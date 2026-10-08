/**
 * Generation queue (worker process only). Claims gen_* jobs (asset_id null, request in jobs.input),
 * runs them through an engine adapter, and lands the outputs in Studio Generated via the write guard:
 *
 *   claim -> quote cost -> start (external id stored at once) -> poll -> collect into the cache
 *        -> wait for the drive -> sidecar + move in (write guard) -> ingest -> done
 *
 * Restart safety: a running Higgsfield job with an external id is re-polled, never re-created (credits are
 * spent at start); one without an id was interrupted mid-start and becomes an error that says so. Engines
 * whose jobs are local processes (Codex, `resumable: false`) cannot be picked up again: their running jobs
 * become "interrupted, retry" errors, and Retry simply runs them again.
 * Cancel (Codex only): the app sets jobs.cancel_requested_at; the poll loop sees it, the adapter kills the run.
 * References: images go as originals (HEIC/GIF -> JPEG); videos as originals when H.264 MP4/MOV under 200 MB,
 * else as a cached 1080p H.264 transcode (STUDIO_CACHE/<fingerprint>/ref1080.mp4).
 * Quick tools (gen_tool) run through the same path: the source asset is references[0] (so it gets the same
 * original / JPEG / 1080p-transcode rules), the adapter sends no prompt, and the output name and sidecar carry
 * the tool and the source. Video upscale / remove background quotes are minimums (logged as such).
 * Separate slots per engine (Higgsfield 3, Codex 2); independent of the derive queue, which only claims jobs
 * joined to an asset.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { GEN_IN, MAY_EXIST_ON_ENGINE, type GenJobType } from "../lib/jobs";
import { destSegments } from "../lib/gen/generated-dirs";
import { buildSidecar, freeOutputPath, outputStem, sidecarPathFor } from "../lib/gen/output";
import { REF_TRANSCODE_FILE, videoRefPlan } from "../lib/gen/refs";
import {
  JobNotFoundError,
  StartUncertainError,
  type AdapterContext,
  type GenAdapter,
  type GenEngineId,
  type GenInput,
  type GenResult,
  type PreparedRef,
} from "../lib/gen/types";
import type { OriginalCheck } from "../lib/originals";
import type { WriteGuard } from "../lib/writeguard";
import { run } from "./proc";
import { deriveReference1080 } from "./derive";

type GenJobRow = {
  id: number;
  type: GenJobType;
  input: string | null;
  external_id: string | null;
  result: string | null;
  started_at: number | null;
};

export type GenQueueOptions = {
  adapters: Partial<Record<GenEngineId, GenAdapter>>;
  /** Parallel jobs per engine. */
  concurrency: Partial<Record<GenEngineId, number>>;
  guard: WriteGuard;
  cacheDir: string;
  logsDir: string;
  /** Ingest one file right away (engine fingerprint/probe/tags/derive). Returns the asset id. */
  ingest: (file: string) => Promise<number | null>;
  /** Re-check a reference at start time (root enabled, file present, drive mounted). */
  originalFor: (assetId: number) => OriginalCheck;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  pollMs?: number;
  /** Give up polling after this long (the job keeps its external id, so Retry re-polls). */
  pollTimeoutMs?: number;
};

/** Consecutive "job not found" polls before the id is treated as dead (a remote failure: Retry creates a new job). */
const NOT_FOUND_LIMIT = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONVERT_EXT = new Set(["heic", "gif"]);

class RemoteFailure extends Error {}
class Cancelled extends Error {}

export class GenQueue {
  /** jobId -> label, for the heartbeat. */
  readonly running = new Map<number, string>();
  private resume: GenJobRow[] = [];
  private starting = new Set<number>();
  private loops: Promise<void>[] = [];

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: GenQueueOptions,
  ) {}

  private engines(): GenEngineId[] {
    return Object.keys(this.opts.adapters) as GenEngineId[];
  }

  // ------------------------------------------------------------------ state

  private jobLogPath(id: number) {
    return path.join(this.opts.logsDir, "jobs", `gen-${id}.log`);
  }

  private logger(id: number) {
    const file = this.jobLogPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return (line: string) => {
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* logging never fails a job */
      }
    };
  }

  private saveResult(id: number, result: GenResult) {
    this.sql.prepare("update jobs set result = ? where id = ?").run(JSON.stringify(result), id);
  }

  private finish(id: number, status: "done" | "error" | "cancelled", error: string | null) {
    this.sql
      .prepare("update jobs set status = ?, error = ?, finished_at = ?, cancel_requested_at = null where id = ?")
      .run(status, error, Date.now(), id);
  }

  private cancelRequested(id: number): boolean {
    return this.sql.prepare("select cancel_requested_at from jobs where id = ?").pluck().get(id) != null;
  }

  /**
   * Worker start: running jobs of resumable engines with an external id are queued for re-polling (never
   * re-created); ones without an id were cut off mid-start. Running jobs of local-process engines (Codex)
   * died with the old worker. Both become errors that say what happened. Returns counts.
   */
  recover(): { resumed: number; interrupted: number } {
    const rows = this.sql
      .prepare(`select id, type, input, external_id, result, started_at from jobs where status = 'running' and ${GEN_IN}`)
      .all() as GenJobRow[];
    let interrupted = 0;
    for (const row of rows) {
      const engine = this.engineOf(row);
      const adapter = engine ? this.opts.adapters[engine] : undefined;
      if (adapter && !adapter.resumable) {
        this.logger(row.id)("interrupted: the worker restarted while this run was going");
        this.sql.prepare("update jobs set external_id = null where id = ?").run(row.id);
        this.finish(row.id, "error", "Interrupted (Studio's worker restarted). Retry runs it again.");
        interrupted++;
      } else if (row.external_id) {
        this.resume.push(row);
      } else {
        this.logger(row.id)("interrupted before the engine returned a job id");
        this.saveResult(row.id, { ...this.parseResult(row.result), startUncertain: true });
        this.finish(row.id, "error", `Interrupted while starting. ${MAY_EXIST_ON_ENGINE}`);
        interrupted++;
      }
    }
    return { resumed: this.resume.length, interrupted };
  }

  private claim(engine: GenEngineId): GenJobRow | null {
    const resumeAt = this.resume.findIndex((row) => this.engineOf(row) === engine);
    if (resumeAt >= 0) return this.resume.splice(resumeAt, 1)[0];
    if (!this.opts.guard.isDriveMounted()) return null; // outputs need the drive; pending jobs wait for it
    // IMMEDIATE: take the write lock before reading, and flip only a row that is still pending, so an app-side
    // cancel of a pending job (one guarded UPDATE) and this claim can never both win.
    return this.sql.transaction(() => {
      const job = this.sql
        .prepare(
          `select id, type, input, external_id, result, started_at from jobs
            where status = 'pending' and asset_id is null and ${GEN_IN} and json_extract(input, '$.engine') = ?
            order by priority, id limit 1`,
        )
        .get(engine) as GenJobRow | undefined;
      if (!job) return null;
      const now = Date.now();
      const claimed = this.sql
        .prepare("update jobs set status = 'running', started_at = ?, attempts = attempts + 1, log_path = ? where id = ? and status = 'pending'")
        .run(now, this.jobLogPath(job.id), job.id).changes;
      return claimed ? { ...job, started_at: now } : null;
    }).immediate();
  }

  private parseResult(raw: string | null): GenResult {
    try {
      return (JSON.parse(raw ?? "{}") as GenResult) ?? {};
    } catch {
      return {};
    }
  }

  private engineOf(row: GenJobRow): GenEngineId | null {
    try {
      return (JSON.parse(row.input ?? "{}") as Partial<GenInput>).engine ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- one job

  /**
   * References re-checked now (originalFileFor + same path as queued). Images: the original, or a JPEG in
   * the job's temp dir for HEIC / GIF. Videos: the original when H.264 MP4/MOV under 200 MB, else a 1080p
   * H.264 transcode cached next to the asset's other derived files (reused by later runs).
   */
  private async prepareReferences(input: GenInput, ctx: AdapterContext): Promise<PreparedRef[]> {
    const out: PreparedRef[] = [];
    for (const [i, ref] of input.references.entries()) {
      const role = ref.role ?? "image_references";
      const original = this.opts.originalFor(ref.assetId);
      if (!original.ok) throw new Error(`reference ${ref.assetId} is unavailable (${original.error})`);
      if (original.file !== ref.path) throw new Error(`reference ${ref.assetId} changed since it was queued`);
      const ext = path.extname(original.file).slice(1).toLowerCase();
      if (ref.kind === "video") {
        const row = this.sql.prepare("select codec, bytes, sha256 from assets where id = ?").get(ref.assetId) as
          | { codec: string | null; bytes: number; sha256: string | null }
          | undefined;
        if (!row?.sha256) throw new Error(`reference ${ref.assetId} is not indexed yet`);
        const plan = videoRefPlan({ codec: row.codec, bytes: row.bytes, ext });
        if (plan.action === "original") {
          ctx.log(`reference ${ref.assetId}: original (H.264, under 200 MB)`);
          out.push({ path: original.file, role, kind: "video" });
          continue;
        }
        const dir = path.join(this.opts.cacheDir, row.sha256);
        const cached = path.join(dir, REF_TRANSCODE_FILE);
        if (!fs.existsSync(cached)) {
          ctx.log(`reference ${ref.assetId}: making a 1080p H.264 reference (${plan.reason})`);
          await deriveReference1080(original.file, dir);
        } else {
          ctx.log(`reference ${ref.assetId}: cached 1080p reference (${plan.reason})`);
        }
        out.push({ path: cached, role, kind: "video" });
        continue;
      }
      if (!CONVERT_EXT.has(ext)) {
        out.push({ path: original.file, role, kind: "image" });
        continue;
      }
      fs.mkdirSync(ctx.tmpDir, { recursive: true });
      const jpg = path.join(ctx.tmpDir, `ref-${i + 1}.jpg`);
      const r = await run("/usr/bin/sips", ["-s", "format", "jpeg", original.file, "--out", jpg], { timeoutMs: 120_000 });
      if (r.code !== 0 || !fs.existsSync(jpg)) throw new Error(`could not convert reference ${ref.assetId} to JPEG`);
      out.push({ path: jpg, role, kind: "image" });
    }
    return out;
  }

  /** Poll until done (true) or the worker stops (false). The timeout counts from this polling session. */
  private async pollUntilDone(
    jobId: number,
    adapter: GenAdapter,
    externalId: string,
    startedAt: number,
    ctx: AdapterContext,
  ): Promise<boolean> {
    const pollMs = adapter.cancel ? Math.min(this.opts.pollMs ?? 4000, 2000) : (this.opts.pollMs ?? 4000);
    const timeout = this.opts.pollTimeoutMs ?? 45 * 60_000;
    let failures = 0;
    let notFound = 0;
    let lastStatus = "";
    for (;;) {
      if (this.opts.isStopped()) return false;
      if (adapter.cancel && this.cancelRequested(jobId)) {
        await adapter.cancel(externalId, ctx);
        throw new Cancelled("Cancelled");
      }
      try {
        const res = await adapter.poll(externalId, ctx);
        failures = 0;
        notFound = 0;
        if (res.status !== lastStatus) ctx.log(`status: ${res.status}`);
        lastStatus = res.status;
        if (res.state === "done") return true;
        if (res.state === "failed") throw new RemoteFailure(res.reason);
      } catch (e) {
        if (e instanceof RemoteFailure) throw e;
        if (e instanceof JobNotFoundError) {
          // A dead id (never existed, or gone): re-polling it forever would never finish. After a few in a row it
          // is a remote failure, which forgets the id so a Retry creates a fresh job (and says it spends credits).
          notFound++;
          ctx.log(`poll: ${e.message} (${notFound}/${NOT_FOUND_LIMIT})`);
          if (notFound >= NOT_FOUND_LIMIT) throw new RemoteFailure(`${e.message}. Retry creates a new job and spends credits again.`);
          await sleep(pollMs);
          continue;
        }
        failures++;
        ctx.log(`poll error ${failures}: ${(e as Error).message}`);
        if (failures >= 10) throw new Error(`could not reach the engine (${(e as Error).message}). Retry re-polls the same job.`);
      }
      if (Date.now() - startedAt > timeout) throw new Error("Timed out waiting for the engine. Retry re-polls the same job (no new credits).");
      await sleep(pollMs);
    }
  }

  /** studioJobId in a sidecar, or null when there is none (or it cannot be read). */
  private sidecarOwner(sidecarPath: string): number | null {
    try {
      const d = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as { studioJobId?: unknown };
      return typeof d.studioJobId === "number" ? d.studioJobId : null;
    } catch {
      return null;
    }
  }

  /**
   * The target for output `index`, recorded in jobs.result BEFORE anything is written, so landing is idempotent
   * across a crash: a planned target is reused when its sidecar is ours (the file may already be in place) or when
   * nothing is there yet. A planned name that something else took meanwhile is re-planned.
   */
  private planTarget(jobId: number, result: GenResult, index: number, fresh: () => string): string {
    const planned = result.planned?.find((p) => p.index === index)?.path;
    if (planned) {
      const owner = this.sidecarOwner(sidecarPathFor(planned));
      if (owner === jobId) return planned;
      if (owner === null && !fs.existsSync(planned) && !fs.existsSync(sidecarPathFor(planned))) return planned;
    }
    const target = fresh();
    result.planned = [...(result.planned ?? []).filter((p) => p.index !== index), { index, path: target }];
    this.saveResult(jobId, result);
    return target;
  }

  private async process(job: GenJobRow) {
    const log = this.logger(job.id);
    const ctx: AdapterContext = { tmpDir: path.join(this.opts.cacheDir, "gen-tmp", String(job.id)), log };
    let input: GenInput;
    try {
      input = JSON.parse(job.input ?? "") as GenInput;
      if (input.v !== 1 || !input.model || !input.dest) throw new Error("bad input");
    } catch {
      this.finish(job.id, "error", "Invalid generation request.");
      return;
    }
    const adapter = this.opts.adapters[input.engine];
    if (!adapter) {
      this.finish(job.id, "error", `Engine ${input.engine} is not available in this worker.`);
      return;
    }
    const result = this.parseResult(job.result);
    let externalId = job.external_id;
    this.running.set(
      job.id,
      input.tool
        ? `${input.engine} ${input.model}: ${input.tool.id} ${input.tool.source.filename.slice(0, 60)}`
        : `${input.engine} ${input.model}: ${input.prompt.slice(0, 60)}`,
    );
    try {
      if (!externalId) {
        const references = await this.prepareReferences(input, ctx);
        if (this.cancelRequested(job.id)) throw new Cancelled("Cancelled");
        try {
          result.credits = await adapter.estimate(input);
          // Video upscale / remove background: Higgsfield's quote does not know the clip length (a minimum).
          if (input.tool && !input.tool.exactQuote && result.credits != null) result.creditsMinimum = true;
          ctx.log(
            result.credits == null
              ? "no credit quote (not billed per run)"
              : `quoted ${result.credits} credits${result.creditsMinimum ? " (minimum: the quote does not know the clip length)" : ""}`,
          );
        } catch (e) {
          ctx.log(`cost quote failed: ${(e as Error).message}`);
          result.credits = null;
        }
        delete result.startUncertain;
        this.saveResult(job.id, result);
        this.starting.add(job.id);
        try {
          externalId = await adapter.start(input, references, ctx);
        } catch (e) {
          if (e instanceof StartUncertainError) {
            result.startUncertain = true;
            this.saveResult(job.id, result);
          }
          throw e;
        } finally {
          this.starting.delete(job.id);
        }
        // Stored before anything else can fail: from here on a restart re-polls instead of re-creating.
        this.sql.prepare("update jobs set external_id = ? where id = ?").run(externalId, job.id);
        ctx.log(`started ${externalId}`);
      } else {
        ctx.log(`resuming ${externalId}`);
      }

      this.opts.log(`gen: job ${job.id} ${input.engine} ${input.model} -> ${externalId}`);
      if (!(await this.pollUntilDone(job.id, adapter, externalId, Date.now(), ctx))) return; // stopping: stays running
      result.remoteStatus = "completed";
      this.saveResult(job.id, result);

      const files = await adapter.collect(externalId, ctx);
      ctx.log(`collected ${files.length} file(s)`);
      while (!this.opts.guard.isDriveMounted()) {
        if (this.opts.isStopped()) return; // re-polled + re-collected after the restart
        ctx.log("waiting for the drive to be mounted");
        await sleep(5000);
      }
      const destDir = this.opts.guard.ensureDir(path.join(this.opts.guard.base, ...destSegments(input.dest)));
      result.outputs = result.outputs ?? [];
      for (const [i, file] of files.entries()) {
        const index = i + 1;
        if (result.outputs.some((o) => o.index === index)) continue; // already landed and indexed before a restart
        const ext = path.extname(file).slice(1).toLowerCase() || "bin";
        const target = this.planTarget(job.id, result, index, () =>
          freeOutputPath(destDir, outputStem(input) + (files.length > 1 ? `-${index}` : ""), ext),
        );
        const sidecarPath = sidecarPathFor(target);
        // Sidecar first, so any ingest (ours or the watcher's) already sees the file as generated. A sidecar that
        // is already there is ours (planTarget checked): written before a crash, reused as is.
        if (fs.existsSync(sidecarPath)) ctx.log("reusing the sidecar written before a restart");
        else {
          const sidecar = buildSidecar({
            file: target,
            input,
            jobType: job.type,
            credits: result.credits ?? null,
            creditsMinimum: result.creditsMinimum,
            externalId,
            jobId: job.id,
          });
          this.opts.guard.writeNewFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
        }
        if (fs.existsSync(target)) ctx.log(`already moved in before a restart: ${target}`);
        else {
          this.opts.guard.moveIn(file, target);
          ctx.log(`saved ${target}`);
        }
        const assetId = await this.opts.ingest(target);
        ctx.log(assetId ? `indexed as asset ${assetId}` : "not indexed (is the Studio Generated root enabled?)");
        result.outputs.push({ index, path: target, assetId });
        this.saveResult(job.id, result);
      }
      this.finish(job.id, "done", null);
      ctx.log("done");
      this.opts.log(`gen: job ${job.id} done (${result.outputs.length} file(s))`);
    } catch (e) {
      if (e instanceof Cancelled) {
        ctx.log("cancelled");
        this.opts.log(`gen: job ${job.id} cancelled`);
        this.sql.prepare("update jobs set external_id = null where id = ?").run(job.id);
        this.finish(job.id, "cancelled", "Cancelled");
        return;
      }
      const message = ((e as Error).message || "generation failed").slice(0, 600);
      ctx.log(`error: ${message}`);
      this.opts.log(`gen: job ${job.id} error: ${message}`);
      if (!adapter.resumable) {
        // A local run cannot be picked up again: Retry runs it from scratch.
        if (e instanceof RemoteFailure) result.engineMessage = message;
        this.saveResult(job.id, result);
        this.sql.prepare("update jobs set external_id = null where id = ?").run(job.id);
      } else if (e instanceof RemoteFailure && externalId) {
        // The remote job itself failed: forget its id so a Retry creates a fresh one.
        result.failedExternalIds = [...(result.failedExternalIds ?? []), externalId];
        result.remoteStatus = message;
        this.saveResult(job.id, result);
        this.sql.prepare("update jobs set external_id = null where id = ?").run(job.id);
      }
      this.finish(job.id, "error", message);
    } finally {
      this.running.delete(job.id);
      if (this.sql.prepare("select status from jobs where id = ?").pluck().get(job.id) !== "running") {
        fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
      }
    }
  }

  // ---------------------------------------------------------------- loops

  /** Run until nothing is claimable (smoke tests). */
  async drain() {
    await Promise.all(
      this.engines().flatMap((engine) =>
        Array.from({ length: this.opts.concurrency[engine] ?? 1 }, async () => {
          for (;;) {
            const job = this.claim(engine);
            if (!job) return;
            await this.process(job);
          }
        }),
      ),
    );
  }

  start() {
    for (const engine of this.engines()) {
      for (let slot = 0; slot < (this.opts.concurrency[engine] ?? 1); slot++) {
        this.loops.push(
          (async () => {
            while (!this.opts.isStopped()) {
              let job: GenJobRow | null = null;
              try {
                job = this.claim(engine);
              } catch (e) {
                this.opts.log("gen claim error", (e as Error).message);
              }
              if (!job) {
                await sleep(1500);
                continue;
              }
              await this.process(job);
            }
          })(),
        );
      }
    }
  }

  /** Let a create call that is already in flight return its id (so it gets stored), up to `ms`. */
  async stop(ms = 8000) {
    const until = Date.now() + ms;
    while (this.starting.size && Date.now() < until) await sleep(200);
  }

  /** Remove "*.part" leftovers of an interrupted move-in (worker start, via the write guard). */
  sweepParts(): number {
    return this.opts.guard.sweepPartFiles();
  }

  /** Remove temp dirs of jobs that are no longer running (worker start). */
  sweepTemp() {
    const dir = path.join(this.opts.cacheDir, "gen-tmp");
    if (!fs.existsSync(dir)) return;
    const running = new Set(
      (this.sql.prepare(`select id from jobs where status = 'running' and ${GEN_IN}`).all() as { id: number }[]).map((r) => String(r.id)),
    );
    for (const name of fs.readdirSync(dir)) if (!running.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}
