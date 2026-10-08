/**
 * Filesystem guards shared by the app and the worker (server only). These are READ guards: the drive
 * is read only except "<drive>/Studio Generated/", which only src/lib/writeguard.ts may write to.
 *  - resolveInside(): resolve + realpath + prefix check, so no ".." or symlink escape.
 *  - isDriveMounted(): the drive is there: a real mount point (`external`) or a readable folder (`folder`).
 *  - rootAccessible(): a root can be read right now.
 */
import fs from "node:fs";
import path from "node:path";
import type { DriveMode } from "./drive-mode";

function isInside(child: string, base: string): boolean {
  return child === base || child.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * Returns the real absolute path if `p` resolves (lexically AND after symlinks)
 * inside one of `bases`, else null. Never throws.
 */
export function resolveInside(p: string, bases: string[]): string | null {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  if (!path.isAbsolute(p)) return null;
  const abs = path.resolve(p);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return null;
  }
  for (const b of bases) {
    if (!b || !path.isAbsolute(b)) continue;
    const lexBase = path.resolve(b);
    let realBase: string;
    try {
      realBase = fs.realpathSync(lexBase);
    } catch {
      continue;
    }
    if (isInside(abs, lexBase) && isInside(real, realBase)) return real;
  }
  return null;
}

/** Join a cache-relative path and verify it stays inside the cache dir. */
export function resolveCacheFile(cacheDir: string, rel: string | null | undefined): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  return resolveInside(path.join(cacheDir, rel), [cacheDir]);
}

export function isUnder(p: string, base: string): boolean {
  return isInside(path.resolve(p), path.resolve(base));
}

/**
 * Mount check. `external`: the path exists, is a directory, and sits on a different device than its parent (an
 * unplugged drive leaves nothing, or a plain folder on the boot disk, at its path). `folder`: the path exists, is a
 * directory and is readable (no device check). `fakeUnmounted` (STUDIO_FAKE_UNMOUNTED) forces false in both modes.
 * Every argument is required (no silent default mode): callers pass the config's (`driveMounted(cfg)`).
 */
export function isDriveMounted(drivePath: string, fakeUnmounted: boolean, mode: DriveMode): boolean {
  if (fakeUnmounted) return false;
  try {
    const st = fs.statSync(drivePath);
    if (!st.isDirectory()) return false;
    if (mode === "folder") {
      fs.accessSync(drivePath, fs.constants.R_OK | fs.constants.X_OK);
      return true;
    }
    const parent = fs.statSync(path.dirname(drivePath));
    return st.dev !== parent.dev;
  } catch {
    return false;
  }
}

/** What every mount check needs from the config. */
export type DriveCfg = { drivePath: string; fakeUnmounted: boolean; driveMode: DriveMode };

/** Mount state of the configured media drive (honours STUDIO_DRIVE_MODE and STUDIO_FAKE_UNMOUNTED). */
export function driveMounted(cfg: DriveCfg): boolean {
  return isDriveMounted(cfg.drivePath, cfg.fakeUnmounted, cfg.driveMode);
}

/** A root is readable now: its drive (if it lives on one) is mounted and the dir exists. */
export function rootAccessible(
  rootPath: string,
  drivePath: string,
  driveMounted: boolean,
): boolean {
  if (isUnder(rootPath, drivePath) && !driveMounted) return false;
  try {
    return fs.statSync(rootPath).isDirectory();
  } catch {
    return false;
  }
}
