/**
 * Rewrite variants queue (worker only, Phase 4 E1 to E5): runs `hook_variants` job rows one at a time with the real
 * `claude` CLI (src/lib/hooks/claude.ts: argument array, minimal env, no tools, no MCP, no settings, own process
 * group, timeout). Never the Anthropic API.
 *
 * Per job: build the prompt (src/lib/hooks/variants.ts) -> claude -p -> parse {variants: [{text, mechanic}]} -> check
 * every variant against the copy rules in code (src/lib/hooks/variant-rules.ts; failures are dropped and logged), then
 * against the mechanics already kept (E2: five DIFFERENT mechanics; a repeat is dropped with rule `mechanic`) ->
 * fewer than 3 survivors = one retry of the whole call (told which rules the first answer broke; survivors of both
 * answers are kept, up to 5) -> insert the survivors as undecided `variant` hooks, requested for scoring at once ->
 * job done (or done with a note when fewer than 3 survived; error when none did). A timeout, a CLI error or an answer
 * that is not JSON is a job error (Retry runs it again). Log: logs/jobs/hook-variants-<id>.log.
 *
 * Nothing is written to the DB until claude answered, so a restart only has to turn a `running` row into an error.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  ClaudeError,
  claudeArgs,
  claudeCommandLine,
  CLAUDE_TIMEOUT_MS,
  parseClaudeJson,
  resolveClaude,
  runClaude,
  type ClaudeResult,
} from "../lib/hooks/claude";
import {
  buildVariantPrompt,
  insertVariants,
  parseVariants,
  VARIANT_COUNT,
  VARIANT_JOB,
  VARIANT_MIN_SURVIVORS,
  variantContext,
  type RawVariant,
  type VariantAttempt,
  type VariantJobInput,
  type VariantJobResult,
} from "../lib/hooks/variants";
import { checkVariant, compileVariantRules, MECHANIC_CLASH } from "../lib/hooks/variant-rules";
import { normHook } from "../lib/hooks/rubric";

export type HookVariantQueueOptions = {
  cacheDir: string;
  logsDir: string;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  timeoutMs?: number;
  idleMs?: number;
  now?: () => number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const INTERRUPTED = "Interrupted (Studio's worker restarted). Retry runs it again.";

type Claimed = { id: number; input: VariantJobInput };

export class HookVariantQueue {
  /** Job id -> the hook id it rewrites (what is running; drain / start keep it). */
  readonly running = new Map<number, number>();
  private stopped = false;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: HookVariantQueueOptions,
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private isStopped() {
    return this.stopped || this.opts.isStopped();
  }

  /** A `running` row after a restart never finished (nothing was written): an error the owner can Retry. */
  recover(): number {
    return this.sql
      .prepare(`update jobs set status = 'error', error = ?, finished_at = ? where type = '${VARIANT_JOB}' and status = 'running'`)
      .run(INTERRUPTED, this.now()).changes;
  }

  /** Oldest pending job, flipped to running in one IMMEDIATE transaction (a Cancel that lands first wins). */
  claimNext(): Claimed | null {
    const tx = this.sql.transaction((): Claimed | null => {
      const row = this.sql
        .prepare(`select id, input from jobs where type = '${VARIANT_JOB}' and status = 'pending' order by priority, id limit 1`)
        .get() as { id: number; input: string } | undefined;
      if (!row) return null;
      const logPath = path.join(this.opts.logsDir, "jobs", `hook-variants-${row.id}.log`);
      const n = this.sql
        .prepare("update jobs set status = 'running', started_at = ?, attempts = attempts + 1, log_path = ? where id = ? and status = 'pending'")
        .run(this.now(), logPath, row.id).changes;
      if (!n) return null;
      let input: VariantJobInput;
      try {
        input = JSON.parse(row.input);
      } catch {
        input = { hookId: 0, steer: null };
      }
      return { id: row.id, input };
    });
    return tx.immediate();
  }

  private finish(id: number, status: "done" | "error", error: string | null, result: VariantJobResult | null) {
    this.sql
      .prepare("update jobs set status = ?, error = ?, result = ?, finished_at = ? where id = ? and status = 'running'")
      .run(status, error, result ? JSON.stringify(result) : null, this.now(), id);
  }

  /** One claude run: prompt -> parsed variants + usage. Throws on timeout / CLI error / bad output. */
  private async ask(prompt: string, mechIds: string[], workdir: string, log: (line: string) => void): Promise<{ variants: RawVariant[]; res: ClaudeResult; ms: number }> {
    const bin = resolveClaude();
    if (!bin) throw new ClaudeError("claude CLI not found (~/.local/bin/claude; CLAUDE_BIN overrides).", "cli");
    const args = claudeArgs(prompt);
    log(`run: ${claudeCommandLine(bin, args)}`);
    const run = await runClaude(bin, args, { cwd: workdir, timeoutMs: this.opts.timeoutMs ?? CLAUDE_TIMEOUT_MS, signal: this.abort.signal });
    if (run.killed) throw new ClaudeError(INTERRUPTED, "cli");
    if (run.timedOut) throw new ClaudeError(`claude took longer than ${Math.round((this.opts.timeoutMs ?? CLAUDE_TIMEOUT_MS) / 1000)} s and was stopped.`, "cli");
    log(`claude exited ${run.code ?? "by signal"} after ${(run.ms / 1000).toFixed(1)} s`);
    if (run.stderr.trim()) log(`stderr: ${run.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    const res = parseClaudeJson(run.stdout);
    if (run.code !== 0) throw new ClaudeError(`claude exited ${run.code}: ${res.text.slice(0, 200)}`, "cli");
    return { variants: parseVariants(res.text, mechIds), res, ms: run.ms };
  }

  /** Run one claimed job. Never throws. */
  async runOne(job: Claimed): Promise<"done" | "error" | "interrupted"> {
    const logPath = path.join(this.opts.logsDir, "jobs", `hook-variants-${job.id}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = (line: string) => {
      try {
        fs.appendFileSync(logPath, `${new Date(this.now()).toISOString()} ${line}\n`);
      } catch {
        /* logging never fails a job */
      }
    };
    const workdir = path.join(this.opts.cacheDir, "claude-tmp", `variants-${job.id}`);
    const result: VariantJobResult = { attempts: [], survivors: [], note: null };
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
      fs.mkdirSync(workdir, { recursive: true });
      const ctx = variantContext(this.sql, job.input.hookId);
      const mechIds = ctx.mechanics.map((m) => m.id);
      log(`hook #${ctx.hook.id} (${ctx.channelLabel}, ${ctx.hook.kind}): ${ctx.hook.text}`);
      if (job.input.steer) log(`steer: ${job.input.steer}`);
      const rules = compileVariantRules(ctx.rules);
      const accepted = new Set<string>();
      const kept: RawVariant[] = [];
      let feedback: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = buildVariantPrompt(ctx, job.input.steer, feedback);
        if (attempt === 1) log(`prompt: ${prompt.length} chars`);
        // An unknown mechanic id is kept as null (shown as "?"); only the copy rules drop a variant.
        const { variants, res, ms } = await this.ask(prompt, mechIds, workdir, log);
        const a: VariantAttempt = {
          returned: variants.length,
          kept: 0,
          dropped: [],
          ms,
          model: res.model,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          cacheReadTokens: res.cacheReadTokens,
          cacheCreationTokens: res.cacheCreationTokens,
        };
        log(
          `attempt ${attempt}: ${variants.length} returned · model ${res.model ?? "?"}${res.models.length > 1 ? ` (also listed: ${res.models.slice(1).join(", ")})` : ""} · tokens in ${res.inputTokens ?? "?"} (+cache read ${res.cacheReadTokens ?? 0}, cache write ${res.cacheCreationTokens ?? 0}) out ${res.outputTokens ?? "?"}`,
        );
        const broke = new Set<string>();
        for (const v of variants) {
          if (kept.length >= VARIANT_COUNT) break;
          let verdict = checkVariant(v.text, rules, accepted);
          // Copy rules first, then E2: a mechanic a kept survivor already uses is a drop like any other (an unknown
          // mechanic, null, never clashes). Its text leaves the batch's dedupe set so a retry may still use it.
          if (verdict.ok && v.mechanic != null && kept.some((k) => k.mechanic === v.mechanic)) {
            accepted.delete(normHook(v.text));
            verdict = { ok: false, rule: "mechanic", detail: MECHANIC_CLASH };
          }
          if (verdict.ok) {
            kept.push(v);
            a.kept++;
            log(`  kept    [${v.mechanic ?? "?"}] ${v.text}`);
          } else {
            a.dropped.push({ text: v.text, mechanic: v.mechanic, rule: verdict.rule, detail: verdict.detail });
            broke.add(verdict.detail);
            log(`  dropped [${v.mechanic ?? "?"}] ${v.text}  <- ${verdict.detail}`);
          }
        }
        result.attempts.push(a);
        if (kept.length >= VARIANT_MIN_SURVIVORS) break;
        if (attempt === 1) {
          const taken = [...new Set(kept.map((k) => k.mechanic).filter((m): m is string => m != null))];
          feedback = [...broke, ...(taken.length ? [`Kept variants already use these mechanics, so pick others: ${taken.join(", ")}`] : [])];
          log(`only ${kept.length} passed the rules: one retry of the whole call`);
        }
        if (this.isStopped()) return "interrupted";
      }
      if (!kept.length) {
        result.note = "No variant passed the copy rules (see the log).";
        this.finish(job.id, "error", result.note, result);
        log(result.note);
        return "error";
      }
      result.survivors = insertVariants(this.sql, ctx, job.id, kept, this.now());
      if (kept.length < VARIANT_MIN_SURVIVORS) result.note = `Only ${kept.length} variant${kept.length === 1 ? "" : "s"} passed the copy rules after one retry.`;
      this.finish(job.id, "done", null, result);
      log(`done: ${kept.length} variant${kept.length === 1 ? "" : "s"} saved (#${result.survivors.join(", #")}), queued for scoring${result.note ? `. ${result.note}` : ""}`);
      this.opts.log(`variants: job #${job.id} hook #${ctx.hook.id}: ${kept.length} saved`);
      return "done";
    } catch (e) {
      const message = ((e as Error).message || "Rewrite failed").slice(0, 500);
      if (this.isStopped() || message === INTERRUPTED) {
        this.finish(job.id, "error", INTERRUPTED, result.attempts.length ? result : null);
        log(INTERRUPTED);
        return "interrupted";
      }
      log(`error: ${message}`);
      this.opts.log(`variants: job #${job.id} error: ${message}`);
      this.finish(job.id, "error", message, result.attempts.length ? result : null);
      return "error";
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }

  /** Run every pending job (smoke tests). */
  async drain(): Promise<Record<"done" | "error" | "interrupted", number>> {
    const counts = { done: 0, error: 0, interrupted: 0 };
    for (;;) {
      if (this.isStopped()) return counts;
      const job = this.claimNext();
      if (!job) return counts;
      this.running.set(job.id, job.input.hookId);
      counts[await this.runOne(job)]++;
      this.running.delete(job.id);
    }
  }

  start() {
    if (this.loop) return;
    const n = this.recover();
    if (n) this.opts.log(`variants: ${n} interrupted job(s) marked for Retry`);
    const idle = this.opts.idleMs ?? 2_000;
    this.loop = (async () => {
      while (!this.isStopped()) {
        let job: Claimed | null = null;
        try {
          job = this.claimNext();
        } catch (e) {
          this.opts.log("variants claim error", (e as Error).message);
        }
        if (!job) {
          await sleep(idle);
          continue;
        }
        this.running.set(job.id, job.input.hookId);
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
  }
}
