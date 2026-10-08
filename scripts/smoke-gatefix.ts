/**
 * Phase 5 gate fix smoke checks (called by scripts/smoke.ts last): refresh gaps + the backfill fallback, GHL partial
 * reads, fatigue on the last 7 days, video hooks for matched ad videos, the test order file rule, one anchor for Meta and
 * GHL windows, the 06:00 slot on DST days, the Graph parameter refusal, thumbnail redirects and terse error text.
 * A FRESH temp DB (migrated + seeded) with stub transports and stub rows only: never the network, never Jev.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const TOKEN = "gfSECRETtoken0123456789abcdef";
const GHL_KEY = "gfSECRETghlkey11223344556677";
/** Noon New York time of a YYYY-MM-DD (EDT in September). */
const nyNoon = (d: string) => Date.parse(`${d}T16:00:00Z`);
// 2026-09-30 12:00 America/New_York (EDT).
const NOW = nyNoon("2026-09-30");

type GraphReq = { method: string; url: string; headers: Record<string, string> };

export async function runGateFixSmoke({ cfg, tmp, ok }: Ctx) {
  const { openDb } = await import("../src/lib/db");
  const { MetaGraph, MetaTokenMissingError, httpGraphTransport } = await import("../src/lib/meta/graph");
  const { GhlClient, GHL_SEARCH_URL } = await import("../src/lib/meta/ghl");
  const sync = await import("../src/lib/meta/sync");
  const { runningData, parseRunningFilters } = await import("../src/lib/meta/running");
  const { syncMetaHooks } = await import("../src/lib/meta/hooks");
  const rules = await import("../src/lib/meta/test-order-rules");
  const to = await import("../src/lib/meta/test-order");
  const store = await import("../src/lib/meta/store");
  const { addDays } = await import("../src/lib/meta/windows");
  const { httpThumbFetch } = await import("../src/lib/meta/thumbs");
  const { YouTubeApi } = await import("../src/lib/youtube/api");

  const db = openDb(path.join(tmp, "gatefix.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const accId = (code: string) => s.prepare("select acc.id from ad_accounts acc join clients c on c.id = acc.client_id where c.code = ?").pluck().get(code) as number;
  const accountRow = (code: string) => sync.listAccounts(s).find((a) => a.code === code)!;

  // ---------------------------------------------------------------- fixtures: env file, client folders
  const clientsDir = path.join(tmp, "gatefix-clients");
  fs.mkdirSync(path.join(clientsDir, "acme"), { recursive: true });
  fs.mkdirSync(path.join(clientsDir, "cedar"), { recursive: true });
  fs.writeFileSync(path.join(clientsDir, "acme", "state.json"), JSON.stringify({ campaign_id: "111" }));
  fs.writeFileSync(path.join(clientsDir, "cedar", "build_state.json"), JSON.stringify({ campaign_id: "222" }));
  const envFile = path.join(clientsDir, "agency.env");
  fs.writeFileSync(envFile, `META_ACCESS_TOKEN=${TOKEN}\nMETA_GRAPH_VERSION=v21.0\nGHL_API_KEY=${GHL_KEY}\nGHL_LOCATION_ID=loc1\n`);

  // ---------------------------------------------------------------- the stub Graph API (one world, mutable)
  const dailyRange = (adId: string, from: string, to: string) => {
    const out: Record<string, unknown>[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ ad_id: adId, ad_name: adId, date_start: d, date_stop: d, spend: "1.00", impressions: "100", clicks: "2", inline_link_clicks: "1" });
    return out;
  };
  const world = {
    campaigns: {
      "111": { id: "111", name: "Adam-SGC", effective_status: "ACTIVE", start_time: "2026-09-20T12:00:00-0400" },
      "222": { id: "222", name: "Ben-SGC", effective_status: "ACTIVE" }, // no start_time
    } as Record<string, Record<string, string>>,
    ads: {
      "111": [{ id: "1001", name: "SGC-acme-a-01", effective_status: "ACTIVE", created_time: "2026-09-20T14:00:00+0000", campaign_id: "111", creative: { id: "c1", video_id: "v1" } }],
      "222": [
        { id: "2001", name: "Ben-Ad-01", effective_status: "ACTIVE", created_time: "2026-09-12T15:00:00+0000", campaign_id: "222", creative: { id: "c2", video_id: "v2" } },
        { id: "2002", name: "Ben-Ad-02", effective_status: "ACTIVE", created_time: "2026-09-10T15:00:00+0000", campaign_id: "222", creative: { id: "c3", video_id: "v3" } },
      ],
    } as Record<string, Record<string, unknown>[]>,
    days: { "111": dailyRange("1001", "2026-09-20", "2026-09-30"), "222": dailyRange("2001", "2026-09-10", "2026-09-30") } as Record<string, Record<string, unknown>[]>,
  };
  const ranges: { campaign: string; since: string; until: string }[] = [];
  const graphReqs: GraphReq[] = [];
  const stubGraph = async (req: GraphReq) => {
    graphReqs.push(req);
    const u = new URL(req.url);
    const p = u.pathname.replace(/^\/v\d+\.\d+\/?/, "");
    const q = Object.fromEntries(u.searchParams);
    const json = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body), header: () => null });
    if (/^act_\d+$/.test(p)) return json({ id: p, timezone_name: "America/New_York" });
    if (world.campaigns[p] && q.fields?.includes("start_time")) return json(world.campaigns[p]);
    let m = /^(\d+)\/ads$/.exec(p);
    if (m) return json({ data: world.ads[m[1]] ?? [] });
    m = /^(\d+)\/insights$/.exec(p);
    if (m) {
      if (q.time_increment === "1") {
        const r = JSON.parse(q.time_range) as { since: string; until: string };
        ranges.push({ campaign: m[1], ...r });
        return json({ data: (world.days[m[1]] ?? []).filter((d) => (d.date_start as string) >= r.since && (d.date_start as string) <= r.until) });
      }
      return json({ data: [] });
    }
    if (p === "") return json({});
    if (/^act_\d+\/adimages$/.test(p)) return json({ data: [] });
    return json({ error: { message: `unknown ${p}`, code: 803 } }, 404);
  };

  // ---------------------------------------------------------------- the stub GHL API
  type Contact = Record<string, unknown>;
  const contact = (id: string, day: string, utm: string | null, cursor = true): Contact => ({
    id,
    dateAdded: new Date(nyNoon(day)).toISOString(),
    tags: [],
    attributionSource: utm ? { utmContent: utm } : {},
    lastAttributionSource: {},
    ...(cursor ? { searchAfter: [nyNoon(day), id] } : {}),
  });
  let ghlMode: "complete" | "partial" = "complete";
  let ghlContacts: Contact[] = [];
  const stubGhl = async (req: { method: string; url: string; body: string }) => {
    assert.equal(req.url, GHL_SEARCH_URL);
    if (ghlMode === "partial") {
      // GHL says 3 but stops after 2 with no cursor on the last one: an incomplete read.
      const page = ghlContacts.slice(0, 2).map((c, i) => (i === 1 ? { ...c, searchAfter: undefined } : c));
      return { status: 200, body: JSON.stringify({ contacts: page, total: ghlContacts.length }) };
    }
    return { status: 200, body: JSON.stringify({ contacts: ghlContacts, total: ghlContacts.length }) };
  };

  let now = nyNoon("2026-09-22");
  const logs: string[] = [];
  const deps = {
    graph: () => new MetaGraph({ identity: "fpc", envFile, transport: stubGraph, sleep: async () => {}, now: () => now, retryDelays: [1] }),
    ghl: () => new GhlClient({ identity: "fpc", envFile, transport: stubGhl, sleep: async () => {} }),
    cacheDir: cfg.cacheDir,
    clientsDir,
    now: () => now,
    log: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
    isStopped: () => false,
  };

  // ---------------------------------------------------------------- 1. refresh gaps
  assert.equal(sync.refreshFrom("2026-09-29", "2026-09-28", "2026-01-01"), "2026-09-27", "synced yesterday: the usual 3 day window");
  assert.equal(sync.refreshFrom("2026-09-29", "2026-09-22", "2026-01-01"), "2026-09-21", "a 6 day gap: from the day before the last read");
  assert.equal(sync.refreshFrom("2026-09-29", "2026-09-22", "2026-09-25"), "2026-09-25", "never before the campaign start");
  assert.equal(sync.refreshFrom("2026-09-29", null, "2026-01-01"), "2026-09-27");
  const dom = accId("acme");
  const r0 = await sync.syncAccount(s, accountRow("acme"), deps);
  assert.ok(r0.ok, r0.error);
  assert.deepEqual(ranges.filter((r) => r.campaign === "111").map((r) => [r.since, r.until]), [["2026-09-20", "2026-09-22"]], "first sync: the backfill from the start");
  assert.equal(s.prepare("select synced_through from meta_campaigns where id = '111'").pluck().get(), "2026-09-22");
  // The worker is down / paused / failing for 6 days, then syncs on 9/29.
  ranges.length = 0;
  now = nyNoon("2026-09-29");
  const r1 = await sync.syncAccount(s, accountRow("acme"), deps);
  assert.ok(r1.ok, r1.error);
  assert.deepEqual(ranges.filter((r) => r.campaign === "111").map((r) => [r.since, r.until]), [["2026-09-21", "2026-09-29"]], "the gap is re-read from the day before the last read");
  const days = s.prepare("select date from ad_metrics where meta_ad_id = '1001' order by date").pluck().all() as string[];
  const want: string[] = [];
  for (let d = "2026-09-20"; d <= "2026-09-29"; d = addDays(d, 1)) want.push(d);
  assert.deepEqual(days, want, "every day stored, the 6 missed days (9/23 to 9/28) included");
  assert.equal(s.prepare("select synced_through from meta_campaigns where id = '111'").pluck().get(), "2026-09-29");
  // A campaign backfilled before synced_through existed: the account's last good sync stands in.
  s.prepare("update meta_campaigns set synced_through = null where id = '111'").run();
  ranges.length = 0;
  now = nyNoon("2026-09-30");
  assert.ok((await sync.syncAccount(s, accountRow("acme"), deps)).ok);
  assert.deepEqual(ranges.filter((r) => r.campaign === "111").map((r) => [r.since, r.until]), [["2026-09-28", "2026-09-30"]], "no marker: from the day before the account's last good sync");
  ok("Refresh gaps: later syncs re-read from the earlier of (today - 2) and the day before the campaign's last completed read (meta_campaigns.synced_through; older rows: the account's last good sync), capped at the start: a 6 day gap is filled on the next sync");

  // ---------------------------------------------------------------- 6. backfill fallback (no campaign start_time)
  assert.equal(sync.backfillStart("2026-08-01", "2026-09-10", "2026-09-30"), "2026-08-01", "Meta's start_time first");
  assert.equal(sync.backfillStart(null, "2026-09-10", "2026-09-30"), "2026-09-10", "else the earliest ad");
  assert.equal(sync.backfillStart(null, null, "2026-09-30"), addDays("2026-09-30", -89), "else 89 days back");
  ranges.length = 0;
  const re = await sync.syncAccount(s, accountRow("cedar"), deps);
  assert.ok(re.ok, re.error);
  assert.equal(ranges.filter((r) => r.campaign === "222")[0]?.since, "2026-09-10", "the backfill starts at the campaign's earliest ad (created 2026-09-10)");
  assert.equal(s.prepare("select min(date) from ad_metrics where account_id = ?").pluck().get(accId("cedar")), "2026-09-10");
  assert.equal(s.prepare("select start_date from meta_campaigns where id = '222'").pluck().get(), null, "the fallback is not stored as Meta's start");
  ok("Backfill fallback: a campaign with no Meta start_time backfills from the earliest created_time of its ads (else today - 89)");

  // ---------------------------------------------------------------- 2. GHL partial reads
  const client = (transport: (req: { method: string; url: string; body: string }) => Promise<{ status: number; body: string }>) =>
    new GhlClient({ identity: "fpc", envFile, transport, sleep: async () => {} });
  const many = Array.from({ length: 150 }, (_, i) => contact(`N${i}`, "2026-09-20", null));
  let pages = 0;
  const noTotal = await client(async (req) => {
    pages++;
    const after = (JSON.parse(req.body) as { searchAfter?: [number, string] }).searchAfter;
    const start = after ? many.findIndex((c) => c.id === after[1]) + 1 : 0;
    return { status: 200, body: JSON.stringify({ contacts: many.slice(start, start + 100) }) };
  }).searchLeads("acme");
  assert.deepEqual([noTotal.leads.length, noTotal.complete, pages], [150, true, 2], "no total: paging continues past a full page, the short page ends it");
  const fullNoCursor = await client(async () => ({ status: 200, body: JSON.stringify({ contacts: many.slice(0, 100).map((c) => ({ ...c, searchAfter: undefined })) }) })).searchLeads("acme");
  assert.deepEqual([fullNoCursor.leads.length, fullNoCursor.complete], [100, false], "a full page with no cursor = incomplete");
  const shortOfTotal = await client(async () => ({ status: 200, body: JSON.stringify({ contacts: many.slice(0, 5).map((c, i) => (i === 4 ? { ...c, searchAfter: undefined } : c)), total: 9 }) })).searchLeads("acme");
  assert.equal(shortOfTotal.complete, false, "total not reached = incomplete");
  const exact = await client(async () => ({ status: 200, body: JSON.stringify({ contacts: many.slice(0, 5), total: 5 }) })).searchLeads("acme");
  assert.equal(exact.complete, true, "seen >= total = complete");

  ghlContacts = [contact("G1", "2026-09-25", "SGC-acme-a-01"), contact("G2", "2026-09-26", null), contact("G3", "2026-09-27", null)];
  ghlMode = "complete";
  assert.ok((await sync.syncAccount(s, accountRow("acme"), deps)).ok);
  const stored = () => s.prepare("select contact_id from ghl_leads where account_id = ? order by contact_id").pluck().all(dom) as string[];
  assert.deepEqual(stored(), ["G1", "G2", "G3"]);
  ghlMode = "partial";
  const rp = await sync.syncAccount(s, accountRow("acme"), deps);
  assert.ok(rp.ok, rp.error);
  assert.deepEqual([rp.leadsComplete, rp.leadsKept, rp.leadsRemoved], [false, 1, 0]);
  assert.deepEqual(stored(), ["G1", "G2", "G3"], "a partial read keeps every stored lead (upsert only)");
  assert.match(s.prepare("select ghl_error from ad_accounts where id = ?").pluck().get(dom) as string, /^GHL returned a partial list \(2 contacts\): nothing removed, 1 stored leads kept\.$/);
  ghlContacts = ghlContacts.slice(0, 2);
  ghlMode = "complete";
  const rc = await sync.syncAccount(s, accountRow("acme"), deps);
  assert.deepEqual([rc.leadsComplete, rc.leadsRemoved], [true, 1]);
  assert.deepEqual(stored(), ["G1", "G2"], "a complete read still drops a contact GHL no longer returns");
  assert.equal(s.prepare("select ghl_error from ad_accounts where id = ?").pluck().get(dom), null, "the note clears on a complete read");
  ok("GHL partial reads: searchLeads reports complete (seen >= a numeric total; no total = keep paging until a short / empty page); a partial read (cap, missing cursor, total not reached) only upserts and leaves a terse note, a complete read still mirror-deletes removed contacts");

  // ---------------------------------------------------------------- 3 + 7: fatigue on the last 7 days, one anchor
  const harbor = accId("harbor");
  s.prepare("update ad_accounts set timezone = 'America/New_York', last_sync_at = ?, ghl_synced_at = ?, leads_source = 'ghl' where id = ?").run(nyNoon("2026-09-28"), nyNoon("2026-09-30"), harbor);
  const insAd = s.prepare(
    `insert into ads (meta_ad_id, account_id, name, effective_status, created_time, creative, first_spend_date, first_seen_at, last_synced_at, matched_asset_id, angle_key)
     values (@id, @account, @name, @status, @created, @creative, @first, 1, 1, @asset, @angle)`,
  );
  const creative = (o: Record<string, unknown> = {}) =>
    JSON.stringify({ headlines: [], primaries: [], descriptions: [], ctas: [], videoIds: [], imageHashes: [], isVideo: true, link: null, ...o });
  const ad = (id: string, account: number, o: { name?: string; status?: string; created?: number | null; creative?: string; asset?: number | null; angle?: string | null } = {}) =>
    insAd.run({ id, account, name: o.name ?? id, status: o.status ?? "ACTIVE", created: o.created ?? null, creative: o.creative ?? creative(), first: "2026-09-01", asset: o.asset ?? null, angle: o.angle ?? null });
  ad("f1", harbor);
  ad("f2", harbor);
  const insM = s.prepare("insert into ad_metrics (meta_ad_id, date, account_id, spend, impressions, clicks, video_3s, synced_at) values (?, ?, ?, ?, ?, ?, ?, 1)");
  for (let d = "2026-09-20"; d <= "2026-09-29"; d = addDays(d, 1)) {
    insM.run("f1", d, harbor, 10, 100, 2, 30);
    insM.run("f2", d, harbor, 5, 100, 2, 30);
  }
  const insW = s.prepare("insert into ad_windows (meta_ad_id, window, reach, impressions, frequency, synced_at) values (?, ?, ?, ?, ?, 1)");
  for (const [w, f1, f2] of [["today", 1.1, 1.0], ["7d", 3.4, 2.0], ["14d", 2.0, 3.6], ["lifetime", 2.5, 4.0]] as const) {
    insW.run("f1", w, 100, 100, f1);
    insW.run("f2", w, 100, 100, f2);
  }
  const read = (w: string) => runningData(s, { kind: "client", code: "harbor" }, parseRunningFilters({ w, status: "all" }), NOW);
  for (const w of ["today", "7d", "14d", "lifetime"]) {
    const rd = read(w);
    const f1 = rd.cards.find((c) => c.metaAdId === "f1")!;
    const f2 = rd.cards.find((c) => c.metaAdId === "f2")!;
    assert.deepEqual(f1.flags.map((f) => [f.id, f.reasons.join()]), [["fatiguing", "frequency 3.4"]], `${w}: fatiguing reads the 7 day frequency`);
    assert.deepEqual(f2.flags, [], `${w}: f2 (7 day frequency 2.0) never fatiguing, whatever the window shows`);
    assert.equal(rd.flagCounts.fatiguing, 1, `${w}: flag counts never move with the window`);
  }
  assert.equal(read("14d").cards.find((c) => c.metaAdId === "f1")!.m.frequency, 2.0, "the card still shows the window's frequency");
  ok("Fatigue: the frequency rule always reads the last 7 days (the 7d ad_windows row), so flags and flag counts are the same on Today / 7 days / 14 days / All time; the card shows the window's frequency as a number");

  // 7. One anchor: the account's last good sync (9/28) for Meta AND GHL windows, though the last lead pull was 9/30.
  const insLead = s.prepare("insert into ghl_leads (contact_id, account_id, date_added, test, ad_id, attributed_via, synced_at) values (?, ?, ?, 0, ?, 'first', 1)");
  insLead.run("T1", harbor, nyNoon("2026-09-22"), "f1");
  insLead.run("T2", harbor, nyNoon("2026-09-29"), "f1");
  s.prepare(
    `insert into channel_metrics (account_id, window, date_start, date_stop, spend, impressions, clicks, ctr, cpm, link_clicks, meta_leads, synced_at)
     values (?, '7d', '2026-09-21', '2026-09-27', 105, 1400, 28, 2, 75, 14, 0, 1)`,
  ).run(harbor);
  const r7 = read("7d");
  const c1 = r7.cards.find((c) => c.metaAdId === "f1")!;
  assert.equal(c1.m.spend, 70, "Meta: the 7 days before the sync day (9/21 to 9/27)");
  assert.equal(c1.m.leads, 1, "GHL: 9/22 to 9/28 from the same sync day (the 9/29 lead is after it)");
  assert.equal(r7.channel.windows["7d"].leads, 1, "the header counts the same leads as the cards");
  assert.equal(r7.channel.stale, "2026-09-28", "the sync day is not today: the tab says numbers stop there");
  s.prepare("update ad_accounts set last_sync_at = ? where id = ?").run(NOW, harbor);
  assert.equal(read("7d").channel.stale, null, "synced today: no note");
  s.prepare("update ad_accounts set last_sync_at = ? where id = ?").run(nyNoon("2026-09-28"), harbor);
  ok("Windows: Meta per-ad windows and GHL lead windows anchor to the same moment (the account's last good sync), header and cards agree, and a stale sync day reads \"Last synced <day>: numbers stop there\"");

  // ---------------------------------------------------------------- 4. video hooks for matched ad videos
  const fkp = s.prepare("select id from sections where key = 'fkbpros'").pluck().get() as number;
  const root = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(path.join(tmp, "gatefix-root"), fkp).lastInsertRowid);
  const insAsset = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status, duration_s, sha256, description, spoken_open, described_at)
     values (?, ?, ?, ?, ?, 'mp4', 'video', 1, 1, 1, 'done', 20, ?, ?, ?, ?)`,
  );
  const video = (name: string, described: boolean) =>
    Number(
      insAsset.run(fkp, root, path.join(tmp, "gatefix-root", name), name, name, `sha-${name}`, described ? "Opening: A tub in a small deck." : null, described ? "Still climbing over that tub?" : null, described ? 1 : null)
        .lastInsertRowid,
    );
  const vNew = video("tub.mp4", true);
  const vArchived = video("archived.mp4", true);
  const vBare = video("bare.mp4", false);
  const archivedHook = Number(
    s.prepare("insert into hooks (section_id, client_id, kind, text, norm, asset_id, source, archived_at, created_at) values (?, null, 'video', 'Old line', 'old line', ?, 'asset', 5, 1)").run(fkp, vArchived).lastInsertRowid,
  );
  ad("v1", harbor, { asset: vNew });
  ad("v2", harbor, { asset: vArchived });
  ad("v3", harbor, { asset: vBare });
  const mh = syncMetaHooks(s, { accountIds: [harbor], now: NOW });
  assert.equal(mh.videoHooksCreated, 1);
  const made = s.prepare("select id, source, archived_at, text from hooks where asset_id = ? and kind = 'video'").get(vNew) as { id: number; source: string; archived_at: number | null; text: string };
  assert.deepEqual([made.source, made.archived_at, made.text], ["asset", null, "Still climbing over that tub?"], "a described matched video with no hook gets one (addVideoHook, source asset)");
  const roleOf = (hookId: number, adId: string) => s.prepare("select role from hook_ads where hook_id = ? and meta_ad_id = ?").pluck().get(hookId, adId);
  assert.equal(roleOf(made.id, "v1"), "video", "and is linked with role video");
  assert.equal(roleOf(archivedHook, "v2"), "video", "an archived video hook is linked as is");
  assert.notEqual(s.prepare("select archived_at from hooks where id = ?").pluck().get(archivedHook), null, "and never restored");
  assert.equal(s.prepare("select count(*) from hooks where asset_id = ?").pluck().get(vBare), 0, "an undescribed video gets no hook (no link)");
  assert.equal(syncMetaHooks(s, { accountIds: [harbor], now: NOW }).videoHooksCreated, 0, "idempotent");
  ok("Video links: an ad's matched, described, visible video with no video hook gets one through addVideoHook (then scores like any hook) and is linked with role video; an archived hook is linked as is, never restored; undescribed = none");

  // ---------------------------------------------------------------- 5. test order: the file rule
  const base = { name: "x", angle: "a1", angleLabel: "a1", line: null, isVideo: true, texts: "t1", ctas: ["GET_QUOTE"], link: "sgdpros.example/x" };
  const prior = [{ ...base, id: "p", asset: "asset:7", metaMedia: "v1" }];
  const verdict = (o: Partial<import("../src/lib/meta/test-order-rules").AdFeatures>) => rules.classifyBatch([{ ...base, id: "n", asset: null, metaMedia: null, ...o }], prior);
  assert.equal(verdict({ metaMedia: "v1" }).suggested, "none", "no local file on the new ad: Meta's video id says it is the same video = a repeat");
  assert.equal(verdict({ metaMedia: "v2" }).suggested, "format", "Meta's video id differs = format");
  assert.equal(verdict({ metaMedia: "v1", texts: "t9" }).suggested, "copy", "same Meta video, new text = copy");
  assert.equal(rules.fileRelation({ asset: "asset:7", metaMedia: "v9", isVideo: true }, { asset: "asset:7", metaMedia: "v1", isVideo: true }), "same", "both matched: the local file decides");
  const unknownPrior = [{ ...base, id: "p", asset: null, metaMedia: null }];
  const unk = rules.classifyBatch([{ ...base, id: "n", asset: null, metaMedia: null }], unknownPrior);
  assert.equal(unk.suggested, "format");
  assert.match(unk.reason, /file unknown/, "unknown on both sides: the reason says so instead of assuming the same file");
  assert.match(rules.classifyBatch([{ ...base, id: "n", asset: null, metaMedia: null, texts: "t9" }], unknownPrior).reason, /file unknown/);
  // Store: only unanswered batches are recomputed.
  const dk = accId("bluebird");
  const cr = (videoIds: string[]) => creative({ videoIds, headlines: ["H"], primaries: ["P."], ctas: ["GET_QUOTE"], link: "https://sgdpros.example/bluebird" });
  ad("d1", dk, { created: nyNoon("2026-09-01"), angle: "a1", asset: vNew, creative: cr(["v1"]) });
  ad("d2", dk, { created: nyNoon("2026-09-10"), angle: "a1", creative: cr(["v1"]) });
  ad("d3", dk, { created: nyNoon("2026-09-15"), angle: "a1", creative: cr(["v1"]) });
  const insTo = s.prepare(
    `insert into test_orders (account_id, batch_date, ad_ids, n_ads, suggested, parts, detail, reason, variable, confirmed_at, found_at, updated_at)
     values (?, ?, ?, 1, 'format', '["format"]', '[]', 'old rule', ?, ?, 1, 1)`,
  );
  insTo.run(dk, "2026-09-10", JSON.stringify(["d2"]), null, null);
  insTo.run(dk, "2026-09-15", JSON.stringify(["d3"]), "format", 5);
  const st = to.syncTestOrders(s, { accountIds: [dk], now: NOW });
  const row = (d: string) => s.prepare("select suggested, reason, variable, confirmed_at from test_orders where account_id = ? and batch_date = ?").get(dk, d) as { suggested: string; reason: string; variable: string | null; confirmed_at: number | null };
  assert.equal(row("2026-09-10").suggested, "none", "unconfirmed: recomputed (same Meta video = a repeat, no longer format)");
  assert.deepEqual([row("2026-09-15").suggested, row("2026-09-15").reason, row("2026-09-15").variable, row("2026-09-15").confirmed_at], ["format", "old rule", "format", 5], "Alex's answered batch is untouched");
  assert.equal(st.changed, 1);
  ok("Test order file rule: a new ad without a local file compares Meta's own media (video id / image hash): same = repeat / copy, different = format; unknown on both sides says \"file unknown\" instead of assuming the same file; only unanswered batches are recomputed");

  // ---------------------------------------------------------------- 9. the daily slots on DST days
  // YouTube at 06:00 (YT_SYNC_HOUR), Meta + GHL at 18:00 (SYNC_HOUR, since 2026-10-06): wall-clock times.
  const EST_6AM_NOV1 = Date.UTC(2026, 10, 1, 11, 0); // 2026-11-01 06:00 EST (clocks fell back at 02:00)
  const EDT_6AM_MAR14 = Date.UTC(2027, 2, 14, 10, 0); // 2027-03-14 06:00 EDT (clocks sprang forward at 02:00)
  assert.equal(store.lastSlot(Date.UTC(2026, 10, 1, 13, 0), 6), EST_6AM_NOV1, "fall back day: 06:00 EST, not 05:00");
  assert.equal(store.lastSlot(Date.UTC(2026, 10, 1, 10, 30), 6), Date.UTC(2026, 9, 31, 10, 0), "05:30 EST: still the day before's 06:00 EDT");
  assert.equal(store.nextSlot(Date.UTC(2026, 9, 31, 16, 0), 6), EST_6AM_NOV1);
  assert.equal(store.lastSlot(Date.UTC(2027, 2, 14, 12, 0), 6), EDT_6AM_MAR14, "spring forward day: 06:00 EDT, not 07:00");
  assert.equal(store.lastSlot(Date.UTC(2027, 2, 14, 10, 30), 6), EDT_6AM_MAR14, "06:30 EDT is after the slot");
  assert.equal(store.nextSlot(Date.UTC(2027, 2, 13, 17, 0), 6), EDT_6AM_MAR14);
  assert.equal(store.nextSlot(EDT_6AM_MAR14, 6), Date.UTC(2027, 2, 15, 10, 0));
  assert.equal(store.SYNC_HOUR, 18);
  assert.equal(store.lastSlot(Date.UTC(2026, 10, 1, 23, 30)), Date.UTC(2026, 10, 1, 23, 0), "Meta, fall back day: 18:00 EST = 23:00 UTC");
  assert.equal(store.lastSlot(Date.UTC(2026, 10, 1, 22, 30)), Date.UTC(2026, 9, 31, 22, 0), "17:30 EST: the day before's 18:00 EDT");
  assert.equal(store.nextSlot(Date.UTC(2027, 2, 14, 12, 0)), Date.UTC(2027, 2, 14, 22, 0), "Meta, spring forward day: 18:00 EDT = 22:00 UTC");
  ok("Daily slots: wall-clock times in America/New_York, so the 2026-11-01 and 2027-03-14 DST days give 06:00 (YouTube) and 18:00 (Meta + GHL) local, never an hour off, for lastSlot and nextSlot");

  // ---------------------------------------------------------------- 10. Graph parameter refusal
  const before = graphReqs.length;
  const g = new MetaGraph({ identity: "fpc", envFile, transport: stubGraph, sleep: async () => {}, retryDelays: [1] });
  for (const params of [{ method: "POST" }, { Method: "delete" }, { _METHOD: "post" }, { batch: '[{"method":"POST"}]' }, { BATCH: "x" }, { access_token: "x" }, { Access_Token: "x" }]) {
    await assert.rejects(g.get("123", params), /refused|never goes in a URL/, JSON.stringify(params));
    await assert.rejects(g.getAll("123/ads", params), /refused|never goes in a URL/);
  }
  await assert.rejects(g.get("123?method=post"), /Bad Graph path/, "a query string in the path is refused");
  await assert.rejects(g.get("123%3Fmethod%3Dpost"), /Bad Graph path/);
  assert.equal(graphReqs.length, before, "nothing reached the transport");
  await assert.rejects(httpGraphTransport({ method: "GET", url: "https://graph.facebook.com/v21.0/123?Method=DELETE", headers: {}, timeoutMs: 1000 }), /refused/, "the transport refuses it too, before a socket");
  await assert.rejects(httpGraphTransport({ method: "GET", url: "https://graph.facebook.com/v21.0/?batch=%5B%5D", headers: {}, timeoutMs: 1000 }), /refused/);
  ok("Graph GETs refuse the method, _method, batch and access_token parameters in any case (params object, the path, the transport), so a GET can never tunnel a write");

  // ---------------------------------------------------------------- 11 + 12 + 13: redirects, terse error text
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const hop = (to: string) => new Response(null, { status: 302, headers: { location: to } });
  try {
    globalThis.fetch = (async (u: string | URL) => {
      const url = String(u);
      fetched.push(url);
      if (url.includes("to-evil")) return hop("https://evil.example.com/x.jpg");
      if (url.includes("to-cdn")) return hop("https://other.xx.fbcdn.net/ok.jpg");
      if (url.includes("loop")) return hop(`https://scontent.xx.fbcdn.net/loop${fetched.length}.jpg`);
      return new Response(JPEG, { status: 200 });
    }) as typeof fetch;
    await assert.rejects(httpThumbFetch("https://scontent.xx.fbcdn.net/to-evil.jpg", { maxBytes: 1000, timeoutMs: 1000 }), /off the allowed CDN/);
    assert.ok(!fetched.some((u) => u.includes("evil.example.com")), "the off-list hop is never requested");
    fetched.length = 0;
    const okHop = await httpThumbFetch("https://scontent.xx.fbcdn.net/to-cdn.jpg", { maxBytes: 1000, timeoutMs: 1000 });
    assert.deepEqual([okHop.status, okHop.bytes.length, fetched.length], [200, JPEG.length, 2], "an allowed hop is followed");
    fetched.length = 0;
    await assert.rejects(httpThumbFetch("https://scontent.xx.fbcdn.net/loop.jpg", { maxBytes: 1000, timeoutMs: 1000 }), /too many times/);
    assert.equal(fetched.length, 4, "at most 3 redirects");
  } finally {
    globalThis.fetch = realFetch;
  }
  const noToken = path.join(tmp, "gatefix-empty.env");
  fs.writeFileSync(noToken, "META_GRAPH_VERSION=v21.0\n");
  const e1 = await new MetaGraph({ identity: "fkb", envFile: noToken, transport: stubGraph }).get("1").catch((e) => e as Error);
  assert.ok(e1 instanceof MetaTokenMissingError && !e1.message.includes(tmp) && /META_FKB_ENV_FILE file/.test(e1.message), "no env file path in stored error text");
  const e2 = await new GhlClient({ identity: "fpc", envFile: noToken, transport: stubGhl }).searchLeads("acme").then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(e2 && !e2.message.includes(tmp), "GHL: no path either");
  const yt = new YouTubeApi({
    getToken: async () => "ya29.ACCESS",
    retryDelays: [0],
    scrub: (x) => x.split("ya29.ACCESS").join("<token>"),
    transport: async () => ({ status: 403, body: JSON.stringify({ error: { message: "Quota for ya29.ACCESS exceeded on project 12345", errors: [{ reason: "quotaExceeded" }] } }) }),
  });
  const e3 = (await yt.get("data", "videos", { id: "x" }).catch((e) => e)) as import("../src/lib/youtube/api").YouTubeApiError;
  assert.equal(e3.message, "YouTube 403 (quotaExceeded)", "stored text = status + Google's short reason only");
  assert.ok(e3.detail?.includes("<token>") && !e3.detail.includes("ya29.ACCESS"), "Google's message stays in memory only, scrubbed");
  ok("Thumbnail downloads follow at most 3 redirects by hand and check every hop's host before requesting it; stored error text never carries an env file path; YouTube errors store the status + Google's short reason only");

  db.sqlite.close();
}
