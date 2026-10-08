/**
 * The one place that decides whether an asset's ORIGINAL file may be touched
 * (served, revealed in Finder, sent to a generation engine as a reference): root enabled, not missing/ignored, drive mounted
 * when the root lives on it, and the real path inside an enabled root.
 */
import fs from "node:fs";
import type Database from "better-sqlite3";
import { getConfig, type StudioConfig } from "./config";
import { getDb } from "./db";
import { driveMounted, isUnder, resolveInside } from "./fsguard";

export type OriginalCheck =
  | { ok: true; file: string; filename: string; onDrive: boolean }
  | { ok: false; status: 403 | 404 | 409; error: string; onDrive: boolean };

/** `sqlite` / `cfg` default to the app's; the worker passes its own connection (generation references). */
export function originalFileFor(
  assetId: number,
  sqlite: Database.Database = getDb().sqlite,
  cfg: Pick<StudioConfig, "drivePath" | "fakeUnmounted" | "driveMode"> = getConfig(),
): OriginalCheck {
  const a = sqlite
    .prepare(
      `select a.path, a.filename, a.missing, a.ignored, r.path as root_path, r.enabled as root_enabled
         from assets a join roots r on r.id = a.root_id where a.id = ?`,
    )
    .get(assetId) as
    | { path: string; filename: string; missing: number; ignored: number; root_path: string; root_enabled: number }
    | undefined;
  if (!a) return { ok: false, status: 404, error: "not found", onDrive: false };
  const onDrive = isUnder(a.root_path, cfg.drivePath);
  if (!a.root_enabled || a.missing || a.ignored) return { ok: false, status: 404, error: "original unavailable", onDrive };
  if (onDrive && !driveMounted(cfg)) return { ok: false, status: 409, error: "drive not mounted", onDrive };
  if (!fs.existsSync(a.path)) return { ok: false, status: 404, error: "original unavailable", onDrive };
  const roots = (sqlite.prepare("select path from roots where enabled = 1").all() as { path: string }[]).map((r) => r.path);
  const file = resolveInside(a.path, roots);
  if (!file) return { ok: false, status: 403, error: "outside configured roots", onDrive };
  return { ok: true, file, filename: a.filename, onDrive };
}
