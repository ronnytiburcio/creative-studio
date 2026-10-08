/** Job types/statuses and the shared job + asset-state SQL (server only). */
import type Database from "better-sqlite3";
import { notCleared } from "./cleared";

export const DERIVE_JOB_TYPES = ["derive_thumb", "derive_proxy"] as const;
/** Generation jobs: asset_id is null, the request lives in jobs.input. Claimed only by the worker's GenQueue. */
export const GEN_JOB_TYPES = ["gen_image", "gen_video", "gen_tool"] as const;
/** `claude -p` jobs (asset_id null, the request in jobs.input), each run only by its own worker queue. */
export const VARIANT_JOB = "hook_variants";
export const MOMENTS_JOB = "short_moments";
export const AD_COPY_JOB = "ad_copy";
export const CLAUDE_JOB_TYPES = [VARIANT_JOB, MOMENTS_JOB, AD_COPY_JOB] as const;
export const JOB_TYPES = [...DERIVE_JOB_TYPES, ...GEN_JOB_TYPES, ...CLAUDE_JOB_TYPES] as const;
export type DeriveJobType = (typeof DERIVE_JOB_TYPES)[number];
export type GenJobType = (typeof GEN_JOB_TYPES)[number];
export type ClaudeJobType = (typeof CLAUDE_JOB_TYPES)[number];
export type JobType = (typeof JOB_TYPES)[number];
/** Derive job states (the Jobs page table columns). Generation jobs can also end as "cancelled" (Codex). */
export const JOB_STATUSES = ["pending", "running", "done", "error"] as const;
export type DeriveJobStatus = (typeof JOB_STATUSES)[number];
export type JobStatus = DeriveJobStatus | "cancelled";

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  derive_thumb: "Poster + sheet / thumb",
  derive_proxy: "480p proxy",
  gen_image: "Generate image",
  gen_video: "Generate video",
  gen_tool: "Quick tool",
  hook_variants: "Hook variants",
  short_moments: "Short moments",
  ad_copy: "Ad copy draft",
};

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * The error text a job row (and so the browser) may carry: the message of a known, terse error class or one of the
 * caller's fixed phrases; anything else (an fs / ffmpeg / SQLite error that could name a path or SQL) becomes `fallback`.
 * The full message belongs in the per-job log / the worker log only.
 */
export function terseJobError(e: unknown, known: readonly ErrorClass[], fallback: string, fixed: readonly string[] = []): string {
  const message = e instanceof Error ? e.message : "";
  if (message && known.some((k) => e instanceof k)) return message.slice(0, 500);
  if (message && fixed.includes(message)) return message;
  return fallback;
}

export function isGenType(type: string): type is GenJobType {
  return (GEN_JOB_TYPES as readonly string[]).includes(type);
}

type Sql = Database.Database;

const DERIVE_IN = `type in (${DERIVE_JOB_TYPES.map((t) => `'${t}'`).join(",")})`;
/** SQL condition: the row is a generation job (shared by the app and the worker's GenQueue). */
export const GEN_IN = `type in (${GEN_JOB_TYPES.map((t) => `'${t}'`).join(",")})`;

/**
 * Error wording for a create call that may have gone through on Higgsfield without Studio getting the job id
 * (worker restart mid-create, create timed out or died without printing an id). Retrying spends credits again.
 */
export const MAY_EXIST_ON_ENGINE =
  "It may still have been created on Higgsfield: check there before retrying (a retry spends credits again).";

/**
 * Put interrupted `running` DERIVE jobs back in the queue. Returns how many.
 * Generation jobs are never blindly requeued (that could spend credits twice); GenQueue.recover() owns them.
 */
export function requeueRunning(sql: Sql): number {
  return sql.prepare(`update jobs set status = 'pending', started_at = null where status = 'running' and ${DERIVE_IN}`).run()
    .changes;
}

/**
 * Re-queue one errored derive or generation job (or a cancelled generation job) by id, or all errored DERIVE jobs.
 * Returns how many. "Retry all" never touches generation jobs: each paid retry needs its own click.
 * A generation job keeps its external_id when it has one, so the retry re-polls / re-downloads instead of re-creating
 * (Codex jobs never keep one: their retry simply runs again).
 * The `claude -p` job types (CLAUDE_JOB_TYPES: `hook_variants`, `short_moments`, `ad_copy`) are never retried here: each
 * has its own Retry action with its own checks (retryVariantJob: one active job per hook, the hook still live;
 * retryMomentJob: one active job per episode; retryAdCopyJob: one active job per channel + hook).
 */
export function retryErrored(sql: Sql, jobId?: number): number {
  const set =
    "update jobs set status = 'pending', error = null, attempts = 0, started_at = null, finished_at = null, cancel_requested_at = null";
  return jobId == null
    ? sql.prepare(`${set} where status = 'error' and ${DERIVE_IN} and ${notCleared("derive", "jobs.id", "jobs.error")}`).run().changes
    : sql
        .prepare(`${set} where id = ? and ((status = 'error' and (${DERIVE_IN} or ${GEN_IN})) or (status = 'cancelled' and ${GEN_IN}))`)
        .run(jobId).changes;
}

/**
 * Cancel a generation job that is still waiting (nothing started, nothing spent). One UPDATE guarded by
 * `status = 'pending'`: the worker's claim flips a row to running inside an IMMEDIATE transaction that also
 * requires `status = 'pending'`, so exactly one of the two wins. Returns true when this call cancelled it.
 */
export function cancelPending(sql: Sql, jobId: number): boolean {
  return (
    sql
      .prepare(`update jobs set status = 'cancelled', error = 'Cancelled', finished_at = ? where id = ? and status = 'pending' and ${GEN_IN}`)
      .run(Date.now(), jobId).changes > 0
  );
}

/**
 * Ask to cancel a generation job. Pending jobs are cancelled on the spot (any engine: nothing was spent);
 * running ones get a request the worker acts on within a few seconds (it kills the run). Only engines that can
 * stop a running job (Codex) may pass `running: true`: the caller checks the engine.
 * Returns "cancelled" | "requested" | null (not active, or running and `running` is false).
 */
export function requestCancel(sql: Sql, jobId: number, opts: { running?: boolean } = { running: true }): "cancelled" | "requested" | null {
  if (cancelPending(sql, jobId)) return "cancelled";
  if (!opts.running) return null;
  return sql.prepare(`update jobs set cancel_requested_at = ? where id = ? and status = 'running' and ${GEN_IN}`).run(Date.now(), jobId).changes
    ? "requested"
    : null;
}

/** Count of generation jobs waiting or running, and the last time one finished (drives Library auto refresh). */
export function genActivity(sql: Sql): { active: number; lastDoneAt: number | null } {
  const row = sql
    .prepare(
      `select sum(case when status in ('pending','running') then 1 else 0 end) as active,
              max(case when status = 'done' then finished_at end) as last_done
         from jobs where ${GEN_IN}`,
    )
    .get() as { active: number | null; last_done: number | null };
  return { active: row.active ?? 0, lastDoneAt: row.last_done ?? null };
}

function setFlagAndDropPending(sql: Sql, column: "missing" | "ignored", assetIds: number[]) {
  if (!assetIds.length) return;
  const flag = sql.prepare(`update assets set ${column} = 1 where id = ?`);
  const drop = sql.prepare("delete from jobs where asset_id = ? and status = 'pending'");
  sql.transaction(() => {
    for (const id of assetIds) {
      flag.run(id);
      drop.run(id);
    }
  })();
}

/** File vanished while its root was readable. */
export function markMissing(sql: Sql, assetIds: number[]) {
  setFlagAndDropPending(sql, "missing", assetIds);
}

/** Path now matches an ignore pattern: soft-hide (keeps the row and its manual tags). */
export function markIgnored(sql: Sql, assetIds: number[]) {
  setFlagAndDropPending(sql, "ignored", assetIds);
}
