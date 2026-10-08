/**
 * Describe queue (worker only, Phase 3): a plain-text description of every image and video made on this Mac by the
 * Ollama vision model, plus the spoken opening (whisper, first 15 s) of every video with audio.
 *
 * Pull model over `assets`, not jobs rows (so the Jobs page never grows 1,700 rows and restarts need no recovery):
 * an asset is due when its stored description was made with another model / prompt version (or none), or when it is
 * a video whose spoken opening was never checked and whose proxy exists. Order: "Describe again" requests, then files
 * indexed since Describe was introduced (new), then the backfill, newest first. Concurrency 1.
 *
 *   claim -> fingerprint cache hit? apply it (no model call) : cache files -> vision model -> normalize
 *         -> spoken opening (video, cached proxy) -> descriptions row -> copy onto every asset with that fingerprint
 *
 * Reads ONLY cache files (thumb / poster / contact sheet / proxy), never the drive, so it works while the drive is
 * unplugged and cannot write to it. Temp files live in STUDIO_CACHE/describe-tmp/<asset id>/.
 * Restart safe: nothing is written until a result exists, so interrupted work is simply redone.
 * Ollama off / model missing = back off (5 s doubling to 60 s) without touching any asset; other failures are stored
 * on that asset (describe_error) and skipped until "Describe again" or "Retry errors".
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import sharp from "sharp";
import { resolveCacheFile } from "../lib/fsguard";
import { DESCRIBE_PROMPT_VERSION, imagePrompt, normalizeDescription, videoPrompt } from "../lib/ai/describe";
import { VisionTimeoutError, VisionUnavailableError, type VisionAdapter } from "../lib/ai/ollama";
import type { SpokenOpeningAdapter } from "../lib/ai/whisper";
import { DESCRIBABLE, describePaused, describeSince } from "../lib/ai/state";
import { profile } from "../lib/profile";
import { FFMPEG, run } from "./proc";

type DueRow = {
  id: number;
  sha256: string;
  kind: "image" | "video";
  rel_path: string;
  thumb_path: string;
  sheet_path: string | null;
  proxy_path: string | null;
  duration_s: number | null;
  describe_requested_at: number | null;
};

type CacheRow = {
  text: string;
  spoken_open: string | null;
  ms: number | null;
  spoken_ms: number | null;
  first_image: string | null;
  created_at: number;
};

export type DescribeState = "running" | "idle" | "paused" | "waiting" | "off";

export type DescribeOutcome = "described" | "cached" | "error" | "unavailable" | "interrupted";

export type DescribeQueueOptions = {
  cacheDir: string;
  vision: VisionAdapter;
  /** Spoken openings; null = not configured (videos are described, their spoken opening waits). */
  whisper: SpokenOpeningAdapter | null;
  /** whisper binary + model present right now (checked per claim; installing it later just works). */
  whisperReady?: () => boolean;
  /** Defaults to DESCRIBE_PROMPT_VERSION (the smoke test bumps it). */
  promptVersion?: number;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  /** Poll interval while idle or paused (pause / requests are honoured within this). */
  idleMs?: number;
  backoffMs?: { min: number; max: number };
};

class InputError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DescribeQueue {
  state: DescribeState = "idle";
  current: string | null = null;
  note: string | null = null;
  readonly model: string;
  readonly promptVersion: number;
  private readonly since: number;
  private stopped = false;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private backoff = 0;
  private waitUntil = 0;

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: DescribeQueueOptions,
  ) {
    this.model = opts.vision.model;
    this.promptVersion = opts.promptVersion ?? DESCRIBE_PROMPT_VERSION;
    this.since = describeSince(sql);
  }

  private whisperReady() {
    return Boolean(this.opts.whisper) && (this.opts.whisperReady?.() ?? true);
  }

  private isStopped() {
    return this.stopped || this.opts.isStopped();
  }

  // ------------------------------------------------------------------ claim

  /**
   * Next asset to work on, or null. While paused only "Describe again" requests are returned. Videos wait for their
   * proxy (the opening frames and the audio come from it) unless its derive failed, then the poster stands in.
   */
  claimNext(): DueRow | null {
    const paused = describePaused(this.sql);
    return (
      (this.sql
        .prepare(
          `select a.id, a.sha256, a.kind, a.rel_path, a.thumb_path, a.sheet_path, a.proxy_path, a.duration_s, a.describe_requested_at
             from assets a join roots r on r.id = a.root_id
            where r.enabled = 1 and ${DESCRIBABLE} and a.sha256 is not null and a.thumb_path is not null
              and (a.kind = 'image' or (a.sheet_path is not null and (a.proxy_path is not null or a.derive_status = 'error')))
              and (a.describe_requested_at is not null or (@paused = 0 and a.describe_error is null and (
                     a.description_model is not @model or a.description_version is not @version
                     or (@whisper = 1 and a.kind = 'video' and a.spoken_open is null and a.proxy_path is not null))))
            order by a.describe_requested_at is null, a.describe_requested_at, a.indexed_at >= @since desc, a.mtime desc, a.id desc
            limit 1`,
        )
        .get({
          paused: paused ? 1 : 0,
          model: this.model,
          version: this.promptVersion,
          whisper: this.whisperReady() ? 1 : 0,
          since: this.since,
        }) as DueRow | undefined) ?? null
    );
  }

  // ----------------------------------------------------------------- inputs

  private cacheFile(rel: string | null): string {
    const file = resolveCacheFile(this.opts.cacheDir, rel);
    if (!file) throw new InputError("Preview files are missing from the cache (they are rebuilt on the next scan). Describe again after that.");
    return file;
  }

  private async jpeg(file: string): Promise<Buffer> {
    return sharp(file).rotate().jpeg({ quality: 85 }).toBuffer();
  }

  /** 3 frames from the first 3 s of the cached proxy, side by side (short clips: 20/50/80 %). null = could not make it. */
  private async openingStrip(proxy: string, durationS: number | null, workDir: string): Promise<string | null> {
    if (!durationS || durationS <= 0) return null;
    const times = durationS >= 3 ? [0.5, 1.5, 2.5] : [durationS * 0.2, durationS * 0.5, durationS * 0.8];
    const out = path.join(workDir, "opening.jpg");
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
    let fc = "";
    times.forEach((t, i) => {
      args.push("-ss", t.toFixed(3), "-i", proxy);
      fc += `[${i}:v]scale='if(gt(iw,ih),426,-2)':'if(gt(iw,ih),-2,320)',setsar=1[v${i}];`;
    });
    fc += "[v0][v1][v2]hstack=3,format=yuvj420p[out]";
    try {
      const r = await run(FFMPEG, [...args, "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", "-q:v", "4", out], {
        timeoutMs: 60_000,
      });
      return r.code === 0 && fs.existsSync(out) ? out : null;
    } catch {
      return null;
    }
  }

  private async inputs(row: DueRow, workDir: string) {
    if (row.kind === "image") {
      return { images: [await this.jpeg(this.cacheFile(row.thumb_path))], prompt: imagePrompt(profile()), firstImage: null };
    }
    const sheet = await this.jpeg(this.cacheFile(row.sheet_path));
    const proxy = row.proxy_path ? this.cacheFile(row.proxy_path) : null;
    const strip = proxy ? await this.openingStrip(proxy, row.duration_s, workDir) : null;
    const firstImage = strip ? "opening" : "poster";
    const first = await this.jpeg(strip ?? this.cacheFile(row.thumb_path));
    return { images: [first, sheet], prompt: videoPrompt(firstImage, profile()), firstImage };
  }

  // -------------------------------------------------------------------- run

  /** Describe (or apply the cached description to) one asset. Never throws. */
  async runOne(row: DueRow): Promise<{ outcome: DescribeOutcome; message?: string }> {
    const forced = row.describe_requested_at != null;
    const workDir = path.join(this.opts.cacheDir, "describe-tmp", String(row.id));
    const cached = forced
      ? undefined
      : (this.sql
          .prepare("select text, spoken_open, ms, spoken_ms, first_image, created_at from descriptions where sha256 = ? and model = ? and prompt_version = ?")
          .get(row.sha256, this.model, this.promptVersion) as CacheRow | undefined);
    try {
      let text: string;
      let ms: number | null;
      let firstImage: string | null;
      let createdAt: number;
      let spoken: string | null = null;
      let spokenMs: number | null = null;
      if (cached) {
        ({ text, ms, spoken_open: spoken, spoken_ms: spokenMs } = cached);
        firstImage = cached.first_image;
        createdAt = cached.created_at;
      } else {
        fs.mkdirSync(workDir, { recursive: true });
        const input = await this.inputs(row, workDir);
        const res = await this.opts.vision.describe(input.images, input.prompt, { signal: this.abort.signal });
        text = normalizeDescription(res.text);
        if (!text) throw new Error("The vision model returned an empty description.");
        ms = res.ms;
        firstImage = input.firstImage;
        createdAt = Date.now();
        if (!forced) {
          // The spoken opening depends on the bytes only: reuse one found under another model / prompt version.
          const prior = this.sql
            .prepare("select spoken_open, spoken_ms from descriptions where sha256 = ? and spoken_open is not null order by created_at desc limit 1")
            .get(row.sha256) as { spoken_open: string; spoken_ms: number | null } | undefined;
          spoken = prior?.spoken_open ?? null;
          spokenMs = prior?.spoken_ms ?? null;
        }
      }

      let spokenError: string | null = null;
      if (row.kind === "video" && spoken == null && row.proxy_path && this.whisperReady()) {
        try {
          const opening = await this.opts.whisper!.transcribeOpening(this.cacheFile(row.proxy_path), workDir);
          spoken = opening.text;
          spokenMs = opening.ms;
        } catch (e) {
          if (this.isStopped()) return { outcome: "interrupted" };
          spokenError = `Spoken opening: ${(e as Error).message}`.slice(0, 500);
        }
      }

      this.sql.transaction(() => {
        this.sql
          .prepare(
            `insert into descriptions (sha256, model, prompt_version, text, spoken_open, ms, spoken_ms, first_image, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (sha256, model, prompt_version) do update set text = excluded.text, spoken_open = excluded.spoken_open,
               ms = excluded.ms, spoken_ms = excluded.spoken_ms, first_image = excluded.first_image, created_at = excluded.created_at`,
          )
          .run(row.sha256, this.model, this.promptVersion, text, spoken, ms, spokenMs, firstImage, createdAt);
        // Every copy of these bytes (duplicates, renamed files) gets it at once and never reaches the model.
        this.sql
          .prepare(
            `update assets set description = ?, description_model = ?, description_version = ?, spoken_open = ?, described_at = ?,
               describe_error = null where sha256 = ?`,
          )
          .run(text, this.model, this.promptVersion, spoken, createdAt, row.sha256);
        this.finishAsset(row, spokenError);
      })();
      if (spokenError) this.opts.log(`describe: ${row.rel_path}: ${spokenError}`);
      return { outcome: cached ? "cached" : "described", message: spokenError ?? undefined };
    } catch (e) {
      if (this.isStopped()) return { outcome: "interrupted" };
      if (e instanceof VisionUnavailableError) return { outcome: "unavailable", message: e.message };
      if (e instanceof VisionTimeoutError) {
        const status = await this.opts.vision.status();
        if (!status.reachable) return { outcome: "unavailable", message: status.error ?? "Ollama is not reachable" };
      }
      const message = ((e as Error).message || "Describe failed").slice(0, 500);
      this.opts.log(`describe error: ${row.rel_path}: ${message}`);
      this.finishAsset(row, message);
      return { outcome: "error", message };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Record the asset's error (or clear it) and drop the request it was claimed for (a newer click survives). */
  private finishAsset(row: DueRow, error: string | null) {
    this.sql
      .prepare(
        `update assets set describe_error = ?,
           describe_requested_at = case when describe_requested_at is ? then null else describe_requested_at end
         where id = ?`,
      )
      .run(error, row.describe_requested_at, row.id);
  }

  // ------------------------------------------------------------------ loops

  private noteUnavailable(message: string) {
    this.backoff = this.backoff ? Math.min(this.backoff * 2, this.opts.backoffMs?.max ?? 60_000) : (this.opts.backoffMs?.min ?? 5_000);
    this.waitUntil = Date.now() + this.backoff;
    if (this.note !== message) this.opts.log(`describe: ${message}; waiting (retry in ${Math.round(this.backoff / 1000)} s)`);
    this.state = "waiting";
    this.note = message;
  }

  /** Work until nothing is due (smoke tests, one-shot runs). Stops early when the model is unavailable. */
  async drain(): Promise<Record<DescribeOutcome, number>> {
    const counts: Record<DescribeOutcome, number> = { described: 0, cached: 0, error: 0, unavailable: 0, interrupted: 0 };
    for (;;) {
      if (this.isStopped()) return counts;
      const row = this.claimNext();
      if (!row) return counts;
      const { outcome, message } = await this.runOne(row);
      counts[outcome]++;
      if (outcome === "unavailable") {
        this.noteUnavailable(message ?? "Ollama is not available");
        return counts;
      }
      if (outcome === "interrupted") return counts;
    }
  }

  start() {
    if (this.loop) return;
    const idle = this.opts.idleMs ?? 2_000;
    this.loop = (async () => {
      while (!this.isStopped()) {
        let row: DueRow | null = null;
        try {
          row = this.claimNext();
        } catch (e) {
          this.opts.log("describe claim error", (e as Error).message);
        }
        if (!row) {
          this.state = describePaused(this.sql) ? "paused" : "idle";
          this.current = null;
          await sleep(idle);
          continue;
        }
        const wait = this.waitUntil - Date.now();
        if (wait > 0) {
          this.state = "waiting";
          this.current = null;
          await sleep(Math.min(wait, idle));
          continue;
        }
        this.state = "running";
        this.current = row.rel_path;
        const { outcome, message } = await this.runOne(row);
        this.current = null;
        if (outcome === "unavailable") this.noteUnavailable(message ?? "Ollama is not available");
        else if (outcome !== "interrupted") {
          if (this.backoff) this.opts.log("describe: Ollama is back");
          this.backoff = 0;
          this.note = null;
        }
      }
    })();
  }

  /** Stop the loop and abort an in-flight Ollama request (whisper children are killed by the engine). */
  async stop() {
    this.stopped = true;
    this.abort.abort();
    this.state = "off";
    this.current = null;
    if (this.loop) await Promise.race([this.loop, sleep(5_000)]);
  }

  /** Remove temp dirs left by a killed worker. Call at startup, before start(). */
  sweepTemp() {
    fs.rmSync(path.join(this.opts.cacheDir, "describe-tmp"), { recursive: true, force: true });
  }
}
