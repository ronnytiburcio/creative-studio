/**
 * Meta Graph API reader (worker only, Phase 5). READ ONLY: this module has no POST / DELETE / PUT code path, its
 * transport refuses any method but GET and any host but graph.facebook.com, and the smoke test asserts both.
 *
 * - The ONLY reader of the two Meta tokens: `META_ACCESS_TOKEN` from `META_ENV_FILE` (the Lane B API system user: the
 *   Lane B client accounts) or from `META_FKB_ENV_FILE` (Lane C's own account). Read
 *   fresh per request (a rotated token works without a restart) and sent in the Authorization header only, never in a
 *   URL, the DB, a log line, an error message or the browser. config.ts keyStatus() checks presence only.
 * - The Graph version is pinned per identity from the same env file (`META_GRAPH_VERSION`, default v21.0). Paging never
 *   follows Meta's `paging.next` URL as is (it switches to the newest version): the `after` cursor is read from it and
 *   the request is rebuilt on the pinned version.
 * - `url()` refuses the `method`, `_method`, `batch` and `access_token` query parameters in any case, so a GET can never
 *   become a Graph write tunnel (method override or a batch) or carry the token.
 * - Retries transient failures (network, 429, 5xx, Meta error codes 1 / 2 / 4 / 17 / 32 / 613 / 80004 or
 *   `is_transient`) with backoff; never a permission or validation error. Reads Meta's usage headers
 *   (x-business-use-case-usage, x-ad-account-usage, x-app-usage) after every call and cools down before the next one when
 *   usage runs high; past 5 minutes it throws MetaThrottledError so the queue waits instead.
 * - Every request is reported through `onCall` (identity, path without query, status, ms, scrubbed error) for the
 *   `meta_calls` log. `scrub()` removes the token and any access_token= value from any text before it goes anywhere.
 *
 * Tests inject a stub transport; they never reach the network.
 */
import { IDENTITY } from "../config";
import fs from "node:fs";
import { parseEnvText } from "../envfile";
import { scrubSecrets } from "../scrub";

export type MetaIdentity = "fpc" | "fkb";

export const GRAPH_HOST = "graph.facebook.com";
export const DEFAULT_GRAPH_VERSION = "v21.0";
// The install identity's slug (the original install keeps its own, which outside services already see).
const USER_AGENT = `${IDENTITY.slug}/1.0 (read only)`;

export type GraphRequest = {
  method: "GET";
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
};
export type GraphResponse = { status: number; body: string; header: (name: string) => string | null };
export type GraphTransport = (req: GraphRequest) => Promise<GraphResponse>;

export type MetaCallLog = { identity: MetaIdentity; kind: "graph"; path: string; status: number | null; ms: number; error: string | null };

export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: number | null = null,
    readonly transient = false,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
}

/** The env file has no token (or cannot be read). The text names the identity, never the file path (it is stored). */
export class MetaTokenMissingError extends MetaGraphError {
  constructor(identity: MetaIdentity) {
    super(`No META_ACCESS_TOKEN in the ${identity === "fkb" ? "META_FKB_ENV_FILE" : "META_ENV_FILE"} file.`);
    this.name = "MetaTokenMissingError";
  }
}

/** Meta asked us to slow down for longer than the queue should sleep inline: wait until resumeAt, then try again. */
export class MetaThrottledError extends MetaGraphError {
  constructor(readonly resumeAt: number) {
    super(`Meta rate limit: waiting until ${new Date(resumeAt).toLocaleTimeString("en-US", { timeZone: "America/New_York" })}.`, 429, 17, true);
    this.name = "MetaThrottledError";
  }
}

/** Replace the token (when known) and any access_token= / Bearer value in a string. Safe on any input. */
export function scrub(text: unknown, token?: string | null): string {
  return scrubSecrets(text, [token])
    .replace(/([?&#]access_token=)[^&\s"']+/gi, "$1<token>")
    .replace(/(access_token["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-.]{8,}/gi, "$1<token>");
}

function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnvText(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const VERSION_RE = /^v\d{1,3}\.\d{1,2}$/;

/** The pinned Graph version for an env file (META_GRAPH_VERSION, else v21.0). Not a secret. */
export function graphVersionOf(file: string): string {
  const v = readEnvFile(file).META_GRAPH_VERSION?.trim();
  return v && VERSION_RE.test(v) ? v : DEFAULT_GRAPH_VERSION;
}

/**
 * The default transport: fetch, GET only, graph.facebook.com only, no redirects. Anything else is refused before a
 * socket opens (the smoke test calls it with POST and another host).
 */
export const httpGraphTransport: GraphTransport = async (req) => {
  if (req.method !== "GET") throw new MetaGraphError("Studio only reads from Meta: GET requests only.");
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new MetaGraphError("Bad Graph URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== GRAPH_HOST) throw new MetaGraphError("Studio only calls graph.facebook.com.");
  if ([...url.searchParams.keys()].some((k) => REFUSED_PARAMS.has(k.toLowerCase()))) throw new MetaGraphError("Studio only reads from Meta: that parameter is refused.");
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const res = await fetch(url, { method: "GET", headers: req.headers, signal, redirect: "error" });
  const body = await res.text();
  return { status: res.status, body, header: (name) => res.headers.get(name) };
};

/**
 * Query parameters a GET must never carry (compared lowercased): `method` / `_method` (Graph's method override turns a
 * GET into a POST / DELETE), `batch` (a batch request can hold writes) and `access_token` (the token goes in the header).
 */
export const REFUSED_PARAMS = new Set(["method", "_method", "batch", "access_token"]);

const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613, 80000, 80003, 80004]);

type ErrorBody = { error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean; type?: string } };

export type GraphParams = Record<string, string | number | undefined>;

export type MetaGraphOptions = {
  identity: MetaIdentity;
  envFile: string;
  transport?: GraphTransport;
  onCall?: (c: MetaCallLog) => void;
  log?: (...args: unknown[]) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Waits before retry 1, 2, ... (default 5 s, 15 s, 45 s). */
  retryDelays?: number[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Longest cool-down slept inline; anything longer throws MetaThrottledError. */
const MAX_INLINE_WAIT_MS = 5 * 60_000;

export class MetaGraph {
  readonly identity: MetaIdentity;
  private readonly envFile: string;
  private readonly transport: GraphTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private cooldownUntil = 0;
  /** Highest usage percent Meta reported on the last response (for the heartbeat note). */
  lastUsagePct = 0;
  calls = 0;

  constructor(private readonly opts: MetaGraphOptions) {
    this.identity = opts.identity;
    this.envFile = opts.envFile;
    this.transport = opts.transport ?? httpGraphTransport;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** The pinned version (re-read from the env file each time, like the token). */
  get version(): string {
    return graphVersionOf(this.envFile);
  }

  /** True when the env file carries a token (presence only). */
  configured(): boolean {
    return Boolean(this.token());
  }

  private token(): string | null {
    const t = readEnvFile(this.envFile).META_ACCESS_TOKEN?.trim();
    return t ? t : null;
  }

  private url(path: string, params: GraphParams): string {
    // Letters, digits, _ and / only: no query string, fragment or dot segment can ride in on the path.
    if (!/^[A-Za-z0-9_]*(\/[A-Za-z0-9_]+)*$/.test(path)) throw new MetaGraphError("Bad Graph path.");
    const u = new URL(`https://${GRAPH_HOST}/${this.version}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    for (const k of u.searchParams.keys()) {
      if (REFUSED_PARAMS.has(k.toLowerCase())) throw new MetaGraphError(k.toLowerCase() === "access_token" ? "The token never goes in a URL." : "Studio only reads from Meta: that parameter is refused.");
    }
    return u.toString();
  }

  private async coolDown() {
    const wait = this.cooldownUntil - this.now();
    if (wait <= 0) return;
    if (wait > MAX_INLINE_WAIT_MS) throw new MetaThrottledError(this.cooldownUntil);
    this.opts.log?.(`meta: usage high, cooling down ${Math.round(wait / 1000)} s`);
    await this.sleep(wait);
  }

  /** Read Meta's usage headers; set a cool-down when they run high (>= 75% short, >= 90% or a regain time longer). */
  private noteUsage(res: GraphResponse) {
    let pct = 0;
    let regainMin = 0;
    const json = (name: string): unknown => {
      const raw = res.header(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const bu = json("x-business-use-case-usage") as Record<string, { call_count?: number; total_cputime?: number; total_time?: number; estimated_time_to_regain_access?: number }[]> | null;
    if (bu && typeof bu === "object") {
      for (const list of Object.values(bu)) {
        for (const u of Array.isArray(list) ? list : []) {
          pct = Math.max(pct, u.call_count ?? 0, u.total_cputime ?? 0, u.total_time ?? 0);
          regainMin = Math.max(regainMin, u.estimated_time_to_regain_access ?? 0);
        }
      }
    }
    const acc = json("x-ad-account-usage") as { acc_id_util_pct?: number; reset_time_duration?: number } | null;
    if (acc) {
      pct = Math.max(pct, acc.acc_id_util_pct ?? 0);
      if ((acc.acc_id_util_pct ?? 0) >= 100) regainMin = Math.max(regainMin, Math.ceil((acc.reset_time_duration ?? 60) / 60));
    }
    const app = json("x-app-usage") as { call_count?: number; total_cputime?: number; total_time?: number } | null;
    if (app) pct = Math.max(pct, app.call_count ?? 0, app.total_cputime ?? 0, app.total_time ?? 0);
    this.lastUsagePct = pct;
    const now = this.now();
    if (regainMin > 0) this.cooldownUntil = Math.max(this.cooldownUntil, now + regainMin * 60_000);
    else if (pct >= 90) this.cooldownUntil = Math.max(this.cooldownUntil, now + 60_000);
    else if (pct >= 75) this.cooldownUntil = Math.max(this.cooldownUntil, now + 10_000);
  }

  /** One GET with retries. Returns the parsed JSON body. */
  async get<T = Record<string, unknown>>(path: string, params: GraphParams = {}): Promise<T> {
    const delays = this.opts.retryDelays ?? [5_000, 15_000, 45_000];
    const url = this.url(path, params);
    let last: MetaGraphError | null = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await this.sleep(delays[attempt - 1]);
      await this.coolDown();
      const token = this.token();
      if (!token) throw new MetaTokenMissingError(this.identity);
      const started = this.now();
      let res: GraphResponse | null = null;
      try {
        this.calls++;
        res = await this.transport({
          method: "GET",
          url,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT },
          timeoutMs: this.opts.timeoutMs ?? 120_000,
          signal: this.opts.signal,
        });
      } catch (e) {
        if (this.opts.signal?.aborted) throw new MetaGraphError("Stopped.");
        if (e instanceof MetaGraphError && !e.transient) {
          this.report(path, null, started, e.message);
          throw e;
        }
        last = new MetaGraphError(scrub(`Network error: ${(e as Error).message}`, token).slice(0, 300), null, null, true);
        this.report(path, null, started, last.message);
        continue;
      }
      this.noteUsage(res);
      let body: unknown = null;
      try {
        body = JSON.parse(res.body);
      } catch {
        body = null;
      }
      if (res.status >= 200 && res.status < 300 && body && typeof body === "object" && !(body as ErrorBody).error) {
        this.report(path, res.status, started, null);
        return body as T;
      }
      const err = (body as ErrorBody | null)?.error;
      const code = typeof err?.code === "number" ? err.code : null;
      const transient = TRANSIENT_HTTP.has(res.status) || err?.is_transient === true || (code != null && TRANSIENT_CODES.has(code));
      const message = scrub(
        err?.message ? `Meta ${res.status}${code != null ? ` (#${code}${err.error_subcode ? `/${err.error_subcode}` : ""})` : ""}: ${err.message}` : `Meta HTTP ${res.status}`,
        token,
      ).slice(0, 300);
      last = new MetaGraphError(message, res.status, code, transient);
      this.report(path, res.status, started, message);
      if (!transient) throw last;
      // Rate-limit codes: a longer cool-down before the retry.
      if (code === 17 || code === 4 || code === 613 || code === 80004 || res.status === 429) {
        this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + 60_000);
      }
    }
    throw last ?? new MetaGraphError("Meta request failed.");
  }

  /**
   * Every row of a list edge (`data` arrays), following the `after` cursor on the pinned version. `maxPages` stops a
   * paging bug from spinning forever.
   */
  async getAll<T = Record<string, unknown>>(path: string, params: GraphParams = {}, maxPages = 50): Promise<T[]> {
    const rows: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.get<{ data?: T[]; paging?: { next?: string; cursors?: { after?: string } } }>(path, { ...params, after });
      rows.push(...(Array.isArray(body.data) ? body.data : []));
      const next = body.paging?.next;
      if (!next) break;
      let cursor: string | null = null;
      try {
        const u = new URL(next);
        if (u.hostname === GRAPH_HOST) cursor = u.searchParams.get("after");
      } catch {
        cursor = null;
      }
      cursor = cursor ?? body.paging?.cursors?.after ?? null;
      if (!cursor || cursor === after) break;
      after = cursor;
    }
    return rows;
  }

  private report(path: string, status: number | null, started: number, error: string | null) {
    try {
      this.opts.onCall?.({ identity: this.identity, kind: "graph", path: path || "/", status, ms: Math.max(0, this.now() - started), error });
    } catch {
      /* logging never breaks a read */
    }
  }
}
