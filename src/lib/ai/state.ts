/**
 * Describe queue state shared by the app (server actions, status, Settings) and the worker (server only).
 * The queue is a pull model over `assets` (no jobs rows): an asset needs describing when its stored description was
 * made with another model / prompt version (or none), and videos also need a spoken opening once their proxy exists.
 * Pause is a row in app_settings; "Describe again" is assets.describe_requested_at.
 */
import type Database from "better-sqlite3";
import { notCleared } from "../cleared";
import { THRESHOLD_DEFAULT, THRESHOLD_MAX, THRESHOLD_MIN } from "./classes";

type Sql = Database.Database;

export const DESCRIBE_PAUSED_KEY = "describe:paused";
/** Epoch ms of the first worker start with Describe: files indexed after it count as "new" (described first). */
export const DESCRIBE_SINCE_KEY = "describe:since";

/** Image and video rows the Library shows (audio is never described). */
export const DESCRIBABLE = "a.missing = 0 and a.ignored = 0 and a.kind in ('image','video')";

/** One app_settings value (null when missing). The one reader shared by the describe, classify and hook state. */
export function getSetting(sql: Sql, key: string): string | null {
  return (sql.prepare("select value from app_settings where key = ?").pluck().get(key) as string | null | undefined) ?? null;
}

export function setSetting(sql: Sql, key: string, value: string) {
  sql
    .prepare("insert into app_settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
    .run(key, value);
}

/** Paused = the backfill and new files wait; "Describe again" requests still run. */
export function describePaused(sql: Sql): boolean {
  return getSetting(sql, DESCRIBE_PAUSED_KEY) === "1";
}

export function setDescribePaused(sql: Sql, paused: boolean) {
  setSetting(sql, DESCRIBE_PAUSED_KEY, paused ? "1" : "0");
}

/** The "new files" watermark, set once. */
export function describeSince(sql: Sql, now = Date.now()): number {
  const v = Number(getSetting(sql, DESCRIBE_SINCE_KEY));
  if (Number.isFinite(v) && v > 0) return v;
  setSetting(sql, DESCRIBE_SINCE_KEY, String(now));
  return now;
}

/**
 * "Describe again": the worker runs it next (even while paused), bypassing the fingerprint cache, and clears the
 * asset's last error. Only visible image/video assets. Returns false when the asset cannot be described.
 */
export function requestDescribe(sql: Sql, assetId: number, now = Date.now()): boolean {
  return (
    sql
      .prepare(`update assets as a set describe_requested_at = ?, describe_error = null where a.id = ? and ${DESCRIBABLE}`)
      .run(now, assetId).changes > 0
  );
}

/** Clear every describe error so the queue picks those assets up again (normal order, cache honoured). */
export function retryDescribeErrors(sql: Sql): number {
  return sql.prepare(`update assets set describe_error = null where describe_error is not null and ${notCleared("describe", "assets.id", "assets.describe_error")}`).run().changes;
}

export type DescribeSummary = {
  model: string;
  promptVersion: number;
  paused: boolean;
  /** Visible images + videos in enabled roots. */
  total: number;
  /** Described with the current model + prompt version. */
  done: number;
  videos: number;
  /** Videos whose first 15 s were checked (with or without speech), and how many had speech. */
  spokenChecked: number;
  spokenWithSpeech: number;
  errors: number;
  requested: number;
  /** Waiting to be described (new, backfill or Describe again; includes files still waiting for their previews). */
  queued: number;
};

export function describeSummary(sql: Sql, model: string, promptVersion: number): DescribeSummary {
  const row = sql
    .prepare(
      `select count(*) as total,
              coalesce(sum(a.description_model = @model and a.description_version = @version), 0) as done,
              coalesce(sum(a.kind = 'video'), 0) as videos,
              coalesce(sum(a.kind = 'video' and a.spoken_open is not null), 0) as spoken_checked,
              coalesce(sum(a.kind = 'video' and a.spoken_open != ''), 0) as spoken_speech,
              coalesce(sum(a.describe_error is not null and ${notCleared("describe", "a.id", "a.describe_error")}), 0) as errors,
              coalesce(sum(a.describe_requested_at is not null), 0) as requested,
              coalesce(sum(a.describe_requested_at is not null or (a.describe_error is null and (
                a.description_model is not @model or a.description_version is not @version))), 0) as queued
         from assets a join roots r on r.id = a.root_id
        where r.enabled = 1 and ${DESCRIBABLE}`,
    )
    .get({ model, version: promptVersion }) as {
    total: number;
    done: number;
    videos: number;
    spoken_checked: number;
    spoken_speech: number;
    errors: number;
    requested: number;
    queued: number;
  };
  return {
    model,
    promptVersion,
    paused: describePaused(sql),
    total: row.total,
    done: row.done,
    videos: row.videos,
    spokenChecked: row.spoken_checked,
    spokenWithSpeech: row.spoken_speech,
    errors: row.errors,
    requested: row.requested,
    queued: row.queued,
  };
}

// ------------------------------------------------------------------ classify (Jev)

export const CLASSIFY_PAUSED_KEY = "classify:paused";
export const CLASSIFY_SINCE_KEY = "classify:since";
export const CLASSIFY_THRESHOLD_KEY = "classify:threshold";

/**
 * Classify due = a visible image/video with a description from the current vision model + prompt version whose last
 * classify used another CLASSIFY_VERSION / Jev model, never ran, or read an older description than the current one
 * (`classify_described_at` = the described_at seen at claim time, so a description written while Jev was answering
 * makes the asset due again; rows classified before migration 0006 fall back to classified_at).
 * `@model`, `@version`, `@vmodel`, `@vversion` are bound by the caller.
 */
export const CLASSIFY_STALE =
  "(a.classify_version is not @version or a.classify_model is not @model or a.classified_at is null or coalesce(a.classify_described_at, a.classified_at) < a.described_at)";
export const CLASSIFY_DESCRIBED = "a.description is not null and a.description_model = @vmodel and a.description_version = @vversion";

/** Paused = the backfill and new files wait; "Classify again" still runs. Starts paused (seed v5) until the owner resumes. */
export function classifyPaused(sql: Sql): boolean {
  return getSetting(sql, CLASSIFY_PAUSED_KEY) !== "0";
}

export function setClassifyPaused(sql: Sql, paused: boolean) {
  setSetting(sql, CLASSIFY_PAUSED_KEY, paused ? "1" : "0");
}

export function classifySince(sql: Sql, now = Date.now()): number {
  const v = Number(getSetting(sql, CLASSIFY_SINCE_KEY));
  if (Number.isFinite(v) && v > 0) return v;
  setSetting(sql, CLASSIFY_SINCE_KEY, String(now));
  return now;
}

/** Confidence threshold for choice / score answers (Settings, 0.3 to 0.95, default 0.7). */
export function classifyThreshold(sql: Sql): number {
  const raw = getSetting(sql, CLASSIFY_THRESHOLD_KEY);
  const v = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= THRESHOLD_MIN && v <= THRESHOLD_MAX ? v : THRESHOLD_DEFAULT;
}

export function setClassifyThreshold(sql: Sql, value: number) {
  setSetting(sql, CLASSIFY_THRESHOLD_KEY, String(value));
}

/** "Classify again": runs next (even while paused) and clears the asset's last error. Needs a description. */
export function requestClassify(sql: Sql, assetId: number, now = Date.now()): boolean {
  return (
    sql
      .prepare(
        `update assets as a set classify_requested_at = ?, classify_error = null where a.id = ? and ${DESCRIBABLE} and a.description is not null`,
      )
      .run(now, assetId).changes > 0
  );
}

export function retryClassifyErrors(sql: Sql): number {
  return sql.prepare(`update assets set classify_error = null where classify_error is not null and ${notCleared("classify", "assets.id", "assets.classify_error")}`).run().changes;
}

export type ClassifySummary = {
  model: string;
  version: number;
  paused: boolean;
  threshold: number;
  /** Visible images + videos in enabled roots. */
  total: number;
  /** With a current description (what classify can work on). */
  described: number;
  /** Classified with the current version + model and not stale. */
  done: number;
  needsReview: number;
  errors: number;
  requested: number;
  /** Waiting for Jev (Classify again, or described but not classified with the current version). */
  queued: number;
};

export function classifySummary(sql: Sql, cfg: { jevModel: string; visionModel: string }, version: number, describeVersion: number): ClassifySummary {
  const row = sql
    .prepare(
      `select count(*) as total,
              coalesce(sum(${CLASSIFY_DESCRIBED}), 0) as described,
              coalesce(sum(a.classified_at is not null and not ${CLASSIFY_STALE}), 0) as done,
              -- Review's count leaves out switched-off lanes (Creative Studio 1b), like the Review queue itself.
              coalesce(sum(a.needs_review = 1 and (select enabled from sections where id = a.section_id) = 1), 0) as review,
              coalesce(sum(a.classify_error is not null and ${notCleared("classify", "a.id", "a.classify_error")}), 0) as errors,
              coalesce(sum(a.classify_requested_at is not null), 0) as requested,
              coalesce(sum(a.description is not null and (a.classify_requested_at is not null or (
                a.classify_error is null and ${CLASSIFY_DESCRIBED} and ${CLASSIFY_STALE}))), 0) as queued
         from assets a join roots r on r.id = a.root_id
        where r.enabled = 1 and ${DESCRIBABLE}`,
    )
    .get({ model: cfg.jevModel, version, vmodel: cfg.visionModel, vversion: describeVersion }) as {
    total: number;
    described: number;
    done: number;
    review: number;
    errors: number;
    requested: number;
    queued: number;
  };
  return {
    model: cfg.jevModel,
    version,
    paused: classifyPaused(sql),
    threshold: classifyThreshold(sql),
    total: row.total,
    described: row.described,
    done: row.done,
    needsReview: row.review,
    errors: row.errors,
    requested: row.requested,
    queued: row.queued,
  };
}
