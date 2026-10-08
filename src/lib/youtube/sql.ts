/**
 * Shared SQL fragments for YouTube Shorts (Phase 5 slice 4; no imports).
 *
 * The Short -> hook link is DERIVED, not stored: a Short's hook = the video hook of the Lane A file it is matched to
 * (`yt_videos.matched_asset_id` -> `hooks.asset_id`, kind video, top level). So a relink, an unlink or a video hook the
 * worker creates later is reflected at once, and nothing can go stale. Archived hooks keep their link (their Short really
 * ran); a file whose hook does not exist yet has no link until the hook is created (the sync and "Link a file" create it
 * through addVideoHook when the file is described).
 */

/** (hook_id, video_id) for every Short whose matched file has a video hook. Use as `${SHORT_HOOK_JOIN} sh`. */
export const SHORT_HOOK_JOIN = `(select h.id as hook_id, v.video_id
    from yt_videos v join hooks h on h.asset_id = v.matched_asset_id and h.kind = 'video' and h.parent_id is null
   where v.is_short = 1 and v.gone_at is null and v.matched_asset_id is not null)`;

/** The latest snapshot per video (its "numbers"). Use as `${LATEST_YT_METRICS} m`. */
export const LATEST_YT_METRICS = `(select * from yt_metrics x
   where x.snapshot_date = (select max(y.snapshot_date) from yt_metrics y where y.video_id = x.video_id))`;
