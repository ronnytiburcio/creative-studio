/**
 * The Lane A reel kit in Studio (Phase 7 slice 2, D1 to D3; server only). Studio never writes the kit, a reel folder or a
 * `kit.json`: it reads them.
 *
 *   - readKitVersion(): the ONE reader of the kit's `VERSION` file (`<STUDIO_REEL_KIT_DIR>/VERSION`, nothing else in that
 *     folder): O_RDONLY | O_NOFOLLOW, a regular file of at most 16 bytes, /^\d{1,4}\s*$/, never on the drive; anything
 *     else = 1. Cut reel names it in its kit hand-off.
 *   - syncKitNotes(): worker only (ShortMomentsQueue, every 60 s). For every visible Lane A video it looks for the sibling
 *     `<file stem minus a trailing " vN"> kit.json` (the reel kit's tests.md) in its folder's guarded listing and reads it
 *     through src/lib/textread.ts readKitNote (`.json` only for names ending ` kit.json`, 64 KB, inside the enabled
 *     roots, no symlink escape), zod against the exact tests.md shape. Cached by size + mtime in `reel_kit_notes`; a
 *     refused note (junk, wrong shape, oversize, a symlink out) is an error row, never a crash; a note that vanished from a
 *     readable folder drops its row (= "Before kit"). An unreadable root changes nothing.
 *   - The comparison: the channel's median "% viewed" over its Shorts, Kit tags, the Before kit / Kit vN groups and the
 *     kit test winner rule (the A7 rule: 7 days, 300 views, beats the same version's no-test median by 5 points with at
 *     least 2 such baseline reels). Read time only; nothing acts on a winner.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { driveMounted, rootAccessible, type DriveCfg } from "../fsguard";
import { onDrive } from "../privatefile";
import { KIT_NOTE_SUFFIX, listGuardedDir, readKitNote, statKitNote, TextReadError } from "../textread";
import { LATEST_YT_METRICS } from "../youtube/sql";
import { profile } from "../profile";

type Sql = Database.Database;

export const KIT_DEFAULT_VERSION = 1;
export const KIT_VERSION_MAX_BYTES = 16;
const VERSION_TEXT = /^(\d{1,4})\s*$/;

/** The kit's version from `<dir>/VERSION` (see the module comment); 1 when it is missing, odd or refused. */
export function readKitVersion(dir: string, drivePath: string): number {
  if (!dir || !path.isAbsolute(dir)) return KIT_DEFAULT_VERSION;
  const file = path.join(path.resolve(dir), "VERSION");
  let fd: number | null = null;
  try {
    if (onDrive(file, drivePath) || onDrive(fs.realpathSync(file), drivePath)) return KIT_DEFAULT_VERSION;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > KIT_VERSION_MAX_BYTES) return KIT_DEFAULT_VERSION;
    const buf = Buffer.alloc(KIT_VERSION_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > KIT_VERSION_MAX_BYTES) return KIT_DEFAULT_VERSION;
    const m = VERSION_TEXT.exec(buf.subarray(0, n).toString("utf8"));
    const v = m ? Number(m[1]) : NaN;
    return Number.isInteger(v) && v >= 1 ? v : KIT_DEFAULT_VERSION;
  } catch {
    return KIT_DEFAULT_VERSION;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// ------------------------------------------------------------------------------------------------ kit notes (worker)

/** `Episode 5 Reel 1 v3.mp4` -> `Episode 5 Reel 1 kit.json`; `Speed to Lead Reel v1.mp4` -> `Speed to Lead Reel kit.json`. */
export function kitNoteNameFor(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/ v\d{1,3}$/i, "");
  return `${stem}${KIT_NOTE_SUFFIX}`;
}

/** The exact kit note shape the reel kit documents (its tests.md): no other keys; `kit` = the kit's name (profile). */
export function kitNoteSchema(kit: string) {
  return z
    .object({
      kit: z.literal(kit),
      version: z.number().int().min(1).max(9999),
      test: z.union([z.null(), z.object({ change: z.string().trim().min(1).max(200), detail: z.string().max(1000) }).strict()]),
    })
    .strict();
}
export type KitNote = { kit: string; version: number; test: null | { change: string; detail: string } };

/** The active profile's reel kit name (`skills.reelKit`). */
export const kitName = () => profile().skills.reelKit;

export const KIT_NOTE_NOT_JSON = "Not valid JSON.";
/** Stored as the note's error: keep the wording stable (a stored refusal is compared, never rewritten when equal). */
export const kitNoteBadShape = (kit = kitName()) => `Not the ${kit} kit.json shape.`;
const KIT_NOTE_FAILED = "Could not read the kit note.";

/** A kit note's text -> the note, or a terse reason. */
export function parseKitNote(text: string, kit = kitName()): { ok: true; note: KitNote } | { ok: false; error: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: KIT_NOTE_NOT_JSON };
  }
  const p = kitNoteSchema(kit).safeParse(body);
  return p.success ? { ok: true, note: p.data as KitNote } : { ok: false, error: kitNoteBadShape(kit) };
}

export type KitSyncResult = { checked: number; read: number; errors: number; removed: number };

type StoredNote = { asset_id: number; note_name: string; size: number | null; mtime: number | null; error: string | null };

/** The worker's kit note pass (see the module comment). Never throws for one bad note. */
export function syncKitNotes(sql: Sql, drive: DriveCfg, now = Date.now()): KitSyncResult {
  const res: KitSyncResult = { checked: 0, read: 0, errors: 0, removed: 0 };
  const videos = sql
    .prepare(
      `select a.id, a.path, a.filename, r.path as root_path from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
        where s.key = 'rtm' and a.kind = 'video' and a.missing = 0 and a.ignored = 0 and r.enabled = 1`,
    )
    .all() as { id: number; path: string; filename: string; root_path: string }[];
  if (!videos.length) return res;
  const bases = (sql.prepare("select path from roots where enabled = 1").pluck().all() as string[]).filter(Boolean);
  const stored = new Map((sql.prepare("select asset_id, note_name, size, mtime, error from reel_kit_notes").all() as StoredNote[]).map((r) => [r.asset_id, r]));
  const mounted = driveMounted(drive);
  const readable = new Map<string, boolean>();
  const listings = new Map<string, Set<string>>();
  const upsert = sql.prepare(
    `insert into reel_kit_notes (asset_id, note_name, version, test_change, test_detail, size, mtime, read_at, error)
     values (@asset, @name, @version, @change, @detail, @size, @mtime, @now, @error)
     on conflict(asset_id) do update set note_name = excluded.note_name, version = excluded.version, test_change = excluded.test_change,
       test_detail = excluded.test_detail, size = excluded.size, mtime = excluded.mtime, read_at = excluded.read_at, error = excluded.error`,
  );
  const del = sql.prepare("delete from reel_kit_notes where asset_id = ?");
  const fail = (asset: number, name: string, error: string, size: number | null, mtime: number | null) => {
    upsert.run({ asset, name, version: null, change: null, detail: null, size, mtime, now, error });
    res.errors++;
  };
  for (const v of videos) {
    if (!readable.has(v.root_path)) readable.set(v.root_path, rootAccessible(v.root_path, drive.drivePath, mounted));
    if (!readable.get(v.root_path)) continue; // drive unplugged: keep what is stored
    res.checked++;
    const dir = path.dirname(v.path);
    if (!listings.has(dir)) listings.set(dir, new Set(listGuardedDir(dir, bases)));
    const name = kitNoteNameFor(v.filename);
    const have = stored.get(v.id);
    if (!listings.get(dir)!.has(name)) {
      if (have) res.removed += del.run(v.id).changes;
      continue;
    }
    const p = path.join(dir, name);
    let st: { size: number; mtimeMs: number };
    try {
      st = statKitNote(p, bases);
    } catch (e) {
      const error = e instanceof TextReadError ? e.message : KIT_NOTE_FAILED;
      // Gate fix: the same refusal already stored is not rewritten (read_at kept) or counted again every 60 s.
      if (have && have.note_name === name && have.error === error) continue;
      fail(v.id, name, error, null, null);
      continue;
    }
    if (have && have.note_name === name && have.size === st.size && have.mtime === st.mtimeMs) continue; // unchanged
    try {
      const r = readKitNote(p, bases);
      const parsed = parseKitNote(r.text);
      if (!parsed.ok) {
        fail(v.id, name, parsed.error, r.size, r.mtimeMs);
        continue;
      }
      upsert.run({
        asset: v.id,
        name,
        version: parsed.note.version,
        change: parsed.note.test?.change ?? null,
        detail: parsed.note.test?.detail ?? null,
        size: r.size,
        mtime: r.mtimeMs,
        now,
        error: null,
      });
      res.read++;
    } catch (e) {
      fail(v.id, name, e instanceof TextReadError ? e.message : KIT_NOTE_FAILED, st.size, st.mtimeMs);
    }
  }
  return res;
}

// ------------------------------------------------------------------------------------------------ tags + medians

export type KitTag = {
  /** `before` (no note, or a refused one) or `v<N>`. */
  group: string;
  version: number | null;
  change: string | null;
  detail: string | null;
  /** "Kit v1" / "Kit v1 · test: hook 170px" / "Before kit". */
  label: string;
  /** The note was refused (its reason; the reel counts as Before kit). */
  error: string | null;
};

export const BEFORE_KIT = "before";

export function kitTagOf(r: { version: number | null; test_change: string | null; test_detail?: string | null; error: string | null } | null | undefined): KitTag {
  if (!r || r.error || r.version == null) {
    return { group: BEFORE_KIT, version: null, change: null, detail: null, label: "Before kit", error: r?.error ?? null };
  }
  return {
    group: `v${r.version}`,
    version: r.version,
    change: r.test_change,
    detail: r.test_detail ?? null,
    label: r.test_change ? `Kit v${r.version} · test: ${r.test_change}` : `Kit v${r.version}`,
    error: null,
  };
}

/** The kit tag per asset (no row = Before kit). */
export function kitTagsFor(sql: Sql, assetIds: number[]): Map<number, KitTag> {
  const out = new Map<number, KitTag>();
  if (!assetIds.length) return out;
  const rows = sql
    .prepare("select asset_id, version, test_change, test_detail, error from reel_kit_notes where asset_id in (select value from json_each(?))")
    .all(JSON.stringify([...new Set(assetIds)])) as { asset_id: number; version: number | null; test_change: string | null; test_detail: string | null; error: string | null }[];
  for (const r of rows) out.set(r.asset_id, kitTagOf(r));
  return out;
}

export function median(nums: number[]): number | null {
  const v = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** One Short with its latest numbers and its matched file's kit note (the comparison's unit). */
export type KitShort = {
  videoId: string;
  title: string | null;
  publishedAt: number | null;
  views: number | null;
  avgViewPct: number | null;
  assetId: number | null;
  fileName: string | null;
  kit: KitTag;
};

/** Every live Short (not gone) with its latest numbers and kit tag. */
export function kitShorts(sql: Sql): KitShort[] {
  const rows = sql
    .prepare(
      `select v.video_id, v.title, v.published_at, m.views, m.avg_view_pct, a.id as asset_id, a.filename,
              n.version, n.test_change, n.test_detail, n.error
         from yt_videos v
         left join ${LATEST_YT_METRICS} m on m.video_id = v.video_id
         left join assets a on a.id = v.matched_asset_id
         left join reel_kit_notes n on n.asset_id = a.id
        where v.is_short = 1 and v.gone_at is null
        order by v.published_at desc, v.video_id`,
    )
    .all() as {
    video_id: string;
    title: string | null;
    published_at: number | null;
    views: number | null;
    avg_view_pct: number | null;
    asset_id: number | null;
    filename: string | null;
    version: number | null;
    test_change: string | null;
    test_detail: string | null;
    error: string | null;
  }[];
  return rows.map((r) => ({
    videoId: r.video_id,
    title: r.title,
    publishedAt: r.published_at,
    views: r.views,
    avgViewPct: r.avg_view_pct,
    assetId: r.asset_id,
    fileName: r.filename,
    kit: kitTagOf(r.asset_id != null && (r.version != null || r.error != null) ? r : null),
  }));
}

/** A Short that counts toward a median: its latest snapshot has "% viewed" and more than 0 views. */
export const countsForMedian = (s: { views: number | null; avgViewPct: number | null }) => s.avgViewPct != null && (s.views ?? 0) > 0;

export type ViewMedian = { median: number | null; count: number };

/** The channel's median "% viewed" over its Shorts that count (see countsForMedian). */
export function channelViewMedian(shorts: KitShort[]): ViewMedian {
  const pcts = shorts.filter(countsForMedian).map((s) => s.avgViewPct as number);
  return { median: median(pcts), count: pcts.length };
}

/** Each kit group's median ("before", "v1", ...), over the Shorts that count. */
export function groupMedians(shorts: KitShort[]): { group: string; label: string; median: number | null; count: number; total: number }[] {
  const groups = new Map<string, KitShort[]>();
  for (const s of shorts) groups.set(s.kit.group, [...(groups.get(s.kit.group) ?? []), s]);
  const order = (g: string) => (g === BEFORE_KIT ? -1 : Number(g.slice(1)));
  return [...groups.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([group, list]) => {
      const pcts = list.filter(countsForMedian).map((s) => s.avgViewPct as number);
      return { group, label: group === BEFORE_KIT ? "Before kit" : `Kit ${group}`, median: median(pcts), count: pcts.length, total: list.length };
    });
}

// ------------------------------------------------------------------------------------------------ kit tests (A7)

export const WIN_MIN_DAYS = 7;
export const WIN_MIN_VIEWS = 300;
export const WIN_MIN_POINTS = 5;
export const WIN_MIN_BASELINE = 2;
const DAY_MS = 86_400_000;

export type KitVersionBaseline = { version: number; baselineMedian: number | null; baselineCount: number };
export type KitTestReel = {
  videoId: string;
  title: string | null;
  fileName: string | null;
  version: number;
  change: string;
  detail: string | null;
  views: number | null;
  avgViewPct: number | null;
  daysUp: number | null;
  /** Points over the version's no-test median (null = not enough baseline reels, or no numbers yet). */
  beatBy: number | null;
  winner: boolean;
  /** Why it is not (yet) a winner, when it is not. */
  note: string | null;
};
export type KitTestsSummary = { versions: KitVersionBaseline[]; tests: KitTestReel[] };

/**
 * The A7 rule (PHASE-7 A7): a test reel wins when its Short has been up 7+ days with 300+ views and its "% viewed" beats
 * the median of the SAME kit version's no-test reels (Shorts that count: a "% viewed" and views > 0) by 5+ points; that
 * needs at least 2 such baseline reels, else "not enough kit reels yet".
 */
export function kitTests(shorts: KitShort[], now = Date.now()): KitTestsSummary {
  const versions = [...new Set(shorts.map((s) => s.kit.version).filter((v): v is number => v != null))].sort((a, b) => a - b);
  const base = new Map<number, KitVersionBaseline>();
  for (const v of versions) {
    const pcts = shorts.filter((s) => s.kit.version === v && !s.kit.change && countsForMedian(s)).map((s) => s.avgViewPct as number);
    base.set(v, { version: v, baselineMedian: median(pcts), baselineCount: pcts.length });
  }
  const tests: KitTestReel[] = shorts
    .filter((s) => s.kit.version != null && s.kit.change)
    .map((s) => {
      const b = base.get(s.kit.version!)!;
      const daysUp = s.publishedAt != null ? Math.floor((now - s.publishedAt) / DAY_MS) : null;
      const enoughBase = b.baselineCount >= WIN_MIN_BASELINE && b.baselineMedian != null;
      const beatBy = enoughBase && s.avgViewPct != null ? Math.round((s.avgViewPct - (b.baselineMedian as number)) * 10) / 10 : null;
      const old = s.publishedAt != null && now - s.publishedAt >= WIN_MIN_DAYS * DAY_MS;
      const views = (s.views ?? 0) >= WIN_MIN_VIEWS;
      const raw = enoughBase && s.avgViewPct != null ? s.avgViewPct - (b.baselineMedian as number) : null;
      const winner = Boolean(old && views && raw != null && raw >= WIN_MIN_POINTS);
      const note = winner
        ? null
        : !enoughBase
          ? "not enough kit reels yet"
          : !old
            ? `up ${daysUp ?? 0} of ${WIN_MIN_DAYS} days`
            : !views
              ? `${s.views ?? 0} of ${WIN_MIN_VIEWS} views`
              : raw == null
                ? "no numbers yet"
                : `beats the kit by ${(Math.round(raw * 10) / 10).toFixed(1)} of ${WIN_MIN_POINTS} points`;
      return {
        videoId: s.videoId,
        title: s.title,
        fileName: s.fileName,
        version: s.kit.version!,
        change: s.kit.change!,
        detail: s.kit.detail,
        views: s.views,
        avgViewPct: s.avgViewPct,
        daysUp,
        beatBy,
        winner,
        note,
      };
    });
  return { versions: versions.map((v) => base.get(v)!), tests };
}
