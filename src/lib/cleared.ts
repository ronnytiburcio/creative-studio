import type Database from "better-sqlite3";
import { HOOK_ACTIVE } from "./hooks/sql";

/**
 * Cleared errors (Jobs page, 2026-10-06): the owner's Clear hides an error row from the Jobs page lists, the error counts
 * (sidebar badge, queue summaries) and Retry all, until that thing fails with a DIFFERENT error. Clearing never changes
 * the job, the file or a queue (a cleared describe / classify / hook error stays skipped exactly as before); Retry on a
 * row still works. Rows live in `error_dismissals` (kind + id + the error text it hid). jobs.ts, ai/state.ts and
 * hooks/store.ts use the SQL fragment; this file imports only hooks/sql.ts (import free, so no cycle).
 */

type Sql = Database.Database;

export const CLEAR_KINDS = ["derive", "describe", "classify", "hook", "meta", "youtube"] as const;
export type ClearKind = (typeof CLEAR_KINDS)[number];

/**
 * SQL condition: this error is NOT cleared. `ref` / `err` are SQL expressions of the outer row (e.g. `j.id`, `j.error`).
 * `kind` is one of CLEAR_KINDS (a literal, never user input).
 */
export function notCleared(kind: ClearKind, ref: string, err: string): string {
  return `not exists (select 1 from error_dismissals ed where ed.kind = '${kind}' and ed.ref_id = ${ref} and ed.error = ${err})`;
}

/** The text the Jobs page shows for a Meta account's errors (Meta + GHL), the one stored when it is cleared. */
const META_ERR = "coalesce(x.error, '') || char(10) || coalesce(x.ghl_error, '')";

/** The Jobs page lists describe / classify errors only for files it shows (visible, in an enabled root). */
const FILE_SHOWN = "x.missing = 0 and x.ignored = 0 and x.root_id in (select id from roots where enabled = 1)";

/** Where each kind's current errors live: the row id, the error text and the "has an error" condition. */
const SOURCES: Record<ClearKind, { from: string; ref: string; err: string; where: string }> = {
  derive: { from: "jobs x", ref: "x.id", err: "x.error", where: "x.status = 'error' and x.type like 'derive_%' and x.error is not null" },
  describe: { from: "assets x", ref: "x.id", err: "x.describe_error", where: `x.describe_error is not null and ${FILE_SHOWN}` },
  classify: { from: "assets x", ref: "x.id", err: "x.classify_error", where: `x.classify_error is not null and ${FILE_SHOWN}` },
  hook: { from: "hooks h", ref: "h.id", err: "h.score_error", where: `h.score_error is not null and ${HOOK_ACTIVE}` },
  meta: { from: "ad_accounts x", ref: "x.id", err: META_ERR, where: "(x.error is not null or x.ghl_error is not null)" },
  youtube: { from: "app_settings x", ref: "0", err: "x.value", where: "x.key = 'youtube:error' and coalesce(x.value, '') <> ''" },
};

/**
 * Clear the CURRENT error of one thing (`refId`) or of every thing of these kinds (no `refId`). The text is read from the
 * DB here, never taken from the browser. Returns how many errors were cleared.
 */
export function clearErrors(sql: Sql, kinds: readonly ClearKind[], refId?: number, now = Date.now()): number {
  let n = 0;
  sql.transaction(() => {
    for (const kind of kinds) {
      const s = SOURCES[kind];
      const one = refId == null ? "" : ` and ${s.ref} = ?`;
      n += sql
        .prepare(
          `insert into error_dismissals (kind, ref_id, error, dismissed_at)
             select ?, ${s.ref}, ${s.err}, ? from ${s.from} where ${s.where} and ${notCleared(kind, s.ref, s.err)}${one}
           on conflict (kind, ref_id) do update set error = excluded.error, dismissed_at = excluded.dismissed_at`,
        )
        .run(kind, now, ...(refId == null ? [] : [refId])).changes;
    }
  })();
  return n;
}

/** How many errors of these kinds are showing (not cleared): the Jobs page's "Clear all" count. */
export function unclearedCount(sql: Sql, kinds: readonly ClearKind[] = CLEAR_KINDS): number {
  let n = 0;
  for (const kind of kinds) {
    const s = SOURCES[kind];
    n += sql.prepare(`select count(*) from ${s.from} where ${s.where} and ${notCleared(kind, s.ref, s.err)}`).pluck().get() as number;
  }
  return n;
}

/** Ids of this kind whose CURRENT error is cleared (the Jobs page filters Meta accounts and the YouTube error with it). */
export function clearedIds(sql: Sql, kind: ClearKind): Set<number> {
  const s = SOURCES[kind];
  const ids = sql.prepare(`select ${s.ref} from ${s.from} where ${s.where} and not ${notCleared(kind, s.ref, s.err)}`).pluck().all() as number[];
  return new Set(ids);
}
