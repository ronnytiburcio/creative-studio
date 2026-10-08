/**
 * Shorts board automatic moves (Phase 6 C2 + C3; server only). Forward only, never backward by themselves:
 *
 *   Cutting -> Review   when a visible indexed reel file for the card's episode + number, written after the card entered
 *                       Cutting (file mtime >= `cutting_at`, else the card's creation; so an older reel that happens to
 *                       carry the same number never counts), exists in one of the episode's reel folders
 *                       (`episodes.reel_dirs`: the episode folder + a sibling holding `<prefix>N reels.json`):
 *                       `<prefix>N Reel K.mp4` (rank 1), `<prefix>N Reel K vN.mp4` (rank N: the highest N wins) or
 *                       `reels/reelK/out/reelK.mp4` (rank 0, the skill's working copy); ties go to the newest file. Or
 *                       the owner's Link a file (manual: never overwritten by a match; Unlink = back to automatic).
 *   Review -> Ready     only on the owner's Approve click, which needs a caption md for the output (findCaption).
 *   Ready -> Posted     when a YouTube Short (`yt_videos`, Phase 5 matching or its Link a file) is linked to the output.
 *
 * A card the owner moved backward by hand carries `hold_key` (the trigger that was true then); the automatic move out of that
 * column fires only for a different trigger (a new reel version, another Short). Automatic moves only ever start from
 * the column right before (never skipping one). syncBoard() runs in the worker every 15 s: SQL over the index plus
 * guarded caption reads (src/lib/textread.ts with .md only: read only, inside the enabled roots, 2 MB cap, no symlink
 * escape) for Review / Ready cards only, and only when something may have changed (captionDue: a found caption when the
 * reel or the caption file is newer than the last check, a missing one at most every 60 s). Nothing here writes
 * anywhere but the DB.
 */
import path from "node:path";
import type Database from "better-sqlite3";
import { driveMounted, rootAccessible, type DriveCfg } from "../fsguard";
import { CAPTION_EXTS, listGuardedDir, readGuardedText, statGuardedText, TextReadError } from "../textread";
import { parseReelDirs } from "./episodes";
import { SHORT_STATUSES, type ShortStatus } from "./rules";
import { laneNames } from "../clients-admin";
import { captionName, episodePrefix, reelFileRes, reelNumberRe } from "./naming";

type Sql = Database.Database;

export class ShortOutputError extends Error {}

const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * How well a file (path relative to a reel folder, `/` separators) names reel k of episode num: null = not this reel.
 * `<prefix>N Reel K vN.mp4` = N, `<prefix>N Reel K.mp4` = 1, `reels/reelK/out/reelK.mp4` = 0. "Reel 3B" or "Reel 31" are
 * not reel 3; another episode's files never match.
 */
export function outputRank(rel: string, num: number, k: number, prefix = episodePrefix()): number | null {
  const { plain, versioned } = reelFileRes(num, k, prefix);
  const work = new RegExp(`^reels/reel${k}/out/reel${k}\\.mp4$`, "i");
  if (plain.test(rel)) return 1;
  const v = versioned.exec(rel);
  if (v) return Number(v[1]);
  if (work.test(rel)) return 0;
  return null;
}

type Candidate = { id: number; path: string; mtime: number | null };

/** A reel file may be up to this much older than the card's Cutting time (clock / mtime granularity). */
const MTIME_SLACK_MS = 60_000;

/** Visible indexed videos under a folder (any depth), from the index (no drive read). */
function videosUnder(sql: Sql, dir: string): Candidate[] {
  return sql
    .prepare(
      `select a.id, a.path, a.mtime from assets a join roots r on r.id = a.root_id
        where a.kind = 'video' and a.missing = 0 and a.ignored = 0 and r.enabled = 1 and a.path like ? escape '\\'`,
    )
    .all(`${escLike(dir.replace(/\/+$/, ""))}/%`) as Candidate[];
}

/**
 * The best matching reel file for card k of an episode (see outputRank), or null. `since` = only files whose mtime is at
 * or after it (minus a minute of slack); null = any age.
 */
export function bestOutput(
  sql: Sql,
  ep: { num: number; reelDirs: string[] },
  k: number,
  since: number | null = null,
): { assetId: number; rank: number; path: string } | null {
  let best: { assetId: number; rank: number; path: string; mtime: number } | null = null;
  for (const dir of ep.reelDirs) {
    const base = dir.replace(/\/+$/, "");
    for (const c of videosUnder(sql, base)) {
      const rel = c.path.slice(base.length + 1).split(path.sep).join("/");
      const rank = outputRank(rel, ep.num, k);
      if (rank == null) continue;
      const mtime = c.mtime ?? 0;
      if (since != null && mtime < since - MTIME_SLACK_MS) continue;
      if (!best || rank > best.rank || (rank === best.rank && (mtime > best.mtime || (mtime === best.mtime && c.id > best.assetId)))) {
        best = { assetId: c.id, rank, path: c.path, mtime };
      }
    }
  }
  return best ? { assetId: best.assetId, rank: best.rank, path: best.path } : null;
}

/**
 * Reel numbers already used by files of this episode in its reel folders (any indexed file, hidden ones too): `<prefix>N
 * Reel K...` and `reels/reelK/...`. New cards and Cut reel never hand out these numbers, so a new reel can never be
 * confused with (or written over) an older one.
 */
export function usedReelNumbers(sql: Sql, ep: { num: number; reelDirs: string[] }): Set<number> {
  const used = new Set<number>();
  const named = reelNumberRe(ep.num);
  const work = /^reels\/reel(\d{1,4})\//i;
  for (const dir of ep.reelDirs) {
    const base = dir.replace(/\/+$/, "");
    const rows = sql.prepare("select path from assets where path like ? escape '\\' and ignored = 0").pluck().all(`${escLike(base)}/%`) as string[];
    for (const p of rows) {
      const rel = p.slice(base.length + 1).split(path.sep).join("/");
      const m = named.exec(path.basename(rel)) ?? work.exec(rel);
      if (m) used.add(Number(m[1]));
    }
  }
  return used;
}

// ------------------------------------------------------------------------------------------------ captions

export type CaptionFind = { state: "found"; path: string; preview: string } | { state: "none"; expected: string } | { state: "unreadable" };

const CAPTION_NAME = /caption.*\.md$/i;
const PREVIEW_LINES = 8;
const PREVIEW_MAX = 800;

/** The caption's first lines (blank lines out, markdown heading marks off), for the card. */
export function captionPreview(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^#{1,6}\s+/, "").trim())
    .filter(Boolean)
    .slice(0, PREVIEW_LINES)
    .map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
  let out = lines.join("\n");
  if (out.length > PREVIEW_MAX) out = `${out.slice(0, PREVIEW_MAX - 1)}…`;
  return out;
}

type CaptionCard = {
  k: number | null;
  num: number | null;
  folder: string | null;
  reelDirs: string | null;
  outputPath: string;
  outputRoot: string;
};

/**
 * Where a card's caption may be, in order. Episode cards: `<prefix>N Reel K caption.md` next to the reel or in any reel
 * folder, then any `*caption*.md` in `reels/reelK/` or `reels/reelK/out/` of a reel folder. Explainer cards (no episode):
 * any `*caption*.md` in the reel's folder (and its parent when the reel sits in an `out/` folder).
 */
function captionCandidates(c: CaptionCard, bases: string[]): string[] {
  const outDir = path.dirname(c.outputPath);
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  const anyCaption = (dir: string) =>
    listGuardedDir(dir, bases)
      .filter((n) => CAPTION_NAME.test(n))
      .sort()
      .forEach((n) => add(path.join(dir, n)));
  if (c.num != null && c.k != null && c.folder) {
    const dirs = [outDir, ...parseReelDirs(c.reelDirs, c.folder)];
    const name = captionName(c.num, c.k);
    for (const d of dirs) add(path.join(d, name));
    for (const d of parseReelDirs(c.reelDirs, c.folder)) {
      anyCaption(path.join(d, "reels", `reel${c.k}`));
      anyCaption(path.join(d, "reels", `reel${c.k}`, "out"));
    }
  } else {
    anyCaption(outDir);
    if (path.basename(outDir).toLowerCase() === "out") anyCaption(path.dirname(outDir));
  }
  return out;
}

const CAPTION_SQL = `
  select sh.k, e.num, e.folder, e.reel_dirs, a.path as output_path, r.path as output_root
    from shorts sh join assets a on a.id = sh.output_asset_id join roots r on r.id = a.root_id
    left join episodes e on e.id = sh.episode_id
   where sh.id = ?`;

/** The caption md for a card's output (guarded reads, .md only). `unreadable` = its root cannot be read now. */
export function findCaption(sql: Sql, cardId: number, drive: DriveCfg): CaptionFind {
  const r = sql.prepare(CAPTION_SQL).get(cardId) as
    | { k: number | null; num: number | null; folder: string | null; reel_dirs: string | null; output_path: string; output_root: string }
    | undefined;
  if (!r) return { state: "none", expected: "a reel file first" };
  if (!rootAccessible(r.output_root, drive.drivePath, driveMounted(drive))) return { state: "unreadable" };
  const bases = (sql.prepare("select path from roots where enabled = 1").pluck().all() as string[]).filter(Boolean);
  const card: CaptionCard = { k: r.k, num: r.num, folder: r.folder, reelDirs: r.reel_dirs, outputPath: r.output_path, outputRoot: r.output_root };
  for (const p of captionCandidates(card, bases)) {
    try {
      const t = readGuardedText(p, bases, CAPTION_EXTS);
      return { state: "found", path: p, preview: captionPreview(t.text) };
    } catch (e) {
      if (!(e instanceof TextReadError)) throw e;
    }
  }
  const expected = r.num != null && r.k != null ? `${captionName(r.num, r.k)} next to the reel` : "a caption .md in the reel's folder";
  return { state: "none", expected };
}

function storeCaption(sql: Sql, cardId: number, f: CaptionFind, now: number): boolean {
  if (f.state === "unreadable") return false;
  const cur = sql.prepare("select caption_path, caption_preview from shorts where id = ?").get(cardId) as { caption_path: string | null; caption_preview: string | null };
  const path_ = f.state === "found" ? f.path : null;
  const preview = f.state === "found" ? f.preview : null;
  if (cur.caption_path === path_ && cur.caption_preview === preview) {
    sql.prepare("update shorts set caption_checked_at = ? where id = ?").run(now, cardId);
    return false;
  }
  sql.prepare("update shorts set caption_path = ?, caption_preview = ?, caption_checked_at = ?, updated_at = ? where id = ?").run(path_, preview, now, now, cardId);
  return true;
}

/**
 * Look a card's caption up now and store it (Link a file / Unlink, in the web process): the card shows its caption at once
 * instead of "No caption file yet" until the worker's next 15 s sync. Same guarded reader; an unreadable root or an
 * unexpected read error leaves the stored caption alone (the worker's sync tries again).
 */
export function refreshCaption(sql: Sql, cardId: number, drive: DriveCfg, now = Date.now()): CaptionFind["state"] | "error" {
  try {
    const f = findCaption(sql, cardId, drive);
    storeCaption(sql, cardId, f, now);
    return f.state;
  } catch {
    return "error";
  }
}

// ------------------------------------------------------------------------------------------------ the worker's sync

/** The Short linked to an output file (the newest when several), or null. */
export function shortForOutput(sql: Sql, assetId: number): string | null {
  return (
    (sql
      .prepare("select video_id from yt_videos where is_short = 1 and gone_at is null and matched_asset_id = ? order by published_at desc, video_id limit 1")
      .pluck()
      .get(assetId) as string | undefined) ?? null
  );
}

export type BoardSyncResult = { toReview: number; outputsUpdated: number; captions: number; toPosted: number };

/** A card with no caption yet is looked up again at most this often by the worker's sync. */
export const CAPTION_RECHECK_MS = 60_000;

function enabledRootPaths(sql: Sql): string[] {
  return (sql.prepare("select path from roots where enabled = 1").pluck().all() as string[]).filter(Boolean);
}

/**
 * Whether the sync should look a card's caption up again (it was checked before): no caption yet = every 60 s; a found
 * one = only when the reel file changed since the check (its indexed mtime), or the caption file changed / vanished (a
 * guarded stat, no bytes read).
 */
function captionDue(c: { caption_path: string | null; caption_checked_at: number | null; out_mtime: number | null }, now: number, bases: () => string[]): boolean {
  const checked = c.caption_checked_at ?? 0;
  if (!c.caption_path) return now - checked >= CAPTION_RECHECK_MS;
  if (c.out_mtime != null && c.out_mtime > checked) return true;
  try {
    return statGuardedText(c.caption_path, bases(), CAPTION_EXTS).mtimeMs > checked;
  } catch {
    return true; // gone or refused now: look again (an unreadable root is skipped by findCaption)
  }
}

/** One pass of the automatic moves (worker, every 15 s). See the module comment. */
export function syncBoard(sql: Sql, drive: DriveCfg, now = Date.now()): BoardSyncResult {
  const res: BoardSyncResult = { toReview: 0, outputsUpdated: 0, captions: 0, toPosted: 0 };
  // 1. Reel files: Cutting -> Review; a newer version replaces an automatic output in Review.
  const cards = sql
    .prepare(
      `select sh.id, sh.k, sh.status, sh.output_asset_id, sh.hold_key, coalesce(sh.cutting_at, sh.created_at) as since, e.num, e.folder, e.reel_dirs
         from shorts sh join episodes e on e.id = sh.episode_id
        where sh.archived_at is null and sh.k is not null and sh.status in ('cutting','review') and coalesce(sh.output_source, '') != 'manual'`,
    )
    .all() as {
    id: number;
    k: number;
    status: ShortStatus;
    output_asset_id: number | null;
    hold_key: string | null;
    since: number;
    num: number;
    folder: string;
    reel_dirs: string | null;
  }[];
  const toReview = sql.prepare(
    "update shorts set output_asset_id = ?, output_source = 'auto', status = 'review', kept = 1, hold_key = null, updated_at = ? where id = ? and status = 'cutting'",
  );
  // A newer reel replaces the output: its caption is looked up again on this pass (caption_checked_at cleared).
  const newer = sql.prepare("update shorts set output_asset_id = ?, output_source = 'auto', caption_checked_at = null, updated_at = ? where id = ? and status = 'review'");
  for (const c of cards) {
    const best = bestOutput(sql, { num: c.num, reelDirs: parseReelDirs(c.reel_dirs, c.folder) }, c.k, c.since);
    if (!best) continue;
    if (c.status === "cutting") {
      if (c.hold_key === `out:${best.assetId}`) continue; // the owner moved it back with this file there: wait for a new one
      res.toReview += toReview.run(best.assetId, now, c.id).changes;
    } else if (best.assetId !== c.output_asset_id) {
      res.outputsUpdated += newer.run(best.assetId, now, c.id).changes;
    }
  }
  // 2. Captions for cards in Review / Ready to post (display + the Approve gate; Posted cards keep theirs). Cheap when
  //    nothing changed: a found caption is looked up again only when the reel's mtime or the caption file's mtime is newer
  //    than the last check (or the caption is gone); a card with no caption yet is looked up at most every 60 s.
  const withOutput = sql
    .prepare(
      `select sh.id, sh.caption_path, sh.caption_checked_at, a.mtime as out_mtime from shorts sh join assets a on a.id = sh.output_asset_id
        where sh.archived_at is null and sh.status in ('review','ready')`,
    )
    .all() as { id: number; caption_path: string | null; caption_checked_at: number | null; out_mtime: number | null }[];
  let bases: string[] | null = null;
  for (const c of withOutput) {
    if (c.caption_checked_at != null && !captionDue(c, now, () => (bases ??= enabledRootPaths(sql)))) continue;
    try {
      if (storeCaption(sql, c.id, findCaption(sql, c.id, drive), now)) res.captions++;
    } catch {
      /* an unexpected read error leaves the stored caption alone */
    }
  }
  // 3. Ready -> Posted when a Short is linked to the output.
  res.toPosted += syncPosted(sql, now);
  return res;
}

/** Ready -> Posted for cards whose output has a linked YouTube Short (not the one a backward move is holding). */
export function syncPosted(sql: Sql, now = Date.now(), onlyCard: number | null = null): number {
  const ready = sql
    .prepare("select id, output_asset_id, hold_key from shorts where archived_at is null and status = 'ready' and output_asset_id is not null and (? is null or id = ?)")
    .all(onlyCard, onlyCard) as { id: number; output_asset_id: number; hold_key: string | null }[];
  const upd = sql.prepare("update shorts set status = 'posted', yt_video_id = ?, posted_at = ?, hold_key = null, updated_at = ? where id = ? and status = 'ready'");
  let n = 0;
  for (const c of ready) {
    const vid = shortForOutput(sql, c.output_asset_id);
    if (!vid || c.hold_key === `yt:${vid}`) continue;
    n += upd.run(vid, now, now, c.id).changes;
  }
  return n;
}

// ------------------------------------------------------------------------------------------------ the owner's actions

function liveCard(sql: Sql, id: number) {
  const r = sql
    .prepare(
      `select sh.id, sh.episode_id, sh.k, sh.status, sh.output_asset_id, sh.output_source, sh.archived_at, e.num, e.folder, e.reel_dirs,
              coalesce(sh.cutting_at, sh.created_at) as since
         from shorts sh left join episodes e on e.id = sh.episode_id where sh.id = ?`,
    )
    .get(id) as
    | {
        id: number;
        episode_id: number | null;
        k: number | null;
        status: ShortStatus;
        output_asset_id: number | null;
        output_source: string | null;
        archived_at: number | null;
        num: number | null;
        folder: string | null;
        reel_dirs: string | null;
        since: number;
      }
    | undefined;
  if (!r || r.archived_at != null) throw new ShortOutputError("That card is gone (discarded).");
  return r;
}

/**
 * Link a file: the owner's reel for a card (a visible Lane A video). Never overwritten by the automatic match. A card in Idea
 * or Cutting moves to Review (his own forward move; the only Review trigger for an explainer card). The caption is looked
 * up right after (refreshCaption), so the card never shows "No caption file yet" for one that is already there.
 */
export function linkOutput(sql: Sql, cardId: number, assetId: number, drive: DriveCfg, now = Date.now()): { filename: string; moved: boolean } {
  const r = sql.transaction(() => {
    const c = liveCard(sql, cardId);
    const a = sql
      .prepare(
        `select a.filename from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
          where a.id = ? and a.kind = 'video' and a.missing = 0 and a.ignored = 0 and r.enabled = 1 and s.key = 'rtm'`,
      )
      .get(assetId) as { filename: string } | undefined;
    if (!a) throw new ShortOutputError(`Pick a visible ${laneNames(sql).rtm} video.`);
    const moved = c.status === "idea" || c.status === "cutting";
    sql
      .prepare(
        `update shorts set output_asset_id = ?, output_source = 'manual', hold_key = null, caption_path = null, caption_preview = null,
           status = case when status in ('idea','cutting') then 'review' else status end, kept = coalesce(kept, 1), updated_at = ? where id = ?`,
      )
      .run(assetId, now, cardId);
    return { filename: a.filename, moved };
  })();
  refreshCaption(sql, cardId, drive, now);
  return r;
}

/** Unlink the owner's file: back to the automatic match (found at once if any, its caption too). The column never changes. */
export function unlinkOutput(sql: Sql, cardId: number, drive: DriveCfg, now = Date.now()): { rematched: boolean } {
  const r = sql.transaction(() => {
    const c = liveCard(sql, cardId);
    if (c.output_source !== "manual") throw new ShortOutputError("This reel was matched automatically: link another file to change it.");
    const best =
      c.num != null && c.k != null && c.folder ? bestOutput(sql, { num: c.num, reelDirs: parseReelDirs(c.reel_dirs, c.folder) }, c.k, c.since) : null;
    sql
      .prepare("update shorts set output_asset_id = ?, output_source = ?, caption_path = null, caption_preview = null, updated_at = ? where id = ?")
      .run(best?.assetId ?? null, best ? "auto" : null, now, cardId);
    return { rematched: Boolean(best) };
  })();
  if (r.rematched) refreshCaption(sql, cardId, drive, now);
  return r;
}

/**
 * Approve (Review -> Ready to post): needs the reel and its caption md (looked up again right now, through the guarded
 * reader). Then a Short already linked to the reel moves it on to Posted at once.
 */
export function approveShort(sql: Sql, cardId: number, drive: DriveCfg, now = Date.now()): { posted: boolean } {
  const c = liveCard(sql, cardId);
  if (c.status !== "review") throw new ShortOutputError("Only a card in Review can be approved.");
  if (c.output_asset_id == null) throw new ShortOutputError("No reel file yet: it moves here when the file shows up, or use Link a file.");
  const f = findCaption(sql, cardId, drive);
  if (f.state === "unreadable") throw new ShortOutputError("The reel's drive is not readable right now.");
  storeCaption(sql, cardId, f, now);
  if (f.state === "none") throw new ShortOutputError(`No caption file yet: add ${f.expected}.`);
  sql.prepare("update shorts set status = 'ready', approved_at = ?, hold_key = null, updated_at = ? where id = ? and status = 'review'").run(now, now, cardId);
  return { posted: syncPosted(sql, now, cardId) > 0 };
}

/**
 * The hold a backward move by hand leaves (see the module comment): moving into Cutting holds the reel file that is
 * there now, into Ready to post the Short that is linked now; other columns have no automatic move into the next one.
 */
export function holdKeyFor(sql: Sql, cardId: number, target: ShortStatus): string | null {
  const c = liveCard(sql, cardId);
  if (target === "cutting") {
    const best =
      c.num != null && c.k != null && c.folder ? bestOutput(sql, { num: c.num, reelDirs: parseReelDirs(c.reel_dirs, c.folder) }, c.k, c.since) : null;
    const id = best?.assetId ?? c.output_asset_id;
    return `out:${id ?? "none"}`;
  }
  if (target === "ready") {
    const vid = c.output_asset_id != null ? shortForOutput(sql, c.output_asset_id) : null;
    return `yt:${vid ?? "none"}`;
  }
  return null;
}

export const statusIndex = (s: ShortStatus) => SHORT_STATUSES.indexOf(s);
