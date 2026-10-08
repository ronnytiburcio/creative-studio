/**
 * Phase 5 slice 3 smoke checks (called by scripts/smoke.ts last): calibration math + the report, Running flags, threshold
 * settings and test order. A FRESH temp DB (migrated + seeded) with stub rows only: never the network, never Jev.
 */
import assert from "node:assert/strict";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

// 2026-09-30 12:00 America/New_York (EDT).
const NOW = Date.UTC(2026, 8, 30, 16, 0, 0);
const DAY = 86_400_000;
/** Noon New York time of a YYYY-MM-DD (EDT in September). */
const nyNoon = (d: string) => Date.parse(`${d}T16:00:00Z`);
const near = (a: number | null, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

export async function runSlice3Smoke({ cfg, tmp, ok }: Ctx) {
  const { openDb } = await import("../src/lib/db");
  const stats = await import("../src/lib/calibration/stats");
  const report = await import("../src/lib/calibration/report");
  const flagsLib = await import("../src/lib/meta/flags");
  const thresholds = await import("../src/lib/meta/thresholds");
  const { runningData, parseRunningFilters } = await import("../src/lib/meta/running");
  const rules = await import("../src/lib/meta/test-order-rules");
  const to = await import("../src/lib/meta/test-order");
  const { addDays } = await import("../src/lib/meta/windows");

  // ---------------------------------------------------------------- Spearman (pure)
  assert.deepEqual(stats.ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4], "average ranks for ties");
  assert.deepEqual(stats.ranks([3, 1, 2]), [3, 1, 2]);
  assert.ok(near(stats.spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 100]), 1), "monotonic = +1");
  assert.ok(near(stats.spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1), "reversed = -1");
  // Ties: x ranks [1, 2.5, 2.5, 4], y ranks [1, 3, 2, 4] -> 4.5 / sqrt(4.5 * 5) = 0.94868...
  assert.ok(near(stats.spearman([1, 2, 2, 3], [1, 3, 2, 4]), 4.5 / Math.sqrt(22.5)), "ties averaged");
  assert.equal(stats.spearman([1], [2]), null, "n < 2 = null");
  assert.equal(stats.spearman([], []), null);
  assert.equal(stats.spearman([2, 2, 2], [1, 2, 3]), null, "no spread = null");
  assert.equal(stats.fmtRho(0.4234), "+0.42");
  assert.equal(stats.fmtRho(-0.5), "−0.50");
  ok("Calibration math: Spearman = Pearson on tie-averaged ranks (+1 / -1 / ties 0.949), null for n < 2 or no spread, signed two-decimal text");

  // ---------------------------------------------------------------- hook result sums + minimum sample (pure)
  const r1 = stats.sumHookResults([
    { impressions: 1000, clicks: 10, video3s: 300, spend: 50, leads: 1, isVideo: true },
    { impressions: 3000, clicks: 90, video3s: 999, spend: 150, leads: 2, isVideo: false },
  ]);
  assert.deepEqual([r1.impressions, r1.clicks, r1.spend, r1.leads, r1.videoImpressions], [4000, 100, 200, 3, 1000]);
  assert.ok(near(r1.ctr, 2.5), "CTR from the sums (100 / 4000), not the mean of 1% and 3%");
  assert.ok(near(r1.hookRate, 30), "hook rate over the video ads only (300 / 1000)");
  assert.ok(near(r1.cpl, 200 / 3), "CPL = spend / leads");
  const zero = stats.sumHookResults([{ impressions: 0, clicks: 0, video3s: 0, spend: 12, leads: 0, isVideo: false }]);
  assert.deepEqual([zero.ctr, zero.hookRate, zero.cpl, zero.leads, zero.hasVideo], [null, null, null, 0, false], "zero impressions / zero leads = null ratios");
  const unknown = stats.sumHookResults([{ impressions: 10, clicks: 1, video3s: 0, spend: 1, leads: null, isVideo: false }]);
  assert.equal(unknown.leads, null, "leads never pulled = unknown, not 0");
  const min = stats.DEFAULT_CAL_MINIMUMS;
  assert.deepEqual(min, { impressions: 1000, leads: 3, hooks: 8, groups: 8, views: 300 });
  const res = (imp: number, videoImp: number, leads: number | null) =>
    stats.sumHookResults([
      { impressions: imp - videoImp, clicks: 5, video3s: 0, spend: 90, leads, isVideo: false },
      ...(videoImp ? [{ impressions: videoImp, clicks: 5, video3s: 100, spend: 10, leads: 0, isVideo: true }] : []),
    ]);
  assert.equal(stats.countsFor(res(999, 0, 3), "ctr", min), false, "999 impressions: not counted for CTR");
  assert.equal(stats.countsFor(res(1000, 0, 3), "ctr", min), true, "1,000 impressions: counted");
  assert.equal(stats.countsFor(res(5000, 0, 3), "hook", min), false, "no video ad: no hook rate");
  assert.equal(stats.countsFor(res(5000, 999, 3), "hook", min), false, "hook rate needs 1,000 VIDEO impressions");
  assert.equal(stats.countsFor(res(5000, 1000, 3), "hook", min), true);
  assert.equal(stats.countsFor(res(5000, 0, 2), "cpl", min), false, "2 leads: not counted for CPL");
  assert.equal(stats.countsFor(res(10, 0, 3), "cpl", min), true, "CPL counts on leads, whatever the impressions");
  const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ hookId: i + 1, score: i, result: stats.sumHookResults([{ id: `ad${i}`, impressions: 2000, clicks: 10 + i, video3s: 0, spend: 100, leads: 3 + i, isVideo: false }]) }));
  const five = stats.calCell(pts(5), "ctr", min);
  assert.deepEqual([five.n, five.enough, five.rho, stats.cellText(five)], [5, false, null, "Not enough data yet (5 of 8)"], "a cell needs 8 hooks");
  const eight = stats.calCell(pts(8), "ctr", min);
  assert.ok(eight.enough && near(eight.rho, 1) && stats.cellText(eight) === "+1.00 · 8 hooks on 8 ad groups");
  ok("Hook results = the SUM over linked ads (CTR / hook rate / CPL from the sums, hook rate over video ads only, zero impressions or leads = no ratio); a hook counts at 1,000 impressions (hook rate: video impressions) or 3 leads; a cell needs 8 hooks, else \"Not enough data yet (5 of 8)\"");

  // CPL direction: more leads for the same spend with a higher score = +1 ("higher score, better result").
  const cplCell = stats.calCell(pts(8), "cpl", min);
  assert.ok(near(cplCell.rho, 1), "lower CPL with a higher score reads +1");
  const worse = pts(8).map((p, i) => ({ ...p, score: -i }));
  assert.ok(near(stats.calCell(worse, "cpl", min).rho, -1), "higher score, higher CPL = -1");
  // Biggest misses: scores 5..1 vs CTR 1..5 (the rubric exactly backwards).
  const missPts = [5, 4, 3, 2, 1].map((sc, i) => ({ hookId: 10 + i, score: sc, result: stats.sumHookResults([{ impressions: 2000, clicks: 20 * (i + 1), video3s: 0, spend: 1, leads: 0, isVideo: false }]) }));
  const mm = stats.biggestMisses(missPts, "ctr", min);
  assert.deepEqual(mm.high.map((m) => m.hookId), [10, 11], "high score / poor result, biggest gap first (the middle one has no gap)");
  assert.deepEqual(mm.low.map((m) => m.hookId), [14, 13], "low score / strong result, biggest gap first");
  assert.ok(near(mm.high[0].gap, 1) && near(mm.low[0].gap, 1));
  assert.deepEqual(stats.biggestMisses(missPts.slice(0, 1), "ctr", min), { high: [], low: [] });
  ok("CPL is compared lower-is-better (+ always = higher score, better result); biggest misses rank by the gap between score rank and result rank (5 + 5, biggest first)");

  // ---------------------------------------------------------------- a fresh DB with stub rows
  const db = openDb(path.join(tmp, "slice3.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const acc = (code: string) =>
    (code === "fkb"
      ? s.prepare("select acc.id from ad_accounts acc join sections x on x.id = acc.section_id where x.key = 'fkb'").pluck().get()
      : s.prepare("select acc.id from ad_accounts acc join clients c on c.id = acc.client_id where c.code = ?").pluck().get(code)) as number;
  const sectionId = (k: string) => s.prepare("select id from sections where key = ?").pluck().get(k) as number;
  const clientId = (c: string) => s.prepare("select id from clients where code = ?").pluck().get(c) as number;
  s.prepare("update ad_accounts set timezone = 'America/New_York', last_sync_at = ?, ghl_synced_at = ?, leads_source = 'ghl'").run(NOW, NOW);
  s.prepare("update ad_accounts set leads_source = 'meta' where id = ?").run(acc("fkb"));
  const insAd = s.prepare(
    `insert into ads (meta_ad_id, account_id, name, effective_status, created_time, creative, angle_key, first_spend_date, first_seen_at, last_synced_at)
     values (@id, @account, @name, @status, @created, @creative, @angle, @first, 1, 1)`,
  );
  const ad = (id: string, account: number, o: { name?: string; status?: string; created?: number | null; video?: boolean; angle?: string | null; creative?: Record<string, unknown> } = {}) =>
    insAd.run({
      id,
      account,
      name: o.name ?? id,
      status: o.status ?? "ACTIVE",
      created: o.created ?? null,
      creative: JSON.stringify({ headlines: [], primaries: [], descriptions: [], ctas: [], videoIds: [], imageHashes: [], isVideo: o.video ?? false, link: null, ...(o.creative ?? {}) }),
      angle: o.angle ?? null,
      first: "2026-09-01",
    });
  const insM = s.prepare(
    `insert into ad_metrics (meta_ad_id, date, account_id, spend, impressions, clicks, video_3s, meta_leads, synced_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const days = (id: string, account: number, from: string, to: string, v: { spend?: number; imp?: number; clk?: number; v3?: number; ml?: number }) => {
    for (let d = from; d <= to; d = addDays(d, 1)) insM.run(id, d, account, v.spend ?? 0, v.imp ?? 0, v.clk ?? 0, v.v3 ?? 0, v.ml ?? 0);
  };
  let leadN = 0;
  const insLead = s.prepare("insert into ghl_leads (contact_id, account_id, date_added, test, ad_id, synced_at) values (?, ?, ?, ?, ?, 1)");
  const leads = (account: number, adId: string | null, n: number, day: string, test = 0) => {
    for (let i = 0; i < n; i++) insLead.run(`c${++leadN}`, account, nyNoon(day), test, adId);
  };
  const insWin = s.prepare("insert into ad_windows (meta_ad_id, window, frequency, reach, impressions, synced_at) values (?, ?, ?, ?, ?, 1)");
  const insCm = s.prepare(
    "insert into channel_metrics (account_id, window, date_start, spend, impressions, clicks, ctr, meta_leads, synced_at) values (?, ?, '2026-09-16', ?, 10000, 100, 1, ?, 1)",
  );
  const insHook = s.prepare("insert into hooks (section_id, client_id, kind, text, norm, source, archived_at, created_at) values (?, ?, ?, ?, ?, 'meta', ?, 1)");
  const hook = (section: string, client: string | null, text: string, kind: "text" | "video" = "text", archived = false) =>
    Number(insHook.run(sectionId(section), client ? clientId(client) : null, kind, text, text.toLowerCase(), archived ? 1 : null).lastInsertRowid);
  const insLink = s.prepare("insert into hook_ads (hook_id, meta_ad_id, role, created_at) values (?, ?, ?, 1)");
  const insScore = s.prepare(
    `insert into hook_scores (hook_id, rubric_version, answers, unsure, overall, pp_person, pp_pain, pp_promise, stops_scroll, model, scored_at)
     values (?, ?, ?, '[]', ?, ?, 0.5, 0.5, ?, 'jev-1.13.0', ?)`,
  );
  const score = (hookId: number, version: number, overall: number, pp = 0.5, stops = 0.5) =>
    insScore.run(hookId, version, JSON.stringify({ specificity: { type: "score", value: overall - 1 } }), overall, pp, stops, version);

  // ---------------------------------------------------------------- calibration report over the DB
  const ED = acc("cedar");
  const FKBACC = acc("fkb");
  const edHooks: number[] = [];
  for (let i = 0; i < 10; i++) {
    const id = `cal${i}`;
    ad(id, ED, { status: "PAUSED", video: i % 2 === 0 });
    // Higher i = higher CTR, higher hook rate, lower CPL (same spend, more leads).
    days(id, ED, "2026-08-01", "2026-08-04", { spend: 25, imp: 500, clk: 2 + i, v3: 50 + 10 * i });
    leads(ED, id, 3 + i, "2026-08-02");
    const h = hook("fkbpros", "cedar", `Calibration hook ${i}`, "text", i === 0);
    insLink.run(h, id, "headline");
    score(h, 1, 1 + i * 0.4, i / 10, 1 - i / 10);
    // v2 (latest) on the first five, backwards.
    if (i < 5) score(h, 2, 5 - i * 0.4);
    edHooks.push(h);
  }
  // Shared credit: one hook on two ads (as headline AND primary on the first) = each ad counted once.
  ad("share1", ED, { status: "PAUSED" });
  ad("share2", ED, { status: "PAUSED" });
  days("share1", ED, "2026-08-10", "2026-08-10", { spend: 10, imp: 700, clk: 7 });
  days("share2", ED, "2026-08-10", "2026-08-11", { spend: 20, imp: 150, clk: 3 });
  leads(ED, "share2", 2, "2026-08-10");
  leads(ED, "share2", 1, "2026-08-10", 1);
  const shared = hook("fkbpros", "cedar", "Two ads share me");
  insLink.run(shared, "share1", "headline");
  insLink.run(shared, "share1", "primary");
  insLink.run(shared, "share2", "headline");
  insLink.run(edHooks[5], "share1", "primary");
  // SGD: 3 hooks on Meta leads.
  for (let i = 0; i < 3; i++) {
    const id = `fkbcal${i}`;
    ad(id, FKBACC, { status: "PAUSED" });
    days(id, FKBACC, "2026-08-01", "2026-08-02", { spend: 50, imp: 1000, clk: 10 + i, ml: 2 });
    const h = hook("fkb", null, `SGD calibration hook ${i}`);
    insLink.run(h, id, "headline");
    score(h, 2, 2 + i);
  }
  const results = report.hookResults(s);
  const sh = results.get(shared)!;
  assert.deepEqual([sh.ads, sh.impressions, sh.clicks, sh.spend, sh.leads], [2, 1000, 13, 50, 2], "shared credit: both ads in full, each once, test lead out");
  assert.ok(near(sh.ctr, 1.3));
  const fkbRes = results.get(s.prepare("select id from hooks where text = 'SGD calibration hook 0'").pluck().get() as number)!;
  assert.equal(fkbRes.leads, 4, "SGD counts Meta leads (2 days x 2)");

  const v1 = report.calibrationReport(s, report.parseCalParams({ cal_v: "1", cal_view: "cedar" }));
  const row = (r: typeof v1, id: string) => r.view.rows.find((x) => x.item.id === id)!.cells as Record<import("../src/lib/calibration/stats").CalMetric, import("../src/lib/calibration/stats").CalCell>;
  assert.equal(v1.params.version, 1);
  assert.equal(v1.view.counted.ctr, 10, "10 cedar hooks with 2,000 impressions count (the shared hook has 1,000 but no v1 score)");
  assert.ok(near(row(v1, "overall").ctr.rho, 1) && near(row(v1, "overall").cpl.rho, 1), "v1: score order = CTR order = CPL order (lower is better)");
  assert.ok(near(row(v1, "dim:specificity").ctr.rho, 1), "per dimension (level from Jev's 0-based value)");
  assert.ok(near(row(v1, "pp_person").ctr.rho, 1) && near(row(v1, "stops_scroll").ctr.rho, -1), "Three P's and stops the scroll as P(yes)");
  assert.equal(row(v1, "overall").hook.enough, false, "5 video hooks: hook rate not enough");
  assert.equal(stats.cellText(row(v1, "overall").hook), "Not enough data yet (5 of 8)");
  const v2 = report.calibrationReport(s, report.parseCalParams({ cal_v: "2", cal_view: "cedar" }));
  assert.equal(row(v2, "overall").ctr.n, 5, "exact v2: only the 5 hooks scored on v2");
  const latest = report.calibrationReport(s, report.parseCalParams({ cal_view: "cedar" }));
  assert.equal(latest.params.version, "latest");
  assert.deepEqual(latest.includedVersions, [1, 2], "latest mixes v1 and v2");
  assert.match(latest.versionNote, /same question with the same 5 levels/, "v2 = v1 + SGD: same dimension wording");
  assert.equal(row(latest, "overall").ctr.n, 10, "latest: every linked, scored hook once (the unscored shared hook is out)");
  assert.ok((row(latest, "overall").ctr.rho ?? 1) < 0.5, "the backwards v2 half pulls the latest correlation down");
  assert.deepEqual(latest.versionOptions.map((o) => o.value), ["latest", "1", "2"]);
  const overall = report.calibrationReport(s, report.parseCalParams({}));
  assert.equal(overall.view.key, "overall");
  assert.equal(overall.view.linked, 13, "Overall pools SGD Pros and SGD");
  assert.equal(overall.view.metaLeads, true, "Meta leads flagged for SGD");
  assert.ok(overall.byChannel.some((c) => c.key === "fkb" && c.linked === 3) && overall.byChannel.some((c) => c.key === "acme" && c.linked === 0));
  assert.match(overall.rtm.note ?? "", /Not yet calibrated: connect YouTube in Settings/);
  const misses = report.calibrationReport(s, report.parseCalParams({ cal_v: "2", cal_view: "cedar", cal_m: "ctr" }));
  assert.equal(misses.misses.metric, "ctr");
  assert.deepEqual(misses.misses.high.map((m) => m.hookId).slice(0, 2), [edHooks[0], edHooks[1]], "v2's top scores have the worst CTR");
  assert.ok(misses.misses.high[0].href.startsWith("/fkbpros/cedar/hooks?archived=1&focus="), "miss links to its (archived) hook row");
  assert.equal(report.parseCalParams({ cal_v: "x", cal_view: "../x", cal_m: "nope" }).version, "latest");
  ok("Calibration report (fresh DB, stub rows): shared credit sums each ad once (tests out), SGD on Meta leads; per dimension / overall / P's / stops the scroll x CTR / hook rate / CPL; exact version vs latest per hook (v1 + v2 listed, same wording); Overall pools SGD Pros + SGD, per channel, NSM not yet; misses link to the hook row");

  const line = report.calibrationLine(s, { kind: "client", code: "cedar" });
  assert.match(line.text, /10 hooks here have enough Meta results/);
  assert.equal(line.href, "/rubric?cal_view=cedar#calibration");
  assert.match(report.calibrationLine(s, { kind: "fkb" }).text, /not enough Meta results here yet \(3 of 8/);
  assert.match(report.calibrationLine(s, { kind: "rtm" }).text, /not yet calibrated/);
  ok("Hooks tab line: says whether the channel has enough Meta results for the report and links to it (NSM: not yet calibrated)");

  // ---------------------------------------------------------------- flags (pure)
  const T = flagsLib.DEFAULT_FLAG_THRESHOLDS;
  const base = { isVideo: true, frequency: 1.2, recent: { impressions: 5000, clicks: 100, video3s: 1500 }, earlier: { impressions: 5000, clicks: 100, video3s: 1500 }, spend14: 0, leads14: 0, channelCpl14: null };
  assert.deepEqual(flagsLib.adFlags(base, T), [], "steady ad: no flag");
  assert.deepEqual(flagsLib.adFlags({ ...base, frequency: 3.4 }, T), [{ id: "fatiguing", reasons: ["frequency 3.4"] }]);
  assert.deepEqual(flagsLib.adFlags({ ...base, frequency: 3 }, T), [], "frequency must be ABOVE 3");
  assert.deepEqual(flagsLib.adFlags({ ...base, frequency: 3.04 }, T)[0].reasons, ["frequency 3.04"], "never reads as the threshold itself");
  const drop = flagsLib.adFlags({ ...base, recent: { impressions: 5000, clicks: 65, video3s: 1100 }, earlier: { impressions: 10000, clicks: 190, video3s: 3000 } }, T);
  assert.deepEqual(drop, [{ id: "fatiguing", reasons: ["CTR 1.9% → 1.3%", "hook rate 30% → 22%"] }], "CTR 1.9 -> 1.3 (-32%) and hook rate 30 -> 22 (-27%)");
  assert.deepEqual(flagsLib.adFlags({ ...base, recent: { impressions: 2999, clicks: 10, video3s: 100 }, earlier: { impressions: 10000, clicks: 190, video3s: 3000 } }, T), [], "under 3,000 impressions on one side: no drop check");
  assert.deepEqual(flagsLib.adFlags({ ...base, recent: { impressions: 5000, clicks: 76, video3s: 1500 }, earlier: { impressions: 5000, clicks: 100, video3s: 1500 } }, T), [], "a 24% drop is not enough");
  assert.deepEqual(flagsLib.adFlags({ ...base, spend14: 294, leads14: 3, channelCpl14: 141 }, T), [{ id: "winner", reasons: ["CPL $98 vs channel $141"] }]);
  assert.deepEqual(flagsLib.adFlags({ ...base, spend14: 196, leads14: 2, channelCpl14: 141 }, T), [], "2 leads: no winner");
  assert.deepEqual(flagsLib.adFlags({ ...base, spend14: 360, leads14: 3, channelCpl14: 141 }, T), [], "CPL $120 is only 15% better");
  ok("Flags (pure): fatiguing = frequency above 3, or CTR / hook rate down 25%+ vs the ad's earlier days with 3,000+ impressions on each side (reasons on the chip); winner = 14 day CPL 20%+ under the channel's with 3+ leads");

  // ---------------------------------------------------------------- flags on the Running tab (stub rows)
  const DOM = acc("acme");
  ad("fA", DOM, { video: true });
  days("fA", DOM, "2026-09-01", "2026-09-10", { spend: 5, imp: 1000, clk: 20, v3: 300 });
  days("fA", DOM, "2026-09-23", "2026-09-29", { spend: 5, imp: 1000, clk: 10, v3: 150 });
  insWin.run("fA", "7d", 2.0, 3500, 7000);
  ad("fB", DOM);
  days("fB", DOM, "2026-09-01", "2026-09-02", { spend: 5, imp: 1000, clk: 20 });
  days("fB", DOM, "2026-09-23", "2026-09-29", { spend: 5, imp: 500, clk: 2 });
  insWin.run("fB", "7d", null, 1000, 3400);
  ad("fC", DOM, { video: true });
  days("fC", DOM, "2026-09-16", "2026-09-29", { spend: 20, imp: 300, clk: 3, v3: 90 });
  leads(DOM, "fC", 4, "2026-09-20");
  ad("fD", DOM);
  days("fD", DOM, "2026-09-16", "2026-09-29", { spend: 4, imp: 300, clk: 3 });
  leads(DOM, "fD", 2, "2026-09-21");
  leads(DOM, null, 4, "2026-09-25");
  insCm.run(DOM, "14d", 1400, 0);
  const winnerHook = hook("fkbpros", "acme", "Winner hook");
  const lowHook = hook("fkbpros", "acme", "Lower hook");
  insLink.run(winnerHook, "fC", "headline");
  insLink.run(lowHook, "fC", "primary");
  score(winnerHook, 2, 4.2);
  score(lowHook, 2, 2.1);
  const F = FKBACC;
  ad("fF", F);
  days("fF", F, "2026-09-16", "2026-09-20", { spend: 20, imp: 400, clk: 4, ml: 1 });
  insCm.run(F, "14d", 1000, 20);

  const dom = runningData(s, { kind: "client", code: "acme" }, parseRunningFilters({}), NOW);
  const card = (id: string) => dom.cards.find((c) => c.metaAdId === id)!;
  assert.deepEqual(card("fA").flags, [{ id: "fatiguing", reasons: ["CTR 2.0% → 1.0%", "hook rate 30% → 15%"] }]);
  assert.deepEqual(card("fB").flags, [{ id: "fatiguing", reasons: ["frequency 3.4"] }], "no Meta frequency: impressions / reach (3,400 / 1,000); 2,000 earlier impressions = no drop check");
  assert.deepEqual(card("fC").flags, [{ id: "winner", reasons: ["CPL $70 vs channel $140"] }], "$280 / 4 GHL leads vs $1,400 / 10 channel leads");
  assert.equal(card("fC").rewriteHref, `/fkbpros/acme/hooks?focus=${winnerHook}&rewrite=${winnerHook}`, "Rewrite link: its best-scoring text hook");
  assert.deepEqual(card("fD").flags, [], "2 leads: not a winner");
  assert.deepEqual(dom.flagCounts, { fatiguing: 2, winner: 1 });
  const onlyWin = runningData(s, { kind: "client", code: "acme" }, parseRunningFilters({ flag: "winner" }), NOW);
  assert.deepEqual(onlyWin.cards.map((c) => c.metaAdId), ["fC"], "Flags filter");
  assert.equal(parseRunningFilters({ flag: "bogus" }).flag, null);
  const fkbRun = runningData(s, { kind: "fkb" }, parseRunningFilters({}), NOW);
  assert.deepEqual(fkbRun.cards.find((c) => c.metaAdId === "fF")!.flags, [{ id: "winner", reasons: ["CPL $20 vs channel $50"] }], "SGD: Meta leads (5 over 14 days)");
  const all = runningData(s, { kind: "fkbpros" }, parseRunningFilters({}), NOW);
  assert.deepEqual(all.clientRows!.find((r) => r.code === "acme")!.flags, { fatiguing: 2, winner: 1 }, "All SGD Pros client table: flag counts");
  assert.deepEqual(all.clientRows!.find((r) => r.code === "fkb")!.flags, { fatiguing: 0, winner: 1 }, "SGD comparison row too");
  assert.equal(s.prepare("select count(*) from jobs").pluck().get(), 0, "flags never queue anything");
  ok("Running flags from the daily rows: frequency (Meta's, else impressions / reach), CTR + hook rate drop vs earlier days, winner vs the channel's 14 day CPL (GHL; SGD Meta leads), Rewrite link to the best-scoring hook, Flags filter + counts, All SGD Pros table counts; nothing queued");

  // ---------------------------------------------------------------- threshold settings
  const bad = [
    { ...T, frequency: 0 },
    { ...T, dropPct: 95 },
    { ...T, minImpressions: 1.5 },
    { ...T, winnerLeads: 0 },
    { ...T, extra: 1 },
    { frequency: 3 },
  ];
  for (const b of bad) assert.equal(flagsLib.flagThresholdsSchema.safeParse(b).success, false, JSON.stringify(b));
  assert.equal(flagsLib.calibrationMinimumsSchema.safeParse({ impressions: 1000, leads: 3, hooks: 2 }).success, false, "a cell needs 3+ hooks");
  thresholds.setFlagThresholds(s, { ...T, frequency: 1.5, winnerLeads: 5 });
  const tuned = runningData(s, { kind: "client", code: "acme" }, parseRunningFilters({}), NOW);
  assert.deepEqual(tuned.cards.find((c) => c.metaAdId === "fA")!.flags[0].reasons.at(-1), "frequency 2.0", "saved thresholds apply");
  assert.deepEqual(tuned.flagCounts.winner, 0, "5 leads needed now");
  s.prepare("update app_settings set value = '{not json' where key = ?").run(thresholds.FLAG_THRESHOLDS_KEY);
  assert.deepEqual(thresholds.flagThresholds(s), T, "unreadable = defaults");
  thresholds.setFlagThresholds(s, null);
  assert.deepEqual(thresholds.flagThresholds(s), T, "Reset");
  thresholds.setCalibrationMinimums(s, { impressions: 5000, leads: 3, hooks: 3, groups: 3, views: 300 });
  assert.equal(report.calibrationReport(s, report.parseCalParams({ cal_v: "1", cal_view: "cedar" })).view.counted.ctr, 0, "calibration minimums apply (5,000 impressions)");
  thresholds.setCalibrationMinimums(s, null);
  assert.deepEqual(thresholds.calibrationMinimums(s), stats.DEFAULT_CAL_MINIMUMS);
  ok("Threshold settings: zod rejects out-of-range / fractional / extra / partial values; saved flag thresholds and calibration minimums apply at read time; unreadable = defaults; Reset");

  // ---------------------------------------------------------------- test order rules (pure)
  const f = (o: Partial<import("../src/lib/meta/test-order-rules").AdFeatures> & { id: string }) => ({
    name: o.id,
    angle: "a1",
    angleLabel: o.angle ?? "a1",
    line: null,
    asset: null,
    metaMedia: "v1",
    isVideo: true,
    texts: "t1",
    ctas: ["GET_QUOTE"],
    link: "sgdpros.example/acme",
    ...o,
  });
  const prior = [f({ id: "p1" }), f({ id: "p2", angle: "a2", metaMedia: "s1", isVideo: false, texts: "t2" })];
  const one = (o: Parameters<typeof f>[0]) => rules.classifyBatch([f(o)], prior);
  assert.equal(one({ id: "n", angle: "a9" }).suggested, "hook", "new angle = hook");
  assert.equal(one({ id: "n", metaMedia: "v2", texts: "t9" }).suggested, "format", "same angle + new video = format");
  assert.equal(one({ id: "n", angle: "a1", metaMedia: "s9", isVideo: false }).suggested, "format", "same angle + a static = format");
  assert.equal(one({ id: "n", texts: "t9" }).suggested, "copy", "same angle + same video, new text = copy");
  assert.equal(one({ id: "n", ctas: ["SIGN_UP"] }).suggested, "offer", "new CTA = offer");
  assert.equal(one({ id: "n", link: "sgdpros.example/acme-free" }).suggested, "offer", "new landing page = offer");
  const same = one({ id: "n" });
  assert.deepEqual([same.suggested, same.parts], ["none", []], "a copy of a running ad = not a test");
  assert.match(same.reason, /^Not a test/);
  const mixed = rules.classifyBatch([f({ id: "n1", angle: "a9" }), f({ id: "n2", metaMedia: "v3" }), f({ id: "n3" })], prior);
  assert.deepEqual([mixed.suggested, mixed.parts, mixed.mixed], ["hook", ["hook", "format"], true], "mixed = the highest, with the parts");
  assert.match(mixed.reason, /Hook: new angle a9 · format: new video for a1 · 1 ad repeats an ad already running\./);
  const offerHook = one({ id: "n", angle: "a9", ctas: ["SIGN_UP"] });
  assert.deepEqual([offerHook.suggested, offerHook.parts], ["offer", ["offer", "hook"]], "offer outranks hook");
  assert.equal(rules.classifyBatch([f({ id: "x" })], []).first, true, "first ads: nothing to compare");
  assert.deepEqual([rules.nextInOrder(null), rules.nextInOrder("offer"), rules.nextInOrder("hook"), rules.nextInOrder("format"), rules.nextInOrder("copy")], ["offer", "hook", "format", "copy", "offer"], "the order cycles");
  const feat = to.adFeatures({ meta_ad_id: "1", name: "x", created_time: 1, matched_asset_id: null, angle_key: null, creative: JSON.stringify({ headlines: ["H"], primaries: ["🏠 Dream gardens start here.\n✅ Free quote"], ctas: ["GET_QUOTE"], videoIds: ["9"], imageHashes: [], isVideo: true, link: "https://www.SGDpros.example/acme/?utm=1" }) });
  assert.deepEqual([feat.angle, feat.line, feat.link, feat.asset, feat.metaMedia], [null, "dream gardens start here", "sgdpros.example/acme", null, "9"], "opening line kept for ads without an angle key; link = host + path");
  assert.equal(rules.sameAngle({ angle: "a", line: "x" }, { angle: null, line: "x" }), true, "one side without an angle key: the opening lines decide");
  assert.equal(rules.sameAngle({ angle: "a", line: "x" }, { angle: "b", line: "x" }), false, "both keyed: the keys decide");
  assert.equal(rules.sameAngle({ angle: null, line: null }, { angle: null, line: null }), false, "nothing known: a new angle");
  assert.equal(rules.classifyBatch([f({ id: "n", angle: null, line: "open" })], [f({ id: "p", line: "open" })]).suggested, "none", "SGD style (no ad map): same opening, file and text = a repeat");
  ok("Test order rules: new angle = hook, same angle + new video / a static = format, same file + new text = copy, new CTA / landing page = offer, nothing new = not a test, mixed = highest (offer > hook > format > copy) with its parts, first ads; next cycles offer -> hook -> format -> copy -> offer");

  // ---------------------------------------------------------------- test order store (batches, confirm / change)
  const TO = acc("bluebird");
  const cr = (o: Record<string, unknown>) => ({ ctas: ["GET_QUOTE"], link: "https://sgdpros.example/bluebird", headlines: ["H"], primaries: ["P one."], ...o });
  ad("t1", TO, { status: "PAUSED", created: nyNoon("2026-09-01"), angle: "a1", video: true, creative: cr({ videoIds: ["v1"], isVideo: true }) });
  ad("t2", TO, { status: "PAUSED", created: nyNoon("2026-09-01") + 3600_000, angle: "a2", creative: cr({ imageHashes: ["s1"], primaries: ["P two."] }) });
  ad("t3", TO, { status: "PAUSED", created: nyNoon("2026-09-10"), angle: "a3", video: true, creative: cr({ videoIds: ["v9"], isVideo: true }) });
  ad("t4", TO, { status: "PAUSED", created: nyNoon("2026-09-15"), angle: "a1", video: true, creative: cr({ videoIds: ["v2"], isVideo: true }) });
  ad("t5", TO, { status: "PAUSED", created: nyNoon("2026-09-20"), angle: "a1", video: true, creative: cr({ videoIds: ["v1"], isVideo: true, headlines: ["New H"] }) });
  ad("t6", TO, { status: "PAUSED", created: nyNoon("2026-09-25"), angle: "a2", creative: cr({ imageHashes: ["s1"], primaries: ["P two."], ctas: ["SIGN_UP"] }) });
  // 23:30 New York on 9/28 is already 9/29 in UTC: still the 9/28 batch.
  const late = Date.parse("2026-09-29T03:30:00Z");
  ad("t7", TO, { status: "PAUSED", created: late, angle: "a4", video: true, creative: cr({ videoIds: ["v4"], isVideo: true }) });
  ad("t8", TO, { status: "PAUSED", created: late - 60_000, angle: "a1", video: true, creative: cr({ videoIds: ["v5"], isVideo: true }) });
  // A relaunched copy whose map row gave no angle: same name as t1 -> t1's angle (so its new opening = copy, not hook).
  ad("t9", TO, { name: "t1 - Copy", status: "PAUSED", created: nyNoon("2026-09-28"), angle: null, video: true, creative: cr({ videoIds: ["v1"], isVideo: true, primaries: ["Other opening line."] }) });
  const st = to.syncTestOrders(s, { accountIds: [TO], now: NOW });
  assert.deepEqual([st.batches, st.inserted], [6, 6]);
  const batches = s.prepare("select batch_date, suggested, parts, n_ads from test_orders where account_id = ? order by batch_date").all(TO) as { batch_date: string; suggested: string; parts: string; n_ads: number }[];
  assert.deepEqual(
    batches.map((b) => [b.batch_date, b.suggested, b.n_ads]),
    [
      ["2026-09-01", "none", 2],
      ["2026-09-10", "hook", 1],
      ["2026-09-15", "format", 1],
      ["2026-09-20", "copy", 1],
      ["2026-09-25", "offer", 1],
      ["2026-09-28", "hook", 3],
    ],
    "batches by New York day; each vs the ads before it",
  );
  assert.equal(batches.at(-1)!.parts, JSON.stringify(["hook", "format", "copy"]), "9/28: mixed hook + format + copy");
  const d928 = JSON.parse(s.prepare("select detail from test_orders where account_id = ? and batch_date = '2026-09-28'").pluck().get(TO) as string) as { id: string; variable: string }[];
  assert.equal(d928.find((d) => d.id === "t9")!.variable, "copy", "the copy took t1's angle by name");
  let ch = to.channelTestOrder(s, "bluebird");
  assert.equal(ch.prompt?.date, "2026-09-28", "only the newest batch asks for a Confirm");
  assert.equal(ch.lastTested?.date, "2026-09-28");
  assert.equal(ch.next, "format", "suggested hook -> next format");
  assert.equal(to.confirmTestOrder(s, "bluebird", "2026-09-28", NOW), "hook");
  to.setTestOrder(s, "bluebird", "2026-09-25", "copy", NOW);
  assert.throws(() => to.setTestOrder(s, "bluebird", "2026-01-01", "hook", NOW), to.TestOrderError);
  assert.throws(() => to.setTestOrder(s, "bluebird", "2026-09-25", "banana" as "hook", NOW), to.TestOrderError);
  to.syncTestOrders(s, { accountIds: [TO], now: NOW + DAY });
  const kept = s.prepare("select batch_date, variable, confirmed_at from test_orders where account_id = ? and variable is not null order by batch_date").all(TO);
  assert.deepEqual(kept, [
    { batch_date: "2026-09-25", variable: "copy", confirmed_at: NOW },
    { batch_date: "2026-09-28", variable: "hook", confirmed_at: NOW },
  ], "a later sync never overwrites Alex's answers");
  ch = to.channelTestOrder(s, "bluebird");
  assert.equal(ch.prompt, null, "confirmed: no prompt");
  // A new batch (9/30, a new text on the same video) asks again; the order moves on after Alex's hook.
  ad("t10", TO, { status: "ACTIVE", created: NOW, angle: "a4", video: true, creative: cr({ videoIds: ["v4"], isVideo: true, headlines: ["Newer H"] }) });
  to.syncTestOrders(s, { accountIds: [TO], now: NOW });
  ch = to.channelTestOrder(s, "bluebird");
  assert.deepEqual([ch.prompt?.date, ch.prompt?.suggested, ch.lastTested?.answer, ch.next], ["2026-09-30", "copy", "copy", "offer"]);
  to.setTestOrder(s, "bluebird", "2026-09-30", "none", NOW);
  ch = to.channelTestOrder(s, "bluebird");
  assert.deepEqual([ch.lastTested?.date, ch.lastTested?.answer, ch.next], ["2026-09-28", "hook", "format"], "not a test: last tested stays the 9/28 hook");
  const table = to.testOrderTable(s);
  const dr = table.find((r) => r.code === "bluebird")!;
  assert.deepEqual([dr.lastTested, dr.confirmed, dr.date, dr.next, dr.pending], ["hook", true, "2026-09-28", "format", false]);
  const ed = table.find((r) => r.code === "cedar")!;
  assert.deepEqual([ed.lastTested, ed.next], [null, "offer"], "no created times: nothing tested yet, start with offer");
  assert.ok(table.at(-1)!.code === "fkb" && table.at(-1)!.href === "/fkb/client#test-order");
  ok("Test order store: batches grouped by New York day (23:30 EDT stays that day), suggested vs every earlier ad (first / hook / format / copy / offer / mixed), only the newest batch prompts, Confirm / Change kept across syncs, a new batch prompts again, the Rubric table's last tested (confirmed vs suggested) and next in the order");

  db.sqlite.close();
}
