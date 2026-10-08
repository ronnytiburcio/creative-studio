/**
 * `claude -p` for hook variants (Phase 4 E1) and Shorts moments (Phase 6 B1); worker only for runs. Never the Anthropic API and never an API key: the
 * Claude Code CLI runs on the owner's subscription login (~/.claude + the macOS keychain).
 *
 * Verified on claude 2.1.226 (DECISIONS "Phase 4 slice 3 build choices"): with the flags below its init event lists
 * tools [], mcp_servers [], skills [], plugins [] and apiKeySource "none".
 *   -p --output-format json            non-interactive, one JSON result on stdout
 *   --tools ""                         no built-in tools at all
 *   --strict-mcp-config --mcp-config {"mcpServers":{}}   no MCP servers (the owner's are ignored)
 *   --setting-sources ""               no user / project / local settings
 *   --safe-mode                        no CLAUDE.md, skills, plugins, hooks, custom agents
 *   --no-session-persistence           nothing saved to ~/.claude/projects
 *   --disable-slash-commands           no skills
 *   --system-prompt <ours>             replaces the Claude Code system prompt (small prompt, JSON only)
 * Never --dangerously-skip-permissions (a shell alias may add it; the worker runs the binary directly).
 *
 * The binary: ~/.local/bin/claude is a symlink to ~/.local/share/claude/versions/<version>; it is resolved at run time
 * (an update moves it). `CLAUDE_BIN` overrides (the smoke test points it at a stub script). Run with an argument array
 * (never a shell), a minimal explicit env (HOME, USER, LOGNAME, LANG, TMPDIR, NODE_ENV, PATH=/usr/bin:/bin:/usr/sbin:/sbin;
 * no ANTHROPIC_* or any key), cwd = a temp dir under STUDIO_CACHE, stdin /dev/null, its own process group, a timeout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { enginesOff, killGroup, trackGroup } from "../gen/cli";

export const CLAUDE_TIMEOUT_MS = 3 * 60_000;

export const CLAUDE_SYSTEM_PROMPT =
  "You are a direct response copywriter. Follow the rules in the user's message exactly. Reply with one JSON object only: no prose, no code fences.";

function executable(p: string) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export type ClaudeBin = { cmd: string; prefix: string[] };

/** The real claude binary (symlinks resolved now, not at install time), or null. */
export function resolveClaude(): ClaudeBin | null {
  if (enginesOff()) return null; // STUDIO_ENGINES=off (the demo): never the installed CLI
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    // An npm install is a JS entry point that needs node: run it with this node (not `env node`, the PATH is minimal).
    if (real.endsWith(".js") || real.endsWith(".mjs")) return { cmd: process.execPath, prefix: [real] };
    if (executable(real)) return { cmd: real, prefix: [] };
  }
  return null;
}

/** The whole environment the CLI gets: enough for the keychain login, nothing else (no API key can leak in). */
export function claudeEnv(): NodeJS.ProcessEnv {
  const user = os.userInfo().username;
  return {
    NODE_ENV: "production",
    HOME: os.homedir(),
    USER: user,
    LOGNAME: user,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: os.tmpdir(),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

/**
 * Argument array for one non-interactive run (the prompt is the last argument; stdin stays /dev/null). `systemPrompt`
 * replaces the copywriter one for another task (Phase 6 moments); every other flag is fixed.
 */
export function claudeArgs(prompt: string, systemPrompt: string = CLAUDE_SYSTEM_PROMPT): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--safe-mode",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--system-prompt",
    systemPrompt,
    prompt,
  ];
}

/** The command line for logs: flags as run, the prompt elided. */
export function claudeCommandLine(bin: ClaudeBin, args: string[]): string {
  const shown = args.slice(0, -1).map((a) => (a === "" ? '""' : /[\s{}"]/.test(a) ? `'${a}'` : a));
  return [bin.cmd, ...bin.prefix, ...shown, `<prompt, ${args.at(-1)?.length ?? 0} chars>`].join(" ");
}

export type ClaudeRun = { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean; killed: boolean };

/** Run once. Never throws for a non-zero exit; throws only when the binary cannot start. */
export function runClaude(
  bin: ClaudeBin,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ClaudeRun> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin.cmd, [...bin.prefix, ...args], {
      cwd: opts.cwd,
      detached: true, // own process group: a timeout or shutdown kills the CLI and anything it started
      stdio: ["ignore", "pipe", "pipe"],
      env: claudeEnv(),
    });
    trackGroup(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    let timedOut = false;
    let killed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, opts.timeoutMs ?? CLAUDE_TIMEOUT_MS);
    const onAbort = () => {
      killed = true;
      killGroup(child, 500);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut, killed });
    });
  });
}

export type ClaudeResult = {
  text: string;
  /** The model that wrote the answer (most output tokens in modelUsage). */
  model: string | null;
  /** Every model modelUsage listed. */
  models: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** What the CLI reports (notional on a subscription; nothing is billed per run). */
  costUsd: number | null;
  durationMs: number | null;
};

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "output" | "cli",
  ) {
    super(message);
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** stdout of `--output-format json` -> the reply text + usage. Throws ClaudeError (auth, bad output, CLI error). */
export function parseClaudeJson(stdout: string): ClaudeResult {
  const trimmed = stdout.trim();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(trimmed);
  } catch {
    // Some versions print a stray line first: take the last line that parses.
    for (const line of trimmed.split("\n").reverse()) {
      try {
        body = JSON.parse(line);
        break;
      } catch {
        /* next */
      }
    }
  }
  if (!body || typeof body !== "object") throw new ClaudeError("claude printed no JSON result", "output");
  const text = typeof body.result === "string" ? body.result : "";
  if (body.is_error === true) {
    if (/authenticat|oauth|log ?in|not logged/i.test(text)) {
      throw new ClaudeError("claude is not signed in on this Mac: Settings > Claude > Sign in (or run `claude auth login` in Terminal), then Retry.", "auth");
    }
    throw new ClaudeError(`claude reported an error: ${text.slice(0, 300) || "no message"}`, "cli");
  }
  const usage = (body.usage ?? {}) as Record<string, unknown>;
  // modelUsage can list a small helper model next to the one that wrote the answer: the writer has the most output.
  const models = Object.entries(body.modelUsage && typeof body.modelUsage === "object" ? (body.modelUsage as Record<string, Record<string, unknown>>) : {})
    .map(([id, u]) => ({ id, outputTokens: num(u?.outputTokens) ?? 0 }))
    .sort((a, b) => b.outputTokens - a.outputTokens);
  return {
    text,
    model: models[0]?.id ?? null,
    models: models.map((m) => m.id),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    costUsd: num(body.total_cost_usd),
    durationMs: num(body.duration_ms),
  };
}

// ------------------------------------------------------------- sign-in state (Settings > Claude)

export type ClaudeAuth = {
  /** The binary was found. */
  installed: boolean;
  /** `claude auth status` said loggedIn (null = could not tell). */
  signedIn: boolean | null;
  /** Its authMethod word ("claude.ai", "none", ...); never the account, email or org. */
  method: string | null;
};

/**
 * `claude auth status --json` with the same minimal env as a run: a free local read (no model call, ~0.2 s). Only
 * loggedIn + authMethod are kept; anything else it prints (account details) is dropped here.
 */
export function claudeAuthStatus(timeoutMs = 10_000): Promise<ClaudeAuth> {
  const bin = resolveClaude();
  if (!bin) return Promise.resolve({ installed: false, signedIn: null, method: null });
  return new Promise((resolve) => {
    execFile(
      bin.cmd,
      [...bin.prefix, "auth", "status", "--json"],
      { env: claudeEnv(), cwd: os.homedir(), timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (_err, stdout) => {
        // Signed out exits 1 with the same JSON on stdout, so the exit code is not the answer.
        try {
          const body = JSON.parse(String(stdout).trim()) as Record<string, unknown>;
          const method = typeof body.authMethod === "string" && /^[a-z0-9._-]{1,32}$/i.test(body.authMethod) ? body.authMethod : null;
          resolve({ installed: true, signedIn: typeof body.loggedIn === "boolean" ? body.loggedIn : null, method });
        } catch {
          resolve({ installed: true, signedIn: null, method: null });
        }
      },
    );
  });
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Sign in (Settings > Claude): opens a Terminal window running `claude auth login --claudeai` (the subscription login;
 * the browser part is the owner's). Studio never completes the login itself and never sees a token: the CLI stores it in
 * the macOS keychain, where the worker's runs pick it up. The one file written is a small .command script in
 * STUDIO_CACHE (0700, rewritten each time), opened with /usr/bin/open (argument array, no shell).
 */
export async function openClaudeLogin(cacheDir: string): Promise<void> {
  const bin = resolveClaude();
  if (!bin) throw new ClaudeError("The claude CLI was not found on this Mac.", "cli");
  const dir = path.join(cacheDir, "claude-login");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "Sign in to Claude.command");
  const cmd = [bin.cmd, ...bin.prefix].map(shellQuote).join(" ");
  const script = [
    "#!/bin/zsh",
    "echo 'Studio: signing the claude CLI in to your Claude subscription.'",
    "echo",
    `${cmd} auth login --claudeai`,
    "echo",
    `${cmd} auth status --text`,
    "echo",
    "echo 'Done: go back to Studio (Settings > Claude updates by itself). You can close this window.'",
    "",
  ].join("\n");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, script, { mode: 0o700 });
  fs.renameSync(tmp, file);
  await new Promise<void>((resolve, reject) =>
    execFile("/usr/bin/open", ["-a", "Terminal", file], (err) => (err ? reject(err) : resolve())),
  );
}
