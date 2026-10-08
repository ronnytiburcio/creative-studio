/**
 * Matching Shorts to Lane A files (Phase 5 slice 4, PHASE-5 I2; server only, SQL only).
 *
 * Automatic (every sync): the Short's normalized title equals a Lane A video's normalized file name stem AND their
 * durations are within 1.5 s. Only a unique match links (copies of the same file, i.e. one fingerprint, count as one:
 * the lowest id); two different files = ambiguous = no link. Normalizing: lower case, hashtags (#shorts) dropped,
 * punctuation / _ / - as spaces, version and copy suffixes dropped (" v2", "_v3", "(1)", " copy", " final").
 * Manual ("Link a file" / Unlink): the owner's link (`match_source` manual) is never overwritten by a sync; Unlink returns
 * the Short to the automatic rule at once.
 * The matched file's video hook becomes the Short's hook (derived, src/lib/youtube/sql.ts); when the file has none yet and
 * is described, one is created through the Phase 4 `addVideoHook` path (source asset). An archived hook is linked as is,
 * never restored.
 */
import type Database from "better-sqlite3";
import { ensureVideoHook } from "../hooks/video";
import { laneNames } from "../clients-admin";
import { linkedByText } from "../profile";

type Sql = Database.Database;

export const DURATION_TOLERANCE_S = 1.5;

/** Title / file stem -> comparison key. */
export function normTitle(s: string): string {
  let t = s.normalize("NFKD").toLowerCase();
  t = t.replace(/\.(mp4|mov|m4v|webm|mkv)$/i, "");
  t = t.replace(/#[\p{L}\p{N}_]+/gu, " ");
  t = t.replace(/\(\s*\d{1,3}\s*\)/g, " ");
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // Trailing version / copy words, repeatedly ("final v2 copy").
  for (;;) {
    const next = t.replace(/(?:^|\s)(?:v\d{1,3}|version\s?\d{1,3}|copy|final|edit(?:ed)?|export)$/, "").trim();
    if (next === t) break;
    t = next;
  }
  return t.replace(/\s+/g, " ");
}

const stem = (filename: string) => filename.replace(/\.[^.]+$/, "");

type Cand = { id: number; filename: string; duration_s: number | null; sha256: string | null };

/** Lane A videos that can be linked (visible, enabled root). */
function rtmVideos(sql: Sql): Cand[] {
  return sql
    .prepare(
      `select a.id, a.filename, a.duration_s, a.sha256 from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
        where s.key = 'rtm' and a.kind = 'video' and a.missing = 0 and a.ignored = 0 and r.enabled = 1`,
    )
    .all() as Cand[];
}

export type ShortMatchStats = { auto: number; manual: number; ambiguous: number; none: number; hooksCreated: number };

/** The automatic match for every Short without a manual link (or only `onlyVideoIds`). Idempotent. */
export function matchShorts(sql: Sql, opts: { onlyVideoIds?: string[]; now?: number } = {}): ShortMatchStats {
  const stats: ShortMatchStats = { auto: 0, manual: 0, ambiguous: 0, none: 0, hooksCreated: 0 };
  const byKey = new Map<string, Cand[]>();
  for (const c of rtmVideos(sql)) {
    const k = normTitle(stem(c.filename));
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  const shorts = sql
    .prepare(
      `select v.video_id, v.title, v.duration_s, v.matched_asset_id, v.match_source from yt_videos v
        where v.is_short = 1 and v.gone_at is null ${opts.onlyVideoIds ? "and v.video_id in (select value from json_each(@ids))" : ""}`,
    )
    .all(opts.onlyVideoIds ? { ids: JSON.stringify(opts.onlyVideoIds) } : {}) as {
    video_id: string;
    title: string;
    duration_s: number | null;
    matched_asset_id: number | null;
    match_source: string | null;
  }[];
  const set = sql.prepare("update yt_videos set matched_asset_id = ?, match_source = ?, match_detail = ? where video_id = ?");
  for (const s of shorts) {
    if (s.match_source === "manual") {
      // A manual link whose file vanished stays manual (the owner unlinks it); only a still-visible file gets its hook.
      stats.manual++;
      if (s.matched_asset_id != null && ensureVideoHook(sql, s.matched_asset_id, opts.now)) stats.hooksCreated++;
      continue;
    }
    const key = normTitle(s.title);
    const hits = (byKey.get(key) ?? []).filter(
      (c) => s.duration_s != null && c.duration_s != null && Math.abs(c.duration_s - s.duration_s) <= DURATION_TOLERANCE_S,
    );
    const files = new Map<string, Cand>();
    for (const h of hits) {
      const key = h.sha256 ?? `id:${h.id}`;
      const prev = files.get(key);
      if (!prev || h.id < prev.id) files.set(key, h);
    }
    if (files.size === 1) {
      const c = [...files.values()][0];
      const dd = Math.abs((c.duration_s ?? 0) - (s.duration_s ?? 0));
      set.run(c.id, "auto", `Title matches ${c.filename}, duration within ${dd.toFixed(1)} s`, s.video_id);
      stats.auto++;
      if (ensureVideoHook(sql, c.id, opts.now)) stats.hooksCreated++;
    } else {
      set.run(null, null, files.size > 1 ? `${files.size} files match the title and duration` : null, s.video_id);
      if (files.size > 1) stats.ambiguous++;
      else stats.none++;
    }
  }
  return stats;
}


export class ShortLinkError extends Error {}

/** "Link a file": the owner's link (manual, kept across syncs). The file must be a visible Lane A video. */
export function linkShort(sql: Sql, videoId: string, assetId: number, now = Date.now()): { filename: string; hookCreated: boolean } {
  const v = sql.prepare("select video_id from yt_videos where video_id = ? and is_short = 1").get(videoId);
  if (!v) throw new ShortLinkError("Short not found.");
  const a = sql
    .prepare(
      `select a.id, a.filename from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
        where a.id = ? and s.key = 'rtm' and a.kind = 'video' and a.missing = 0 and a.ignored = 0 and r.enabled = 1`,
    )
    .get(assetId) as { id: number; filename: string } | undefined;
  if (!a) throw new ShortLinkError(`Pick a video from the ${laneNames(sql).rtm} Library.`);
  sql.prepare("update yt_videos set matched_asset_id = ?, match_source = 'manual', match_detail = ? where video_id = ?").run(a.id, linkedByText(), videoId);
  return { filename: a.filename, hookCreated: ensureVideoHook(sql, a.id, now) };
}

/** Unlink a manual link: back to the automatic rule at once. Only manual links can be unlinked. */
export function unlinkShort(sql: Sql, videoId: string, now = Date.now()): { rematched: boolean } {
  const v = sql.prepare("select match_source from yt_videos where video_id = ?").get(videoId) as { match_source: string | null } | undefined;
  if (!v) throw new ShortLinkError("Short not found.");
  if (v.match_source !== "manual") throw new ShortLinkError("Only a file you linked can be unlinked.");
  sql.prepare("update yt_videos set matched_asset_id = null, match_source = null, match_detail = null where video_id = ?").run(videoId);
  matchShorts(sql, { onlyVideoIds: [videoId], now });
  return { rematched: sql.prepare("select matched_asset_id from yt_videos where video_id = ?").pluck().get(videoId) != null };
}
