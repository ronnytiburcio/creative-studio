/**
 * The small app_settings helpers the worker's daily sync queues share (Meta, YouTube): a pause flag, a "sync now"
 * request stamp and whether that request is newer than the last run's start. Keys stay each queue's own
 * (`meta:*`, `youtube:*`).
 */
import type Database from "better-sqlite3";
import { getSetting, setSetting } from "./ai/state";

type Sql = Database.Database;

/** A positive number stored under `key`, else null. */
export function numSetting(sql: Sql, key: string): number | null {
  const v = Number(getSetting(sql, key));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Paused = the key holds "1". */
export function pausedSetting(sql: Sql, key: string): boolean {
  return getSetting(sql, key) === "1";
}

export function setPausedSetting(sql: Sql, key: string, paused: boolean) {
  setSetting(sql, key, paused ? "1" : "0");
}

/** "Sync now": stamp the request; the worker picks it up on its next poll (even while paused). */
export function stampRequest(sql: Sql, key: string, now = Date.now()) {
  setSetting(sql, key, String(now));
}

/** A request newer than the last run's start. */
export function requestPending(sql: Sql, requestKey: string, runStartedKey: string): boolean {
  const req = numSetting(sql, requestKey);
  return req != null && req > (numSetting(sql, runStartedKey) ?? 0);
}
