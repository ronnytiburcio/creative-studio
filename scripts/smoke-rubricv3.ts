/**
 * Landing page Phase 2 slice 1 smoke checks (called by scripts/smoke.ts after the copy gate checks): rubric v3, the NSM
 * context, with per section versions. Migration 0023's backfill on a DB that had v1 + v2 before it (every old version
 * keeps its own number per section, briefs null), seed step 11 on that v2 DB (v3 current, rescore_at null, the NSM
 * avatars replaced, section versions {rtm 3, fkbpros 2, fkb 2}, briefs, v1 / v2 untouched, the marker, idempotent, an
 * unsaved seeded NSM note refreshed and a saved one never touched), `briefOf`, BYTE IDENTITY (an SGD Pros client hook,
 * a shared SGD Pros hook and an SGD hook build the same state + questions JSON under v2 and v3), `saveRubricVersion`'s
 * section bumps, the copy gate's section version / global version / context_fp (CLI included), and hooks (no scored
 * hook due on v3; `requestSectionRescore("rtm")` requests only live NSM hooks lacking v3, and the queue scores exactly
 * those on v3 with the new brief). FRESH temp DBs and FakeJev only: never the live DB, Jev or the network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { StudioConfig } from "../src/lib/config";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

/** The NSM note body as an older seed wrote it (before the v3 refresh): what a never saved live note still holds. */
const OLD_RTM_DRAFT = "Northstar Media is Alex Nolan's one person marketing brand.\nOld seeded draft line.";
/** No avatar or brief may promise call handling, call backs or appointment setting by Alex (Alex 2026-10-07). */
export const CALL_HANDLING = /call ?backs?|calling (them|leads) back|answer(s|ing)? (the |your )?(calls|phone)|appointment setting|sets? (the |your )?appointments|handles? (the |your )?(calls|leads|intake)/i;

export async function runRubricV3Smoke({ cfg, tmp, ok }: Ctx) {
  const dbmod = await import("../src/lib/db");
  const { openDb, MIGRATIONS_DIR } = dbmod;
  const { seed, SEED_VERSION, RTM_CONTEXT_V3_MARKER } = await import("../src/lib/db/seed");
  const rubricLib = await import("../src/lib/hooks/rubric");
  const notesLib = await import("../src/lib/hooks/notes");
  const store = await import("../src/lib/hooks/store");
  const scoreLib = await import("../src/lib/hooks/score");
  const gate = await import("../src/lib/hooks/copygate");
  const seedData = await (await import("./smoke-legacy-rubric")).seedTexts(); // slice 1c: the profile's seed texts
  const { FakeJev } = await import("../src/lib/ai/fake");
  const { Jev } = await import("../src/lib/ai/jev");
  const { HookScoreQueue } = await import("../src/worker/hooks");
  // Slice 1c: v1 is the original install's history (the snapshot's rows), the v3 NSM avatars / brief / note the profile
  // starter's; the legacy briefs the profile's `hooks.legacyBriefs`.
  const RUBRIC_V1 = (await import("./smoke-legacy-rubric")).legacyV1() as import("../src/lib/hooks/rubric").RubricContent;
  const starter = (await import("../src/lib/profile")).profile().rubric;
  const RUBRIC_V3_RTM_AVATARS = starter.avatars.filter((a) => a.section === "rtm");
  const RTM_BRIEF_V3 = starter.briefs.rtm!;
  const { withFkb } = rubricLib;
  const withRtmV3 = (r: import("../src/lib/hooks/rubric").RubricContent) => rubricLib.withLaneAvatars(r, "rtm", RUBRIC_V3_RTM_AVATARS);
  const { briefOf } = notesLib;
  const LEGACY_SECTION_BRIEF = { rtm: notesLib.legacyBrief("rtm"), fkbpros: notesLib.legacyBrief("fkbpros"), fkb: notesLib.legacyBrief("fkb") };
  assert.equal(SEED_VERSION, 11);

  // ---------------------------------------------------------------- migration 0023 backfill on a pre-0023 v2 DB
  // A DB migrated to 0022 only, holding what the live DB held before this slice: v1 (rescore clicked) and v2 current
  // (rescore not clicked), an unsaved seeded NSM note, seed version 10.
  const oldDir = path.join(tmp, "rubricv3-migrations-0022");
  fs.cpSync(MIGRATIONS_DIR, oldDir, { recursive: true });
  const journalFile = path.join(oldDir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { tag: string }[] };
  // Drop 0023 and every later migration (Creative Studio 1b added 0024), so the folder ends at 0022.
  const at = journal.entries.findIndex((e) => e.tag === "0023_rubric_briefs_sections");
  assert.ok(at >= 0, "0023 is in the journal");
  for (const e of journal.entries.splice(at)) fs.rmSync(path.join(oldDir, `${e.tag}.sql`));
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  const preFile = path.join(tmp, "rubricv3-pre.db");
  const pre = new Database(preFile);
  migrate(drizzle(pre), { migrationsFolder: oldDir });
  const cols = () => (pre.prepare("select name from pragma_table_info('rubric_versions')").pluck().all() as string[]);
  assert.ok(!cols().includes("section_versions") && !cols().includes("briefs"), "0022 has neither column");
  const v2Content = withFkb(RUBRIC_V1);
  const insV = pre.prepare(
    "insert into rubric_versions (version, dimensions, mechanics, avatars, note, current, created_at, rescore_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insV.run(1, JSON.stringify(RUBRIC_V1.dimensions), JSON.stringify(RUBRIC_V1.mechanics), JSON.stringify(RUBRIC_V1.avatars), "v1", 0, 1000, 1000);
  insV.run(2, JSON.stringify(v2Content.dimensions), JSON.stringify(v2Content.mechanics), JSON.stringify(v2Content.avatars), "v2", 1, 2000, null);
  pre.prepare("insert into notes (key, body, saved_at, updated_at) values ('rtm', ?, null, 1)").run(OLD_RTM_DRAFT);
  pre.prepare("insert into app_settings (key, value) values ('seed_version', '10')").run();
  // The real path: the full migrations folder applies only what is missing (0023).
  migrate(drizzle(pre), { migrationsFolder: MIGRATIONS_DIR });
  assert.deepEqual(dbmod.pendingMigrations(pre), [], "0023 (and later) applied");
  type Row = { version: number; dimensions: string; mechanics: string; avatars: string; note: string; current: number; created_at: number; rescore_at: number | null; briefs: string | null; section_versions: string | null };
  const rows = () => pre.prepare("select * from rubric_versions order by version").all() as Row[];
  const migrated = rows();
  assert.deepEqual(
    migrated.map((r) => [r.version, JSON.parse(r.section_versions!), r.briefs]),
    [
      [1, { rtm: 1, fkbpros: 1, fkb: 1 }, null],
      [2, { rtm: 2, fkbpros: 2, fkb: 2 }, null],
    ],
    "backfill: every old version = its own number per section, briefs null",
  );
  ok("migration 0023 on a pre-0023 DB (v1 + v2): briefs + section_versions added, every old version backfilled to its own number per section, briefs null");

  // ---------------------------------------------------------------- seed step 11 on that v2 DB
  seed(pre, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  const after = rows();
  assert.equal(after.length, 3, "one new version");
  assert.deepEqual(after.slice(0, 2), migrated.map((r) => ({ ...r, current: 0 })), "v1 / v2 untouched (only v2's current flag moved)");
  const v3row = after[2];
  assert.deepEqual([v3row.version, v3row.current, v3row.rescore_at, v3row.note], [3, 1, null, starter.note], "v3 current, rescore_at null");
  assert.deepEqual(JSON.parse(v3row.section_versions!), { rtm: 3, fkbpros: 2, fkb: 2 }, "section versions {rtm 3, fkbpros 2, fkb 2}");
  assert.deepEqual(JSON.parse(v3row.briefs!), { rtm: RTM_BRIEF_V3, fkbpros: LEGACY_SECTION_BRIEF.fkbpros, fkb: LEGACY_SECTION_BRIEF.fkb });
  assert.equal(v3row.dimensions, after[1].dimensions, "dimensions unchanged");
  assert.equal(v3row.mechanics, after[1].mechanics, "mechanics unchanged");
  const v3Avatars = JSON.parse(v3row.avatars) as { slug: string; section: string }[];
  assert.deepEqual(
    v3Avatars.filter((a) => a.section === "rtm").map((a) => a.slug),
    ["rtm_installer_burning_spend", "rtm_owner_boosted_posts", "rtm_owner_agency_fed_up", "rtm_local_service_new_to_ads", "rtm_owner_clicks_no_leads"],
    "the 5 approved NSM avatars (3 slugs kept, 2 new)",
  );
  assert.deepEqual(v3Avatars.filter((a) => a.section !== "rtm"), v2Content.avatars.filter((a) => a.section !== "rtm"), "every SGD Pros / SGD avatar as it was");
  assert.equal(pre.prepare("select body from notes where key = 'rtm'").pluck().get(), seedData.RTM_NOTES, "the unsaved seeded NSM note is refreshed");
  assert.ok(pre.prepare("select 1 from app_settings where key = ?").get(RTM_CONTEXT_V3_MARKER), "marker set");
  assert.equal(pre.prepare("select value from app_settings where key = 'seed_version'").pluck().get(), "11");
  // Idempotent: a later seed run adds nothing and changes nothing.
  const once = rows();
  pre.prepare("update app_settings set value = '10' where key = 'seed_version'").run();
  seed(pre, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  assert.deepEqual(rows(), once, "lands exactly once (marker)");
  // A note Alex saved is never touched (the step lands again on a v2 DB without the marker).
  pre.prepare("delete from rubric_versions where version = 3").run();
  pre.prepare("update rubric_versions set current = 1 where version = 2").run();
  pre.prepare("delete from app_settings where key = ?").run(RTM_CONTEXT_V3_MARKER);
  pre.prepare("update notes set body = 'Alex saved these NSM notes.', saved_at = 5 where key = 'rtm'").run();
  pre.prepare("update app_settings set value = '10' where key = 'seed_version'").run();
  seed(pre, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  assert.equal(rows().length, 3);
  assert.deepEqual(pre.prepare("select body, saved_at from notes where key = 'rtm'").raw().get(), ["Alex saved these NSM notes.", 5], "a saved NSM note is untouched");
  pre.close();
  ok("seed step 11 on a v2 DB: v3 current (rescore_at null, NSM avatars replaced by the approved 5, dimensions / mechanics / SGD Pros avatars unchanged), section versions {rtm 3, fkbpros 2, fkb 2}, briefs (new NSM + legacy SGD Pros / SGD), v1 / v2 untouched, lands once (marker), an unsaved seeded NSM note refreshed, a saved one untouched");

  // ---------------------------------------------------------------- briefOf + the approved text
  const db = openDb(path.join(tmp, "rubricv3.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const versions = store.rubricVersions(s);
  const v2 = versions.get(2)!;
  const v3 = store.currentRubric(s);
  assert.equal(v3.version, 3, "a fresh install lands on v3 too (steps 6, 8, 11)");
  assert.deepEqual(v3.sectionVersions, { rtm: 3, fkbpros: 2, fkb: 2 });
  assert.deepEqual(v2.sectionVersions, { rtm: 2, fkbpros: 2, fkb: 2 }, "a row without section_versions = its own version");
  assert.deepEqual([v2.briefs, versions.get(1)!.briefs], [null, null]);
  assert.equal(briefOf(v2, "rtm"), LEGACY_SECTION_BRIEF.rtm, "v2 keeps the old NSM brief");
  assert.match(LEGACY_SECTION_BRIEF.rtm, /organic content/, "the legacy NSM brief is never edited");
  assert.equal(briefOf(v3, "rtm"), RTM_BRIEF_V3, "v3 reads the new NSM brief");
  for (const sec of ["fkbpros", "fkb"] as const) assert.equal(briefOf(v3, sec), briefOf(v2, sec), `${sec}: the same brief on v2 and v3`);
  assert.equal(briefOf({ briefs: null }, "fkb"), LEGACY_SECTION_BRIEF.fkb);
  assert.deepEqual(withRtmV3(withRtmV3(v2)), withRtmV3(v2), "withRtmV3 is idempotent");
  // The NSM notes draft too, except its one line that states the rule itself (it names what is never promised).
  const RULE_LINE = /^Alex never handles a client's lead intake or calls:/;
  const noteLines = notesLib.noteLines(seedData.RTM_NOTES);
  assert.equal(noteLines.filter((l) => RULE_LINE.test(l)).length, 1, "the NSM notes draft states the no call handling rule once");
  for (const text of [RTM_BRIEF_V3, ...RUBRIC_V3_RTM_AVATARS.flatMap((a) => [a.label, a.person, a.pain, a.promise]), ...noteLines.filter((l) => !RULE_LINE.test(l))]) {
    assert.ok(!/[—–]| - /.test(text) && !/\w-\w/.test(text), `no dashes or hyphenated compounds: ${text.slice(0, 50)}`);
    assert.ok(!CALL_HANDLING.test(text), `never promises call handling by Alex: ${text.slice(0, 50)}`);
    assert.ok(!/person on the call\b/.test(text), `"the person on the call" is always the sales call: ${text.slice(0, 50)}`);
  }
  assert.equal(rubricLib.sectionVersionsLabel(v3.sectionVersions, (await import("../src/lib/clients-admin")).laneNames(s)), "NSM v3 · SGD Pros v2 · SGD v2", "the Rubric page's per section line (the lane names from the DB)");
  ok("briefOf: v1 / v2 read the legacy briefs (NSM still the old organic content text, never edited), v3 the approved NSM brief, SGD Pros / SGD identical; no dashes and no call handling promise in the new brief, avatars or NSM notes draft (\"the person on the sales call\"); Rubric page label NSM v3 · SGD Pros v2 · SGD v2");

  // ---------------------------------------------------------------- BYTE IDENTITY: SGD Pros + SGD state and questions
  const clientId = (code: string) => s.prepare("select id from clients where code = ?").pluck().get(code) as number;
  const inputs = {
    granite: { ...notesLib.loadChannelNotes(s, "fkbpros", clientId("granite")), id: 1, kind: "text" as const, text: "Most Decks Done in About a Week", video: null },
    graniteVideo: {
      ...notesLib.loadChannelNotes(s, "fkbpros", clientId("granite")),
      id: 2,
      kind: "video" as const,
      text: "Still stepping over that old tub?",
      video: { firstSeconds: "A man in a garden", onScreenText: "One week decks", spokenOpening: "Still stepping over that old tub?" },
    },
    shared: { ...notesLib.loadChannelNotes(s, "fkbpros", null), id: 3, kind: "text" as const, text: "A vetted local pro for your garden", video: null },
    fkb: { ...notesLib.loadChannelNotes(s, "fkb", null), id: 4, kind: "text" as const, text: "Dream Gardens Start Here", video: null },
  };
  const built = (r: typeof v2, input: (typeof inputs)[keyof typeof inputs]) =>
    JSON.stringify({ state: scoreLib.buildHookState(r, input).state, questions: scoreLib.buildHookQuestions(r, input) });
  for (const [name, input] of Object.entries(inputs)) assert.equal(built(v3, input), built(v2, input), `${name}: state + questions byte identical on v2 and v3`);
  const rtmIn = { ...notesLib.loadChannelNotes(s, "rtm", null), id: 5, kind: "text" as const, text: "Boosted posts got you likes, not leads?", video: null };
  assert.notEqual(built(v3, rtmIn), built(v2, rtmIn), "NSM's state does change");
  const rtmState = scoreLib.buildHookState(v3, rtmIn).state as { channel: { brief: string }; avatars: Record<string, unknown> };
  assert.equal(rtmState.channel.brief, RTM_BRIEF_V3);
  assert.deepEqual(Object.keys(rtmState.avatars), RUBRIC_V3_RTM_AVATARS.map((a) => a.slug), "NSM hooks are offered exactly the 5 v3 avatars");
  ok("BYTE IDENTITY: an SGD Pros client hook (text + video), a shared SGD Pros hook and an SGD hook build the same state + questions JSON under v2 and v3; NSM's state carries the new brief and the 5 v3 avatars");

  // ---------------------------------------------------------------- copy gate: section version, global, context_fp
  const fj = new FakeJev();
  const jev = new Jev(s, fj, "jev-1.13.0", { sleep: async () => {} });
  const line = [{ id: "h1", field: "headline" as const, text: "Meta ads that turn ad spend into booked calls." }];
  const outs: Record<string, Awaited<ReturnType<typeof gate.scoreCopyLines>>> = {};
  for (const code of ["rtm", "granite", "fkb"]) outs[code] = await gate.scoreCopyLines(s, jev, { code, lines: line });
  assert.deepEqual(
    Object.fromEntries(Object.entries(outs).map(([k, o]) => [k, [o.rubric_version, o.rubric_version_global]])),
    { rtm: [3, 3], granite: [2, 3], fkb: [2, 3] },
    "rubric_version = the section version (rtm 3, granite / fkb 2); rubric_version_global 3",
  );
  for (const o of Object.values(outs)) assert.match(o.context_fp, /^[0-9a-f]{16}$/);
  assert.equal(new Set(Object.values(outs).map((o) => o.context_fp)).size, 3, "each channel has its own context");
  const fpOf = (r: typeof v2, section: "rtm" | "fkbpros" | "fkb", cid: number | null) => gate.copyGateContextFp(r, notesLib.loadChannelNotes(s, section, cid));
  assert.equal(fpOf(v2, "fkbpros", clientId("granite")), outs.granite.context_fp, "granite: the same context on v2 and v3");
  assert.equal(fpOf(v2, "fkb", null), outs.fkb.context_fp, "fkb: the same context on v2 and v3");
  assert.notEqual(fpOf(v2, "rtm", null), outs.rtm.context_fp, "rtm: v3 is a different context");
  // A notes edit moves only that channel's context_fp.
  const rtmNoteBefore = notesLib.getNote(s, "rtm")!.body;
  notesLib.saveNote(s, "rtm", `${rtmNoteBefore}\nA new NSM line.`);
  assert.notEqual(fpOf(v3, "rtm", null), outs.rtm.context_fp, "an NSM note edit moves NSM's context_fp");
  assert.equal(fpOf(v3, "fkbpros", clientId("granite")), outs.granite.context_fp, "and never a client's");
  s.prepare("update clients set brand_notes = brand_notes || char(10) || 'A new granite line.' where code = 'granite'").run();
  assert.notEqual(fpOf(v3, "fkbpros", clientId("granite")), outs.granite.context_fp, "a client note edit moves that client's context_fp");
  assert.notEqual(fpOf(v3, "rtm", null), fpOf(v2, "rtm", null));
  const rtmReq = fj.requests[0].state as { channel: { brief: string }; avatars: Record<string, unknown> };
  assert.equal(rtmReq.channel.brief, RTM_BRIEF_V3, "the rtm copy gate reads the v3 brief");
  // The CLI reports the same, against this fresh DB (the smoke's empty-key env: no Jev call).
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const cli = (code: string) => {
    const r = spawnSync(tsx, [path.join(process.cwd(), "scripts", "score-copy.ts")], {
      input: JSON.stringify({ code, lines: line }),
      env: { ...process.env, STUDIO_DB: path.join(tmp, "rubricv3.db") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as { rubric_version: number; rubric_version_global: number; context_fp: string; results: { error: string }[] };
  };
  const cliRtm = cli("rtm");
  const cliGranite = cli("granite");
  assert.deepEqual([cliRtm.rubric_version, cliRtm.rubric_version_global, cliGranite.rubric_version, cliGranite.rubric_version_global], [3, 3, 2, 3]);
  assert.equal(cliRtm.context_fp, fpOf(v3, "rtm", null), "the CLI's context_fp = the current NSM context");
  assert.ok(cliRtm.results.every((x) => /^nokey: /.test(x.error)), "no key in the smoke env: nothing sent");
  ok("copy gate: rubric_version = the section version (rtm 3, granite and fkb 2), rubric_version_global 3, context_fp per channel (SGD Pros / SGD equal on v2 and v3, NSM not; a notes edit moves only its own channel); the CLI reports the same");

  // ---------------------------------------------------------------- hooks: nothing due, NSM scoped rescore
  const add = (section: "rtm" | "fkbpros" | "fkb", code: string | null, text: string) =>
    store.addTextHooks(s, { section, clientCode: code }, [{ text, source: "manual" }]).ids[0];
  const rtmScored = add("rtm", null, "Paying for clicks that never call?");
  const rtmScored2 = add("rtm", null, "Your agency hands you to an account manager.");
  const rtmNew = add("rtm", null, "Boosted posts brought likes, not leads.");
  const rtmArchived = add("rtm", null, "An archived NSM hook.");
  const graniteScored = add("fkbpros", "granite", "Most decks done in about a week.");
  const fkbScored = add("fkb", null, "One team from design to construction.");
  const insScore = s.prepare(
    `insert into hook_scores (hook_id, rubric_version, answers, unsure, overall, model, scored_at) values (?, 2, '{}', '[]', 3.2, 'jev-1.13.0', 1)`,
  );
  for (const id of [rtmScored, rtmScored2, rtmArchived, graniteScored, fkbScored]) insScore.run(id);
  store.setHookArchived(s, rtmArchived, true);
  assert.equal(
    s.prepare(`select count(*) from hooks h where ${store.HOOK_LIVE} and ${store.HOOK_DUE} and not ${store.HOOK_NEVER_SCORED}`).pluck().get({ version: 3 }),
    0,
    "after v3 no already scored hook is due",
  );
  const preview = store.sectionRescorePreview(s, "rtm");
  assert.deepEqual([preview.version, preview.changed, preview.approved, preview.count], [3, true, false, 2], "NSM: 2 live hooks carry an older score");
  assert.ok(Math.abs(preview.usd - 2 * store.hookScoreUnitUsd(s)) < 1e-12, "count x the hook score unit cost");
  assert.equal(store.sectionRescorePreview(s, "fkbpros").changed, false, "SGD Pros did not change in v3 (no line on its tabs)");
  assert.equal(store.sectionRescorePreview(s, "fkb").changed, false);
  assert.equal(s.prepare("select count(*) from hooks where score_requested_at is not null").pluck().get(), 0, "the preview requests nothing");
  // The server action re-checks everything (pointed at this DB for the call): zod first, then the refusal rule.
  const actions = await import("../src/app/actions");
  const g = globalThis as unknown as { __rtmStudioDb?: typeof db };
  const prevDb = g.__rtmStudioDb;
  g.__rtmStudioDb = db;
  try {
    for (const bad of [{ section: "fkb" }, { section: "fkbpros" }, { section: "rtm", extra: 1 }, {}, null]) {
      assert.deepEqual(await actions.rescoreSectionAction(bad as never), { ok: false, error: "Invalid section." }, `zod refuses ${JSON.stringify(bad)}`);
    }
    assert.equal(store.sectionRescoreRefusal(preview), null, "NSM changed in v3, no global Rescore, 2 waiting: allowed");
    assert.equal(store.sectionRescoreRefusal(store.sectionRescorePreview(s, "fkbpros")), "SGD Pros did not change in rubric v3: nothing to rescore.");
    s.prepare("update rubric_versions set rescore_at = 1 where version = 3").run();
    assert.deepEqual(await actions.rescoreSectionAction({ section: "rtm" }), { ok: false, error: "Rescore was already clicked for v3: it covers NSM too." }, "refused once the global Rescore was clicked");
    s.prepare("update rubric_versions set rescore_at = null where version = 3").run();
    assert.equal(s.prepare("select count(*) from hooks where score_requested_at is not null").pluck().get(), 0, "a refused click requests nothing");
    // The allowed path is the store call itself (`done()` revalidates, which needs a Next request); then the click is refused.
    assert.equal(store.requestSectionRescore(s, "rtm"), 2);
    assert.deepEqual(await actions.rescoreSectionAction({ section: "rtm" }), { ok: false, error: "Nothing to rescore: every NSM hook has a v3 score or is already queued." }, "a second click is refused");
  } finally {
    g.__rtmStudioDb = prevDb;
  }
  const requested = (s.prepare("select id from hooks where score_requested_at is not null order by id").pluck().all() as number[]);
  assert.deepEqual(requested, [rtmScored, rtmScored2], "only the live NSM hooks lacking v3 (never the new, archived, SGD Pros or SGD ones)");
  assert.equal(store.requestSectionRescore(s, "rtm"), 0, "a second click requests nothing more");
  assert.equal(store.sectionRescorePreview(s, "rtm").count, 0);
  // The queue (scoring paused, as seeded) runs exactly those, on v3, with the v3 brief; nothing else is scored.
  assert.equal(store.hooksPaused(s), true);
  const sent = fj.requests.length;
  await new HookScoreQueue(s, { jev, log: () => {}, isStopped: () => false, idleMs: 5 }).drain();
  assert.deepEqual(s.prepare("select hook_id from hook_scores where rubric_version = 3 order by hook_id").pluck().all(), [rtmScored, rtmScored2]);
  assert.equal(fj.requests.length - sent, 2);
  for (const r of fj.requests.slice(sent)) assert.equal((r.state as { channel: { brief: string } }).channel.brief, RTM_BRIEF_V3);
  assert.equal(s.prepare("select count(*) from hook_scores where hook_id in (?, ?, ?)").pluck().get(rtmNew, graniteScored, fkbScored), 2, "the SGD Pros / SGD hooks keep only their v2 score; the new NSM hook waits");
  ok("hooks: after v3 no scored hook is due; the NSM line counts live NSM hooks with an older score (count x unit cost, SGD Pros / SGD unchanged so no line there); the server action (zod + refusal re-check: unchanged section, global Rescore clicked, nothing left) then requests exactly those, never by itself, and the paused queue scores them on v3 with the new brief");

  // ---------------------------------------------------------------- saveRubricVersion: section bumps
  const base = () => {
    const c = store.currentRubric(s);
    return { dimensions: structuredClone(c.dimensions), mechanics: structuredClone(c.mechanics), avatars: structuredClone(c.avatars) };
  };
  const save = (edit: (c: ReturnType<typeof base>) => void, note: string) => {
    const c = base();
    edit(c);
    const v = store.saveRubricVersion(s, c, note);
    const r = store.currentRubric(s);
    assert.equal(r.version, v);
    assert.deepEqual(r.briefs, v3.briefs, "briefs carried forward");
    return r.sectionVersions;
  };
  // An SGD Pros avatar that is also offered on SGD: SGD Pros and SGD move, NSM keeps 3.
  let sv = save((c) => (c.avatars.find((a) => a.slug === "justmovedin_garden")!.pain += " Edited."), "Edit an SGD Pros avatar offered on SGD");
  assert.deepEqual(sv, { rtm: 3, fkbpros: 4, fkb: 4 });
  // A universal only SGD Pros avatar (shared hooks only, never SGD): only SGD Pros moves.
  sv = save((c) => (c.avatars.find((a) => a.slug === "busy_easyquote")!.pain += " Edited."), "Edit a universal only avatar");
  assert.deepEqual(sv, { rtm: 3, fkbpros: 5, fkb: 4 });
  // An NSM avatar: only NSM moves.
  sv = save((c) => (c.avatars.find((a) => a.slug === "rtm_owner_boosted_posts")!.pain += " Edited."), "Edit an NSM avatar");
  assert.deepEqual(sv, { rtm: 6, fkbpros: 5, fkb: 4 });
  // A dimension's short label is display only: nothing Jev reads changed, every section keeps its number.
  sv = save((c) => (c.dimensions[0].short = "Specifics"), "Rename a short label");
  assert.deepEqual(sv, { rtm: 6, fkbpros: 5, fkb: 4 });
  // A mechanic definition is read by every section: all three move.
  sv = save((c) => (c.mechanics[0].definition += " Edited."), "Edit a mechanic");
  assert.deepEqual(sv, { rtm: 8, fkbpros: 8, fkb: 8 });
  assert.equal(briefOf(store.currentRubric(s), "rtm"), RTM_BRIEF_V3, "a saved version keeps the v3 NSM brief");
  s.close();
  ok("saveRubricVersion: briefs carried forward; an SGD Pros avatar offered on SGD moves SGD Pros + SGD, a universal only one SGD Pros only, an NSM avatar NSM only, a short label nothing, a mechanic all three");
}
