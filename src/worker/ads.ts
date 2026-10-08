/**
 * New PAUSED ad queue (worker only, Phase 6 slice 3): runs `ad_copy` job rows ("Draft the rest") one at a time with the
 * real `claude` CLI through the Phase 4 runner (src/lib/hooks/claude.ts: argument array, minimal env, no tools, no MCP,
 * no settings, own process group, timeout; never the Anthropic API), and reads every Studio order file that may still
 * change back into `ad_orders` every 60 s (src/lib/meta/orders.ts syncOrders: a guarded READ of exactly the stored file
 * path inside the two configured folders, size capped, zod). Nothing here writes to Meta, GHL or any order file.
 *
 * Per job: context + prompt (src/lib/meta/ad-copy-job.ts) -> claude -p -> parse {headlines, primaries, descriptions,
 * concept, ps_obj} -> every line through the same code checks the dialog and Stage use (src/lib/meta/ad-copy-rules.ts) +
 * FORMAT v4 (primaries double spaced; a one-line primary is dropped) + no repeat of a line already in the ad -> fewer than
 * the slots that need text = one retry of the whole call (told what broke; survivors of both kept) -> job done with the
 * draft (a note when some slots stayed empty; an error when nothing passed). A timeout, a CLI error or an answer that is
 * not JSON is a job error (Retry runs it again). Log: logs/jobs/ad-copy-<id>.log. The result is the only thing written.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { StudioConfig } from "../lib/config";
import { ClaudeError, claudeArgs, claudeCommandLine, CLAUDE_TIMEOUT_MS, parseClaudeJson, resolveClaude, runClaude, type ClaudeResult } from "../lib/hooks/claude";
import { terseJobError } from "../lib/jobs";
import {
  AD_COPY_JOB,
  AdCopyError,
  adCopyContext,
  buildAdCopyPrompt,
  draftComplete,
  keepDrafted,
  parseAdDraft,
  type AdCopyAttempt,
  type AdCopyJobInput,
  type AdCopyJobResult,
  type AdDraft,
  type RawAdDraft,
} from "../lib/meta/ad-copy-job";
import { syncOrders } from "../lib/meta/orders";

export type AdQueueOptions = {
  cfg: Pick<StudioConfig, "metaEnvFile" | "clientDocsDir" | "drivePath" | "pendingDirs">;
  cacheDir: string;
  logsDir: string;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  timeoutMs?: number;
  idleMs?: number;
  /** Order read-back period (default 60 s). */
  ordersMs?: number;
  now?: () => number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const AD_INTERRUPTED = "Interrupted (Studio's worker restarted). Retry runs it again.";
/** What a job row says for an unexpected failure (the detail stays in the job's log and the worker log). */
export const AD_FAILED = "Draft failed (see the log)";
export const ORDERS_SYNC_MS = 60_000;

type Claimed = { id: number; input: AdCopyJobInput };

export class AdQueue {
  readonly running = new Map<number, string>();
  private stopped = false;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private ordersTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: AdQueueOptions,
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private isStopped() {
    return this.stopped || this.opts.isStopped();
  }

  /** A `running` row after a restart never finished (only the result is ever written): an error the owner can Retry. */
  recover(): number {
    return this.sql
      .prepare(`update jobs set status = 'error', error = ?, finished_at = ? where type = '${AD_COPY_JOB}' and status = 'running'`)
      .run(AD_INTERRUPTED, this.now()).changes;
  }

  claimNext(): Claimed | null {
    const tx = this.sql.transaction((): Claimed | null => {
      const row = this.sql
        .prepare(`select id, input from jobs where type = '${AD_COPY_JOB}' and status = 'pending' order by priority, id limit 1`)
        .get() as { id: number; input: string } | undefined;
      if (!row) return null;
      const logPath = path.join(this.opts.logsDir, "jobs", `ad-copy-${row.id}.log`);
      const n = this.sql
        .prepare("update jobs set status = 'running', started_at = ?, attempts = attempts + 1, log_path = ? where id = ? and status = 'pending'")
        .run(this.now(), logPath, row.id).changes;
      if (!n) return null;
      let input: AdCopyJobInput;
      try {
        input = JSON.parse(row.input);
      } catch {
        input = { channel: "", hookId: null, angleKey: null, filled: { headlines: [], primaries: [], description: "" } };
      }
      return { id: row.id, input };
    });
    return tx.immediate();
  }

  private finish(id: number, status: "done" | "error", error: string | null, result: AdCopyJobResult | null) {
    this.sql
      .prepare("update jobs set status = ?, error = ?, result = ?, finished_at = ? where id = ? and status = 'running'")
      .run(status, error, result ? JSON.stringify(result) : null, this.now(), id);
  }

  private async ask(prompt: string, workdir: string, log: (line: string) => void): Promise<{ raw: RawAdDraft; res: ClaudeResult; ms: number }> {
    const bin = resolveClaude();
    if (!bin) throw new ClaudeError("claude CLI not found (~/.local/bin/claude; CLAUDE_BIN overrides).", "cli");
    const args = claudeArgs(prompt);
    log(`run: ${claudeCommandLine(bin, args)}`);
    const timeout = this.opts.timeoutMs ?? CLAUDE_TIMEOUT_MS;
    const run = await runClaude(bin, args, { cwd: workdir, timeoutMs: timeout, signal: this.abort.signal });
    if (run.killed) throw new ClaudeError(AD_INTERRUPTED, "cli");
    if (run.timedOut) throw new ClaudeError(`claude took longer than ${Math.round(timeout / 1000)} s and was stopped.`, "cli");
    log(`claude exited ${run.code ?? "by signal"} after ${(run.ms / 1000).toFixed(1)} s`);
    if (run.stderr.trim()) log(`stderr: ${run.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    const res = parseClaudeJson(run.stdout);
    if (run.code !== 0) throw new ClaudeError(`claude exited ${run.code}: ${res.text.slice(0, 200)}`, "cli");
    return { raw: parseAdDraft(res.text), res, ms: run.ms };
  }

  /** Run one claimed job. Never throws. */
  async runOne(job: Claimed): Promise<"done" | "error" | "interrupted"> {
    const logPath = path.join(this.opts.logsDir, "jobs", `ad-copy-${job.id}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = (line: string) => {
      try {
        fs.appendFileSync(logPath, `${new Date(this.now()).toISOString()} ${line}\n`);
      } catch {
        /* logging never fails a job */
      }
    };
    const workdir = path.join(this.opts.cacheDir, "claude-tmp", `ad-copy-${job.id}`);
    const result: AdCopyJobResult = { attempts: [], draft: null, note: null };
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
      fs.mkdirSync(workdir, { recursive: true });
      const ctx = adCopyContext(this.sql, this.opts.cfg, job.input);
      log(`channel ${ctx.channel.code} · hook ${ctx.hook ? `#${ctx.hook.id}: ${ctx.hook.text}` : "none"} · angle ${ctx.angle ?? "none"}${ctx.block ? " (block found)" : ""}`);
      log(
        `needs ${ctx.need.headlines} headline(s), ${ctx.need.primaries} primary(ies)${ctx.need.p1 ? " + the rest of primary 1 after the hook" : ""}, ${ctx.need.description ? "the description" : "no description"}`,
      );
      const draft: AdDraft = { headlines: [], primaries: [], description: null, concept: null, psObj: null, p1: null };
      let feedback: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = buildAdCopyPrompt(ctx, feedback);
        if (attempt === 1) log(`prompt: ${prompt.length} chars`);
        const { raw, res, ms } = await this.ask(prompt, workdir, log);
        const before = { headlines: draft.headlines.length, primaries: draft.primaries.length + (draft.p1 ? 1 : 0), description: draft.description ? 1 : 0 };
        const dropped = keepDrafted(raw, ctx, draft);
        const a: AdCopyAttempt = {
          returned: { headlines: raw.headlines.length, primaries: raw.primaries.length, description: raw.descriptions.length },
          kept: {
            headlines: draft.headlines.length - before.headlines,
            primaries: draft.primaries.length + (draft.p1 ? 1 : 0) - before.primaries,
            description: (draft.description ? 1 : 0) - before.description,
          },
          dropped,
          ms,
          model: res.model,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          cacheReadTokens: res.cacheReadTokens,
          cacheCreationTokens: res.cacheCreationTokens,
        };
        result.attempts.push(a);
        log(
          `attempt ${attempt}: returned ${a.returned.headlines} headline(s), ${a.returned.primaries} primary(ies), ${a.returned.description} description(s) · model ${res.model ?? "?"} · tokens in ${res.inputTokens ?? "?"} (+cache read ${res.cacheReadTokens ?? 0}, cache write ${res.cacheCreationTokens ?? 0}) out ${res.outputTokens ?? "?"}`,
        );
        for (const d of dropped) log(`  dropped ${d.field}: ${d.text.replace(/\n+/g, " / ").slice(0, 160)}  <- ${d.reason}`);
        if (draftComplete(ctx, draft)) break;
        if (attempt === 1) {
          feedback = [...new Set(dropped.map((d) => `${d.field}: ${d.reason}`))];
          log("not every slot passed the rules: one retry of the whole call");
        }
        if (this.isStopped()) {
          // Stopped between the two attempts: finish the row like the catch path (never left `running`).
          this.finish(job.id, "error", AD_INTERRUPTED, result);
          log(AD_INTERRUPTED);
          return "interrupted";
        }
      }
      for (const h of draft.headlines) log(`  kept headline: ${h}`);
      if (draft.p1) log(`  kept primary 1 (opens with the hook):\n${draft.p1}`);
      draft.primaries.forEach((p, i) => log(`  kept primary ${i + 1}:\n${p}`));
      if (draft.description) log(`  kept description: ${draft.description}`);
      if (draft.concept) log(`  concept ${draft.concept} · ${draft.psObj ?? "?"}`);
      if (!draft.headlines.length && !draft.primaries.length && !draft.p1 && !draft.description) {
        result.note = "No drafted line passed the copy rules (see the log).";
        this.finish(job.id, "error", result.note, result);
        log(result.note);
        return "error";
      }
      result.draft = draft;
      if (!draftComplete(ctx, draft)) result.note = "Some slots stayed empty: their lines broke the copy rules twice (see the log).";
      this.finish(job.id, "done", null, result);
      log(`done${result.note ? `. ${result.note}` : ""}`);
      this.opts.log(`ad copy: job #${job.id} (${ctx.channel.code}) done`);
      return "done";
    } catch (e) {
      const message = ((e as Error).message || "Draft failed").slice(0, 500);
      if (this.isStopped() || message === AD_INTERRUPTED) {
        this.finish(job.id, "error", AD_INTERRUPTED, result.attempts.length ? result : null);
        log(AD_INTERRUPTED);
        return "interrupted";
      }
      log(`error: ${message}`);
      this.opts.log(`ad copy: job #${job.id} error: ${message}`);
      // Only a known terse message reaches the job row (and the browser): never a path or SQL text.
      this.finish(job.id, "error", terseJobError(e, [ClaudeError, AdCopyError], AD_FAILED), result.attempts.length ? result : null);
      return "error";
    } finally {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* cleanup never throws out of runOne (the job row is already finished) */
      }
    }
  }

  /** Read the order files back (staged / failed / missing ones). Never throws. */
  syncOrders(): { read: number; changed: number } {
    try {
      const r = syncOrders(this.sql, this.opts.cfg, this.now());
      if (r.changed) this.opts.log(`ad orders: ${r.changed} status change(s) read back`);
      return r;
    } catch (e) {
      this.opts.log("ad orders: read-back error", (e as Error).message);
      return { read: 0, changed: 0 };
    }
  }

  /** Run every pending job (smoke tests). */
  async drain(): Promise<Record<"done" | "error" | "interrupted", number>> {
    const counts = { done: 0, error: 0, interrupted: 0 };
    for (;;) {
      if (this.isStopped()) return counts;
      const job = this.claimNext();
      if (!job) return counts;
      this.running.set(job.id, job.input.channel);
      counts[await this.runOne(job)]++;
      this.running.delete(job.id);
    }
  }

  start() {
    if (this.loop) return;
    const n = this.recover();
    if (n) this.opts.log(`ad copy: ${n} interrupted job(s) marked for Retry`);
    this.syncOrders();
    this.ordersTimer = setInterval(() => this.syncOrders(), this.opts.ordersMs ?? ORDERS_SYNC_MS);
    const idle = this.opts.idleMs ?? 2_000;
    this.loop = (async () => {
      while (!this.isStopped()) {
        let job: Claimed | null = null;
        try {
          job = this.claimNext();
        } catch (e) {
          this.opts.log("ad copy claim error", (e as Error).message);
        }
        if (!job) {
          await sleep(idle);
          continue;
        }
        this.running.set(job.id, job.input.channel);
        await this.runOne(job);
        this.running.delete(job.id);
      }
    })();
  }

  async stop() {
    this.stopped = true;
    if (this.ordersTimer) clearInterval(this.ordersTimer);
    this.abort.abort();
    if (this.loop) await Promise.race([this.loop, sleep(5_000)]);
  }
}
