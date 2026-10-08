/**
 * YouTube Shorts state shared by the app (server actions, status, Settings, Jobs, the Lane A Shorts tab, hook rows) and the
 * worker (server only). The web process never calls the Data / Analytics APIs: it only sets a request / pause in
 * app_settings and edits the owner's manual Short -> file links; the worker's YouTubeSyncQueue does every read.
 *
 * Schedule: once a day at 06:00 America/New_York (YT_SYNC_HOUR; the Meta sync moved to 18:00 on 2026-10-06; due when the last good sync is older than the
 * latest 06:00, a failure retried at most hourly), on worker start when stale, plus "Sync now"
 * (`youtube:sync_requested_at`, runs even while paused), minus Pause (`youtube:paused`).
 */
import type Database from "better-sqlite3";
import { getSetting, setSetting } from "../ai/state";
import { numSetting, pausedSetting, requestPending, setPausedSetting, stampRequest } from "../queue-settings";
import { localDayStart } from "../ai/jev";
import { lastSlot, nextSlot, RETRY_MS, SYNC_TZ } from "../meta/store";

/** YouTube's daily sync hour (New York wall clock); Analytics reports through yesterday, so the morning is enough. */
export const YT_SYNC_HOUR = 6;
import type { YouTubeKeyStatus } from "./auth";
import { SHORT_HOOK_JOIN, LATEST_YT_METRICS } from "./sql";

type Sql = Database.Database;

export const YT_PAUSED_KEY = "youtube:paused";
export const YT_REQUEST_KEY = "youtube:sync_requested_at";
export const YT_RUN_STARTED_KEY = "youtube:last_run_started_at";
export const YT_RUN_FINISHED_KEY = "youtube:last_run_finished_at";
export const YT_LAST_SYNC_KEY = "youtube:last_sync_at";
export const YT_LAST_ATTEMPT_KEY = "youtube:last_attempt_at";
export const YT_ERROR_KEY = "youtube:error";
/** Set when Google refused the refresh token (revoked / consent ended): "Reconnect needed". Cleared by a new connect. */
export const YT_RECONNECT_KEY = "youtube:reconnect_needed";
export const YT_METRICS_OK_KEY = "youtube:metrics_ok";
export const YT_METRICS_FAILED_KEY = "youtube:metrics_failed";
export const YT_MODE_KEY = "youtube:analytics_mode";

/** A Short = an upload of at most 3 minutes (YouTube allows Shorts up to 180 s since 2024-10; the API has no Shorts flag). */
export const SHORT_MAX_S = 180;

const num = numSetting;

export function ytPaused(sql: Sql): boolean {
  return pausedSetting(sql, YT_PAUSED_KEY);
}
export function setYtPaused(sql: Sql, paused: boolean) {
  setPausedSetting(sql, YT_PAUSED_KEY, paused);
}
export function requestYtSync(sql: Sql, now = Date.now()) {
  stampRequest(sql, YT_REQUEST_KEY, now);
}
export function ytRequestPending(sql: Sql): boolean {
  return requestPending(sql, YT_REQUEST_KEY, YT_RUN_STARTED_KEY);
}

/** The daily schedule wants a run now (stale since the latest 06:00, not tried in the last hour). */
export function ytScheduleDue(sql: Sql, now = Date.now()): boolean {
  const slot = lastSlot(now, YT_SYNC_HOUR);
  const good = num(sql, YT_LAST_SYNC_KEY) ?? 0;
  const tried = num(sql, YT_LAST_ATTEMPT_KEY) ?? 0;
  return good < slot && (tried < slot || tried <= now - RETRY_MS);
}

export function setReconnectNeeded(sql: Sql, on: boolean, now = Date.now()) {
  if (on) setSetting(sql, YT_RECONNECT_KEY, String(now));
  else sql.prepare("delete from app_settings where key = ?").run(YT_RECONNECT_KEY);
}

export type YtSummary = {
  /** Booleans only (never a value): client file, connected, scopes, private token file. */
  keys: YouTubeKeyStatus;
  reconnectNeeded: boolean;
  paused: boolean;
  requested: boolean;
  lastSyncAt: number | null;
  lastRunFinishedAt: number | null;
  nextRunAt: number;
  error: string | null;
  channelTitle: string | null;
  videos: number;
  shorts: number;
  matched: number;
  callsToday: number;
  /** Metrics the Analytics API refused (stay empty). */
  metricsFailed: string[];
};

export function ytSummary(sql: Sql, keys: YouTubeKeyStatus, now = Date.now()): YtSummary {
  const ch = sql.prepare("select title from yt_channels order by synced_at desc limit 1").get() as { title: string | null } | undefined;
  const c = sql
    .prepare(
      `select count(*) as videos, coalesce(sum(is_short), 0) as shorts, coalesce(sum(is_short and matched_asset_id is not null), 0) as matched
         from yt_videos where gone_at is null`,
    )
    .get() as { videos: number; shorts: number; matched: number };
  let failed: string[] = [];
  try {
    const v = JSON.parse(getSetting(sql, YT_METRICS_FAILED_KEY) ?? "[]");
    failed = Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    failed = [];
  }
  return {
    keys,
    reconnectNeeded: getSetting(sql, YT_RECONNECT_KEY) != null,
    paused: ytPaused(sql),
    requested: ytRequestPending(sql),
    lastSyncAt: num(sql, YT_LAST_SYNC_KEY),
    lastRunFinishedAt: num(sql, YT_RUN_FINISHED_KEY),
    nextRunAt: nextSlot(now, YT_SYNC_HOUR),
    error: getSetting(sql, YT_ERROR_KEY),
    channelTitle: ch?.title ?? null,
    videos: c.videos,
    shorts: c.shorts,
    matched: c.matched,
    callsToday: sql.prepare("select count(*) from yt_calls where at >= ?").pluck().get(localDayStart(now, SYNC_TZ)) as number,
    metricsFailed: failed,
  };
}

// ---------------------------------------------------------------- the Lane A Shorts section

import { SHORT_SORTS, SHORT_SORT_LABEL, type ShortSort } from "./sorts";
export { SHORT_SORTS, SHORT_SORT_LABEL, type ShortSort };

export type ShortRow = {
  videoId: string;
  title: string;
  publishedAt: number | null;
  durationS: number | null;
  privacy: string | null;
  /** /api/youtube/thumb/<id> (cached), or the matched file's poster; null = none yet. */
  thumb: string | null;
  views: number | null;
  avgViewPct: number | null;
  avgViewS: number | null;
  likes: number | null;
  subsGained: number | null;
  engagedViews: number | null;
  /** Day the numbers were read (latest snapshot). */
  snapshotDate: string | null;
  file: { assetId: number; filename: string; source: "auto" | "manual"; detail: string | null; hasThumb: boolean; v: string } | null;
  hook: { id: number; overall: number | null; archived: boolean; href: string } | null;
};

type RawShort = {
  video_id: string;
  title: string;
  published_at: number | null;
  duration_s: number | null;
  privacy: string | null;
  thumb_path: string | null;
  views: number | null;
  avg_view_pct: number | null;
  avg_view_s: number | null;
  likes: number | null;
  subs_gained: number | null;
  engaged_views: number | null;
  snapshot_date: string | null;
  asset_id: number | null;
  filename: string | null;
  match_source: "auto" | "manual" | null;
  match_detail: string | null;
  a_thumb: string | null;
  a_sha: string | null;
  hook_id: number | null;
  hook_archived: number | null;
  overall: number | null;
};

const ORDER: Record<ShortSort, string> = {
  newest: "v.published_at desc, v.video_id",
  views: "coalesce(m.views, -1) desc, v.published_at desc",
  viewed: "coalesce(m.avg_view_pct, -1) desc, v.published_at desc",
};

/** Every Short (newest first by default), its latest numbers, the linked file and that file's hook. */
export function shortsList(sql: Sql, sort: ShortSort = "newest", hookId: number | null = null): ShortRow[] {
  const rows = sql
    .prepare(
      `select v.video_id, v.title, v.published_at, v.duration_s, v.privacy, v.thumb_path,
              m.views, m.avg_view_pct, m.avg_view_s, m.likes, m.subs_gained, m.engaged_views, m.snapshot_date,
              a.id as asset_id, a.filename, v.match_source, v.match_detail, a.thumb_path as a_thumb, a.sha256 as a_sha,
              h.id as hook_id, h.archived_at as hook_archived,
              (select hs.overall from hook_scores hs where hs.hook_id = h.id order by hs.rubric_version desc limit 1) as overall
         from yt_videos v
         left join ${LATEST_YT_METRICS} m on m.video_id = v.video_id
         left join assets a on a.id = v.matched_asset_id
         left join hooks h on h.asset_id = a.id and h.kind = 'video' and h.parent_id is null
        where v.is_short = 1 and v.gone_at is null and (@hook is null or h.id = @hook)
        order by ${ORDER[sort]}`,
    )
    .all({ hook: hookId }) as RawShort[];
  return rows.map((r) => ({
    videoId: r.video_id,
    title: r.title,
    publishedAt: r.published_at,
    durationS: r.duration_s,
    privacy: r.privacy,
    thumb: r.thumb_path ? `/api/youtube/thumb/${r.video_id}` : r.asset_id && r.a_thumb ? `/api/media/${r.asset_id}/thumb?v=${(r.a_sha ?? "").slice(0, 8)}` : null,
    views: r.views,
    avgViewPct: r.avg_view_pct,
    avgViewS: r.avg_view_s,
    likes: r.likes,
    subsGained: r.subs_gained,
    engagedViews: r.engaged_views,
    snapshotDate: r.snapshot_date,
    file:
      r.asset_id != null
        ? { assetId: r.asset_id, filename: r.filename ?? "", source: r.match_source === "manual" ? "manual" : "auto", detail: r.match_detail, hasThumb: Boolean(r.a_thumb), v: (r.a_sha ?? "").slice(0, 8) }
        : null,
    hook:
      r.hook_id != null
        ? { id: r.hook_id, overall: r.overall, archived: r.hook_archived != null, href: `/rtm/hooks?view=video${r.hook_archived != null ? "&archived=1" : ""}&focus=${r.hook_id}` }
        : null,
  }));
}

/** The cached thumbnail of a Short (relative to STUDIO_CACHE), or null. */
export function shortThumbPath(sql: Sql, videoId: string): string | null {
  return (sql.prepare("select thumb_path from yt_videos where video_id = ?").pluck().get(videoId) as string | null | undefined) ?? null;
}

// ---------------------------------------------------------------- numbers beside a hook (Lane A Hooks tab)

export type HookShortStats = {
  shorts: number;
  views: number;
  /** Views-weighted average % viewed over the linked Shorts (null = none known). */
  avgViewPct: number | null;
  likes: number;
  subsGained: number;
  href: string;
};

/** The Shorts carrying each hook (through its file), summed: views, views-weighted avg % viewed, likes, subs. */
export function hookShortStats(sql: Sql, hookIds: number[]): Map<number, HookShortStats> {
  const out = new Map<number, HookShortStats>();
  if (!hookIds.length) return out;
  const rows = sql
    .prepare(
      `select sh.hook_id, sh.video_id, m.views, m.avg_view_pct, m.likes, m.subs_gained
         from ${SHORT_HOOK_JOIN} sh left join ${LATEST_YT_METRICS} m on m.video_id = sh.video_id
        where sh.hook_id in (select value from json_each(?))`,
    )
    .all(JSON.stringify(hookIds)) as { hook_id: number; video_id: string; views: number | null; avg_view_pct: number | null; likes: number | null; subs_gained: number | null }[];
  const by = new Map<number, typeof rows>();
  for (const r of rows) by.set(r.hook_id, [...(by.get(r.hook_id) ?? []), r]);
  for (const [id, list] of by) {
    let views = 0,
      weighted = 0,
      weight = 0,
      likes = 0,
      subs = 0;
    for (const r of list) {
      views += r.views ?? 0;
      likes += r.likes ?? 0;
      subs += r.subs_gained ?? 0;
      if (r.avg_view_pct != null && (r.views ?? 0) > 0) {
        weighted += r.avg_view_pct * (r.views ?? 0);
        weight += r.views ?? 0;
      }
    }
    out.set(id, { shorts: list.length, views, avgViewPct: weight > 0 ? weighted / weight : null, likes, subsGained: subs, href: `/rtm/shorts?hook=${id}#shorts` });
  }
  return out;
}
