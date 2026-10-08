/**
 * The demo's environment (`npm run demo`, scripts/demo.ts). Pure: no config module is imported here, so the smoke can
 * build it and hand it to loadConfig() with a temp home and repo.
 *
 * Isolation rule: EVERY config key is forced through the process environment (the top layer of config.ts), so the
 * demo never falls back to an install's env file, its Studio config, its identity file or its default folders:
 *  - STUDIO_IDENTITY=neutral: `private/identity.env` is never read (src/lib/config.ts identityFileIgnored).
 *  - STUDIO_ENV_FILE = demo/.env (no keys), STUDIO_CONFIG = demo/studio.config.json (the made-up brand).
 *  - DB / cache / logs / hand-offs under the throwaway data folder (`.demo-data/` by default, gitignored).
 *  - STUDIO_DRIVE = demo/media in folder mode; port 4750 (never 4747 / 4748, the real app's and its test port).
 *  - Every outside file (Meta / GHL env files, the YouTube client + token, the client docs, the reel kit, the shared ads
 *    registry) points at a path inside the data folder that does not exist; whisper and Ollama at nothing.
 *  - STUDIO_ENGINES=off: Higgsfield, Codex and claude are never resolved (src/lib/gen/cli.ts enginesOff); their *_BIN
 *    keys are empty. FFMPEG_PATH / FFPROBE_PATH are the caller's own process values (a shell setting, never an env file:
 *    the demo needs ffmpeg), else empty (Homebrew's).
 *  - STUDIO_DIST_DIR = .demo-data/next: the demo's own build (next.config.ts distDir), never the repo's `.next/`.
 *  - STUDIO_BRAND_DIR = "" (the built-in generic marks: empty counts as unset, and the layers below it are the demo's).
 *  - The two order folders (they may never sit inside a git working tree) are under the OS temp folder and are only
 *    created if someone stages an ad in the demo.
 * Inherited STUDIO_* / META_* / YOUTUBE_* / engine variables are dropped first (`demoChildEnv`).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEMO_PORT = 4750;
/** The real app's port and its test port: the demo never binds them. */
export const REFUSED_PORTS = [4747, 4748] as const;
/** An address nothing listens on (loopback, the discard port): Describe sees "Ollama not reachable". */
export const DEMO_OLLAMA_URL = "http://127.0.0.1:9";

/** Why a port cannot be the demo's, or null. */
export function demoPortProblem(port: number): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return "must be a whole number from 1024 to 65535";
  if ((REFUSED_PORTS as readonly number[]).includes(port)) return `${port} belongs to a real install (the demo never uses ${REFUSED_PORTS.join(" or ")})`;
  return null;
}

/** The demo's data folder for a repo (gitignored). */
export const demoDataDir = (repoDir: string) => path.join(repoDir, ".demo-data");
/** The demo's own build folder (next.config.ts `distDir`, relative to the repo; tsconfig.json "include" lists its types). */
export const DEMO_DIST_DIR = ".demo-data/next";
/** Written into a data folder the demo made; --reset deletes, and --data reuses, only a folder that carries it. */
export const DEMO_MARKER = "DEMO-DATA";

/** The real path of `p`, or of its nearest existing ancestor joined with the rest (symlinked folders resolved). */
function realish(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

/**
 * Why a folder cannot be the demo's data folder, or null. `protect` = an install's folders (its data and settings
 * folders, the neutral ones, any DB / cache / logs folder its environment names): the data folder may not be one of them,
 * inside one, or hold one. Inside the repo only `.demo-data` is allowed. An existing folder must be empty or carry the
 * demo's marker (so --reset and the seed never touch someone else's files).
 */
export function demoDataProblem(dir: string, o: { repoDir: string; protect: string[] }): string | null {
  const d = realish(dir);
  const repo = realish(o.repoDir);
  const own = realish(demoDataDir(o.repoDir));
  if (within(d, repo) && d !== own) return "is inside the repo (only .demo-data is allowed there)";
  if (within(repo, d)) return "holds the repo";
  for (const raw of o.protect) {
    const p = realish(raw);
    if (within(d, p) || within(p, d)) return `is, holds or is inside an install's folder (${raw})`;
  }
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(d);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return "is not a folder";
  if (fs.readdirSync(d).length && !fs.existsSync(path.join(d, DEMO_MARKER))) return `is not empty and was not made by the demo (no ${DEMO_MARKER} file)`;
  return null;
}

/** Variables an inherited environment may carry that the demo must not see (they would point at a real install). */
const DROP_PREFIXES = ["STUDIO_", "META_", "YOUTUBE_", "GHL_", "TYPESAFE_"];
const DROP_KEYS = ["HIGGSFIELD_BIN", "CODEX_BIN", "CLAUDE_BIN"];

export function demoEnv(o: { repoDir: string; dataDir: string; port: number; tmpDir?: string; ffmpegPath?: string; ffprobePath?: string }): Record<string, string> {
  const { repoDir, dataDir } = o;
  const d = (...p: string[]) => path.join(dataDir, ...p);
  // The order folders must not sit inside a git working tree (config.ts pendingDirProblem): one folder per repo under
  // the OS temp folder, created only if someone stages an ad in the demo.
  const tag = crypto.createHash("sha256").update(path.resolve(repoDir)).digest("hex").slice(0, 10);
  const orders = path.join(o.tmpDir ?? os.tmpdir(), `creative-studio-demo-${tag}`);
  return {
    STUDIO_IDENTITY: "neutral",
    STUDIO_ENV_FILE: path.join(repoDir, "demo", ".env"),
    STUDIO_CONFIG: path.join(repoDir, "demo", "studio.config.json"),
    STUDIO_DB: d("studio.db"),
    STUDIO_CACHE: d("cache"),
    STUDIO_LOGS: d("logs"),
    STUDIO_HANDOFFS: d("handoffs"),
    STUDIO_PORT: String(o.port),
    STUDIO_DRIVE: path.join(repoDir, "demo", "media"),
    STUDIO_DRIVE_MODE: "folder",
    STUDIO_FAKE_UNMOUNTED: "0",
    META_ENV_FILE: d("no-meta.env"),
    META_FKB_ENV_FILE: d("no-meta-company.env"),
    META_UNIVERSAL_REGISTRY: d("no-shared-ads.json"),
    STUDIO_VISION_MODEL: "qwen3-vl:8b-instruct",
    STUDIO_OLLAMA_URL: DEMO_OLLAMA_URL,
    STUDIO_WHISPER_BIN: d("no-whisper", "whisper-cli"),
    STUDIO_WHISPER_MODEL: d("no-whisper", "model.bin"),
    STUDIO_JEV_MODEL: "jev-1.13.0",
    STUDIO_CLIENT_DOCS_DIR: d("client-docs"),
    YOUTUBE_CLIENT_SECRET_FILE: d("no-youtube-client.json"),
    YOUTUBE_TOKEN_FILE: d("youtube-token.json"),
    STUDIO_REEL_KIT_DIR: d("reel-kit"),
    META_PENDING_DIR: path.join(orders, "pending-clients"),
    META_FKB_PENDING_DIR: path.join(orders, "pending-company"),
    STUDIO_BRAND_DIR: "",
    FFMPEG_PATH: o.ffmpegPath ?? "",
    FFPROBE_PATH: o.ffprobePath ?? "",
    HIGGSFIELD_BIN: "",
    CODEX_BIN: "",
    CLAUDE_BIN: "",
    STUDIO_ENGINES: "off",
    STUDIO_DIST_DIR: DEMO_DIST_DIR,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/** The environment for the demo's child processes: the inherited one minus anything that could name a real install. */
export function demoChildEnv(inherited: Record<string, string | undefined>, demo: Record<string, string>): NodeJS.ProcessEnv {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(inherited)) {
    if (DROP_KEYS.includes(k) || DROP_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return { ...out, ...demo } as NodeJS.ProcessEnv;
}
