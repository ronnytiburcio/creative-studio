/**
 * Brand marks (Creative Studio slice 1d; server only). The app ships generic marks in public/brand. An install can keep
 * its own in a folder (STUDIO_BRAND_DIR, e.g. in its Studio config's `env`): every BRAND_FILES name found there is served
 * by GET /api/brand/<name> instead. Nothing else in the folder is ever opened.
 *
 * A mark counts when `resolveInside(<folder>/<name>, [<folder>])` (src/lib/fsguard.ts: lexically AND by real path inside
 * the folder) finds a regular file of at most 256 KB that looks like an SVG. The route reads it with
 * O_RDONLY | O_NOFOLLOW and checks the open descriptor (fstat) again. `brandUrls` (every render) only stats: whether a
 * file looks like an SVG is remembered per process by real path + size + mtime, so a file is read again only when it
 * changes.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveInside } from "./fsguard";
import { BRAND_FILES, GENERIC_BRAND, type BrandFile, type BrandUrls } from "./profile-shared";
import type { StudioConfig } from "./config";

export const BRAND_MAX_BYTES = 256 * 1024;

/** The route's param: exactly one of the four names. */
export const brandFileSchema = z.enum(BRAND_FILES);

const URL_KEY: Record<BrandFile, keyof BrandUrls> = {
  "mark-ink.svg": "markInk",
  "mark-sand.svg": "markSand",
  "wordmark-ink.svg": "wordmarkInk",
  "wordmark-paper.svg": "wordmarkPaper",
};

const SVG_RE = /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

export function isBrandFile(name: string): name is BrandFile {
  return brandFileSchema.safeParse(name).success;
}

/** The install's own file for `name` (its real path) + its stat, or null (no folder, missing, a link out, not a regular file, too big). */
function ownBrandStat(cfg: Pick<StudioConfig, "brandDir">, name: BrandFile): { real: string; st: fs.Stats } | null {
  if (!cfg.brandDir) return null;
  const real = resolveInside(path.join(cfg.brandDir, name), [cfg.brandDir]);
  if (!real) return null;
  try {
    const st = fs.statSync(real);
    return st.isFile() && st.size <= BRAND_MAX_BYTES ? { real, st } : null;
  } catch {
    return null;
  }
}

/** Read a mark through the guard: O_RDONLY | O_NOFOLLOW, the descriptor fstat'ed (regular, <= 256 KB). Null on anything else. */
function readGuarded(real: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > BRAND_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** Per process: does the file at this real path + size + mtime look like an SVG (read once per change). */
const looksCache = new Map<string, { size: number; mtimeMs: number; svg: boolean }>();

function looksLikeSvg(real: string, st: fs.Stats): boolean {
  const hit = looksCache.get(real);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.svg;
  const text = readGuarded(real);
  const svg = text != null && SVG_RE.test(text);
  looksCache.set(real, { size: st.size, mtimeMs: st.mtimeMs, svg });
  return svg;
}

/** The URL of each mark: the install's own (/api/brand/<name>) when present, else the built-in generic one. Stats only. */
export function brandUrls(cfg: Pick<StudioConfig, "brandDir">): BrandUrls {
  const out: BrandUrls = { ...GENERIC_BRAND };
  for (const name of BRAND_FILES) {
    const own = ownBrandStat(cfg, name);
    if (own && looksLikeSvg(own.real, own.st)) out[URL_KEY[name]] = `/api/brand/${name}`;
  }
  return out;
}

/** The SVG text of the install's own mark, or null (also when it does not look like an SVG). Reads the file (the route). */
export function readOwnBrandSvg(cfg: Pick<StudioConfig, "brandDir">, name: BrandFile): string | null {
  const own = ownBrandStat(cfg, name);
  if (!own) return null;
  const text = readGuarded(own.real);
  return text != null && SVG_RE.test(text) ? text : null;
}
