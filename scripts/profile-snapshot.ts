/**
 * The model-facing text dump (Creative Studio slice 1c, business profile): every string Jev, Ollama or `claude -p` reads,
 * built for representative fixtures on a FRESH temp DB seeded from a Studio config, plus the copy rule verdicts on probe
 * lines, the ad name previews / parsers, the campaign pick and the seeded notes / rubric content.
 *
 *   npx tsx scripts/profile-snapshot.ts            writes private/profile-snapshot.json from private/studio.config.json
 *
 * The snapshot was written by THIS script against the pre-refactor code (commit ced48b2, every business text still a
 * code constant; its `legacyRubric` = the v1 / v2 / v3 rows that seed wrote). scripts/smoke-profile.ts rebuilds the dump
 * with the private profile and asserts it is deep equal (byte identity), and builds it again on a made-up config with NO
 * profile and asserts no business word appears. Running this script again REFUSES to overwrite the snapshot; `--force`
 * re-baselines it from the current code (keeping the stored legacyRubric): only after a deliberate, reviewed change to
 * the original install's model-facing text.
 *
 * Fixtures: a Lane A / Lane B client / Lane B shared / Lane C hook (text + video) for every rubric version in the DB; on
 * the private config that DB first gets the rubric history the original install holds (`legacyRubric`, the rows the
 * pre-refactor seed wrote, read back from the snapshot), so v1, v2 and v3 are all covered. Never the live DB, Jev, Ollama,
 * claude or the network (FakeJev, a stub Graph).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { StudioFile } from "../src/lib/studio-config";

export const SNAPSHOT_FILE = path.join(process.cwd(), "private", "profile-snapshot.json");

export type LegacyRubricRow = {
  version: number;
  dimensions: string;
  mechanics: string;
  avatars: string;
  note: string | null;
  current: number;
  rescore_clicked: number;
  briefs: string | null;
  section_versions: string | null;
};

type Dump = Record<string, unknown>;

/**
 * Fixture inputs that carry business words. `original` = exactly what the snapshot was taken with (the original install's
 * names), kept in private/profile-fixtures.json next to the snapshot; `neutral` = the same shapes in neutral words (the
 * no-profile denylist dump). Everything else is shared.
 */
type Fixture = {
  oneClient: string | null;
  filename: string;
  relPath: string;
  rootLabel: string;
  adNames: (code: string) => { parse: string[]; number: string[]; compact: string[]; campaigns: string[][] };
};

export const PRIVATE_FIXTURES_FILE = path.join(process.cwd(), "private", "profile-fixtures.json");

const NEUTRAL_FIXTURE: Fixture = {
  oneClient: null,
  filename: "Studio Reveal Ad 3.mp4",
  relPath: "renders/batch/Studio Reveal Ad 3.mp4",
  rootLabel: "Client ads",
  adNames: (code: string) => ({
    parse: [`${code}-coopboard_paperwork-ps-07`, `${code}-x-obj-3`, `zz-${code}-x-ps-3`, "Something else"],
    number: [`${code}-thing-11`, "other Ad 06", "Universal-12", `${code}-x-04`],
    compact: ["JD Ad 2.mov", "Ad2.mov", "jd   big   reveal.mp4", "short"],
    campaigns: [["Brand awareness", "Spring launch", `${code} spring`], ["Brand awareness", `${code} spring`], ["Only one"], ["One", "Two"]],
  }),
};

/** The original install's fixture inputs (private/profile-fixtures.json; `{code}` = the client code). */
function privateFixture(): Fixture {
  const raw = JSON.parse(fs.readFileSync(PRIVATE_FIXTURES_FILE, "utf8")) as Omit<Fixture, "adNames"> & { adNames: Record<string, unknown> };
  const fill = (v: unknown, code: string): unknown =>
    typeof v === "string"
      ? v.split("{code}").join(code)
      : Array.isArray(v)
        ? v.map((x) => fill(x, code))
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, code)]))
          : v;
  return { ...raw, adNames: (code: string) => fill(raw.adNames, code) as ReturnType<Fixture["adNames"]> };
}

const FIXTURES = { original: privateFixture, neutral: () => NEUTRAL_FIXTURE } as const;

/** First client code of the config (the "one client" fixture), or null. */
function firstClient(studio: StudioFile, prefer?: string): string | null {
  const codes = (studio.clients ?? []).map((c) => c.code);
  return prefer && codes.includes(prefer) ? prefer : (codes[0] ?? null);
}

/**
 * Build the dump. `studio` = the config the fresh DB is seeded from (and, after slice 1c, whose profile is active while
 * building); `legacyRubric` = rubric rows to put in place of the seeded ones before the hook dumps (the original install's
 * history), or null to keep what the seed wrote.
 */
export async function buildProfileDump(opts: {
  studio: StudioFile;
  tmp: string;
  legacyRubric: LegacyRubricRow[] | null;
  /** Run `fn` with this config's profile active (src/lib/profile.ts withProfile). */
  withProfile?: <T>(p: StudioFile["profile"], fn: () => Promise<T>) => Promise<T>;
  /** Which fixture words to use (default original). */
  fixtures?: keyof typeof FIXTURES;
}): Promise<Dump> {
  const run = opts.withProfile ?? (async <T>(_p: unknown, fn: () => Promise<T>) => fn());
  return run(opts.studio.profile, () => build(opts));
}

async function build(opts: { studio: StudioFile; tmp: string; legacyRubric: LegacyRubricRow[] | null; fixtures?: keyof typeof FIXTURES }): Promise<Dump> {
  const { studio, tmp } = opts;
  const FX = FIXTURES[opts.fixtures ?? "original"]();
  const { MIGRATIONS_DIR } = await import("../src/lib/db");
  const { seed } = await import("../src/lib/db/seed");
  const classify = await import("../src/lib/ai/classify");
  const describe = await import("../src/lib/ai/describe");
  const notesLib = await import("../src/lib/hooks/notes");
  const store = await import("../src/lib/hooks/store");
  const scoreLib = await import("../src/lib/hooks/score");
  const gate = await import("../src/lib/hooks/copygate");
  const pagegate = await import("../src/lib/pages/pagegate");
  const variants = await import("../src/lib/hooks/variants");
  const vrules = await import("../src/lib/hooks/variant-rules");
  const moments = await import("../src/lib/shorts/moments");
  const srules = await import("../src/lib/shorts/rules");
  const adJob = await import("../src/lib/meta/ad-copy-job");
  const adRules = await import("../src/lib/meta/ad-copy-rules");
  const newAd = await import("../src/lib/meta/new-ad");
  const adMap = await import("../src/lib/meta/ad-map");
  const match = await import("../src/lib/meta/match");
  const sync = await import("../src/lib/meta/sync");
  const claude = await import("../src/lib/hooks/claude");
  const profileLib = await import("../src/lib/profile");
  const { FakeJev } = await import("../src/lib/ai/fake");
  const { Jev } = await import("../src/lib/ai/jev");
  const { ClassifyQueue } = await import("../src/worker/classify");

  const dir = fs.mkdtempSync(path.join(tmp, "profile-dump-"));
  const drivePath = path.join(dir, "drive");
  const clientDocsDir = path.join(dir, "fpc");
  fs.mkdirSync(drivePath, { recursive: true });
  fs.mkdirSync(clientDocsDir, { recursive: true });
  const s = new Database(path.join(dir, "dump.db"));
  s.pragma("foreign_keys = ON");
  migrate(drizzle(s), { migrationsFolder: MIGRATIONS_DIR });
  seed(s, { drivePath, clientDocsDir, studio });

  const out: Dump = {};
  const sortRows = (rows: Record<string, unknown>[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  // ------------------------------------------------------------------ seed (fresh DB)
  const cur = store.currentRubric(s);
  out.seed = {
    notes: sortRows(s.prepare("select key, body, saved_at is null as draft from notes").all() as Record<string, unknown>[]),
    clients: sortRows(s.prepare("select code, name, classify_hint, brand_notes from clients").all() as Record<string, unknown>[]),
    rubricCurrent: {
      dimensions: cur.dimensions,
      mechanics: cur.mechanics,
      avatars: cur.avatars,
      briefs: notesLib.briefsOf(cur),
    },
    rubricMarkers: s
      .prepare("select key from app_settings where key like 'rubric:%' order by key")
      .pluck()
      .all(),
  };
  out.seedRubricRows = (
    s.prepare("select version, note, current, rescore_at is not null as rescore_clicked, briefs, section_versions from rubric_versions order by version").all()
  );

  if (opts.legacyRubric) {
    s.prepare("delete from rubric_versions").run();
    const ins = s.prepare(
      `insert into rubric_versions (version, dimensions, mechanics, avatars, note, current, created_at, rescore_at, briefs, section_versions)
       values (@version, @dimensions, @mechanics, @avatars, @note, @current, 1000, @rescore, @briefs, @section_versions)`,
    );
    for (const r of opts.legacyRubric) ins.run({ ...r, rescore: r.rescore_clicked ? 1000 : null });
  }

  const live = store.currentRubric(s);
  const clientId = (code: string) => s.prepare("select id from clients where code = ?").pluck().get(code) as number;
  const oneClient = firstClient(studio, FX.oneClient ?? undefined);

  // ------------------------------------------------------------------ describe
  out.describe = { image: describe.imagePrompt(profileLib.profile()), opening: describe.videoPrompt("opening", profileLib.profile()), poster: describe.videoPrompt("poster", profileLib.profile()) };

  // ------------------------------------------------------------------ classify
  const clientInfos = (
    s.prepare("select c.code, c.name, c.classify_hint from clients c join sections s on s.id = c.section_id where s.key = 'fkbpros' order by c.sort, c.name").all() as {
      code: string;
      name: string;
      classify_hint: string | null;
    }[]
  ).map((c) => ({ code: c.code, name: c.name, hint: c.classify_hint?.trim() || c.name }));
  // Corrections through the worker's own example builder (its "shared" label rides along on a clients [] answer).
  const rootId = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, (select id from sections where key = 'fkbpros'), 1, 1)").run(path.join(drivePath, "dump-root")).lastInsertRowid);
  const insAsset = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status, description)
     values ((select id from sections where key = 'fkbpros'), ?, ?, ?, ?, 'jpg', 'image', 1, 1, 1, 'done', ?)`,
  );
  const a1 = Number(insAsset.run(rootId, path.join(drivePath, "dump-root", "renders", "a1.jpg"), "renders/a1.jpg", "a1.jpg", "A tidy room with a big headline.").lastInsertRowid);
  const a2 = Number(insAsset.run(rootId, path.join(drivePath, "dump-root", "renders", "a2.jpg"), "renders/a2.jpg", "a2.jpg", "A logo on a plain background.").lastInsertRowid);
  const a3 = Number(insAsset.run(rootId, path.join(drivePath, "dump-root", "renders", "a3.jpg"), "renders/a3.jpg", "a3.jpg", "A person holding a sign.").lastInsertRowid);
  const insCorr = s.prepare("insert into ai_corrections (asset_id, question, jev_answer, ronny_answer, created_at) values (?, ?, ?, ?, ?)");
  insCorr.run(a1, "asset_class", JSON.stringify("job_photo"), JSON.stringify("static_ad"), 1);
  insCorr.run(a2, "clients", JSON.stringify([]), JSON.stringify([]), 2);
  if (oneClient) insCorr.run(a3, "clients", JSON.stringify([]), JSON.stringify([oneClient]), 3);
  const fj0 = new FakeJev();
  const queue = new ClassifyQueue(s, { jev: new Jev(s, fj0, "jev-1.13.0", { sleep: async () => {} }), visionModel: "fake", log: () => {}, isStopped: () => true });
  const examples = queue.examples(-1);
  const baseInput: Record<string, unknown> = {
    id: 1,
    filename: FX.filename,
    relPath: FX.relPath,
    rootLabel: FX.rootLabel,
    orientation: "9:16",
    durationS: 24,
    description: "First 3 seconds: a reveal of a finished room.\nShows: a room, text overlays.\nText: \"BIG REVEAL\"",
    spokenOpen: "Still waiting on that quote?",
    generationPrompt: null,
    fixedClients: [] as string[],
    manualClass: null,
  };
  const ci = (section: "rtm" | "fkbpros" | "fkb", kind: "image" | "video", extra: Record<string, unknown> = {}) => ({ ...baseInput, section, kind, ...extra });
  const classifyInputs = {
    rtmImage: ci("rtm", "image", { filename: "Ep 7 thumb.png", spokenOpen: null }),
    rtmVideo: ci("rtm", "video"),
    clientsImage: ci("fkbpros", "image", { spokenOpen: null }),
    clientsVideo: ci("fkbpros", "video"),
    clientsTagged: ci("fkbpros", "video", { fixedClients: oneClient ? [studio.clients!.find((c) => c.code === oneClient)!.name] : [] }),
    fkbImage: ci("fkb", "image", { spokenOpen: null }),
    fkbVideo: ci("fkb", "video", { generationPrompt: "a bright room, morning light" }),
    manualAd: ci("fkbpros", "image", { manualClass: "static_ad" as never, spokenOpen: null }),
  };
  out.classify = Object.fromEntries(
    Object.entries(classifyInputs).map(([k, input]) => [
      k,
      { state: classify.buildState(input as never, examples), questions: classify.buildQuestions(input as never, clientInfos, examples) },
    ]),
  );
  out.classifyExamples = examples;

  // ------------------------------------------------------------------ hooks: state + questions per rubric version
  const versions = [...store.rubricVersions(s).values()].sort((a, b) => a.version - b.version);
  const vid = { firstSeconds: "A person walks into a finished room", onScreenText: "One week, start to finish", spokenOpening: "Still stepping over that old tub?" };
  const hookInputs = {
    rtmText: { ...notesLib.loadChannelNotes(s, "rtm", null), id: 1, kind: "text" as const, text: "Boosted posts got you likes, not leads?", video: null },
    rtmVideo: { ...notesLib.loadChannelNotes(s, "rtm", null), id: 2, kind: "video" as const, text: "Your ads are not the problem.", video: { ...vid, textFrom: "spoken" as const } },
    rtmOpening: { ...notesLib.loadChannelNotes(s, "rtm", null), id: 3, kind: "video" as const, text: "A screen recording of an ad account", video: { ...vid, spokenOpening: null, onScreenText: null, textFrom: "opening" as const, earlyFrame: true } },
    ...(oneClient
      ? {
          clientText: { ...notesLib.loadChannelNotes(s, "fkbpros", clientId(oneClient)), id: 4, kind: "text" as const, text: "Most Rooms Done in About a Week", video: null },
          clientVideo: { ...notesLib.loadChannelNotes(s, "fkbpros", clientId(oneClient)), id: 5, kind: "video" as const, text: "Still stepping over that old tub?", video: { ...vid, textFrom: "spoken" as const } },
        }
      : {}),
    sharedText: { ...notesLib.loadChannelNotes(s, "fkbpros", null), id: 6, kind: "text" as const, text: "A vetted local pro for your project", video: null },
    sharedVideo: { ...notesLib.loadChannelNotes(s, "fkbpros", null), id: 7, kind: "video" as const, text: "Watch this", video: { ...vid, textFrom: "onscreen" as const } },
    fkbText: { ...notesLib.loadChannelNotes(s, "fkb", null), id: 8, kind: "text" as const, text: "Dream Rooms Start Here", video: null },
    fkbVideo: { ...notesLib.loadChannelNotes(s, "fkb", null), id: 9, kind: "video" as const, text: "One team from design to construction.", video: { ...vid, textFrom: "spoken" as const } },
  };
  out.hooks = Object.fromEntries(
    versions.map((r) => [
      `v${r.version}`,
      Object.fromEntries(
        Object.entries(hookInputs).map(([k, input]) => {
          const b = scoreLib.buildHookState(r, input as never);
          return [k, { state: b.state, notesFp: b.notesFp, questions: scoreLib.buildHookQuestions(r, input as never) }];
        }),
      ),
    ]),
  );
  out.notesFp = Object.fromEntries(Object.entries(hookInputs).map(([k, input]) => [k, notesLib.channelNotesFp(input as never)]));

  // ------------------------------------------------------------------ copy gate + page scorer (FakeJev)
  const fj = new FakeJev();
  const jev = new Jev(s, fj, "jev-1.13.0", { sleep: async () => {} });
  const lines = [
    { id: "h1", field: "headline" as const, text: "Meta ads that turn ad spend into booked calls." },
    { id: "p1", field: "primary" as const, text: "Paying for clicks that never call?\n\nHere is the fix.\n\n✅ One person runs it" },
  ];
  const gateCodes = ["rtm", ...(oneClient ? [oneClient] : []), "fkb"];
  const gateOut: Dump = {};
  for (const code of gateCodes) {
    const before = fj.requests.length;
    const o = await gate.scoreCopyLines(s, jev, { code, lines });
    gateOut[code] = {
      rubric_version: o.rubric_version,
      rubric_version_global: o.rubric_version_global,
      context_fp: o.context_fp,
      scored: o.results.map((r) => r.scored_text),
      requests: fj.requests.slice(before).map((r) => ({ state: r.state, questions: r.questions })),
    };
  }
  out.copyGate = gateOut;
  const page = {
    page: { site: "example.com", stage: "draft", headline: "Ads that turn spend into booked calls" },
    voice: ["I run every account myself."],
    sections: [
      { id: "s1", part: "eyebrow", text: "For small business owners running ads", ctas: [] },
      { id: "s2", part: "headline", text: "Ads that turn spend into booked calls", ctas: ["Book a call"] },
      { id: "s3", part: "offer", text: "A free audit of your ad account", ctas: ["Get the audit"] },
    ],
  };
  const pageOut: Dump = {};
  for (const code of gateCodes) {
    const req = pagegate.pageGateRequestSchema.parse({ code, ...page });
    const before = fj.requests.length;
    const o = await pagegate.scorePage(s, jev, req);
    pageOut[code] = {
      resolve: pagegate.resolvePage(s, req, "jev-1.13.0"),
      context_fp: o.context_fp,
      hook_rubric_version: o.hook_rubric_version,
      section_version: o.section_version,
      requests: fj.requests.slice(before).map((r) => ({ state: r.state, questions: r.questions })),
    };
  }
  out.pageScorer = pageOut;

  // ------------------------------------------------------------------ claude -p prompts
  out.claudeSystem = claude.CLAUDE_SYSTEM_PROMPT;
  out.momentsSystem = moments.momentsSystemPrompt();
  const sentences = Array.from({ length: 14 }, (_, i) => ({ start: i * 6, end: i * 6 + 5.5, text: `Sentence number ${i + 1} about ads and leads.` }));
  const allClients = s
    .prepare("select c.code, c.name, c.brand_notes as brandNotes from clients c join sections s on s.id = c.section_id where s.key = 'fkbpros' order by c.sort, c.id")
    .all() as { code: string; name: string; brandNotes: string | null }[];
  const momentCtx = {
    episode: { id: 1, num: 7, title: "The Agency Question", label: "Ep 7 · The Agency Question", durationS: 84, cues: sentences, sentences, goneAt: null, masterAssetId: null, masterPath: null, folder: "/x", reelDirs: [] },
    sentences,
    episodeEnd: 84,
    taken: [{ start: 6, end: 40, hookWords: "YOU PAID FOR *THIS LEAD*" }],
    allClients,
  };
  out.moments = {
    prompt: moments.buildMomentsPrompt(momentCtx as never),
    retry: moments.buildMomentsPrompt({ ...momentCtx, taken: [] } as never, ["hook: names a client"]),
  };

  const add = (section: "rtm" | "fkbpros" | "fkb", code: string | null, text: string) =>
    store.addTextHooks(s, { section, clientCode: code }, [{ text, source: "manual" }]).ids[0];
  const vHooks: Record<string, number> = {
    rtm: add("rtm", null, "Paying for clicks that never call?"),
    ...(oneClient ? { client: add("fkbpros", oneClient, "Most rooms done in about a week") } : {}),
    shared: add("fkbpros", null, "A vetted local pro for your project"),
    fkb: add("fkb", null, "One team from design to construction"),
  };
  // A score on the client hook so the prompt carries the scores block (rubric, levels, P's, mechanic, avatar).
  if (vHooks.client) {
    const avatar = live.avatars.find((a) => a.section === "fkbpros" && !a.universalOnly)?.slug ?? null;
    s.prepare(
      `insert into hook_scores (hook_id, rubric_version, answers, unsure, overall, pp_person, pp_pain, pp_promise, style, avatar, model, scored_at)
       values (?, ?, ?, '[]', 2.8, 0.7, 0.2, 0.6, 'be_specific', ?, 'jev-1.13.0', 1)`,
    ).run(vHooks.client, live.version, JSON.stringify({ specificity: { type: "score", value: 1, probabilities: {}, confidence: 0.9 }, curiosity_gap: { type: "score", value: 2.4, probabilities: {}, confidence: 0.9 } }), avatar);
  }
  const variantOut: Dump = {};
  for (const [k, id] of Object.entries(vHooks)) {
    const ctx = variants.variantContext(s, id);
    variantOut[k] = { channelLabel: ctx.channelLabel, brief: ctx.brief, prompt: variants.buildVariantPrompt(ctx, null) };
  }
  const vctx = variants.variantContext(s, vHooks.rtm);
  variantOut.rtmVideoSteer = variants.buildVariantPrompt({ ...vctx, hook: { ...vctx.hook, kind: "video" }, video: { spoken: "Ads are not the problem.", onScreen: null, opening: "A man at a desk" } }, "make it punchier", ["dash: dash \"—\""]);
  out.variants = variantOut;

  const adOut: Dump = {};
  const adCodes = [...(oneClient ? [oneClient] : []), "fkb"];
  for (const code of adCodes) {
    const ch = newAd.adChannel(s, code);
    if (!ch) {
      adOut[code] = null;
      continue;
    }
    const hookId = code === "fkb" ? vHooks.fkb : vHooks.client;
    const empty = { headlines: ["", "", ""], primaries: ["", ""], description: "" };
    const ctx = adJob.adCopyContext(s, { metaEnvFile: path.join(dir, "no-meta.env"), clientDocsDir }, { channel: code, hookId, angleKey: null, filled: empty });
    const ctxP1 = adJob.adCopyContext(
      s,
      { metaEnvFile: path.join(dir, "no-meta.env"), clientDocsDir },
      { channel: code, hookId, angleKey: "speed", filled: { headlines: ["Done in a week", "", ""], primaries: ["A long hook line that opens the first primary text of this ad", ""], description: "" }, p1Opening: "A long hook line that opens the first primary text of this ad" },
    );
    adOut[code] = {
      channelLabel: ctx.channelLabel,
      landing: ch.landing,
      label: ch.label,
      prompt: adJob.buildAdCopyPrompt(ctx),
      promptP1: adJob.buildAdCopyPrompt(ctxP1, ["Headline 2: A dash"]),
      bans: ctx.bans,
    };
  }
  out.adCopy = adOut;

  // ------------------------------------------------------------------ copy rule verdicts on probe lines
  const probes = [
    "Most rooms done in about a week",
    "Walk-in shower, 10-year warranty",
    "Fast — and clean",
    "Fast - and clean",
    "A range 10-12 days",
    "Follow-up that books calls",
    "Only $99 a month with financing",
    "Licensed and insured, since 1983",
    "Rated 4.9 stars on Google",
    "We serve New Jersey and New York",
    "Let us elevate your space",
    "- a dash bullet line",
    "🏠 New look 🛁 fast 🚀",
    "Visit www.example.com today",
    ...allClients.flatMap((c) => [`Ask ${c.name.split(" / ")[0]} today`, `Code ${c.code} inside`]),
  ];
  const ruleCtx = (section: "rtm" | "fkbpros" | "fkb", client: string | null) => ({
    section,
    client: client ? (allClients.find((c) => c.code === client) ?? null) : null,
    allClients,
    existingNorms: new Set<string>(),
    ownNotes: section === "fkb" ? (notesLib.getNoteRow(s, notesLib.FKB_NOTE_KEY)?.body ?? null) : null,
    house: profileLib.houseRulesFor(section),
  });
  const vr: Dump = {};
  for (const [k, c] of Object.entries({ rtm: ruleCtx("rtm", null), client: ruleCtx("fkbpros", oneClient), shared: ruleCtx("fkbpros", null), fkb: ruleCtx("fkb", null) })) {
    const compiled = vrules.compileVariantRules(c as never);
    vr[k] = {
      names: compiled.names.map((n) => n.name),
      phrases: compiled.phrases.map((p) => p.phrase),
      claims: compiled.claims.map((x) => x.id),
      verdicts: probes.map((p) => vrules.checkVariant(p, compiled, new Set())),
      dash: probes.map((p) => vrules.dashProblem(p, profileLib.houseRulesFor(c.section).dashes, profileLib.houseRulesFor(c.section).noHyphenMessage)),
    };
  }
  out.variantRules = vr;
  const overlay = srules.overlayRules(allClients);
  out.shortsRules = {
    hookWords: ["YOU PAID FOR *THIS LEAD*", "FOLLOW-UP *WINS*", "NEW JERSEY *ADS*", "TOO", ...allClients.map((c) => `ASK ${c.code.toUpperCase()} *NOW*`)].map((w) => srules.checkHookWords(w, overlay)),
    prose: probes.map((p) => srules.proseProblem(p, "first line")),
    moment: srules.checkMoment(
      { start: 0, end: 47.5, firstLine: "", hook: "THE 3 P'S OF *AD COPY*", why: "A clear rule — with a payoff.", layout: "stack", coldStart: 6, coldEnd: 11.5 },
      { cues: sentences, episodeEnd: 84, taken: [], overlay, unit: "sentence" },
    ),
  };
  const ar: Dump = {};
  for (const code of adCodes) {
    const ch = newAd.adChannel(s, code);
    if (!ch) continue;
    const rc = newAd.adRuleContext(s, { metaEnvFile: path.join(dir, "no-meta.env") }, ch);
    const compiled = adRules.compileAdRules(rc);
    ar[code] = {
      bans: [...compiled.bans].sort(),
      names: compiled.names.map((n) => n.label),
      lines: probes.map((p) => ({ h: adRules.checkAdLine(p, "headline", compiled), p: adRules.checkAdLine(p, "primary", compiled), d: adRules.checkAdLine(p, "description", compiled) })),
      set: adRules.checkAdCopy({ headlines: ["$99 deal", "Two", "Three"], primaries: ["Only $99", "Another one"], description: "Short" }, compiled),
    };
  }
  out.adRules = ar;
  out.adPalette = profileLib.profile().adCopy.emojiPalette;

  // ------------------------------------------------------------------ ad names, parsers, campaign pick
  const code = oneClient ?? "acme";
  const names = FX.adNames(code);
  out.adNames = {
    previews: [
      adRules.namePreview("fkbpros", code, "coopboard_paperwork", "ps", 7, newAd.adNaming()),
      adRules.namePreview("fkbpros", code, "", "obj", 12, newAd.adNaming()),
      adRules.namePreview("fkb", "fkb", "", "ps", 9, newAd.adNaming()),
    ],
    concept: [adRules.conceptProblem("", newAd.adNaming()), adRules.conceptProblem("Bad-Name", newAd.adNaming())],
    parse: names.parse.map((n) => adMap.parseFpcName(n, code)),
    number: names.number.map((n) => match.adNumber(n, code)),
    compact: names.compact.map((n) => match.compactMediaName(n)),
  };
  const pick = async (names: string[], accCode: string) => {
    const list = names.map((n, i) => ({ id: String(100 + i), name: n }));
    const graph = { getAll: async () => list, get: async () => ({ id: "0", name: "x" }) };
    try {
      const r = await sync.findCampaigns(graph as never, { code: accCode, act_id: "act_1", campaign_mode: "state_json", campaign_id: null } as never, path.join(dir, "no-clients"));
      return { ok: r.campaigns.map((c) => c.name), source: r.source };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  out.campaignPick = [];
  for (const list of names.campaigns) (out.campaignPick as unknown[]).push(await pick([...list], code));
  s.close();
  return out;
}

// ---------------------------------------------------------------------------------------------- CLI

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "profile-snapshot-"));
  process.env.STUDIO_ENV_FILE = path.join(tmp, "studio.env");
  process.env.STUDIO_DB = path.join(tmp, "studio.db");
  process.env.STUDIO_CACHE = path.join(tmp, "cache");
  process.env.STUDIO_LOGS = path.join(tmp, "logs");
  process.env.STUDIO_DRIVE = path.join(tmp, "drive");
  process.env.STUDIO_DRIVE_MODE = "external";
  process.env.META_ENV_FILE = path.join(tmp, "no-meta.env");
  process.env.META_FKB_ENV_FILE = path.join(tmp, "no-fkb-meta.env");
  process.env.STUDIO_CLIENT_DOCS_DIR = path.join(tmp, "fpc-clients");
  process.env.YOUTUBE_CLIENT_SECRET_FILE = path.join(tmp, "no-client-secret.json");
  process.env.YOUTUBE_TOKEN_FILE = path.join(tmp, "no-youtube-token.json");
  process.env.STUDIO_HANDOFFS = path.join(tmp, "handoffs");
  process.env.STUDIO_REEL_KIT_DIR = path.join(tmp, "reel-kit");
  process.env.META_PENDING_DIR = path.join(tmp, "pending-fpc");
  process.env.META_FKB_PENDING_DIR = path.join(tmp, "pending-fkb");
  process.env.STUDIO_CONFIG = path.join(process.cwd(), "private", "studio.config.json");
  const { ensureEnvFile, getConfig } = await import("../src/lib/config");
  const { withProfile } = await import("../src/lib/profile");
  ensureEnvFile();
  const cfg = getConfig();
  if (fs.existsSync(SNAPSHOT_FILE)) {
    if (!process.argv.includes("--force")) throw new Error(`${SNAPSHOT_FILE} exists (the pre-refactor baseline). Pass --force to re-baseline it.`);
    const saved = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")) as { takenAt: string; legacyRubric: LegacyRubricRow[] };
    const dump = await buildProfileDump({ studio: cfg.studio, tmp, legacyRubric: saved.legacyRubric, withProfile });
    fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify({ takenAt: `${saved.takenAt} (re-baselined)`, legacyRubric: saved.legacyRubric, dump }, null, 1)}\n`);
    console.log(`re-baselined ${SNAPSHOT_FILE}`);
    return;
  }
  const dump = await buildProfileDump({ studio: cfg.studio, tmp, legacyRubric: null });
  // The original install's rubric history = the rows the pre-refactor seed wrote; kept for the smoke's legacy DB.
  const s = new Database(path.join(fs.readdirSync(tmp).filter((d) => d.startsWith("profile-dump-")).map((d) => path.join(tmp, d))[0], "dump.db"), { readonly: true });
  const legacy = s
    .prepare("select version, dimensions, mechanics, avatars, note, current, rescore_at is not null as rescore_clicked, briefs, section_versions from rubric_versions order by version")
    .all();
  s.close();
  fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify({ takenAt: "ced48b2", legacyRubric: legacy, dump }, null, 1)}\n`);
  console.log(`wrote ${SNAPSHOT_FILE} (${(fs.statSync(SNAPSHOT_FILE).size / 1024).toFixed(0)} KB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
