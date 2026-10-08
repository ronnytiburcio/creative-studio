/**
 * Phase 5 slice 4 smoke checks (called by scripts/smoke.ts last): YouTube OAuth (state, PKCE, callback through the proxy,
 * token file 0600, refresh, revoked), the daily Shorts sync (Shorts rule, analytics batching, refused metrics, single
 * mode fallback, snapshots), matching + video hooks, the NSM Shorts reads, NSM calibration and the distinct-ad-groups
 * cells. A FRESH temp DB, a fake client secret and stub OAuth / Data / Analytics / thumbnail transports only: never the
 * network, never the real client secret or token.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

// 2026-09-30 12:00 America/New_York (EDT).
const NOW = Date.UTC(2026, 8, 30, 16, 0, 0);
const ACCESS = "ya29.FAKE-ACCESS-TOKEN-abcdefghijklmnop";
const ACCESS2 = "ya29.FAKE-ACCESS-TOKEN-refreshed-qrstuv";
const REFRESH = "1//FAKE-REFRESH-TOKEN-zyxwvutsrqponm";
const CLIENT_SECRET = "GOCSPX-FAKE-CLIENT-SECRET-123456";
const SCOPES = "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly";

export async function runYouTubeSmoke({ cfg: baseCfg, tmp, ok }: Ctx) {
  const { openDb } = await import("../src/lib/db");
  const auth = await import("../src/lib/youtube/auth");
  const api = await import("../src/lib/youtube/api");
  const an = await import("../src/lib/youtube/analytics");
  const ytStore = await import("../src/lib/youtube/store");
  const match = await import("../src/lib/youtube/match");
  const { YouTubeSyncQueue } = await import("../src/worker/youtube");
  const stats = await import("../src/lib/calibration/stats");
  const report = await import("../src/lib/calibration/report");
  const { ytThumbAllowed } = await import("../src/lib/youtube/sync");

  const dir = path.join(tmp, "yt");
  fs.mkdirSync(dir, { recursive: true });
  const cfg: StudioConfig = { ...baseCfg, youtubeClientSecretFile: path.join(dir, "client_secret.json"), youtubeTokenFile: path.join(dir, "studio", "youtube-token.json") };
  assert.ok(!cfg.youtubeClientSecretFile.includes(".claude"), "never the real skill folder");

  // ---------------------------------------------------------------- config guard + key status
  const { resetConfigCache, getConfig } = await import("../src/lib/config");
  const savedEnv = { ...process.env };
  process.env.YOUTUBE_CLIENT_SECRET_FILE = path.join(dir, "skill", "client_secret.json");
  process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "skill", "token.json");
  resetConfigCache();
  assert.throws(() => getConfig(), /must not be a token\.json/, "Studio's token never points at the skill's upload token");
  for (const k of ["YOUTUBE_CLIENT_SECRET_FILE", "YOUTUBE_TOKEN_FILE"] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetConfigCache();
  getConfig();
  assert.deepEqual(auth.youtubeKeyStatus(cfg), { clientSecret: false, connected: false, scopesOk: false, privateFile: false });
  fs.writeFileSync(
    cfg.youtubeClientSecretFile,
    JSON.stringify({ installed: { client_id: "123-fake.apps.googleusercontent.com", client_secret: CLIENT_SECRET, auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"] } }),
    { mode: 0o600 },
  );
  assert.equal(auth.youtubeKeyStatus(cfg).clientSecret, true);
  ok("YouTube config: Studio's token path can never be the skill's token.json; key status is booleans only (client file, connected, scopes, private file)");

  const db = openDb(path.join(tmp, "youtube.db"), { drivePath: baseCfg.drivePath, clientDocsDir: baseCfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;

  // ---------------------------------------------------------------- connect: state + PKCE
  const { url } = auth.startConnect(s, cfg, NOW);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/auth");
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.scope, SCOPES, "exactly the two read-only scopes");
  assert.deepEqual([q.access_type, q.prompt, q.response_type, q.code_challenge_method], ["offline", "consent", "code", "S256"]);
  assert.equal(q.redirect_uri, `http://127.0.0.1:${cfg.port}/`, "loopback redirect on the configured port");
  assert.ok(!url.includes(CLIENT_SECRET), "the client secret never goes in the consent URL");
  const state = q.state;
  const row = s.prepare("select * from yt_oauth_states").get() as { state_hash: string; verifier: string; expires_at: number };
  assert.notEqual(row.state_hash, state, "only a hash of the state is stored");
  assert.equal(row.state_hash, crypto.createHash("sha256").update(state).digest("hex"));
  assert.equal(q.code_challenge, crypto.createHash("sha256").update(row.verifier).digest("base64url"), "S256 challenge of the stored verifier");
  assert.equal(row.expires_at, NOW + 10 * 60_000);
  assert.equal(auth.consumeState(s, "not-the-state-xxxxxxxxxxxxxxxx", NOW), null, "an unknown state is refused");
  assert.equal(auth.consumeState(s, state, NOW + 1000), row.verifier, "the issued state returns its verifier once");
  assert.equal(auth.consumeState(s, state, NOW + 2000), null, "single use: the second try is refused");
  const late = new URL(auth.startConnect(s, cfg, NOW).url).searchParams.get("state")!;
  assert.equal(auth.consumeState(s, late, NOW + 10 * 60_000 + 1), null, "expired after 10 minutes");
  assert.equal(s.prepare("select count(*) from yt_oauth_states").pluck().get(), 0, "used and expired states are deleted");
  const noSecret = { ...cfg, youtubeClientSecretFile: path.join(dir, "missing.json") };
  assert.throws(() => auth.startConnect(s, noSecret, NOW), /not a Desktop client/);
  ok("Connect YouTube: one-time state (sha256 stored) + PKCE S256 verifier, 10 minute expiry, single use, unknown / expired / reused refused; Google URL with exactly the two read-only scopes, offline + consent, loopback redirect, no secret");

  // ---------------------------------------------------------------- callback through the proxy + the route (no network)
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../src/proxy");
  const nav = { host: "127.0.0.1:4747", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  const cb = "http://127.0.0.1:4747/api/youtube/callback?state=abc&code=xyz";
  const pass = (r: Response) => r.status !== 403;
  assert.ok(pass(proxy(new NextRequest(cb, { headers: nav }))), "Google's redirect (cross-site top-level GET navigation) passes the proxy");
  assert.ok(pass(proxy(new NextRequest("http://127.0.0.1:4747/?state=abc&code=xyz", { headers: nav }))), "the loopback landing (/) passes too");
  assert.equal(proxy(new NextRequest(cb, { headers: { ...nav, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status, 403, "a cross-site fetch is refused");
  assert.equal(proxy(new NextRequest(cb, { method: "POST", headers: { ...nav, origin: "https://accounts.google.com" } })).status, 403, "other methods are refused");
  assert.equal(proxy(new NextRequest("http://evil.example/api/youtube/callback?state=a&code=b", { headers: { ...nav, host: "evil.example" } })).status, 403, "other hosts are refused");
  const route = await import("../src/app/api/youtube/callback/route");
  const loc = async (qs: string) => {
    const r = await route.GET(new Request(`http://127.0.0.1:4747/api/youtube/callback?${qs}`));
    return [r.status, new URL(r.headers.get("location")!).search];
  };
  assert.deepEqual(await loc("state=AAAAAAAAAAAAAAAAAAAAAAAA&code=4/0abc"), [303, "?youtube=expired"], "a state this server never issued: expired, no exchange");
  assert.deepEqual(await loc("error=access_denied&state=AAAAAAAAAAAAAAAAAAAAAAAA"), [303, "?youtube=denied"]);
  assert.deepEqual(await loc("code=only"), [303, "?youtube=failed"], "zod: a code without a state fails");
  assert.ok(!fs.existsSync(cfg.youtubeTokenFile) && !fs.existsSync(getConfig().youtubeTokenFile), "nothing stored");
  ok("Callback: Google's cross-site GET navigation passes src/proxy.ts (also on the / landing), a cross-site fetch / POST / foreign host get 403; the route refuses unknown states, maps denied / bad queries to fixed result words, never exchanges without its own state");

  // ---------------------------------------------------------------- code exchange + token file (stub transport)
  const oauthReqs: { url: string; body: URLSearchParams }[] = [];
  let refreshMode: "ok" | "revoked" = "ok";
  const oauth: import("../src/lib/youtube/auth").OAuthTransport = async (req) => {
    const body = new URLSearchParams(req.body);
    oauthReqs.push({ url: req.url, body });
    if (req.url.endsWith("/revoke")) return { status: 200, body: "{}" };
    if (body.get("grant_type") === "authorization_code") {
      const scope = body.get("code") === "narrow" ? "https://www.googleapis.com/auth/youtube.readonly" : SCOPES;
      return { status: 200, body: JSON.stringify({ access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope, token_type: "Bearer" }) };
    }
    if (refreshMode === "revoked") return { status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: `Token has been expired or revoked. ${REFRESH}` }) };
    return { status: 200, body: JSON.stringify({ access_token: ACCESS2, expires_in: 3599, scope: SCOPES, token_type: "Bearer" }) };
  };
  const narrow = await auth.exchangeCode(cfg, "narrow", "v".repeat(64), oauth, NOW);
  assert.deepEqual(narrow, { ok: false, reason: "scopes" }, "one scope unticked: refused");
  assert.ok(oauthReqs.at(-1)!.url.endsWith("/revoke") && !oauthReqs.at(-1)!.url.includes(REFRESH), "that grant is revoked (token in the POST body, not the URL)");
  assert.ok(!fs.existsSync(cfg.youtubeTokenFile), "and nothing is stored");
  const calls: string[] = [];
  const ex = await auth.exchangeCode(cfg, "4/0good", "verifier-verifier-verifier-verifier-verifier", oauth, NOW, (c) => calls.push(JSON.stringify(c)));
  assert.deepEqual(ex, { ok: true });
  const exReq = oauthReqs.find((r) => r.body.get("code") === "4/0good")!;
  assert.equal(exReq.url, "https://oauth2.googleapis.com/token");
  assert.deepEqual([exReq.body.get("grant_type"), exReq.body.get("code_verifier"), exReq.body.get("redirect_uri")], ["authorization_code", "verifier-verifier-verifier-verifier-verifier", `http://127.0.0.1:${cfg.port}/`]);
  const mode = fs.statSync(cfg.youtubeTokenFile).mode & 0o777;
  assert.equal(mode, 0o600, "token file 0600");
  assert.equal(fs.statSync(path.dirname(cfg.youtubeTokenFile)).mode & 0o777, 0o700, "its folder 0700");
  assert.deepEqual(auth.youtubeKeyStatus(cfg), { clientSecret: true, connected: true, scopesOk: true, privateFile: true });
  assert.ok(calls.every((c) => !c.includes(ACCESS) && !c.includes(REFRESH) && !c.includes("4/0good")), "call log: path + status only");
  await assert.rejects(() => auth.httpOAuthTransport({ url: "https://evil.example/token", body: "", timeoutMs: 10 }), /only posts to oauth2\.googleapis\.com/);
  await assert.rejects(() => api.httpYtTransport({ method: "POST" as "GET", url: "https://www.googleapis.com/youtube/v3/channels", headers: {}, timeoutMs: 10 }), /GET requests only/);
  await assert.rejects(() => api.httpYtTransport({ method: "GET", url: "https://evil.example/youtube/v3/channels", headers: {}, timeoutMs: 10 }), /only calls the YouTube Data and Analytics APIs/);
  ok("Code exchange (stub): code + PKCE verifier + loopback redirect to oauth2.googleapis.com, token file written 0600 in a 0700 folder, a grant missing a scope is revoked and not stored; transports refuse other hosts and non-GET API calls before a socket opens");

  // ---------------------------------------------------------------- refresh / revoked
  assert.equal(await auth.getAccessToken(cfg, { transport: oauth, now: () => NOW + 60_000 }), ACCESS, "a valid access token needs no call");
  const before = oauthReqs.length;
  assert.equal(await auth.getAccessToken(cfg, { transport: oauth, now: () => NOW + 3_600_000 }), ACCESS2, "expired: refreshed");
  assert.equal(oauthReqs.length, before + 1);
  assert.equal(oauthReqs.at(-1)!.body.get("grant_type"), "refresh_token");
  assert.equal(fs.statSync(cfg.youtubeTokenFile).mode & 0o777, 0o600, "still 0600 after the refresh");
  assert.equal(JSON.parse(fs.readFileSync(cfg.youtubeTokenFile, "utf8")).refresh_token, REFRESH, "the refresh token is kept");
  refreshMode = "revoked";
  await assert.rejects(() => auth.getAccessToken(cfg, { transport: oauth, now: () => NOW + 3_600_000, force: true }), (e: Error) => e instanceof auth.YouTubeReconnectError && !e.message.includes(REFRESH));
  refreshMode = "ok";
  ok("Token refresh: a valid access token is reused, an expired one refreshes (file rewritten 0600, refresh token kept), invalid_grant = YouTubeReconnectError (Google's text never echoed)");

  // ---------------------------------------------------------------- the stub channel
  const vids: { id: string; title: string; dur: string; pub: string }[] = [
    { id: "short_00001", title: "Stop guessing your CPL #shorts", dur: "PT45S", pub: "2026-09-01T15:00:00Z" },
    { id: "short_00002", title: "The 3 second rule", dur: "PT3M", pub: "2026-09-05T15:00:00Z" },
    { id: "long_000003", title: "Full episode 12", dur: "PT3M1S", pub: "2026-09-06T15:00:00Z" },
    { id: "short_00004", title: "Hooks that sell (1)", dur: "PT30S", pub: "2026-09-07T15:00:00Z" },
    { id: "short_00005", title: "Two copies", dur: "PT20S", pub: "2026-09-08T15:00:00Z" },
    { id: "short_00006", title: "No file for this one", dur: "PT15S", pub: "2026-09-09T15:00:00Z" },
    { id: "short_00007", title: "Twins", dur: "PT25S", pub: "2026-09-10T15:00:00Z" },
    { id: "short_00008", title: "Alex archived this hook", dur: "PT33S", pub: "2026-09-11T15:00:00Z" },
  ];
  for (let i = 0; i < 112; i++) vids.push({ id: `bulk_${String(i).padStart(6, "0")}`, title: `Bulk short ${i}`, dur: `PT${10 + (i % 50)}S`, pub: "2026-08-01T15:00:00Z" });
  const apiReqs: URL[] = [];
  let refuse: "engaged" | "unnamed" | "batch" | null = "engaged";
  const views = (id: string) => (id.startsWith("bulk_") ? 100 + Number(id.slice(5)) * 10 : id === "short_00006" ? 0 : 1000 + Number(id.slice(6)) * 100);
  const apiT: import("../src/lib/youtube/api").YtTransport = async (req) => {
    const x = new URL(req.url);
    apiReqs.push(x);
    assert.equal(req.headers.Authorization?.startsWith("Bearer ya29."), true, "Bearer header");
    assert.ok(!req.url.includes("ya29.") && !req.url.includes(REFRESH), "no token in a URL");
    const p = x.pathname;
    if (p === "/youtube/v3/channels")
      return { status: 200, body: JSON.stringify({ items: [{ id: "UCfake", snippet: { title: "Alex Nolan", publishedAt: "2024-01-15T12:00:00Z" }, contentDetails: { relatedPlaylists: { uploads: "UUfake" } } }] }) };
    if (p === "/youtube/v3/playlistItems") {
      const start = Number(x.searchParams.get("pageToken") ?? 0);
      const page = vids.slice(start, start + 50).map((v) => ({ contentDetails: { videoId: v.id } }));
      return { status: 200, body: JSON.stringify({ items: page, nextPageToken: start + 50 < vids.length ? String(start + 50) : undefined }) };
    }
    if (p === "/youtube/v3/videos") {
      const ids = x.searchParams.get("id")!.split(",");
      assert.ok(ids.length <= 50);
      return {
        status: 200,
        body: JSON.stringify({
          items: vids
            .filter((v) => ids.includes(v.id))
            .map((v) => ({ id: v.id, snippet: { title: v.title, publishedAt: v.pub, thumbnails: { high: { url: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` } } }, contentDetails: { duration: v.dur }, status: { privacyStatus: "public" } })),
        }),
      };
    }
    if (p === "/v2/reports") {
      const metrics = x.searchParams.get("metrics")!.split(",");
      if (refuse === "engaged" && metrics.includes("engagedViews"))
        return { status: 400, body: JSON.stringify({ error: { code: 400, message: "Unknown identifier (engagedViews) given in field parameters.metrics.", errors: [{ reason: "badRequest" }] } }) };
      if (refuse === "unnamed" && metrics.includes("shares")) return { status: 400, body: JSON.stringify({ error: { code: 400, message: "The query is not supported.", errors: [{ reason: "badRequest" }] } }) };
      if (refuse === "batch" && x.searchParams.get("dimensions") === "video")
        return { status: 400, body: JSON.stringify({ error: { code: 400, message: "The query is not supported.", errors: [{ reason: "badRequest" }] } }) };
      const ids = x.searchParams.get("filters")!.replace(/^video==/, "").split(",");
      const byVideo = x.searchParams.get("dimensions") === "video";
      const headers = [...(byVideo ? ["video"] : []), ...metrics].map((name) => ({ name }));
      const rowFor = (id: string) => [
        ...(byVideo ? [id] : []),
        ...metrics.map((m) => (m === "views" ? views(id) : m === "averageViewPercentage" ? 40 + (views(id) % 50) : m === "averageViewDuration" ? 12 : m === "engagedViews" ? Math.round(views(id) * 0.8) : 3)),
      ];
      return { status: 200, body: JSON.stringify({ columnHeaders: headers, rows: ids.filter((id) => views(id) > 0).map(rowFor) }) };
    }
    return { status: 404, body: "{}" };
  };
  const thumbFetch: import("../src/lib/meta/thumbs").ThumbFetch = async (u2) => {
    assert.ok(ytThumbAllowed(u2));
    return { status: 200, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) };
  };

  // NSM files: an exact match, a "(1)" suffix, two different files with one title (ambiguous), two copies of one file.
  const NSM = s.prepare("select id from sections where key = 'rtm'").pluck().get() as number;
  const rtmRoot = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(path.join(tmp, "rtm-root"), NSM).lastInsertRowid);
  const insAsset = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status, duration_s, sha256, description, spoken_open, described_at)
     values (?, ?, ?, ?, ?, 'mp4', 'video', 1, 1, 1, 'done', ?, ?, ?, ?, ?)`,
  );
  const asset = (rel: string, dur: number, sha: string, described = true) =>
    Number(
      insAsset.run(NSM, rtmRoot, path.join(tmp, "rtm-root", rel), rel, path.basename(rel), dur, sha, described ? "Opening: Alex talks to camera." : null, described ? "Stop guessing what your leads cost." : null, described ? 1 : null)
        .lastInsertRowid,
    );
  const aCpl = asset("Shorts/stop-guessing-your-CPL_v2.mp4", 45.8, "sha-cpl");
  const aRule = asset("Shorts/The 3 second rule.mp4", 181.4, "sha-rule");
  const aHooks = asset("Shorts/hooks that sell.mp4", 30.4, "sha-hooks", false);
  const aCopy1 = asset("Shorts/two copies.mp4", 20, "sha-copy");
  asset("Backup/two copies.mp4", 20.2, "sha-copy");
  asset("Shorts/twins.mp4", 25, "sha-twin-a");
  asset("Other/twins.mp4", 25.5, "sha-twin-b");
  const aArch = asset("Shorts/alex archived this hook.mp4", 33, "sha-arch");
  const archHook = Number(
    s.prepare("insert into hooks (section_id, kind, text, norm, asset_id, source, archived_at, created_at) values (?, 'video', 'Old line', 'old line', ?, 'asset', 5, 1)").run(NSM, aArch).lastInsertRowid,
  );
  const aManual = asset("Cuts/the one Alex links.mp4", 15, "sha-manual");

  // ---------------------------------------------------------------- the queue: off until connected, then a sync
  const qCfg = { ...cfg, cacheDir: path.join(tmp, "yt-cache") };
  const logs: string[] = [];
  const queue = new YouTubeSyncQueue(s, { cfg: qCfg, oauthTransport: oauth, apiTransport: apiT, fetchThumb: thumbFetch, retryDelays: [0, 0, 0], log: (...a) => logs.push(a.join(" ")), isStopped: () => false, now: () => NOW });
  const tokenBak = fs.readFileSync(cfg.youtubeTokenFile);
  fs.rmSync(cfg.youtubeTokenFile);
  assert.equal(queue.due(), null, "not connected: nothing due");
  assert.match(queue.blocked()!, /Not connected/);
  fs.writeFileSync(cfg.youtubeTokenFile, tokenBak, { mode: 0o600 });
  assert.equal(queue.due(), "schedule", "connected and never synced: the daily run is due at once");
  ytStore.setYtPaused(s, true);
  assert.equal(queue.due(), null, "paused: the daily run waits");
  ytStore.requestYtSync(s, NOW);
  assert.equal(queue.due(), "request", "Sync now runs even while paused");
  const res = (await queue.drain())!;
  assert.ok(res, logs.join("\n"));
  assert.equal(queue.due(), null, "done for today");
  ytStore.setYtPaused(s, false);
  const videoRow = (id: string) => s.prepare("select * from yt_videos where video_id = ?").get(id) as Record<string, unknown>;
  assert.deepEqual([res.videos, res.shorts], [120, 119], "120 uploads stored, 119 Shorts");
  assert.deepEqual(
    ["short_00001", "short_00002", "long_000003"].map((id) => [videoRow(id).duration_s, videoRow(id).is_short]),
    [
      [45, 1],
      [180, 1],
      [181, 0],
    ],
    "Shorts rule: <= 180 s (3:00 is a Short, 3:01 is not); every upload stored",
  );
  ok("Shorts sync (stub Data API): off until connected, due on start when stale, Pause holds the daily run, Sync now runs anyway; channel + uploads playlist paged (120 uploads) + videos in batches of 50; every upload stored with is_short = duration <= 180 s");

  // Analytics: batches of 50 (50 / 50 / 19), engagedViews refused by name -> dropped + remembered.
  const reports = apiReqs.filter((x) => x.pathname === "/v2/reports");
  const okReports = reports.filter((x) => !x.searchParams.get("metrics")!.includes("engagedViews"));
  assert.deepEqual(okReports.map((x) => x.searchParams.get("filters")!.split(",").length), [50, 50, 19], "one video report per 50 Shorts");
  assert.ok(okReports.every((x) => x.searchParams.get("ids") === "channel==MINE" && x.searchParams.get("dimensions") === "video" && x.searchParams.get("sort") === "-views"));
  assert.equal(okReports[0].searchParams.get("endDate"), "2026-09-29", "to yesterday (Pacific)");
  assert.equal(okReports[0].searchParams.get("startDate"), "2024-01-15", "from the channel's start");
  assert.deepEqual(res.metricsFailed, ["engagedViews"]);
  const m1 = s.prepare("select * from yt_metrics where video_id = 'short_00001'").get() as Record<string, unknown>;
  assert.deepEqual([m1.snapshot_date, m1.views, m1.engaged_views, m1.avg_view_s, m1.likes], ["2026-09-30", 1100, null, 12, 3], "engaged views null (refused), the rest stored");
  assert.equal((s.prepare("select views from yt_metrics where video_id = 'short_00006'").get() as { views: number }).views, 0, "a Short with no row in the report = 0 views, not unknown");
  assert.deepEqual(ytStore.ytSummary(s, auth.youtubeKeyStatus(cfg)).metricsFailed, ["engagedViews"]);
  ok("Analytics (stub): one video report per 50 Shorts (channel==MINE, dimension video, video filter list, sort -views, channel start to yesterday); a metric refused by name (engagedViews) is dropped, remembered and left null while the rest land; no row = 0 views");

  // Next day: engagedViews is not asked again; history keeps one snapshot per day.
  const q2 = new YouTubeSyncQueue(s, { cfg: qCfg, oauthTransport: oauth, apiTransport: apiT, fetchThumb: thumbFetch, retryDelays: [0, 0, 0], log: () => {}, isStopped: () => false, now: () => NOW + 86_400_000 });
  apiReqs.length = 0;
  await q2.drain();
  assert.ok(apiReqs.filter((x) => x.pathname === "/v2/reports").every((x) => !x.searchParams.get("metrics")!.includes("engagedViews")), "the refused metric is not asked again");
  assert.equal(s.prepare("select count(*) from yt_metrics where video_id = 'short_00001'").pluck().get(), 2, "one snapshot per day, history kept");
  // An unnamed refusal: the core metrics, then each optional metric probed alone.
  s.prepare("delete from app_settings where key like 'youtube:metrics%'").run();
  refuse = "unnamed";
  const r3 = await an.shortsAnalytics(new api.YouTubeApi({ getToken: async () => ACCESS, transport: apiT, retryDelays: [0], scrub: (x) => x }), ["short_00001", "short_00002"], { startDate: "2026-01-01", endDate: "2026-09-29" });
  assert.deepEqual([r3.failed, r3.metrics.includes("comments"), r3.metrics.includes("engagedViews")], [["shares"], true, true], "shares refused, engagedViews + comments recovered by their probes");
  assert.equal(r3.rows.get("short_00001")!.comments, 3);
  refuse = "batch";
  const r4 = await an.shortsAnalytics(new api.YouTubeApi({ getToken: async () => ACCESS, transport: apiT, retryDelays: [0], scrub: (x) => x }), ["short_00001", "short_00002"], { startDate: "2026-01-01", endDate: "2026-09-29" }, { metrics: [...an.CORE_METRICS] });
  assert.deepEqual([r4.mode, r4.rows.get("short_00002")!.views], ["single", 1200], "the batched report refused: one report per Short");
  refuse = null;
  ok("Analytics fallbacks: refused metrics are not asked the next day, one snapshot per day kept; an unnamed refusal retries on the core metrics then probes each optional one (shares refused, the others kept); a refused batch report falls back to one report per Short");

  // ---------------------------------------------------------------- matching + hooks
  const matched = (id: string) => videoRow(id).matched_asset_id as number | null;
  assert.equal(matched("short_00001"), aCpl, "title (hashtag, case, punctuation) = file stem (v2 suffix) and 45 s vs 45.8 s");
  assert.equal(matched("short_00002"), aRule, "180 s vs 181.4 s: within 1.5 s");
  assert.equal(matched("short_00004"), aHooks, "'(1)' suffix dropped");
  assert.equal(matched("short_00005"), aCopy1, "two copies of one file (one fingerprint) = one match, the lowest id");
  assert.equal(matched("short_00007"), null, "two different files with the title and length: ambiguous, no link");
  assert.match(String(videoRow("short_00007").match_detail), /2 files match/);
  assert.equal(matched("short_00006"), null);
  assert.deepEqual([match.normTitle("Stop guessing your CPL #shorts"), match.normTitle("stop-guessing-your-CPL_v2")], ["stop guessing your cpl", "stop guessing your cpl"]);
  s.prepare("update assets set duration_s = 47.6 where id = ?").run(aCpl);
  match.matchShorts(s, { onlyVideoIds: ["short_00001"] });
  assert.equal(matched("short_00001"), null, "2.6 s apart: no match");
  s.prepare("update assets set duration_s = 45.8 where id = ?").run(aCpl);
  match.matchShorts(s);
  // Hooks: the described file got a video hook (source asset), the undescribed one did not, the archived one stays archived.
  const hookOf = (assetId: number) => s.prepare("select id, source, archived_at from hooks where asset_id = ? and kind = 'video'").get(assetId) as { id: number; source: string; archived_at: number | null } | undefined;
  assert.equal(hookOf(aCpl)?.source, "asset", "a matched, described file gets its video hook");
  assert.equal(hookOf(aHooks), undefined, "not described yet: no hook (made on a later sync)");
  assert.deepEqual([hookOf(aArch)?.id, hookOf(aArch)?.archived_at], [archHook, 5], "an archived hook is linked as is, never restored");
  // Manual link kept across syncs; Unlink goes back to the automatic rule.
  assert.throws(() => match.linkShort(s, "short_00006", 999999), /NSM Library/);
  const l = match.linkShort(s, "short_00006", aManual);
  assert.equal(l.filename, "the one Alex links.mp4");
  assert.equal(l.hookCreated, true, "linking a described file makes its hook");
  match.linkShort(s, "short_00001", aManual);
  match.matchShorts(s);
  assert.deepEqual([matched("short_00001"), videoRow("short_00001").match_source], [aManual, "manual"], "a manual link is never overwritten by the automatic match");
  assert.throws(() => match.unlinkShort(s, "short_00002"), /Only a file you linked/);
  assert.deepEqual(match.unlinkShort(s, "short_00001"), { rematched: true });
  assert.equal(matched("short_00001"), aCpl, "Unlink: the automatic match again");
  ok("Matching: normalized title (hashtags, case, punctuation, v2 / (1) suffixes) + duration within 1.5 s, unique only (copies of one fingerprint count once, two files = ambiguous = none); the described file's video hook is made (source asset), an archived one linked as is; Link a file is kept across syncs, Unlink rematches");

  // ---------------------------------------------------------------- reads: Shorts list, hook numbers, thumbnails
  const list = ytStore.shortsList(s, "views");
  assert.equal(list.length, 119);
  assert.equal(list[0].videoId, "short_00008", "sort by views");
  const one = ytStore.shortsList(s).find((r) => r.videoId === "short_00001")!;
  assert.deepEqual([one.views, one.file?.assetId, one.file?.source, one.hook?.id], [1100, aCpl, "auto", hookOf(aCpl)!.id]);
  assert.equal(ytStore.shortsList(s, "newest", hookOf(aCpl)!.id).length, 1, "?hook= keeps the Shorts carrying that hook");
  const hs = ytStore.hookShortStats(s, [hookOf(aCpl)!.id]).get(hookOf(aCpl)!.id)!;
  assert.deepEqual([hs.shorts, hs.views, hs.avgViewPct], [1, 1100, 40], "hook row numbers: views + avg % viewed of its Short");
  assert.equal(s.prepare("select count(*) from yt_videos where thumb_path like 'youtube/%.jpg'").pluck().get(), 119 - 0, "thumbnails cached once (ytimg only, sniffed)");
  assert.equal(ytThumbAllowed("https://i.ytimg.com/vi/x/hq.jpg"), true);
  assert.equal(ytThumbAllowed("https://evil.example/x.jpg"), false);
  assert.equal(ytThumbAllowed("http://i.ytimg.com/vi/x/hq.jpg"), false);
  ok("Reads: the NSM Shorts list (sort by views / newest, ?hook= filter, file + hook per Short), hook rows get their Short's views + avg % viewed, thumbnails cached from i.ytimg.com only (https)");

  // ---------------------------------------------------------------- secrets never leave the token file
  const dbBytes = () => {
    s.pragma("wal_checkpoint(TRUNCATE)");
    return fs.readFileSync(path.join(tmp, "youtube.db")).toString("latin1");
  };
  const everything = dbBytes() + logs.join("\n") + JSON.stringify(ytStore.ytSummary(s, auth.youtubeKeyStatus(cfg)));
  for (const secret of [ACCESS, ACCESS2, REFRESH, CLIENT_SECRET, "4/0good"]) assert.ok(!everything.includes(secret), `never stored or logged: ${secret.slice(0, 8)}`);
  const callRows = s.prepare("select kind, path from yt_calls").all() as { kind: string; path: string }[];
  assert.ok(callRows.length > 10 && callRows.every((c) => !c.path.includes("?") && !c.path.includes("=")), "call log = path only");
  // /api/status carries booleans + sync times only (the main smoke DB via getStatus: its own temp token path).
  const { getStatus } = await import("../src/lib/queries");
  const st = getStatus().youtube;
  assert.deepEqual(Object.keys(st).sort(), ["clientSecret", "connected", "current", "hasError", "lastRunFinishedAt", "lastSyncAt", "nextRunAt", "note", "paused", "reconnectNeeded", "requested", "scopesOk", "state"].sort());
  assert.ok(!JSON.stringify(getStatus()).includes("ya29."));
  ok("Secrets: access / refresh tokens, the client secret and the code never reach the DB, the call log, the worker log or /api/status (booleans + sync times only)");

  // ---------------------------------------------------------------- revoked -> Reconnect needed
  refreshMode = "revoked";
  const tok = JSON.parse(fs.readFileSync(cfg.youtubeTokenFile, "utf8"));
  fs.writeFileSync(cfg.youtubeTokenFile, JSON.stringify({ ...tok, expires_at: 1 }), { mode: 0o600 });
  ytStore.requestYtSync(s, NOW + 2 * 86_400_000);
  const q3 = new YouTubeSyncQueue(s, { cfg: qCfg, oauthTransport: oauth, apiTransport: apiT, retryDelays: [0, 0, 0], log: () => {}, isStopped: () => false, now: () => NOW + 2 * 86_400_000 });
  await q3.drain();
  const sum = ytStore.ytSummary(s, auth.youtubeKeyStatus(cfg));
  assert.equal(sum.reconnectNeeded, true, "a refused refresh = Reconnect needed");
  assert.equal(q3.state, "waiting");
  assert.equal(q3.due(), null, "nothing runs until Alex reconnects");
  assert.equal(sum.lastSyncAt, NOW + 86_400_000, "the last good numbers stay");
  ytStore.setReconnectNeeded(s, false);
  refreshMode = "ok";
  // Disconnect: revoke (body, not URL) + delete the file.
  const d = await auth.disconnect(cfg, oauth);
  assert.deepEqual(d, { revoked: true, hadToken: true });
  assert.ok(!fs.existsSync(cfg.youtubeTokenFile) && !oauthReqs.at(-1)!.url.includes("token="), "token file deleted, revoke carries the token in the body");
  ok("Revoked: a refused refresh sets Reconnect needed, the queue waits (last good numbers kept); Disconnect revokes at Google (token in the POST body) and deletes the token file");

  // ---------------------------------------------------------------- NSM calibration (views, avg % viewed)
  const rtmHooks: number[] = [];
  const insScore = s.prepare(
    `insert into hook_scores (hook_id, rubric_version, answers, unsure, overall, pp_person, pp_pain, pp_promise, stops_scroll, model, scored_at)
     values (?, (select version from rubric_versions where current = 1), '{}', '[]', ?, 0.5, 0.5, 0.5, 0.5, 'jev-1.13.0', 1)`,
  );
  s.prepare("delete from yt_metrics").run();
  s.prepare("update yt_videos set matched_asset_id = null, match_source = null").run();
  const insM = s.prepare("insert into yt_metrics (video_id, snapshot_date, start_date, end_date, views, avg_view_pct, synced_at) values (?, '2026-09-30', '2024-01-15', '2026-09-29', ?, ?, 1)");
  for (let i = 0; i < 10; i++) {
    const vid = `bulk_${String(i).padStart(6, "0")}`;
    const a = asset(`Cal/cal-${i}.mp4`, 20, `sha-cal-${i}`);
    s.prepare("update yt_videos set matched_asset_id = ?, match_source = 'manual' where video_id = ?").run(a, vid);
    const h = Number(s.prepare("insert into hooks (section_id, kind, text, norm, asset_id, source, created_at) values (?, 'video', ?, ?, ?, 'asset', 1)").run(NSM, `Cal hook ${i}`, `cal hook ${i}`, a).lastInsertRowid);
    insScore.run(h, 1 + i * 0.4);
    // Higher score = more views and a higher average % viewed; hook 0 has only 299 views (not counted).
    insM.run(vid, i === 0 ? 299 : 1000 + i * 500, 30 + i * 3);
    rtmHooks.push(h);
  }
  const rtmRep = report.calibrationReport(s, report.parseCalParams({ cal_view: "rtm" }), true);
  assert.deepEqual(rtmRep.view.metrics, ["views", "avg_viewed"]);
  assert.equal(rtmRep.params.missMetric, "views", "NSM's misses default to views");
  const oc = rtmRep.view.rows.find((r) => r.item.id === "overall")!.cells;
  assert.deepEqual([oc.views!.n, oc.views!.groups, oc.views!.enough], [9, 9, true], "hook 0 (299 views) is out; 9 hooks on 9 Shorts");
  assert.ok(Math.abs((oc.views!.rho ?? 0) - 1) < 1e-9 && Math.abs((oc.avg_viewed!.rho ?? 0) - 1) < 1e-9, "higher score, more views and a higher % viewed = +1");
  assert.equal(stats.cellText(oc.views!, "Shorts"), "+1.00 · 9 hooks on 9 Shorts");
  assert.equal(rtmRep.rtm.note, null, "connected + enough data: calibrated");
  assert.equal(rtmRep.view.linked, 10, "the 10 NSM hooks linked to Shorts");
  assert.equal(report.calibrationReport(s, report.parseCalParams({}), true).view.linked, 0, "NSM is never pooled into Overall");
  assert.match(report.calibrationReport(s, report.parseCalParams({}), false).rtm.note ?? "", /connect YouTube in Settings/, "not connected: not yet calibrated");
  const { setCalibrationMinimums } = await import("../src/lib/meta/thresholds");
  setCalibrationMinimums(s, { ...stats.DEFAULT_CAL_MINIMUMS, views: 3000 });
  const strict = report.calibrationReport(s, report.parseCalParams({ cal_view: "rtm" }), true);
  assert.equal(strict.rtm.note?.startsWith("Not yet calibrated: 6 of 8 hooks have 3,000+ views"), true, strict.rtm.note ?? "");
  setCalibrationMinimums(s, null);
  assert.match(report.calibrationLine(s, { kind: "rtm" }).text, /9 hooks here have 300\+ views/);
  const misses = report.calibrationReport(s, report.parseCalParams({ cal_view: "rtm", cal_m: "avg_viewed" }), true);
  assert.equal(misses.misses.metric, "avg_viewed");
  assert.equal(report.parseCalParams({ cal_view: "rtm", cal_m: "ctr" }).missMetric, "views", "a Meta metric on the NSM view falls back to views");
  ok("NSM calibration: hooks linked to Shorts (file -> video hook) vs views and views-weighted avg % viewed, a hook counts at 300+ views (editable), Spearman per cell with Shorts as the unit, never pooled into Overall, \"Not yet calibrated\" until connected and enough data, the Hooks tab line, NSM misses");

  // ---------------------------------------------------------------- distinct ad groups (SGD Pros cells)
  const pts = (n: number, adsFor: (i: number) => string[]) =>
    Array.from({ length: n }, (_, i) => ({
      hookId: i + 1,
      score: i,
      result: stats.sumHookResults(adsFor(i).map((id, k) => ({ id, impressions: 2000, clicks: 10 + i + k, video3s: 0, spend: 100, leads: 3 + i, isVideo: false }))),
    }));
  const twoGroups = stats.calCell(pts(10, (i) => (i % 2 ? ["adA", "adB"] : ["adB", "adA"])), "ctr", stats.DEFAULT_CAL_MINIMUMS);
  assert.deepEqual([twoGroups.n, twoGroups.groups, twoGroups.enough, twoGroups.rho], [10, 1, false, null], "10 hooks on the same two ads (any order) = 1 ad group: not enough");
  assert.equal(stats.cellText(twoGroups), "Not enough data yet (10 hooks on 1 of 8 ad groups)");
  const nine = stats.calCell(pts(12, (i) => [`ad${Math.min(i, 8)}`]), "ctr", stats.DEFAULT_CAL_MINIMUMS);
  assert.deepEqual([nine.n, nine.groups, nine.enough], [12, 9, true], "12 hooks on 9 distinct ad groups: enough");
  assert.equal(stats.cellText(nine), `${stats.fmtRho(nine.rho!)} · 12 hooks on 9 ad groups`);
  const noisy = { n: 20, groups: 12, rho: 0.14, enough: true, need: 8, needGroups: 8 };
  assert.deepEqual([stats.isNoise(noisy), stats.isNoise({ ...noisy, groups: 30 }), stats.isNoise({ ...noisy, rho: -0.25 })], [true, false, false], "muted: |rho| < 0.2 with < 30 groups");
  assert.equal(stats.calCell(pts(10, (i) => [`ad${i}`]), "ctr", { ...stats.DEFAULT_CAL_MINIMUMS, groups: 11 }).enough, false, "the group minimum is editable");
  const { calibrationMinimumsSchema } = await import("../src/lib/meta/flags");
  assert.deepEqual(calibrationMinimumsSchema.parse({ impressions: 1000, leads: 3, hooks: 8 }), stats.DEFAULT_CAL_MINIMUMS, "values saved before slice 4 get the new defaults");
  // In the report: hooks carried by the same ad share one group.
  const ED = s.prepare("select acc.id from ad_accounts acc join clients c on c.id = acc.client_id where c.code = 'cedar'").pluck().get() as number;
  s.prepare("update ad_accounts set ghl_synced_at = 1, leads_source = 'ghl'").run();
  const edClient = s.prepare("select id from clients where code = 'cedar'").pluck().get() as number;
  const FKBP = s.prepare("select id from sections where key = 'fkbpros'").pluck().get() as number;
  for (let i = 0; i < 12; i++) {
    const adId = `grp${i % 4}`;
    if (i < 4) s.prepare("insert into ad_metrics (meta_ad_id, date, account_id, spend, impressions, clicks, synced_at) values (?, '2026-09-01', ?, 50, 2000, ?, 1)").run(adId, ED, 10 + i);
    const h = Number(s.prepare("insert into hooks (section_id, client_id, kind, text, norm, source, created_at) values (?, ?, 'text', ?, ?, 'meta', 1)").run(FKBP, edClient, `Group hook ${i}`, `group hook ${i}`).lastInsertRowid);
    s.prepare("insert into hook_ads (hook_id, meta_ad_id, role, created_at) values (?, ?, 'headline', 1)").run(h, adId);
    insScore.run(h, 1 + i * 0.3);
  }
  const ed = report.calibrationReport(s, report.parseCalParams({ cal_view: "cedar" }), true);
  const edCell = ed.view.rows.find((r) => r.item.id === "overall")!.cells.ctr!;
  assert.deepEqual([edCell.n, edCell.groups, edCell.enough, ed.view.countedGroups.ctr], [12, 4, false, 4], "12 hooks on 4 ads = 4 ad groups: under the group minimum");
  ok("Ad groups: every cell counts the distinct sets of linked ads behind its hooks (\"+0.14 · 336 hooks on 104 ad groups\"), needs 8 hooks AND 8 groups (editable; old saved minimums get the defaults), |rho| < 0.2 on < 30 groups is muted as noise; in the report hooks on the same ads share one group");

  db.sqlite.close();
}
