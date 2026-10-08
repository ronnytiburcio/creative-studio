/**
 * Config for Studio (shared by the Next server, the worker, scripts).
 *
 * Precedence: process.env > the env file (STUDIO_ENV_FILE, else <settings dir>/.env) > defaults.
 * Secrets in the env file are never loaded into process.env and never returned:
 * callers only get presence booleans via keyStatus().
 *
 * Precedence in full: process.env > the env file > the Studio config file's `env` section (STUDIO_CONFIG; for an install
 * that keeps its own defaults in its config) > the neutral defaults below.
 *
 * Install identity (resolveIdentity, the ONE rule; scripts/studio-identity.sh mirrors it for the installer and the
 * launcher, and the smoke checks they agree): neutral defaults (~/.studio, ~/Studio-Data, LaunchAgents com.studio.*,
 * "Creative Studio"), or, when the repo carries `private/identity.env`, that install's own names and folders (they
 * live only in that file) so nothing has to move. `STUDIO_IDENTITY=neutral` ignores the file (the demo).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DRIVE_MODES, driveWords, type DriveMode } from "./drive-mode";
import { parseEnvText } from "./envfile";
import { onDrive, realishPath } from "./privatefile";
import { EMPTY_STUDIO, parseStudioText, StudioConfigError, type StudioFile } from "./studio-config";
import { z } from "zod";

export { driveWords, type DriveMode } from "./drive-mode";

const HOME = os.homedir();

export function expandHome(p: string, home = HOME): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export type StudioIdentity = {
  /** true = the repo carries an identity file (private/identity.env): that install's own names and folders. */
  legacy: boolean;
  /** Short machine name: the Meta / GHL User-Agent and the order lock owner (both seen outside Studio). */
  slug: string;
  /** App display name (page titles, the desktop app, messages). */
  appName: string;
  /** Holds the env file and Studio's YouTube token. */
  settingsDir: string;
  /** Default parent of the DB, cache, logs and Cut reel hand-offs. */
  dataDir: string;
  /** STUDIO_ENV_FILE when set, else <settingsDir>/.env. */
  envFile: string;
  launchdLabels: { web: string; worker: string };
};

/** The neutral identity: every install's names and folders unless the repo carries an identity file. */
export const NEUTRAL_ID = { settings: ".studio", data: "Studio-Data", labelPrefix: "com.studio", appName: "Creative Studio", slug: "creative-studio" };
export type IdentityValues = typeof NEUTRAL_ID;

/**
 * The optional identity file, `<repo>/private/identity.env` (never exported): an install that already runs under other
 * names (the original install, decision 8) keeps its settings / data folders, LaunchAgent labels, app name and slug
 * without them appearing in code. KEY=VALUE lines (parseEnvText rules); each value is checked and a bad or missing one
 * keeps the neutral value. scripts/studio-identity.sh reads the same file with the same rules (the smoke compares them).
 */
export const IDENTITY_FILE = path.join("private", "identity.env");
const FOLDER_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const IDENTITY_KEYS: Record<keyof IdentityValues, { key: string; re: RegExp }> = {
  settings: { key: "STUDIO_ID_SETTINGS", re: FOLDER_NAME },
  data: { key: "STUDIO_ID_DATA", re: FOLDER_NAME },
  labelPrefix: { key: "STUDIO_ID_LABEL_PREFIX", re: /^[A-Za-z0-9-]{1,40}(\.[A-Za-z0-9-]{1,40}){1,5}$/ },
  appName: { key: "STUDIO_ID_APP_NAME", re: /^[A-Za-z0-9 ._-]{1,60}$/ },
  slug: { key: "STUDIO_ID_SLUG", re: /^[a-z0-9-]{1,40}$/ },
};

/** The identity file's values over the neutral ones, or null when the repo has no identity file (a regular file <= 4 KB). */
export function readIdentityFile(repoDir: string): IdentityValues | null {
  const file = path.join(repoDir, IDENTITY_FILE);
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4096) return null;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const raw = parseEnvText(text);
  const out = { ...NEUTRAL_ID };
  for (const [field, { key, re }] of Object.entries(IDENTITY_KEYS) as [keyof IdentityValues, { key: string; re: RegExp }][]) {
    const v = raw[key];
    if (v !== undefined && re.test(v) && v !== "." && v !== "..") out[field] = v;
  }
  return out;
}

/**
 * The repo folder: walk up from `start` (this module's own folder) to the first folder holding a package.json. Under
 * the Next server bundle the module's folder is not the source folder (a bundle chunk, or a build folder outside the
 * repo): when the walk finds nothing, `fallback` (process.cwd(); the LaunchAgents and npm scripts run in the repo).
 * Never depends on the caller's cwd otherwise, so a script run from another folder still finds `private/identity.env`.
 */
export function findRepoDir(start: string | null, fallback = process.cwd()): string {
  if (start && path.isAbsolute(start)) {
    let cur = path.resolve(start);
    for (;;) {
      try {
        if (fs.statSync(path.join(cur, "package.json")).isFile()) return cur;
      } catch {
        // keep walking
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return fallback;
}

/** This module's folder when the runtime knows it (tsx / node: the source folder; a bundle: its chunk), else null. */
function moduleDir(): string | null {
  try {
    return typeof __dirname === "string" && __dirname ? __dirname : null;
  } catch {
    return null;
  }
}

/** This process's repo folder (resolved once, at load). */
export const REPO_DIR = findRepoDir(moduleDir());

/**
 * `STUDIO_IDENTITY` (process env only: the env file's location depends on the identity): unset / empty / `auto` = the
 * identity file when the repo has one (the default); `neutral` = never read `private/identity.env`, always the neutral
 * identity (the demo, `npm run demo`, runs inside an install's repo without its names or folders). Any other value is
 * treated as `neutral` too: a typo can only ever ignore the file, never read it. scripts/studio-identity.sh reads the
 * same variable with the same rule.
 */
export function identityFileIgnored(env: Record<string, string | undefined>): boolean {
  const v = env.STUDIO_IDENTITY?.trim() ?? "";
  return v !== "" && v !== "auto";
}

/**
 * Resolve the install identity for a home folder + environment + repo folder (tests pass temp ones; nothing is created
 * here). `repoDir` defaults to REPO_DIR (found from this module's location, not the caller's cwd).
 */
export function resolveIdentity(home = HOME, env: Record<string, string | undefined> = process.env, repoDir = REPO_DIR): StudioIdentity {
  const envFileOverride = env.STUDIO_ENV_FILE;
  const own = identityFileIgnored(env) ? null : readIdentityFile(repoDir);
  const id = own ?? NEUTRAL_ID;
  const settingsDir = path.join(home, id.settings);
  const prefix = id.labelPrefix;
  return {
    legacy: own != null,
    slug: id.slug,
    appName: id.appName,
    settingsDir,
    dataDir: path.join(home, id.data),
    envFile: envFileOverride ? expandHome(envFileOverride, home) : path.join(settingsDir, ".env"),
    launchdLabels: { web: `${prefix}.web`, worker: `${prefix}.worker` },
  };
}

/** This process's identity (resolved once, at load). */
export const IDENTITY = resolveIdentity();
export const ENV_FILE = IDENTITY.envFile;

/** `~/...` for a path under the home folder (messages and UI text), else the path itself. */
export function tildePath(p: string, home = HOME): string {
  return p === home ? "~" : p.startsWith(home + path.sep) ? `~/${p.slice(home.length + 1)}` : p;
}

export function envTemplate(id: StudioIdentity): string {
  const data = tildePath(id.dataDir);
  const settings = tildePath(id.settingsDir);
  return `# ${id.appName} config (local only, never commit this file)
#
# Jev (TypeSafe) key, used by Classify, hook scoring and search by meaning. Paste it yourself.
TYPESAFE_API_KEY=

# Defaults (uncomment to override; the Studio config file's "env" section can set them too, below this file)
# STUDIO_DB=${data}/studio.db
# STUDIO_CACHE=${data}/cache
# STUDIO_LOGS=${data}/logs
# STUDIO_PORT=4747                            (the web app, the background services and the desktop app all use it)
# STUDIO_DRIVE=~/Studio-Media
# STUDIO_DRIVE_MODE=folder                     (folder: STUDIO_DRIVE is any readable folder; external: a removable drive,
#                                                checked as a real mount point, with the unplugged banner)
# META_ENV_FILE=${settings}/meta.env           (the clients lane's Meta API token + GHL key, read only)
# META_FKB_ENV_FILE=${settings}/meta-company.env  (the company lane's own Meta token, read only; its leads use META_ENV_FILE's GHL key)
# META_UNIVERSAL_REGISTRY=<STUDIO_DRIVE>/shared-ads.json   (optional: ads shared by every client, read only)
#
# Describe (local and free): Ollama vision model + whisper.cpp for the spoken opening of videos.
# STUDIO_VISION_MODEL=qwen3-vl:8b-instruct
# STUDIO_OLLAMA_URL=http://127.0.0.1:11434   (loopback only)
# STUDIO_WHISPER_BIN=/opt/homebrew/bin/whisper-cli
# STUDIO_WHISPER_MODEL=${data}/models/ggml-small.en.bin
#
# Outside tools (empty = Studio looks for them itself: ffmpeg and ffprobe in /opt/homebrew/bin, the engine CLIs in
# ~/.local/bin, /opt/homebrew/bin and /usr/local/bin). Absolute paths (or ~/...); a value in the process environment
# still wins. Read when the web app and the worker start, so restart Studio after a change. Never in the Studio config.
# FFMPEG_PATH=
# FFPROBE_PATH=
# HIGGSFIELD_BIN=
# CODEX_BIN=
# CLAUDE_BIN=
#
# Classify: the pinned Jev model (a versioned id, never jev-latest / jev-preview).
# STUDIO_JEV_MODEL=jev-1.13.0
#
# Hooks: the folder holding each client's folder with its approved copy doc ("Import approved copy", read only).
# STUDIO_CLIENT_DOCS_DIR=${data}/client-docs
#
# YouTube Shorts: the Desktop OAuth client (read only here) and Studio's own read-only token (written 0600 by
# "Connect YouTube" in Settings; never another tool's upload token.json).
# YOUTUBE_CLIENT_SECRET_FILE=${settings}/youtube-client-secret.json
# YOUTUBE_TOKEN_FILE=${settings}/youtube-token.json
#
# Shorts board: where Cut reel writes its hand-off lists (new files only, never on the drive).
# STUDIO_HANDOFFS=${data}/handoffs
#
# Reel kit: the reel kit folder whose VERSION file Cut reel names in its kit hand-off (read only, never on the drive).
# STUDIO_REEL_KIT_DIR=${settings}/reel-kit
#
# New PAUSED Meta ads: where Stage writes NEW order files for your ad apply script (one folder for the clients lane, one for
# the company lane). Absolute, never on the drive, never inside a git working tree.
# META_PENDING_DIR=${data}/pending-clients
# META_FKB_PENDING_DIR=${data}/pending-company
#
# Brand marks: a folder holding your own mark-ink.svg / mark-sand.svg / wordmark-ink.svg / wordmark-paper.svg (empty =
# the built-in generic marks).
# STUDIO_BRAND_DIR=
#
# Lanes, clients, extra roots, folder rules, the business profile and per install defaults (read at startup; seeds lanes
# and clients ONCE, then Settings owns them; the profile holds every business text and house copy rule,
# see docs/configuration.md). Missing file = an empty Studio. Example: studio.config.example.json.
# STUDIO_CONFIG=${settings}/studio.config.json
`;
}

/** Create the env file from the template if it does not exist (never touches an existing one). */
export function ensureEnvFile(file = ENV_FILE): boolean {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, envTemplate(IDENTITY), { mode: 0o600 });
  return true;
}

function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnvText(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const boolish = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true");

const ConfigSchema = z.object({
  STUDIO_DB: z.string().min(1),
  STUDIO_CACHE: z.string().min(1),
  STUDIO_LOGS: z.string().min(1),
  // Digits only (scripts/studio-identity.sh studio_port applies the same rule, so the shell and Node agree on every value).
  STUDIO_PORT: z.string().trim().regex(/^\d+$/, "a whole number from 1 to 65535").transform(Number).pipe(z.number().int().min(1).max(65535)),
  STUDIO_DRIVE: z.string().min(1),
  STUDIO_DRIVE_MODE: z.enum(DRIVE_MODES, { message: `one of ${DRIVE_MODES.join(" | ")}` }),
  META_ENV_FILE: z.string().min(1),
  META_FKB_ENV_FILE: z.string().min(1),
  // Empty = <STUDIO_DRIVE>/shared-ads.json (a missing file = no shared ads).
  META_UNIVERSAL_REGISTRY: z.string(),
  // Empty = the built-in generic marks in public/brand.
  STUDIO_BRAND_DIR: z.string(),
  STUDIO_FAKE_UNMOUNTED: boolish,
  STUDIO_VISION_MODEL: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/, "an Ollama model name, like qwen3-vl:8b-instruct"),
  STUDIO_OLLAMA_URL: z.string().transform((v, ctx) => {
    const url = loopbackUrl(v);
    if (!url) ctx.addIssue({ code: "custom", message: "must be a loopback http URL, like http://127.0.0.1:11434 (Studio never sends media off this Mac)" });
    return url ?? "";
  }),
  STUDIO_WHISPER_BIN: z.string().min(1),
  STUDIO_WHISPER_MODEL: z.string().min(1),
  // Pinned so calibration never drifts: a versioned id like jev-1.13.0; the aliases jev-latest / jev-preview are refused.
  STUDIO_JEV_MODEL: z.string().regex(/^jev-\d+\.\d+\.\d+$/, "a versioned Jev model id like jev-1.13.0 (never jev-latest or jev-preview)"),
  STUDIO_CLIENT_DOCS_DIR: z.string().min(1),
  YOUTUBE_CLIENT_SECRET_FILE: z.string().min(1),
  YOUTUBE_TOKEN_FILE: z.string().min(1),
  STUDIO_HANDOFFS: z.string().min(1),
  STUDIO_REEL_KIT_DIR: z.string().min(1),
  META_PENDING_DIR: z.string().min(1),
  META_FKB_PENDING_DIR: z.string().min(1),
  STUDIO_CONFIG: z.string().min(1),
  // Outside tool binaries (empty = each reader's own search); absolute or ~/, checked in loadConfig. Env file / process only.
  FFMPEG_PATH: z.string(),
  FFPROBE_PATH: z.string(),
  HIGGSFIELD_BIN: z.string(),
  CODEX_BIN: z.string(),
  CLAUDE_BIN: z.string(),
});

/**
 * Outside tool binaries a Mac's env file may point at (Phase 4b): ffmpeg / ffprobe (src/worker/proc.ts) and the engine CLIs
 * (src/lib/gen/cli.ts resolveHiggsfield / resolveCodex, src/lib/hooks/claude.ts resolveClaude). Their readers read the
 * process environment, so the web app (scripts/next.ts, before it spawns Next) and the worker (src/worker/tool-env.ts, its
 * first import) copy the resolved values in with applyToolEnv. Not allowed in the Studio config's `env` (CONFIG_ENV_KEYS):
 * where a tool lives belongs to the Mac, not to the business config.
 */
export const TOOL_PATH_KEYS = ["FFMPEG_PATH", "FFPROBE_PATH", "HIGGSFIELD_BIN", "CODEX_BIN", "CLAUDE_BIN"] as const;
export type ToolPathKey = (typeof TOOL_PATH_KEYS)[number];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `http(s)://<loopback>[:port]` with no credentials, path, query or hash, normalized to its origin; else null. */
export function loopbackUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  return url.origin;
}

export type StudioConfig = {
  dbPath: string;
  cacheDir: string;
  logsDir: string;
  port: number;
  host: "127.0.0.1";
  drivePath: string;
  /**
   * `external` = STUDIO_DRIVE is a removable drive (mounted = a real mount point; the unplugged banner);
   * `folder` = any readable folder counts as mounted (no device check). Default `folder`.
   */
  driveMode: DriveMode;
  /** App display name: the Studio config's `app.name`, else the install identity's. */
  appName: string;
  /** The Studio config file (STUDIO_CONFIG; missing = an empty Studio). */
  studioConfigFile: string;
  /** Its parsed content (src/lib/studio-config.ts; seeds lanes / clients once, see src/lib/db/seed.ts seedFromConfig). */
  studio: StudioFile;
  /** The clients lane's Meta API token + GHL key. Read by src/lib/meta/graph.ts + ghl.ts only (values), config (presence). */
  metaEnvFile: string;
  /** The company lane's own Meta token. Read by src/lib/meta/graph.ts only (its leads use META_ENV_FILE's GHL key). */
  metaFkbEnvFile: string;
  /** The universal ad registry (optional, read only; a missing file = no shared ads), src/lib/meta/match.ts. */
  universalRegistry: string;
  /** A folder with the install's own brand marks (BRAND_FILES), or null = the built-in generic marks (public/brand). */
  brandDir: string | null;
  fakeUnmounted: boolean;
  envFile: string;
  /** Ollama vision model used by Describe. */
  visionModel: string;
  /** Ollama API origin, loopback only (validated). */
  ollamaUrl: string;
  /** whisper.cpp CLI and model, absolute (LaunchAgents have no /opt/homebrew/bin on PATH). Existence is checked at use. */
  whisperBin: string;
  whisperModel: string;
  /** Pinned Jev model (versioned id). */
  jevModel: string;
  /** Folder holding each client's folder with its approved copy doc (read only, Import approved copy). */
  clientDocsDir: string;
  /** Google Desktop OAuth client (read by src/lib/youtube/auth.ts only; values never leave it). */
  youtubeClientSecretFile: string;
  /** Studio's own read-only YouTube token (written 0600 by src/lib/youtube/auth.ts only). */
  youtubeTokenFile: string;
  /** Cut reel hand-off lists (Phase 6 slice 2): written only by src/lib/shorts/handoff.ts, new files only, never on the drive. */
  handoffsDir: string;
  /** The reel kit folder (Phase 7): only its `VERSION` file is ever read (src/lib/shorts/kit.ts readKitVersion). */
  reelKitDir: string;
  /**
   * New PAUSED ad order files (Phase 6 slice 3): the clients lane and the company lane. Written only by src/lib/meta/orders.ts,
   * new files only (+ cancelling Studio's own staged ones); never on the drive, never inside a git working tree.
   */
  pendingDirs: { fkbpros: string; fkb: string };
  /** The tool paths that are set (absolute; process env > env file), see TOOL_PATH_KEYS / applyToolEnv. */
  toolPaths: Partial<Record<ToolPathKey, string>>;
};

/**
 * The neutral defaults for an identity (data under the data dir, settings and keys under the settings dir). An install
 * that keeps other defaults (the original install: its drive, its Meta folders, its skills) sets them in its Studio
 * config's `env` section, never here.
 */
function defaultsFor(id: StudioIdentity, home: string): Record<string, string> {
  return {
    STUDIO_DB: path.join(id.dataDir, "studio.db"),
    STUDIO_CACHE: path.join(id.dataDir, "cache"),
    STUDIO_LOGS: path.join(id.dataDir, "logs"),
    STUDIO_PORT: "4747",
    STUDIO_DRIVE: path.join(home, "Studio-Media"),
    STUDIO_DRIVE_MODE: "folder",
    META_ENV_FILE: path.join(id.settingsDir, "meta.env"),
    META_FKB_ENV_FILE: path.join(id.settingsDir, "meta-company.env"),
    META_UNIVERSAL_REGISTRY: "",
    STUDIO_BRAND_DIR: "",
    STUDIO_VISION_MODEL: "qwen3-vl:8b-instruct",
    STUDIO_OLLAMA_URL: "http://127.0.0.1:11434",
    STUDIO_WHISPER_BIN: "/opt/homebrew/bin/whisper-cli",
    STUDIO_WHISPER_MODEL: path.join(id.dataDir, "models", "ggml-small.en.bin"),
    STUDIO_JEV_MODEL: "jev-1.13.0",
    STUDIO_CLIENT_DOCS_DIR: path.join(id.dataDir, "client-docs"),
    YOUTUBE_CLIENT_SECRET_FILE: path.join(id.settingsDir, "youtube-client-secret.json"),
    YOUTUBE_TOKEN_FILE: path.join(id.settingsDir, "youtube-token.json"),
    STUDIO_HANDOFFS: path.join(id.dataDir, "handoffs"),
    STUDIO_REEL_KIT_DIR: path.join(id.settingsDir, "reel-kit"),
    META_PENDING_DIR: path.join(id.dataDir, "pending-clients"),
    META_FKB_PENDING_DIR: path.join(id.dataDir, "pending-company"),
    STUDIO_CONFIG: path.join(id.settingsDir, "studio.config.json"),
    FFMPEG_PATH: "",
    FFPROBE_PATH: "",
    HIGGSFIELD_BIN: "",
    CODEX_BIN: "",
    CLAUDE_BIN: "",
  };
}

/**
 * Read + validate the Studio config file (missing = EMPTY_STUDIO). Throws StudioConfigError with the field path and rule
 * only, never a value from the file.
 */
export function readStudioFile(file: string): StudioFile {
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new StudioConfigError("is not a file");
    if (st.size > 2_000_000) throw new StudioConfigError("is larger than 2 MB");
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STUDIO;
    if (e instanceof StudioConfigError) throw e;
    throw new StudioConfigError("cannot be read");
  }
  return parseStudioText(text);
}

const KEYS = [...Object.keys(defaultsFor(IDENTITY, HOME)), "STUDIO_FAKE_UNMOUNTED"] as const;

/** Every key the config reads (the schema's own list): the demo forces each one, and the smoke checks it does. */
export const CONFIG_KEYS: readonly string[] = Object.keys(ConfigSchema.shape);

let cached: StudioConfig | null = null;

/** Load + validate config (memoized). Throws a readable error on invalid values. */
export function getConfig(): StudioConfig {
  if (cached) return cached;
  cached = loadConfig();
  return cached;
}

/**
 * The Studio config's `env` section as raw values: `./` at the start of a value = the config file's own folder (so a
 * config kept next to its install can point at files beside it), `~/` is expanded later like any value.
 */
function configEnvValues(studio: StudioFile, configFile: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(studio.env ?? {})) {
    if (typeof v !== "string") continue;
    out[k] = v.startsWith("./") ? path.join(path.dirname(configFile), v.slice(2)) : v;
  }
  return out;
}

/**
 * Load + validate config for an environment and home folder, not memoized (getConfig = this process's; the smoke
 * passes a temp home + env). Throws a readable error on invalid values.
 */
export function loadConfig({
  env = process.env,
  home = HOME,
  repoDir = REPO_DIR,
}: { env?: Record<string, string | undefined>; home?: string; repoDir?: string } = {}): StudioConfig {
  const id = resolveIdentity(home, env, repoDir);
  const defaults = defaultsFor(id, home);
  const fileEnv = readEnvFile(id.envFile);
  const given = (k: string): string | undefined => {
    const fromProc = env[k];
    if (fromProc !== undefined && fromProc !== "") return fromProc;
    const fromFile = fileEnv[k];
    return fromFile !== undefined && fromFile !== "" ? fromFile : undefined;
  };
  const invalid = (msg: string) => new Error(`${id.appName} config is invalid: ${msg}`);
  const expand = (p: string) => expandHome(p, home);
  // The Studio config file first: its `env` section is the layer between the env file and the neutral defaults.
  const studioConfigFile = path.resolve(expand(given("STUDIO_CONFIG") ?? defaults.STUDIO_CONFIG));
  let studio: StudioFile;
  try {
    studio = readStudioFile(studioConfigFile);
  } catch (e) {
    throw invalid(`STUDIO_CONFIG (${studioConfigFile}) ${(e as Error).message}. Fix the file and restart.`);
  }
  const configEnv = configEnvValues(studio, studioConfigFile);
  const raw: Record<string, string | undefined> = {};
  for (const k of KEYS) raw[k] = given(k) ?? configEnv[k] ?? defaults[k];
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `${id.appName} config is invalid (${id.envFile}):\n${issues}\nFix the values and restart.`,
    );
  }
  const v = parsed.data;
  const dbPath = path.resolve(expand(v.STUDIO_DB));
  const cacheDir = path.resolve(expand(v.STUDIO_CACHE));
  const logsDir = path.resolve(expand(v.STUDIO_LOGS));
  const drivePath = path.resolve(expand(v.STUDIO_DRIVE));
  const whisperBin = expand(v.STUDIO_WHISPER_BIN);
  const whisperModel = expand(v.STUDIO_WHISPER_MODEL);
  if (!path.isAbsolute(whisperBin) || !path.isAbsolute(whisperModel)) {
    throw invalid("STUDIO_WHISPER_BIN / STUDIO_WHISPER_MODEL must be absolute paths (or start with ~/).");
  }
  if (cacheDir === "/" || dbPath === "/") {
    throw invalid("STUDIO_CACHE / STUDIO_DB cannot be /");
  }
  const youtubeClientSecretFile = path.resolve(expand(v.YOUTUBE_CLIENT_SECRET_FILE));
  const youtubeTokenFile = path.resolve(expand(v.YOUTUBE_TOKEN_FILE));
  // Studio's token must never overwrite the episode prep skill's upload token (token.json next to the client secret).
  if (youtubeTokenFile === path.join(path.dirname(youtubeClientSecretFile), "token.json") || path.basename(youtubeTokenFile) === "client_secret.json") {
    throw invalid("YOUTUBE_TOKEN_FILE must not be a token.json (another tool's upload login) or a client secret file.");
  }
  if (cacheDir === drivePath || cacheDir.startsWith(drivePath + path.sep)) {
    throw invalid(`STUDIO_CACHE (${cacheDir}) must not live on the media drive (${drivePath}). The drive is read only for this app (except generated outputs in "Studio Generated", via the write guard).`);
  }
  const handoffsDir = path.resolve(expand(v.STUDIO_HANDOFFS));
  if (handoffsDir === "/" || handoffsDir === drivePath || handoffsDir.startsWith(drivePath + path.sep)) {
    throw invalid(`STUDIO_HANDOFFS (${handoffsDir}) must not be / or live on the media drive (${drivePath}). Cut reel lists stay on this Mac.`);
  }
  const rawKit = expand(v.STUDIO_REEL_KIT_DIR);
  const reelKitDir = path.resolve(rawKit);
  if (!path.isAbsolute(rawKit) || reelKitDir === "/" || onDrive(reelKitDir, drivePath)) {
    throw invalid(`STUDIO_REEL_KIT_DIR (${rawKit}) must be an absolute path (or start with ~/), not /, and not on the media drive (${drivePath}).`);
  }
  const rawPending = { fkbpros: expand(v.META_PENDING_DIR), fkb: expand(v.META_FKB_PENDING_DIR) };
  const pendingDirs = { fkbpros: path.resolve(rawPending.fkbpros), fkb: path.resolve(rawPending.fkb) };
  for (const [key, dir] of [["META_PENDING_DIR", rawPending.fkbpros], ["META_FKB_PENDING_DIR", rawPending.fkb]] as const) {
    const bad = pendingDirProblem(dir, drivePath);
    if (bad) throw invalid(`${key} (${dir}) ${bad}`);
  }
  if (pendingDirs.fkbpros === pendingDirs.fkb) throw invalid("META_PENDING_DIR and META_FKB_PENDING_DIR must differ.");
  const brandDir = v.STUDIO_BRAND_DIR.trim() ? path.resolve(expand(v.STUDIO_BRAND_DIR.trim())) : null;
  if (brandDir && !path.isAbsolute(expand(v.STUDIO_BRAND_DIR.trim()))) throw invalid("STUDIO_BRAND_DIR must be an absolute path (or start with ~/ or ./ in the Studio config).");
  const toolPaths: Partial<Record<ToolPathKey, string>> = {};
  for (const k of TOOL_PATH_KEYS) {
    const raw = expand(v[k].trim());
    if (!raw) continue;
    // A bare command name (no slash) is kept as is: spawn finds it on PATH, as before this key could sit in the env file.
    if (!raw.includes("/")) {
      toolPaths[k] = raw;
      continue;
    }
    if (!path.isAbsolute(raw)) throw invalid(`${k} must be an absolute path, a command name or start with ~/.`);
    toolPaths[k] = path.resolve(raw);
  }
  return {
    dbPath,
    cacheDir,
    logsDir,
    port: v.STUDIO_PORT,
    host: "127.0.0.1",
    drivePath,
    driveMode: v.STUDIO_DRIVE_MODE,
    appName: studio.app?.name ?? id.appName,
    studioConfigFile,
    studio,
    metaEnvFile: path.resolve(expand(v.META_ENV_FILE)),
    metaFkbEnvFile: path.resolve(expand(v.META_FKB_ENV_FILE)),
    universalRegistry: v.META_UNIVERSAL_REGISTRY.trim() ? path.resolve(expand(v.META_UNIVERSAL_REGISTRY.trim())) : path.join(drivePath, "shared-ads.json"),
    brandDir,
    fakeUnmounted: v.STUDIO_FAKE_UNMOUNTED,
    envFile: id.envFile,
    visionModel: v.STUDIO_VISION_MODEL,
    ollamaUrl: v.STUDIO_OLLAMA_URL,
    whisperBin: path.resolve(whisperBin),
    whisperModel: path.resolve(whisperModel),
    jevModel: v.STUDIO_JEV_MODEL,
    clientDocsDir: path.resolve(expand(v.STUDIO_CLIENT_DOCS_DIR)),
    youtubeClientSecretFile,
    youtubeTokenFile,
    handoffsDir,
    reelKitDir,
    pendingDirs,
    toolPaths,
  };
}

/**
 * Copy the resolved tool paths into an environment (this process's by default) so the readers, which read the process
 * environment, see the env file's values too: a set one is written (already the process value when that was given, `~/`
 * expanded), an unset one is removed (an empty value means unset). Called before anything reads them: scripts/next.ts
 * before it spawns Next, src/worker/tool-env.ts as the worker's first import. STUDIO_ENGINES=off still wins for the three
 * engines (their resolvers check it first).
 */
export function applyToolEnv(cfg: Pick<StudioConfig, "toolPaths">, env: Record<string, string | undefined> = process.env): void {
  for (const k of TOOL_PATH_KEYS) {
    const v = cfg.toolPaths[k];
    if (v) env[k] = v;
    else delete env[k];
  }
}

/** The git working tree a path sits in (an ancestor holding `.git`), or null. */
export function gitTreeOf(p: string): string | null {
  let cur = realishPath(p);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Why an order folder (META_PENDING_DIR / META_FKB_PENDING_DIR) is refused, or null: it must be absolute, not `/`, not on
 * the media drive (lexically or by its real path) and not inside a git working tree (e.g. this repo). Shared by config
 * (fail fast at startup) and src/lib/meta/orders.ts (checked again before every write).
 */
export function pendingDirProblem(dir: string, drivePath: string): string | null {
  if (!path.isAbsolute(dir)) return "must be an absolute path.";
  const abs = path.resolve(dir);
  if (abs === "/") return "must not be /.";
  if (onDrive(abs, drivePath)) return "must not live on the media drive.";
  if (gitTreeOf(abs)) return "must not be inside a git working tree (order files never belong in a repo).";
  return null;
}

/** The drive's display name (e.g. "Media Drive"): the last segment of STUDIO_DRIVE. Used by every "not mounted" message. */
export function driveLabel(cfg: Pick<StudioConfig, "drivePath">): string {
  return path.basename(cfg.drivePath);
}

/** "<drive> is not mounted." (external) / "<drive> is not available." (folder) for server responses. */
export function notMountedMessage(cfg: Pick<StudioConfig, "drivePath" | "driveMode">): string {
  return `${driveLabel(cfg)} is ${driveWords(cfg.driveMode).down}.`;
}

/** Create the app's own dirs (never anything on the drive; only src/lib/writeguard.ts may write there). */
export function ensureAppDirs(cfg: StudioConfig = getConfig()) {
  fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  fs.mkdirSync(cfg.logsDir, { recursive: true });
}

export type KeyStatus = {
  typesafe: boolean;
  /** Lane B API token (the client accounts, META_ENV_FILE). */
  meta: boolean;
  metaFileExists: boolean;
  /** Lane C's own Meta token (META_FKB_ENV_FILE). */
  fkbMeta: boolean;
  fkbMetaFileExists: boolean;
  /**
   * GHL key + location id in META_ENV_FILE (the widget's lead source). Lane C uses the same key (Phase 5 slice 2): its leads
   * count from GHL once a contact carries source fkb-fb-ad, Meta leads until then.
   */
  ghl: boolean;
};

/** Presence only. Values are never returned, logged, or sent anywhere (src/lib/meta/* read them for their requests). */
export function keyStatus(cfg: StudioConfig = getConfig()): KeyStatus {
  const studioEnv = readEnvFile(cfg.envFile);
  const typesafe = Boolean(studioEnv.TYPESAFE_API_KEY?.trim());
  const metaFileExists = fs.existsSync(cfg.metaEnvFile);
  const metaEnv = metaFileExists ? readEnvFile(cfg.metaEnvFile) : {};
  const fkbMetaFileExists = fs.existsSync(cfg.metaFkbEnvFile);
  const fkbEnv = fkbMetaFileExists ? readEnvFile(cfg.metaFkbEnvFile) : {};
  const has = (env: Record<string, string>, k: string) => Boolean(env[k]?.trim());
  return {
    typesafe,
    meta: has(metaEnv, "META_ACCESS_TOKEN"),
    metaFileExists,
    fkbMeta: has(fkbEnv, "META_ACCESS_TOKEN"),
    fkbMetaFileExists,
    ghl: has(metaEnv, "GHL_API_KEY") && has(metaEnv, "GHL_LOCATION_ID"),
  };
}

/**
 * The Jev key, for src/lib/ai/jev.ts ONLY (its HTTP transport puts it in the Authorization header). Read fresh from the
 * env file on every call so a key pasted later works without a restart. Never log, store or return it anywhere else.
 */
export function readTypesafeKey(cfg: Pick<StudioConfig, "envFile"> = getConfig()): string | null {
  const key = readEnvFile(cfg.envFile).TYPESAFE_API_KEY?.trim();
  return key ? key : null;
}

/** For tests: drop the memoized config. */
export function resetConfigCache() {
  cached = null;
}
