/**
 * Creative Studio Phase 4b smoke checks (called by scripts/smoke.ts; also runnable alone: `npx tsx scripts/smoke-launch.ts`):
 *
 *  - The shell resolver (scripts/studio-identity.sh studio_port / studio_setting) equals loadConfig() for STUDIO_PORT on
 *    temp homes and temp repos for every layer (process env > env file > the Studio config's `env` > 4747; STUDIO_ENV_FILE,
 *    STUDIO_CONFIG from the environment or the env file, an identity file, STUDIO_IDENTITY=neutral; dotenv's value rules;
 *    bad values refused by both), in bash and zsh, and for STUDIO_BRAND_DIR (the desktop app's icon).
 *  - launcher/start.sh (zsh, the applet's bare PATH) prints the configured port's URL once Studio answers, and stops on a bad
 *    port before it touches launchctl. A temp repo whose identity names made-up LaunchAgent labels and whose installer is a
 *    stub: nothing on this Mac is started or loaded.
 *  - Tool paths (FFMPEG_PATH, FFPROBE_PATH, HIGGSFIELD_BIN, CODEX_BIN, CLAUDE_BIN): set in an env file they reach the
 *    worker's readers (src/worker/tool-env.ts first, then proc.ts and the three resolvers, in a child process) and the Next
 *    server's environment (scripts/next.ts against a stub `next`); a process value beats the file; empty = unset; a relative
 *    path is refused; never in the Studio config's `env`; STUDIO_ENGINES=off still wins; the demo env forces all five.
 *  - The neutral whisper model default follows the identity's data folder.
 * Temp folders only: never the real home, env file, DB, LaunchAgents or ports 4747 / 4748.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";

type Ctx = { cfg?: StudioConfig; tmp: string; ok: (msg: string) => void };

const REPO = path.resolve(__dirname, "..");
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SHELLS = ["/bin/bash", "/bin/zsh"];

/** A free loopback port (never 4747 / 4748 / 4750). */
async function freePort(): Promise<number> {
  for (;;) {
    const srv = http.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    if (![4747, 4748, 4750].includes(port)) return port;
  }
}

function run(cmd: string, args: string[], opts: { env: Record<string, string | undefined>; cwd?: string; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: opts.env as NodeJS.ProcessEnv, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    c.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const t = setTimeout(() => c.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    c.on("error", reject);
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runLaunchSmoke({ tmp, ok }: Ctx) {
  const config = await import("../src/lib/config");
  const { loadConfig, envTemplate, resolveIdentity, applyToolEnv, TOOL_PATH_KEYS, CONFIG_KEYS } = config;
  const base = path.join(tmp, "launch");
  fs.mkdirSync(base);

  // A temp repo carrying the shell helpers (and, for some cases, a made-up identity file).
  const OWN = { settings: ".acme-launch", data: "Acme-Launch", labelPrefix: "com.example.smokelaunch" };
  const repoOf = (name: string, identity: boolean) => {
    const r = path.join(base, name);
    fs.mkdirSync(path.join(r, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(r, "launcher"), { recursive: true });
    fs.mkdirSync(path.join(r, "private"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "scripts", "studio-identity.sh"), path.join(r, "scripts", "studio-identity.sh"));
    fs.copyFileSync(path.join(REPO, "launcher", "start.sh"), path.join(r, "launcher", "start.sh"));
    fs.chmodSync(path.join(r, "launcher", "start.sh"), 0o755);
    // A stub installer: start.sh's fallback can never load anything from a temp repo.
    fs.writeFileSync(path.join(r, "scripts", "install-launchd.sh"), "echo stub installer; exit 1\n");
    if (identity) fs.writeFileSync(path.join(r, "private", "identity.env"), `STUDIO_ID_SETTINGS=${OWN.settings}\nSTUDIO_ID_DATA=${OWN.data}\nSTUDIO_ID_LABEL_PREFIX=${OWN.labelPrefix}\n`);
    return r;
  };
  const plainRepo = repoOf("repo-plain", false);
  const ownRepo = repoOf("repo-own", true);

  // ---------------------------------------------------------------- STUDIO_PORT: the shell resolver vs loadConfig
  type Case = {
    name: string;
    repo?: string;
    env?: Record<string, string>;
    /** Env file text at the identity's default place (settings dir / .env). */
    envFile?: string;
    /** Studio config at the default place (settings dir / studio.config.json); a string = raw text. */
    config?: Record<string, unknown> | string;
    /** Extra files under the home (relative path -> text). */
    files?: Record<string, string>;
    want: number | "invalid";
  };
  const cfgJson = (port: unknown) => ({ env: { STUDIO_PORT: port } });
  const cases: Case[] = [
    { name: "nothing set", want: 4747 },
    { name: "the config's env", config: cfgJson("4761"), want: 4761 },
    { name: "the env file over the config", envFile: "STUDIO_PORT=4762\n", config: cfgJson("4761"), want: 4762 },
    { name: "the process env over both", env: { STUDIO_PORT: "4763" }, envFile: "STUDIO_PORT=4762\n", config: cfgJson("4761"), want: 4763 },
    { name: "an empty process value = unset", env: { STUDIO_PORT: "" }, envFile: "STUDIO_PORT=4762\n", want: 4762 },
    { name: "an empty env file value = unset", envFile: "STUDIO_PORT=\n", config: cfgJson("4761"), want: 4761 },
    { name: "export, double quotes, a comment", envFile: 'A=1\nexport STUDIO_PORT="4764"   # mine\n', want: 4764 },
    { name: "single quotes", envFile: "STUDIO_PORT='4765'\n", want: 4765 },
    { name: "blanks around = and the value, CRLF", envFile: "  STUDIO_PORT =  4766  \r\nB=2\r\n", want: 4766 },
    { name: "the last line wins", envFile: "STUDIO_PORT=4760\nSTUDIO_PORT=4767\n", want: 4767 },
    { name: "an unquoted value ends at #", envFile: "STUDIO_PORT=4768#note\n", want: 4768 },
    { name: "a longer key is another key", envFile: "STUDIO_PORTS=4000\nXSTUDIO_PORT=4001\n", want: 4747 },
    { name: "leading zeros", envFile: "STUDIO_PORT=04769\n", want: 4769 },
    { name: "STUDIO_ENV_FILE with ~/", env: { STUDIO_ENV_FILE: "~/other/studio.env" }, files: { "other/studio.env": "STUDIO_PORT=4770\n" }, envFile: "STUDIO_PORT=4762\n", want: 4770 },
    { name: "STUDIO_CONFIG from the env file", envFile: "STUDIO_CONFIG=~/cfg/mine.json\n", files: { "cfg/mine.json": JSON.stringify(cfgJson("4771")) }, config: cfgJson("4761"), want: 4771 },
    { name: "STUDIO_CONFIG from the process env beats the env file's", env: { STUDIO_CONFIG: "~/cfg/proc.json" }, envFile: "STUDIO_CONFIG=~/cfg/mine.json\n", files: { "cfg/mine.json": JSON.stringify(cfgJson("4771")), "cfg/proc.json": JSON.stringify(cfgJson("4772")) }, want: 4772 },
    { name: "an identity file's settings folder", repo: ownRepo, envFile: "STUDIO_PORT=4773\n", want: 4773 },
    { name: "STUDIO_IDENTITY=neutral ignores it", repo: ownRepo, env: { STUDIO_IDENTITY: "neutral" }, files: { [`${OWN.settings}/.env`]: "STUDIO_PORT=4773\n" }, want: 4747 },
    { name: "a config without STUDIO_PORT", config: { env: { STUDIO_DRIVE: "~/m" } }, want: 4747 },
    { name: "letters", envFile: "STUDIO_PORT=abc\n", want: "invalid" },
    { name: "zero", env: { STUDIO_PORT: "0" }, want: "invalid" },
    { name: "too big", envFile: "STUDIO_PORT=70000\n", want: "invalid" },
    { name: "a decimal", envFile: "STUDIO_PORT=4747.5\n", want: "invalid" },
    { name: "an exponent", envFile: "STUDIO_PORT=1e3\n", want: "invalid" },
    { name: "an empty config value", config: cfgJson(""), want: "invalid" },
  ];
  let n = 0;
  for (const c of cases) {
    const home = path.join(base, `home-${n++}`);
    const repo = c.repo ?? plainRepo;
    const env = c.env ?? {};
    const id = resolveIdentity(home, env, repo);
    fs.mkdirSync(id.settingsDir, { recursive: true });
    if (c.envFile != null) fs.writeFileSync(path.join(id.settingsDir, ".env"), c.envFile);
    if (c.config != null) fs.writeFileSync(path.join(id.settingsDir, "studio.config.json"), typeof c.config === "string" ? c.config : JSON.stringify(c.config));
    for (const [rel, text] of Object.entries(c.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), text);
    }
    let node: number | "invalid";
    try {
      node = loadConfig({ env, home, repoDir: repo }).port;
    } catch (e) {
      assert.match((e as Error).message, /STUDIO_PORT/, `${c.name}: node names the key`);
      node = "invalid";
    }
    assert.equal(node, c.want, `${c.name}: loadConfig`);
    for (const shell of SHELLS) {
      const r = spawnSync(shell, ["-c", '. "$1"; studio_port', "x", path.join(repo, "scripts", "studio-identity.sh")], {
        env: { NODE_ENV: process.env.NODE_ENV, HOME: home, PATH: BARE_PATH, ...env } as NodeJS.ProcessEnv,
        cwd: base,
        encoding: "utf8",
      });
      const got = r.status === 0 ? Number(r.stdout.trim()) : "invalid";
      assert.equal(got, node, `${c.name}: ${shell} (${r.stderr.trim()})`);
      if (got === "invalid") assert.match(r.stderr, /STUDIO_PORT/, `${c.name}: ${shell} says why`);
      else assert.equal(r.stdout, `${node}\n`, `${c.name}: ${shell} prints the port only`);
    }
  }
  ok(`STUDIO_PORT: scripts/studio-identity.sh studio_port equals loadConfig().port in bash and zsh for ${cases.length} temp homes (process env > env file > the Studio config's env > 4747; empty = unset; STUDIO_ENV_FILE / STUDIO_CONFIG from the environment or the env file; an identity file's settings folder and STUDIO_IDENTITY=neutral; dotenv's export / quotes / # / blanks / CRLF / last line rules); letters, 0, 70000, 4747.5, 1e3 and an empty config value refused by both, the shell saying why`);

  // STUDIO_BRAND_DIR through the same helper (the desktop app's icon).
  const brandCases: { name: string; env?: Record<string, string>; envFile?: string; config?: Record<string, unknown> }[] = [
    { name: "none" },
    { name: "the config's ./", config: { env: { STUDIO_BRAND_DIR: "./marks" } } },
    { name: "the env file's ~/", envFile: "STUDIO_BRAND_DIR=~/brand\n", config: { env: { STUDIO_BRAND_DIR: "./marks" } } },
    { name: "the process env", env: { STUDIO_BRAND_DIR: "/abs/brand" }, envFile: "STUDIO_BRAND_DIR=~/brand\n" },
  ];
  for (const c of brandCases) {
    const home = path.join(base, `home-${n++}`);
    const id = resolveIdentity(home, c.env ?? {}, plainRepo);
    fs.mkdirSync(id.settingsDir, { recursive: true });
    if (c.envFile) fs.writeFileSync(path.join(id.settingsDir, ".env"), c.envFile);
    if (c.config) fs.writeFileSync(path.join(id.settingsDir, "studio.config.json"), JSON.stringify(c.config));
    const want = loadConfig({ env: c.env ?? {}, home, repoDir: plainRepo }).brandDir;
    for (const shell of SHELLS) {
      const r = spawnSync(shell, ["-c", '. "$1"; v="$(studio_setting STUDIO_BRAND_DIR)" || exit 3; _studio_tilde "$v"', "x", path.join(plainRepo, "scripts", "studio-identity.sh")], {
        env: { NODE_ENV: process.env.NODE_ENV, HOME: home, PATH: BARE_PATH, ...(c.env ?? {}) } as NodeJS.ProcessEnv,
        cwd: base,
        encoding: "utf8",
      });
      assert.equal(r.status === 3 ? null : r.stdout.trim(), want, `brand ${c.name}: ${shell}`);
    }
  }
  ok("studio_setting STUDIO_BRAND_DIR (the desktop app's icon) equals loadConfig().brandDir: none, the config's ./ (its folder), the env file's ~/, the process env");

  // ---------------------------------------------------------------- launcher/start.sh (temp repo, made-up labels, stub installer)
  const port = await freePort();
  const home = path.join(base, "home-start");
  const id = resolveIdentity(home, {}, ownRepo);
  fs.mkdirSync(id.settingsDir, { recursive: true });
  fs.writeFileSync(path.join(id.settingsDir, ".env"), `STUDIO_PORT=${port}\n`);
  assert.equal(loadConfig({ env: {}, home, repoDir: ownRepo }).port, port);
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  try {
    const up = await run("/bin/zsh", [path.join(ownRepo, "launcher", "start.sh")], { env: { HOME: home, PATH: BARE_PATH }, cwd: base, timeoutMs: 30_000 });
    assert.equal(up.code, 0, up.stderr);
    assert.equal(up.stdout, `http://127.0.0.1:${port}/\n`, "start.sh prints the configured port's URL and nothing else");
    assert.deepEqual(hits, ["/api/status"], "it polled that port's status route");
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
  fs.writeFileSync(path.join(id.settingsDir, ".env"), "STUDIO_PORT=nope\n");
  const bad = await run("/bin/zsh", [path.join(ownRepo, "launcher", "start.sh")], { env: { HOME: home, PATH: BARE_PATH }, cwd: base, timeoutMs: 30_000 });
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, "", "no URL on a bad port");
  assert.match(fs.readFileSync(path.join(id.dataDir, "logs", "launcher.log"), "utf8"), /STUDIO_PORT \(nope\) is not a whole number/, "the reason goes to launcher.log");
  const applet = fs.readFileSync(path.join(REPO, "launcher", "studio.applescript"), "utf8");
  assert.doesNotMatch(applet, /127\.0\.0\.1:\d/, "the desktop app has no port built in");
  assert.match(applet, /set studioURL to do shell script/, "it opens the URL start.sh prints");
  for (const f of ["launcher/start.sh", "launcher/build_app.sh", "scripts/install-launchd.sh"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, f), "utf8").replace(/default 4747/g, ""), /4747/, `${f}: no fixed port`);
  }
  ok("launcher/start.sh (zsh, the applet's bare PATH): with STUDIO_PORT in the env file it polls that port and prints http://127.0.0.1:<port>/ as its only output (the desktop app opens it; no port in the applet, start.sh, build_app.sh or the installer); a bad port stops it before launchctl with the reason in launcher.log");

  // ---------------------------------------------------------------- tool paths: config
  assert.deepEqual([...TOOL_PATH_KEYS], ["FFMPEG_PATH", "FFPROBE_PATH", "HIGGSFIELD_BIN", "CODEX_BIN", "CLAUDE_BIN"]);
  for (const k of TOOL_PATH_KEYS) assert.ok(CONFIG_KEYS.includes(k), `${k} is a config key (documented, forced by the demo)`);
  const { CONFIG_ENV_KEYS, parseStudioText } = await import("../src/lib/studio-config");
  for (const k of TOOL_PATH_KEYS) assert.ok(!(CONFIG_ENV_KEYS as readonly string[]).includes(k), `${k} is not allowed in the Studio config's env`);
  assert.throws(() => parseStudioText(JSON.stringify({ env: { FFMPEG_PATH: "/x/ffmpeg" } })), "the Studio config refuses a tool path");
  const th = path.join(base, "home-tools");
  const tid = resolveIdentity(th, {}, plainRepo);
  fs.mkdirSync(tid.settingsDir, { recursive: true });
  const bin = path.join(th, "bin");
  fs.mkdirSync(bin);
  const stub = (name: string) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return fs.realpathSync(p);
  };
  const S = { ffmpeg: stub("ffmpeg"), ffprobe: stub("ffprobe"), hf: stub("higgsfield"), codex: stub("codex"), claude: stub("claude"), other: stub("other-ffmpeg") };
  const envText = `FFMPEG_PATH=~/bin/ffmpeg\nFFPROBE_PATH=${S.ffprobe}\nHIGGSFIELD_BIN=~/bin/higgsfield\nCODEX_BIN=~/bin/codex\nCLAUDE_BIN="~/bin/claude"\n`;
  fs.writeFileSync(path.join(tid.settingsDir, ".env"), envText);
  const realHomeBin = (name: string) => path.join(th, "bin", name);
  const tc = loadConfig({ env: {}, home: th, repoDir: plainRepo });
  assert.deepEqual(tc.toolPaths, { FFMPEG_PATH: realHomeBin("ffmpeg"), FFPROBE_PATH: S.ffprobe, HIGGSFIELD_BIN: realHomeBin("higgsfield"), CODEX_BIN: realHomeBin("codex"), CLAUDE_BIN: realHomeBin("claude") }, "the env file's values, ~/ expanded");
  const tp = loadConfig({ env: { FFMPEG_PATH: S.other, CODEX_BIN: "" }, home: th, repoDir: plainRepo });
  assert.equal(tp.toolPaths.FFMPEG_PATH, S.other, "the process env beats the env file");
  assert.equal(tp.toolPaths.CODEX_BIN, realHomeBin("codex"), "an empty process value = unset (the env file's)");
  assert.deepEqual(loadConfig({ env: {}, home: path.join(base, "home-none"), repoDir: plainRepo }).toolPaths, {}, "nothing set = each reader's own search");
  assert.throws(() => loadConfig({ env: { CLAUDE_BIN: "bin/claude" }, home: th, repoDir: plainRepo }), /CLAUDE_BIN must be an absolute path/, "a relative path is refused");
  assert.equal(loadConfig({ env: { FFMPEG_PATH: "ffmpeg" }, home: th, repoDir: plainRepo }).toolPaths.FFMPEG_PATH, "ffmpeg", "a bare command name is kept (spawn finds it on PATH)");
  const target: Record<string, string | undefined> = { FFMPEG_PATH: "/stale", CODEX_BIN: "", OTHER: "kept" };
  applyToolEnv({ toolPaths: { FFMPEG_PATH: "/a/ffmpeg", CLAUDE_BIN: "/a/claude" } }, target);
  assert.deepEqual(target, { FFMPEG_PATH: "/a/ffmpeg", CLAUDE_BIN: "/a/claude", OTHER: "kept" }, "applyToolEnv writes the set ones and removes the rest");
  ok("tool paths: FFMPEG_PATH / FFPROBE_PATH / HIGGSFIELD_BIN / CODEX_BIN / CLAUDE_BIN are config keys (env file + process env only; the Studio config's env refuses them), ~/ expanded, a process value beats the env file, empty = unset, a relative path refused, a bare command name kept; applyToolEnv writes the set ones and removes the others");

  // ---------------------------------------------------------------- tool paths reach the worker's readers (a child process)
  const tsx = path.join(REPO, "node_modules", ".bin", "tsx");
  const probe = path.join(base, "probe-tools.ts");
  const mod = (rel: string) => JSON.stringify(path.join(REPO, rel));
  fs.writeFileSync(
    probe,
    `import ${mod("src/worker/tool-env.ts")};\n` +
      `import { FFMPEG, FFPROBE } from ${mod("src/worker/proc.ts")};\n` +
      `import { resolveCodex, resolveHiggsfield } from ${mod("src/lib/gen/cli.ts")};\n` +
      `import { resolveClaude } from ${mod("src/lib/hooks/claude.ts")};\n` +
      `console.log(JSON.stringify({ FFMPEG, FFPROBE, hf: resolveHiggsfield()?.cmd ?? null, codex: resolveCodex()?.cmd ?? null, claude: resolveClaude()?.cmd ?? null }));\n`,
  );
  const childEnv = (extra: Record<string, string>): Record<string, string> => ({
    HOME: th,
    PATH: `${path.dirname(process.execPath)}:${BARE_PATH}`,
    STUDIO_IDENTITY: "neutral",
    STUDIO_ENV_FILE: path.join(tid.settingsDir, ".env"),
    ...extra,
  });
  const readers = async (extra: Record<string, string>) => {
    const r = await run(tsx, [probe], { env: childEnv(extra), cwd: base });
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop()!) as Record<string, string | null>;
  };
  assert.deepEqual(await readers({}), { FFMPEG: realHomeBin("ffmpeg"), FFPROBE: S.ffprobe, hf: S.hf, codex: S.codex, claude: S.claude }, "the env file's tool paths reach proc.ts (read at load) and the three resolvers");
  assert.deepEqual(await readers({ FFMPEG_PATH: S.other, STUDIO_ENGINES: "off" }), { FFMPEG: S.other, FFPROBE: S.ffprobe, hf: null, codex: null, claude: null }, "a process value wins; STUDIO_ENGINES=off still wins for the engines");
  assert.deepEqual(fs.readdirSync(th).sort(), [".studio", "bin"], "the worker bootstrap created nothing in its home");
  ok("worker: src/worker/tool-env.ts (the entry's first import) puts the env file's tool paths in place before proc.ts reads FFMPEG / FFPROBE at load and for resolveHiggsfield / resolveCodex / resolveClaude (a child process on a temp home); a process value wins; STUDIO_ENGINES=off still wins");

  // ---------------------------------------------------------------- ...and the Next server's environment (scripts/next.ts, stub next)
  const nextCwd = path.join(base, "next-cwd");
  fs.mkdirSync(path.join(nextCwd, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(nextCwd, "node_modules", ".bin", "next"), `#!/bin/sh\nprintf '%s|' "$*" "$FFMPEG_PATH" "$FFPROBE_PATH" "$HIGGSFIELD_BIN" "$CODEX_BIN" "$CLAUDE_BIN"; echo\n`, { mode: 0o755 });
  const data = path.join(base, "next-data");
  const nx = await run(tsx, [path.join(REPO, "scripts", "next.ts"), "start"], {
    env: childEnv({ STUDIO_DB: path.join(data, "s.db"), STUDIO_CACHE: path.join(data, "cache"), STUDIO_LOGS: path.join(data, "logs"), STUDIO_PORT: String(port), CODEX_BIN: S.other }),
    cwd: nextCwd,
  });
  assert.equal(nx.code, 0, nx.stderr);
  const line = nx.stdout.split("\n").find((l) => l.startsWith("start "))!;
  assert.deepEqual(line.split("|").slice(0, 6), [`start -H 127.0.0.1 -p ${port}`, realHomeBin("ffmpeg"), S.ffprobe, realHomeBin("higgsfield"), S.other, realHomeBin("claude")], "Next starts on the configured port with the env file's tool paths (a process value wins)");
  ok("web: scripts/next.ts hands the env file's tool paths (a process value wins) and STUDIO_PORT to the Next server it starts (a stub next on a temp home)");

  // ---------------------------------------------------------------- the demo forces them
  const demo = await import("./demo-env");
  const dv = demo.demoEnv({ repoDir: plainRepo, dataDir: path.join(base, "demo-data"), port: demo.DEMO_PORT, tmpDir: base });
  for (const k of TOOL_PATH_KEYS) assert.equal(dv[k], "", `the demo forces ${k} empty by default`);
  assert.equal(demo.demoEnv({ repoDir: plainRepo, dataDir: path.join(base, "demo-data"), port: demo.DEMO_PORT, tmpDir: base, ffmpegPath: S.ffmpeg }).FFMPEG_PATH, S.ffmpeg, "the caller's own ffmpeg (a shell value) passes through");
  const child = demo.demoChildEnv({ PATH: "/usr/bin", CLAUDE_BIN: S.claude, CODEX_BIN: S.codex, HIGGSFIELD_BIN: S.hf, FFMPEG_PATH: S.other }, dv);
  for (const k of TOOL_PATH_KEYS) assert.equal(child[k], "", `the demo child gets an empty ${k}`);
  ok("demo: demoEnv forces all five tool keys (engines empty and STUDIO_ENGINES=off; ffmpeg / ffprobe only from the caller's own process values), so an install's env file never reaches it");

  // ---------------------------------------------------------------- the whisper model default
  const wh = path.join(base, "home-whisper");
  fs.mkdirSync(wh);
  assert.equal(loadConfig({ env: {}, home: wh, repoDir: plainRepo }).whisperModel, path.join(wh, "Studio-Data", "models", "ggml-small.en.bin"));
  assert.equal(loadConfig({ env: {}, home: wh, repoDir: ownRepo }).whisperModel, path.join(wh, OWN.data, "models", "ggml-small.en.bin"), "follows the identity's data folder");
  assert.match(envTemplate(resolveIdentity(os.homedir(), { STUDIO_IDENTITY: "neutral" }, plainRepo)), /^# STUDIO_WHISPER_MODEL=~\/Studio-Data\/models\/ggml-small\.en\.bin$/m);
  assert.deepEqual(fs.readdirSync(wh), [], "nothing created");
  ok("whisper: the neutral STUDIO_WHISPER_MODEL is <data dir>/models/ggml-small.en.bin (the identity's data folder; the env template says so)");
}

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
}

if (isMain()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-launch-"));
  let count = 0;
  runLaunchSmoke({ tmp, ok: (m) => console.log(`ok ${++count} ${m}`) })
    .then(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`smoke-launch: PASS (${count} checks)`);
    })
    .catch((e) => {
      console.error("smoke-launch: FAIL");
      console.error(e);
      console.error(`(left temp dir for inspection: ${tmp})`);
      process.exit(1);
    });
}
