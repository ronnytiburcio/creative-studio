/**
 * YouTube OAuth for Studio's own READ-ONLY token (Phase 5 slice 4, PHASE-5 I1; server only).
 *
 * - The ONLY reader of the Google OAuth client (`YOUTUBE_CLIENT_SECRET_FILE`, the episode prep skill's Desktop /
 *   "installed" client of the owner's Google Cloud project; read only, never modified) and of Studio's token file
 *   (`YOUTUBE_TOKEN_FILE`, <settings dir>/youtube-token.json, written 0600 via temp file + rename). Neither value goes
 *   into the DB, a log line, an error message, /api/status or the browser: callers get booleans and fixed messages.
 *   The skill's own upload token (token.json next to the client secret) is never read or touched (config.ts refuses a
 *   token path that points at it).
 * - Scopes: exactly youtube.readonly + yt-analytics.readonly.
 * - Connect = a loopback flow the owner completes themselves: `startConnect` stores a one-time `state` (sha256 only) with its
 *   PKCE verifier (S256) for 10 minutes and returns Google's consent URL (access_type=offline, prompt=consent). Google
 *   sends the browser back to `http://127.0.0.1:<STUDIO_PORT>/` (the documented loopback form for Desktop clients; the
 *   home page hands `state` + `code` to /api/youtube/callback). The callback consumes the state (single use, unexpired)
 *   and exchanges the code: that exchange and Disconnect's best-effort revoke are the only YouTube network calls the
 *   web process makes (both to oauth2.googleapis.com). Refreshing the access token happens in the worker.
 * - A refused refresh (`invalid_grant`: revoked, or the consent expired) = "Reconnect needed" (YouTubeReconnectError).
 * - Errors never echo Google's bodies: only its short `error` code (letters and underscores) is kept.
 *
 * Tests inject an OAuthTransport stub; they never reach Google.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { StudioConfig } from "../config";
import { scrubSecrets } from "../scrub";

type Sql = Database.Database;
type Cfg = Pick<StudioConfig, "youtubeClientSecretFile" | "youtubeTokenFile" | "port">;

export const YT_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"] as const;
export const OAUTH_HOST = "oauth2.googleapis.com";
const AUTH_HOST = "accounts.google.com";
export const STATE_TTL_MS = 10 * 60_000;
/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 120_000;

export class YouTubeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeAuthError";
  }
}
/** The refresh token was refused (revoked, or the consent ended): the owner clicks Reconnect in Settings. */
export class YouTubeReconnectError extends YouTubeAuthError {
  constructor() {
    super("Reconnect needed: Google refused Studio's YouTube token. Click Reconnect in Settings.");
    this.name = "YouTubeReconnectError";
  }
}
/** No token file yet (Connect YouTube not done). */
export class YouTubeNotConnectedError extends YouTubeAuthError {
  constructor() {
    super("YouTube is not connected. Connect YouTube in Settings.");
    this.name = "YouTubeNotConnectedError";
  }
}

export type OAuthRequest = { url: string; body: string; timeoutMs: number };
export type OAuthResponse = { status: number; body: string };
export type OAuthTransport = (req: OAuthRequest) => Promise<OAuthResponse>;

/** POST a form to oauth2.googleapis.com only (anything else refused before a socket opens); no redirects. */
export const httpOAuthTransport: OAuthTransport = async (req) => {
  const u = new URL(req.url);
  if (u.protocol !== "https:" || u.hostname !== OAUTH_HOST) throw new YouTubeAuthError("Studio only posts to oauth2.googleapis.com.");
  const res = await fetch(u, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: req.body,
    signal: AbortSignal.timeout(req.timeoutMs),
    redirect: "error",
  });
  return { status: res.status, body: await res.text() };
};

type ClientSecret = { clientId: string; clientSecret: string | null; authUri: string; tokenUri: string };

/** The Desktop client from the client secret file (null when missing / not an installed client / odd hosts). */
function readClientSecret(cfg: Cfg): ClientSecret | null {
  try {
    const st = fs.statSync(cfg.youtubeClientSecretFile);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const j = JSON.parse(fs.readFileSync(cfg.youtubeClientSecretFile, "utf8")) as { installed?: Record<string, unknown> };
    const c = j.installed;
    if (!c || typeof c.client_id !== "string" || !c.client_id) return null;
    const authUri = typeof c.auth_uri === "string" ? c.auth_uri : `https://${AUTH_HOST}/o/oauth2/auth`;
    const tokenUri = typeof c.token_uri === "string" ? c.token_uri : `https://${OAUTH_HOST}/token`;
    if (new URL(authUri).hostname !== AUTH_HOST || new URL(tokenUri).hostname !== OAUTH_HOST) return null;
    return { clientId: c.client_id, clientSecret: typeof c.client_secret === "string" ? c.client_secret : null, authUri, tokenUri };
  } catch {
    return null;
  }
}

type TokenFile = {
  version: 1;
  refresh_token: string;
  access_token: string | null;
  /** Epoch ms the access token expires. */
  expires_at: number | null;
  scope: string;
  obtained_at: number;
};

function readTokenFile(cfg: Cfg): TokenFile | null {
  try {
    const st = fs.statSync(cfg.youtubeTokenFile);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const j = JSON.parse(fs.readFileSync(cfg.youtubeTokenFile, "utf8")) as Partial<TokenFile>;
    if (typeof j.refresh_token !== "string" || !j.refresh_token) return null;
    return {
      version: 1,
      refresh_token: j.refresh_token,
      access_token: typeof j.access_token === "string" ? j.access_token : null,
      expires_at: typeof j.expires_at === "number" ? j.expires_at : null,
      scope: typeof j.scope === "string" ? j.scope : "",
      obtained_at: typeof j.obtained_at === "number" ? j.obtained_at : 0,
    };
  } catch {
    return null;
  }
}

/** Write the token file 0600 (dir 0700), temp file + rename so a crash never leaves half a token. */
function writeTokenFile(cfg: Cfg, t: TokenFile) {
  const dir = path.dirname(cfg.youtubeTokenFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${cfg.youtubeTokenFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600, flag: "wx" });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, cfg.youtubeTokenFile);
}

export type YouTubeKeyStatus = {
  /** The client secret file exists and names a Desktop client. */
  clientSecret: boolean;
  /** Studio's token file exists with a refresh token. */
  connected: boolean;
  /** Both read-only scopes were granted. */
  scopesOk: boolean;
  /** The token file is private (0600). */
  privateFile: boolean;
};

/** Presence only (booleans). Never returns a value from either file. */
export function youtubeKeyStatus(cfg: Cfg): YouTubeKeyStatus {
  const t = readTokenFile(cfg);
  let privateFile = false;
  try {
    privateFile = t != null && (fs.statSync(cfg.youtubeTokenFile).mode & 0o077) === 0;
  } catch {
    privateFile = false;
  }
  return { clientSecret: readClientSecret(cfg) != null, connected: t != null, scopesOk: t != null && hasScopes(t.scope), privateFile };
}

function hasScopes(scope: string): boolean {
  const got = new Set(scope.split(/\s+/).filter(Boolean));
  return YT_SCOPES.every((s) => got.has(s));
}

const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

/** The loopback redirect Google sends the owner back to (Desktop clients accept any port on 127.0.0.1). */
export function redirectUri(cfg: Pick<StudioConfig, "port">): string {
  return `http://127.0.0.1:${cfg.port}/`;
}

/**
 * Connect / Reconnect: a fresh one-time state + PKCE verifier (stored server side, 10 minutes) and Google's consent URL.
 * Nothing is sent to Google here; the browser opens the URL.
 */
export function startConnect(sql: Sql, cfg: Cfg, now = Date.now()): { url: string } {
  const cs = readClientSecret(cfg);
  if (!cs) throw new YouTubeAuthError("The Google OAuth client file is missing or is not a Desktop client.");
  const state = b64url(crypto.randomBytes(32));
  const verifier = b64url(crypto.randomBytes(48));
  sql.prepare("delete from yt_oauth_states where expires_at <= ?").run(now);
  sql
    .prepare("insert into yt_oauth_states (state_hash, verifier, created_at, expires_at) values (?, ?, ?, ?)")
    .run(sha256(state).toString("hex"), verifier, now, now + STATE_TTL_MS);
  const u = new URL(cs.authUri);
  u.search = new URLSearchParams({
    client_id: cs.clientId,
    redirect_uri: redirectUri(cfg),
    response_type: "code",
    scope: YT_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: b64url(sha256(verifier)),
    code_challenge_method: "S256",
  }).toString();
  return { url: u.toString() };
}

/** Use a state once: its verifier if it is known and unexpired (the row is deleted either way), else null. */
export function consumeState(sql: Sql, state: string, now = Date.now()): string | null {
  const hash = sha256(state).toString("hex");
  return sql.transaction(() => {
    const row = sql.prepare("select verifier, expires_at from yt_oauth_states where state_hash = ?").get(hash) as { verifier: string; expires_at: number } | undefined;
    if (!row) return null;
    sql.prepare("delete from yt_oauth_states where state_hash = ?").run(hash);
    return row.expires_at > now ? row.verifier : null;
  }).immediate();
}

type TokenBody = { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown; error?: unknown };

function parseBody(body: string): TokenBody {
  try {
    const j = JSON.parse(body);
    return j && typeof j === "object" ? (j as TokenBody) : {};
  } catch {
    return {};
  }
}

/** Google's short error code only ("invalid_grant"), never its description or any other part of the body. */
function errorCode(b: TokenBody): string {
  return typeof b.error === "string" && /^[a-z_]{1,40}$/.test(b.error) ? b.error : "unknown_error";
}

export type ExchangeResult = { ok: true } | { ok: false; reason: "failed" | "scopes" };

/**
 * The callback's code exchange (web process; the one network call it makes for YouTube besides Disconnect's revoke).
 * Stores the token file only when Google granted BOTH read-only scopes and a refresh token; otherwise the grant is
 * revoked (best effort) and nothing is stored.
 */
export async function exchangeCode(
  cfg: Cfg,
  code: string,
  verifier: string,
  transport: OAuthTransport = httpOAuthTransport,
  now = Date.now(),
  onCall?: (c: YtCallLog) => void,
): Promise<ExchangeResult> {
  const cs = readClientSecret(cfg);
  if (!cs) return { ok: false, reason: "failed" };
  const form = new URLSearchParams({ code, client_id: cs.clientId, redirect_uri: redirectUri(cfg), grant_type: "authorization_code", code_verifier: verifier });
  if (cs.clientSecret) form.set("client_secret", cs.clientSecret);
  const started = Date.now();
  let res: OAuthResponse;
  try {
    res = await transport({ url: cs.tokenUri, body: form.toString(), timeoutMs: 30_000 });
  } catch {
    onCall?.({ kind: "oauth", path: "/token (code)", status: null, ms: Date.now() - started, error: "network error" });
    return { ok: false, reason: "failed" };
  }
  const b = parseBody(res.body);
  onCall?.({ kind: "oauth", path: "/token (code)", status: res.status, ms: Date.now() - started, error: res.status === 200 ? null : errorCode(b) });
  if (res.status !== 200 || typeof b.refresh_token !== "string" || !b.refresh_token) return { ok: false, reason: "failed" };
  const scope = typeof b.scope === "string" ? b.scope : "";
  if (!hasScopes(scope)) {
    await revokeValue(b.refresh_token, transport).catch(() => {});
    return { ok: false, reason: "scopes" };
  }
  writeTokenFile(cfg, {
    version: 1,
    refresh_token: b.refresh_token,
    access_token: typeof b.access_token === "string" ? b.access_token : null,
    expires_at: typeof b.expires_in === "number" ? now + b.expires_in * 1000 : null,
    scope,
    obtained_at: now,
  });
  return { ok: true };
}

export type YtCallLog = { kind: "data" | "analytics" | "oauth"; path: string; status: number | null; ms: number; error: string | null };

/**
 * A valid access token for the worker's API calls: the stored one while it has 2+ minutes left (unless `force`), else a
 * refresh (written back 0600). A refused refresh = YouTubeReconnectError; no token file = YouTubeNotConnectedError.
 */
export async function getAccessToken(
  cfg: Cfg,
  opts: { transport?: OAuthTransport; now?: () => number; force?: boolean; onCall?: (c: YtCallLog) => void } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const t = readTokenFile(cfg);
  if (!t) throw new YouTubeNotConnectedError();
  if (!opts.force && t.access_token && t.expires_at != null && t.expires_at - REFRESH_MARGIN_MS > now()) return t.access_token;
  const cs = readClientSecret(cfg);
  if (!cs) throw new YouTubeAuthError("The Google OAuth client file is missing or is not a Desktop client.");
  const form = new URLSearchParams({ client_id: cs.clientId, grant_type: "refresh_token", refresh_token: t.refresh_token });
  if (cs.clientSecret) form.set("client_secret", cs.clientSecret);
  const started = Date.now();
  let res: OAuthResponse;
  try {
    res = await (opts.transport ?? httpOAuthTransport)({ url: cs.tokenUri, body: form.toString(), timeoutMs: 30_000 });
  } catch {
    opts.onCall?.({ kind: "oauth", path: "/token (refresh)", status: null, ms: Date.now() - started, error: "network error" });
    throw new YouTubeAuthError("Could not reach Google to refresh the YouTube token.");
  }
  const b = parseBody(res.body);
  opts.onCall?.({ kind: "oauth", path: "/token (refresh)", status: res.status, ms: Date.now() - started, error: res.status === 200 ? null : errorCode(b) });
  if (res.status === 400 || res.status === 401) {
    const code = errorCode(b);
    if (code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client") throw new YouTubeReconnectError();
  }
  if (res.status !== 200 || typeof b.access_token !== "string") throw new YouTubeAuthError(`Google refused the token refresh (${errorCode(b)}).`);
  writeTokenFile(cfg, {
    ...t,
    refresh_token: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : t.refresh_token,
    access_token: b.access_token,
    expires_at: typeof b.expires_in === "number" ? now() + b.expires_in * 1000 : now() + 3_000_000,
    scope: typeof b.scope === "string" && b.scope ? b.scope : t.scope,
  });
  return b.access_token;
}

async function revokeValue(token: string, transport: OAuthTransport): Promise<boolean> {
  const res = await transport({ url: `https://${OAUTH_HOST}/revoke`, body: new URLSearchParams({ token }).toString(), timeoutMs: 5_000 });
  return res.status === 200;
}

/**
 * Disconnect: revoke the grant at Google (best effort, 5 s; the token goes in the POST body, never a URL) and delete the
 * token file. Returns whether Google confirmed the revoke (the file is deleted either way).
 */
export async function disconnect(cfg: Cfg, transport: OAuthTransport = httpOAuthTransport): Promise<{ revoked: boolean; hadToken: boolean }> {
  const t = readTokenFile(cfg);
  let revoked = false;
  if (t) {
    try {
      revoked = await revokeValue(t.refresh_token, transport);
    } catch {
      revoked = false;
    }
  }
  fs.rmSync(cfg.youtubeTokenFile, { force: true });
  return { revoked, hadToken: t != null };
}

/** Replace any known token value in a string (for error text built from a response). */
export function scrubTokens(text: string, cfg: Cfg): string {
  const t = readTokenFile(cfg);
  return scrubSecrets(text, [t?.access_token, t?.refresh_token]).replace(/(ya29\.)[A-Za-z0-9_\-.]+/g, "$1<token>");
}
