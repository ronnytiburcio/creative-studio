/**
 * Derive queue: decide what an asset still needs (ensureDerived), enqueue, claim,
 * run and requeue jobs. SQLite-backed, concurrency N, thumbnails before proxies.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Kind } from "../lib/media";
import { OUTPUTS } from "../lib/variants";
import { requeueRunning, type DeriveJobStatus, type JobStatus, type JobType } from "../lib/jobs";
import { deriveImageThumb, deriveProxy, deriveVideoThumbs, type SourceInfo } from "./derive";

export type QueueAsset = {
  id: number;
  root_id: number;
  path: string;
  rel_path: string;
  ext: string;
  sha256: string | null;
  kind: Kind;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  thumb_path: string | null;
  sheet_path: string | null;
  proxy_path: string | null;
  derive_status: string | null;
  derive_error: string | null;
};

type JobRow = { id: number; type: JobType; asset_id: number };

export type QueueOptions = {
  cacheDir: string;
  concurrency: number;
  log: (...args: unknown[]) => void;
  /** Root ids whose files can be read right now (drive mounted, dir exists). */
  readableRootIds: () => number[];
  /** Is this asset's source readable right now? Used to tell "unplugged" from a real failure. */
  sourceReadable: (asset: QueueAsset) => boolean;
  isStopped: () => boolean;
};

const PRIORITY_THUMB = 0;
const PRIORITY_PROXY_BASE = 100; // + duration in seconds: short clips first
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeriveQueue {
  /** slot -> human label of the job running in it (for the heartbeat). */
  readonly running = new Map<number, string>();
  private loops: Promise<void>[] = [];
  private readonly stmts: {
    getAsset: Database.Statement;
    lastJob: Database.Statement;
    enqueue: Database.Statement;
    updateDerived: Database.Statement;
  };

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: QueueOptions,
  ) {
    this.stmts = {
      getAsset: sql.prepare("select * from assets where id = ?"),
      lastJob: sql.prepare("select status, error from jobs where asset_id = ? and type = ? order by id desc limit 1"),
      enqueue: sql.prepare(
        "insert or ignore into jobs (type, asset_id, status, priority, created_at) values (?, ?, 'pending', ?, ?)",
      ),
      updateDerived: sql.prepare(
        "update assets set thumb_path = ?, sheet_path = ?, proxy_path = ?, derive_status = ?, derive_error = ? where id = ?",
      ),
    };
  }

  private cacheDirFor(sha: string) {
    return path.join(this.opts.cacheDir, sha);
  }

  private getAsset(id: number) {
    return this.stmts.getAsset.get(id) as QueueAsset | undefined;
  }

  /** Link cache files that exist, enqueue what is missing, recompute derive_status. */
  ensureDerived(assetId: number) {
    const asset = this.getAsset(assetId);
    if (!asset || !asset.sha256) return;
    const sha = asset.sha256;
    const dir = this.cacheDirFor(sha);
    const cached = (file: string) => (fs.existsSync(path.join(dir, file)) ? `${sha}/${file}` : null);
    let thumb: string | null = null;
    let sheet: string | null = null;
    let proxy: string | null = null;
    const needs: { type: JobType; priority: number }[] = [];
    if (asset.kind === "video") {
      thumb = cached(OUTPUTS.poster.file);
      sheet = cached(OUTPUTS.sheet.file);
      proxy = cached(OUTPUTS.proxy.file);
      if (!thumb || !sheet) needs.push({ type: "derive_thumb", priority: PRIORITY_THUMB });
      if (!proxy) {
        needs.push({
          type: "derive_proxy",
          priority: PRIORITY_PROXY_BASE + Math.min(Math.round(asset.duration_s ?? 0), 100_000),
        });
      }
    } else if (asset.kind === "image") {
      thumb = cached(OUTPUTS.thumb.file);
      if (!thumb) needs.push({ type: "derive_thumb", priority: PRIORITY_THUMB });
    }
    let errorMessage: string | null = null;
    for (const need of needs) {
      const last = this.stmts.lastJob.get(asset.id, need.type) as { status: JobStatus; error: string | null } | undefined;
      if (last?.status === "error") {
        errorMessage = errorMessage ?? last.error ?? "derive failed";
        continue; // waits for a manual retry from the Jobs page
      }
      this.stmts.enqueue.run(need.type, asset.id, need.priority, Date.now());
    }
    const status = needs.length === 0 ? "done" : errorMessage ? "error" : "pending";
    const nextError = status === "done" ? null : (errorMessage ?? asset.derive_error);
    const unchanged =
      asset.thumb_path === thumb &&
      asset.sheet_path === sheet &&
      asset.proxy_path === proxy &&
      asset.derive_status === status &&
      asset.derive_error === nextError;
    if (unchanged) return; // unchanged files on a rescan cost reads only, no writes
    this.stmts.updateDerived.run(thumb, sheet, proxy, status, nextError, asset.id);
  }

  private claimNext(): JobRow | null {
    const rootIds = this.opts.readableRootIds();
    if (rootIds.length === 0) return null;
    const placeholders = rootIds.map(() => "?").join(",");
    return this.sql.transaction(() => {
      const job = this.sql
        .prepare(
          `select j.id, j.type, j.asset_id from jobs j join assets a on a.id = j.asset_id
            where j.status = 'pending' and a.missing = 0 and a.ignored = 0 and a.root_id in (${placeholders})
            order by j.priority, j.id limit 1`,
        )
        .get(...rootIds) as JobRow | undefined;
      if (!job) return null;
      this.sql
        .prepare("update jobs set status = 'running', started_at = ?, attempts = attempts + 1 where id = ?")
        .run(Date.now(), job.id);
      return job;
    })();
  }

  private async runJob(job: JobRow, slot: number) {
    const finish = this.sql.prepare("update jobs set status = ?, error = ?, finished_at = ? where id = ?");
    const asset = this.getAsset(job.asset_id);
    if (!asset || !asset.sha256) {
      finish.run("done" satisfies JobStatus, "asset gone", Date.now(), job.id);
      return;
    }
    this.running.set(slot, `${job.type === "derive_proxy" ? "proxy" : "thumb"}: ${asset.rel_path}`);
    const source: SourceInfo = {
      path: asset.path,
      ext: asset.ext,
      durationS: asset.duration_s,
      width: asset.width,
      height: asset.height,
    };
    const dir = this.cacheDirFor(asset.sha256);
    try {
      if (job.type === "derive_thumb") {
        if (asset.kind === "video") await deriveVideoThumbs(source, dir);
        else if (asset.kind === "image") await deriveImageThumb(source, dir);
      } else {
        await deriveProxy(source, dir);
      }
      finish.run("done" satisfies JobStatus, null, Date.now(), job.id);
    } catch (e) {
      if (this.opts.isStopped() || !this.opts.sourceReadable(asset)) {
        // Shutdown, drive unplugged or file moved: requeue, not an error.
        this.sql
          .prepare("update jobs set status = 'pending', started_at = null, attempts = max(attempts - 1, 0) where id = ?")
          .run(job.id);
      } else {
        const message = (e as Error).message.slice(0, 1000);
        this.opts.log(`derive error [${job.type}] ${asset.path}: ${message}`);
        finish.run("error" satisfies JobStatus, message, Date.now(), job.id);
      }
    } finally {
      this.running.delete(slot);
      this.ensureDerived(asset.id);
    }
  }

  /** Run until nothing is claimable (smoke tests, one-shot runs). */
  async drain() {
    await Promise.all(
      Array.from({ length: this.opts.concurrency }, async (_, slot) => {
        for (;;) {
          const job = this.claimNext();
          if (!job) return;
          await this.runJob(job, slot);
        }
      }),
    );
  }

  /** Long-running worker loops (daemon mode). */
  start() {
    for (let slot = 0; slot < this.opts.concurrency; slot++) {
      this.loops.push(
        (async () => {
          while (!this.opts.isStopped()) {
            let job: JobRow | null = null;
            try {
              job = this.claimNext();
            } catch (e) {
              this.opts.log("queue claim error", (e as Error).message);
            }
            if (!job) {
              await sleep(1000);
              continue;
            }
            await this.runJob(job, slot);
          }
        })(),
      );
    }
  }

  requeueInterrupted(): number {
    return requeueRunning(this.sql);
  }

  /**
   * Delete temp outputs left by a killed worker (derive.ts atomic() cleans up only on a
   * normal exit). Call at startup, before start(), while no job can be writing.
   */
  sweepTempFiles(): number {
    const TEMP = /(\.tmp-\d+-[0-9a-f]{8}\.[a-z0-9]+|^heic-\d+-[0-9a-f]{8}\.jpg)$/;
    let removed = 0;
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(this.opts.cacheDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const full = path.join(this.opts.cacheDir, dir.name);
      for (const name of fs.readdirSync(full)) {
        if (!TEMP.test(name)) continue;
        fs.rmSync(path.join(full, name), { force: true });
        removed++;
      }
    }
    return removed;
  }

  counts(): Record<DeriveJobStatus, number> {
    const rows = this.sql.prepare("select status, count(*) as n from jobs group by status").all() as {
      status: JobStatus;
      n: number;
    }[];
    const countFor = (status: JobStatus) => rows.find((row) => row.status === status)?.n ?? 0;
    return { pending: countFor("pending"), running: countFor("running"), done: countFor("done"), error: countFor("error") };
  }
}
