/**
 * Creative Studio slice 1a smoke checks (called by scripts/smoke.ts after the page scorer checks): STUDIO_DRIVE_MODE
 * and the install identity. Folder mode (a readable folder = mounted; missing, unreadable or a file = not), external
 * mode unchanged (a plain temp folder sits on its parent's device = not mounted), STUDIO_FAKE_UNMOUNTED in both modes,
 * the mode-aware wording, roots + the WriteGuard on a folder-mode drive (writes only inside Studio Generated), the
 * identity resolver on temp homes with and without a made-up identity file in temp repos (never the real home), loadConfig's
 * precedence (process env > env file > identity defaults) and scripts/studio-identity.sh agreeing with resolveIdentity.
 * Temp folders only: never the live DB, the real env file or the media drive.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

export async function runStudioDefaultsSmoke({ cfg, tmp, ok }: Ctx) {
  const { isDriveMounted, driveMounted, rootAccessible } = await import("../src/lib/fsguard");
  const config = await import("../src/lib/config");
  const { resolveIdentity, loadConfig, notMountedMessage, driveWords, IDENTITY, NEUTRAL_ID } = config;
  const { WriteGuardError, writeGuardFor } = await import("../src/lib/writeguard");
  const { GENERATED_DIRNAME } = await import("../src/lib/gen/layout");

  const base = path.join(tmp, "studio-defaults");
  fs.mkdirSync(base);

  // ---------------------------------------------------------------- folder mode vs external mode
  const folder = path.join(base, "media");
  fs.mkdirSync(path.join(folder, "Clips"), { recursive: true });
  const missing = path.join(base, "no-such-folder");
  const file = path.join(base, "a-file");
  fs.writeFileSync(file, "x");
  const locked = path.join(base, "locked");
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  const root = process.getuid?.() === 0; // root reads anything: the unreadable case only holds for a normal user

  assert.equal(isDriveMounted(folder, false, "folder"), true, "folder mode: a readable folder is mounted");
  assert.equal(isDriveMounted(missing, false, "folder"), false, "folder mode: missing = not mounted");
  assert.equal(isDriveMounted(file, false, "folder"), false, "folder mode: a file = not mounted");
  if (!root) assert.equal(isDriveMounted(locked, false, "folder"), false, "folder mode: unreadable = not mounted");
  assert.equal(isDriveMounted(folder, true, "folder"), false, "folder mode: STUDIO_FAKE_UNMOUNTED wins");
  assert.equal(isDriveMounted(folder, false, "external"), false, "external: same device as the parent = not mounted");
  assert.equal(isDriveMounted(missing, false, "external"), false);
  assert.equal(isDriveMounted(file, false, "external"), false);
  assert.equal(isDriveMounted(folder, true, "external"), false, "external: STUDIO_FAKE_UNMOUNTED");
  fs.chmodSync(locked, 0o700);

  const folderCfg = { drivePath: folder, fakeUnmounted: false, driveMode: "folder" as const };
  const externalCfg = { ...folderCfg, driveMode: "external" as const };
  assert.equal(driveMounted(folderCfg), true);
  assert.equal(driveMounted(externalCfg), false);
  assert.equal(driveMounted({ ...folderCfg, fakeUnmounted: true }), false);
  assert.equal(cfg.driveMode, "external", "the main smoke runs in external mode (its stand-in drive is a plain folder)");
  assert.equal(rootAccessible(path.join(folder, "Clips"), folder, driveMounted(folderCfg)), true, "folder mode: a root under it is readable");
  assert.equal(rootAccessible(path.join(folder, "Clips"), folder, driveMounted(externalCfg)), false, "external: the same root waits for the drive");
  ok("STUDIO_DRIVE_MODE: folder = an existing, readable directory (missing / unreadable / a file = not); external keeps the device check; STUDIO_FAKE_UNMOUNTED forces not mounted in both; roots follow");

  // ---------------------------------------------------------------- wording
  const label = path.basename(folder);
  assert.equal(notMountedMessage({ drivePath: folder, driveMode: "external" }), `${label} is not mounted.`);
  assert.equal(notMountedMessage({ drivePath: folder, driveMode: "folder" }), `${label} is not available.`);
  assert.equal(driveWords("external").needs(label), `Needs ${label} mounted`);
  assert.equal(driveWords("folder").needs(label), `Needs the ${label} folder`);
  assert.doesNotMatch(Object.values(driveWords("folder")).map((v) => (typeof v === "function" ? v(label) : v)).join(" "), /plug|mount/i);
  ok("drive wording by mode: external says mounted / plugged in, folder says available (never plug / mount)");

  // ---------------------------------------------------------------- WriteGuard on a folder-mode drive
  const guard = writeGuardFor(folderCfg);
  const genBase = path.join(folder, GENERATED_DIRNAME);
  guard.ensureDir(path.join(genBase, "Lane"));
  guard.writeNewFile(path.join(genBase, "Lane", "out.txt"), "made");
  assert.equal(fs.readFileSync(path.join(genBase, "Lane", "out.txt"), "utf8"), "made");
  assert.throws(() => guard.writeNewFile(path.join(folder, "Clips", "x.txt"), "x"), WriteGuardError, "outside Studio Generated");
  assert.throws(() => guard.writeNewFile(path.join(base, "x.txt"), "x"), WriteGuardError, "outside the folder");
  assert.throws(() => guard.writeNewFile(`${genBase}/Lane/../../escape.txt`, "x"), WriteGuardError);
  assert.throws(() => guard.ensureDir(path.join(folder, "Elsewhere")), WriteGuardError);
  assert.throws(() => writeGuardFor(externalCfg).writeNewFile(path.join(genBase, "Lane", "y.txt"), "y"), WriteGuardError, "external: a plain folder is unplugged");
  assert.throws(() => writeGuardFor({ ...folderCfg, fakeUnmounted: true }).ensureDir(path.join(genBase, "Other")), WriteGuardError);
  assert.deepEqual(fs.readdirSync(path.join(folder, "Clips")), []);
  assert.deepEqual(fs.readdirSync(base).sort(), ["a-file", "locked", "media"]);
  assert.deepEqual(fs.readdirSync(genBase), ["Lane"]);
  ok("WriteGuard on a folder-mode drive: writes inside Studio Generated, refuses the rest of the folder, outside it, .., unmounted / external / fake unmounted");

  // ---------------------------------------------------------------- the identity resolver (temp repos + homes only)
  // A made-up install identity in a temp repo's private/identity.env; HOME no longer decides anything.
  const OWN = { settings: ".acme-studio", data: "Acme-Studio", labelPrefix: "com.example.acme", appName: "Acme Studio", slug: "acme-studio" };
  const freshHome = path.join(base, "home-fresh");
  const legacyHome = path.join(base, "home-legacy");
  fs.mkdirSync(freshHome);
  fs.mkdirSync(path.join(legacyHome, OWN.settings), { recursive: true });
  const repoOf = (name: string, identity: string | null, asDir = false) => {
    const r = path.join(base, name);
    fs.mkdirSync(path.join(r, "private"), { recursive: true });
    fs.mkdirSync(path.join(r, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), "scripts", "studio-identity.sh"), path.join(r, "scripts", "studio-identity.sh"));
    if (asDir) fs.mkdirSync(path.join(r, "private", "identity.env"));
    else if (identity != null) fs.writeFileSync(path.join(r, "private", "identity.env"), identity);
    return r;
  };
  const ownText = `# made up\nSTUDIO_ID_SETTINGS=${OWN.settings}\nSTUDIO_ID_DATA="${OWN.data}"\nSTUDIO_ID_LABEL_PREFIX=${OWN.labelPrefix}\nSTUDIO_ID_APP_NAME=${OWN.appName}   # a note\nexport FOO=bar\nSTUDIO_ID_SLUG='${OWN.slug}'\n`;
  const plainRepo = repoOf("repo-plain", null);
  const ownRepo = repoOf("repo-own", ownText);
  const badRepo = repoOf("repo-bad", "STUDIO_ID_SETTINGS=../escape\nSTUDIO_ID_DATA=..\nSTUDIO_ID_LABEL_PREFIX=nodots\nSTUDIO_ID_APP_NAME=Ok Name\nSTUDIO_ID_SLUG=Bad Slug\n");
  const dirRepo = repoOf("repo-dir", null, true);

  const fresh = resolveIdentity(legacyHome, {}, plainRepo);
  assert.deepEqual(fresh, {
    legacy: false,
    slug: NEUTRAL_ID.slug,
    appName: "Creative Studio",
    settingsDir: path.join(legacyHome, ".studio"),
    dataDir: path.join(legacyHome, "Studio-Data"),
    envFile: path.join(legacyHome, ".studio", ".env"),
    launchdLabels: { web: "com.studio.web", worker: "com.studio.worker" },
  }, "no identity file = neutral, whatever folders the home holds");
  const own = resolveIdentity(legacyHome, {}, ownRepo);
  assert.deepEqual(own, {
    legacy: true,
    slug: OWN.slug,
    appName: OWN.appName,
    settingsDir: path.join(legacyHome, OWN.settings),
    dataDir: path.join(legacyHome, OWN.data),
    envFile: path.join(legacyHome, OWN.settings, ".env"),
    launchdLabels: { web: `${OWN.labelPrefix}.web`, worker: `${OWN.labelPrefix}.worker` },
  }, "the identity file's values (quotes, an inline comment and other keys handled like dotenv)");
  const bad = resolveIdentity(freshHome, {}, badRepo);
  assert.deepEqual([bad.legacy, bad.settingsDir, bad.dataDir, bad.launchdLabels.web, bad.appName, bad.slug], [true, path.join(freshHome, ".studio"), path.join(freshHome, "Studio-Data"), "com.studio.web", "Ok Name", NEUTRAL_ID.slug], "a bad value keeps the neutral one");
  assert.equal(resolveIdentity(freshHome, {}, dirRepo).legacy, false, "a FOLDER named identity.env is no identity file");
  assert.equal(resolveIdentity(legacyHome, { STUDIO_ENV_FILE: "~/elsewhere.env" }, ownRepo).envFile, path.join(legacyHome, "elsewhere.env"), "STUDIO_ENV_FILE wins");
  assert.equal(resolveIdentity(freshHome, { STUDIO_ENV_FILE: "" }, plainRepo).envFile, path.join(freshHome, ".studio", ".env"), "an empty STUDIO_ENV_FILE = unset");
  assert.deepEqual(fs.readdirSync(freshHome), [], "resolving creates nothing");
  assert.equal(typeof IDENTITY.appName, "string");
  ok("identity: neutral defaults (~/.studio, ~/Studio-Data, com.studio.*, Creative Studio) unless the repo's private/identity.env gives others (dotenv rules, every value checked, a bad one stays neutral; HOME decides nothing), STUDIO_ENV_FILE overrides, nothing created");

  // ---------------------------------------------------------------- loadConfig: defaults + precedence
  const plain = loadConfig({ home: freshHome, env: {}, repoDir: plainRepo });
  assert.equal(plain.dbPath, path.join(freshHome, "Studio-Data", "studio.db"));
  assert.equal(plain.cacheDir, path.join(freshHome, "Studio-Data", "cache"));
  assert.equal(plain.logsDir, path.join(freshHome, "Studio-Data", "logs"));
  assert.equal(plain.handoffsDir, path.join(freshHome, "Studio-Data", "handoffs"));
  assert.equal(plain.youtubeTokenFile, path.join(freshHome, ".studio", "youtube-token.json"));
  assert.equal(plain.envFile, path.join(freshHome, ".studio", ".env"));
  assert.equal(plain.driveMode, "folder", "the public default is folder mode");
  assert.equal(plain.appName, "Creative Studio");
  const old = loadConfig({ home: legacyHome, env: {}, repoDir: ownRepo });
  assert.equal(old.dbPath, path.join(legacyHome, OWN.data, "studio.db"));
  assert.equal(old.cacheDir, path.join(legacyHome, OWN.data, "cache"));
  assert.equal(old.logsDir, path.join(legacyHome, OWN.data, "logs"));
  assert.equal(old.handoffsDir, path.join(legacyHome, OWN.data, "handoffs"));
  assert.equal(old.youtubeTokenFile, path.join(legacyHome, OWN.settings, "youtube-token.json"));
  assert.equal(old.appName, OWN.appName);
  assert.equal(old.driveMode, "folder", "the old install gets folder mode too until its env file says external");
  fs.writeFileSync(path.join(legacyHome, OWN.settings, ".env"), "TYPESAFE_API_KEY=\nSTUDIO_DRIVE_MODE=external\nSTUDIO_DB=~/from-file.db\nSTUDIO_CACHE=~/file-cache\n");
  const fromFile = loadConfig({ home: legacyHome, env: { STUDIO_CACHE: path.join(legacyHome, "proc-cache") }, repoDir: ownRepo });
  assert.equal(fromFile.driveMode, "external", "the env file's STUDIO_DRIVE_MODE");
  assert.equal(fromFile.dbPath, path.join(legacyHome, "from-file.db"), "the env file beats the default");
  assert.equal(fromFile.cacheDir, path.join(legacyHome, "proc-cache"), "process env beats the env file");
  const elsewhere = path.join(base, "elsewhere.env");
  fs.writeFileSync(elsewhere, "STUDIO_LOGS=/tmp/elsewhere-logs\n");
  const viaEnvFile = loadConfig({ home: freshHome, env: { STUDIO_ENV_FILE: elsewhere, STUDIO_DRIVE_MODE: "external" }, repoDir: plainRepo });
  assert.equal(viaEnvFile.envFile, elsewhere);
  assert.equal(viaEnvFile.logsDir, "/tmp/elsewhere-logs");
  assert.equal(viaEnvFile.driveMode, "external");
  assert.throws(() => loadConfig({ home: freshHome, env: { STUDIO_DRIVE_MODE: "usb" }, repoDir: plainRepo }), /config is invalid[\s\S]*STUDIO_DRIVE_MODE/);
  assert.throws(() => loadConfig({ home: freshHome, env: { STUDIO_DRIVE: base, STUDIO_CACHE: path.join(base, "cache") }, repoDir: plainRepo }), /Creative Studio config is invalid: STUDIO_CACHE/);
  assert.equal(fs.existsSync(path.join(freshHome, "Studio-Data")), false, "loading creates no folders");
  ok("loadConfig: identity defaults for the DB / cache / logs / hand-offs / YouTube token, folder mode by default, process env > env file > defaults, STUDIO_ENV_FILE, a bad STUDIO_DRIVE_MODE named");

  // ---------------------------------------------------------------- the shell rule agrees
  for (const repo of [plainRepo, ownRepo, badRepo, dirRepo]) {
    for (const home of [freshHome, legacyHome]) {
      for (const shell of ["/bin/bash", "/bin/zsh"]) {
        const script = path.join(repo, "scripts", "studio-identity.sh");
        const r = spawnSync(shell, ["-c", `. "$1"; printf '%s\\n' "$STUDIO_APP_NAME" "$STUDIO_SETTINGS_DIR" "$STUDIO_DATA_DIR" "$STUDIO_LABEL_WEB" "$STUDIO_LABEL_WORKER" "$STUDIO_SLUG"`, "x", script], {
          env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
          encoding: "utf8",
          cwd: base,
        });
        assert.equal(r.status, 0, r.stderr);
        const id = resolveIdentity(home, {}, repo);
        assert.deepEqual(r.stdout.trimEnd().split("\n"), [id.appName, id.settingsDir, id.dataDir, id.launchdLabels.web, id.launchdLabels.worker, id.slug], `${shell} ${repo} ${home}`);
      }
    }
  }
  ok("scripts/studio-identity.sh (installer, uninstaller, launcher; bash and zsh) resolves the same name, folders, labels and slug as resolveIdentity for every temp repo (none, a good, a bad and a folder identity file) and home");

  // ---------------------------------------------------------------- the repo folder comes from the module, not the cwd
  const { findRepoDir, REPO_DIR } = config;
  const fakeRepo = path.join(base, "fake-repo");
  fs.mkdirSync(path.join(fakeRepo, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, "package.json"), "{}");
  const cwdFallback = path.join(base, "cwd-fallback");
  assert.equal(findRepoDir(path.join(fakeRepo, "src", "lib"), cwdFallback), fakeRepo, "walks up to the folder holding package.json");
  assert.equal(findRepoDir(null, cwdFallback), cwdFallback, "no module folder = the fallback (process.cwd())");
  assert.equal(findRepoDir("relative/dir", cwdFallback), cwdFallback, "a relative start is not trusted");
  assert.equal(findRepoDir(path.join(base, "no-such", "chunks"), cwdFallback), cwdFallback, "nothing found up the tree (a build folder outside the repo) = the fallback");
  assert.ok(fs.statSync(path.join(REPO_DIR, "src", "lib", "config.ts")).isFile(), "REPO_DIR = this repo");
  // A script run from another folder resolves the same identity (the identity file is found from the module).
  const probe = path.join(base, "probe-identity.ts");
  fs.writeFileSync(probe, `import { IDENTITY, REPO_DIR } from ${JSON.stringify(path.join(REPO_DIR, "src", "lib", "config.ts"))};\nconsole.log(JSON.stringify({ repo: REPO_DIR, legacy: IDENTITY.legacy, app: IDENTITY.appName, settings: IDENTITY.settingsDir, data: IDENTITY.dataDir }));\n`);
  const tsxBin = path.join(REPO_DIR, "node_modules", ".bin", "tsx");
  const elsewhereCwd = path.join(base, "some-other-folder");
  fs.mkdirSync(elsewhereCwd);
  const pr = spawnSync(tsxBin, [probe], { cwd: elsewhereCwd, env: { ...process.env, HOME: freshHome, STUDIO_ENV_FILE: "" }, encoding: "utf8", timeout: 60_000 });
  assert.equal(pr.status, 0, pr.stderr);
  const want = resolveIdentity(freshHome, {}, REPO_DIR);
  assert.deepEqual(JSON.parse(pr.stdout.trim().split("\n").pop()!), { repo: REPO_DIR, legacy: want.legacy, app: want.appName, settings: want.settingsDir, data: want.dataDir }, "another cwd: same repo, same identity");
  assert.deepEqual(fs.readdirSync(freshHome), [], "the probe created nothing in its home");
  ok("repo folder: found from the config module's own location (walk up to package.json; a bundle or an outside build folder falls back to the cwd), so a script run from another folder reads the same private/identity.env");
}
