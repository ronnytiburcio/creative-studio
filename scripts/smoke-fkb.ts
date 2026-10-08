/**
 * Phase 5 slice 2 smoke checks (called by scripts/smoke.ts after the Meta checks, on the same temp DB): SGD as a full
 * section (rubric v2, SGD avatars / state / notes, Client tab + What works here, Library / Review / meaning scopes,
 * classify state) and Meta copy as hooks (extraction, link vs create, dedupe incl. archived, idempotent re-run, video
 * role, numbers beside a hook, the Running tab's hook filter and card hooks). FakeJev and DB rows only: never the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { StudioConfig } from "../src/lib/config";

type Ctx = { s: Database.Database; cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

export async function runFkbSmoke({ s, cfg, tmp, ok }: Ctx) {
  const rubricLib = await import("../src/lib/hooks/rubric");
  const store = await import("../src/lib/hooks/store");
  const notesLib = await import("../src/lib/hooks/notes");
  const scoreLib = await import("../src/lib/hooks/score");
  const clientLib = await import("../src/lib/hooks/client");
  const seedData = await (await import("./smoke-legacy-rubric")).seedTexts(); // slice 1c: the profile's seed texts
  const { seed } = await import("../src/lib/db/seed");
  const { HookScoreQueue } = await import("../src/worker/hooks");
  const { Jev } = await import("../src/lib/ai/jev");
  const { FakeJev } = await import("../src/lib/ai/fake");
  const metaHooks = await import("../src/lib/meta/hooks");
  const { runningData, parseRunningFilters } = await import("../src/lib/meta/running");
  const { listHooks, parseHookFilters } = await import("../src/lib/hooks/queries");
  const queries = await import("../src/lib/queries");
  const { prefilter } = await import("../src/lib/ai/search");
  const classify = await import("../src/lib/ai/classify");
  const vrules = await import("../src/lib/hooks/variant-rules");

  const sectionId = (key: string) => s.prepare("select id from sections where key = ?").pluck().get(key) as number;
  const clientIdOf = (code: string) => s.prepare("select id from clients where code = ?").pluck().get(code) as number;
  const SGD = sectionId("fkb");
  const FKBPROS = sectionId("fkbpros");

  // ---------------------------------------------------------------- rubric v2 (seed step 8) over a scored library
  // The Phase 4 checks ran on v1 (and saved later versions); re-running step 8 now adds SGD on top of the current one.
  // Pending "Score again" requests run on any version by design; clear them so only the backlog rule is measured.
  s.prepare("update hooks set score_requested_at = null").run();
  const before = store.currentRubric(s);
  const versionsBefore = s.prepare("select version, dimensions, avatars from rubric_versions order by version").all() as { version: number; dimensions: string; avatars: string }[];
  const scoredLive = s.prepare(`select count(*) from hooks h where ${store.HOOK_LIVE} and exists (select 1 from hook_scores x where x.hook_id = h.id)`).pluck().get() as number;
  const fpBefore = {
    rtm: notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "rtm", null)),
    shared: notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkbpros", null)),
    dom: notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkbpros", clientIdOf("acme"))),
  };
  const changedBefore = (["rtm", "fkbpros"] as const).map((k) => store.changedSinceScored(s, { kind: k }).count);
  s.prepare("delete from app_settings where key = 'rubric:fkb_added'").run();
  s.prepare("update app_settings set value = '7' where key = 'seed_version'").run();
  seed(s, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  const v2 = store.currentRubric(s);
  assert.equal(v2.version, (versionsBefore.at(-1)?.version ?? 0) + 1, "a NEW current version");
  assert.equal(v2.rescoreAt, null, "rescore_at null: Alex's click only");
  assert.equal(v2.note, rubricLib.LANE_C_ADDED_NOTE);
  assert.deepEqual(
    s.prepare("select version, dimensions, avatars from rubric_versions where version < ? order by version").all(v2.version),
    versionsBefore,
    "older versions untouched (never edited in place)",
  );
  assert.deepEqual(rubricLib.withFkb(before).dimensions, v2.dimensions, "v2 = the current version + SGD");
  // Exactly once: another seed run (a later bump) adds nothing.
  s.prepare("update app_settings set value = '7' where key = 'seed_version'").run();
  seed(s, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  assert.equal(store.currentRubric(s).version, v2.version, "lands exactly once");
  const bind = { version: v2.version };
  const dueScored = s
    .prepare(`select count(*) from hooks h where ${store.HOOK_LIVE} and ${store.HOOK_DUE} and not ${store.HOOK_NEVER_SCORED}`)
    .pluck()
    .get(bind) as number;
  assert.equal(dueScored, 0, "no hook with a score is due on v2");
  const preview = store.rescorePreview(s);
  assert.deepEqual([preview.approved, preview.count], [false, scoredLive], "the Rubric page: N hooks will be rescored (on your click)");
  // Scoring runs: only never-scored hooks get a v2 score; every scored hook keeps its old one and gets none.
  store.setHooksPaused(s, false);
  const fj = new FakeJev();
  const jev = new Jev(s, fj, "jev-1.13.0", { sleep: async () => {} });
  const q = new HookScoreQueue(s, { jev, log: () => {}, isStopped: () => false, idleMs: 5 });
  const neverScored = s.prepare(`select h.id from hooks h where ${store.HOOK_LIVE} and ${store.HOOK_NEVER_SCORED} and h.score_error is null`).pluck().all() as number[];
  const hadScore = new Set(s.prepare("select distinct hook_id from hook_scores").pluck().all() as number[]);
  await q.drain();
  const v2Scored = new Set(s.prepare("select hook_id from hook_scores where rubric_version = ?").pluck().all(v2.version) as number[]);
  assert.ok(neverScored.length > 0 && neverScored.every((id) => v2Scored.has(id)), "never-scored hooks (Meta hooks included) score on v2");
  assert.ok(![...v2Scored].some((id) => hadScore.has(id)), "no already-scored hook was rescored");
  store.setHooksPaused(s, true);
  // Fingerprints of the existing channels do not move (SGD is new text; NSM / SGD Pros read what they read before).
  assert.deepEqual(
    {
      rtm: notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "rtm", null)),
      shared: notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkbpros", null)),
      dom: notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkbpros", clientIdOf("acme"))),
    },
    fpBefore,
  );
  const rtmParts = notesLib.channelNoteParts(notesLib.loadChannelNotes(s, "rtm", null));
  assert.equal(fpBefore.rtm, notesLib.notesFingerprint({ notes: rtmParts.notes, hint: rtmParts.hint, whos: rtmParts.whos }), "the slice 1 formula");
  assert.deepEqual((["rtm", "fkbpros"] as const).map((k) => store.changedSinceScored(s, { kind: k }).count), changedBefore, "no false Notes changed banner");
  ok("rubric v2 (seed v8): a new current version = the current one + SGD, rescore_at null, older versions untouched, lands once; no scored hook is due (Rescore line counts them), never-scored hooks score on v2; NSM / SGD Pros notes fingerprints unchanged");

  // ---------------------------------------------------------------- SGD avatars, dimensions, state
  // On the live library (v1 + SGD): exactly the 10 SGD Pros avatars that are not universal only.
  const legacyV1 = (await import("./smoke-legacy-rubric")).legacyV1() as typeof before;
  const liveV2 = rubricLib.withFkb(legacyV1);
  const liveFkb = rubricLib.avatarsFor(liveV2, "fkb", false).map((a) => a.slug);
  assert.equal(liveFkb.length, 10, "v1 + SGD: the 10 SGD Pros avatars that are not universal only");
  assert.deepEqual(liveFkb, legacyV1.avatars.filter((a) => a.section === "fkbpros" && !a.universalOnly).map((a) => a.slug));
  assert.ok(liveV2.avatars.filter((a) => a.universalOnly).every((a) => !rubricLib.avatarSections(a).includes("fkb")));
  // Here v2 was built on the Phase 4 test's edited version (it removed stalled_diy): SGD follows the current list.
  const fkbAv = rubricLib.avatarsFor(v2, "fkb", false).map((a) => a.slug);
  assert.equal(fkbAv.length, before.avatars.filter((a) => a.section === "fkbpros" && !a.universalOnly).length);
  assert.ok(!fkbAv.includes("vettedrating_responsive") && !fkbAv.includes("busy_easyquote"), "never the universal-only ones");
  assert.deepEqual(scoreLib.allowedAvatars(v2, { section: "fkb", client: null }).map((a) => a.slug), fkbAv, "SGD hooks are never 'shared'");
  assert.deepEqual(rubricLib.avatarsFor(v2, "fkbpros", false).map((a) => a.slug), fkbAv, "same slugs as SGD Pros (calibration pools them)");
  assert.equal(rubricLib.avatarsFor(v2, "fkbpros", true).length, fkbAv.length + 2, "shared SGD Pros hooks keep the universal-only two as well");
  assert.deepEqual(rubricLib.dimensionsFor(v2, "fkb", "text").map((d) => d.id), rubricLib.dimensionsFor(v2, "fkbpros", "text").map((d) => d.id), "SGD = the SGD Pros dimensions");
  assert.ok(rubricLib.dimensionsFor(v2, "fkb", "text").some((d) => d.id === "offer_clarity"));
  assert.ok(rubricLib.dimensionsFor(v2, "fkb", "video").some((d) => d.id === "visual_stop_power"));
  const fkbIn = { ...notesLib.loadChannelNotes(s, "fkb", null), id: 1, kind: "text" as const, text: "Dream Gardens Start Here" };
  const { state, notesFp } = scoreLib.buildHookState(v2, fkbIn);
  const ch = state.channel as Record<string, unknown>;
  assert.equal(ch.brief, notesLib.briefOf(v2, "fkb"));
  assert.equal(ch.brief, notesLib.legacyBrief("fkb"), "a version without briefs reads the legacy SGD brief");
  assert.match(String(ch.section), /Summit Gardens and Decks/);
  assert.deepEqual(ch.notes, notesLib.noteLines(seedData.FKB_BRAND_NOTES), "SGD's own notes");
  assert.deepEqual(ch.brand, { name: "Summit Gardens and Decks", who: seedData.FKB_HINT });
  assert.ok(!ch.installer && !ch.scope, "no installer, not shared");
  assert.deepEqual(Object.keys(state.avatars as object), fkbAv);
  const fkbQ = scoreLib.buildHookQuestions(v2, fkbIn);
  assert.ok(fkbQ.offer_clarity && !fkbQ.visual_stop_power);
  assert.ok(!Object.keys((fkbQ.avatar as { criteria: Record<string, string> }).criteria).includes("busy_easyquote"));
  for (const text of [seedData.FKB_BRAND_NOTES, seedData.FKB_HINT, notesLib.legacyBrief("fkb")]) assert.ok(!/[—–]| - /.test(text), "no dashes in SGD's seeded text");
  const fkbNote = notesLib.getNoteRow(s, notesLib.FKB_NOTE_KEY);
  assert.ok(fkbNote && fkbNote.savedAt == null && notesLib.noteLines(fkbNote.body).length >= 5 && notesLib.noteLines(fkbNote.body).length <= 10, "5 to 10 draft lines");
  assert.equal(notesFp, notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkb", null)));
  ok("SGD scoring: the SGD Pros dimensions (Offer clarity, Visual stop power on video), the 10 non-universal avatars (same slugs, never the universal-only ones); state = SGD's brief, its own draft notes (5 to 10 lines, no dashes) and hint as channel.brand, no installer");

  // ---------------------------------------------------------------- SGD Client tab: notes, hint, What works here, pins
  const fkbHook = store.addTextHooks(s, { section: "fkb", clientCode: null }, [{ text: "One team from design to construction", source: "manual" }]).ids[0];
  const tab0 = clientLib.clientTabData(s, "fkb");
  assert.deepEqual([tab0.kind, tab0.short, tab0.metaAdAccountId, tab0.brandNotesSavedAt, tab0.rules.length], ["fkb", "SGD", "act_100000000000009", null, 0]);
  assert.ok(tab0.roots.some((r) => r.path.endsWith("Studio Generated/SGD")), "its Library folders, read only");
  const fp0 = notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkb", null));
  clientLib.saveBrandNotes(s, "fkb", `${seedData.FKB_BRAND_NOTES}\nNew line from Alex.`);
  clientLib.saveHint(s, "fkb", "  SGD,\nNJ and PA renovations ");
  clientLib.addWork(s, "fkb", "Before and after reveals of our own gardens");
  assert.equal(clientLib.pinHook(s, fkbHook), "fkb");
  const tab1 = clientLib.clientTabData(s, "fkb");
  assert.ok(tab1.brandNotesSavedAt != null && tab1.hint === "SGD, NJ and PA renovations");
  assert.deepEqual(tab1.works.map((w) => w.body ?? `pin:${w.hook?.text}:${w.hook?.state}`), ["Before and after reveals of our own gardens", "pin:One team from design to construction:live"]);
  const fkbOwner = clientLib.worksOwner(s, "fkb");
  assert.deepEqual(fkbOwner, { sectionId: SGD, clientId: null });
  assert.deepEqual(notesLib.worksLines(s, fkbOwner), ["Before and after reveals of our own gardens", "Pinned hook: One team from design to construction"]);
  assert.ok(clientLib.pinnedHookIds(s, [fkbHook]).has(fkbHook));
  assert.equal(notesLib.worksLines(s, clientLib.worksOwner(s, "acme")).some((l) => l.includes("design to construction")), false, "SGD's list is its own");
  assert.notEqual(notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkb", null)), fp0, "an SGD notes edit moves SGD's fingerprint");
  assert.equal(listHooks({ kind: "fkb" }, parseHookFilters({})).rows.find((r) => r.id === fkbHook)?.pinnable, true);
  assert.throws(() => clientLib.pinHook(s, s.prepare("select id from hooks where section_id = ? and client_id is null limit 1").pluck().get(FKBPROS) as number), clientLib.ClientTabError);
  ok("SGD Client tab: brand notes save (the Draft label goes), one-line hint, What works here (free text + pinned SGD hooks, its own list), ad account and Library folders read only; its edits move only SGD's fingerprint");

  // ---------------------------------------------------------------- Meta copy -> hooks
  assert.equal(metaHooks.primaryHookLine("🏠 Free garden renovation consultation for Maple County householders.\n\n✅ Same layout, brand new look\n✅ Done in days\n\n👇 Tap below."), "Free garden renovation consultation for Maple County householders.");
  assert.equal(metaHooks.primaryHookLine("✅ A bullet first\nSay goodbye to renovation stress!\nImagine a garden that is yours."), "Say goodbye to renovation stress!");
  assert.equal(metaHooks.primaryHookLine("Imagine a garden or deck that's truly yours, \nwhere style meets function.\n\nWith 8+ years of expertise."), "Imagine a garden or deck that's truly yours, where style meets function.");
  assert.equal(metaHooks.primaryHookLine("No demo. About 3 days, start to finish.\n\nMore."), "No demo. About 3 days, start to finish.", "a short first sentence takes the next (the copy doc rule)");
  assert.equal(metaHooks.primaryHookLine("✅ only\n✅ bullets\nhttps://example.com"), null);
  assert.deepEqual(
    metaHooks.metaCopyCandidates({ headlines: ["🔥 Dream Gardens Start Here", "Dream gardens start here!"], primaries: ["🏠 Line one is a full sentence here.\n✅ x"] }),
    [
      { text: "Dream Gardens Start Here", role: "headline" },
      { text: "Line one is a full sentence here.", role: "primary" },
    ],
    "emoji stripped, duplicates collapse, descriptions are never read",
  );
  // Fixture ads: acme (a copy doc headline, an archived hook, a new line, a matched video) and SGD.
  const accDom = s.prepare("select acc.id from ad_accounts acc join clients c on c.id = acc.client_id where c.code = 'acme'").pluck().get() as number;
  const accFkb = s.prepare("select id from ad_accounts where identity = 'fkb'").pluck().get() as number;
  const [existing] = store.addTextHooks(s, { section: "fkbpros", clientCode: "acme" }, [{ text: "Stuck with the last owner's garden?", source: "copy_doc" }]).ids;
  const [archived] = store.addTextHooks(s, { section: "fkbpros", clientCode: "acme" }, [{ text: "An archived line still links", source: "pasted" }]).ids;
  store.setHookArchived(s, archived, true);
  const vidAsset = Number(
    s
      .prepare(
        `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status)
         values (?, (select id from roots limit 1), ?, 's2/dom-hook.mp4', 'dom-hook.mp4', 'mp4', 'video', 1, 1, 1, 'done')`,
      )
      .run(FKBPROS, path.join(tmp, "s2", "dom-hook.mp4")).lastInsertRowid,
  );
  const vidHook = Number(
    s.prepare("insert into hooks (section_id, client_id, kind, text, norm, asset_id, source, created_at) values (?, ?, 'video', 'Watch this garden flip', 'watch this garden flip', ?, 'asset', 1)")
      .run(FKBPROS, clientIdOf("acme"), vidAsset).lastInsertRowid,
  );
  const insAd = (metaId: string, account: number, name: string, creative: object, status = "ACTIVE", asset: number | null = null) =>
    s
      .prepare(
        `insert into ads (meta_ad_id, account_id, name, effective_status, creative, matched_asset_id, match_source, first_seen_at, last_synced_at)
         values (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      )
      .run(metaId, account, name, status, JSON.stringify({ headlines: [], primaries: [], descriptions: [], ctas: [], videoIds: [], imageHashes: [], isVideo: false, link: null, ...creative }), asset, asset ? "map" : null);
  insAd("S2-A", accDom, "SGC-acme-s2-21", {
    headlines: ["Stuck with the last owner's garden?", "An archived line still links", "A brand new Meta line"],
    primaries: ["🏠 Stuck with the last owner's garden? We can help.\n✅ bullet"],
    descriptions: ["Descriptions are never hooks"],
    isVideo: true,
    videoIds: ["vS2"],
  }, "ACTIVE", vidAsset);
  insAd("S2-B", accDom, "SGC-acme-s2-22", { headlines: ["A brand new Meta line"], primaries: ["Second ad primary sentence here. More."] }, "PAUSED");
  insAd("S2-F", accFkb, "SGD-S2", { headlines: ["Dream Gardens Start Here"], primaries: ["Say goodbye to renovation stress!\nImagine a garden."], isVideo: true, videoIds: ["fS2"] });
  // The ad map gives the angle (angle_key) for the acme ad.
  const mapDir = path.join(tmp, "s2-clients");
  fs.mkdirSync(path.join(mapDir, "acme"), { recursive: true });
  fs.writeFileSync(path.join(mapDir, "acme", "video_script_map.json"), JSON.stringify({ schema: 2, ads: [{ n: 21, ad_id: "S2-A", angle_key: "justmovedin-garden", video: "dom-hook.mp4" }] }));
  const hookCount = () => s.prepare("select count(*) from hooks").pluck().get() as number;
  const h0 = hookCount();
  const r1 = metaHooks.syncMetaHooks(s, { accountIds: [accDom, accFkb], clientsDir: mapDir, now: 5 });
  const byText = (text: string, section = FKBPROS) =>
    s.prepare("select id, source, archived_at, angle_slug, client_id from hooks where section_id = ? and text = ? and kind = 'text' and parent_id is null").get(section, text) as
      | { id: number; source: string; archived_at: number | null; angle_slug: string | null; client_id: number | null }
      | undefined;
  const newLine = byText("A brand new Meta line")!;
  assert.deepEqual([newLine.source, newLine.client_id, newLine.angle_slug], ["meta", clientIdOf("acme"), "justmovedin-garden"], "new text = a meta hook in the client channel, angle from the ad map");
  assert.equal(byText("Stuck with the last owner's garden?")!.id, existing, "equal text links to the copy doc hook (no new row)");
  assert.equal(byText("An archived line still links")!.archived_at != null, true, "archived stays archived, still linked");
  const links = (metaId: string) => s.prepare("select hook_id, role from hook_ads where meta_ad_id = ? order by role, hook_id").all(metaId) as { hook_id: number; role: string }[];
  assert.deepEqual(
    links("S2-A").map((l) => `${l.role}:${l.hook_id}`).sort(),
    [`headline:${existing}`, `headline:${archived}`, `headline:${newLine.id}`, `primary:${existing}`, `video:${vidHook}`].sort(),
    "headlines, the primary's first sentence (links the same hook) and the matched video's hook",
  );
  assert.ok(!s.prepare("select 1 from hooks where text like 'Descriptions are never%'").get());
  const fkbDream = byText("Dream Gardens Start Here", SGD)!;
  assert.deepEqual([fkbDream.source, fkbDream.client_id], ["meta", null], "SGD's ads land in SGD's channel");
  assert.ok(byText("Say goodbye to renovation stress!", SGD));
  assert.deepEqual([r1.created, r1.videoLinks, r1.perChannel.acme?.linkedExisting], [4, 1, 2], JSON.stringify(r1));
  const h1 = hookCount();
  const r2 = metaHooks.syncMetaHooks(s, { accountIds: [accDom, accFkb], clientsDir: mapDir, now: 6 });
  assert.deepEqual([r2.created, r2.newLinks, hookCount()], [0, 0, h1], "idempotent: a re-run adds nothing");
  s.prepare("update ads set effective_status = 'ARCHIVED' where meta_ad_id = 'S2-B'").run();
  metaHooks.syncMetaHooks(s, { accountIds: [accDom], clientsDir: mapDir });
  assert.equal(links("S2-B").length, 2, "an ad that stops keeps its links (history)");
  assert.ok(h1 - h0 === 4);
  ok("Meta copy -> hooks: every headline + each primary's first sentence (bullet / URL lines and emoji out, the copy doc's firstSentence), equal text links (copy doc, archived stays archived), new text = a `meta` hook in the ad's channel (client / SGD) with the ad map's angle; the matched video's hook links (role video); idempotent, never deletes links");

  // ---------------------------------------------------------------- numbers beside a hook
  const insDay = (metaId: string, account: number, date: string, spend: number, imp: number, clicks: number, v3 = 0, metaLeads = 0) =>
    s
      .prepare(
        `insert into ad_metrics (meta_ad_id, date, account_id, spend, impressions, clicks, link_clicks, meta_leads, video_3s, thruplays, synced_at)
         values (?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 1)`,
      )
      .run(metaId, date, account, spend, imp, clicks, metaLeads, v3);
  insDay("S2-A", accDom, "2026-09-01", 100, 1000, 50, 300); // CTR 5%
  insDay("S2-A", accDom, "2026-09-02", 0, 0, 0); // zero impressions: never a division by zero
  insDay("S2-B", accDom, "2026-09-01", 50, 9000, 90); // CTR 1% (average of CTRs would say 3%)
  insDay("S2-F", accFkb, "2026-09-01", 30, 600, 12, 150, 3);
  s.prepare("update ad_accounts set ghl_synced_at = coalesce(ghl_synced_at, 1), leads_source = 'ghl' where id = ?").run(accDom);
  s.prepare("update ad_accounts set leads_source = 'meta' where id = ?").run(accFkb);
  s.prepare("insert into ghl_leads (contact_id, account_id, date_added, test, ad_id, attributed_via, synced_at) values ('S2L1', ?, 1, 0, 'S2-A', 'first', 1), ('S2L2', ?, 1, 0, 'S2-B', 'first', 1), ('S2L3', ?, 1, 1, 'S2-B', 'first', 1)").run(accDom, accDom, accDom);
  const stats = metaHooks.hookAdStats(s, [newLine.id, existing, vidHook, fkbDream.id, fkbHook]);
  const nl = stats.get(newLine.id)!;
  assert.deepEqual([nl.ads, nl.active, nl.spend, nl.impressions, nl.clicks, nl.leads, nl.leadsSource], [2, 1, 150, 10000, 140, 2, "ghl"], "summed over its 2 ads; test leads out");
  assert.ok(Math.abs(nl.ctr! - 1.4) < 1e-9, "CTR = clicks / impressions from the sums (140 / 10,000), not the mean of 5% and 1%");
  assert.ok(Math.abs(nl.cpl! - 75) < 1e-9);
  assert.ok(Math.abs(nl.hookRate! - 30) < 1e-9, "hook rate over the video ad only (300 / 1,000)");
  assert.equal(nl.runningHref, `/fkbpros/acme/running?hook=${newLine.id}&status=all&w=lifetime`);
  const ex = stats.get(existing)!;
  assert.deepEqual([ex.ads, ex.roles.sort().join(",")], [1, "headline,primary"], "one ad even with two roles");
  const fd = stats.get(fkbDream.id)!;
  assert.deepEqual([fd.leads, fd.leadsSource, fd.cpl, fd.runningHref.startsWith("/fkb/running?hook=")], [3, "meta", 10, true], "SGD: Meta leads");
  assert.equal(stats.has(fkbHook), false, "a hook on no ad has no numbers");
  const zero = metaHooks.hookAdStats(s, [archived]).get(archived)!;
  assert.ok(zero.ads === 1 && zero.spend === 100, "an archived hook keeps its ad's numbers");
  s.prepare("delete from ad_metrics where meta_ad_id = 'S2-A'").run();
  const none = metaHooks.hookAdStats(s, [existing]).get(existing)!;
  assert.deepEqual([none.ctr, none.hookRate, none.spend], [null, null, 0], "zero impressions: dashes, never NaN");
  s.prepare("update ad_metrics set meta_leads = 0 where meta_ad_id = 'S2-F'").run();
  assert.equal(metaHooks.hookAdStats(s, [fkbDream.id]).get(fkbDream.id)!.cpl, null, "zero leads: no CPL");
  s.prepare("update ad_metrics set meta_leads = 3 where meta_ad_id = 'S2-F'").run();
  insDay("S2-A", accDom, "2026-09-01", 100, 1000, 50, 300);
  const monotonic = (rs: { ads: { spend: number; ctr: number | null } | null }[], key: "spend" | "ctr") => {
    const vals = rs.map((r) => (r.ads ? (r.ads[key] ?? -1) : -2));
    return vals.every((v, i) => i === 0 || vals[i - 1] >= v);
  };
  const bySpend = listHooks({ kind: "client", code: "acme" }, parseHookFilters({ sort: "spend" })).rows;
  assert.ok(monotonic(bySpend, "spend") && bySpend.some((r) => r.id === newLine.id && r.ads?.spend === 150), "sort by spend (hooks on no ad last)");
  assert.ok(monotonic(listHooks({ kind: "client", code: "acme" }, parseHookFilters({ sort: "ctr" })).rows, "ctr"), "sort by CTR");
  // The Running tab: ?hook= keeps only the ads carrying it; cards list their hooks with scores.
  const rd = runningData(s, { kind: "client", code: "acme" }, parseRunningFilters({ hook: String(newLine.id), status: "all", w: "lifetime" }));
  assert.deepEqual(rd.cards.map((c) => c.metaAdId).sort(), ["S2-A"], "S2-B is archived: out of scope; S2-A carries it");
  assert.equal(rd.hook?.id, newLine.id);
  const card = rd.cards[0];
  assert.ok(card.hooks.some((h) => h.id === vidHook && h.roles.includes("video")) && card.hooks.some((h) => h.id === existing && h.roles.length === 2));
  ok("numbers beside a hook: spend / impressions / clicks summed over its linked ads all time (CTR from the sums, hook rate over video ads, GHL leads without tests, SGD Meta leads, CPL), zero impressions = dashes; sort by spend / CTR; Running ?hook= filter and the hooks on each card");

  // ---------------------------------------------------------------- SGD in Library / Review / meaning scopes, classify
  const fkbRootDir = path.join(tmp, "fkb-root");
  fs.mkdirSync(fkbRootDir, { recursive: true });
  const fkbRoot = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(fkbRootDir, SGD).lastInsertRowid);
  const fkbAsset = Number(
    s
      .prepare(
        `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status, description, needs_review, classified_at, described_at)
         values (?, ?, ?, 'garden-reveal.jpg', 'garden-reveal.jpg', 'jpg', 'image', 1, 1, 1, 'done', 'A bright white garden reveal with an island', 1, 1, 1)`,
      )
      .run(SGD, fkbRoot, path.join(fkbRootDir, "garden-reveal.jpg")).lastInsertRowid,
  );
  // SGD ad -> file: Morgan's "MO Ad 12.mov" media name is the file "Ad12.mov" in SGD's folders (its own section only).
  const matchLib = await import("../src/lib/meta/match");
  assert.deepEqual([matchLib.compactMediaName("MO Ad 12.mov"), matchLib.compactMediaName("Ad 3.mov"), matchLib.compactMediaName("x.mov")], ["ad12.mov", "ad3.mov", null]);
  const filmerAd = Number(
    s
      .prepare(
        `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status)
         values (?, ?, ?, 'Videos for Ad/Morgan Ads/Edited/Ad12.mov', 'Ad12.mov', 'mov', 'video', 1, 1, 1, 'done')`,
      )
      .run(SGD, fkbRoot, path.join(fkbRootDir, "Videos for Ad/Morgan Ads/Edited/Ad12.mov")).lastInsertRowid,
  );
  assert.equal(matchLib.assetForMediaName(s, "MO Ad 12.mov", { clientId: null, sectionId: SGD }), filmerAd);
  assert.equal(matchLib.assetForMediaName(s, "MO Ad 12.mov", { clientId: clientIdOf("acme"), sectionId: FKBPROS }), null, "another section's ads never take it");
  const lib = (scope: Parameters<typeof queries.listAssets>[0]) => queries.listAssets(scope, queries.parseFilters({})).items.map((i) => i.id);
  assert.ok(lib({ kind: "fkb" }).includes(fkbAsset));
  assert.ok(!lib({ kind: "fkbpros" }).includes(fkbAsset) && !lib({ kind: "rtm" }).includes(fkbAsset));
  assert.deepEqual(queries.parseReviewScope("fkb", []), { kind: "fkb" });
  assert.ok(queries.reviewQueue({ kind: "fkb" }).includes(fkbAsset) && !queries.reviewQueue({ kind: "fkbpros" }).includes(fkbAsset));
  assert.ok(queries.reviewCounts().fkb >= 1);
  const pf = prefilter(s, "garden island", { kind: "fkb" }, queries.parseFilters({}));
  assert.deepEqual(pf.candidates.map((c) => c.id), [fkbAsset], "search by meaning scope fkb");
  assert.equal(queries.channelHrefFor("fkb"), "/fkb/library");
  const cin = {
    id: fkbAsset, kind: "image" as const, section: "fkb" as const, filename: "garden-reveal.jpg", relPath: "garden-reveal.jpg", rootLabel: "fkb-root",
    orientation: null, durationS: null, description: "A garden", spokenOpen: null, generationPrompt: null, fixedClients: [], manualClass: null,
  };
  assert.equal(classify.asksClients(cin), false, "SGD files are never asked about clients");
  assert.match(String((classify.buildState(cin).file as Record<string, string>).section), /Summit Gardens and Decks/);
  const cq = classify.buildQuestions(cin, [{ code: "acme", name: "Adam", hint: "Adam" }]);
  assert.ok(!Object.keys(cq).some((k) => k.startsWith("client_")), "no client questions");
  assert.equal(classify.sectionStateText("fkbpros"), "SGD Pros (ads for garden and deck installers)", "existing sections' wording unchanged (no CLASSIFY_VERSION bump; the profile keeps it)");
  // Variants for an SGD hook: SGD speaks as itself; the SGD Pros client names stay banned; compounds allowed.
  const fr = vrules.compileVariantRules({
    section: "fkb",
    client: null,
    allClients: [{ code: "acme", name: "Adam / Acme Restoration", brandNotes: null }],
    existingNorms: new Set(),
    ownNotes: "Claims not allowed: financing or payment plans.",
    house: (await import("../src/lib/profile")).houseRulesFor("fkb"),
  });
  assert.equal(vrules.checkVariant("Summit Gardens and Decks builds your walk-in shower", fr).ok, true);
  assert.equal((vrules.checkVariant("Acme Restoration can do this garden", fr) as { rule?: string }).rule, "name");
  assert.equal((vrules.checkVariant("New garden — one team", fr) as { rule?: string }).rule, "dash");
  ok("SGD section in the Library (its own scope), Review (?in=fkb, counts) and search by meaning (scope fkb candidates); SGD ad matching (MO Ad N -> AdN.mov, own section); classify: SGD state, no client questions, other sections' wording unchanged; SGD variants may name SGD but never an SGD Pros client");
}
