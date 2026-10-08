/**
 * Creative Studio Phase 4a smoke checks (called by scripts/smoke.ts): the public export (scripts/export-public.ts).
 *
 * A temp git repo stands in for this one (exported, non-exported and private files), with a made-up denylist and
 * made-up secret files: the mapping (manual/ -> docs/, CLAUDE.public.md -> CLAUDE.md, the AGENTS.md link, the
 * allowlist rewrite, modes), dirty / untracked refusal and --allow-dirty (the index, never the working tree), each gate
 * failing on a planted hit with the target untouched and the staging folder gone, every target refusal, a second export
 * removing a deleted file (its .git kept), the marker, the CLI's usage errors. Private only: the real export of this
 * repo's index into a temp target passes every gate. Temp folders only; never a git write in this repo.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Ctx = { tmp: string; ok: (msg: string) => void };

const REPO = process.cwd();

/** Every file / link under a folder with its bytes (links: their text), for "untouched" checks. */
function snapshot(dir: string): string {
  let top: fs.Stats;
  try {
    top = fs.lstatSync(dir);
  } catch {
    return "<none>";
  }
  if (top.isSymbolicLink()) return `-> ${fs.readlinkSync(dir)}`;
  if (!top.isDirectory()) return `file ${crypto.createHash("sha256").update(fs.readFileSync(dir)).digest("hex")}`;
  const out: string[] = [];
  const go = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const abs = path.join(d, n);
      const st = fs.lstatSync(abs);
      const rel = path.relative(dir, abs);
      if (st.isSymbolicLink()) out.push(`${rel} -> ${fs.readlinkSync(abs)}`);
      else if (st.isDirectory()) {
        out.push(`${rel}/`);
        go(abs);
      } else out.push(`${rel} ${(st.mode & 0o777).toString(8)} ${crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}`);
    }
  };
  go(dir);
  return out.join("\n");
}

export async function runExportSmoke({ tmp, ok }: Ctx) {
  const ex = await import("./export-public");
  const base = path.join(tmp, "export");
  const repo = path.join(base, "repo");
  const stageRoot = path.join(base, "stage");
  const home = path.join(base, "home");
  const drive = path.join(base, "Media Drive");
  for (const d of [repo, stageRoot, home, drive]) fs.mkdirSync(d, { recursive: true });

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.com", "-c", "commit.gpgsign=false", ...args], { env: gitEnv, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const put = (rel: string, data: string | Buffer, mode?: number) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    if (mode) fs.chmodSync(abs, mode);
  };

  // ---------------------------------------------------------------- the fixture repo
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  put("package.json", '{ "name": "fixture" }\n');
  put("src/app.ts", "export const a = 1;\n");
  put("src/old.ts", "export const b = 2;\n");
  put("launcher/run.sh", "#!/bin/sh\necho hi\n", 0o755);
  put("scripts/leak-allow.txt", `# fixture allowlist\nsha256:${sha("zebracorn")}\tmanual/install.md\t# fixture\n`);
  // The export's own manual check (gate e): fails on the private layout or a page saying BROKEN LINK.
  put(
    "scripts/smoke-manual.ts",
    [
      'import fs from "node:fs";',
      'if (fs.existsSync("manual") || !fs.existsSync("CLAUDE.md") || !fs.existsSync("docs/README.md")) { console.log("FAIL layout"); process.exit(1); }',
      'const bad = fs.readdirSync("docs").filter((f) => f.endsWith(".md") && fs.readFileSync(`docs/${f}`, "utf8").includes("BROKEN LINK"));',
      "for (const f of bad) console.log(`FAIL docs/${f}`);",
      "process.exit(bad.length ? 1 : 0);",
      "",
    ].join("\n"),
  );
  put("manual/README.md", "# Docs\n");
  put("manual/install.md", "Install it, zebracorn edition.\n");
  put("manual/CLAUDE.public.md", "# Public notes\n");
  put("manual/images/shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  put("demo/.env", "DEMO=1\n");
  put(".env.example", "KEY=\n");
  put("README.md", "# Fixture\n");
  put("docs/private.md", "private doc\n");
  put("private/notes.txt", "private\n");
  put("CLAUDE.md", "# private notes\n");
  put("notes.txt", "not exported\n");
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-q", "-m", "fixture");
  const baseCommit = g("rev-parse", "HEAD");

  const denyFile = path.join(base, "deny.txt");
  fs.writeFileSync(denyFile, "# made up\nzebracorn\nc:\\bQuxco\\b\n");
  const SECRET_KEY = "tsk-made-up-0123456789";
  const SECRET_TOKEN = "EAAmadeup0123456789token";
  const SECRET_REFRESH = "1//made-up-refresh-0123456789";
  const SHORT = "short7x";
  const envFile = path.join(base, "secrets", "studio.env");
  const metaEnv = path.join(base, "secrets", "meta.env");
  const tokenFile = path.join(base, "secrets", "token.json");
  fs.mkdirSync(path.dirname(envFile));
  fs.writeFileSync(envFile, `TYPESAFE_API_KEY=${SECRET_KEY}\nOTHER=not-read-0123456789\n`);
  fs.writeFileSync(metaEnv, `META_ACCESS_TOKEN=${SECRET_TOKEN}\nGHL_LOCATION_ID=${SHORT}\n`);
  fs.writeFileSync(tokenFile, JSON.stringify({ nested: { refresh_token: SECRET_REFRESH }, access_token: "" }));
  const secrets = ex.installSecretSources({
    envFile,
    metaEnvFile: metaEnv,
    metaFkbEnvFile: path.join(base, "secrets", "missing.env"),
    youtubeClientSecretFile: path.join(base, "secrets", "bad.json"),
    youtubeTokenFile: tokenFile,
  });
  fs.writeFileSync(path.join(base, "secrets", "bad.json"), `{"installed": {"client_secret": "${"y".repeat(12)}"`); // not JSON
  const VALUES = [SECRET_KEY, SECRET_TOKEN, SECRET_REFRESH, "y".repeat(12), "not-read-0123456789"];

  let lines: string[] = [];
  const run = (target: string, extra: Partial<Parameters<typeof ex.exportPublic>[0]> = {}) => {
    lines = [];
    const r = ex.exportPublic({ repoDir: repo, target, denyFile, secrets, drivePath: drive, home, tmpRoot: stageRoot, toolDir: REPO, log: (l) => lines.push(l), warn: (l) => lines.push(l), ...extra });
    const text = lines.join("\n");
    for (const v of VALUES) assert.ok(!text.includes(v), "no secret value is ever printed");
    assert.deepEqual(fs.readdirSync(stageRoot), [], "the staging folder is always deleted");
    return { ...r, text };
  };

  // ---------------------------------------------------------------- a clean export into an empty git repo
  const target = path.join(base, "out", "public");
  fs.mkdirSync(path.join(target, ".git"), { recursive: true });
  fs.writeFileSync(path.join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
  const r1 = run(target);
  assert.equal(r1.code, 0, r1.text);
  const T = (rel: string) => path.join(target, rel);
  assert.equal(fs.readFileSync(T("docs/install.md"), "utf8"), "Install it, zebracorn edition.\n", "manual/ -> docs/");
  assert.deepEqual(fs.readFileSync(T("docs/images/shot.png")), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), "images as bytes");
  assert.equal(fs.readFileSync(T("CLAUDE.md"), "utf8"), "# Public notes\n", "manual/CLAUDE.public.md -> CLAUDE.md");
  assert.ok(!fs.existsSync(T("docs/CLAUDE.public.md")), "not also in docs/");
  assert.equal(fs.readlinkSync(T("AGENTS.md")), "CLAUDE.md", "AGENTS.md = a relative link to CLAUDE.md");
  assert.equal(fs.statSync(T("launcher/run.sh")).mode & 0o777, 0o755, "the executable bit is kept");
  assert.equal(fs.statSync(T("src/app.ts")).mode & 0o777, 0o644);
  for (const gone of ["private", "notes.txt", "manual", "docs/private.md"]) assert.ok(!fs.existsSync(T(gone)), `${gone} is not exported`);
  const allow = fs.readFileSync(T("scripts/leak-allow.txt"), "utf8");
  assert.ok(allow.includes(`\tdocs/install.md\t`) && !allow.includes("manual/"), "the allowlist paths follow the mapping");
  assert.equal(fs.readFileSync(T(".git/HEAD"), "utf8"), "ref: refs/heads/main\n", "the target's .git is untouched");
  const markerText = fs.readFileSync(T(ex.MARKER), "utf8");
  const marker = JSON.parse(markerText) as Record<string, unknown>;
  assert.equal(marker.tool, "export-public");
  assert.equal(marker.source_commit, baseCommit);
  assert.equal(marker.files, r1.files);
  assert.equal(marker.allow_dirty, false);
  assert.ok(!/["'](\/|~)/.test(markerText) && !markerText.includes(base) && !markerText.includes(os.homedir()), "the marker holds no path of this Mac");
  assert.ok(r1.gates.length === 5, r1.text);
  assert.match(r1.text, /missing\.env|company Meta env file not found, skipped/);
  assert.match(r1.text, /YouTube client file is not JSON, skipped/);
  ok(`export: a clean fixture repo exports ${r1.files} files into an empty git repo (manual/ -> docs/, CLAUDE.public.md -> the root CLAUDE.md, AGENTS.md a relative link, the allowlist's paths rewritten, modes kept, private/ docs/ CLAUDE.md and non-exported files left out, the target's .git untouched, the marker with the commit and counts and no path), all 5 gates passed, missing / non-JSON secret files noted, no secret value printed`);

  // ---------------------------------------------------------------- dirty / untracked refusal, --allow-dirty = the index
  const before = snapshot(target);
  put("src/new.ts", "untracked\n");
  let r = run(target);
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /uncommitted or untracked[\s\S]*src\/new\.ts/);
  assert.equal(snapshot(target), before, "a refusal leaves the target untouched");
  put("src/app.ts", "export const a = 99;\n");
  fs.rmSync(path.join(repo, "src/new.ts"));
  r = run(target);
  assert.equal(r.code, 2, "a modified tracked file is refused too");
  put("src/new.ts", "untracked\n");
  r = run(target, { allowDirty: true });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /!! --allow-dirty/);
  assert.ok(!fs.existsSync(T("src/new.ts")), "--allow-dirty never exports an untracked file");
  assert.equal(fs.readFileSync(T("src/app.ts"), "utf8"), "export const a = 1;\n", "--allow-dirty exports the index, not the working tree");
  assert.equal((JSON.parse(fs.readFileSync(T(ex.MARKER), "utf8")) as { allow_dirty: boolean }).allow_dirty, true);
  fs.rmSync(path.join(repo, "src/new.ts"));
  g("checkout", "-q", "--", "src/app.ts");
  put("notes.txt", "changed, not exported\n");
  put("private/new.txt", "untracked, not exported\n");
  r = run(target);
  assert.equal(r.code, 0, `a dirty path outside EXPORTED does not block: ${r.text}`);
  g("checkout", "-q", "--", "notes.txt");
  fs.rmSync(path.join(repo, "private/new.txt"));
  ok("export: an untracked or modified exported path is refused (exit 2, target untouched); --allow-dirty prints its warning and still exports the index (never the untracked file or the working tree edit); dirt outside EXPORTED does not block");

  // ---------------------------------------------------------------- each gate fails on a planted hit, target untouched
  const plant = (files: Record<string, string | Buffer | { link: string }>, gate: string, expect: RegExp[], not: RegExp[] = []) => {
    for (const [rel, v] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (typeof v === "object" && !Buffer.isBuffer(v)) fs.symlinkSync(v.link, abs);
      else fs.writeFileSync(abs, v);
    }
    g("add", "-A");
    g("commit", "-q", "-m", `plant ${gate}`);
    const snap = snapshot(target);
    const res = run(target);
    assert.equal(res.code, 1, `gate (${gate}) must fail:\n${res.text}`);
    assert.match(res.text, new RegExp(`gate \\(${gate}\\)[^\\n]*FAILED`));
    for (const e of expect) assert.match(res.text, e);
    for (const n of not) assert.doesNotMatch(res.text, n);
    assert.equal(res.failures.filter((l) => l.startsWith("gate")).length, 1, `only gate (${gate}) fails:\n${res.text}`);
    assert.equal(snapshot(target), snap, "a failed gate leaves the target untouched");
    g("reset", "-q", "--hard", baseCommit);
    g("clean", "-qfd");
  };
  plant({ "src/leak.ts": "const x = 'Zebracorn';\n" }, "a", [/src\/leak\.ts:1: Zebracorn/]);
  plant({ "public/zebracorn-logo.svg": "<svg/>\n", "src/Quxco/a.ts": "export {};\n" }, "b", [/public\/zebracorn-logo\.svg/, /src\/Quxco /]);
  plant(
    {
      "src/copy.ts": `const k = "${SECRET_KEY}";\n`,
      "manual/images/x.png": Buffer.concat([crypto.randomBytes(64), Buffer.from(SECRET_REFRESH), crypto.randomBytes(64)]),
      "src/short.ts": `const s = "${SHORT}"; const o = "not-read-0123456789";\n`,
    },
    "c",
    [/src\/copy\.ts: holds the value of TYPESAFE_API_KEY \(env file\)/, /docs\/images\/x\.png: holds the value of refresh_token \(YouTube token file\)/],
    [/short\.ts/],
  );
  plant({ "src/.env": "X=1\n", "scripts/meta.env": "Y=1\n" }, "d", [/src\/\.env: an env file/, /scripts\/meta\.env: an env file/]);
  plant({ "public/big.bin": Buffer.alloc(ex.MAX_FILE_BYTES + 1) }, "d", [/public\/big\.bin: 5\.0 MB \(over 5 MB\)/]);
  plant({ "src/link.ts": { link: "app.ts" } }, "d", [/src\/link\.ts: a symlink/]);
  plant({ "manual/guide.md": "See the BROKEN LINK.\n" }, "e", [/FAIL docs\/guide\.md/]);
  ok("export: each gate fails alone on a planted hit, exit 1, target byte identical, staging folder gone: (a) a denylisted word in a file, (b) in a file name and a folder name (c: case-sensitive), (c) the env file's key in a source file and the token file's nested refresh_token inside binary bytes (named by KEY, never the value; a short value and an unread key ignored), (d) a stray .env / <x>.env, a file over 5 MB, an extra symlink, (e) the export's own manual check on the public layout");

  // ---------------------------------------------------------------- target refusals
  const refused = (t: string, why: RegExp, extra: Partial<Parameters<typeof ex.exportPublic>[0]> = {}) => {
    const watched = path.isAbsolute(t) && t.startsWith(base + path.sep); // never walk / or a real folder
    const snap = watched ? snapshot(t) : "";
    const res = run(t, extra);
    assert.equal(res.code, 2, `refused: ${t}\n${res.text}`);
    assert.match(res.text, why);
    if (watched) assert.equal(snapshot(t), snap, "a refused target is never created or changed");
  };
  refused("/", /it is \//);
  refused("relative/out", /absolute path/);
  refused(home, /is the home folder/);
  refused(base, /holds the home folder|holds the source repo/);
  refused(path.join(repo, "out"), /is inside the source repo/);
  refused(path.join(drive, "out"), /is on the media drive/);
  fs.symlinkSync(drive, path.join(base, "drive-link"));
  refused(path.join(base, "drive-link", "out"), /is on the media drive/);
  fs.mkdirSync(path.join(base, "real-dir"));
  fs.symlinkSync(path.join(base, "real-dir"), path.join(base, "linked-target"));
  refused(path.join(base, "linked-target"), /is a symlink/);
  fs.writeFileSync(path.join(base, "a-file"), "x");
  refused(path.join(base, "a-file"), /is not a folder/);
  fs.mkdirSync(path.join(base, "other-tree", ".git"), { recursive: true });
  refused(path.join(base, "other-tree", "sub"), /inside another git working tree/);
  fs.mkdirSync(path.join(base, "busy"));
  fs.writeFileSync(path.join(base, "busy", "keep.txt"), "mine");
  refused(path.join(base, "busy"), /non-empty folder that is not a previous export/);
  fs.writeFileSync(path.join(base, "busy", ex.MARKER), '{"tool": "something-else"}');
  refused(path.join(base, "busy"), /non-empty folder that is not a previous export/);
  refused(path.join(base, "out", "fresh"), /denylist is missing/, { denyFile: path.join(base, "no-deny.txt") });
  const fresh = path.join(base, "out", "fresh");
  assert.equal(run(fresh).code, 0, "a missing target folder is created");
  ok("export: the target is refused (exit 2, nothing created or changed) when it is /, relative, the home folder, holds the home folder or the repo, inside the repo, on the media drive (lexical and through a symlink), a symlink, a file, inside another git tree, a non-empty folder without this script's marker, or when the denylist is missing; a missing folder is created");

  // ---------------------------------------------------------------- a second export removes what git no longer has
  g("rm", "-q", "src/old.ts");
  g("commit", "-q", "-m", "drop old");
  fs.writeFileSync(T("stray.txt"), "left by hand");
  fs.mkdirSync(T("leftover/deep"), { recursive: true });
  fs.mkdirSync(path.join(base, "canary"));
  fs.writeFileSync(path.join(base, "canary", "keep.txt"), "never followed");
  fs.symlinkSync(path.join(base, "canary"), T("src/escape"));
  fs.symlinkSync(path.join(base, "canary"), T("leftover/deep/link"));
  r = run(target);
  assert.equal(r.code, 0, r.text);
  for (const gone of ["src/old.ts", "stray.txt", "leftover", "src/escape"]) assert.ok(!fs.existsSync(T(gone)) && !isLink(T(gone)), `${gone} is removed`);
  assert.ok(fs.existsSync(T("src/app.ts")) && fs.existsSync(T(".git/HEAD")));
  assert.equal(fs.readFileSync(path.join(base, "canary", "keep.txt"), "utf8"), "never followed", "a link in the target is removed, never followed");
  assert.equal((JSON.parse(fs.readFileSync(T(ex.MARKER), "utf8")) as { source_commit: string }).source_commit, g("rev-parse", "HEAD"));
  const again = run(target);
  assert.equal(again.code, 0);
  assert.match(again.text, /1 written, 0 removed/, "an unchanged export rewrites only the marker");
  ok("export: a second export into a previous one removes a file git dropped and anything else not exported (a stray file, a folder, a link, never followed), keeps the target's .git, updates the marker; an unchanged export writes only the marker");

  // ---------------------------------------------------------------- the CLI's usage errors
  const tsx = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const cli = (...args: string[]) => spawnSync(process.execPath, [tsx, path.join(REPO, "scripts", "export-public.ts"), ...args], { cwd: REPO, encoding: "utf8" });
  assert.equal(cli("--bogus").status, 2);
  assert.equal(cli("--target").status, 2);
  assert.equal(cli("--target", "relative/out").status, 2);
  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npm run export:public/);
  assert.deepEqual(ex.parseExportArgs(["--target=/x", "--allow-dirty"]), { target: "/x", allowDirty: true });
  assert.deepEqual(ex.parseExportArgs([]), { target: ex.DEFAULT_TARGET, allowDirty: false });
  ok("export: the CLI exits 2 on an unknown argument, a --target without a folder or a relative target, prints its usage on --help; default target ~/creative-studio-public");

  // ---------------------------------------------------------------- private only: this repo's real export
  const realDeny = path.join(REPO, "private", "leak-denylist.txt");
  if (fs.existsSync(realDeny)) {
    const { loadConfig } = await import("../src/lib/config");
    const cfg = loadConfig({ env: {}, home: os.homedir(), repoDir: REPO });
    const sources = ex.installSecretSources(cfg);
    const realTarget = path.join(base, "real", "public");
    const out: string[] = [];
    const res = ex.exportPublic({ repoDir: REPO, target: realTarget, allowDirty: true, denyFile: realDeny, secrets: sources, drivePath: cfg.drivePath, home: os.homedir(), tmpRoot: stageRoot, log: (l) => out.push(l), warn: () => {} });
    const text = out.join("\n");
    const held = ex.loadSecrets(sources, []);
    assert.ok(held.every((s) => !text.includes(s.value.toString("utf8"))), "no real secret value is printed");
    assert.equal(res.code, 0, `the real export:\n${text}`);
    assert.equal(res.gates.length, 5);
    assert.ok(!fs.existsSync(path.join(realTarget, "private")) && fs.existsSync(path.join(realTarget, "docs", "install.md")) && fs.existsSync(path.join(realTarget, "CLAUDE.md")));
    assert.deepEqual(fs.readdirSync(stageRoot), []);
    fs.rmSync(realTarget, { recursive: true, force: true });
    ok(`export: the real export of this repo's index (--allow-dirty) passes every gate: ${res.files} files, ${(res.bytes / 1024 / 1024).toFixed(2)} MB, ${held.length} secret value(s) searched; ${res.gates.join("; ")}`);
  } else {
    ok("export: the real export of this repo: skipped (private)");
  }
  fs.rmSync(base, { recursive: true, force: true });
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
