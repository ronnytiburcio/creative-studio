/**
 * YouTube Data API v3 + YouTube Analytics API v2 reader (worker only, Phase 5 slice 4). READ ONLY: GET requests to
 * www.googleapis.com/youtube/v3 and youtubeanalytics.googleapis.com/v2 only (the transport refuses anything else).
 *
 * - The access token comes from src/lib/youtube/auth.ts (`getToken`, refreshed there) and is sent in the Authorization
 *   header only; a 401 forces one refresh and one retry. Never in a URL, the DB, a log line or an error message.
 * - Retries 429 / 5xx / network errors with backoff (5, 15, 45 s). A 403 quota error is not retried (the queue waits).
 * - Every request is reported through `onCall` (kind, path without query, status, ms, a short scrubbed error).
 * - Error text (what is stored in `yt_calls`, `youtube:error` and logs) is Google's short error code / reason + the HTTP
 *   status only ("YouTube 400 (badRequest)"), never Google's `error.message`. The message is kept on the error object in
 *   memory only (`detail`, scrubbed, 300 chars) so analytics.ts can find a refused metric's name; it is never stored.
 *
 * Tests inject a stub transport; they never reach Google.
 */
import type { YtCallLog } from "./auth";

export const DATA_HOST = "www.googleapis.com";
export const ANALYTICS_HOST = "youtubeanalytics.googleapis.com";

export type YtRequest = { method: "GET"; url: string; headers: Record<string, string>; timeoutMs: number; signal?: AbortSignal };
export type YtResponse = { status: number; body: string };
export type YtTransport = (req: YtRequest) => Promise<YtResponse>;

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly reason: string | null = null,
    /** Google's own error message (scrubbed), in memory only: read to find a refused metric name, never stored. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

/** GET only, the two Google API hosts only, no redirects. */
export const httpYtTransport: YtTransport = async (req) => {
  if (req.method !== "GET") throw new YouTubeApiError("Studio only reads from YouTube: GET requests only.");
  const u = new URL(req.url);
  if (u.protocol !== "https:" || (u.hostname !== DATA_HOST && u.hostname !== ANALYTICS_HOST)) throw new YouTubeApiError("Studio only calls the YouTube Data and Analytics APIs.");
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const res = await fetch(u, { method: "GET", headers: req.headers, signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout, redirect: "error" });
  return { status: res.status, body: await res.text() };
};

export type YouTubeApiOptions = {
  /** A valid access token (force = refresh first, after a 401). */
  getToken: (force?: boolean) => Promise<string>;
  transport?: YtTransport;
  onCall?: (c: YtCallLog) => void;
  sleep?: (ms: number) => Promise<void>;
  retryDelays?: number[];
  /** Removes the tokens from Google's error text (required: auth.ts scrubTokens in the worker). */
  scrub: (s: string) => string;
  signal?: AbortSignal;
};

type ErrBody = { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };

/** ISO 8601 duration ("PT1M5S", "P0D", "PT59.5S") -> seconds; null when unreadable. */
export function isoDurationS(d: unknown): number | null {
  if (typeof d !== "string") return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d);
  if (!m || d === "P" || d.endsWith("T")) return null;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export class YouTubeApi {
  private readonly transport: YtTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  calls = 0;

  constructor(private readonly opts: YouTubeApiOptions) {
    this.transport = opts.transport ?? httpYtTransport;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One GET (retries, one forced refresh on 401). Returns the parsed JSON body. */
  async get<T = Record<string, unknown>>(kind: "data" | "analytics", pathname: string, params: Record<string, string | number | undefined>): Promise<T> {
    const host = kind === "data" ? DATA_HOST : ANALYTICS_HOST;
    const base = kind === "data" ? "/youtube/v3/" : "/v2/";
    if (!/^[a-zA-Z]+$/.test(pathname)) throw new YouTubeApiError("Bad YouTube API path.");
    const u = new URL(`https://${host}${base}${pathname}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    if (u.searchParams.has("access_token") || u.searchParams.has("key")) throw new YouTubeApiError("Credentials never go in a URL.");
    const delays = this.opts.retryDelays ?? [5_000, 15_000, 45_000];
    const scrub = this.opts.scrub;
    let forced = false;
    let last: YouTubeApiError | null = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0 && last?.status !== 401) await this.sleep(delays[attempt - 1]);
      const token = await this.opts.getToken(forced);
      const started = Date.now();
      let res: YtResponse;
      try {
        this.calls++;
        res = await this.transport({ method: "GET", url: u.toString(), headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, timeoutMs: 60_000, signal: this.opts.signal });
      } catch (e) {
        if (this.opts.signal?.aborted) throw new YouTubeApiError("Stopped.");
        if (e instanceof YouTubeApiError) throw e;
        last = new YouTubeApiError("Network error talking to YouTube.", null, "network");
        this.report(kind, base + pathname, null, started, last.message);
        continue;
      }
      let body: unknown = null;
      try {
        body = JSON.parse(res.body);
      } catch {
        body = null;
      }
      if (res.status >= 200 && res.status < 300 && body && typeof body === "object") {
        this.report(kind, base + pathname, res.status, started, null);
        return body as T;
      }
      const err = (body as ErrBody | null)?.error;
      const rawReason = err?.errors?.[0]?.reason ?? err?.status ?? null;
      const reason = typeof rawReason === "string" && /^[A-Za-z_]{1,64}$/.test(rawReason) ? rawReason : null;
      const message = `YouTube ${res.status}${reason ? ` (${reason})` : ""}`;
      const detail = typeof err?.message === "string" ? scrub(err.message).replace(/\s+/g, " ").slice(0, 300) : null;
      last = new YouTubeApiError(message, res.status, reason, detail);
      this.report(kind, base + pathname, res.status, started, message);
      if (res.status === 401 && !forced) {
        forced = true;
        continue;
      }
      if (res.status === 429 || res.status >= 500) continue;
      throw last;
    }
    throw last ?? new YouTubeApiError("YouTube request failed.");
  }

  private report(kind: "data" | "analytics", p: string, status: number | null, started: number, error: string | null) {
    try {
      this.opts.onCall?.({ kind, path: p, status, ms: Math.max(0, Date.now() - started), error });
    } catch {
      /* logging never breaks a read */
    }
  }

  // ---------------------------------------------------------------- Data API

  async myChannel(): Promise<{ id: string; title: string; uploads: string | null; publishedAt: number | null } | null> {
    const b = await this.get<{ items?: { id?: string; snippet?: { title?: string; publishedAt?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(
      "data",
      "channels",
      { part: "snippet,contentDetails", mine: "true", maxResults: 1 },
    );
    const c = b.items?.[0];
    if (!c?.id) return null;
    const pub = c.snippet?.publishedAt ? Date.parse(c.snippet.publishedAt) : NaN;
    return { id: c.id, title: c.snippet?.title ?? c.id, uploads: c.contentDetails?.relatedPlaylists?.uploads ?? null, publishedAt: Number.isFinite(pub) ? pub : null };
  }

  /** Every video id in the uploads playlist (paged, 50 a page, capped at 100 pages). */
  async uploadIds(playlistId: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const b = await this.get<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>("data", "playlistItems", {
        part: "contentDetails",
        playlistId,
        maxResults: 50,
        pageToken,
      });
      for (const it of b.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
      if (!b.nextPageToken || b.nextPageToken === pageToken) break;
      pageToken = b.nextPageToken;
    }
    return [...new Set(ids)];
  }

  /** Title, publish time, duration, privacy and a thumbnail URL per video (50 ids per call). */
  async videos(ids: string[]): Promise<YtVideoInfo[]> {
    const out: YtVideoInfo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const b = await this.get<{
        items?: {
          id?: string;
          snippet?: { title?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string } | undefined> };
          contentDetails?: { duration?: string };
          status?: { privacyStatus?: string };
        }[];
      }>("data", "videos", { part: "snippet,contentDetails,status", id: ids.slice(i, i + 50).join(","), maxResults: 50 });
      for (const v of b.items ?? []) {
        if (!v.id) continue;
        const pub = v.snippet?.publishedAt ? Date.parse(v.snippet.publishedAt) : NaN;
        const th = v.snippet?.thumbnails;
        out.push({
          id: v.id,
          title: v.snippet?.title ?? "",
          publishedAt: Number.isFinite(pub) ? pub : null,
          durationS: isoDurationS(v.contentDetails?.duration),
          privacy: v.status?.privacyStatus ?? null,
          thumbUrl: th?.high?.url ?? th?.medium?.url ?? th?.default?.url ?? null,
        });
      }
    }
    return out;
  }
}

export type YtVideoInfo = { id: string; title: string; publishedAt: number | null; durationS: number | null; privacy: string | null; thumbUrl: string | null };
