import path from "node:path";
import type Database from "better-sqlite3";
import { generatedClientGlob, generatedFkbRoot, generatedRoots } from "../gen/generated-dirs";
import { getConfig } from "../config";
import { provisionClient, staticAdsDir } from "../clients-admin";
import { campaignColumns, LANE_KEYS, NEUTRAL_LANES, type StudioFile } from "../studio-config";
import {
  computeSectionVersions,
  LANE_C_ADDED_NOTE,
  parseBriefs,
  parseSectionVersions,
  rubricHasFkb,
  withFkb,
  withLaneAvatars,
  SECTION_KEYS,
  type RubricBriefs,
  type RubricContent,
} from "../hooks/rubric";
import { briefsOf, FKB_HINT_KEY, FKB_NOTE_KEY } from "../hooks/notes";
import { profile } from "../profile";

/**
 * Seeds are versioned steps. Each step runs once (tracked by `app_settings.seed_version`)
 * and only inserts rows that do not exist yet, so edits made in Settings are never clobbered.
 * To add defaults later: append a step and bump SEED_VERSION.
 *
 * Creative Studio slice 1b: nothing business specific is seeded from constants any more. Lanes, clients (+ their ad
 * account row, Studio Generated rule and Static Ads root), Lane C's ad account, extra roots and folder tag rules come from
 * the Studio config file (seedFromConfig, every DB open, BEFORE the versioned steps: they read the lanes and clients).
 * A DB seeded before 1b (seed_version > 0 when the config pass first runs) ADOPTS the config: its roots and tag rules are
 * marked as seeded without being inserted again, so a root or rule removed in Settings never comes back; only missing
 * lanes / clients are inserted, and existing clients get their new `folder` column filled once. The versioned steps below
 * keep their generic parts (ignores, Studio Generated roots, rubric, notes, pauses); on a pre-1b DB (seed_version 11)
 * none of them runs again.
 */
export const SEED_VERSION = 11;

/*
 * Ignore pattern syntax (gitignore-lite), see src/lib/patterns.ts:
 *  - "name/"  a directory segment anywhere in the path
 *  - ".*"     any dotfile or dot-directory segment
 *  - "*.bak*" glob against any single path segment
 *  - "a/b/**" glob containing a slash, matched against the root-relative path
 * Only * ** ? are wildcards; ( ) [ ] { } ! + @ are literal.
 */
type Step = { ignores: string[]; rules: { glob: string; codes: string[] }[] };

/**
 * Step 1: DECISIONS.md defaults (+ work-*: HyperFrames render scratch dirs of transient frame_*.jpg). Its folder tag
 * rules now come from the config's `tagRules` (slice 1b).
 */
const STEP_1: Step = {
  ignores: ["build/", "_archive/", "Demos/", "node_modules/", "site/", ".*", "*.bak*", "work-*/"],
  rules: [],
};

/** Step 2 (Phase 1 review): reel QA frame dumps (out/check/). Its per-client render rules now come from the config. */
const STEP_2: Step = { ignores: ["check/"], rules: [] };

/**
 * Steps 9 + 10 (the owner, 2026-10-01, after Phase 6 gate H): the frame grabs a render writes next to each Lane B ad
 * (`renders/<client>/[<batch>/]thumbnails/*_frame0.png`, `*_hero.png`) are not ads. They showed in client Libraries,
 * counted as static ads in coverage and could be picked as ad media (one was staged by mistake). Hidden, never deleted;
 * removing the pattern in Settings brings them back on the next scan. Anchored to `renders/` so any other `thumbnails/`
 * folder stays. v9 shipped `renders/*` + `/thumbnails/**`, which missed the batch folders one level deeper; v10 swaps it for
 * the `**` form (only that exact seeded row is removed, so a pattern the owner typed is never touched).
 */
export const THUMBNAIL_FRAMES_IGNORE = "renders/**/thumbnails/**";
const THUMBNAIL_FRAMES_IGNORE_V9 = "renders/*/thumbnails/**";
const STEP_9: Step = { ignores: [THUMBNAIL_FRAMES_IGNORE], rules: [] };

/**
 * Step 4 (Phase 2): Studio Generated roots (Lane A + Lane B) and one absolute tag rule per client folder (the clients in
 * the DB at that point; later clients get theirs from provisionClient). Lane B/_shared has no rule (shared). Rows only:
 * the folders are created on first use by the write guard, so this never touches the drive and works while it is unmounted.
 */
function step4(sqlite: Database.Database, drivePath: string): Step & { roots: { path: string; section: "rtm" | "fkbpros" }[] } {
  const codes = sqlite.prepare("select code from clients order by sort, id").pluck().all() as string[];
  return {
    ignores: [],
    rules: codes.map((code) => ({ glob: generatedClientGlob(drivePath, code), codes: [code] })),
    roots: generatedRoots(drivePath),
  };
}

/**
 * Step 5 (Phase 3 slice 2): the classify backfill starts paused (a small test run is reviewed before the whole library is
 * sent to Jev). Who each client is (`classify_hint`, Jev's client questions) now comes with the client (config `hint`,
 * Settings > Clients).
 */
function step5(sqlite: Database.Database) {
  sqlite.prepare("insert or ignore into app_settings (key, value) values ('classify:paused', '1')").run();
}

/**
 * Step 6 (Phase 4 slice 1): the hook rubric, the draft notes (Lane A notes, who's who, one brand note per Lane B client)
 * and hook scoring starts paused (a small scored sample is checked before the full import is scored). Creative Studio
 * slice 1c: a DB with no rubric gets ONE current version, the business profile's `rubric` (or the neutral starter), with
 * its briefs; it already scores every lane, so the later rubric steps (8: Lane C added, 11: Lane A context) only set
 * their markers. The notes come from the profile's `seed`. Only where missing / empty: an existing rubric version, a
 * saved note or a brand note already written is never touched.
 */
function step6(sqlite: Database.Database, now: number) {
  const P = profile();
  const hasRubric = sqlite.prepare("select count(*) from rubric_versions").pluck().get() as number;
  if (!hasRubric) {
    const briefs = Object.fromEntries(SECTION_KEYS.filter((k) => P.rubric.briefs[k]).map((k) => [k, P.rubric.briefs[k]]));
    sqlite
      .prepare(
        "insert into rubric_versions (version, dimensions, mechanics, avatars, note, current, created_at, rescore_at, briefs) values (1, ?, ?, ?, ?, 1, ?, ?, ?)",
      )
      .run(
        JSON.stringify(P.rubric.dimensions),
        JSON.stringify(P.rubric.mechanics),
        JSON.stringify(P.rubric.avatars),
        P.rubric.note,
        now,
        now, // the first version: scoring it is not a rescore (nothing to approve).
        Object.keys(briefs).length ? JSON.stringify(briefs) : null,
      );
    // The starter is already the "current" content: steps 8 and 11 (upgrades of an older rubric) never apply to it.
    sqlite.prepare("insert or ignore into app_settings (key, value) values (?, ?)").run(RTM_CONTEXT_V3_MARKER, String(now));
  }
  const insNote = sqlite.prepare("insert or ignore into notes (key, body, saved_at, updated_at) values (?, ?, null, ?)");
  insNote.run("rtm", P.seed.rtmNotes, now);
  insNote.run("whos_who", P.seed.whosWho, now);
  const setNotes = sqlite.prepare("update clients set brand_notes = ? where code = ? and (brand_notes is null or trim(brand_notes) = '')");
  for (const [code, body] of Object.entries(P.seed.brandNotes)) setNotes.run(body, code);
  sqlite.prepare("insert or ignore into app_settings (key, value) values ('hooks:paused', '1')").run();
}

/**
 * Step 7 (Phase 5 slice 1): one ad_accounts row per client with a Meta ad account (identity fpc) and each client folder's
 * `Static Ads/` (under STUDIO_CLIENT_DOCS_DIR, when it exists now) as a read-only root with a tag rule to that client, for
 * the clients in the DB at that point (provisionClient, the same code Settings > Clients uses). Lane C's own account
 * comes from the config (seedFromConfig). Only what is missing is inserted; nothing is written to those folders.
 */
export function staticAdsRoots(sqlite: Database.Database, clientDocsDir: string): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const rows = sqlite.prepare("select code, folder from clients where folder is not null order by sort, id").all() as { code: string; folder: string }[];
  for (const r of rows) {
    const real = staticAdsDir(clientDocsDir, r.folder);
    if (real) out.push({ path: real, code: r.code });
  }
  return out;
}

function step7(sqlite: Database.Database, now: number, dirs: { drivePath: string; clientDocsDir: string }) {
  const ids = sqlite.prepare("select id from clients order by sort, id").pluck().all() as number[];
  for (const id of ids) provisionClient(sqlite, id, dirs, { account: true, staticRoot: true }, now);
}

/**
 * Step 8 (Phase 5 slice 2): Lane C as a full section.
 *  - On a DB whose rubric does not score Lane C yet (an upgrade path: a fresh DB's starter already does): a NEW current
 *    version = the current one with Lane C added (withFkb: the Lane B dimensions incl. Offer clarity and Visual stop
 *    power, the Lane B avatars that are not universal only, same slugs), `rescore_at` null: hooks that already have a
 *    score are not due (the Rescore click only); never-scored hooks score on it. Only when no version names Lane C yet
 *    and the `rubric:fkb_added` marker is missing, so it lands exactly once; older versions are never edited.
 *  - Lane C's draft brand notes + one-line hint (notes keys fkb / fkb_hint, saved_at null = "Draft, check me", from the
 *    profile's `seed`), only where missing.
 *  - `<drive>/Studio Generated/<lane C folder>` as a root (a row only; the write guard creates the folder on first use).
 *    The lane's own media folders are config `roots` (slice 1b).
 *  (Before slice 1c it also appended a line to an unsaved who's who draft; the profile's `seed.whosWho` carries it now.)
 */
function step8(sqlite: Database.Database, now: number, drivePath: string) {
  const cur = sqlite.prepare("select version, dimensions, mechanics, avatars from rubric_versions where current = 1").get() as
    | { version: number; dimensions: string; mechanics: string; avatars: string }
    | undefined;
  const anyFkb = (sqlite.prepare("select dimensions from rubric_versions").pluck().all() as string[]).some((d) => {
    try {
      return rubricHasFkb({ dimensions: JSON.parse(d) });
    } catch {
      return false;
    }
  });
  // Marker: once added, Lane C's version is never added again (a later seed re-run, or a DB whose Lane C version was removed).
  const added = sqlite.prepare("select 1 from app_settings where key = 'rubric:fkb_added'").get();
  if (cur && !anyFkb && !added) {
    const content: RubricContent = withFkb({ dimensions: JSON.parse(cur.dimensions), mechanics: JSON.parse(cur.mechanics), avatars: JSON.parse(cur.avatars) });
    const next = ((sqlite.prepare("select max(version) from rubric_versions").pluck().get() as number | null) ?? 0) + 1;
    sqlite.prepare("update rubric_versions set current = 0 where current = 1").run();
    sqlite
      .prepare(
        "insert into rubric_versions (version, dimensions, mechanics, avatars, note, current, created_at, rescore_at) values (?, ?, ?, ?, ?, 1, ?, null)",
      )
      .run(next, JSON.stringify(content.dimensions), JSON.stringify(content.mechanics), JSON.stringify(content.avatars), LANE_C_ADDED_NOTE, now);
  }
  if (cur) sqlite.prepare("insert or ignore into app_settings (key, value) values ('rubric:fkb_added', ?)").run(String(now));
  const insNote = sqlite.prepare("insert or ignore into notes (key, body, saved_at, updated_at) values (?, ?, null, ?)");
  insNote.run(FKB_NOTE_KEY, profile().seed.companyNotes, now);
  insNote.run(FKB_HINT_KEY, profile().seed.companyHint, now);
  const insRoot = sqlite.prepare("insert or ignore into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)");
  const root = generatedFkbRoot(drivePath);
  insRoot.run(root.path, sectionIdOf(sqlite, root.section), now);
}

/** Marker: rubric v3 (the Lane A context) landed once; never added again (a later seed re-run, or a DB whose v3 was removed). */
export const RTM_CONTEXT_V3_MARKER = "rubric:rtm_context_v3";

/**
 * Step 11 (landing page Phase 2 slice 1, 2026-10-07): the Lane A context as a NEW current rubric version, on a DB whose
 * rubric predates it (an upgrade path: a fresh DB's starter sets the marker in step 6).
 *  - Content = the current version with its Lane A avatars replaced by the profile starter's (`withLaneAvatars`;
 *    dimensions, mechanics and every Lane B / C avatar unchanged). `briefs` = the current resolved briefs with Lane A's
 *    replaced by the starter's Lane A brief (when it has one). `section_versions` computed against the current version
 *    (`computeSectionVersions`): Lane A moves to the new number, Lane B and C keep theirs, so the copy gate's keys and a
 *    calibration on the older version never move. `rescore_at` null: nothing already scored is due (a click only). Lands
 *    once (marker `rubric:rtm_context_v3`); older versions are never edited.
 *  - The `rtm` note is refreshed to the profile's `seed.rtmNotes` only while it is still the unsaved seeded draft
 *    (saved_at null); a saved note is never touched.
 */
function step11(sqlite: Database.Database, now: number) {
  const P = profile();
  const cur = sqlite
    .prepare("select version, dimensions, mechanics, avatars, briefs, section_versions from rubric_versions where current = 1")
    .get() as { version: number; dimensions: string; mechanics: string; avatars: string; briefs: string | null; section_versions: string | null } | undefined;
  const landed = sqlite.prepare("select 1 from app_settings where key = ?").get(RTM_CONTEXT_V3_MARKER);
  if (cur && !landed) {
    const prevContent: RubricContent = { dimensions: JSON.parse(cur.dimensions), mechanics: JSON.parse(cur.mechanics), avatars: JSON.parse(cur.avatars) };
    const prevBriefs = parseBriefs(cur.briefs);
    const prevVersions = parseSectionVersions(cur.section_versions, cur.version);
    const content = withLaneAvatars(prevContent, "rtm", P.rubric.avatars);
    const briefs: RubricBriefs = { ...briefsOf({ briefs: prevBriefs }), ...(P.rubric.briefs.rtm ? { rtm: P.rubric.briefs.rtm } : {}) };
    const next = ((sqlite.prepare("select max(version) from rubric_versions").pluck().get() as number | null) ?? 0) + 1;
    const sectionVersions = computeSectionVersions(
      { content: prevContent, briefs: briefsOf({ briefs: prevBriefs }), sectionVersions: prevVersions },
      { content, briefs: briefsOf({ briefs }) },
      next,
    );
    sqlite.prepare("update rubric_versions set current = 0 where current = 1").run();
    sqlite
      .prepare(
        `insert into rubric_versions (version, dimensions, mechanics, avatars, note, current, created_at, rescore_at, briefs, section_versions)
         values (?, ?, ?, ?, ?, 1, ?, null, ?, ?)`,
      )
      .run(
        next,
        JSON.stringify(content.dimensions),
        JSON.stringify(content.mechanics),
        JSON.stringify(content.avatars),
        P.rubric.note,
        now,
        JSON.stringify(briefs),
        JSON.stringify(sectionVersions),
      );
  }
  if (cur) sqlite.prepare("insert or ignore into app_settings (key, value) values (?, ?)").run(RTM_CONTEXT_V3_MARKER, String(now));
  if (P.seed.rtmNotes) {
    sqlite.prepare("update notes set body = ?, updated_at = ? where key = 'rtm' and saved_at is null and body <> ?").run(P.seed.rtmNotes, now, P.seed.rtmNotes);
  }
}

/** Flattened defaults (fresh install view), used by docs and tests. */
export const IGNORE_SEED = [...STEP_1.ignores, ...STEP_2.ignores, ...STEP_9.ignores];

function applyStep(sqlite: Database.Database, step: Step, now: number) {
  const insIgnore = sqlite.prepare("insert or ignore into ignore_patterns (pattern) values (?)");
  for (const p of step.ignores) insIgnore.run(p);
  const hasRule = sqlite.prepare("select 1 from tag_rules where path_glob = ?");
  const insRule = sqlite.prepare("insert into tag_rules (path_glob, client_codes, created_at) values (?, ?, ?)");
  for (const r of step.rules) {
    if (!hasRule.get(r.glob)) insRule.run(r.glob, JSON.stringify(r.codes), now);
  }
}

function seedBase(sqlite: Database.Database) {
  sqlite.prepare("insert or ignore into worker_status (id) values (1)").run();
}

function sectionIdOf(sqlite: Database.Database, key: string): number {
  return (sqlite.prepare("select id from sections where key = ?").get(key) as { id: number }).id;
}

const CONFIG_PASS_KEY = "config:seeded_at";
const marker = (kind: string, key: string) => `config:${kind}:${key}`;

/**
 * The config pass (slice 1b, every DB open, idempotent, inserts only):
 *  - lanes: a missing lane row is inserted with the config's name / color / on-off / account options (else the neutral
 *    built-ins); an existing one is never updated.
 *  - clients: a missing client is inserted (name, account, hint, folder, campaigns, leads, GHL source, sort = its place in
 *    the file) and provisioned (ad account row, Studio Generated rule, Static Ads root); an existing one is never updated,
 *    except, once, filling its `folder` when still empty (the pre-1b DB had none). A client removed from the file stays.
 *  - Lane C's ad account (lanes.fkb.metaAdAccount), roots and tag rules: inserted once each (a `config:` marker per
 *    item), so one removed in Settings never comes back; on a DB seeded before 1b they are only marked (adopted) by the
 *    first pass that has a config with something in it (`config:seeded_at` ends the adopt window; a fresh DB never adopts).
 */
export function seedFromConfig(
  sqlite: Database.Database,
  studio: StudioFile,
  dirs: { drivePath: string; clientDocsDir: string },
  now = Date.now(),
): void {
  const seededBefore = Number((sqlite.prepare("select value from app_settings where key = 'seed_version'").pluck().get() as string | undefined) ?? 0) > 0;
  const adopting = seededBefore && !sqlite.prepare("select 1 from app_settings where key = ?").get(CONFIG_PASS_KEY);
  const has = sqlite.prepare("select 1 from app_settings where key = ?");
  const mark = sqlite.prepare("insert or ignore into app_settings (key, value) values (?, ?)");

  const lanes = studio.lanes ?? {};
  const insLane = sqlite.prepare(
    `insert or ignore into sections (key, name, color, sort, enabled, campaign_mode, campaign_id, leads_mode, ghl_source, ghl_location_id)
     values (@key, @name, @color, @sort, @enabled, @campaignMode, @campaignId, @leadsMode, @ghlSource, @ghlLocation)`,
  );
  for (const key of LANE_KEYS) {
    const base = NEUTRAL_LANES[key];
    const l = (lanes[key] ?? {}) as { name?: string; color?: string; enabled?: boolean; campaigns?: Parameters<typeof campaignColumns>[0]; leads?: string; ghlSource?: string; ghlLocation?: string };
    const camp = campaignColumns(l.campaigns);
    insLane.run({
      key,
      name: l.name ?? base.name,
      color: l.color ?? base.color,
      sort: base.sort,
      enabled: l.enabled === false ? 0 : 1,
      campaignMode: camp.mode,
      campaignId: camp.id,
      leadsMode: l.leads ?? "meta",
      ghlSource: l.ghlSource ?? null,
      ghlLocation: l.ghlLocation ?? null,
    });
  }

  const laneAct = lanes.fkb?.metaAdAccount;
  if (laneAct && !has.get(marker("account", laneAct))) {
    if (!adopting || !sqlite.prepare("select 1 from ad_accounts where act_id = ?").get(laneAct)) {
      sqlite
        .prepare("insert or ignore into ad_accounts (section_id, client_id, act_id, identity, sort) values (?, null, ?, 'fkb', 100)")
        .run(sectionIdOf(sqlite, "fkb"), laneAct);
    }
    mark.run(marker("account", laneAct), String(now));
  }

  const fkbpros = sectionIdOf(sqlite, "fkbpros");
  const insClient = sqlite.prepare(
    `insert into clients (section_id, code, name, meta_ad_account_id, classify_hint, folder, campaign_mode, campaign_id, leads_mode, ghl_source, sort)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  (studio.clients ?? []).forEach((c, i) => {
    const key = marker("client", c.code);
    const row = sqlite.prepare("select id, folder from clients where code = ?").get(c.code) as { id: number; folder: string | null } | undefined;
    if (!row) {
      const camp = campaignColumns(c.campaigns);
      const id = Number(
        insClient.run(fkbpros, c.code, c.name, c.metaAdAccount ?? null, c.hint ?? null, c.folder ?? null, camp.mode, camp.id, c.leads ?? "meta", c.ghlSource ?? null, i)
          .lastInsertRowid,
      );
      provisionClient(sqlite, id, dirs, { account: true, generatedRule: true, staticRoot: true }, now);
    } else if (!has.get(key) && row.folder == null && c.folder) {
      sqlite.prepare("update clients set folder = ? where id = ?").run(c.folder, row.id);
    }
    mark.run(key, String(now));
  });

  const insRoot = sqlite.prepare("insert or ignore into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)");
  for (const r of studio.roots ?? []) {
    const abs = path.isAbsolute(r.path) ? path.resolve(r.path) : path.join(dirs.drivePath, r.path);
    const key = marker("root", abs);
    if (has.get(key)) continue;
    if (!adopting) insRoot.run(abs, sectionIdOf(sqlite, r.lane), now);
    mark.run(key, String(now));
  }
  const hasRule = sqlite.prepare("select 1 from tag_rules where path_glob = ?");
  const insRule = sqlite.prepare("insert into tag_rules (path_glob, client_codes, created_at) values (?, ?, ?)");
  for (const r of studio.tagRules ?? []) {
    const key = marker("rule", r.glob);
    if (has.get(key)) continue;
    if (!adopting && !hasRule.get(r.glob)) insRule.run(r.glob, JSON.stringify(r.clients), now);
    mark.run(key, String(now));
  }
  // The adopt window closes on a 1b-era DB at once, on a pre-1b DB only with the first pass that has something in it: an
  // empty (missing) config on the original install never ends adoption, so its later first real config only marks.
  const hasContent = Boolean(studio.lanes || studio.clients?.length || studio.roots?.length || studio.tagRules?.length);
  if (!seededBefore || hasContent) mark.run(CONFIG_PASS_KEY, String(now));
}

export function seed(sqlite: Database.Database, opts: { drivePath: string; clientDocsDir: string; studio?: StudioFile }) {
  const row = sqlite.prepare("select value from app_settings where key = 'seed_version'").get() as
    | { value: string }
    | undefined;
  const current = Number(row?.value ?? 0) || 0;
  const now = Date.now();
  const dirs = { drivePath: opts.drivePath, clientDocsDir: opts.clientDocsDir };
  sqlite.transaction(() => {
    seedFromConfig(sqlite, opts.studio ?? getConfig().studio, dirs, now);
    if (current >= SEED_VERSION) return;
    if (current < 1) {
      seedBase(sqlite);
      applyStep(sqlite, STEP_1, now);
    }
    if (current < 2) applyStep(sqlite, STEP_2, now);
    if (current < 4) {
      const step = step4(sqlite, opts.drivePath);
      applyStep(sqlite, step, now);
      const insRoot = sqlite.prepare("insert or ignore into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)");
      for (const r of step.roots) insRoot.run(r.path, sectionIdOf(sqlite, r.section), now);
    }
    if (current < 5) step5(sqlite);
    if (current < 6) step6(sqlite, now);
    if (current < 7) step7(sqlite, now, dirs);
    if (current < 8) step8(sqlite, now, opts.drivePath);
    if (current < 9) applyStep(sqlite, STEP_9, now);
    if (current < 10) {
      applyStep(sqlite, STEP_9, now);
      sqlite.prepare("delete from ignore_patterns where pattern = ?").run(THUMBNAIL_FRAMES_IGNORE_V9);
    }
    if (current < 11) step11(sqlite, now);
    sqlite
      .prepare(
        "insert into app_settings (key, value) values ('seed_version', ?) on conflict(key) do update set value = excluded.value",
      )
      .run(String(SEED_VERSION));
  })();
}
