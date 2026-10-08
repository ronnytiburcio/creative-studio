/**
 * ChatGPT image via the Codex CLI (worker only for runs; `codexCapabilities` is also used by the app).
 * Verified behaviour (codex-cli 0.159.1, see docs/DECISIONS.md "Phase 2 slice 2 build choices"):
 *  - `codex exec ... --json` prints JSONL events: thread.started {thread_id}, turn.started, item.started /
 *    item.completed {item: {type: command_execution | agent_message | error, ...}}, turn.completed | turn.failed.
 *    An item of type "error" is not fatal (e.g. "Exceeded skills context budget").
 *  - The built-in image tool writes to ~/.codex/generated_images/<thread_id>/exec-<uuid>.png (no JSON event for it);
 *    the agent then copies it to ./out_1.png in the -C workdir with a shell command. Exit code 0 on success.
 *  - ~50 s per image. `--ignore-user-config` skips the owner's MCP servers and plugins (fewer tokens, no stray
 *    MCP auth errors) while auth still comes from ~/.codex.
 * Success = exit 0 AND a decodable image at ./out_1.png, or (fallback) the newest image in the thread's
 * generated_images folder. Each run is its own process group so Cancel kills the agent and its tools.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import sharp from "sharp";
import { killGroup, resolveCodex, runCli, trackGroup } from "./cli";
import type { AdapterContext, Capabilities, GenAdapter, GenInput, PollResult, PreparedRef } from "./types";

const OUT_NAME = "out_1.png";
const MAX_RUN_MS = 10 * 60_000;

type Run = {
  child: ChildProcess;
  workdir: string;
  threadId: string | null;
  exitCode: number | null;
  done: boolean;
  cancelled: boolean;
  timedOut: boolean;
  failure: string | null;
  lastMessage: string | null;
  stderrTail: string;
  closed: Promise<void>;
};

const ASPECT_WORDS: Record<string, string> = {
  "9:16": "tall portrait",
  "2:3": "portrait",
  "4:5": "portrait",
  "1:1": "square",
  "3:2": "landscape",
  "16:9": "wide landscape",
};

/** The one instruction Codex gets. The prompt is last so nothing the owner types can reorder the rules. */
export function codexInstruction(input: Pick<GenInput, "promptSent" | "effectiveParams">, refCount: number): string {
  const aspect = typeof input.effectiveParams.aspect_ratio === "string" ? input.effectiveParams.aspect_ratio : "9:16";
  return [
    `Generate exactly one image with your built-in image generation tool and save it as ./${OUT_NAME} in the current directory.`,
    "Do nothing else: do not create or change any other file, do not ask questions, do not describe the image.",
    `Aspect ratio ${aspect} (${ASPECT_WORDS[aspect] ?? "portrait"}).`,
    refCount ? `Use the ${refCount === 1 ? "attached image" : `${refCount} attached images`} as visual reference.` : "",
    "",
    "Image prompt:",
    input.promptSent,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

/** Signed in with ChatGPT? Maps `codex login status` to fixed messages (the account itself is never read out). */
export async function codexCapabilities(): Promise<Capabilities> {
  const bin = resolveCodex();
  if (!bin) return { available: false, installed: false, signedIn: false, reason: "Codex CLI not installed (~/.local/bin/codex)" };
  try {
    const r = await runCli(bin.cmd, [...bin.prefix, "login", "status"], { timeoutMs: 20_000, env: bin.env });
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && /chatgpt/i.test(text)) return { available: true, installed: true, signedIn: true, plan: "ChatGPT" };
    if (/api key/i.test(text)) {
      return { available: false, installed: true, signedIn: false, reason: "Codex is signed in with an API key, not ChatGPT (run codex login)" };
    }
    return { available: false, installed: true, signedIn: false, reason: "Codex is not signed in with ChatGPT (run codex login)" };
  } catch {
    return { available: false, installed: true, reason: "Codex CLI did not answer" };
  }
}

async function imageExt(file: string): Promise<string | null> {
  try {
    const meta = await sharp(file).metadata();
    return meta.format === "png" ? "png" : meta.format === "jpeg" ? "jpg" : meta.format === "webp" ? "webp" : null;
  } catch {
    return null;
  }
}

export class CodexAdapter implements GenAdapter {
  readonly id = "codex" as const;
  readonly resumable = false;
  private readonly runs = new Map<string, Run>();

  constructor(private readonly opts: { maxRunMs?: number; generatedImagesDir?: string } = {}) {}

  capabilities(): Promise<Capabilities> {
    return codexCapabilities();
  }

  /** Included in the ChatGPT plan: nothing to quote. */
  async estimate(): Promise<null> {
    return null;
  }

  async start(input: GenInput, references: PreparedRef[], ctx: AdapterContext): Promise<string> {
    const bin = resolveCodex();
    if (!bin) throw new Error("Codex CLI not found");
    const workdir = path.join(ctx.tmpDir, "work");
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.mkdirSync(workdir, { recursive: true });
    const images = references.filter((r) => r.kind === "image");
    const args = [
      ...bin.prefix,
      "exec",
      "-C",
      workdir,
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--json",
      "-o",
      path.join(ctx.tmpDir, "last-message.txt"),
      // The prompt goes before any -i: `-i` takes several values and would swallow it.
      codexInstruction(input, images.length),
      ...images.flatMap((r) => ["-i", r.path]),
    ];
    ctx.log(`codex exec -C <job dir> -s workspace-write --skip-git-repo-check --ephemeral --ignore-user-config --json (+${images.length} references)`);
    // stdin "ignore" = /dev/null. detached = own process group, so Cancel can kill the agent and its tools.
    const child = spawn(bin.cmd, args, { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: bin.env });
    trackGroup(child);
    const run: Run = {
      child,
      workdir,
      threadId: null,
      exitCode: null,
      done: false,
      cancelled: false,
      timedOut: false,
      failure: null,
      lastMessage: null,
      stderrTail: "",
      closed: Promise.resolve(),
    };
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onEvent(run, line, ctx);
      }
    });
    child.stderr!.on("data", (d: Buffer) => {
      run.stderrTail = (run.stderrTail + d.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      run.timedOut = true;
      ctx.log(`codex: no result after ${Math.round((this.opts.maxRunMs ?? MAX_RUN_MS) / 60_000)} min, stopping it`);
      killGroup(child);
    }, this.opts.maxRunMs ?? MAX_RUN_MS);
    run.closed = new Promise<void>((resolve) => {
      child.on("error", (e) => {
        run.failure = `could not start codex (${e.message})`;
        run.done = true;
        clearTimeout(timer);
        resolve();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        run.exitCode = code;
        run.done = true;
        ctx.log(`codex exited ${code ?? "by signal"}`);
        resolve();
      });
    });

    // The thread id arrives within a second or two; it names the run (and the generated_images folder).
    const until = Date.now() + 60_000;
    while (!run.threadId && !run.done && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    if (run.done && !run.threadId && run.failure) throw new Error(run.failure);
    const id = run.threadId ?? `codex-pid-${child.pid}`;
    this.runs.set(id, run);
    return id;
  }

  private onEvent(run: Run, line: string, ctx: AdapterContext) {
    let ev: { type?: string; thread_id?: string; item?: Record<string, unknown>; error?: { message?: string }; message?: string };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const item = ev.item ?? {};
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
      run.threadId = ev.thread_id;
      ctx.log(`codex thread ${ev.thread_id}`);
    } else if (ev.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      run.lastMessage = item.text.slice(0, 600);
      ctx.log(`codex: ${run.lastMessage}`);
    } else if (ev.type === "item.completed" && item.type === "command_execution") {
      ctx.log(`codex ran: ${String(item.command ?? "").slice(0, 300)} (exit ${String(item.exit_code ?? "?")})`);
    } else if (ev.type === "item.completed" && item.type === "error") {
      ctx.log(`codex note: ${String(item.message ?? "").slice(0, 300)}`);
    } else if (ev.type === "turn.failed" || ev.type === "error") {
      run.failure = (ev.error?.message ?? ev.message ?? "Codex reported an error").slice(0, 400);
      ctx.log(`codex error: ${run.failure}`);
    } else if (ev.type === "turn.completed") {
      ctx.log("codex turn completed");
    }
  }

  async poll(externalId: string): Promise<PollResult> {
    const run = this.runs.get(externalId);
    if (!run) return { state: "failed", status: "lost", reason: "Codex run is gone (the worker restarted). Retry runs it again." };
    if (!run.done) return { state: "running", status: "generating" };
    if (run.cancelled) return { state: "failed", status: "cancelled", reason: "Cancelled" };
    if (run.timedOut) return { state: "failed", status: "timeout", reason: "Codex took longer than 10 minutes and was stopped." };
    if (run.exitCode === 0) return { state: "done", status: "completed" };
    const tail = run.stderrTail.trim().split("\n").filter((l) => !/rmcp::|WARN|INFO/.test(l)).pop();
    return { state: "failed", status: `exit ${run.exitCode}`, reason: run.failure ?? tail?.slice(0, 300) ?? `Codex exited ${run.exitCode}` };
  }

  async collect(externalId: string, ctx: AdapterContext): Promise<string[]> {
    const run = this.runs.get(externalId);
    this.runs.delete(externalId);
    const candidates: string[] = [];
    if (run) candidates.push(path.join(run.workdir, OUT_NAME));
    // Fallback: the tool's own copy, in case the agent could not copy it into the workdir.
    const threadId = run?.threadId ?? (externalId.startsWith("codex-pid-") ? null : externalId);
    if (threadId && /^[0-9a-f-]{8,64}$/i.test(threadId)) {
      const dir = path.join(this.opts.generatedImagesDir ?? path.join(os.homedir(), ".codex", "generated_images"), threadId);
      try {
        const newest = fs
          .readdirSync(dir)
          .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
          .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)[0];
        if (newest) candidates.push(newest.f);
      } catch {
        /* no folder: the tool never ran */
      }
    }
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const ext = await imageExt(file);
      if (!ext) {
        ctx.log(`codex: ${path.basename(file)} is not an image`);
        continue;
      }
      const out = path.join(ctx.tmpDir, `1.${ext}`);
      fs.copyFileSync(file, out);
      if (file !== candidates[0]) ctx.log(`codex: took the image from ~/.codex/generated_images/${threadId}`);
      return [out];
    }
    throw new Error(`Codex finished without an image${run?.lastMessage ? `: ${run.lastMessage}` : "."}`);
  }

  async cancel(externalId: string, ctx: AdapterContext): Promise<void> {
    const run = this.runs.get(externalId);
    if (!run) return;
    run.cancelled = true;
    if (!run.done) {
      ctx.log("codex: cancelling (killing its process group)");
      killGroup(run.child);
      await Promise.race([run.closed, new Promise((r) => setTimeout(r, 5000))]);
    }
    this.runs.delete(externalId);
  }
}
