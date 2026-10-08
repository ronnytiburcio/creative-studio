/**
 * Guarded text reader (server only, Phase 6 A1): the one way Studio reads a text file that sits next to the media on a
 * root (an episode's `<prefix>N.srt`; since slice 2 also a reel's caption `.md`, passed explicitly as CAPTION_EXTS by
 * src/lib/shorts/outputs.ts only). READ ONLY: nothing here opens a file for writing.
 *
 *   - the requested path AND its real path must end in an allowed extension (.srt / .txt by default, .md only when the
 *     caller asks for it), so a symlink named `x.srt` that points at a video is refused;
 *   - resolveInside() over the bases given (enabled roots): absolute, lexically inside, realpath inside, no `..` or
 *     symlink escape;
 *   - opened read only with O_NOFOLLOW on the real path, fstat'ed: a regular file of at most 2 MB (else refused before
 *     a byte is read);
 *   - decoded as UTF-8 with a leading BOM removed.
 * Folder listings go through the same guard (listGuardedDir: the folder's real path inside a base, names only).
 *
 * Phase 7 slice 2: the reel kit's per reel notes (`<reel stem> kit.json`) through statKitNote / readKitNote ONLY: `.json`
 * is passed explicitly (KIT_NOTE_EXTS, never a default), the requested AND the real file name must end in ` kit.json`,
 * and the cap is 64 KB. Only the worker's kit note sync (src/lib/shorts/kit.ts) calls them.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "./fsguard";

export const TEXT_EXTS = [".srt", ".txt"] as const;
/** Caption files next to a reel (Phase 6 slice 2): read through the same guards, only by the caption lookup. */
export const CAPTION_EXTS = [".md"] as const;
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Kit notes next to a reel (Phase 7 slice 2): `.json`, and only for names ending ` kit.json` (statKitNote / readKitNote). */
export const KIT_NOTE_EXTS = [".json"] as const;
export const KIT_NOTE_SUFFIX = " kit.json";
export const KIT_NOTE_MAX_BYTES = 64 * 1024;

export class TextReadError extends Error {}

function extOk(p: string, exts: readonly string[]) {
  return exts.includes(path.extname(p).toLowerCase());
}

export type GuardedStat = { real: string; size: number; mtimeMs: number };

/** Where the file really is + its size and mtime, through the same guards as the read (no bytes read). */
export function statGuardedText(p: string, bases: string[], exts: readonly string[] = TEXT_EXTS, maxBytes = TEXT_MAX_BYTES): GuardedStat {
  const names = exts.join(" / ");
  if (!extOk(p, exts)) throw new TextReadError(`Not a text file Studio reads (${names} only).`);
  const real = resolveInside(p, bases);
  if (!real) throw new TextReadError("Outside the enabled roots (or missing).");
  if (!extOk(real, exts)) throw new TextReadError(`The file it points at is not a ${names} file.`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new TextReadError("Not a regular file.");
  if (st.size > maxBytes) throw new TextReadError(`Larger than ${capText(maxBytes)}.`);
  return { real, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

const capText = (n: number) => (n >= 1024 * 1024 ? `${n / 1024 / 1024} MB` : `${n / 1024} KB`);

/** Read a guarded text file (see the module comment). Throws TextReadError with a terse reason. */
export function readGuardedText(
  p: string,
  bases: string[],
  exts: readonly string[] = TEXT_EXTS,
  maxBytes = TEXT_MAX_BYTES,
): GuardedStat & { text: string } {
  const pre = statGuardedText(p, bases, exts, maxBytes);
  let fd: number;
  try {
    fd = fs.openSync(pre.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new TextReadError("Could not open the file.");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new TextReadError("Not a regular file.");
    if (st.size > maxBytes) throw new TextReadError(`Larger than ${capText(maxBytes)}.`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString("utf8").replace(/^﻿/, "");
    return { real: pre.real, size: st.size, mtimeMs: Math.round(st.mtimeMs), text };
  } finally {
    fs.closeSync(fd);
  }
}

function kitNameOk(p: string) {
  return path.basename(p).endsWith(KIT_NOTE_SUFFIX) && path.basename(p).length > KIT_NOTE_SUFFIX.length;
}

/** A kit note's real path, size and mtime (the name rule on the requested and the real path, `.json`, 64 KB). */
export function statKitNote(p: string, bases: string[]): GuardedStat {
  if (!kitNameOk(p)) throw new TextReadError("Not a kit note name.");
  const st = statGuardedText(p, bases, KIT_NOTE_EXTS, KIT_NOTE_MAX_BYTES);
  if (!kitNameOk(st.real)) throw new TextReadError("The file it points at is not a kit note.");
  return st;
}

/** Read a kit note (statKitNote's rules, then the guarded read). Throws TextReadError. */
export function readKitNote(p: string, bases: string[]): GuardedStat & { text: string } {
  statKitNote(p, bases);
  const r = readGuardedText(p, bases, KIT_NOTE_EXTS, KIT_NOTE_MAX_BYTES);
  if (!kitNameOk(r.real)) throw new TextReadError("The file it points at is not a kit note.");
  return r;
}

/** File names in a folder whose real path is inside one of the bases (none when it is not, or unreadable). */
export function listGuardedDir(dir: string, bases: string[]): string[] {
  const real = resolveInside(dir, bases);
  if (!real) return [];
  try {
    return fs
      .readdirSync(real, { withFileTypes: true })
      .filter((d) => d.isFile() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Sub-folder names of a folder whose real path is inside one of the bases (real directories only, no symlinks). */
export function listGuardedSubdirs(dir: string, bases: string[]): string[] {
  const real = resolveInside(dir, bases);
  if (!real) return [];
  try {
    return fs
      .readdirSync(real, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
