/**
 * `npm run demo`: a populated Creative Studio in a minute, with no keys, no media drive, no Ollama and no paid or network
 * call, isolated from any real install on the same Mac (scripts/demo-env.ts says how).
 *
 *   npm run demo                      index demo/media into .demo-data/, add the sample data, build the demo's own copy of
 *                                     the app if it has none (.demo-data/next), then run the web app and the worker on
 *                                     http://127.0.0.1:4750 (Ctrl+C stops both)
 *   npm run demo -- --reset           wipe .demo-data/ first (a fresh demo DB, cache, logs and build)
 *   npm run demo -- --build           rebuild the demo's app even when its build exists (after pulling new code)
 *   npm run demo -- --port 4751       another port (never 4747 / 4748: a real install's)
 *   npm run demo -- --setup-only      only index + sample data, print a JSON summary, no build, no servers (the smoke)
 *   npm run demo -- --setup-only --data <dir>   the same into another throwaway folder (absolute; refused when it is an
 *                                     install's folder, inside the repo other than .demo-data, or a non-empty folder the
 *                                     demo did not make)
 *
 * Order: the media is indexed by the worker's own engine (a scan, in this process) before the sample data is written,
 * because the sample rows point at the indexed files; then the worker (derive: thumbs, posters, proxies) and the web app
 * start as separate processes with the demo environment.
 *
 * What it writes: everything goes into the data folder (DB, cache, logs, `DEMO-DATA` marker, its build in
 * `.demo-data/next` (`STUDIO_DIST_DIR`) + `next-build.json`). The repo's own `.next/` is never built into, read or served.
 * One side effect is undone at once: `next build` rewrites `next-env.d.ts` (gitignored) to point at the build folder's
 * types, and this script puts the file's previous bytes back right after the build (or removes it if there was none).
 * tsconfig.json already lists the demo build's types, so Next leaves it alone. Outside the repo: only the two ad order
 * folders under the OS temp folder, and only if someone stages an ad in the demo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { DEMO_DIST_DIR, DEMO_MARKER, DEMO_PORT, demoChildEnv, demoDataDir, demoDataProblem, demoEnv, demoPortProblem } from "./demo-env";

const REPO = path.resolve(__dirname, "..");
const BUILD_STAMP = "next-build.json";

type Args = { reset: boolean; build: boolean; setupOnly: boolean; port: number; data: string | null };

function usage(msg: string): never {
  console.error(`demo: ${msg}\nusage: npm run demo -- [--reset] [--build] [--port N] [--setup-only [--data <absolute dir>]]`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { reset: false, build: false, setupOnly: false, port: DEMO_PORT, data: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--reset") a.reset = true;
    else if (v === "--build") a.build = true;
    else if (v === "--setup-only") a.setupOnly = true;
    else if (v === "--port") a.port = Number(argv[++i]);
    else if (v === "--data") a.data = argv[++i] ?? "";
    else usage(`unknown argument ${JSON.stringify(v)}`);
  }
  const bad = demoPortProblem(a.port);
  if (bad) usage(`port ${bad}`);
  if (a.data != null && (!a.data || !path.isAbsolute(a.data))) usage("--data needs an absolute folder");
  // The servers always use .demo-data (their build folder must sit inside the repo, next.config.ts distDir).
  if (a.data != null && !a.setupOnly) usage("--data works with --setup-only only");
  return a;
}

/** Delete a data folder only when it is the demo's (it carries the marker) or does not exist. */
function resetData(dir: string) {
  if (!fs.existsSync(dir)) return;
  if (!fs.existsSync(path.join(dir, DEMO_MARKER))) usage(`${dir} was not made by the demo (no ${DEMO_MARKER} file), so --reset leaves it alone.`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * An install's folders the demo must never use as its data folder: the identity this repo resolves to WITHOUT the demo
 * switch (its data + settings folders), the neutral ones, and any DB / cache / logs / hand-offs folder the caller's
 * environment names. Only folder names are read (the identity file through the pure resolveIdentity, given the caller's
 * own environment), never an env file or a config.
 */
async function protectedDirs(originalEnv: NodeJS.ProcessEnv): Promise<string[]> {
  const { resolveIdentity, NEUTRAL_ID } = await import("../src/lib/config");
  const home = os.homedir();
  const id = resolveIdentity(home, { ...originalEnv, STUDIO_IDENTITY: "" }, REPO);
  const expand = (v: string) => path.resolve(v.replace(/^~(?=\/|$)/, home));
  const named = ["STUDIO_DB", "STUDIO_CACHE", "STUDIO_LOGS", "STUDIO_HANDOFFS"]
    .map((key) => originalEnv[key]?.trim())
    .filter((v): v is string => Boolean(v))
    .map((v) => (/\.db$/i.test(v) ? path.dirname(expand(v)) : expand(v))); // a DB path names its folder
  return [id.dataDir, id.settingsDir, path.join(home, NEUTRAL_ID.data), path.join(home, NEUTRAL_ID.settings), ...named];
}

async function setup(dataDir: string) {
  const { getConfig, ensureAppDirs, IDENTITY } = await import("../src/lib/config");
  const cfg = getConfig();
  const inside = (p: string) => p === dataDir || p.startsWith(dataDir + path.sep);
  // Belt and braces: the demo environment must have won every layer.
  const wrong = [
    IDENTITY.legacy && "an install identity file was read",
    cfg.envFile !== path.join(REPO, "demo", ".env") && "the env file is not demo/.env",
    cfg.studioConfigFile !== path.join(REPO, "demo", "studio.config.json") && "the Studio config is not demo/studio.config.json",
    !inside(cfg.dbPath) && "the DB is outside the demo data folder",
    !inside(cfg.cacheDir) && "the cache is outside the demo data folder",
  ].filter(Boolean);
  if (wrong.length) throw new Error(`demo: refusing to start: ${wrong.join("; ")}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, DEMO_MARKER), "Made by npm run demo (scripts/demo.ts). Safe to delete.\n");
  ensureAppDirs(cfg);
  const { openDb } = await import("../src/lib/db");
  const { Engine } = await import("../src/worker/engine");
  const { seedDemoData, demoCounts } = await import("./demo-data");
  const db = openDb(cfg.dbPath);
  try {
    const engine = new Engine({ cfg, db, concurrency: 2, log: () => {} });
    await engine.scanAll();
    const seeded = seedDemoData(db.sqlite, cfg);
    return {
      appName: cfg.appName,
      identityLegacy: IDENTITY.legacy,
      envFile: cfg.envFile,
      studioConfigFile: cfg.studioConfigFile,
      dbPath: cfg.dbPath,
      cacheDir: cfg.cacheDir,
      drivePath: cfg.drivePath,
      driveMode: cfg.driveMode,
      port: cfg.port,
      seeded,
      counts: demoCounts(db.sqlite),
    };
  } finally {
    db.sqlite.close();
  }
}

function bin(name: string) {
  return path.join(REPO, "node_modules", ".bin", name);
}

/** The demo's own build, reused only when this script made it (its stamp next to it) and it is complete. */
function hasOwnBuild(dataDir: string): boolean {
  const dist = path.join(REPO, DEMO_DIST_DIR);
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(dataDir, BUILD_STAMP), "utf8")) as { distDir?: string };
    return stamp.distDir === DEMO_DIST_DIR && fs.statSync(path.join(dist, "BUILD_ID")).isFile();
  } catch {
    return false;
  }
}

/** `next build` into the demo's dist folder, with next-env.d.ts put back exactly as it was afterwards. */
function buildDemo(env: NodeJS.ProcessEnv, dataDir: string) {
  const dist = path.join(REPO, DEMO_DIST_DIR);
  if (!dist.startsWith(dataDir + path.sep)) throw new Error("demo: the build folder must be inside the demo data folder");
  fs.rmSync(path.join(dataDir, BUILD_STAMP), { force: true });
  fs.rmSync(dist, { recursive: true, force: true });
  const envDts = path.join(REPO, "next-env.d.ts");
  const before = fs.existsSync(envDts) ? fs.readFileSync(envDts) : null;
  console.log(`demo: building the demo's own copy of the app into ${DEMO_DIST_DIR} (a minute or two the first time)`);
  let status: number | null;
  try {
    status = spawnSync(bin("next"), ["build"], { cwd: REPO, env, stdio: "inherit" }).status;
  } finally {
    if (before) fs.writeFileSync(envDts, before);
    else fs.rmSync(envDts, { force: true });
  }
  if (status !== 0) {
    console.error("demo: the build failed");
    process.exit(1);
  }
  fs.writeFileSync(path.join(dataDir, BUILD_STAMP), `${JSON.stringify({ by: "npm run demo", distDir: DEMO_DIST_DIR, builtAt: new Date().toISOString() })}\n`);
}

async function waitReady(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const original = { ...process.env };
  const dataDir = path.resolve(args.data ?? demoDataDir(REPO));
  const env = demoChildEnv(original, demoEnv({ repoDir: REPO, dataDir, port: args.port, ffmpegPath: original.FFMPEG_PATH, ffprobePath: original.FFPROBE_PATH }));
  // This process runs the setup itself, with the same environment as the children (inherited install variables dropped),
  // set BEFORE the config module loads (it resolves the install identity at load).
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  const bad = demoDataProblem(dataDir, { repoDir: REPO, protect: await protectedDirs(original) });
  if (bad) usage(`the data folder ${dataDir} ${bad}`);
  if (args.reset) resetData(dataDir);

  const summary = await setup(dataDir);
  if (args.setupOnly) {
    console.log(JSON.stringify(summary));
    return;
  }
  console.log(`demo: ${summary.appName}: data in ${dataDir}, media in ${summary.drivePath}`);
  if (args.build || !hasOwnBuild(dataDir)) buildDemo(env, dataDir);

  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) if (c.exitCode == null && c.signalCode == null) c.kill("SIGTERM");
    const deadline = Date.now() + 15_000;
    while (children.some((c) => c.exitCode == null && c.signalCode == null) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    for (const c of children) if (c.exitCode == null && c.signalCode == null) c.kill("SIGKILL");
    process.exit(code);
  };
  const run = (label: string, cmd: string, argv: string[]) => {
    const c = spawn(cmd, argv, { cwd: REPO, env, stdio: "inherit" });
    c.on("exit", (code, signal) => {
      if (!stopping) {
        console.error(`demo: the ${label} stopped (${signal ?? `exit ${code}`}), stopping the demo`);
        void stop(1);
      }
    });
    children.push(c);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop(0));
  run("worker", bin("tsx"), ["src/worker/index.ts"]);
  run("web app", bin("tsx"), ["scripts/next.ts", "start"]);
  if (await waitReady(args.port, 90_000)) {
    console.log(`\ndemo: ${summary.appName} is running on http://127.0.0.1:${args.port}  (Ctrl+C stops it; every number and name is made up)\n`);
  } else if (!stopping) {
    console.error(`demo: the web app did not answer on port ${args.port} in 90 s`);
    await stop(1);
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
