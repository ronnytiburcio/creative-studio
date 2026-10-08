/**
 * Run an engine CLI without a shell (argument arrays only) and resolve engine binaries robustly.
 * LaunchAgents start with a minimal PATH, so binaries are resolved to absolute paths up front.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type CliResult = { code: number; stdout: string; stderr: string };

const live = new Set<ChildProcess>();

/** Engine children started in their own process group (Codex): killed as a group. */
const groups = new Set<ChildProcess>();

export function trackGroup(child: ChildProcess) {
  groups.add(child);
  child.once("close", () => groups.delete(child));
}

/** SIGTERM (then SIGKILL after `graceMs`) to a detached child's whole process group. */
export function killGroup(child: ChildProcess, graceMs = 1500) {
  const signal = (sig: NodeJS.Signals) => {
    if (child.pid == null || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };
  signal("SIGTERM");
  if (graceMs > 0) setTimeout(() => signal("SIGKILL"), graceMs).unref();
  else signal("SIGKILL");
}

/** Kill every engine CLI child still running (worker shutdown). */
export function killEngineChildren() {
  for (const child of live) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  live.clear();
  for (const child of groups) killGroup(child, 0);
  groups.clear();
}

export function runCli(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; maxStdout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(opts.env ?? process.env), NO_COLOR: "1" },
    });
    live.add(child);
    let stdout = "";
    let stderr = "";
    const maxOut = opts.maxStdout ?? 4 * 1024 * 1024;
    child.stdout!.on("data", (d: Buffer) => {
      if (stdout.length < maxOut) stdout += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      live.delete(child);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      live.delete(child);
      if (timedOut) return reject(new Error(`${path.basename(cmd)} timed out after ${opts.timeoutMs ?? 60_000} ms`));
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Last non-empty stderr/stdout line, trimmed, for terse error messages. */
export function lastLine(r: CliResult): string {
  const lines = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const err = lines.find((l) => /^error:/i.test(l));
  return (err ?? lines[lines.length - 1] ?? `exit ${r.code}`).slice(0, 300);
}

export type ResolvedBin = { cmd: string; prefix: string[]; env?: NodeJS.ProcessEnv };

/**
 * `STUDIO_ENGINES=off` (process env): no outside engine CLI is ever resolved, so nothing runs Higgsfield, Codex or
 * `claude` (they read accounts and reach paid services). The demo (`npm run demo`) sets it: on a machine where those
 * CLIs are installed for a real install, the demo must not see or use them. Unset / anything else = resolve as usual.
 */
export function enginesOff(env: Record<string, string | undefined> = process.env): boolean {
  return env.STUDIO_ENGINES?.trim().toLowerCase() === "off";
}

function executable(p: string) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Higgsfield ships as an npm wrapper (`bin/higgsfield.js` -> `vendor/hf`, a native binary).
 * Prefer the native binary (no node or PATH needed); fall back to running the JS wrapper with this node.
 */
export function resolveHiggsfield(): ResolvedBin | null {
  if (enginesOff()) return null;
  const candidates = [
    process.env.HIGGSFIELD_BIN,
    path.join(os.homedir(), ".local/bin/higgsfield"),
    "/opt/homebrew/bin/higgsfield",
    "/usr/local/bin/higgsfield",
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (real.endsWith(".js")) {
      const native = path.join(path.dirname(real), "..", "vendor", "hf");
      if (executable(native)) return { cmd: native, prefix: [] };
      return { cmd: process.execPath, prefix: [real] };
    }
    if (executable(real)) return { cmd: real, prefix: [] };
  }
  return null;
}

const CODEX_TRIPLE: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};

/**
 * Codex ships as an npm wrapper too (`bin/codex.js` -> `@openai/codex-<platform>/vendor/<triple>/bin/codex`).
 * The wrapper needs `node` on PATH (`#!/usr/bin/env node`), which the LaunchAgents' PATH lacks, so Studio runs
 * the native binary directly with an explicit environment: a minimal PATH (the vendor `codex-path` dir holds
 * the bundled `rg`), HOME for ~/.codex auth, and the two variables the wrapper would have set.
 * Falls back to running the wrapper with this node. `CODEX_BIN` overrides.
 */
export function resolveCodex(): ResolvedBin | null {
  if (enginesOff()) return null;
  const candidates = [
    process.env.CODEX_BIN,
    path.join(os.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((p): p is string => Boolean(p));
  const basePath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env = (extraPath: string[], pkgRoot?: string): NodeJS.ProcessEnv => ({
    NODE_ENV: "production",
    HOME: os.homedir(),
    USER: os.userInfo().username,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: os.tmpdir(),
    PATH: [...extraPath, ...basePath].join(":"),
    ...(pkgRoot ? { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: pkgRoot } : {}),
  });
  for (const candidate of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (real.endsWith(".js")) {
      const pkgRoot = path.join(path.dirname(real), "..");
      const triple = CODEX_TRIPLE[`${process.platform}-${process.arch}`];
      if (triple) {
        const platformPkg = `codex-${process.platform}-${process.arch}`;
        for (const vendor of [
          path.join(pkgRoot, "node_modules", "@openai", platformPkg, "vendor", triple),
          path.join(pkgRoot, "vendor", triple),
        ]) {
          const native = path.join(vendor, "bin", "codex");
          if (executable(native)) return { cmd: native, prefix: [], env: env([path.join(vendor, "codex-path")], pkgRoot) };
        }
      }
      return { cmd: process.execPath, prefix: [real], env: env([path.dirname(process.execPath)]) };
    }
    if (executable(real)) return { cmd: real, prefix: [], env: env([path.dirname(real)]) };
  }
  return null;
}
