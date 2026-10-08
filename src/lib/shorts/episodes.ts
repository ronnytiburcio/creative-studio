/**
 * Lane A episodes (Phase 6 A1 / A2; server only).
 *
 * An episode = a `<prefix>N.srt` (exactly that name: `<prefix>6 take1303.srt`, `<prefix>5 Reel 1.srt` or `<prefix>6 Short.srt`
 * are not episodes) in the same folder as a visible Lane A video classified `episode` (the master; the longest when several
 * share a folder). The SRT stem is the key: folder names and master file names do not match the episode numbers.
 *
 * syncEpisodes() runs in the worker only (ShortMomentsQueue: at start, every 30 s and before each job). It lists each
 * master's folder and reads the SRTs through the guarded text reader (src/lib/textread.ts: inside the master's root,
 * .srt only, 2 MB cap, read only) and stores the parsed cues in `episodes` (re-read only when size or mtime change).
 * A root that cannot be read now (drive unplugged) is skipped: nothing is marked gone. Nothing is ever written to the
 * drive. The app only reads the table.
 */
import path from "node:path";
import type Database from "better-sqlite3";
import { driveMounted, rootAccessible, type DriveCfg } from "../fsguard";
import { MOMENTS_JOB } from "../jobs";
import { listGuardedDir, listGuardedSubdirs, readGuardedText, statGuardedText, TextReadError } from "../textread";
import { cuesEnd, packCues, parseSrt, unpackCues, type Cue } from "./srt";
import { episodeSentences, WORDS_VERSION } from "./words";
import type { MomentUnit } from "./rules";
import { episodeSrtRe, reelsListName } from "./naming";

type Sql = Database.Database;


/** A visible Lane A episode master (any root of the rtm section, enabled, file present). */
const MASTER_SQL = `
  select a.id, a.path, a.duration_s, a.root_id, r.path as root_path
    from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
   where s.key = 'rtm' and a.asset_class = 'episode' and a.kind = 'video'
     and a.missing = 0 and a.ignored = 0 and r.enabled = 1`;

type MasterRow = { id: number; path: string; duration_s: number | null; root_id: number; root_path: string };

export type EpisodeSyncResult = { folders: number; found: number; read: number; gone: number; errors: string[] };

/** The worker's episode sync (see the module comment). */
export function syncEpisodes(sql: Sql, cfg: DriveCfg, now = Date.now()): EpisodeSyncResult {
  const res: EpisodeSyncResult = { folders: 0, found: 0, read: 0, gone: 0, errors: [] };
  const masters = sql.prepare(MASTER_SQL).all() as MasterRow[];
  // Folder -> its master (the longest episode video in it).
  const byFolder = new Map<string, MasterRow>();
  for (const m of masters) {
    const dir = path.dirname(m.path);
    const cur = byFolder.get(dir);
    if (!cur || (m.duration_s ?? 0) > (cur.duration_s ?? 0)) byFolder.set(dir, m);
  }
  const mounted = driveMounted(cfg);
  const readableRoots = new Map<string, boolean>();
  const readable = (root: string) => {
    if (!readableRoots.has(root)) readableRoots.set(root, rootAccessible(root, cfg.drivePath, mounted));
    return readableRoots.get(root)!;
  };
  const existing = sql.prepare("select id, srt_path, srt_size, srt_mtime, cues, gone_at from episodes").all() as {
    id: number;
    srt_path: string;
    srt_size: number | null;
    srt_mtime: number | null;
    cues: string | null;
    gone_at: number | null;
  }[];
  const byPath = new Map(existing.map((e) => [e.srt_path, e]));
  const seen = new Set<string>();
  const upsertNew = sql.prepare(
    `insert into episodes (srt_path, folder, stem, num, title, master_asset_id, srt_size, srt_mtime, cues, cue_count, duration_s, read_error, first_seen_at, last_seen_at, gone_at)
     values (@srtPath, @folder, @stem, @num, @title, @master, @size, @mtime, @cues, @count, @duration, @error, @now, @now, null)
     on conflict (srt_path) do update set folder = excluded.folder, stem = excluded.stem, num = excluded.num, title = excluded.title,
       master_asset_id = excluded.master_asset_id, srt_size = coalesce(excluded.srt_size, episodes.srt_size),
       srt_mtime = coalesce(excluded.srt_mtime, episodes.srt_mtime), cues = coalesce(excluded.cues, episodes.cues),
       cue_count = case when excluded.cues is null then episodes.cue_count else excluded.cue_count end,
       duration_s = coalesce(excluded.duration_s, episodes.duration_s), read_error = excluded.read_error,
       last_seen_at = excluded.last_seen_at, gone_at = null`,
  );
  const scannedFolders = new Set<string>();
  const setReelDirs = sql.prepare("update episodes set reel_dirs = ? where srt_path = ?");
  // Sibling folders (same parent, inside the root) per parent, listed once per sync: name -> its file names.
  const siblings = new Map<string, { dir: string; files: string[] }[]>();
  const siblingsOf = (folder: string, root: string) => {
    const parent = path.dirname(folder);
    if (!siblings.has(parent)) {
      siblings.set(
        parent,
        listGuardedSubdirs(parent, [root])
          .sort()
          .map((name) => {
          const dir = path.join(parent, name);
          return { dir, files: listGuardedDir(dir, [root]) };
        }),
      );
    }
    return siblings.get(parent)!;
  };
  const srtRe = episodeSrtRe();
  for (const [folder, master] of byFolder) {
    if (!readable(master.root_path)) continue; // unplugged: keep what we have
    res.folders++;
    scannedFolders.add(folder);
    const bases = [master.root_path];
    for (const name of listGuardedDir(folder, bases)) {
      const m = srtRe.exec(name);
      if (!m) continue;
      const srtPath = path.join(folder, name);
      seen.add(srtPath);
      res.found++;
      const prev = byPath.get(srtPath);
      let cues: Cue[] | null = null;
      let size: number | null = null;
      let mtime: number | null = null;
      let error: string | null = null;
      try {
        const st = statGuardedText(srtPath, bases, [".srt"]);
        size = st.size;
        mtime = st.mtimeMs;
        if (!prev || prev.srt_size !== st.size || prev.srt_mtime !== st.mtimeMs || !prev.cues) {
          const r = readGuardedText(srtPath, bases, [".srt"]);
          cues = parseSrt(r.text);
          size = r.size;
          mtime = r.mtimeMs;
          res.read++;
          if (!cues.length) error = "No cues in the SRT.";
        }
      } catch (e) {
        error = e instanceof TextReadError ? e.message : "Could not read the SRT.";
        res.errors.push(`${name}: ${error}`);
      }
      const keptCues = cues ?? unpackCues(prev?.cues);
      const duration = master.duration_s ?? (keptCues.length ? cuesEnd(keptCues) : null);
      upsertNew.run({
        srtPath,
        folder,
        stem: name.replace(/\.srt$/, ""),
        num: Number(m[1]),
        title: path.basename(folder).trim(),
        master: master.id,
        size: error && !cues ? (prev?.srt_size ?? null) : size,
        mtime: error && !cues ? (prev?.srt_mtime ?? null) : mtime,
        cues: cues ? packCues(cues) : null,
        count: cues ? cues.length : 0,
        duration,
        error,
        now,
      });
      // Where this episode's reels may land: its folder, plus a sibling folder holding `<prefix>N reels.json`.
      const listName = reelsListName(Number(m[1]));
      const dirs = [folder, ...siblingsOf(folder, master.root_path).filter((x) => x.dir !== folder && x.files.includes(listName)).map((x) => x.dir)];
      setReelDirs.run(JSON.stringify(dirs), srtPath);
    }
  }
  // Gone: the SRT vanished from a folder we could read, or its folder no longer holds an episode master.
  for (const e of existing) {
    if (seen.has(e.srt_path) || e.gone_at != null) continue;
    const folder = path.dirname(e.srt_path);
    const master = byFolder.get(folder);
    if (master && !scannedFolders.has(folder)) continue; // its root is unreadable now
    if (!master) {
      // No master any more: only mark gone when no master of that folder is merely on an unreadable root.
      const anyRoot = masters.find((mm) => path.dirname(mm.path) === folder);
      if (anyRoot && !readable(anyRoot.root_path)) continue;
    }
    sql.prepare("update episodes set gone_at = ?, master_asset_id = case when ? then master_asset_id else null end where id = ?").run(now, master ? 1 : 0, e.id);
    res.gone++;
  }
  return res;
}

export type EpisodeView = {
  id: number;
  num: number;
  stem: string;
  title: string;
  /** "Ep7 · Episode title" */
  label: string;
  short: string;
  masterAssetId: number | null;
  masterHasThumb: boolean;
  thumbV: string | null;
  durationS: number | null;
  cueCount: number;
  readError: string | null;
  cards: number;
  undecided: number;
  /** An active short_moments job for it. */
  activeJob: { id: number; status: "pending" | "running" } | null;
  /** Kept Idea cards (what Cut reel can hand off). */
  keptIdeas: number;
  /** The word-timed transcript (slice 2): what the New short picker shows. */
  transcript: TranscriptState;
};

export type TranscriptState =
  | { state: "ready"; sentences: number; words: number }
  | { state: "running" }
  | { state: "waiting_proxy" }
  | { state: "queued" }
  | { state: "error"; error: string };

/** SQL condition: the episode `e` has a current word transcript for its master `a` (no error, same fingerprint, version). */
export const WORDS_CURRENT = `(e.words is not null and e.words_error is null and e.words_sha = a.sha256 and e.words_version = ${WORDS_VERSION})`;

function transcriptState(r: {
  words_ok: number;
  sentence_count: number | null;
  word_count: number | null;
  words_running_at: number | null;
  proxy_path: string | null;
  words_error: string | null;
  words_stale_error: number;
}): TranscriptState {
  if (r.words_ok) return { state: "ready", sentences: r.sentence_count ?? 0, words: r.word_count ?? 0 };
  if (r.words_running_at) return { state: "running" };
  if (!r.proxy_path) return { state: "waiting_proxy" };
  if (r.words_error && !r.words_stale_error) return { state: "error", error: r.words_error };
  return { state: "queued" };
}

export function episodeLabel(num: number, title: string) {
  return `Ep${num} · ${title}`;
}

/** Live episodes (not gone, master visible), by number; one whose SRT could not be read is listed with its reason. */
export function listEpisodes(sql: Sql): EpisodeView[] {
  const rows = sql
    .prepare(
      `select e.id, e.num, e.stem, e.title, e.master_asset_id, e.duration_s, e.cue_count, e.read_error,
              a.thumb_path, a.sha256,
              (select count(*) from shorts sh where sh.episode_id = e.id and sh.archived_at is null) as cards,
              (select count(*) from shorts sh where sh.episode_id = e.id and sh.archived_at is null and sh.kept is null) as undecided,
              (select j.id || ':' || j.status from jobs j where j.type = '${MOMENTS_JOB}' and j.status in ('pending','running')
                 and json_extract(j.input, '$.episodeId') = e.id order by j.id limit 1) as active,
              (select count(*) from shorts sh where sh.episode_id = e.id and sh.archived_at is null and sh.kept = 1 and sh.status = 'idea') as kept_ideas,
              ${WORDS_CURRENT} as words_ok, e.sentence_count, e.word_count, e.words_running_at, a.proxy_path, e.words_error,
              (e.words_sha is not a.sha256 or e.words_version is not ${WORDS_VERSION}) as words_stale_error
         from episodes e join assets a on a.id = e.master_asset_id
        where e.gone_at is null and a.missing = 0 and a.ignored = 0
        order by e.num, e.id`,
    )
    .all() as {
    id: number;
    num: number;
    stem: string;
    title: string;
    master_asset_id: number | null;
    duration_s: number | null;
    cue_count: number;
    read_error: string | null;
    thumb_path: string | null;
    sha256: string | null;
    cards: number;
    undecided: number;
    active: string | null;
    kept_ideas: number;
    words_ok: number;
    sentence_count: number | null;
    word_count: number | null;
    words_running_at: number | null;
    proxy_path: string | null;
    words_error: string | null;
    words_stale_error: number;
  }[];
  return rows.map((r) => {
    const [jid, st] = (r.active ?? "").split(":");
    return {
      id: r.id,
      num: r.num,
      stem: r.stem,
      title: r.title,
      label: episodeLabel(r.num, r.title),
      short: `Ep${r.num}`,
      masterAssetId: r.master_asset_id,
      masterHasThumb: Boolean(r.thumb_path),
      thumbV: r.sha256 ? r.sha256.slice(0, 12) : null,
      durationS: r.duration_s,
      cueCount: r.cue_count,
      readError: r.read_error,
      cards: r.cards,
      undecided: r.undecided,
      activeJob: r.active ? { id: Number(jid), status: st as "pending" | "running" } : null,
      keptIdeas: r.kept_ideas,
      transcript: transcriptState(r),
    };
  });
}

/**
 * Folders with an episode master but no live `<prefix>N.srt` (A2: "Not prepped yet: run the episode prep skill"). Folders on a
 * root that cannot be read now (drive unplugged) are left out: their SRT may well be there.
 */
export function notPreppedFolders(
  sql: Sql,
  cfg: DriveCfg,
): { folder: string; title: string; masterAssetId: number; filename: string }[] {
  const mounted = driveMounted(cfg);
  const masters = (sql.prepare(`${MASTER_SQL} order by a.path`).all() as MasterRow[]).filter((m) => rootAccessible(m.root_path, cfg.drivePath, mounted));
  const live = new Set(
    (sql.prepare("select folder from episodes where gone_at is null").pluck().all() as string[]).map((f) => f),
  );
  const out = new Map<string, { folder: string; title: string; masterAssetId: number; filename: string }>();
  for (const m of masters) {
    const folder = path.dirname(m.path);
    if (live.has(folder) || out.has(folder)) continue;
    out.set(folder, { folder, title: path.basename(folder).trim(), masterAssetId: m.id, filename: path.basename(m.path) });
  }
  return [...out.values()];
}

export type EpisodeRow = {
  id: number;
  num: number;
  title: string;
  label: string;
  durationS: number | null;
  /** The episode-prep SRT's cues (slice 1). */
  cues: Cue[];
  /** The word-timed transcript's sentences when it is current for the master (slice 2), else null. */
  sentences: Cue[] | null;
  goneAt: number | null;
  masterAssetId: number | null;
  masterPath: string | null;
  folder: string;
  reelDirs: string[];
};

export function getEpisode(sql: Sql, id: number): EpisodeRow | null {
  const r = sql
    .prepare(
      `select e.id, e.num, e.title, e.duration_s, e.cues, e.gone_at, e.master_asset_id, e.folder, e.reel_dirs, a.path as master_path,
              case when ${WORDS_CURRENT} then e.words end as words
         from episodes e left join assets a on a.id = e.master_asset_id where e.id = ?`,
    )
    .get(id) as
    | {
        id: number;
        num: number;
        title: string;
        duration_s: number | null;
        cues: string | null;
        gone_at: number | null;
        master_asset_id: number | null;
        folder: string;
        reel_dirs: string | null;
        master_path: string | null;
        words: string | null;
      }
    | undefined;
  if (!r) return null;
  const cues = unpackCues(r.cues);
  const sentences = r.words ? episodeSentences(cues, r.words).sentences : null;
  return {
    id: r.id,
    num: r.num,
    title: r.title,
    label: episodeLabel(r.num, r.title),
    durationS: r.duration_s,
    cues,
    sentences: sentences && sentences.length ? sentences : null,
    goneAt: r.gone_at,
    masterAssetId: r.master_asset_id,
    masterPath: r.master_path,
    folder: r.folder,
    reelDirs: parseReelDirs(r.reel_dirs, r.folder),
  };
}

export function parseReelDirs(json: string | null, folder: string): string[] {
  try {
    const v = JSON.parse(json ?? "null") as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return v as string[];
  } catch {
    /* fall through */
  }
  return [folder];
}

/** What moments snap to for this episode: its sentences when the word transcript is current, else the SRT cues. */
export function episodeUnits(ep: EpisodeRow): { unit: MomentUnit; units: Cue[] } {
  return ep.sentences ? { unit: "sentence", units: ep.sentences } : { unit: "cue", units: ep.cues };
}
