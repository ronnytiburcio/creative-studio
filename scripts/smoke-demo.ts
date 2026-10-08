/**
 * Creative Studio Phase 2 (the demo pack) smoke checks (called by scripts/smoke.ts): the demo config, the committed media
 * vs make-demo, the demo env file, the port refusal, the identity switch (+ its shell twin), the engines switch, the
 * isolation from an install's identity / env file / config (temp repo + temp home with a fake key, every file read
 * recorded) and the sample data insert (scripts/demo.ts --setup-only twice on a temp data folder: idempotent, no paid or
 * network call rows). Temp folders only; never the real home, the live DB or a port.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { StudioConfig } from "../src/lib/config";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const REPO = process.cwd();

export async function runDemoSmoke({ tmp, ok }: Ctx) {
  const base = path.join(tmp, "demo");
  fs.mkdirSync(base);
  const { parseStudioText } = await import("../src/lib/studio-config");
  const { parseEnvText } = await import("../src/lib/envfile");
  const config = await import("../src/lib/config");
  const make = await import("./make-demo");
  const env = await import("./demo-env");

  // ---------------------------------------------------------------- the demo config
  const demoConfigText = fs.readFileSync(path.join(REPO, "demo", "studio.config.json"), "utf8");
  const studio = parseStudioText(demoConfigText);
  assert.match(studio.app?.name ?? "", /\(demo\)$/, "the app name says demo (the visible marker)");
  assert.equal(studio.lanes?.fkb?.enabled, false, "Lane C is off in the demo");
  assert.equal(studio.clients?.length, 3);
  assert.deepEqual(studio.clients!.filter((c) => c.metaAdAccount).map((c) => c.metaAdAccount), ["act_100000000000021", "act_100000000000022"], "two made-up ad accounts");
  assert.ok(studio.clients!.every((c) => (c.leads ?? "meta") === "meta"), "Meta leads only: no GHL read");
  assert.equal(studio.env, undefined, "the demo config sets no env defaults (demo-env forces every key)");
  ok("demo/studio.config.json parses: app name \"... (demo)\", Lane A on, Lane C off, 3 made-up clients (2 with made-up act ids, Meta leads), no env section");

  // ---------------------------------------------------------------- the media vs make-demo
  const media = make.listFiles(make.DEMO_MEDIA_DIR);
  assert.deepEqual(media, make.DEMO_FILES, "demo/media holds exactly the files make-demo makes");
  const committed = make.manifestOf(make.DEMO_MEDIA_DIR);
  assert.deepEqual(committed, make.readManifest(), "demo/media matches demo/manifest.json (bytes + sha256)");
  assert.ok(committed.totalBytes < make.DEMO_MAX_BYTES, "under 5 MB");
  assert.ok(media.length >= 18 && media.length <= 24, "about 20 files");
  const regen = path.join(base, "regen");
  await make.makeDemoMedia(regen);
  const fresh = make.manifestOf(regen);
  assert.deepEqual(fresh.files.map((f) => f.path), committed.files.map((f) => f.path), "same list");
  const sizeOff = fresh.files.filter((f, i) => Math.abs(f.bytes - committed.files[i].bytes) > committed.files[i].bytes * 0.25);
  assert.deepEqual(sizeOff.map((f) => f.path), [], "every regenerated file within 25% of the committed size");
  const identical = fresh.files.filter((f, i) => f.sha256 === committed.files[i].sha256).length;
  fs.rmSync(regen, { recursive: true, force: true });
  ok(`demo/media = make-demo's list (${media.length} files, ${(committed.totalBytes / 1024 / 1024).toFixed(2)} MB < 5 MB) and demo/manifest.json; regenerated here: same list and sizes, ${identical} of ${media.length} byte identical`);

  // ---------------------------------------------------------------- the demo env file holds no key
  const demoEnvText = fs.readFileSync(path.join(REPO, "demo", ".env"), "utf8");
  const parsed = parseEnvText(demoEnvText);
  assert.deepEqual(Object.keys(parsed), ["STUDIO_DRIVE_MODE"], "only a drive mode line");
  assert.ok(!/(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S/i.test(demoEnvText), "no key, token or secret value");
  ok("demo/.env: no key, token or secret (only STUDIO_DRIVE_MODE=folder)");

  // ---------------------------------------------------------------- the port refusal
  assert.equal(env.demoPortProblem(env.DEMO_PORT), null);
  for (const p of [4747, 4748]) assert.match(env.demoPortProblem(p) ?? "", /real install/);
  assert.ok(env.demoPortProblem(80) && env.demoPortProblem(70000) && env.demoPortProblem(4750.5));
  const tsx = path.join(REPO, "node_modules", ".bin", "tsx");
  for (const p of ["4747", "4748"]) {
    const data = path.join(base, `refused-${p}`);
    const r = spawnSync(tsx, ["scripts/demo.ts", "--setup-only", "--port", p, "--data", data], { cwd: REPO, encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /belongs to a real install/);
    assert.equal(fs.existsSync(data), false, "nothing created");
  }
  ok("scripts/demo.ts refuses ports 4747 / 4748 (exit 2, before anything is created); the demo port is 4750");

  // ---------------------------------------------------------------- the data folder guard
  const home0 = (await import("node:os")).homedir();
  const id0 = config.resolveIdentity(home0, { STUDIO_IDENTITY: "" });
  const occupied = path.join(base, "occupied");
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, "keep.txt"), "not the demo's");
  const marked = path.join(base, "marked");
  fs.mkdirSync(marked);
  fs.writeFileSync(path.join(marked, "DEMO-DATA"), "x");
  fs.writeFileSync(path.join(marked, "studio.db"), "");
  const refusals: [string, RegExp][] = [
    [occupied, /not empty and was not made by the demo/],
    [path.join(REPO, "scripts", "demo-data-x"), /inside the repo/],
    [path.join(REPO, ".demo-data-other"), /inside the repo/],
    [path.join(home0, "Studio-Data", "demo-x"), /install's folder/],
    [path.join(home0, ".studio", "demo-x"), /install's folder/],
    [path.join(id0.dataDir, "demo-x"), /install's folder/],
    [path.join(id0.settingsDir, "demo-x"), /install's folder/],
    [path.dirname(REPO), /holds the repo|not empty/],
  ];
  for (const [dir, why] of refusals) {
    const existed = fs.existsSync(dir);
    assert.match(env.demoDataProblem(dir, { repoDir: REPO, protect: [id0.dataDir, id0.settingsDir, path.join(home0, "Studio-Data"), path.join(home0, ".studio")] }) ?? "", why, dir);
    const r = spawnSync(tsx, ["scripts/demo.ts", "--setup-only", "--data", dir], { cwd: REPO, encoding: "utf8" });
    assert.equal(r.status, 2, `${dir}: ${r.stderr}`);
    assert.equal(fs.existsSync(dir), existed, `${dir}: nothing created`);
  }
  assert.deepEqual(fs.readdirSync(occupied), ["keep.txt"], "an occupied folder is left alone");
  assert.equal(env.demoDataProblem(marked, { repoDir: REPO, protect: [] }), null, "a folder the demo made can be reused");
  assert.equal(env.demoDataProblem(path.join(base, "new-data"), { repoDir: REPO, protect: [] }), null, "a new folder is fine");
  assert.equal(env.demoDataProblem(env.demoDataDir(REPO), { repoDir: REPO, protect: [] }), null, ".demo-data is fine");
  const noSetup = spawnSync(tsx, ["scripts/demo.ts", "--data", path.join(base, "new-data")], { cwd: REPO, encoding: "utf8" });
  assert.equal(noSetup.status, 2);
  assert.match(noSetup.stderr, /--data works with --setup-only only/);
  ok("--data refuses (exit 2, nothing created or touched): a non-empty folder without the DEMO-DATA marker, a folder inside the repo other than .demo-data, a folder holding the repo, and the install's data / settings folders (this repo's identity and the neutral ones) or anything inside them; a marked or new folder is accepted; --data needs --setup-only");

  // ---------------------------------------------------------------- the demo's own build folder
  const distOf = (v: string | undefined) =>
    spawnSync(tsx, ["-e", "import c from './next.config'; console.log(c.distDir)"], { cwd: REPO, encoding: "utf8", env: { ...process.env, STUDIO_DIST_DIR: v ?? "" } });
  assert.equal(distOf(undefined).stdout.trim(), ".next", "unset = .next (a real install)");
  assert.equal(distOf(env.DEMO_DIST_DIR).stdout.trim(), ".demo-data/next");
  for (const badDir of ["../out", "/tmp/x", ".demo-data/../x", "./x", "a//b"]) assert.notEqual(distOf(badDir).status, 0, badDir);
  assert.equal(env.demoEnv({ repoDir: REPO, dataDir: base, port: env.DEMO_PORT }).STUDIO_DIST_DIR, env.DEMO_DIST_DIR);
  const { getTypeDefinitionGlobPatterns } = (await import("next/dist/lib/typescript/type-paths.js")) as { getTypeDefinitionGlobPatterns: (d: string) => string[] };
  const tsconfig = JSON.parse(fs.readFileSync(path.join(REPO, "tsconfig.json"), "utf8")) as { include: string[]; exclude: string[] };
  for (const pat of getTypeDefinitionGlobPatterns(env.DEMO_DIST_DIR)) assert.ok(tsconfig.include.includes(pat), `tsconfig include has ${pat}`);
  assert.ok(tsconfig.exclude.includes(".demo-data"));
  ok("STUDIO_DIST_DIR: unset = .next; the demo builds into .demo-data/next; outside / absolute / dotted paths fail; tsconfig.json already lists the demo build's type globs (Next's own list), so a demo build never edits it");

  // ---------------------------------------------------------------- the identity switch (+ the shell twin)
  const OWN = "STUDIO_ID_SETTINGS=.owner-studio\nSTUDIO_ID_DATA=Owner-Studio\nSTUDIO_ID_LABEL_PREFIX=com.example.owner\nSTUDIO_ID_APP_NAME=Owner Studio\nSTUDIO_ID_SLUG=owner-studio\n";
  const repo = path.join(base, "repo");
  fs.mkdirSync(path.join(repo, "private"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "demo"), { recursive: true });
  fs.writeFileSync(path.join(repo, "private", "identity.env"), OWN);
  fs.copyFileSync(path.join(REPO, "scripts", "studio-identity.sh"), path.join(repo, "scripts", "studio-identity.sh"));
  fs.copyFileSync(path.join(REPO, "demo", ".env"), path.join(repo, "demo", ".env"));
  fs.writeFileSync(path.join(repo, "demo", "studio.config.json"), demoConfigText);
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  const cases: [Record<string, string>, boolean][] = [
    [{}, true],
    [{ STUDIO_IDENTITY: "" }, true],
    [{ STUDIO_IDENTITY: "auto" }, true],
    [{ STUDIO_IDENTITY: "neutral" }, false],
    [{ STUDIO_IDENTITY: " neutral " }, false],
    [{ STUDIO_IDENTITY: "nuetral" }, false],
  ];
  for (const [e, legacy] of cases) {
    const id = config.resolveIdentity(home, e, repo);
    assert.equal(id.legacy, legacy, JSON.stringify(e));
    assert.equal(id.appName, legacy ? "Owner Studio" : "Creative Studio");
    for (const shell of ["/bin/bash", "/bin/zsh"]) {
      const r = spawnSync(shell, ["-c", `. "$1"; printf '%s\\n' "$STUDIO_APP_NAME" "$STUDIO_SETTINGS_DIR" "$STUDIO_DATA_DIR" "$STUDIO_LABEL_WEB" "$STUDIO_SLUG"`, "x", path.join(repo, "scripts", "studio-identity.sh")], {
        env: { NODE_ENV: process.env.NODE_ENV, HOME: home, PATH: "/usr/bin:/bin", ...e } as NodeJS.ProcessEnv,
        encoding: "utf8",
        cwd: base,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.trimEnd().split("\n"), [id.appName, id.settingsDir, id.dataDir, id.launchdLabels.web, id.slug], `${shell} ${JSON.stringify(e)}`);
    }
  }
  ok("STUDIO_IDENTITY: unset / empty / auto = the repo's identity file, neutral (or any other value, a typo included) = never read it; scripts/studio-identity.sh agrees in bash and zsh");

  // ---------------------------------------------------------------- the engines switch
  const cli = await import("../src/lib/gen/cli");
  const claude = await import("../src/lib/hooks/claude");
  assert.equal(cli.enginesOff({ STUDIO_ENGINES: "off" }), true);
  assert.equal(cli.enginesOff({ STUDIO_ENGINES: "OFF " }), true);
  assert.equal(cli.enginesOff({}), false);
  const stub = path.join(base, "engine-stub");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const saved = { HIGGSFIELD_BIN: process.env.HIGGSFIELD_BIN, CODEX_BIN: process.env.CODEX_BIN, CLAUDE_BIN: process.env.CLAUDE_BIN, STUDIO_ENGINES: process.env.STUDIO_ENGINES };
  try {
    Object.assign(process.env, { HIGGSFIELD_BIN: stub, CODEX_BIN: stub, CLAUDE_BIN: stub });
    delete process.env.STUDIO_ENGINES;
    assert.ok(cli.resolveHiggsfield() && claude.resolveClaude(), "a stub binary resolves normally");
    process.env.STUDIO_ENGINES = "off";
    assert.equal(cli.resolveHiggsfield(), null);
    assert.equal(cli.resolveCodex(), null);
    assert.equal(claude.resolveClaude(), null);
    assert.deepEqual(await claude.claudeAuthStatus(), { installed: false, signedIn: null, method: null }, "Settings > Claude sees no CLI");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  ok("STUDIO_ENGINES=off: Higgsfield, Codex and claude never resolve (even with *_BIN set or installed CLIs), so the demo cannot reach them");

  // ---------------------------------------------------------------- isolation from an install (temp repo + temp home)
  // The temp repo carries an identity file pointing at the temp home's settings folder, whose env file holds a FAKE key and
  // points at an "owner" config and DB. Resolving the demo's config must never read anything under that home.
  const ownerSettings = path.join(home, ".owner-studio");
  fs.mkdirSync(ownerSettings, { recursive: true });
  const FAKE = "fake-demo-isolation-key-0000";
  fs.writeFileSync(path.join(ownerSettings, "studio.config.json"), JSON.stringify({ app: { name: "Owner Install" } }));
  fs.writeFileSync(
    path.join(ownerSettings, ".env"),
    `TYPESAFE_API_KEY=${FAKE}\nSTUDIO_CONFIG=${path.join(ownerSettings, "studio.config.json")}\nSTUDIO_DB=${path.join(home, "Owner-Studio", "owner.db")}\nSTUDIO_PORT=4747\n`,
  );
  const owner = config.loadConfig({ env: {}, home, repoDir: repo });
  assert.equal(config.readTypesafeKey(owner), FAKE, "control: without the demo env the install's env file (and its key) is read");
  assert.equal(owner.appName, "Owner Install");
  const dataDir = path.join(base, "data");
  const demoVars = env.demoEnv({ repoDir: repo, dataDir, port: env.DEMO_PORT, tmpDir: base });
  const reads: string[] = [];
  const realRead = fs.readFileSync;
  const realStat = fs.statSync;
  const realExists = fs.existsSync;
  const record = (p: unknown) => {
    if (typeof p === "string") reads.push(path.resolve(p));
  };
  let demoCfg: StudioConfig;
  try {
    (fs as { readFileSync: unknown }).readFileSync = (p: unknown, ...rest: unknown[]) => (record(p), (realRead as (...a: unknown[]) => unknown)(p, ...rest));
    (fs as { statSync: unknown }).statSync = (p: unknown, ...rest: unknown[]) => (record(p), (realStat as (...a: unknown[]) => unknown)(p, ...rest));
    (fs as { existsSync: unknown }).existsSync = (p: unknown) => (record(p), realExists(p as string));
    demoCfg = config.loadConfig({ env: demoVars, home, repoDir: repo });
    assert.equal(config.readTypesafeKey(demoCfg), null, "the demo env file has no key");
    assert.equal(config.keyStatus(demoCfg).typesafe, false);
  } finally {
    (fs as { readFileSync: unknown }).readFileSync = realRead;
    (fs as { statSync: unknown }).statSync = realStat;
    (fs as { existsSync: unknown }).existsSync = realExists;
  }
  assert.deepEqual(reads.filter((p) => p === home || p.startsWith(home + path.sep)), [], "nothing under the install's home was read");
  assert.ok(!reads.includes(path.join(repo, "private", "identity.env")), "the identity file was not read");
  assert.ok(reads.includes(path.join(repo, "demo", ".env")) && reads.includes(path.join(repo, "demo", "studio.config.json")));
  assert.equal(demoCfg.appName, "Creative Studio (demo)");
  assert.equal(demoCfg.envFile, path.join(repo, "demo", ".env"));
  assert.equal(demoCfg.dbPath, path.join(dataDir, "studio.db"));
  assert.equal(demoCfg.port, 4750);
  assert.equal(demoCfg.driveMode, "folder");
  assert.equal(demoCfg.drivePath, path.join(repo, "demo", "media"));
  for (const p of [demoCfg.cacheDir, demoCfg.logsDir, demoCfg.handoffsDir, demoCfg.metaEnvFile, demoCfg.metaFkbEnvFile, demoCfg.youtubeClientSecretFile, demoCfg.youtubeTokenFile, demoCfg.clientDocsDir, demoCfg.reelKitDir, demoCfg.whisperBin, demoCfg.universalRegistry]) {
    assert.ok(p.startsWith(dataDir + path.sep), `${p} inside the demo data folder`);
  }
  assert.equal(demoCfg.ollamaUrl, env.DEMO_OLLAMA_URL);
  assert.equal(demoCfg.brandDir, null, "the built-in generic marks");
  const unforced = config.CONFIG_KEYS.filter((key) => !(key in demoVars));
  assert.deepEqual(unforced, [], "demoEnv sets every key the config reads (config.ts CONFIG_KEYS)");
  assert.ok(demoCfg.pendingDirs.fkbpros.startsWith(base + path.sep) && demoCfg.pendingDirs.fkb.startsWith(base + path.sep), "order folders under the temp folder");
  const child = env.demoChildEnv({ PATH: "/usr/bin", HOME: home, STUDIO_DB: "/x.db", META_ENV_FILE: "/m.env", YOUTUBE_TOKEN_FILE: "/t.json", TYPESAFE_API_KEY: "k", CLAUDE_BIN: "/c", HIGGSFIELD_BIN: "/h", STUDIO_BRAND_DIR: "/b" }, demoVars);
  assert.equal(child.STUDIO_DB, path.join(dataDir, "studio.db"));
  assert.equal(child.TYPESAFE_API_KEY, undefined, "TYPESAFE_API_KEY");
  // The engine paths are config keys (Phase 4b): the demo forces them empty (= unset), so an inherited one never survives.
  for (const k of ["CLAUDE_BIN", "HIGGSFIELD_BIN"]) assert.equal(child[k], "", k);
  assert.equal(child.STUDIO_BRAND_DIR, "", "an inherited brand folder is replaced by the demo's empty value");
  assert.equal(child.PATH, "/usr/bin");
  ok("isolation: in a temp repo WITH an identity file and a temp home whose env file holds a fake key + its own config / DB / port, the demo env resolves the demo's app name, demo/.env (no key), the demo config, port 4750, folder mode and every path inside the demo data folder, reading NOTHING under that home and not the identity file (control: without it the fake key is read); inherited STUDIO_ / META_ / YOUTUBE_ / key / engine variables are dropped");

  // ---------------------------------------------------------------- the sample data (the real script, twice)
  const setupData = path.join(base, "setup-data");
  const runSetup = () => {
    const r = spawnSync(tsx, ["scripts/demo.ts", "--setup-only", "--data", setupData], { cwd: REPO, encoding: "utf8", env: { ...process.env, STUDIO_DB: "/nonexistent/should-be-dropped.db", HIGGSFIELD_BIN: "/nonexistent" } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
      appName: string;
      identityLegacy: boolean;
      dbPath: string;
      envFile: string;
      seeded: { seeded: boolean; hooksScored: number };
      counts: Record<string, number>;
    };
  };
  const first = runSetup();
  const second = runSetup();
  const withIdentity = fs.existsSync(path.join(REPO, "private", "identity.env"));
  assert.equal(first.appName, "Creative Studio (demo)");
  assert.equal(first.identityLegacy, false, "the identity file is ignored (this repo may carry one)");
  assert.equal(first.dbPath, path.join(setupData, "studio.db"));
  assert.equal(first.envFile, path.join(REPO, "demo", ".env"));
  assert.equal(first.seeded.seeded, true);
  assert.ok(first.seeded.hooksScored >= 30);
  assert.equal(second.seeded.seeded, false, "the one-time part runs once");
  assert.deepEqual(second.counts, first.counts, "a second run adds nothing");
  for (const t of ["ai_calls", "meta_calls", "yt_calls"]) assert.equal(first.counts[t], 0, `${t}: no paid / network call`);
  const c = first.counts;
  assert.ok(c.assets === make.DEMO_FILES.length - 1 && c.descriptions === c.assets, "every demo media file indexed + described");
  assert.ok(c.hooks >= 33 && c.hook_scores === c.hooks, "every hook scored (fixed demo answers)");
  assert.equal(c.episodes, 1);
  assert.equal(c.shorts, 6);
  assert.equal(c.ads, 8);
  assert.equal(c.channel_metrics, 8);
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(first.dbPath, { readonly: true });
  try {
    assert.equal(db.prepare("select count(*) from hook_scores where model <> 'demo'").pluck().get(), 0, "every score is marked demo");
    assert.ok(db.prepare("select value from app_settings where key = 'demo:seeded_at'").pluck().get());
    for (const k of ["describe:paused", "classify:paused", "hooks:paused", "meta:paused", "youtube:paused"]) assert.equal(db.prepare("select value from app_settings where key = ?").pluck().get(k), "1", k);
    assert.deepEqual(db.prepare("select distinct status from shorts order by status").pluck().all(), ["cutting", "idea", "review"]);
    assert.equal(db.prepare("select count(*) from hooks where score_requested_at is not null").pluck().get(), 0, "nothing waits for Jev");
    assert.deepEqual(db.prepare("select act_id from ad_accounts where last_sync_at is not null order by act_id").pluck().all(), ["act_100000000000021", "act_100000000000022"], "the two demo accounts, marked synced (the bike shop and the switched off Lane C have none)");
    assert.equal(db.prepare("select count(*) from ad_accounts").pluck().get(), 2);
  } finally {
    db.close();
  }
  ok(`sample data: scripts/demo.ts --setup-only twice on a temp data folder${withIdentity ? " in this repo (which carries an install identity file)" : ""}: app name "(demo)", identity ignored, the demo DB, ${c.assets} files indexed + described, ${c.hooks} hooks all scored (model demo), 1 episode + 6 cards, 8 ads / ${c.ad_metrics} daily rows / 8 channel rows, every queue paused; the second run adds nothing; ai_calls / meta_calls / yt_calls empty`);
}
