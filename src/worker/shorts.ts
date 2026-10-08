/**
 * Shorts moments queue (worker only, Phase 6 B1 to B3 + slice 2): keeps the `episodes` table in step with the drive
 * (every 30 s, read only through the guarded text reader), makes each episode's word-timed transcript with the local
 * whisper-cli from the master's CACHED proxy (never the drive; one episode at a time, sharing whisper's lock with the
 * describe queue; src/lib/shorts/transcript.ts), runs the board's automatic moves every 15 s (src/lib/shorts/outputs.ts:
 * reel file -> Review, linked Short -> Posted, caption lookups through the guarded reader), reads the reel kit notes back
 * every 60 s (Phase 7 D2: `<reel stem> kit.json`, src/lib/shorts/kit.ts, read only) and runs `short_moments` job
 * rows one at a time with the real `claude` CLI through the Phase 4 runner (src/lib/hooks/claude.ts: argument array,
 * minimal env, no tools, no MCP, no settings, own process group, timeout). Never the Anthropic API. A moments job whose
 * episode has no current word transcript is not claimed until it has one.
 *
 * Per job: the episode's cues -> prompt (src/lib/shorts/moments.ts) -> claude -p -> parse {moments: [...]} -> every
 * candidate through the code checks (src/lib/shorts/rules.ts checkMoment: snapped to cues + pad, 30 to 90 s, sentence
 * start / end, no profanity in the first 3 s, first line from the transcript, hook + copy rules, no near duplicate of a
 * live card or an earlier survivor) -> fewer than 3 survivors = one retry of the whole call (told what broke; survivors of
 * both answers kept, up to 8) -> Idea cards + Lane A `moment` hooks (requested for scoring) -> done (a note when fewer than
 * 3 survived; an error when none did). A timeout, a CLI error or an answer that is not JSON is a job error (Retry runs it
 * again). Log: logs/jobs/short-moments-<id>.log. Nothing is written until claude answered, so a restart only has to turn
 * a `running` row into an error.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  ClaudeError,
  claudeArgs,
  claudeCommandLine,
  parseClaudeJson,
  resolveClaude,
  runClaude,
  type ClaudeResult,
} from "../lib/hooks/claude";
import { syncEpisodes, WORDS_CURRENT } from "../lib/shorts/episodes";
import { syncBoard } from "../lib/shorts/outputs";
import { syncKitNotes } from "../lib/shorts/kit";
import {
  markWordsRunning,
  nextWordsDue,
  recoverWordsRunning,
  refreshSentenceCounts,
  storeWords,
  storeWordsError,
  wordsModelName,
  type WordsDue,
} from "../lib/shorts/transcript";
import { resolveCacheFile, type DriveCfg } from "../lib/fsguard";
import { terseJobError } from "../lib/jobs";
import { transcribeWords } from "../lib/ai/whisper";
import { FFMPEG, FFPROBE } from "./proc";
import {
  buildMomentsPrompt,
  insertCards,
  momentContext,
  MomentsError,
  MOMENTS_JOB,
  MOMENTS_PROMPT_VERSION,
  momentsSystemPrompt,
  parseMoments,
  type MomentAttempt,
  type MomentJobInput,
  type MomentJobResult,
} from "../lib/shorts/moments";
import { checkMoment, MOMENTS_MAX, MOMENTS_MIN_SURVIVORS, overlayRules, type CheckedMoment, type RawMoment } from "../lib/shorts/rules";

export type ShortMomentsQueueOptions = {
  cacheDir: string;
  logsDir: string;
  /** For the episode sync's mount check. */
  drive: DriveCfg;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  timeoutMs?: number;
  idleMs?: number;
  now?: () => number;
  /** Word-timed transcripts (slice 2): the whisper binary + model (absolute) and a readiness check. null = off. */
  words?: { bin: string; model: string; ready?: () => boolean; ffmpeg?: string; ffprobe?: string } | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A moments run reads a whole transcript: far more room than a variants run. Real runs took 75 s and 205 s on
 * 2026-10-01 and passed 300 s on 2026-10-02, so 15 minutes (2026-10-02, the owner's timeouts).
 */
export const MOMENTS_TIMEOUT_MS = 15 * 60_000;
const EPISODE_SYNC_MS = 30_000;
const BOARD_SYNC_MS = 15_000;
/** Phase 7 D2: kit notes next to Lane A reel files (guarded reads, cached by size + mtime). */
const KIT_SYNC_MS = 60_000;

export const INTERRUPTED = "Interrupted (Studio's worker restarted). Retry runs it again.";
/** What a job row / an episode says for an unexpected failure (the detail stays in the job's log and the worker log). */
export const MOMENTS_FAILED = "Moments failed (see the log)";
export const WORDS_FAILED = "The word transcript failed (see the log)";
const WORDS_NO_PROXY = "The preview copy is missing from the cache (it is rebuilt on the next scan).";
const WORDS_NO_AUDIO = "The preview copy has no audio track.";
/** The words queue's own fixed phrases (shown as they are); anything else (ffmpeg / ffprobe / whisper output) is WORDS_FAILED. */
export const WORDS_FIXED = [WORDS_NO_PROXY, WORDS_NO_AUDIO, "whisper heard no words"] as const;

type Claimed = { id: number; input: MomentJobInput };

export class ShortMomentsQueue {
  /** Job id -> episode id (what is running). */
  readonly running = new Map<number, number>();
  private stopped = false;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private wordsLoop: Promise<void> | null = null;
  private lastSync = 0;
  private lastBoard = 0;
  private lastKit = 0;
  /** The episode being transcribed now (for logs). */
  transcribing: number | null = null;

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: ShortMomentsQueueOptions,
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private isStopped() {
    return this.stopped || this.opts.isStopped();
  }

  /** Re-read episode folders (cheap: SRTs are re-parsed only when their size or mtime changed). */
  syncEpisodes() {
    this.lastSync = this.now();
    try {
      const r = syncEpisodes(this.sql, this.opts.drive, this.now());
      if (r.read || r.gone) this.opts.log(`shorts: episodes ${r.found} found in ${r.folders} folders, ${r.read} read, ${r.gone} gone`);
      for (const e of r.errors) this.opts.log(`shorts: episode read error ${e}`);
      return r;
    } catch (e) {
      this.opts.log("shorts: episode sync error", (e as Error).message);
      return null;
    }
  }

  /** The board's automatic moves (reel file -> Review, linked Short -> Posted, captions). Never throws. */
  syncBoard() {
    this.lastBoard = this.now();
    try {
      const r = syncBoard(this.sql, this.opts.drive, this.now());
      if (r.toReview || r.toPosted || r.outputsUpdated || r.captions) {
        this.opts.log(`shorts: board ${r.toReview} to Review, ${r.toPosted} to Posted, ${r.outputsUpdated} newer reel(s), ${r.captions} caption change(s)`);
      }
      return r;
    } catch (e) {
      this.opts.log("shorts: board sync error", (e as Error).message);
      return null;
    }
  }

  /** Kit notes (Phase 7 D2): read back every Lane A video's `<stem> kit.json` (read only). Never throws. */
  syncKitNotes() {
    this.lastKit = this.now();
    try {
      const r = syncKitNotes(this.sql, this.opts.drive, this.now());
      if (r.read || r.errors || r.removed) this.opts.log(`shorts: kit notes ${r.read} read, ${r.errors} refused, ${r.removed} gone (${r.checked} reel files checked)`);
      return r;
    } catch (e) {
      this.opts.log("shorts: kit note sync error", (e as Error).message);
      return null;
    }
  }

  /**
   * Transcribe the next due episode (word-timed, from its cached proxy). Returns what happened; never throws.
   * `none` = nothing due (or whisper missing / off).
   */
  async transcribeNext(): Promise<"none" | "done" | "error"> {
    const w = this.opts.words;
    if (!w || !(w.ready?.() ?? true)) return "none";
    const model = wordsModelName(w.model);
    let due: WordsDue | null = null;
    try {
      due = nextWordsDue(this.sql, model, this.now());
    } catch (e) {
      this.opts.log("shorts: words due error", (e as Error).message);
      return "none";
    }
    if (!due) return "none";
    this.transcribing = due.episodeId;
    markWordsRunning(this.sql, due.episodeId, this.now());
    const workDir = path.join(this.opts.cacheDir, "words-tmp", `ep-${due.episodeId}`);
    try {
      // Cache only: the proxy is resolved inside STUDIO_CACHE (resolveCacheFile), never the master on the drive.
      const proxy = resolveCacheFile(this.opts.cacheDir, due.proxyPath);
      if (!proxy) throw new Error(WORDS_NO_PROXY);
      fs.rmSync(workDir, { recursive: true, force: true });
      const run = await transcribeWords(
        { bin: w.bin, model: w.model, ffmpeg: w.ffmpeg ?? FFMPEG, ffprobe: w.ffprobe ?? FFPROBE },
        proxy,
        workDir,
        due.durationS ?? 0,
      );
      if (!run.hasAudio) throw new Error(WORDS_NO_AUDIO);
      const stored = storeWords(this.sql, due, run.json, model, run.ms, this.now());
      this.opts.log(
        `shorts: words ${due.label}: ${stored.words} words, ${stored.sentences} sentences (${stored.source === "srt" ? `the SRT's text on whisper's times, ${Math.round(stored.aligned * 100)}% of its words matched` : `whisper's own words; only ${Math.round(stored.aligned * 100)}% of the SRT matched`}) in ${(run.ms / 1000).toFixed(1)} s (whisper ${(run.whisperMs / 1000).toFixed(1)} s)`,
      );
      return "done";
    } catch (e) {
      const msg = ((e as Error).message || "Transcription failed").slice(0, 300);
      if (this.isStopped()) {
        recoverWordsRunning(this.sql);
        return "none";
      }
      // The episode row (shown in the New short picker) gets a fixed phrase; the full text stays in the worker log.
      storeWordsError(this.sql, due, terseJobError(e, [], WORDS_FAILED, WORDS_FIXED), model, this.now());
      this.opts.log(`shorts: words ${due.label} error: ${msg}`);
      return "error";
    } finally {
      this.transcribing = null;
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Transcribe every due episode (smoke tests). */
  async drainWords(): Promise<{ done: number; error: number }> {
    const out = { done: 0, error: 0 };
    for (let i = 0; i < 100; i++) {
      const r = await this.transcribeNext();
      if (r === "none") return out;
      out[r]++;
    }
    return out;
  }

  /** A `running` row after a restart never finished (nothing was written): an error the owner can Retry. */
  recover(): number {
    recoverWordsRunning(this.sql);
    return this.sql
      .prepare(`update jobs set status = 'error', error = ?, finished_at = ? where type = '${MOMENTS_JOB}' and status = 'running'`)
      .run(INTERRUPTED, this.now()).changes;
  }

  /**
   * Oldest pending job whose episode has a current word transcript (or is gone / unknown: the run then ends in a clear
   * error), flipped to running in one IMMEDIATE transaction (a Cancel that lands first wins). A job waiting for its
   * episode's transcript is skipped.
   */
  claimNext(): Claimed | null {
    const tx = this.sql.transaction((): Claimed | null => {
      const row = this.sql
        .prepare(
          `select j.id, j.input from jobs j
             left join episodes e on e.id = json_extract(j.input, '$.episodeId') left join assets a on a.id = e.master_asset_id
            where j.type = '${MOMENTS_JOB}' and j.status = 'pending'
              and (e.id is null or e.gone_at is not null or a.id is null or coalesce(${WORDS_CURRENT}, 0) = 1)
            order by j.priority, j.id limit 1`,
        )
        .get() as { id: number; input: string } | undefined;
      if (!row) return null;
      const logPath = path.join(this.opts.logsDir, "jobs", `short-moments-${row.id}.log`);
      const n = this.sql
        .prepare("update jobs set status = 'running', started_at = ?, attempts = attempts + 1, log_path = ? where id = ? and status = 'pending'")
        .run(this.now(), logPath, row.id).changes;
      if (!n) return null;
      let input: MomentJobInput;
      try {
        input = JSON.parse(row.input);
      } catch {
        input = { episodeId: 0 };
      }
      return { id: row.id, input };
    });
    return tx.immediate();
  }

  private finish(id: number, status: "done" | "error", error: string | null, result: MomentJobResult | null) {
    this.sql
      .prepare("update jobs set status = ?, error = ?, result = ?, finished_at = ? where id = ? and status = 'running'")
      .run(status, error, result ? JSON.stringify(result) : null, this.now(), id);
  }

  private async ask(prompt: string, workdir: string, log: (line: string) => void): Promise<{ moments: RawMoment[]; res: ClaudeResult; ms: number }> {
    const bin = resolveClaude();
    if (!bin) throw new ClaudeError("claude CLI not found (~/.local/bin/claude; CLAUDE_BIN overrides).", "cli");
    const args = claudeArgs(prompt, momentsSystemPrompt());
    log(`run: ${claudeCommandLine(bin, args)}`);
    const timeoutMs = this.opts.timeoutMs ?? MOMENTS_TIMEOUT_MS;
    const run = await runClaude(bin, args, { cwd: workdir, timeoutMs, signal: this.abort.signal });
    if (run.killed) throw new ClaudeError(INTERRUPTED, "cli");
    if (run.timedOut) throw new ClaudeError(`claude took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`, "cli");
    log(`claude exited ${run.code ?? "by signal"} after ${(run.ms / 1000).toFixed(1)} s`);
    if (run.stderr.trim()) log(`stderr: ${run.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    const res = parseClaudeJson(run.stdout);
    if (run.code !== 0) throw new ClaudeError(`claude exited ${run.code}: ${res.text.slice(0, 200)}`, "cli");
    return { moments: parseMoments(res.text), res, ms: run.ms };
  }

  /** Run one claimed job. Never throws. */
  async runOne(job: Claimed): Promise<"done" | "error" | "interrupted"> {
    const logPath = path.join(this.opts.logsDir, "jobs", `short-moments-${job.id}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = (line: string) => {
      try {
        fs.appendFileSync(logPath, `${new Date(this.now()).toISOString()} ${line}\n`);
      } catch {
        /* logging never fails a job */
      }
    };
    const workdir = path.join(this.opts.cacheDir, "claude-tmp", `moments-${job.id}`);
    const result: MomentJobResult = { promptVersion: MOMENTS_PROMPT_VERSION, attempts: [], survivors: [], note: null };
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
      fs.mkdirSync(workdir, { recursive: true });
      this.syncEpisodes(); // the transcript may have been re-prepped since the last sync
      const ctx = momentContext(this.sql, job.input.episodeId);
      log(`episode #${ctx.episode.id} ${ctx.episode.label}: ${ctx.sentences.length} sentences (word-timed transcript), ${Math.round(ctx.episodeEnd)} s, ${ctx.taken.length} live card(s) to avoid`);
      const overlay = overlayRules(ctx.allClients);
      const taken = ctx.taken.map((t) => ({ start: t.start, end: t.end }));
      const kept: CheckedMoment[] = [];
      let feedback: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = buildMomentsPrompt(ctx, feedback);
        log(`attempt ${attempt} prompt: ${prompt.length} chars`);
        const { moments, res, ms } = await this.ask(prompt, workdir, log);
        const a: MomentAttempt = {
          returned: moments.length,
          kept: 0,
          dropped: [],
          ms,
          model: res.model,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          cacheReadTokens: res.cacheReadTokens,
          cacheCreationTokens: res.cacheCreationTokens,
          coldDropped: [],
        };
        log(
          `attempt ${attempt}: ${moments.length} returned · model ${res.model ?? "?"}${res.models.length > 1 ? ` (also listed: ${res.models.slice(1).join(", ")})` : ""} · tokens in ${res.inputTokens ?? "?"} (+cache read ${res.cacheReadTokens ?? 0}, cache write ${res.cacheCreationTokens ?? 0}) out ${res.outputTokens ?? "?"}`,
        );
        const broke = new Set<string>();
        for (const m of moments) {
          if (kept.length >= MOMENTS_MAX) break;
          const v = checkMoment(m, { cues: ctx.sentences, unit: "sentence", episodeEnd: ctx.episodeEnd, taken, overlay });
          const label = `${Number.isFinite(m.start) ? m.start.toFixed(1) : "?"} to ${Number.isFinite(m.end) ? m.end.toFixed(1) : "?"} s "${m.hook}"`;
          if (v.ok) {
            kept.push(v.moment);
            taken.push({ start: v.moment.start, end: v.moment.end });
            a.kept++;
            log(`  kept    ${v.moment.start.toFixed(2)} to ${v.moment.end.toFixed(2)} s (${Math.round(v.moment.end - v.moment.start)} s) [${v.moment.layout}] ${v.moment.hookWords} | ${v.moment.firstLine}`);
            if (m.firstLine && m.firstLine !== v.moment.firstLine) log(`          claude's first line: ${m.firstLine.slice(0, 200)}`);
            if (v.moment.cold) log(`          cold open ${v.moment.cold.start.toFixed(2)} to ${v.moment.cold.end.toFixed(2)} s | ${v.moment.cold.text}`);
            else if (v.moment.coldDropped) {
              // Only the cold open is dropped: the card survives without one (the owner picks one on the card).
              a.coldDropped!.push({
                start: v.moment.start,
                end: v.moment.end,
                hook: v.moment.hookWords,
                coldStart: m.coldStart != null && Number.isFinite(m.coldStart) ? m.coldStart : null,
                coldEnd: m.coldEnd != null && Number.isFinite(m.coldEnd) ? m.coldEnd : null,
                rule: v.moment.coldDropped.rule,
                detail: v.moment.coldDropped.detail,
              });
              log(`          cold open dropped <- ${v.moment.coldDropped.detail}`);
            }
          } else {
            a.dropped.push({ start: Number.isFinite(m.start) ? m.start : null, end: Number.isFinite(m.end) ? m.end : null, hook: m.hook, rule: v.rule, detail: v.detail });
            broke.add(`${label}: ${v.detail}`);
            log(`  dropped ${label}  <- ${v.detail}`);
          }
        }
        result.attempts.push(a);
        if (kept.length >= MOMENTS_MIN_SURVIVORS) break;
        if (attempt === 1) {
          feedback = [
            ...broke,
            ...(kept.length ? [`These moments passed and are kept, so pick others that do not overlap them: ${kept.map((k) => `${k.start.toFixed(1)} to ${k.end.toFixed(1)} s`).join(", ")}`] : []),
          ];
          log(`only ${kept.length} passed the checks: one retry of the whole call`);
        }
        if (this.isStopped()) {
          // Stopped between the two attempts: finish the row like the catch path (never left `running`).
          this.finish(job.id, "error", INTERRUPTED, result);
          log(INTERRUPTED);
          return "interrupted";
        }
      }
      if (!kept.length) {
        result.note = "No moment passed the checks (see the log).";
        this.finish(job.id, "error", result.note, result);
        log(result.note);
        return "error";
      }
      result.survivors = insertCards(this.sql, job.input.episodeId, job.id, kept, this.now());
      if (kept.length < MOMENTS_MIN_SURVIVORS) result.note = `Only ${kept.length} moment${kept.length === 1 ? "" : "s"} passed the checks after one retry.`;
      this.finish(job.id, "done", null, result);
      log(`done: ${kept.length} card${kept.length === 1 ? "" : "s"} (#${result.survivors.join(", #")}), hooks queued for scoring${result.note ? `. ${result.note}` : ""}`);
      this.opts.log(`shorts: job #${job.id} ${ctx.episode.label}: ${kept.length} cards`);
      return "done";
    } catch (e) {
      const message = ((e as Error).message || "Moments failed").slice(0, 500);
      if (this.isStopped() || message === INTERRUPTED) {
        this.finish(job.id, "error", INTERRUPTED, result.attempts.length ? result : null);
        log(INTERRUPTED);
        return "interrupted";
      }
      log(`error: ${message}`);
      this.opts.log(`shorts: job #${job.id} error: ${message}`);
      // Only a known terse message reaches the job row (and the browser): never a path or SQL text.
      this.finish(job.id, "error", terseJobError(e, [ClaudeError, MomentsError], MOMENTS_FAILED), result.attempts.length ? result : null);
      return "error";
    } finally {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* cleanup never throws out of runOne (the job row is already finished) */
      }
    }
  }

  /** Run every pending job (smoke tests). */
  async drain(): Promise<Record<"done" | "error" | "interrupted", number>> {
    const counts = { done: 0, error: 0, interrupted: 0 };
    for (;;) {
      if (this.isStopped()) return counts;
      const job = this.claimNext();
      if (!job) return counts;
      this.running.set(job.id, job.input.episodeId);
      counts[await this.runOne(job)]++;
      this.running.delete(job.id);
    }
  }

  start() {
    if (this.loop) return;
    const n = this.recover();
    if (n) this.opts.log(`shorts: ${n} interrupted moments job(s) marked for Retry`);
    this.syncEpisodes();
    try {
      const c = refreshSentenceCounts(this.sql);
      if (c) this.opts.log(`shorts: sentence counts refreshed for ${c} episode(s)`);
    } catch (e) {
      this.opts.log("shorts: sentence count refresh error", (e as Error).message);
    }
    this.syncBoard();
    this.syncKitNotes();
    const idle = this.opts.idleMs ?? 2_000;
    // Word transcripts in their own loop, so a long transcription never holds up a moments job for another episode.
    this.wordsLoop = (async () => {
      while (!this.isStopped()) {
        const r = await this.transcribeNext();
        if (r === "none") await sleep(Math.max(idle, 5_000));
      }
    })();
    this.loop = (async () => {
      while (!this.isStopped()) {
        if (this.now() - this.lastSync >= EPISODE_SYNC_MS) this.syncEpisodes();
        if (this.now() - this.lastBoard >= BOARD_SYNC_MS) this.syncBoard();
        if (this.now() - this.lastKit >= KIT_SYNC_MS) this.syncKitNotes();
        let job: Claimed | null = null;
        try {
          job = this.claimNext();
        } catch (e) {
          this.opts.log("shorts claim error", (e as Error).message);
        }
        if (!job) {
          await sleep(idle);
          continue;
        }
        this.running.set(job.id, job.input.episodeId);
        await this.runOne(job);
        this.running.delete(job.id);
      }
    })();
  }

  /** Stop the loop and kill a running claude (its job becomes an Interrupted error). */
  async stop() {
    this.stopped = true;
    this.abort.abort();
    if (this.loop) await Promise.race([this.loop, sleep(5_000)]);
    if (this.wordsLoop) await Promise.race([this.wordsLoop, sleep(2_000)]);
    recoverWordsRunning(this.sql);
  }
}
