/**
 * YouTube Shorts sync queue (worker only, Phase 5 slice 4, PHASE-5 I2). Reads (never writes) the connected Lane A channel:
 * once a day at 06:00 America/New_York (the Meta sync runs at 18:00; also right after a worker start when the last good sync
 * is older than the latest 06:00), and on "Sync now" (`youtube:sync_requested_at`, runs even while paused). Pause
 * (`youtube:paused`) holds the daily run. No jobs rows: the Jobs page shows one summary row plus the last error.
 *
 * The access token is refreshed here (src/lib/youtube/auth.ts getAccessToken, the token file only); a refused refresh
 * sets "Reconnect needed" and the queue waits until the owner reconnects (a new token clears it). Not connected = "off"
 * with nothing to do. Every request lands in `yt_calls` (path only), pruned after 30 days.
 */
import type Database from "better-sqlite3";
import { setSetting } from "../lib/ai/state";
import { getAccessToken, scrubTokens, youtubeKeyStatus, YouTubeNotConnectedError, YouTubeReconnectError, type OAuthTransport, type YtCallLog } from "../lib/youtube/auth";
import { YouTubeApi, type YtTransport } from "../lib/youtube/api";
import { syncYouTube, type YtSyncResult } from "../lib/youtube/sync";
import type { ThumbFetch } from "../lib/meta/thumbs";
import {
  setReconnectNeeded,
  YT_ERROR_KEY,
  YT_LAST_ATTEMPT_KEY,
  YT_LAST_SYNC_KEY,
  YT_RECONNECT_KEY,
  YT_RUN_FINISHED_KEY,
  YT_RUN_STARTED_KEY,
  ytPaused,
  ytRequestPending,
  ytScheduleDue,
} from "../lib/youtube/store";
import { getSetting } from "../lib/ai/state";
import type { StudioConfig } from "../lib/config";

export type YtQueueState = "running" | "idle" | "paused" | "waiting" | "off";

export type YouTubeSyncQueueOptions = {
  cfg: Pick<StudioConfig, "youtubeClientSecretFile" | "youtubeTokenFile" | "port" | "cacheDir">;
  /** Stubs in the smoke test; the real transports otherwise. */
  oauthTransport?: OAuthTransport;
  apiTransport?: YtTransport;
  fetchThumb?: ThumbFetch;
  retryDelays?: number[];
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  now?: () => number;
  pollMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CALL_LOG_DAYS = 30;

export class YouTubeSyncQueue {
  state: YtQueueState = "idle";
  current: string | null = null;
  note: string | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private insCall: Database.Statement;

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: YouTubeSyncQueueOptions,
  ) {
    this.insCall = sql.prepare("insert into yt_calls (at, kind, path, status, ms, error) values (?, ?, ?, ?, ?, ?)");
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }
  private isStopped() {
    return this.stopped || this.opts.isStopped();
  }
  private logCall = (c: YtCallLog) => {
    try {
      this.insCall.run(Date.now(), c.kind, c.path.slice(0, 200), c.status, c.ms, c.error ? scrubTokens(c.error, this.opts.cfg).slice(0, 200) : null);
    } catch {
      /* logging never breaks a read */
    }
  };

  /** Why nothing can run (not connected / reconnect needed), else null. */
  blocked(): string | null {
    const k = youtubeKeyStatus(this.opts.cfg);
    if (!k.connected) return "Not connected: Connect YouTube in Settings.";
    if (getSetting(this.sql, YT_RECONNECT_KEY) != null) return "Reconnect needed: Google refused the token.";
    return null;
  }

  /** What is due now: a Sync now request, else the daily schedule (none while paused, not connected or blocked). */
  due(): "request" | "schedule" | null {
    if (this.blocked()) return null;
    if (ytRequestPending(this.sql)) return "request";
    if (ytPaused(this.sql)) return null;
    return ytScheduleDue(this.sql, this.now()) ? "schedule" : null;
  }

  /** One sync. Never throws. */
  async runOnce(reason: "request" | "schedule"): Promise<YtSyncResult | null> {
    const started = this.now();
    setSetting(this.sql, YT_RUN_STARTED_KEY, String(started));
    setSetting(this.sql, YT_LAST_ATTEMPT_KEY, String(started));
    this.sql.prepare("delete from yt_calls where at < ?").run(started - CALL_LOG_DAYS * 86_400_000);
    this.state = "running";
    this.note = null;
    this.opts.log(`youtube: ${reason} sync`);
    const api = new YouTubeApi({
      getToken: (force) => getAccessToken(this.opts.cfg, { transport: this.opts.oauthTransport, now: () => this.now(), force, onCall: this.logCall }),
      transport: this.opts.apiTransport,
      onCall: this.logCall,
      retryDelays: this.opts.retryDelays,
      scrub: (s) => scrubTokens(s, this.opts.cfg),
    });
    let result: YtSyncResult | null = null;
    try {
      result = await syncYouTube(this.sql, {
        api,
        cacheDir: this.opts.cfg.cacheDir,
        fetchThumb: this.opts.fetchThumb,
        now: () => this.now(),
        log: this.opts.log,
        isStopped: () => this.isStopped(),
        setCurrent: (w) => (this.current = w),
      });
      setSetting(this.sql, YT_LAST_SYNC_KEY, String(this.now()));
      this.sql.prepare("delete from app_settings where key = ?").run(YT_ERROR_KEY);
      this.opts.log(
        `youtube: ${result.channel}: ${result.videos} uploads, ${result.shorts} Shorts, ${result.metricsRows} metric rows (${result.mode}` +
          `${result.metricsFailed.length ? `, refused: ${result.metricsFailed.join(", ")}` : ""}), match ${JSON.stringify(result.match)}, ${result.thumbs} thumbs`,
      );
    } catch (e) {
      const msg = scrubTokens((e as Error).message || "YouTube sync failed", this.opts.cfg).slice(0, 300);
      if (e instanceof YouTubeReconnectError) setReconnectNeeded(this.sql, true, this.now());
      if (!(e instanceof YouTubeNotConnectedError)) setSetting(this.sql, YT_ERROR_KEY, msg);
      this.opts.log(`youtube: error: ${msg}`);
    }
    this.current = null;
    setSetting(this.sql, YT_RUN_FINISHED_KEY, String(this.now()));
    this.state = this.stateNow();
    return result;
  }

  private stateNow(): YtQueueState {
    const b = this.blocked();
    if (b) {
      this.note = b;
      return b.startsWith("Not connected") ? "off" : "waiting";
    }
    this.note = null;
    return ytPaused(this.sql) ? "paused" : "idle";
  }

  /** Run whatever is due now (smoke tests). */
  async drain(): Promise<YtSyncResult | null> {
    const d = this.due();
    return d ? this.runOnce(d) : null;
  }

  private async worker(pollMs: number) {
    while (!this.isStopped()) {
      let d: ReturnType<YouTubeSyncQueue["due"]> = null;
      try {
        d = this.due();
      } catch (e) {
        this.opts.log("youtube: due check error", (e as Error).message);
      }
      if (d) {
        await this.runOnce(d);
        continue;
      }
      this.state = this.stateNow();
      await sleep(pollMs);
    }
  }

  start() {
    if (this.loop) return;
    this.state = this.stateNow();
    this.loop = this.worker(this.opts.pollMs ?? 15_000);
  }

  async stop() {
    this.stopped = true;
    this.state = "off";
    if (this.loop) await Promise.race([this.loop, sleep(5_000)]);
  }
}
