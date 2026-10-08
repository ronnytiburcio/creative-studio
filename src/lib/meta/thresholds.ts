/**
 * Settings for the Running flags and the calibration minimums (Phase 5 slice 3; server only). Stored as one JSON value
 * each in app_settings (`flags:thresholds`, `calibration:minimums`); missing or invalid = the defaults. Saved only
 * through the zod-validated server action; Reset deletes the key.
 */
import type Database from "better-sqlite3";
import { getSetting, setSetting } from "../ai/state";
import { calibrationMinimumsSchema, DEFAULT_FLAG_THRESHOLDS, flagThresholdsSchema, type FlagThresholds } from "./flags";
import { DEFAULT_CAL_MINIMUMS, type CalibrationMinimums } from "../calibration/stats";

type Sql = Database.Database;

export const FLAG_THRESHOLDS_KEY = "flags:thresholds";
export const CAL_MINIMUMS_KEY = "calibration:minimums";

function read<T>(sql: Sql, key: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, fallback: T): T {
  const raw = getSetting(sql, key);
  if (!raw) return fallback;
  try {
    const p = schema.safeParse(JSON.parse(raw));
    return p.success ? (p.data as T) : fallback;
  } catch {
    return fallback;
  }
}

export function flagThresholds(sql: Sql): FlagThresholds {
  return read(sql, FLAG_THRESHOLDS_KEY, flagThresholdsSchema, DEFAULT_FLAG_THRESHOLDS);
}

export function calibrationMinimums(sql: Sql): CalibrationMinimums {
  return read(sql, CAL_MINIMUMS_KEY, calibrationMinimumsSchema, DEFAULT_CAL_MINIMUMS);
}

/** Save (validated values) or reset (null = the defaults). */
export function setFlagThresholds(sql: Sql, v: FlagThresholds | null) {
  if (v == null) sql.prepare("delete from app_settings where key = ?").run(FLAG_THRESHOLDS_KEY);
  else setSetting(sql, FLAG_THRESHOLDS_KEY, JSON.stringify(flagThresholdsSchema.parse(v)));
}

export function setCalibrationMinimums(sql: Sql, v: CalibrationMinimums | null) {
  if (v == null) sql.prepare("delete from app_settings where key = ?").run(CAL_MINIMUMS_KEY);
  else setSetting(sql, CAL_MINIMUMS_KEY, JSON.stringify(calibrationMinimumsSchema.parse(v)));
}
