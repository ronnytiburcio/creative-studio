/**
 * Phase 5 slice 1 smoke checks (called by scripts/smoke.ts on its temp DB): Meta + GHL sync with STUB transports only
 * (never the network), widget math, per-ad lead credit, matching, the Running tab reads, pause / refresh / schedule,
 * token hygiene, the GET-only Graph module, and a root outside the drive. Fixture env files hold fake tokens.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { StudioConfig } from "../src/lib/config";

type Ctx = { s: Database.Database; cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const LANE_B_TOKEN = "fpcSECRETtoken0123456789abcdef";
const FKB_TOKEN = "fkbSECRETtoken9876543210fedcba";
const GHL_KEY = "ghlSECRETkey1122334455667788";

// 2026-09-30 12:00 America/New_York (EDT).
const NOW = Date.UTC(2026, 8, 30, 16, 0, 0);

type Req = { method: string; url: string; headers: Record<string, string> };

export async function runMetaSmoke({ s, cfg, tmp, ok }: Ctx) {
  const graphMod = await import("../src/lib/meta/graph");
  const ghlMod = await import("../src/lib/meta/ghl");
  const { MetaGraph, httpGraphTransport, scrub } = graphMod;
  const { GhlClient, httpGhlTransport, GHL_SEARCH_URL } = ghlMod;
  const { MetaSyncQueue } = await import("../src/worker/meta");
  const store = await import("../src/lib/meta/store");
  const { runningData, parseRunningFilters } = await import("../src/lib/meta/running");
  const { chunkRange, pickAdForName } = await import("../src/lib/meta/sync");
  const { sniffImage, thumbUrlAllowed } = await import("../src/lib/meta/thumbs");
  const { staticAdsRoots } = await import("../src/lib/db/seed");

  // ---------------------------------------------------------------- the GET-only Graph module
  const graphSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/meta/graph.ts"), "utf8");
  assert.ok(!/method:\s*"(POST|PUT|DELETE|PATCH)"/.test(graphSrc), "no write method in graph.ts");
  assert.ok(!Object.keys(graphMod).some((k) => /post|put|delete|patch|write|create|update/i.test(k)), `graph exports: ${Object.keys(graphMod)}`);
  assert.ok(!Object.getOwnPropertyNames(MetaGraph.prototype).some((k) => /post|put|delete|patch|write|create|update/i.test(k)));
  const bad = (m: string, url: string) =>
    httpGraphTransport({ method: m as "GET", url, headers: {}, timeoutMs: 1000 });
  await assert.rejects(bad("POST", "https://graph.facebook.com/v21.0/act_1/ads"), /GET requests only/);
  await assert.rejects(bad("DELETE", "https://graph.facebook.com/v21.0/123"), /GET requests only/);
  await assert.rejects(bad("GET", "https://evil.example.com/v21.0/123"), /graph\.facebook\.com/);
  await assert.rejects(
    httpGhlTransport({ method: "POST", url: "https://services.leadconnectorhq.com/contacts/", headers: {}, body: "{}", timeoutMs: 1000 }),
    /contacts search/,
  );
  await assert.rejects(
    httpGhlTransport({ method: "GET" as "POST", url: GHL_SEARCH_URL, headers: {}, body: "{}", timeoutMs: 1000 }),
    /contacts search/,
  );
  assert.equal(scrub(`x?access_token=${LANE_B_TOKEN}&a=1 Bearer ${LANE_B_TOKEN}`, null).includes(LANE_B_TOKEN), false);
  ok("Meta Graph module is GET only: no write method exported, the transport refuses POST / DELETE and other hosts before any socket; the GHL transport runs the contacts search only; scrub() removes tokens");

  // ---------------------------------------------------------------- fixtures: env files, client folders, assets
  const clientsDir = path.join(tmp, "meta-clients");
  fs.mkdirSync(clientsDir, { recursive: true });
  const fpcEnv = path.join(clientsDir, "agency.env");
  const fkbEnv = path.join(tmp, "fkb-meta.env");
  fs.writeFileSync(fpcEnv, `META_ACCESS_TOKEN=${LANE_B_TOKEN}\nMETA_GRAPH_VERSION=v21.0\nGHL_API_KEY=${GHL_KEY}\nGHL_LOCATION_ID=loc123\n`);
  fs.writeFileSync(fkbEnv, `META_ACCESS_TOKEN=${FKB_TOKEN}\nMETA_GRAPH_VERSION=v21.0\n`);
  const mk = (code: string, file: string, body: unknown) => {
    fs.mkdirSync(path.join(clientsDir, code), { recursive: true });
    fs.writeFileSync(path.join(clientsDir, code, file), JSON.stringify(body));
  };
  mk("acme", "state.json", { campaign_id: "111" });
  mk("cedar", "build_state.json", { campaign_id: "222" });
  fs.mkdirSync(path.join(clientsDir, "granite"), { recursive: true });
  fs.mkdirSync(path.join(clientsDir, "delta"), { recursive: true });
  mk("acme", "video_script_map.json", {
    schema: 2,
    ads: [
      { n: "01", creative_id: "c1", video: "SGD_ad_acme_01.mp4" },
      { n: "03", ad_name: "SGC-acme-c-03", video: "/nowhere/SGD_ad_acme_03.mp4" },
    ],
  });

  // Keep 6 accounts: acme (state.json), cedar (build_state.json), granite (name scan), delta (only campaign),
  // harbor (Meta refuses: one failing account), SGD (account level, Meta leads).
  s.prepare(
    "delete from ad_accounts where act_id in (select meta_ad_account_id from clients where code in ('bluebird','everest','fairway'))",
  ).run();
  const accId = (code: string) =>
    code === "fkb"
      ? (s.prepare("select id from ad_accounts where identity = 'fkb'").pluck().get() as number)
      : (s.prepare("select acc.id from ad_accounts acc join clients c on c.id = acc.client_id where c.code = ?").pluck().get(code) as number);
  const actOf = (code: string) =>
    code === "fkb" ? "act_100000000000009" : (s.prepare("select meta_ad_account_id from clients where code = ?").pluck().get(code) as string);
  assert.equal(s.prepare("select count(*) from ad_accounts").pluck().get(), 6);

  // Assets the matcher can find (DB rows in the fixture root; matching never opens files).
  const fkRoot = s.prepare("select r.id, r.path from roots r join sections s on s.id = r.section_id where s.key = 'fkbpros' and r.enabled = 1").get() as { id: number; path: string };
  const fkSection = s.prepare("select id from sections where key = 'fkbpros'").pluck().get() as number;
  const insAsset = (rel: string, kind = "video") =>
    Number(
      s
        .prepare(
          `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status)
           values (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'done')`,
        )
        .run(fkSection, fkRoot.id, path.join(fkRoot.path, rel), rel, path.basename(rel), path.extname(rel).slice(1), kind).lastInsertRowid,
    );
  const clientIdOf = (code: string) => s.prepare("select id from clients where code = ?").pluck().get(code) as number;
  const tag = (assetId: number, code: string) =>
    s.prepare("insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'manual', 1)").run(assetId, clientIdOf(code));
  const aDomVideo = insAsset("meta-fx/dom/SGD_ad_acme_01.mp4");
  tag(aDomVideo, "acme");
  const aEdSameName = insAsset("meta-fx/ed/SGD_ad_acme_01.mp4"); // same name, another client: the acme one wins
  tag(aEdSameName, "cedar");
  const aMediaName = insAsset("meta-fx/dom/SGD_ad_acme_05.mp4");
  const aManual = insAsset("meta-fx/dom/manual-pick.mp4");
  const rtmSection = s.prepare("select id from sections where key = 'rtm'").pluck().get() as number;

  // ---------------------------------------------------------------- the stub Graph API
  const dates = (from: string, to: string) => {
    const out: string[] = [];
    for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  };
  type Daily = { ad: string; name: string; date: string; spend: number; imp: number; clicks: number; link: number; v3: number; tp: number; lead?: number };
  const daily: Daily[] = [];
  for (const d of dates("2026-09-21", "2026-09-30")) daily.push({ ad: "1001", name: "SGC-acme-a-01", date: d, spend: 10, imp: 1000, clicks: 20, link: 10, v3: 300, tp: 100, lead: d === "2026-09-29" ? 1 : 0 });
  for (const d of dates("2026-08-01", "2026-09-20")) daily.push({ ad: "4004", name: "SGC-acme-a-01", date: d, spend: 5, imp: 500, clicks: 5, link: 2, v3: 100, tp: 20 });
  daily.push({ ad: "2002", name: "SGC-acme-b-02", date: "2026-09-25", spend: 3, imp: 200, clicks: 2, link: 1, v3: 0, tp: 0 });
  daily.push({ ad: "3003", name: "SGC-acme-c-03", date: "2026-08-02", spend: 1, imp: 100, clicks: 1, link: 0, v3: 0, tp: 0 });
  daily.push({ ad: "9009", name: "Old-archived-ad", date: "2026-08-03", spend: 2, imp: 50, clicks: 0, link: 0, v3: 0, tp: 0 });
  for (const d of dates("2026-09-28", "2026-09-30")) daily.push({ ad: "7101", name: "SGD-Spring-Garden", date: d, spend: 20, imp: 2000, clicks: 30, link: 15, v3: 500, tp: 150, lead: 1 });

  const creativeVideo = (id: string, video: string, thumb: string) => ({
    id,
    thumbnail_url: thumb,
    video_id: video,
    asset_feed_spec: { titles: [{ text: "Headline one" }, { text: "Headline two" }], bodies: [{ text: "Primary one." }], descriptions: [{ text: "Desc" }], call_to_action_types: ["LEARN_MORE"] },
  });
  const domAds = [
    { id: "1001", name: "SGC-acme-a-01", effective_status: "ACTIVE", configured_status: "ACTIVE", created_time: "2026-09-21T10:00:00+0000", adset: { id: "s1", name: "Adam-Winners" }, campaign_id: "111", creative: creativeVideo("c1", "v1", "https://scontent.xx.fbcdn.net/t1.jpg") },
    { id: "4004", name: "SGC-acme-a-01", effective_status: "PAUSED", configured_status: "PAUSED", created_time: "2026-08-01T10:00:00+0000", adset: { id: "s0", name: "Adam-Legacy" }, campaign_id: "111", creative: creativeVideo("c1", "v1", "https://scontent.xx.fbcdn.net/t1.jpg") },
    { id: "2002", name: "SGC-acme-b-02", effective_status: "PAUSED", configured_status: "PAUSED", created_time: "2026-09-20T10:00:00+0000", adset: { id: "s2", name: "Adam-Testing" }, campaign_id: "111", creative: { id: "c2", thumbnail_url: "https://scontent.xx.fbcdn.net/t2.jpg", object_story_spec: { link_data: { name: "Static head", message: "Static body", image_hash: "h2", call_to_action: { type: "GET_QUOTE" } } } } },
    { id: "3003", name: "SGC-acme-c-03", effective_status: "PAUSED", configured_status: "PAUSED", created_time: "2026-08-01T10:00:00+0000", adset: { id: "s0", name: "Adam-Legacy" }, campaign_id: "111", creative: creativeVideo("c3", "v3", "https://scontent.xx.fbcdn.net/t3.jpg") },
    { id: "5005", name: "SGC-acme-e-05", effective_status: "ACTIVE", configured_status: "ACTIVE", created_time: "2026-09-29T10:00:00+0000", adset: { id: "s2", name: "Adam-Testing" }, campaign_id: "111", creative: creativeVideo("c5", "v5", "https://scontent.xx.fbcdn.net/t5.jpg") },
    { id: "6006", name: "SGC-acme-g-06", effective_status: "ACTIVE", configured_status: "ACTIVE", created_time: "2026-09-29T10:00:00+0000", adset: { id: "s2", name: "Adam-Testing" }, campaign_id: "111", creative: creativeVideo("c6", "v6", "https://scontent.xx.fbcdn.net/html.jpg") },
  ];
  const fkbAds = [
    { id: "7101", name: "SGD-Spring-Garden", effective_status: "ACTIVE", configured_status: "ACTIVE", created_time: "2026-09-28T10:00:00+0000", adset: { id: "f1", name: "K&B ABO" }, campaign_id: "701", creative: creativeVideo("fc1", "fv1", "https://scontent.xx.fbcdn.net/f1.jpg") },
  ];
  const campaigns: Record<string, { id: string; name: string; effective_status: string; start_time: string }> = {
    "111": { id: "111", name: "Adam-NJ-Renovation", effective_status: "ACTIVE", start_time: "2026-08-01T12:00:00+0000" },
    "222": { id: "222", name: "Ben-NYC-Refinishing", effective_status: "ACTIVE", start_time: "2026-09-29T12:00:00+0000" },
    "331": { id: "331", name: "Deck Renovation Leads (their own)", effective_status: "PAUSED", start_time: "2023-05-07T12:00:00+0000" },
    "332": { id: "332", name: "SGC-Granite-Deck", effective_status: "ACTIVE", start_time: "2026-09-29T12:00:00+0000" },
    "441": { id: "441", name: "Some Campaign", effective_status: "ACTIVE", start_time: "2026-09-29T12:00:00+0000" },
    "701": { id: "701", name: "7.6.26 K&B ABO", effective_status: "ACTIVE", start_time: "2026-09-28T12:00:00+0000" },
    "702": { id: "702", name: "2.16.26 Launch", effective_status: "PAUSED", start_time: "2026-09-27T12:00:00+0000" },
  };
  const channel: Record<string, Record<string, Record<string, unknown>>> = {
    "111": {
      today: { spend: "10.00", impressions: "1000", reach: "900", clicks: "20", ctr: "2.0", cpm: "10.0", inline_link_clicks: "10", cost_per_inline_link_click: "1.0", actions: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "0" }], date_start: "2026-09-30", date_stop: "2026-09-30" },
      last_7d: { spend: "70.00", impressions: "7000", reach: "5000", clicks: "140", ctr: "2.0", cpm: "10.0", inline_link_clicks: "70", cost_per_inline_link_click: "1.0", actions: [{ action_type: "lead", value: "1" }], date_start: "2026-09-23", date_stop: "2026-09-29" },
      last_14d: { spend: "120.00", impressions: "12000", reach: "8000", clicks: "200", ctr: "1.6667", cpm: "10.0", inline_link_clicks: "100", cost_per_inline_link_click: "1.2", actions: [], date_start: "2026-09-16", date_stop: "2026-09-29" },
      maximum: { spend: "500.00", impressions: "50000", reach: "20000", clicks: "600", ctr: "1.2", cpm: "10.0", inline_link_clicks: "300", cost_per_inline_link_click: "1.6667", actions: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "3" }], date_start: "2026-08-01", date_stop: "2026-09-30" },
    },
    "222": { maximum: { spend: "40", impressions: "4000", clicks: "40", ctr: "1.0", cpm: "10", inline_link_clicks: "20", cost_per_inline_link_click: "2", date_start: "2026-09-29", date_stop: "2026-09-30" } },
  };
  const requests: Req[] = [];
  let usageHeader: string | null = null;
  let domDailySpend2909 = 10;
  const stubGraph = async (req: { method: string; url: string; headers: Record<string, string> }) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const u = new URL(req.url);
    assert.equal(u.searchParams.get("access_token"), null, "never a token in the URL");
    const auth = req.headers.Authorization ?? "";
    const p = u.pathname.replace(/^\/v\d+\.\d+\/?/, "");
    const q = Object.fromEntries(u.searchParams);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      status,
      body: JSON.stringify(body),
      header: (n: string) => headers[n.toLowerCase()] ?? (n.toLowerCase() === "x-business-use-case-usage" ? usageHeader : null),
    });
    const isFkb = auth === `Bearer ${FKB_TOKEN}`;
    if (!isFkb && auth !== `Bearer ${LANE_B_TOKEN}`) return json(401, { error: { message: "bad token", code: 190 } });
    if (p === actOf("harbor")) return json(400, { error: { message: `(#200) Permissions error for token ${LANE_B_TOKEN}`, code: 200 } });
    if (/^act_\d+$/.test(p)) return json(200, { timezone_name: isFkb ? "America/Los_Angeles" : "America/New_York", id: p });
    if (campaigns[p] && q.fields?.includes("start_time")) return json(200, campaigns[p]);
    if (p === `${actOf("granite")}/campaigns`) return json(200, { data: [campaigns["331"], campaigns["332"]] });
    if (p === `${actOf("delta")}/campaigns`) return json(200, { data: [campaigns["441"]] });
    if (p === "act_100000000000009/campaigns") return json(200, { data: [campaigns["701"], campaigns["702"]] });
    const m = /^(\d+)\/(ads|insights)$/.exec(p);
    if (m && m[2] === "ads") {
      const list = m[1] === "111" ? domAds : m[1] === "701" ? fkbAds : [];
      // Two pages for Adam; Meta's next URL switches to its newest version: the client must stay on the pinned one.
      if (m[1] === "111" && !q.after) {
        return json(200, { data: list.slice(0, 3), paging: { next: `https://graph.facebook.com/v25.0/111/ads?limit=100&after=PAGE2`, cursors: { after: "PAGE2" } } });
      }
      return json(200, { data: m[1] === "111" ? list.slice(3) : list });
    }
    if (m && m[2] === "insights") {
      const cid = m[1];
      const own = (d: Daily) => (cid === "111" ? !d.ad.startsWith("7") : cid === "701" ? d.ad.startsWith("7") : false);
      if (q.time_increment === "1") {
        const range = JSON.parse(q.time_range) as { since: string; until: string };
        const rows = daily
          .filter((d) => own(d) && d.date >= range.since && d.date <= range.until)
          .map((d) => ({
            ad_id: d.ad,
            ad_name: d.name,
            date_start: d.date,
            date_stop: d.date,
            spend: String(d.ad === "1001" && d.date === "2026-09-29" ? domDailySpend2909 : d.spend),
            impressions: String(d.imp),
            reach: String(Math.round(d.imp * 0.9)),
            frequency: "1.1",
            clicks: String(d.clicks),
            ctr: String(d.imp ? (d.clicks / d.imp) * 100 : 0),
            inline_link_clicks: String(d.link),
            actions: [
              ...(d.v3 ? [{ action_type: "video_view", value: String(d.v3) }] : []),
              ...(d.lead ? [{ action_type: "offsite_conversion.fb_pixel_lead", value: String(d.lead) }] : []),
            ],
            ...(d.tp ? { video_thruplay_watched_actions: [{ action_type: "video_view", value: String(d.tp) }] } : {}),
          }));
        return json(200, { data: rows });
      }
      if (q.level === "ad" && q.date_preset) {
        return json(200, { data: cid === "111" ? [{ ad_id: "1001", reach: "2000", impressions: "7000", frequency: q.date_preset === "last_7d" ? "3.5" : "1.2" }] : [] });
      }
      const row = channel[cid]?.[q.date_preset];
      return json(200, { data: row ? [row] : [] });
    }
    if (p === "act_100000000000009/insights" && q.level === "account") {
      const spend = { today: "20", last_7d: "40", last_14d: "40", maximum: "60" }[q.date_preset] ?? "0";
      return json(200, { data: [{ spend, impressions: "2000", clicks: "30", ctr: "1.5", cpm: "10", inline_link_clicks: "15", cost_per_inline_link_click: "1.33", actions: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "2" }], date_start: "2026-09-28", date_stop: "2026-09-30" }] });
    }
    if (p === "" && q.ids) {
      const out: Record<string, unknown> = {};
      for (const id of q.ids.split(",")) out[id] = { id, title: id === "v5" ? "SGD_ad_acme_05.mp4" : `untitled ${id}` };
      return json(200, out);
    }
    if (/^act_\d+\/adimages$/.test(p)) return json(200, { data: [{ hash: "h2", name: "no-such-file.png" }] });
    return json(404, { error: { message: `unknown path ${p}`, code: 803 } });
  };

  // ---------------------------------------------------------------- the stub GHL API
  const contact = (id: string, dateAdded: string, first: Record<string, string>, last: Record<string, string>, tags: string[] = []) => ({
    id,
    dateAdded,
    tags,
    source: "acme-fb-ad",
    firstName: "Jane",
    lastName: "Doe",
    email: `jane.${id}@example.com`,
    phone: "+15555550100",
    address1: "1 Main St",
    attributionSource: first,
    lastAttributionSource: last,
    searchAfter: [Date.parse(dateAdded), id],
  });
  const domContacts = [
    contact("L1", "2026-09-10T15:00:00.000Z", { utmContent: "SGC-acme-a-01", mediumId: "form1" }, {}),
    contact("L2", "2026-09-29T15:00:00.000Z", { utmContent: "sgc-acme-a-01 ", mediumId: "form1" }, {}),
    contact("L3", "2026-09-30T14:00:00.000Z", { sessionSource: "Other" }, { utmContent: "SGC-acme-b-02" }),
    contact("L4", "2026-09-30T13:00:00.000Z", { sessionSource: "Other" }, {}),
    contact("L5", "2026-09-30T13:30:00.000Z", { utmContent: "SGC-acme-a-01" }, {}, ["Claude-Test-Lead"]),
  ];
  const ghlRequests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  // SGD's leads (Phase 5 slice 2): the same key, source fkb-fb-ad; none today (SGD's own leads carry no ad source).
  const fkbContacts: ReturnType<typeof contact>[] = [];
  const stubGhl = async (req: { method: string; url: string; headers: Record<string, string>; body: string }) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, GHL_SEARCH_URL);
    const body = JSON.parse(req.body) as { locationId: string; filters: { value: string }[]; searchAfter?: unknown[] };
    ghlRequests.push({ url: req.url, body, headers: req.headers });
    const code = body.filters[0].value.replace(/-fb-ad$/, "");
    const list = code === "acme" ? domContacts : code === "fkb" ? fkbContacts : [];
    const page = body.searchAfter ? list.slice(3) : list.slice(0, 3);
    return { status: 200, body: JSON.stringify({ contacts: page, total: list.length }) };
  };

  // ---------------------------------------------------------------- thumbnails (stub fetch)
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const thumbCalls: string[] = [];
  const fetchThumb = async (url: string) => {
    thumbCalls.push(url);
    return url.includes("html") ? { status: 200, bytes: Buffer.from("<html>not an image</html>") } : { status: 200, bytes: JPEG };
  };

  // ---------------------------------------------------------------- the queue (stub transports, fixed clock)
  let now = NOW;
  const logLines: string[] = [];
  const calls: unknown[] = [];
  const sleeps: number[] = [];
  const graphFor = (identity: "fpc" | "fkb") =>
    new MetaGraph({
      identity,
      envFile: identity === "fkb" ? fkbEnv : fpcEnv,
      transport: stubGraph,
      onCall: (c) => calls.push(c),
      log: (...a) => logLines.push(a.join(" ")),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => now,
      retryDelays: [1, 1],
    });
  const ghlFor = (identity: "fpc" | "fkb") =>
    // As the worker wires it: one GHL key (agency.env) for both identities.
    new GhlClient({ identity, envFile: fpcEnv, transport: stubGhl, onCall: (c) => calls.push(c), sleep: async () => {} });
  const queue = new MetaSyncQueue(s, {
    graph: graphFor,
    ghl: ghlFor,
    fetchThumb,
    cacheDir: cfg.cacheDir,
    clientsDir,
    log: (...a) => logLines.push(a.map(String).join(" ")),
    isStopped: () => false,
    now: () => now,
  });

  // Nothing synced yet -> the schedule wants every account (worker start, nothing synced since the latest 18:00).
  assert.equal(queue.due()?.reason, "schedule");
  assert.equal(queue.due()?.accounts.length, 6);
  const first = (await queue.drain())!;
  assert.equal(first.size, 6);
  const acc = (code: string) =>
    s.prepare("select * from ad_accounts where id = ?").get(accId(code)) as { error: string | null; last_sync_at: number | null; campaign_source: string | null; timezone: string | null; leads_source: string | null; ghl_error: string | null };
  for (const code of ["acme", "cedar", "granite", "delta", "fkb"]) assert.ok(first.get(code)?.ok, `${code}: ${first.get(code)?.error}`);
  assert.deepEqual(
    ["acme", "cedar", "granite", "delta", "fkb"].map((c) => acc(c).campaign_source),
    ["state.json", "build_state.json", "name", "only", "account"],
  );
  assert.deepEqual(s.prepare("select id from meta_campaigns where account_id = ? order by id").pluck().all(accId("granite")), ["332"], "granite: the SGC campaign, not the client's own");
  assert.deepEqual(s.prepare("select id from meta_campaigns where account_id = ? order by id").pluck().all(accId("fkb")), ["701", "702"], "SGD: every campaign");
  ok("widget campaign selection: state.json, else build_state.json, else the name scan (the profile's campaign word or the code, the client's own campaign skipped), else the only campaign; SGD reads every campaign in its account");

  // One failing account never stops the others; its error is terse and scrubbed.
  assert.equal(first.get("harbor")?.ok, false);
  assert.match(acc("harbor").error ?? "", /Permissions error/);
  assert.ok(!(acc("harbor").error ?? "").includes(LANE_B_TOKEN), "token scrubbed from the stored error");
  assert.equal(acc("harbor").last_sync_at, null);
  assert.ok(acc("granite").last_sync_at, "the accounts after it still synced");
  ok("one failing account (Meta refused harbor) records a terse scrubbed error and never stops the others");

  // Backfill: every day since the campaign start, in 31 day chunks; ads beyond the 30 day window stay out.
  const dailyReqs = () => requests.filter((r) => r.url.includes("/111/insights") && r.url.includes("time_increment=1"));
  const ranges = dailyReqs().map((r) => JSON.parse(new URL(r.url).searchParams.get("time_range")!) as { since: string; until: string });
  assert.deepEqual(ranges, [{ since: "2026-08-01", until: "2026-08-31" }, { since: "2026-09-01", until: "2026-09-30" }]);
  assert.deepEqual(chunkRange("2026-08-01", "2026-08-01"), [{ since: "2026-08-01", until: "2026-08-01" }]);
  const rowCount = (id: string) => s.prepare("select count(*) from ad_metrics where meta_ad_id = ?").pluck().get(id) as number;
  assert.deepEqual([rowCount("1001"), rowCount("4004"), rowCount("9009")], [10, 51, 1], "every day kept, also for an archived ad");
  const adIds = s.prepare("select meta_ad_id from ads where account_id = ? order by meta_ad_id").pluck().all(accId("acme"));
  assert.deepEqual(adIds, ["1001", "2002", "4004", "5005", "6006"], "3003 (paused, last delivery 8/2) out of scope, not stored");
  assert.ok(requests.every((r) => !/\/v25\.0\//.test(r.url)), "paging stays on the pinned version");
  assert.ok(requests.some((r) => r.url.includes("/111/ads") && r.url.includes("after=PAGE2")), "second page via the after cursor");
  const a1 = s.prepare("select * from ads where meta_ad_id = '1001'").get() as { first_spend_date: string; creative: string; adset_name: string };
  assert.equal(a1.first_spend_date, "2026-09-21");
  const cr = JSON.parse(a1.creative) as { headlines: string[]; primaries: string[]; ctas: string[]; isVideo: boolean };
  assert.deepEqual([cr.headlines, cr.primaries, cr.ctas, cr.isVideo], [["Headline one", "Headline two"], ["Primary one."], ["LEARN_MORE"], true]);
  ok("first sync backfills every ad back to its campaign's first day (31 day chunks, archived ads' days kept), ads in scope = ACTIVE or delivered in the last 30 days, every headline / primary / CTA kept, paging follows the after cursor on the pinned Graph version");

  // Refresh = the last 3 days only; old days are never deleted; upserts replace a changed day.
  domDailySpend2909 = 12;
  const before = dailyReqs().length;
  store.requestMetaSync(s, now + 1);
  now += 60_000;
  assert.equal(queue.due()?.reason, "request");
  await queue.drain();
  const refreshRanges = dailyReqs().slice(before).map((r) => JSON.parse(new URL(r.url).searchParams.get("time_range")!));
  assert.deepEqual(refreshRanges, [{ since: "2026-09-28", until: "2026-09-30" }]);
  assert.equal(s.prepare("select spend from ad_metrics where meta_ad_id = '1001' and date = '2026-09-29'").pluck().get(), 12);
  assert.equal(rowCount("4004"), 51, "old days kept");
  assert.equal(store.metaRequestPending(s), false);
  ok("Refresh (request) syncs every account at once and re-reads only the last 3 days; changed days are upserted, older days kept");

  // Widget math: channel windows (Meta presets) + GHL leads (today, 7 days incl. today, lifetime; tests excluded).
  const dom = runningData(s, { kind: "client", code: "acme" }, parseRunningFilters({}), now);
  const W = dom.channel.windows;
  assert.deepEqual([W.today.spend, W.today.leads, W.today.cpl], [10, 2, 5]);
  assert.deepEqual([W["7d"].spend, W["7d"].leads], [70, 3]);
  assert.ok(Math.abs(W["7d"].cpl! - 70 / 3) < 1e-9);
  assert.deepEqual([W.lifetime.spend, W.lifetime.leads, W.lifetime.cpl], [500, 4, 125]);
  assert.deepEqual([W.lifetime.ctr, W.lifetime.cpm, W.lifetime.cplc], [1.2, 10, 1.6667], "one campaign: Meta's own ratios");
  assert.equal(dom.channel.unattributed.today, 1, "L4 has no utm_content");
  const ed = runningData(s, { kind: "client", code: "cedar" }, parseRunningFilters({}), now).channel.windows;
  assert.deepEqual([ed.lifetime.spend, ed.lifetime.leads, ed.lifetime.cpl], [40, 0, null], "0 GHL leads: CPL null");
  assert.equal(ed.today.delivered, false, "no delivery today");
  ok("widget math: spend from Meta's campaign presets, GHL leads bucketed today / 7 days incl. today / lifetime with test tags excluded, CPL = spend / GHL leads (null on 0), unattributed leads counted for the client total");

  // Per-ad lead credit: first touch (case / spacing tolerant), else last touch, else client total only; duplicate
  // ad names go to the ad that spent that day.
  const credit = Object.fromEntries(
    (s.prepare("select contact_id, ad_id, attributed_via, test from ghl_leads order by contact_id").all() as { contact_id: string; ad_id: string | null; attributed_via: string | null; test: number }[]).map((r) => [
      r.contact_id,
      [r.ad_id, r.attributed_via, r.test],
    ]),
  );
  assert.deepEqual(credit, {
    L1: ["4004", "first", 0],
    L2: ["1001", "first", 0],
    L3: ["2002", "last", 0],
    L4: [null, null, 0],
    L5: ["1001", "first", 1],
  });
  const spendOn = () => 0;
  const named = [{ metaAdId: "x1", name: "Ad-05", createdTime: 1 }, { metaAdId: "x2", name: "Other", createdTime: 2 }];
  assert.equal(pickAdForName("Ad-05-Copy", named, 5, spendOn), "x1", "Meta's Copy suffix is a last resort");
  assert.equal(pickAdForName("Nope", named, 5, spendOn), null);
  const dump = JSON.stringify(s.prepare("select * from ghl_leads").all());
  for (const pii of ["Jane", "Doe", "example.com", "5555550100", "Main St"]) assert.ok(!dump.includes(pii), `no contact detail stored: ${pii}`);
  assert.equal(ghlRequests.length >= 2 && ghlRequests[1].body.searchAfter != null, true, "paged with searchAfter");
  assert.equal(ghlRequests[0].headers.Version, "2021-07-28");
  assert.ok(/\S+\/\S+/.test(ghlRequests[0].headers["User-Agent"]), "a real User-Agent");
  ok("per-ad lead credit: GHL first-touch utm_content (exact, then case / spacing, then without Copy), else last touch, else the client total; a shared ad name goes to the ad with spend that day; no names, phones or emails stored; searchAfter paging with the widget's headers");

  // Cards: the 7 day window, hook / hold rate, frequency, days running, zero impressions / zero 3 s views.
  const card = (id: string, f = {}) => runningData(s, { kind: "client", code: "acme" }, parseRunningFilters(f), now).cards.find((c) => c.metaAdId === id);
  const c1 = card("1001")!;
  assert.deepEqual([c1.m.spend, c1.m.impressions, c1.m.leads, c1.m.metaLeads], [72, 7000, 1, 1], "7 days = the 7 days before today (9/23 to 9/29)");
  assert.deepEqual([c1.m.ctr, c1.m.cpl, c1.m.hookRate, c1.m.frequency, c1.daysRunning], [2, 72, 30, 3.5, 10]);
  assert.ok(Math.abs(c1.m.holdRate! - 100 / 3) < 1e-9);
  const c5 = card("5005")!;
  assert.deepEqual([c5.m.spend, c5.m.impressions, c5.m.ctr, c5.m.cpm, c5.m.hookRate, c5.m.holdRate, c5.m.cpl, c5.daysRunning], [0, 0, null, null, null, null, null, null]);
  const c2 = card("2002", { status: "paused", w: "lifetime" })!;
  assert.deepEqual([c2.active, c2.isVideo, c2.m.hookRate, c2.m.holdRate, c2.m.leads, c2.m.cpl], [false, false, null, null, 1, 3]);
  const counts = runningData(s, { kind: "client", code: "acme" }, parseRunningFilters({ status: "all" }), now).counts;
  assert.deepEqual(counts, { active: 3, paused: 2, all: 5 });
  const bySpend = runningData(s, { kind: "client", code: "acme" }, parseRunningFilters({ status: "all", w: "lifetime" }), now).cards.map((c) => c.metaAdId);
  assert.equal(bySpend[0], "4004", "sorted by spend");
  const byCpl = runningData(s, { kind: "client", code: "acme" }, parseRunningFilters({ status: "all", w: "lifetime", sort: "cpl" }), now).cards.map((c) => c.metaAdId);
  assert.deepEqual(byCpl.slice(0, 1), ["2002"], "lowest CPL first, no leads last");
  ok("Running cards: one window at a time (7 days default), GHL leads per ad + Meta's count, CPL / CTR / CPM / hook rate (video) / hold rate / frequency (Meta's window value) / days running; zero impressions and zero 3 s views give dashes, never a division by zero; Active / Paused / All counts; sort by spend or CPL");

  // Matching: the map by creative id (the client's own copy of a shared file name wins), the Meta media name, else none;
  // thumbnails cached once for unmatched ads, refused when not an image; manual link kept across syncs, Unlink rematches.
  const match = (id: string) => s.prepare("select matched_asset_id, match_source, thumb_path, thumb_error, media_name from ads where meta_ad_id = ?").get(id) as {
    matched_asset_id: number | null;
    match_source: string | null;
    thumb_path: string | null;
    thumb_error: string | null;
    media_name: string | null;
  };
  assert.deepEqual([match("1001").matched_asset_id, match("1001").match_source], [aDomVideo, "map"]);
  assert.deepEqual([match("4004").matched_asset_id, match("4004").match_source], [aDomVideo, "map"], "the paused original shares the creative");
  assert.deepEqual([match("5005").matched_asset_id, match("5005").match_source, match("5005").media_name], [aMediaName, "name", "SGD_ad_acme_05.mp4"]);
  assert.deepEqual([match("2002").matched_asset_id, match("2002").media_name], [null, "no-such-file.png"]);
  assert.ok(match("2002").thumb_path?.startsWith("meta/2002.jpg"));
  assert.ok(fs.existsSync(path.join(cfg.cacheDir, match("2002").thumb_path!)));
  assert.deepEqual([match("6006").thumb_path, match("6006").thumb_error], [null, "thumbnail is not an image"]);
  assert.ok(!thumbCalls.some((u) => u.includes("t1.jpg")), "matched ads get no Meta thumbnail");
  const thumbsBefore = thumbCalls.filter((u) => u.includes("t2.jpg")).length;
  assert.equal(thumbsBefore, 1, "downloaded once (the refresh did not fetch it again)");
  assert.deepEqual([sniffImage(JPEG), sniffImage(Buffer.from("GIF89a....")), sniffImage(Buffer.from("<html>"))], ["jpg", "gif", null]);
  assert.deepEqual([thumbUrlAllowed("https://scontent.xx.fbcdn.net/a.jpg"), thumbUrlAllowed("http://scontent.xx.fbcdn.net/a.jpg"), thumbUrlAllowed("https://evil.com/a.jpg")], [true, false, false]);

  // Link a file (manual), validated; kept across syncs; Unlink goes back to the automatic match.
  const ad2 = s.prepare("select id from ads where meta_ad_id = '2002'").pluck().get() as number;
  const ad1 = s.prepare("select id from ads where meta_ad_id = '1001'").pluck().get() as number;
  const rtmAsset = Number(
    s
      .prepare(`insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status) values (?, ?, ?, ?, ?, 'mp4', 'video', 1, 1, 1, 'done')`)
      .run(rtmSection, fkRoot.id, path.join(fkRoot.path, "meta-fx/rtm.mp4"), "meta-fx/rtm.mp4", "rtm.mp4").lastInsertRowid,
  );
  assert.throws(() => store.linkAd(s, ad2, rtmAsset), /this channel's Library/);
  assert.throws(() => store.linkAd(s, ad2, 999_999), /not in the Library/);
  store.linkAd(s, ad2, aManual);
  store.linkAd(s, ad1, aManual);
  store.requestMetaSync(s, now + 1);
  now += 60_000;
  await queue.drain();
  assert.deepEqual([match("2002").matched_asset_id, match("2002").match_source], [aManual, "manual"], "manual link survives a sync");
  assert.deepEqual([match("1001").matched_asset_id, match("1001").match_source], [aManual, "manual"], "a manual link beats the map");
  assert.deepEqual(store.unlinkAd(s, ad1, clientsDir), { rematched: true });
  assert.deepEqual([match("1001").matched_asset_id, match("1001").match_source], [aDomVideo, "map"], "Unlink: back to the map");
  assert.throws(() => store.unlinkAd(s, ad1, clientsDir), /Only a file you linked/);
  // Older maps (no ids, no names): the ad's number; universal ads: the drive's registry; Meta's suffixed image names.
  const matchMod = await import("../src/lib/meta/match");
  assert.deepEqual(
    ["SGC-Coral-SouthJersey-KB-Ad-06", "Adam-NJ-Renovation-Ad-13-P", "SGC-delta-darktowhite_garden-ps-11", "SGC-Coral-Renovation-Universal-fkb_sizzle_01", "Ben-NYC-Refinishing"].map((n) =>
      matchMod.adNumber(n, "delta"),
    ),
    [6, 13, 11, null, null],
  );
  const regFile = path.join(tmp, "SHARED-ADS.json");
  fs.writeFileSync(regFile, JSON.stringify({ ads: [{ id: "fkb_sizzle_01", video: "renders/SGD Pros (Universal)/fkb_sizzle_01_trust_sizzle.mp4" }] }));
  const rows = [...matchMod.loadScriptMap(clientsDir, "nobody"), { adId: null, creativeId: null, videoId: null, adName: null, n: 6, file: "SGD_ad_delta_06.mp4" }, ...matchMod.loadUniversalRegistry(regFile)];
  const hitOf = (name: string) => matchMod.mapRowFor(rows, { metaAdId: "x", name, creative: null }, "delta");
  assert.deepEqual([hitOf("SGC-Coral-SouthJersey-KB-Ad-06")?.by, hitOf("SGC-Coral-SouthJersey-KB-Ad-06")?.row.file], ["ad number", "SGD_ad_delta_06.mp4"]);
  assert.deepEqual([hitOf("SGC-Coral-Renovation-Universal-fkb_sizzle_01")?.by, path.basename(hitOf("SGC-Coral-Renovation-Universal-fkb_sizzle_01")!.row.file!)], ["universal registry", "fkb_sizzle_01_trust_sizzle.mp4"]);
  assert.equal(hitOf("SGC-Coral-Renovation-Universal-fkb_sizzle_09"), null, "a universal id not in the registry never falls to the number");
  const aStatic = insAsset("meta-fx/dom/acme-static-walkthrough.png", "image");
  const prefs = { clientId: clientIdOf("acme"), sectionId: fkSection };
  assert.equal(matchMod.assetForMediaName(s, "SGC-acme-18-acme-static-walkthrough.png_105", prefs), aStatic);
  assert.equal(matchMod.assetForMediaName(s, "SGD_ad_acme_05", prefs), aMediaName, "no extension: the stem");
  assert.equal(matchMod.assetForMediaName(s, "acme ad 09", prefs), null, "a descriptive title matches nothing");
  ok("matching: video_script_map.json (ad id, creative id, video id, ad name, the ad number for older maps; the client's own file first), universal ads via the drive's registry, then the Meta media name (stem, Meta's suffixed image names); unmatched ads get their Meta thumbnail cached once (non-images refused); Link a file stays manual across syncs and beats the map; Unlink rematches; links only to visible files in the ad's section");

  // SGD: every campaign, account-level numbers, Meta leads (no GHL key in its env file).
  const fkb = runningData(s, { kind: "fkb" }, parseRunningFilters({}), now);
  assert.equal(acc("fkb").leads_source, "meta");
  assert.equal(acc("fkb").timezone, "America/Los_Angeles");
  assert.deepEqual([fkb.channel.leadsSource, fkb.channel.windows.today.spend, fkb.channel.windows.today.leads, fkb.channel.windows.today.cpl], ["meta", 20, 2, 10]);
  assert.deepEqual(fkb.cards.map((c) => [c.metaAdId, c.leadsSource, c.m.leads]), [["7101", "meta", 2]], "7 days (9/23 to 9/29, LA time) holds 9/28 and 9/29");
  assert.ok(requests.some((r) => r.headers.Authorization === `Bearer ${FKB_TOKEN}` && r.url.includes("act_100000000000009")), "SGD read with its own token");
  assert.ok(!requests.some((r) => r.headers.Authorization === `Bearer ${FKB_TOKEN}` && r.url.includes(actOf("acme"))), "and only its own account");
  const all = runningData(s, { kind: "fkbpros" }, parseRunningFilters({}), now);
  assert.deepEqual(all.clientRows!.map((r) => r.code), ["acme", "cedar", "delta", "granite", "harbor", "fkb"]);
  assert.equal(all.clientRows!.at(-1)!.comparison, true);
  assert.ok(all.cards.some((c) => c.client?.code === "acme"));
  ok("SGD: its own token and account, every campaign, account-level widget numbers with Meta leads while GHL has no fkb-fb-ad contact; All SGD Pros = every client's ads + one summary row per client + SGD as the comparison row");

  // Slice 2: SGD's lead source switch. The agency.env key searches source fkb-fb-ad; none -> Meta leads; the first non-test
  // contact with it -> GHL leads (credited per ad by utm_content like the clients); a test contact alone never switches.
  assert.ok(ghlRequests.some((r) => (r.body.filters as { value: string }[])[0].value === "fkb-fb-ad"), "SGD's search runs with the same key");
  const { leadsSourceFor } = await import("../src/lib/meta/sync");
  // Creative Studio 1b: the rule is the account owner's leads_mode (Lane C's account = `auto`, the clients = `ghl`).
  assert.deepEqual([leadsSourceFor("auto", 0), leadsSourceFor("auto", 1), leadsSourceFor("ghl", 0), leadsSourceFor("meta", 5)], ["meta", "ghl", "ghl", "meta"]);
  const refreshAll = async () => {
    now += 1000;
    store.requestMetaSync(s, now);
    await queue.drain();
  };
  fkbContacts.push(contact("F0", "2026-09-29T15:00:00.000Z", { utmContent: "SGD-Spring-Garden" }, {}, ["test record"]));
  await refreshAll();
  assert.equal(acc("fkb").leads_source, "meta", "a test contact alone does not switch");
  fkbContacts.push(contact("F1", "2026-09-29T16:00:00.000Z", { utmContent: "SGD-Spring-Garden" }, {}));
  await refreshAll();
  assert.equal(acc("fkb").leads_source, "ghl");
  const fkbGhl = runningData(s, { kind: "fkb" }, parseRunningFilters({}), now);
  assert.deepEqual([fkbGhl.channel.leadsSource, fkbGhl.cards[0].leadsSource, fkbGhl.cards[0].m.leads, fkbGhl.cards[0].m.metaLeads], ["ghl", "ghl", 1, 2]);
  fkbContacts.length = 0;
  await refreshAll();
  assert.equal(acc("fkb").leads_source, "meta", "back to Meta leads when GHL has none");
  ok("SGD leads: the agency.env GHL key with source fkb-fb-ad; Meta leads while no (non-test) contact carries it, GHL leads (per-ad credit) as soon as one does, by itself");

  // Schedule + pause: nothing due again until 18:00; then it is; paused holds it, a Refresh still runs.
  assert.equal(queue.due(), null, "synced today: nothing due (the failed account waits an hour)");
  now += 61 * 60_000;
  assert.deepEqual(queue.due()?.accounts.map((a) => a.code), ["harbor"], "a failed account is retried hourly by the schedule");
  await queue.drain();
  now = Date.UTC(2026, 8, 30, 21, 59); // 2026-09-30 17:59 EDT
  assert.deepEqual(queue.due()?.accounts.map((a) => a.code), ["harbor"], "17:59: only the failed account's hourly retry, the synced ones wait for 18:00");
  now = Date.UTC(2026, 9, 1, 10, 30); // 2026-10-01 06:30 EDT (the 2026-09-30 18:00 slot passed)
  assert.equal(queue.due()?.accounts.length, 6, "the next 18:00 makes every account due");
  store.setMetaPaused(s, true);
  assert.equal(queue.due(), null, "paused: the daily run waits");
  store.requestMetaSync(s, now);
  assert.equal(queue.due()?.reason, "request", "Refresh runs while paused");
  await queue.drain();
  assert.equal(queue.due(), null);
  store.setMetaPaused(s, false);
  assert.equal(store.lastSlot(Date.UTC(2026, 9, 1, 21, 59)), Date.UTC(2026, 8, 30, 22, 0), "before 18:00 EDT: yesterday's slot");
  assert.equal(store.lastSlot(Date.UTC(2026, 9, 1, 22, 0)), Date.UTC(2026, 9, 1, 22, 0), "18:00 EDT: today's slot");
  assert.equal(store.nextSlot(NOW), Date.UTC(2026, 8, 30, 22, 0), "noon: today's 18:00 is next");
  ok("schedule: 18:00 America/New_York once a day per account (also at start when older), failed accounts retried hourly; Pause holds the daily run, Refresh runs anyway");

  // Usage headers: high usage cools down before the next call; a long regain time throws so the queue waits.
  const g = graphFor("fpc");
  usageHeader = JSON.stringify({ x: [{ call_count: 80, total_cputime: 5, total_time: 5, estimated_time_to_regain_access: 0 }] });
  sleeps.length = 0;
  await g.get(actOf("acme"), { fields: "timezone_name" });
  await g.get(actOf("acme"), { fields: "timezone_name" });
  assert.ok(sleeps.some((ms) => ms > 9_000 && ms <= 10_000), `cooled down: ${sleeps}`);
  usageHeader = JSON.stringify({ x: [{ call_count: 100, estimated_time_to_regain_access: 30 }] });
  await g.get(actOf("acme"), { fields: "timezone_name" });
  await assert.rejects(g.get(actOf("acme"), { fields: "timezone_name" }), (e: Error) => e.name === "MetaThrottledError");
  usageHeader = null;
  ok("Meta usage headers: >= 75% cools down before the next call, a regain time past 5 minutes throws MetaThrottledError (the queue waits)");

  // Token / key hygiene: never in any table, log line, call log path or error; always in the Authorization header.
  const tables = ["ad_accounts", "meta_campaigns", "ads", "ad_metrics", "ad_windows", "channel_metrics", "ghl_leads", "meta_calls", "app_settings", "worker_status"];
  const everything = tables.map((t) => JSON.stringify(s.prepare(`select * from ${t}`).all())).join("\n") + logLines.join("\n") + JSON.stringify(calls);
  for (const secret of [LANE_B_TOKEN, FKB_TOKEN, GHL_KEY, "loc123"]) assert.ok(!everything.includes(secret), `secret leaked: ${secret.slice(0, 6)}`);
  assert.ok(requests.every((r) => r.method === "GET" && r.headers.Authorization?.startsWith("Bearer ")));
  assert.ok((calls as { path: string }[]).every((c) => !c.path.includes("?") && !c.path.includes("token")));
  ok("tokens and the GHL key never reach the DB, the call log, log lines or errors: only the Authorization header (every Graph request a GET)");

  // A root outside the drive: scanned while the drive is unplugged, and a file removed there is marked missing.
  const { Engine } = await import("../src/worker/engine");
  const offRoot = path.join(tmp, "Downloads", "Client", "Static Ads");
  fs.mkdirSync(path.join(offRoot, "2026-09-27-testing-static"), { recursive: true });
  const pngSrc = s.prepare("select path from assets where filename = 'dom.png'").pluck().get() as string | undefined;
  const png = path.join(offRoot, "2026-09-27-testing-static", "coral-static.png");
  if (pngSrc && fs.existsSync(pngSrc)) fs.copyFileSync(pngSrc, png);
  else fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a1c30000000049454e44ae426082", "hex"));
  s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)").run(offRoot, fkSection, Date.now());
  s.prepare("insert into tag_rules (path_glob, client_codes, created_at) values (?, ?, ?)").run(`${offRoot}/**`, JSON.stringify(["delta"]), Date.now());
  const engine = new Engine({ cfg, db: { sqlite: s } as never, concurrency: 1, log: () => {} });
  assert.equal(engine.driveMounted, false, "the stand-in drive is not mounted");
  assert.ok(engine.accessibleRoots().some((r) => r.path === offRoot), "an off-drive root is accessible while the drive is unplugged");
  await engine.scanAll();
  const off = s.prepare("select id, missing from assets where path = ?").get(png) as { id: number; missing: number };
  assert.ok(off && off.missing === 0, "indexed");
  assert.deepEqual(s.prepare("select c.code from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ?").pluck().all(off.id), ["delta"]);
  fs.rmSync(png);
  (engine as unknown as { handleGone: (p: string, dir: boolean) => void }).handleGone(png, false);
  assert.equal(s.prepare("select missing from assets where id = ?").pluck().get(off.id), 1, "gone while the drive is unplugged: still marked missing");
  s.prepare("update roots set enabled = 0 where path = ?").run(offRoot);

  // Seed v7 adds every client's Static Ads folder that exists as a root + tag rule (nothing else).
  const fpcDir = path.join(tmp, "seed7-clients");
  fs.mkdirSync(path.join(fpcDir, "Ben", "Static Ads"), { recursive: true });
  fs.mkdirSync(path.join(fpcDir, "Hana"), { recursive: true });
  // Creative Studio 1b: the folder per client is `clients.folder` (seeded from the Studio config), not a constant.
  assert.deepEqual(staticAdsRoots(s, fpcDir).map((r) => [path.basename(path.dirname(r.path)), r.code]), [["Ben", "cedar"]]);
  ok("roots outside the drive: scanned, tagged and marked missing while the drive is unplugged (never 'unmounted'); seed v7 turns each existing client Static Ads folder into a root + tag rule");
}
