/**
 * Word-timed episode transcripts, the DB side (Phase 6 slice 2; server only). The worker's ShortMomentsQueue asks for the
 * next due episode, runs whisper over the master's cached proxy (src/lib/ai/whisper.ts transcribeWords) and stores the
 * words here. Nothing here reads the drive or runs anything.
 *
 * Due = a live episode whose master is visible, fingerprinted and has a proxy in the cache, and whose stored words were
 * made for another fingerprint, words version or whisper model (or never); a failure is retried after 6 hours (or at
 * once when the fingerprint changes). An episode whose master has no proxy yet waits ("Waiting for the preview copy").
 * Episodes with a waiting moments job go first.
 */
import path from "node:path";
import type Database from "better-sqlite3";
import { MOMENTS_JOB } from "../jobs";
import { unpackCues } from "./srt";
import { episodeSentences, parseWhisperWords, packWords, WORDS_VERSION, type Word } from "./words";

type Sql = Database.Database;

export const WORDS_RETRY_MS = 6 * 3600_000;

/** The model name stored with the words: the model file's base name (`ggml-small.en.bin`). */
export function wordsModelName(modelPath: string): string {
  return path.basename(modelPath);
}

export type WordsDue = { episodeId: number; num: number; label: string; assetId: number; sha256: string; proxyPath: string; durationS: number | null };

export function nextWordsDue(sql: Sql, model: string, now = Date.now()): WordsDue | null {
  const r = sql
    .prepare(
      `select e.id, e.num, e.title, a.id as asset_id, a.sha256, a.proxy_path, a.duration_s
         from episodes e join assets a on a.id = e.master_asset_id join roots r on r.id = a.root_id
        where e.gone_at is null and a.missing = 0 and a.ignored = 0 and r.enabled = 1 and a.sha256 is not null and a.proxy_path is not null
          and (e.words_sha is not a.sha256 or e.words_version is not @v or e.words_model is not @model
               or (e.words_error is not null and e.words_at < @retry))
        order by exists (select 1 from jobs j where j.type = '${MOMENTS_JOB}' and j.status = 'pending'
                           and json_extract(j.input, '$.episodeId') = e.id) desc, e.num desc, e.id
        limit 1`,
    )
    .get({ v: WORDS_VERSION, model, retry: now - WORDS_RETRY_MS }) as
    | { id: number; num: number; title: string; asset_id: number; sha256: string; proxy_path: string; duration_s: number | null }
    | undefined;
  if (!r) return null;
  return { episodeId: r.id, num: r.num, label: `Ep${r.num} · ${r.title}`, assetId: r.asset_id, sha256: r.sha256, proxyPath: r.proxy_path, durationS: r.duration_s };
}

export function markWordsRunning(sql: Sql, episodeId: number, now = Date.now()) {
  sql.prepare("update episodes set words_running_at = ? where id = ?").run(now, episodeId);
}

/** After a restart nothing is mid-transcription. */
export function recoverWordsRunning(sql: Sql): number {
  return sql.prepare("update episodes set words_running_at = null where words_running_at is not null").run().changes;
}

export type StoredWords = { words: number; sentences: number; source: "srt" | "whisper"; aligned: number };

/** whisper's JSON -> the episode's words (sha / version / model recorded, error cleared). Throws when it is unreadable. */
export function storeWords(sql: Sql, due: WordsDue, json: string, model: string, ms: number, now = Date.now()): StoredWords {
  const words: Word[] = json ? parseWhisperWords(json) : [];
  if (!words.length) throw new Error("whisper heard no words");
  const cues = unpackCues(sql.prepare("select cues from episodes where id = ?").pluck().get(due.episodeId) as string | null);
  const split = episodeSentences(cues, words);
  const sentences = split.sentences.length;
  sql
    .prepare(
      `update episodes set words = ?, words_sha = ?, words_version = ?, words_model = ?, words_at = ?, words_ms = ?, words_error = null,
              word_count = ?, sentence_count = ?, words_running_at = null where id = ?`,
    )
    .run(packWords(words), due.sha256, WORDS_VERSION, model, now, ms, words.length, sentences, due.episodeId);
  return { words: words.length, sentences, source: split.source, aligned: Math.round(split.aligned * 100) / 100 };
}

/** A failed transcription: the previous words stay (they are not current any more), retried after WORDS_RETRY_MS. */
export function storeWordsError(sql: Sql, due: WordsDue, error: string, model: string, now = Date.now()) {
  sql
    .prepare(
      `update episodes set words_sha = ?, words_version = ?, words_model = ?, words_at = ?, words_error = ?, words_running_at = null where id = ?`,
    )
    .run(due.sha256, WORDS_VERSION, model, now, error.slice(0, 300), due.episodeId);
}

/** Summary for the board / Jobs: how many live episodes have a current word transcript, and whether one is running. */
export function wordsSummary(sql: Sql): { episodes: number; ready: number; running: number; lastAt: number | null } {
  const r = sql
    .prepare(
      `select count(*) as n,
              sum(case when e.words is not null and e.words_error is null and e.words_sha = a.sha256 and e.words_version = ${WORDS_VERSION} then 1 else 0 end) as ready,
              sum(case when e.words_running_at is not null then 1 else 0 end) as running,
              max(coalesce(e.words_running_at, e.words_at)) as last
         from episodes e join assets a on a.id = e.master_asset_id
        where e.gone_at is null and a.missing = 0 and a.ignored = 0`,
    )
    .get() as { n: number; ready: number | null; running: number | null; last: number | null };
  return { episodes: r.n, ready: r.ready ?? 0, running: r.running ?? 0, lastAt: r.last };
}

/**
 * Recompute the stored sentence counts of current transcripts (the split is done at read time, so a new split rule on
 * deploy changes them without a new transcription). Run by the worker at start. Returns the rows changed.
 */
export function refreshSentenceCounts(sql: Sql): number {
  const rows = sql
    .prepare(
      `select e.id, e.cues, e.words, e.sentence_count from episodes e join assets a on a.id = e.master_asset_id
        where e.words is not null and e.words_error is null and e.words_sha = a.sha256 and e.words_version = ${WORDS_VERSION}`,
    )
    .all() as { id: number; cues: string | null; words: string; sentence_count: number | null }[];
  const upd = sql.prepare("update episodes set sentence_count = ? where id = ?");
  let n = 0;
  for (const r of rows) {
    const count = episodeSentences(unpackCues(r.cues), r.words).sentences.length;
    if (count !== r.sentence_count) n += upd.run(count, r.id).changes;
  }
  return n;
}
