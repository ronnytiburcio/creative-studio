/**
 * Cut reel hand-off (Phase 6 D; server only). Studio never renders a reel, never runs the reel cut skill and never writes
 * to an episode folder: Cut reel writes the approved moments as a list in that skill's own `<prefix>N reels.json` shape
 * (src/lib/shorts/naming.ts) into Studio's own hand-off folder and shows a line the owner pastes into a live Claude
 * session (the skill copies the list into the episode folder).
 *
 * writeHandoffFile() is the ONE writer (a hard rule in CLAUDE.md): only the configured folder (`STUDIO_HANDOFFS`, default
 * <data dir>/handoffs; config refuses one on the drive), created 0700 when missing, never a symlink, its real path
 * never under the drive, file names `<prefix>N reels[ <yyyy-mm-dd-hhmm>[-n]].json` only, JSON only, 64 KB cap, created
 * with O_CREAT | O_EXCL | O_NOFOLLOW (`wx`): an existing file is never overwritten (the next name is tried instead).
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getConfig } from "../config";
import { onDrive, writeNewPrivateFile } from "../privatefile";
import { getEpisode } from "./episodes";
import { nextK } from "./moments";
import { usedReelNumbers } from "./outputs";
import { formatLabel, HANDOFF_FORMATS, pasteLine, type HandoffFormat } from "./handoff-text";
import { readKitVersion } from "./kit";
import { profile } from "../profile";
import { episodeStem, handoffNameRe, handoffNames, reelsListName } from "./naming";

type Sql = Database.Database;

export class HandoffError extends Error {}

export const HANDOFF_MAX_BYTES = 64 * 1024;

/** The hand-off folder, checked (and created 0700 when missing). Throws HandoffError. */
export function handoffDir(dir: string, drivePath: string): string {
  if (!path.isAbsolute(dir)) throw new HandoffError("The hand-off folder must be an absolute path.");
  const abs = path.resolve(dir);
  if (abs === "/" || onDrive(abs, drivePath)) throw new HandoffError("The hand-off folder must not be on the media drive.");
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HandoffError("The hand-off folder is not a plain folder.");
  const real = fs.realpathSync(abs);
  if (onDrive(real, drivePath)) throw new HandoffError("The hand-off folder must not be on the media drive.");
  return real;
}

/**
 * Write a NEW hand-off file (see the module comment). `name` must be `<prefix>N reels.json`; when it exists, the dated
 * name is used (`<prefix>N reels 2026-10-01-1432.json`, then `-2`, `-3` ...). Returns the absolute path written.
 */
export function writeHandoffFile(dir: string, drivePath: string, name: string, body: unknown, now = new Date()): string {
  const NAME = handoffNameRe();
  if (!NAME.test(name) || name.includes("/") || name.includes("\0")) throw new HandoffError("Not a hand-off file name.");
  const text = `${JSON.stringify(body, null, 2)}\n`;
  if (Buffer.byteLength(text) > HANDOFF_MAX_BYTES) throw new HandoffError("The list is larger than 64 KB.");
  JSON.parse(text); // JSON only
  const real = handoffDir(dir, drivePath);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const stem = name.replace(/\.json$/, "");
  const names = [name, `${stem} ${stamp}.json`, ...Array.from({ length: 20 }, (_, i) => `${stem} ${stamp}-${i + 2}.json`)];
  for (const n of names) {
    if (!NAME.test(n)) continue;
    const target = path.join(real, n);
    try {
      writeNewPrivateFile(target, text);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new HandoffError("Could not create the hand-off file.");
    }
    return target;
  }
  throw new HandoffError("Too many hand-off files for this episode this minute.");
}

// ------------------------------------------------------------------------------------------------ Cut reel

/**
 * One clip. Phase 7 slice 2 adds `cold_start` / `cold_end` (the cold open, master seconds) after the old keys; `hook` is
 * the hook words with their `*...*` orange block marker.
 */
export type HandoffClip = {
  k: number;
  start: number;
  end: number;
  layout: string;
  hook: string;
  first_line: string;
  why: string;
  cold_start: number;
  cold_end: number;
};
/**
 * the reel cut skill's `<prefix>N reels.json` top level (its Ep5 example: episode, master, status, clips) + `kit_version`
 * (Phase 7: the reel kit's VERSION for the kit format; null for the old formats).
 */
export type HandoffList = { episode: string; master: string; status: string; clips: HandoffClip[]; kit_version: number | null };

const two = (n: number) => Math.round(n * 100) / 100;

/**
 * The list for these cards (kept Idea cards of one live episode, ordered by k; each with a cold open: Phase 7 B4).
 * `kitVersion` = the kit's VERSION (used by the kit format only). Throws HandoffError.
 */
export function buildHandoff(
  sql: Sql,
  episodeId: number,
  cardIds: number[],
  format: HandoffFormat,
  now = new Date(),
  kitVersion: number | null = null,
): HandoffList {
  if (!(HANDOFF_FORMATS as readonly string[]).includes(format)) throw new HandoffError("Pick a format: kit, v2, v3 or v1.");
  const ids = [...new Set(cardIds)];
  if (!ids.length) throw new HandoffError("Pick at least one kept idea.");
  const ep = getEpisode(sql, episodeId);
  if (!ep || ep.goneAt != null) throw new HandoffError("That episode is not available any more.");
  if (!ep.masterPath) throw new HandoffError("The episode's master file is missing from the index.");
  const rows = sql
    .prepare(
      `select id, k, start_s, end_s, layout, hook_words, first_line, why, status, kept, archived_at, episode_id, cold_start_s, cold_end_s
         from shorts where id in (select value from json_each(?)) order by k`,
    )
    .all(JSON.stringify(ids)) as {
    id: number;
    k: number | null;
    start_s: number;
    end_s: number;
    layout: string;
    hook_words: string;
    first_line: string;
    why: string | null;
    status: string;
    kept: number | null;
    archived_at: number | null;
    episode_id: number | null;
    cold_start_s: number | null;
    cold_end_s: number | null;
  }[];
  if (rows.length !== ids.length) throw new HandoffError("A card is gone. Reload the board.");
  for (const r of rows) {
    if (r.episode_id !== episodeId || r.k == null) throw new HandoffError("Every card must come from the same episode.");
    if (r.archived_at != null || r.kept !== 1 || r.status !== "idea") throw new HandoffError(`Card #${r.k} is not a kept idea any more. Reload the board.`);
    if (!r.hook_words.trim()) throw new HandoffError(`Card #${r.k} has no hook words.`);
    if (r.cold_start_s == null || r.cold_end_s == null) throw new HandoffError(`Card #${r.k}: pick a cold open first (Edit on the card).`);
  }
  const day = now.toISOString().slice(0, 10);
  const kit = format === "kit" ? (kitVersion ?? 1) : null;
  return {
    episode: episodeStem(ep.num),
    master: ep.masterPath,
    status: `APPROVED${profile().owner.name ? ` by ${profile().owner.name}` : ""} ${day} in ${getConfig().appName} for a ${format === "kit" ? `${profile().skills.reelKit} v${kit}` : format} cut (${formatLabel(format, kit, handoffNames())}); not cut yet`,
    clips: rows.map((r) => ({
      k: r.k as number,
      start: two(r.start_s),
      end: two(r.end_s),
      layout: r.layout,
      hook: r.hook_words,
      first_line: r.first_line,
      why: r.why ?? "",
      cold_start: two(r.cold_start_s as number),
      cold_end: two(r.cold_end_s as number),
    })),
    kit_version: kit,
  };
}

export type CutReelResult = {
  path: string;
  line: string;
  cards: number;
  episode: string;
  renumbered: { from: number; to: number }[];
  kitVersion: number | null;
};

/**
 * Cut reel: build the list, write it as a NEW file in the hand-off folder, then move the cards to Cutting with the file
 * and format remembered. Nothing is written anywhere else (never the episode folder, never the drive).
 */
export function cutReel(
  sql: Sql,
  cfg: { handoffsDir: string; drivePath: string; reelKitDir: string },
  input: { episodeId: number; cardIds: number[]; format: HandoffFormat },
  now = Date.now(),
): CutReelResult {
  // A card whose number an older reel file of this episode already uses gets the next free number first (its k is the
  // reel number the reel cut skill writes, so it must never meet an existing reel). All or nothing: the renumbering, the list
  // and the move to Cutting run in ONE transaction, and the hand-off file is written as its last step (a throw rolls the
  // renumbering back; a failed commit deletes the file it just wrote).
  // The kit's VERSION (the kit format names it; Studio only ever reads that one file).
  const kitVersion = input.format === "kit" ? readKitVersion(cfg.reelKitDir, cfg.drivePath) : null;
  buildHandoff(sql, input.episodeId, input.cardIds, input.format, new Date(now), kitVersion); // validate before anything changes
  const ep = getEpisode(sql, input.episodeId)!;
  const used = usedReelNumbers(sql, { num: ep.num, reelDirs: ep.reelDirs });
  const renumbered: { from: number; to: number }[] = [];
  const out: { file: string | null; moved: number } = { file: null, moved: 0 };
  try {
    sql.transaction(() => {
      const ks = sql.prepare("select id, k from shorts where id in (select value from json_each(?)) order by k").all(JSON.stringify([...new Set(input.cardIds)])) as { id: number; k: number }[];
      for (const c of ks) {
        if (!used.has(c.k)) continue;
        const to = nextK(sql, input.episodeId);
        sql.prepare("update shorts set k = ?, updated_at = ? where id = ?").run(to, now, c.id);
        renumbered.push({ from: c.k, to });
      }
      const list = buildHandoff(sql, input.episodeId, input.cardIds, input.format, new Date(now), kitVersion);
      // The cards move first (inside the transaction); the file is written last and its path stored right after.
      const upd = sql.prepare(
        `update shorts set status = 'cutting', handoff_format = ?, handoff_kit_version = ?, handoff_at = ?, cutting_at = ?, hold_key = null, updated_at = ?
          where id = ? and status = 'idea' and kept = 1 and archived_at is null`,
      );
      const ids = [...new Set(input.cardIds)];
      for (const id of ids) out.moved += upd.run(input.format, kitVersion, now, now, now, id).changes;
      if (out.moved !== ids.length) throw new HandoffError("A card changed meanwhile. Reload the board.");
      out.file = writeHandoffFile(cfg.handoffsDir, cfg.drivePath, reelsListName(ep.num), list, new Date(now));
      const setPath = sql.prepare("update shorts set handoff_path = ? where id = ?");
      for (const id of ids) setPath.run(out.file, id);
    })();
  } catch (e) {
    renumbered.length = 0;
    if (out.file) fs.rmSync(out.file, { force: true }); // the commit failed after the write: no orphan list
    throw e;
  }
  const file = out.file as string;
  return { path: file, line: pasteLine(ep.num, ep.title, input.format, file, kitVersion, handoffNames()), cards: out.moved, episode: ep.label, renumbered, kitVersion };
}
