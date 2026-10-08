/**
 * Drizzle schema (SQLite). Phase 1 tables plus Phase 2 generation columns, Phase 3 descriptions + Jev classify and
 * Phase 4 hooks (rubric versions, notes, hooks, hook scores, the Client tab's "What works here" list) and Phase 5 Meta + GHL
 * reads (ad accounts, campaigns, ads, daily ad metrics, window reach, channel numbers, GHL leads, the call log).
 * Not modelled here (raw SQL in drizzle/0004): the FTS5 index `asset_fts` and the triggers that keep it in sync.
 * Timestamps are integer epoch milliseconds.
 * Generate migrations with `npm run db:generate` after editing.
 */
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const sections = sqliteTable("sections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(), // rtm | fkbpros | fkb
  name: text("name").notNull(),
  color: text("color"),
  sort: integer("sort").notNull().default(0),
  /**
   * Creative Studio 1b: a switched-off lane (Settings > Lanes; Lane A `rtm` and Lane C `fkb` only, never `fkbpros`)
   * leaves the sidebar, scopes, cmd+K, coverage, Review and the Meta sync. Every row stays.
   */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * The lane's own Meta ad account options (Lane C: an account with no client row). Same meaning as the clients
   * columns below; unused for the other lanes (their accounts belong to clients).
   */
  campaignMode: text("campaign_mode").notNull().default("all"), // all | one | state_json
  campaignId: text("campaign_id"),
  leadsMode: text("leads_mode").notNull().default("meta"), // meta | ghl | auto
  ghlSource: text("ghl_source"),
  /** GHL sub-account (location id) for this lane's leads; null = GHL_LOCATION_ID in the lane's Meta env file. */
  ghlLocationId: text("ghl_location_id"),
});

export const clients = sqliteTable("clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sectionId: integer("section_id")
    .notNull()
    .references(() => sections.id),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  metaAdAccountId: text("meta_ad_account_id"),
  brandNotes: text("brand_notes"),
  /** One or two lines telling Jev who this client is (brand, place, services). Seeded (v5), never overwritten. */
  classifyHint: text("classify_hint"),
  /**
   * When the owner last saved brand_notes (Client tab, Phase 4 slice 2). null = the seeded draft (seed v6), shown as
   * "Draft, check me". The notes feed hook scoring (and rewriting), never classify.
   */
  brandNotesSavedAt: integer("brand_notes_saved_at"),
  sort: integer("sort").notNull().default(0),
  /**
   * Creative Studio 1b (Settings > Clients). hidden_at: a hidden client leaves the sidebar, scopes, cmd+K, coverage,
   * Review and the Meta sync; every row stays (never deleted). Unhide clears it.
   */
  hiddenAt: integer("hidden_at"),
  /**
   * Which campaigns the Meta sync reads: `all` = every campaign in the account (account-level channel numbers, the
   * default), `one` = campaign_id only, `state_json` = the widget rule (state.json / build_state.json `campaign_id` in
   * the client's Meta folder, else the campaign name scan, else the only campaign).
   */
  campaignMode: text("campaign_mode").notNull().default("all"),
  campaignId: text("campaign_id"),
  /** Leads: `meta` = Meta's lead actions (default, no GHL read), `ghl` = GHL contacts with source ghl_source, `auto` = Meta until a GHL contact carries the source, then GHL. */
  leadsMode: text("leads_mode").notNull().default("meta"),
  /** GHL contact source value; null = `<code>-fb-ad`. */
  ghlSource: text("ghl_source"),
  /** Folder under STUDIO_CLIENT_DOCS_DIR holding the approved copy doc and `Static Ads/`; null = none (Import approved copy is off). */
  folder: text("folder"),
});

export const roots = sqliteTable("roots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  sectionId: integer("section_id")
    .notNull()
    .references(() => sections.id),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const ignorePatterns = sqliteTable("ignore_patterns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pattern: text("pattern").notNull().unique(),
});

export const tagRules = sqliteTable("tag_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Glob relative to the asset's root (or absolute when it starts with "/"). */
  pathGlob: text("path_glob").notNull(),
  /** JSON array of client codes. */
  clientCodes: text("client_codes").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
});

export const assets = sqliteTable(
  "assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sectionId: integer("section_id")
      .notNull()
      .references(() => sections.id),
    rootId: integer("root_id")
      .notNull()
      .references(() => roots.id),
    path: text("path").notNull().unique(),
    relPath: text("rel_path").notNull(),
    filename: text("filename").notNull(),
    ext: text("ext").notNull(),
    /**
     * Sampled fingerprint: sha256 over (size + first 8 MB + middle 8 MB + last 8 MB);
     * whole file when <= 24 MB. See docs/DECISIONS.md.
     */
    sha256: text("sha256"),
    kind: text("kind").notNull(), // video | image | audio | doc
    bytes: integer("bytes").notNull(),
    durationS: real("duration_s"),
    width: integer("width"),
    height: integer("height"),
    orientation: text("orientation"), // 9:16 | 16:9 | 1:1 | 4:5 | other
    fps: real("fps"),
    codec: text("codec"),
    createdAt: integer("created_at"),
    mtime: integer("mtime").notNull(),
    indexedAt: integer("indexed_at").notNull(),
    missing: integer("missing", { mode: "boolean" }).notNull().default(false),
    /** Soft-hidden because the path now matches an ignore pattern. Excluded everywhere; keeps manual tags. */
    ignored: integer("ignored", { mode: "boolean" }).notNull().default(false),
    /** Made by Studio (a `<stem>.gen.json` sidecar sits next to it, or it lives under Studio Generated). Set at ingest. */
    generated: integer("generated", { mode: "boolean" }).notNull().default(false),
    thumbPath: text("thumb_path"), // relative to STUDIO_CACHE
    sheetPath: text("sheet_path"),
    proxyPath: text("proxy_path"),
    deriveStatus: text("derive_status").notNull().default("pending"), // pending | done | error
    deriveError: text("derive_error"),
    // Describe (Phase 3). Copied from `descriptions` (keyed by fingerprint) so queries stay simple.
    description: text("description"),
    /** Ollama model + prompt version the description was made with; a different current pair = describe again. */
    descriptionModel: text("description_model"),
    descriptionVersion: integer("description_version"),
    /** Videos: whisper text of the first 15 s. null = not attempted yet; "" = no audio track or no speech. */
    spokenOpen: text("spoken_open"),
    describedAt: integer("described_at"),
    /** Last describe failure for this asset (skipped by the backfill until Describe again / Retry). */
    describeError: text("describe_error"),
    /** "Describe again": runs first (even while paused) and bypasses the fingerprint cache. Cleared when it ran. */
    describeRequestedAt: integer("describe_requested_at"),
    // Classify (Phase 3, Jev). The full answer set lives in `classifications`; these are the filterable fields.
    /** One of the 18 categories (src/lib/ai/classes.ts). */
    assetClass: text("asset_class"),
    /** Jev's confidence for the class (choice confidence); null when the owner set it. */
    classConfidence: real("class_confidence"),
    /** jev | manual. A manual class is never overwritten by a later classify. */
    classSource: text("class_source"),
    /** Energy 1 to 5 (Jev's 0-based score + 1, can land between levels). */
    energy: real("energy"),
    tags: text("tags"),
    /** 1 = at least one Jev answer is unsure (Review queue). Cleared by a Review confirm. */
    needsReview: integer("needs_review", { mode: "boolean" }),
    classifiedAt: integer("classified_at"),
    /**
     * described_at of the description that classify read (taken at claim time). A description written while the Jev
     * call was in flight is newer, so the asset is due again. null on rows classified before 0006 (classified_at stands in).
     */
    classifyDescribedAt: integer("classify_described_at"),
    /**
     * The owner decided this asset's clients (Review confirm, or any client chip edit in the drawer): that set is the manual
     * rows, none = shared. Like a folder / manual tag it stops the client questions for good; never cleared by classify.
     */
    clientsDecidedAt: integer("clients_decided_at"),
    /** CLASSIFY_VERSION + Jev model of the last classify; a different current pair (or a newer description) = due. */
    classifyVersion: integer("classify_version"),
    classifyModel: text("classify_model"),
    /** Last classify failure for this asset (skipped by the backfill until Classify again / Retry). */
    classifyError: text("classify_error"),
    /** "Classify again": runs first (even while paused). Cleared when it ran. */
    classifyRequestedAt: integer("classify_requested_at"),
  },
  (t) => [
    index("assets_section_idx").on(t.sectionId, t.missing, t.ignored),
    index("assets_root_idx").on(t.rootId),
    index("assets_sha_idx").on(t.sha256),
    index("assets_mtime_idx").on(t.mtime),
    index("assets_kind_idx").on(t.kind),
    index("assets_generated_idx").on(t.generated),
    index("assets_review_idx").on(t.needsReview),
    index("assets_class_idx").on(t.assetClass),
  ],
);

export const assetClients = sqliteTable(
  "asset_clients",
  {
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // folder | manual | jev
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.clientId] }),
    index("asset_clients_client_idx").on(t.clientId),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(), // derive_thumb | derive_proxy | gen_image | gen_video | gen_tool | hook_variants | short_moments | ad_copy
    /** Derive jobs only. Generation jobs keep asset_id null (the request lives in `input`). */
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    /** Generation request (JSON, see src/lib/gen/types.ts GenInput). */
    input: text("input"),
    /** Engine job id (Higgsfield job UUID), stored the moment start() returns: restarts re-poll it, never re-create. */
    externalId: text("external_id"),
    /** Generation progress/outcome (JSON, see src/lib/gen/types.ts GenResult): quoted credits, outputs, asset ids. */
    result: text("result"),
    status: text("status").notNull().default("pending"), // pending | running | done | error | cancelled (Codex only)
    /** Cancel asked for from the app (Codex jobs); the worker kills the run and sets status 'cancelled'. */
    cancelRequestedAt: integer("cancel_requested_at"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    logPath: text("log_path"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("jobs_queue_idx").on(t.status, t.priority, t.id),
    index("jobs_asset_idx").on(t.assetId),
    uniqueIndex("jobs_active_uniq")
      .on(t.type, t.assetId)
      .where(sql`status in ('pending','running')`),
  ],
);

/**
 * Describe cache: one row per (fingerprint, model, prompt version). A duplicate or renamed file reuses it, so the
 * vision model and whisper never run twice for the same bytes. Written by the worker's DescribeQueue only.
 */
export const descriptions = sqliteTable(
  "descriptions",
  {
    sha256: text("sha256").notNull(),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    text: text("text").notNull(),
    /** Same semantics as assets.spoken_open (null = not attempted, "" = no audio / no speech). */
    spokenOpen: text("spoken_open"),
    /** Vision model time (ms) and whisper time incl. the audio cut (ms). */
    ms: integer("ms"),
    spokenMs: integer("spoken_ms"),
    /** Video only: what image 1 was ("opening" = 3 frames from the first 3 s, "poster" = fallback without a proxy). */
    firstImage: text("first_image"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sha256, t.model, t.promptVersion] })],
);

/**
 * Latest Jev classification per asset (one row, replaced on every classify): every answer with its probabilities and
 * confidence, which answers were unsure, and the ai_calls row that produced it. Written by the worker's ClassifyQueue.
 */
export const classifications = sqliteTable("classifications", {
  assetId: integer("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  version: integer("version").notNull(),
  /** JSON: { <question id>: { type, value, probabilities, confidence } } (see src/lib/ai/classify.ts). */
  answers: text("answers").notNull(),
  /** JSON array of question ids (client nouls grouped as "clients") that were unsure. */
  unsure: text("unsure").notNull(),
  callId: integer("call_id"),
  createdAt: integer("created_at").notNull(),
});

/**
 * Every Jev call (classify, search, test), including failures. Never holds the key or the state itself (only its size).
 * cost_usd = input_tokens x $0.042 / 1M. The daily cap sums this per America/New_York day.
 */
export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: integer("created_at").notNull(),
    purpose: text("purpose").notNull(), // classify | search | hook_score | copy_gate | page_score | test
    provider: text("provider").notNull(), // jev
    /** The versioned model id that answered (or the pinned one when the call failed). */
    model: text("model").notNull(),
    assetId: integer("asset_id"),
    /** JSON: the questions sent. */
    questions: text("questions").notNull(),
    stateChars: integer("state_chars").notNull(),
    inputTokens: integer("input_tokens"),
    /** JSON: answers incl. probabilities and confidence. */
    answers: text("answers"),
    minConfidence: real("min_confidence"),
    costUsd: real("cost_usd").notNull().default(0),
    ms: integer("ms"),
    error: text("error"),
  },
  (t) => [index("ai_calls_created_idx").on(t.createdAt), index("ai_calls_asset_idx").on(t.assetId)],
);

/** The owner's answer where it differed from Jev's (Review confirm, drawer category picker). Recent ones feed classify. */
export const aiCorrections = sqliteTable(
  "ai_corrections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** Question id (asset_class, clients, energy, hookable, brand_safe, visual_format, pp_person, ...). */
    question: text("question").notNull(),
    /** JSON values. */
    jevAnswer: text("jev_answer"),
    ownerAnswer: text("ronny_answer").notNull(), // the stored column name stays (renaming a column is a migration)
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("ai_corrections_created_idx").on(t.createdAt)],
);

/** Single row (id = 1) heartbeat written by the worker. */
export const workerStatus = sqliteTable("worker_status", {
  id: integer("id").primaryKey(),
  pid: integer("pid"),
  startedAt: integer("started_at"),
  lastSeen: integer("last_seen"),
  driveMounted: integer("drive_mounted", { mode: "boolean" }),
  queuePending: integer("queue_pending"),
  queueRunning: integer("queue_running"),
  queueError: integer("queue_error"),
  currentFile: text("current_file"),
  scanState: text("scan_state"), // idle | scanning | paused
  scanSeen: integer("scan_seen"),
  cacheBytes: integer("cache_bytes"),
  cacheBytesAt: integer("cache_bytes_at"),
  message: text("message"),
  /** Describe queue: running | idle | paused | waiting (Ollama unreachable) | off. */
  describeState: text("describe_state"),
  describeCurrent: text("describe_current"),
  describeNote: text("describe_note"),
  /** Classify queue: running | idle | paused | waiting (key missing, Jev down, daily cap) | off. */
  classifyState: text("classify_state"),
  classifyCurrent: text("classify_current"),
  classifyNote: text("classify_note"),
  /** Hook scoring queue (Phase 4): running | idle | paused | waiting | off; current = hook ids being scored (comma list). */
  hooksState: text("hooks_state"),
  hooksCurrent: text("hooks_current"),
  hooksNote: text("hooks_note"),
  /** Meta + GHL sync (Phase 5): running | idle | paused | waiting | off; current = the account being synced; note = why it waits. */
  metaState: text("meta_state"),
  metaCurrent: text("meta_current"),
  metaNote: text("meta_note"),
  /** YouTube Shorts sync (Phase 5 slice 4): running | idle | paused | waiting | off; current = what it reads; note = why it waits. */
  ytState: text("yt_state"),
  ytCurrent: text("yt_current"),
  ytNote: text("yt_note"),
});

/**
 * Hook rubric versions (Phase 4). Exactly one row has current = 1 (partial unique index). Editing the rubric saves a
 * new row, never an in-place edit; old hook_scores keep their version (Phase 5 calibration history).
 * JSON columns: see src/lib/hooks/rubric.ts (Dimension[], Mechanic[], Avatar[]).
 */
export const rubricVersions = sqliteTable(
  "rubric_versions",
  {
    version: integer("version").primaryKey(),
    dimensions: text("dimensions").notNull(),
    mechanics: text("mechanics").notNull(),
    avatars: text("avatars").notNull(),
    note: text("note"),
    current: integer("current", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    /**
     * The owner clicked Rescore for this version (slice 3). Until then a hook that already has a score from an older version
     * is not due (saving a version never spends by itself); hooks never scored are due either way.
     */
    rescoreAt: integer("rescore_at"),
    /**
     * Landing page Phase 2 slice 1 (migration 0023): the section briefs Jev reads as `channel.brief`, JSON
     * {rtm?, fkbpros?, fkb?}; null (or a missing key) = the legacy fixed text (`LEGACY_SECTION_BRIEF`, notes.ts).
     */
    briefs: text("briefs"),
    /**
     * The EFFECTIVE version per section, JSON {rtm, fkbpros, fkb}: the version whose content (dimensions, avatars,
     * mechanics, brief) that section still has (`computeSectionVersions`, rubric.ts). The copy gate reports and
     * copy_score.py caches by it, so a version that only changes Lane A keeps every Lane B / Lane C key. Backfilled to the row's
     * own version; null = the row's own version for every section.
     */
    sectionVersions: text("section_versions"),
  },
  (t) => [uniqueIndex("rubric_versions_current_uniq").on(t.current).where(sql`current = 1`)],
);

/**
 * Notes that live outside the rubric version (Phase 4 A1): `rtm` (Lane A brand notes) and `whos_who` (who the people in
 * the files are). Seeded as drafts (saved_at null = "Draft, check me"); edits only raise the "notes changed" flag.
 * Lane B client brand notes live on clients.brand_notes.
 */
export const notes = sqliteTable("notes", {
  key: text("key").primaryKey(),
  body: text("body").notNull(),
  savedAt: integer("saved_at"),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Hooks (Phase 4): one row per hook line. Channel = section + client (null = Lane A, or Lane B shared). Text hooks are
 * deduped per channel on `norm` (src/lib/hooks/rubric.ts normHook) in code, archived ones included, so a re-import
 * never brings an archived hook back.
 */
export const hooks = sqliteTable(
  "hooks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sectionId: integer("section_id")
      .notNull()
      .references(() => sections.id),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // text | video
    /** As typed / as written in the copy doc. */
    text: text("text").notNull(),
    norm: text("norm").notNull(),
    /** Video hooks (slice 2): the asset. */
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }),
    source: text("source").notNull(), // manual | pasted | copy_doc | asset | variant | meta | moment
    /** Copy doc angle slug, when the doc gives one. */
    angleSlug: text("angle_slug"),
    /** Variants (slice 3): the hook they rewrite; kept = the owner kept it (then it is a normal hook). */
    parentId: integer("parent_id"),
    kept: integer("kept", { mode: "boolean" }),
    /** Variants (slice 3): the copy mechanic `claude -p` wrote it on, and the hook_variants job that made it. */
    variantMechanic: text("variant_mechanic"),
    variantJobId: integer("variant_job_id"),
    archivedAt: integer("archived_at"),
    /** "Score again": runs first (even while paused). Cleared when it ran. */
    scoreRequestedAt: integer("score_requested_at"),
    /** Last scoring failure (skipped by the queue until Score again). */
    scoreError: text("score_error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("hooks_channel_idx").on(t.sectionId, t.clientId, t.kind, t.norm),
    index("hooks_asset_idx").on(t.assetId),
    index("hooks_parent_idx").on(t.parentId),
    // One video hook per asset (slice 2): the worker's sync and "Add as hook" both rely on it (variants have a parent).
    uniqueIndex("hooks_video_asset_uniq").on(t.assetId).where(sql`kind = 'video' and parent_id is null`),
  ],
);

/**
 * One Jev score per (hook, rubric version). answers = every answer with probabilities + confidence (StoredAnswer
 * shape), unsure = question ids under the gate; the filterable fields are copied out (overall, the three P's, style,
 * avatar, stops_scroll). notes_fp = fingerprint of the notes the state carried (slice 2's "notes changed" flag).
 */
export const hookScores = sqliteTable(
  "hook_scores",
  {
    hookId: integer("hook_id")
      .notNull()
      .references(() => hooks.id, { onDelete: "cascade" }),
    rubricVersion: integer("rubric_version").notNull(),
    answers: text("answers").notNull(),
    unsure: text("unsure").notNull(),
    /** Mean of the applicable dimension levels (1..5), computed in code. */
    overall: real("overall"),
    ppPerson: real("pp_person"),
    ppPain: real("pp_pain"),
    ppPromise: real("pp_promise"),
    style: text("style"),
    avatar: text("avatar"),
    stopsScroll: real("stops_scroll"),
    notesFp: text("notes_fp"),
    model: text("model").notNull(),
    callId: integer("call_id"),
    scoredAt: integer("scored_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.hookId, t.rubricVersion] }), index("hook_scores_version_idx").on(t.rubricVersion, t.overall)],
);

/**
 * "What works here" (Phase 4 G1, slice 2): per Lane B client, an ordered list of the owner's free-text items and pinned
 * hooks (body null, hook_id set; the hook's text is read live). Rides along on that client's hook scoring state and is
 * part of the notes fingerprint, so an edit raises the "notes changed" flag (never a rescore by itself).
 * Phase 5 slice 2: Lane C (a section with one channel and no clients row) owns a list too: client_id null + section_id =
 * the fkb section. Owner = (section_id, client_id); section_id is set on every row (0011 backfilled the client rows).
 */
export const clientWorks = sqliteTable(
  "client_works",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }),
    sectionId: integer("section_id").references(() => sections.id),
    body: text("body"),
    hookId: integer("hook_id").references(() => hooks.id, { onDelete: "cascade" }),
    sort: integer("sort").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("client_works_client_idx").on(t.clientId, t.sort),
    uniqueIndex("client_works_hook_uniq").on(t.clientId, t.hookId).where(sql`hook_id is not null`),
    uniqueIndex("client_works_section_hook_uniq").on(t.sectionId, t.hookId).where(sql`hook_id is not null and client_id is null`),
  ],
);

/**
 * Hooks carried by Meta ads (Phase 5 slice 2, C): every headline and primary first sentence of a synced ad links to the
 * equal hook in the ad's channel (made as a `meta` hook when new), and the ad's matched video links its video hook
 * (role video). Keyed by the Meta ad id (like ad_metrics) so the link outlives the ad; rows are never deleted by a sync.
 * An ad's numbers are shared credit: every hook it carries shows the ad's whole numbers.
 */
export const hookAds = sqliteTable(
  "hook_ads",
  {
    hookId: integer("hook_id")
      .notNull()
      .references(() => hooks.id, { onDelete: "cascade" }),
    metaAdId: text("meta_ad_id").notNull(),
    role: text("role").notNull(), // headline | primary | video
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.hookId, t.metaAdId, t.role] }), index("hook_ads_ad_idx").on(t.metaAdId)],
);

// ------------------------------------------------------------------ Meta + GHL (Phase 5, read only)

/**
 * One row per Meta ad account Studio reads (seed v7): the Lane B clients (identity `fpc`, the Lane B API token) and
 * Lane C's own account (identity `fkb`, section fkb, client null, its own token). Written by the worker's MetaSyncQueue;
 * last_sync_at only moves on a fully successful account sync, so the last good numbers stay after an error.
 */
export const adAccounts = sqliteTable("ad_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sectionId: integer("section_id")
    .notNull()
    .references(() => sections.id),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }),
  actId: text("act_id").notNull().unique(),
  identity: text("identity").notNull(), // fpc | fkb
  /** The account's own timezone (Meta days are account-local). */
  timezone: text("timezone"),
  /** How the campaign(s) were found: state.json | build_state.json | name | only | account (Lane C: every campaign). */
  campaignSource: text("campaign_source"),
  lastSyncAt: integer("last_sync_at"),
  lastAttemptAt: integer("last_attempt_at"),
  /** Last failure (terse, scrubbed); null after a clean sync. */
  error: text("error"),
  /** ghl | meta (Lane C until a GHL key is added to its env file). */
  leadsSource: text("leads_source"),
  ghlSyncedAt: integer("ghl_synced_at"),
  ghlError: text("ghl_error"),
  sort: integer("sort").notNull().default(0),
});

/** The campaigns a sync reads per account (the widget's one Lane B campaign per client; every Lane C campaign). */
export const metaCampaigns = sqliteTable(
  "meta_campaigns",
  {
    id: text("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    effectiveStatus: text("effective_status"),
    /** Account-local YYYY-MM-DD the campaign started (the backfill's first day). */
    startDate: text("start_date"),
    /** Every day since start_date is stored (first sync); later syncs refresh the last 3 days. */
    backfilledAt: integer("backfilled_at"),
    /**
     * Account-local YYYY-MM-DD: the last day a daily read of this campaign completed through (Phase 5 gate fix). The next
     * sync re-reads from the day before it (or 3 days back, whichever is earlier), so days missed while the worker was
     * down, paused or failing are filled.
     */
    syncedThrough: text("synced_through"),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [index("meta_campaigns_account_idx").on(t.accountId)],
);

/**
 * Ads in scope (ACTIVE, or any other status with delivery in the last 30 days) of the synced campaigns. Rows are never
 * deleted: an ad that drops out of scope keeps its row (and its daily metrics); the Running tab applies the scope rule
 * at read time. creative = JSON (src/lib/meta/sync.ts AdCreative). match_source manual is never overwritten by a sync.
 */
export const ads = sqliteTable(
  "ads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    metaAdId: text("meta_ad_id").notNull().unique(),
    accountId: integer("account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id"),
    campaignName: text("campaign_name"),
    adsetId: text("adset_id"),
    adsetName: text("adset_name"),
    name: text("name").notNull(),
    effectiveStatus: text("effective_status"),
    configuredStatus: text("configured_status"),
    createdTime: integer("created_time"),
    /** Account-local YYYY-MM-DD of the first / last day with spend (from ad_metrics). */
    firstSpendDate: text("first_spend_date"),
    lastSpendDate: text("last_spend_date"),
    creative: text("creative"),
    /** The Meta video title / image name (matching step 2), read once. */
    mediaName: text("media_name"),
    mediaNameAt: integer("media_name_at"),
    /** Cached Meta thumbnail, relative to STUDIO_CACHE (meta/<ad id>.<ext>); downloaded once for unmatched ads. */
    thumbPath: text("thumb_path"),
    thumbError: text("thumb_error"),
    matchedAssetId: integer("matched_asset_id").references(() => assets.id, { onDelete: "set null" }),
    matchSource: text("match_source"), // map | name | manual
    matchDetail: text("match_detail"),
    /**
     * Phase 5 slice 3: the copy doc angle of the ad (its ad map row's `angle_key`, a universal ad's `universal:<id>`),
     * set by the worker next to the Meta hooks step; null = unknown (test order then compares the opening line).
     */
    angleKey: text("angle_key"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSyncedAt: integer("last_synced_at").notNull(),
  },
  (t) => [index("ads_account_idx").on(t.accountId), index("ads_asset_idx").on(t.matchedAssetId)],
);

/**
 * Daily ad-level insights, one row per (Meta ad id, account-local day), upserted and kept forever (also for ads not in
 * `ads`: archived / never in scope). ctr = Meta's all-clicks CTR for the day; windows recompute from clicks.
 */
export const adMetrics = sqliteTable(
  "ad_metrics",
  {
    metaAdId: text("meta_ad_id").notNull(),
    date: text("date").notNull(),
    accountId: integer("account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    adName: text("ad_name"),
    spend: real("spend").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    reach: integer("reach"),
    frequency: real("frequency"),
    clicks: integer("clicks").notNull().default(0),
    ctr: real("ctr"),
    cpm: real("cpm"),
    linkClicks: integer("link_clicks").notNull().default(0),
    costPerLinkClick: real("cost_per_link_click"),
    metaLeads: integer("meta_leads").notNull().default(0),
    video3s: integer("video_3s").notNull().default(0),
    thruplays: integer("thruplays").notNull().default(0),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.metaAdId, t.date] }), index("ad_metrics_account_idx").on(t.accountId, t.date)],
);

/** Per-ad unique reach over each window (reach is not additive across days): frequency = impressions / reach. */
export const adWindows = sqliteTable(
  "ad_windows",
  {
    metaAdId: text("meta_ad_id").notNull(),
    window: text("window").notNull(), // today | 7d | 14d | lifetime
    reach: integer("reach"),
    impressions: integer("impressions"),
    frequency: real("frequency"),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.metaAdId, t.window] })],
);

/**
 * The channel's widget numbers per window (campaign level for clients, account level for Lane C), exactly as Meta returns
 * them for date_preset today / last_7d / last_14d / maximum. Replaced only on a successful read.
 */
export const channelMetrics = sqliteTable(
  "channel_metrics",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    window: text("window").notNull(), // today | 7d | 14d | lifetime
    dateStart: text("date_start"),
    dateStop: text("date_stop"),
    spend: real("spend"),
    impressions: integer("impressions"),
    reach: integer("reach"),
    clicks: integer("clicks"),
    ctr: real("ctr"),
    cpm: real("cpm"),
    linkClicks: integer("link_clicks"),
    costPerLinkClick: real("cost_per_link_click"),
    metaLeads: integer("meta_leads"),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.window] })],
);

/**
 * GHL ad leads per client (the widget's `source = <code>-fb-ad` search), mirrored on each successful pull. No names,
 * phones, emails or any other contact detail: the contact id, when it came in, the attribution keys and the test flag.
 * ad_id = the Meta ad whose name the utm_content carries (first touch, else last touch); null = client total only.
 */
export const ghlLeads = sqliteTable(
  "ghl_leads",
  {
    contactId: text("contact_id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    dateAdded: integer("date_added"),
    firstUtmContent: text("first_utm_content"),
    firstMediumId: text("first_medium_id"),
    lastUtmContent: text("last_utm_content"),
    lastMediumId: text("last_medium_id"),
    /** Tagged `test record` / `claude-test-lead`: kept for the record, never counted. */
    test: integer("test", { mode: "boolean" }).notNull().default(false),
    adId: text("ad_id"),
    attributedVia: text("attributed_via"), // first | last
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [index("ghl_leads_account_idx").on(t.accountId, t.dateAdded), index("ghl_leads_ad_idx").on(t.adId)],
);

/**
 * Test order (Phase 5 slice 3, G): one row per channel's ad account per batch (the ads created on the same America/New_York
 * day). The worker suggests which variable the batch tested against the ads that ran before it (offer, hook, format,
 * copy, or none = the new ads repeat running ones / the first ads); the owner confirms or changes it on the Client tab.
 * `variable` + `confirmed_at` are the owner's and never overwritten by a later suggestion.
 */
export const testOrders = sqliteTable(
  "test_orders",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    /** America/New_York YYYY-MM-DD the batch's ads were created. */
    batchDate: text("batch_date").notNull(),
    /** Meta ad ids of the batch (JSON list). */
    adIds: text("ad_ids").notNull(),
    nAds: integer("n_ads").notNull(),
    suggested: text("suggested").notNull(), // offer | hook | format | copy | none
    /** Every variable the batch changed, highest first (JSON list); > 1 = mixed. */
    parts: text("parts").notNull(),
    /** Per ad: {id, name, variable, why} (JSON list). */
    detail: text("detail").notNull(),
    reason: text("reason").notNull(),
    /** The owner's answer (offer | hook | format | copy | none); null until the owner confirms or changes it. */
    variable: text("variable"),
    confirmedAt: integer("confirmed_at"),
    foundAt: integer("found_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.batchDate] })],
);

/** Every Meta Graph / GHL request the worker made (path only: never a token, key or query string). */
export const metaCalls = sqliteTable(
  "meta_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    identity: text("identity").notNull(), // fpc | fkb
    kind: text("kind").notNull(), // graph | ghl
    path: text("path").notNull(),
    status: integer("status"),
    ms: integer("ms"),
    error: text("error"),
  },
  (t) => [index("meta_calls_at_idx").on(t.at)],
);

// ------------------------------------------------------------------ YouTube Shorts (Phase 5 slice 4, read only)

/** The connected YouTube channel (Studio's own read-only token; one row in practice). */
export const ytChannels = sqliteTable("yt_channels", {
  channelId: text("channel_id").primaryKey(),
  title: text("title"),
  uploadsPlaylist: text("uploads_playlist"),
  /** When the channel was created (the analytics start date). */
  publishedAt: integer("published_at"),
  syncedAt: integer("synced_at").notNull(),
});

/**
 * Every upload of the connected channel (not only Shorts, so the Shorts rule can change): is_short = duration <= 180 s.
 * matched_asset_id = the Lane A video file it was cut from (auto: title + duration; manual: the owner's "Link a file", never
 * overwritten). The Short's hook = that file's video hook (derived at read time, src/lib/youtube/sql.ts).
 */
export const ytVideos = sqliteTable(
  "yt_videos",
  {
    videoId: text("video_id").primaryKey(),
    channelId: text("channel_id").notNull(),
    title: text("title").notNull(),
    publishedAt: integer("published_at"),
    durationS: real("duration_s"),
    isShort: integer("is_short", { mode: "boolean" }).notNull().default(false),
    privacy: text("privacy"), // public | unlisted | private
    /** The public i.ytimg.com thumbnail URL (downloaded once into STUDIO_CACHE/youtube/, never hotlinked). */
    thumbUrl: text("thumb_url"),
    thumbPath: text("thumb_path"),
    thumbError: text("thumb_error"),
    matchedAssetId: integer("matched_asset_id").references(() => assets.id, { onDelete: "set null" }),
    matchSource: text("match_source"), // auto | manual
    matchDetail: text("match_detail"),
    /** Set when the upload is no longer in the uploads playlist (deleted); the row and its history stay. */
    goneAt: integer("gone_at"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSyncedAt: integer("last_synced_at").notNull(),
  },
  (t) => [index("yt_videos_asset_idx").on(t.matchedAssetId), index("yt_videos_short_idx").on(t.isShort, t.publishedAt)],
);

/**
 * Lifetime totals of a Short as read on a given day (one snapshot per America/New_York day, kept forever so growth can
 * be read later). The latest snapshot per video is "its numbers". A metric the Analytics API refused is null.
 */
export const ytMetrics = sqliteTable(
  "yt_metrics",
  {
    videoId: text("video_id").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    views: integer("views"),
    avgViewPct: real("avg_view_pct"),
    avgViewS: real("avg_view_s"),
    likes: integer("likes"),
    subsGained: integer("subs_gained"),
    engagedViews: integer("engaged_views"),
    shares: integer("shares"),
    comments: integer("comments"),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.videoId, t.snapshotDate] })],
);

/** One-time OAuth `state` values (sha256 of the state + its PKCE verifier), 10 minute expiry, deleted on use. */
export const ytOauthStates = sqliteTable("yt_oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  verifier: text("verifier").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** Every YouTube Data / Analytics / OAuth request (path only: never a token, code or query string). */
export const ytCalls = sqliteTable(
  "yt_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    kind: text("kind").notNull(), // data | analytics | oauth
    path: text("path").notNull(),
    status: integer("status"),
    ms: integer("ms"),
    error: text("error"),
  },
  (t) => [index("yt_calls_at_idx").on(t.at)],
);

// ------------------------------------------------------------------ Shorts board (Phase 6 slice 1)

/**
 * A Lane A episode (Phase 6 A1): a `<prefix>N.srt` (the stem names the episode; the folder name and the master's file name
 * are unreliable) in the same folder as a visible Lane A `asset_class = episode` video (the master: the longest when several
 * share the folder). Found and kept fresh by the worker only (src/lib/shorts/episodes.ts, read through the guarded text
 * reader; nothing is ever written to the drive). `cues` is the parsed SRT ([[start, end, text], ...] JSON), the parse
 * cache: re-read only when the file's size or mtime changes. Rows are never deleted (cards point at them): an SRT that is
 * gone while its root is readable gets `gone_at`.
 */
export const episodes = sqliteTable(
  "episodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The SRT's path as found under its root (lexical, absolute). */
    srtPath: text("srt_path").notNull().unique(),
    folder: text("folder").notNull(),
    /** "<prefix>7" (the SRT stem) and its number. */
    stem: text("stem").notNull(),
    num: integer("num").notNull(),
    /** The folder name (trimmed): "Hair Website Demo". */
    title: text("title").notNull(),
    masterAssetId: integer("master_asset_id").references(() => assets.id, { onDelete: "set null" }),
    srtSize: integer("srt_size"),
    srtMtime: integer("srt_mtime"),
    cues: text("cues"),
    cueCount: integer("cue_count").notNull().default(0),
    /** The master's duration, else the last cue's end. */
    durationS: real("duration_s"),
    /** Last read / parse failure (terse; the old cues stay). */
    readError: text("read_error"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    goneAt: integer("gone_at"),
    // Word-timed transcript (Phase 6 slice 2): local whisper-cli over the master's CACHED proxy (never the drive), in
    // the worker only. words = [[start s, end s, "word"], ...] as whisper wrote them (the proper-noun fixes and the
    // sentence split are applied at read time, src/lib/shorts/words.ts). Current = no error AND words_sha = the master's
    // fingerprint AND words_version / words_model = the current ones; anything else makes the episode due again.
    words: text("words"),
    wordsSha: text("words_sha"),
    wordsVersion: integer("words_version"),
    wordsModel: text("words_model"),
    wordsAt: integer("words_at"),
    wordsMs: integer("words_ms"),
    /** Last failure (terse); retried after 6 hours or when the fingerprint changes. */
    wordsError: text("words_error"),
    wordCount: integer("word_count"),
    sentenceCount: integer("sentence_count"),
    /** Set while the worker is transcribing it ("Transcribing…"). */
    wordsRunningAt: integer("words_running_at"),
    /**
     * Folders where this episode's reels may land (JSON array, the episode folder first): the episode folder plus any
     * sibling folder holding `<prefix>N reels.json` (e.g. a reels folder named after the episode). Found by the worker.
     */
    reelDirs: text("reel_dirs"),
  },
  (t) => [index("episodes_num_idx").on(t.num), index("episodes_master_idx").on(t.masterAssetId)],
);

/**
 * A Shorts board card (Phase 6 B3 / C1): one moment of an episode (or, from slice 2, a Lane A hook sent to Shorts with no
 * episode). k = the card number inside its episode, assigned at creation and never reused (rows are never deleted;
 * Discard archives). status = the board column; kept null = undecided, 1 = kept, 0 = discarded (archived). hook_id = the
 * Lane A text hook of its first line (source `moment`, scored by the HookScoreQueue); hook_owned = the hook was created for
 * this card (Discard archives it when no other card uses it). output_asset_id / yt_video_id: the reel file and its
 * posted Short (slice 2, src/lib/shorts/outputs.ts). An "explainer" card (Send to Shorts) has no episode, no k, 0 / 0
 * times and the hook's text as its first line.
 */
export const shorts = sqliteTable(
  "shorts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    episodeId: integer("episode_id").references(() => episodes.id),
    k: integer("k"),
    startS: real("start_s").notNull(),
    endS: real("end_s").notNull(),
    firstLine: text("first_line").notNull(),
    /** The caps overlay text (2 to 5 words). */
    hookWords: text("hook_words").notNull(),
    why: text("why"),
    layout: text("layout").notNull(), // stack | center | blurfill | pip
    status: text("status").notNull().default("idea"), // idea | cutting | review | ready | posted
    kept: integer("kept", { mode: "boolean" }),
    archivedAt: integer("archived_at"),
    hookId: integer("hook_id").references(() => hooks.id, { onDelete: "set null" }),
    hookOwned: integer("hook_owned", { mode: "boolean" }).notNull().default(false),
    /** The short_moments job that wrote it. */
    jobId: integer("job_id"),
    outputAssetId: integer("output_asset_id").references(() => assets.id, { onDelete: "set null" }),
    /** auto (the worker matched the reel file) | manual (the owner's Link a file; never overwritten). */
    outputSource: text("output_source"),
    ytVideoId: text("yt_video_id"),
    /** The caption md found for the output (guarded read, .md only) and its first lines. */
    captionPath: text("caption_path"),
    captionPreview: text("caption_preview"),
    captionCheckedAt: integer("caption_checked_at"),
    /**
     * Set when the owner moves a card backward by hand: the trigger key that was true then (`out:<asset id>` in Cutting,
     * `yt:<video id>` in Ready to post). The automatic move from that column fires only for a different key.
     */
    holdKey: text("hold_key"),
    /** Cut reel hand-off (slice 2): the list written under STUDIO_HANDOFFS and the format picked (v1 | v2 | v3). */
    handoffPath: text("handoff_path"),
    handoffFormat: text("handoff_format"),
    handoffAt: integer("handoff_at"),
    /**
     * When the card last entered Cutting (Cut reel or by hand): only reel files written after it (file mtime) can move it
     * on, so an older reel that happens to carry the same number never does.
     */
    cuttingAt: integer("cutting_at"),
    approvedAt: integer("approved_at"),
    postedAt: integer("posted_at"),
    /**
     * Phase 7 slice 2: the moment's cold open (one or two whole adjacent sentences inside it, 2 to 6 s after the 0.2 s
     * pad; padded master seconds) and its text. Null = no cold open yet (Cut reel refuses the card).
     */
    coldStartS: real("cold_start_s"),
    coldEndS: real("cold_end_s"),
    coldText: text("cold_text"),
    /** The cold open line's Lane A text hook = the card's MAIN hook (linked or made like `hook_id`; owned = made for this card). */
    coldHookId: integer("cold_hook_id").references(() => hooks.id, { onDelete: "set null" }),
    coldHookOwned: integer("cold_hook_owned", { mode: "boolean" }).notNull().default(false),
    /** Make explainer (C1): the episode card an explainer idea card came from. */
    sourceCardId: integer("source_card_id"),
    /** Cut reel in the kit format: the kit version the hand-off named (read from the kit's VERSION file). */
    handoffKitVersion: integer("handoff_kit_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("shorts_episode_k_uniq").on(t.episodeId, t.k).where(sql`episode_id is not null`),
    index("shorts_status_idx").on(t.status),
    index("shorts_hook_idx").on(t.hookId),
    index("shorts_cold_hook_idx").on(t.coldHookId),
  ],
);

/**
 * Kit notes (Phase 7 slice 2, D2): `<reel stem minus " vN"> kit.json` next to a Lane A video, read back by the worker
 * only through the guarded text reader (`.json` only for names ending ` kit.json`, 64 KB, the exact reel kit
 * tests.md shape). One row per asset that has a note (or a refused one: `error`); no row = "Before kit". Cached by the
 * note's size + mtime; rows go when the note goes (on a readable root).
 */
export const reelKitNotes = sqliteTable("reel_kit_notes", {
  assetId: integer("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  /** The note's file name (no folder). */
  noteName: text("note_name").notNull(),
  version: integer("version"),
  testChange: text("test_change"),
  testDetail: text("test_detail"),
  size: integer("size"),
  mtime: integer("mtime"),
  readAt: integer("read_at").notNull(),
  /** A terse fixed reason when the note was refused (junk, wrong shape, oversize, a symlink out). */
  error: text("error"),
});

/**
 * New PAUSED Meta ads (Phase 6 slice 3): Studio's own record of every order file it staged (src/lib/meta/orders.ts, the
 * ONE writer). The file is the source of truth for status: the apply skill (the Lane B apply skill's studio order mode for the
 * Lane B clients, the Lane C apply skill for Lane C) writes `status` applied | failed + `ad_id` / `ad_name` / `applied_at` /
 * `error` into it; the worker reads every non-final file back every 60 s (guarded read of exactly `file_path`) and
 * mirrors it here (`missing` when the file is gone). Studio itself only ever writes `cancelled` into its own still
 * staged order. The order's whole JSON (as written) stays in `body`.
 */
export const adOrders = sqliteTable(
  "ad_orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The order's `studio_order_id` (random, lowercase hex): the file name's short id is its first 10 characters. */
    studioOrderId: text("studio_order_id").notNull().unique(),
    filePath: text("file_path").notNull().unique(),
    sectionId: integer("section_id")
      .notNull()
      .references(() => sections.id),
    /** null = Lane C (no clients row). */
    clientId: integer("client_id").references(() => clients.id),
    /** The client code, or `fkb`. */
    channelCode: text("channel_code").notNull(),
    actId: text("act_id").notNull(),
    mediaAssetId: integer("media_asset_id").references(() => assets.id, { onDelete: "set null" }),
    mediaKind: text("media_kind").notNull(), // video | image
    /** JSON list of hook ids the copy came from (the chosen hook first). */
    hookIds: text("hook_ids").notNull(),
    /** Where Stage started: hook | winner | library; ref = the hook id / the Meta ad id / the asset id. */
    sourceFrom: text("source_from").notNull(),
    sourceRef: text("source_ref"),
    namePreview: text("name_preview").notNull(),
    /** staged | applying | applied | failed | cancelled | missing (the file is gone). */
    status: text("status").notNull().default("staged"),
    adId: text("ad_id"),
    adName: text("ad_name"),
    appliedAt: text("applied_at"),
    error: text("error"),
    /** Written back by the apply skill (Phase 6 slice 4): the new ad's creative id. */
    creativeId: text("creative_id"),
    /** The apply step a `failed` order stopped at (upload | thumbnail | creative | ig_check | ad | verify | map | claim). */
    failedStep: text("failed_step"),
    /** Gate fixes (migration 0020): the step an `applying` order is at, and when its apply started (ISO, from the file). */
    applyStep: text("apply_step"),
    applyStartedAt: text("apply_started_at"),
    /** The order JSON exactly as Studio wrote it. */
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
    cancelledAt: integer("cancelled_at"),
    /** Last time the worker read the file back (status mirrored). */
    statusReadAt: integer("status_read_at"),
    /** Last read-back problem (unreadable, not JSON, refused shape); the stored status stays. */
    readError: text("read_error"),
  },
  (t) => [index("ad_orders_status_idx").on(t.status), index("ad_orders_client_idx").on(t.channelCode, t.createdAt)],
);

/** Small key/value store (seed version, etc.). */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

/**
 * Errors the owner cleared on the Jobs page (2026-10-06). An error row is hidden (lists, counts, Retry all) while a row here
 * has the same kind + id AND the same error text; a different error on the same thing shows again. Kinds: `derive`
 * (jobs.id), `describe` / `classify` (assets.id), `hook` (hooks.id), `meta` (ad_accounts.id; text = Meta + GHL errors),
 * `youtube` (ref 0). Nothing else reads it: clearing never changes a job, a file or a queue.
 */
export const errorDismissals = sqliteTable(
  "error_dismissals",
  {
    kind: text("kind").notNull(),
    refId: integer("ref_id").notNull(),
    error: text("error").notNull(),
    dismissedAt: integer("dismissed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.refId] })],
);
