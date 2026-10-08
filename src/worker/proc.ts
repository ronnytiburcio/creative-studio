import { spawn, type ChildProcess } from "node:child_process";

// FFMPEG_PATH / FFPROBE_PATH (empty = unset): the process environment, which the worker fills from the env file before
// this module loads (src/worker/tool-env.ts, its first import), else Homebrew's.
export const FFMPEG = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "/opt/homebrew/bin/ffprobe";

const live = new Set<ChildProcess>();

/** Kill every child we started (used on shutdown). */
export function killAllChildren() {
  for (const c of live) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  live.clear();
}

export type RunResult = { code: number; stdout: string; stderr: string };

/** Run a command without a shell. Collects stdout, keeps the stderr tail. */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxStdout?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    live.add(child);
    let stdout = "";
    let stderr = "";
    const maxOut = opts.maxStdout ?? 8 * 1024 * 1024;
    child.stdout!.on("data", (d: Buffer) => {
      if (stdout.length < maxOut) stdout += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      live.delete(child);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      live.delete(child);
      if (timedOut) return reject(new Error(`${cmd} timed out after ${opts.timeoutMs} ms`));
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
