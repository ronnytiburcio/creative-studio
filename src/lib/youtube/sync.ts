/**
 * The daily YouTube Shorts sync (worker only, Phase 5 slice 4, PHASE-5 I2). Read only.
 *
 * 1. Data API: the connected channel (`channels?mine=true`: id, title, uploads playlist, start date), every upload's id
 *    (the uploads playlist), then title, publish time, duration, privacy and a thumbnail URL (`videos`, 50 per call).
 *    Every upload is stored (`yt_videos`) with `is_short` = duration <= 180 s; uploads that left the playlist get
 *    `gone_at` (their rows and history stay).
 * 2. Analytics API: lifetime numbers per Short (src/lib/youtube/analytics.ts), stored as today's snapshot in
 *    `yt_metrics` (one row per Short per America/New_York day, upserted; older snapshots are kept for growth).
 * 3. Matching (src/lib/youtube/match.ts) + the matched files' video hooks, then thumbnails: a Short with no matched file
 *    that has a poster gets its YouTube thumbnail downloaded once into STUDIO_CACHE/youtube/ (i.ytimg.com only, 5 MB
 *    cap, sniffed), never hotlinked.
 * Throws YouTubeReconnectError / YouTubeNotConnectedError / YouTubeApiError; the queue records them.
 */
import type Database from "better-sqlite3";
import { getSetting, setSetting } from "../ai/state";
import { addDays, localDate } from "../meta/windows";
import { cacheRemoteImage, type ThumbFetch } from "../meta/thumbs";
import { YouTubeApi } from "./api";
import { ALL_METRICS, shortsAnalytics, type YtMetric } from "./analytics";
import { matchShorts, type ShortMatchStats } from "./match";
import { SHORT_MAX_S, YT_METRICS_FAILED_KEY, YT_METRICS_OK_KEY, YT_MODE_KEY } from "./store";

type Sql = Database.Database;

export const YT_THUMB_DIR = "youtube";
const YT_THUMB_HOST = /(^|\.)ytimg\.com$/i;

/** i.ytimg.com (and other ytimg.com hosts) over https only. */
export function ytThumbAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && YT_THUMB_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export type YtSyncDeps = {
  api: YouTubeApi;
  cacheDir: string;
  fetchThumb?: ThumbFetch;
  now: () => number;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  setCurrent?: (what: string | null) => void;
};

export type YtSyncResult = {
  channel: string;
  videos: number;
  shorts: number;
  gone: number;
  metricsRows: number;
  metricsFailed: YtMetric[];
  mode: "batch" | "single";
  match: ShortMatchStats;
  thumbs: number;
};

const readList = (sql: Sql, key: string): YtMetric[] | null => {
  try {
    const v = JSON.parse(getSetting(sql, key) ?? "null");
    return Array.isArray(v) ? (v.filter((m) => (ALL_METRICS as readonly string[]).includes(m)) as YtMetric[]) : null;
  } catch {
    return null;
  }
};

export async function syncYouTube(sql: Sql, deps: YtSyncDeps): Promise<YtSyncResult> {
  const now = deps.now();
  deps.setCurrent?.("channel");
  const ch = await deps.api.myChannel();
  if (!ch) throw new Error("This Google account has no YouTube channel.");
  sql
    .prepare(
      `insert into yt_channels (channel_id, title, uploads_playlist, published_at, synced_at) values (?, ?, ?, ?, ?)
       on conflict(channel_id) do update set title = excluded.title, uploads_playlist = excluded.uploads_playlist,
         published_at = excluded.published_at, synced_at = excluded.synced_at`,
    )
    .run(ch.id, ch.title, ch.uploads, ch.publishedAt, now);

  deps.setCurrent?.("uploads");
  const ids = ch.uploads ? await deps.api.uploadIds(ch.uploads) : [];
  if (deps.isStopped()) throw new Error("Stopped.");
  const infos = await deps.api.videos(ids);
  const up = sql.prepare(
    `insert into yt_videos (video_id, channel_id, title, published_at, duration_s, is_short, privacy, thumb_url, first_seen_at, last_synced_at, gone_at)
     values (@id, @channel, @title, @published, @duration, @short, @privacy, @thumb, @now, @now, null)
     on conflict(video_id) do update set channel_id = excluded.channel_id, title = excluded.title, published_at = excluded.published_at,
       duration_s = excluded.duration_s, is_short = excluded.is_short, privacy = excluded.privacy, thumb_url = excluded.thumb_url,
       last_synced_at = excluded.last_synced_at, gone_at = null`,
  );
  sql.transaction(() => {
    for (const v of infos) {
      up.run({
        id: v.id,
        channel: ch.id,
        title: v.title,
        published: v.publishedAt,
        duration: v.durationS,
        short: v.durationS != null && v.durationS > 0 && v.durationS <= SHORT_MAX_S ? 1 : 0,
        privacy: v.privacy,
        thumb: v.thumbUrl,
        now,
      });
    }
  })();
  const seen = new Set(infos.map((v) => v.id));
  const stale = (sql.prepare("select video_id from yt_videos where channel_id = ? and gone_at is null").pluck().all(ch.id) as string[]).filter((id) => !seen.has(id));
  const gone = sql.prepare("update yt_videos set gone_at = ? where video_id = ?");
  for (const id of stale) gone.run(now, id);

  // Analytics: every Short of the channel still up, lifetime to yesterday (Pacific, YouTube's reporting day).
  deps.setCurrent?.("analytics");
  const shorts = sql
    .prepare("select video_id, published_at from yt_videos where channel_id = ? and is_short = 1 and gone_at is null order by published_at")
    .all(ch.id) as { video_id: string; published_at: number | null }[];
  const endDate = addDays(localDate(now, "America/Los_Angeles"), -1);
  const oldest = shorts.find((s) => s.published_at != null)?.published_at ?? ch.publishedAt ?? now;
  const startDate = localDate(Math.min(oldest, ch.publishedAt ?? oldest), "America/Los_Angeles");
  let metricsRows = 0;
  let failed: YtMetric[] = [];
  let mode: "batch" | "single" = (getSetting(sql, YT_MODE_KEY) as "batch" | "single" | null) ?? "batch";
  if (shorts.length && startDate <= endDate) {
    const r = await shortsAnalytics(deps.api, shorts.map((s) => s.video_id), { startDate, endDate }, { metrics: readList(sql, YT_METRICS_OK_KEY), mode });
    failed = [...new Set([...(readList(sql, YT_METRICS_FAILED_KEY) ?? []).filter((m) => !r.metrics.includes(m)), ...r.failed])];
    mode = r.mode;
    setSetting(sql, YT_METRICS_OK_KEY, JSON.stringify(r.metrics));
    setSetting(sql, YT_METRICS_FAILED_KEY, JSON.stringify(failed));
    setSetting(sql, YT_MODE_KEY, r.mode);
    const snap = localDate(now, "America/New_York");
    const ins = sql.prepare(
      `insert into yt_metrics (video_id, snapshot_date, start_date, end_date, views, avg_view_pct, avg_view_s, likes, subs_gained, engaged_views, shares, comments, synced_at)
       values (@id, @snap, @start, @end, @views, @pct, @avg, @likes, @subs, @engaged, @shares, @comments, @now)
       on conflict(video_id, snapshot_date) do update set start_date = excluded.start_date, end_date = excluded.end_date, views = excluded.views,
         avg_view_pct = excluded.avg_view_pct, avg_view_s = excluded.avg_view_s, likes = excluded.likes, subs_gained = excluded.subs_gained,
         engaged_views = excluded.engaged_views, shares = excluded.shares, comments = excluded.comments, synced_at = excluded.synced_at`,
    );
    const has = (m: YtMetric) => r.metrics.includes(m);
    sql.transaction(() => {
      for (const [id, n] of r.rows) {
        const val = (m: YtMetric) => (has(m) ? (n[m] ?? 0) : null);
        ins.run({
          id,
          snap,
          start: startDate,
          end: endDate,
          views: val("views"),
          pct: val("averageViewPercentage"),
          avg: val("averageViewDuration"),
          likes: val("likes"),
          subs: val("subscribersGained"),
          engaged: val("engagedViews"),
          shares: val("shares"),
          comments: val("comments"),
          now,
        });
        metricsRows++;
      }
    })();
  }

  deps.setCurrent?.("matching");
  const match = matchShorts(sql, { now });

  // Thumbnails: Shorts with no matched file with a poster, not cached yet (a failure retries next sync).
  deps.setCurrent?.("thumbnails");
  let thumbs = 0;
  const need = sql
    .prepare(
      `select v.video_id, v.thumb_url from yt_videos v left join assets a on a.id = v.matched_asset_id
        where v.is_short = 1 and v.gone_at is null and v.thumb_path is null and v.thumb_url is not null and a.thumb_path is null`,
    )
    .all() as { video_id: string; thumb_url: string }[];
  for (const t of need) {
    if (deps.isStopped()) break;
    try {
      const rel = await cacheRemoteImage(deps.cacheDir, { dir: YT_THUMB_DIR, name: t.video_id, url: t.thumb_url, allowed: ytThumbAllowed, fetcher: deps.fetchThumb, what: "YouTube's image host" });
      sql.prepare("update yt_videos set thumb_path = ?, thumb_error = null where video_id = ?").run(rel, t.video_id);
      thumbs++;
    } catch (e) {
      sql.prepare("update yt_videos set thumb_error = ? where video_id = ?").run(((e as Error).message || "thumbnail failed").slice(0, 200), t.video_id);
    }
  }
  deps.setCurrent?.(null);
  return { channel: ch.title, videos: infos.length, shorts: shorts.length, gone: stale.length, metricsRows, metricsFailed: failed, mode, match, thumbs };
}
