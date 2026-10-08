/**
 * Creative Studio slice 1d smoke checks (called by scripts/smoke.ts): the scrub.
 *
 *  - Neutral defaults for a fresh install (no business path in code) and the Studio config's `env` layer (process env >
 *    env file > config `env` > built in; `./` = the config file's folder).
 *  - The original install resolves EXACTLY its old values (private/: its config + private/legacy-config.json, the pre-1d
 *    loadConfig output for a home holding its settings folder). Skipped without private/.
 *  - Brand marks: the generic ones ship in public/brand; an install's own (STUDIO_BRAND_DIR) are served only when they are
 *    regular SVG files of at most 256 KB inside that folder.
 *  - Lane A episode naming and the hand-off wording follow the profile (any prefix, regex-escaped).
 *  - scripts/leak-grep.sh: its rules on a temp tree (denylist, `c:` lines, plain and sha256 allowlist entries), then the
 *    real gate over every exported folder (needs private/leak-denylist.txt; skipped without it).
 * Temp folders only: never the real home, env file, DB or drive.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

/** What the Phase 4 export copies (and so what the leak gate scans). */
export const EXPORTED = [
  "src",
  "scripts",
  "drizzle",
  "launcher",
  "public",
  "demo",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.ts",
  "eslint.config.mjs",
  "postcss.config.mjs",
  "drizzle.config.ts",
  "components.json",
  "studio.config.example.json",
  ".gitignore",
  "manual",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  ".env.example",
];

export async function runScrubSmoke({ tmp, ok }: Ctx) {
  const config = await import("../src/lib/config");
  const { loadConfig } = config;
  const base = path.join(tmp, "scrub");
  fs.mkdirSync(base);

  // ---------------------------------------------------------------- neutral defaults + the config `env` layer
  const home = path.join(base, "home-fresh");
  fs.mkdirSync(home);
  const fresh = loadConfig({ home, env: {}, repoDir: base });
  const S = path.join(home, ".studio");
  const D = path.join(home, "Studio-Data");
  assert.deepEqual(
    {
      drive: fresh.drivePath,
      meta: fresh.metaEnvFile,
      company: fresh.metaFkbEnvFile,
      docs: fresh.clientDocsDir,
      secret: fresh.youtubeClientSecretFile,
      kit: fresh.reelKitDir,
      pending: fresh.pendingDirs,
      universal: fresh.universalRegistry,
      brand: fresh.brandDir,
    },
    {
      drive: path.join(home, "Studio-Media"),
      meta: path.join(S, "meta.env"),
      company: path.join(S, "meta-company.env"),
      docs: path.join(D, "client-docs"),
      secret: path.join(S, "youtube-client-secret.json"),
      kit: path.join(S, "reel-kit"),
      pending: { fkbpros: path.join(D, "pending-clients"), fkb: path.join(D, "pending-company") },
      universal: path.join(home, "Studio-Media", "shared-ads.json"),
      brand: null,
    },
    "a fresh install gets neutral defaults (no drive name, no outside folder, no skill path)",
  );
  const cfgDir = path.join(base, "cfg");
  fs.mkdirSync(cfgDir);
  const cfgFile = path.join(cfgDir, "studio.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ env: { STUDIO_DRIVE: "/Volumes/Some Drive", STUDIO_DRIVE_MODE: "external", STUDIO_BRAND_DIR: "./marks", STUDIO_DB: "~/from-config.db" } }));
  fs.mkdirSync(S, { recursive: true });
  fs.writeFileSync(path.join(S, ".env"), "STUDIO_DB=~/from-env-file.db\n");
  const layered = loadConfig({ home, env: { STUDIO_CONFIG: cfgFile, STUDIO_DRIVE_MODE: "folder" }, repoDir: base });
  assert.equal(layered.drivePath, "/Volumes/Some Drive", "the config's env beats the built-in default");
  assert.equal(layered.driveMode, "folder", "process env beats the config's env");
  assert.equal(layered.dbPath, path.join(home, "from-env-file.db"), "the env file beats the config's env");
  assert.equal(layered.brandDir, path.join(cfgDir, "marks"), "./ = the config file's folder");
  assert.equal(layered.universalRegistry, path.join("/Volumes/Some Drive", "shared-ads.json"), "the registry default follows the drive");
  fs.rmSync(path.join(S, ".env"));
  ok("neutral defaults for a fresh install (drive, Meta env files, client docs, YouTube client, reel kit, order folders, universal registry, no brand folder) and the config `env` layer (process env > env file > config env > built in; ./ = the config's folder)");

  // ---------------------------------------------------------------- the original install: exactly its old values
  const priv = path.join(process.cwd(), "private");
  const expectFile = path.join(priv, "legacy-config.json");
  if (fs.existsSync(expectFile) && fs.existsSync(path.join(priv, "studio.config.json")) && fs.existsSync(path.join(priv, "identity.env"))) {
    const want = (JSON.parse(fs.readFileSync(expectFile, "utf8")) as { config: Record<string, unknown> }).config;
    const privCfg = path.join(priv, "studio.config.json");
    const own = config.readIdentityFile(process.cwd())!;
    // (a) the real home with its real env file (read only), (b) a temp home holding the same settings folder + an env
    // file of only STUDIO_DRIVE_MODE + STUDIO_CONFIG: both with the real private/identity.env.
    const fakeHome = path.join(base, "home-legacy");
    fs.mkdirSync(path.join(fakeHome, own.settings), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, own.settings, ".env"), `TYPESAFE_API_KEY=\nSTUDIO_DRIVE_MODE=external\nSTUDIO_CONFIG=${privCfg}\n`);
    const realHome = (await import("node:os")).homedir();
    const homes = [fakeHome, ...(fs.existsSync(path.join(realHome, own.settings, ".env")) ? [realHome] : [])];
    for (const h of homes) {
      const got = loadConfig({ home: h, env: {}, repoDir: process.cwd() }) as unknown as Record<string, unknown>;
      const norm = (v: unknown) => JSON.parse(JSON.stringify(v).split(JSON.stringify(privCfg).slice(1, -1)).join("<CONFIG>").split(h).join("<HOME>"));
      for (const k of Object.keys(want)) assert.deepEqual(norm(got[k]), want[k], `the original install's ${k} (${h === realHome ? "real home" : "temp home"})`);
      assert.equal(got.brandDir, path.join(priv, "brand"), "its own marks (private/brand)");
    }
    ok(`the original install resolves exactly its old values: ${Object.keys(want).length} keys of loadConfig() equal the pre-1d code's (59d9007) for ${homes.length === 2 ? "the real home and a temp home" : "a temp home"} with the real private/identity.env (its drive, Meta folders, client docs, skill paths and registry from its config's env), plus its own brand folder`);
  } else {
    ok("the original install's config equality: skipped (private)");
  }

  // ---------------------------------------------------------------- brand marks
  const brand = await import("../src/lib/brand");
  const { BRAND_FILES, GENERIC_BRAND } = await import("../src/lib/profile");
  for (const f of BRAND_FILES) {
    const text = fs.readFileSync(path.join(process.cwd(), "public", "brand", f), "utf8");
    assert.match(text, /^<svg[\s>]/, `public/brand/${f} is the generic SVG`);
  }
  assert.deepEqual(brand.brandUrls({ brandDir: null }), GENERIC_BRAND, "no brand folder = the generic marks");
  const marks = path.join(base, "marks");
  const outside = path.join(base, "outside.svg");
  fs.mkdirSync(marks);
  fs.writeFileSync(path.join(marks, "mark-ink.svg"), '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  fs.writeFileSync(path.join(marks, "mark-sand.svg"), "<html><script>alert(1)</script></html>");
  fs.writeFileSync(outside, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  fs.symlinkSync(outside, path.join(marks, "wordmark-ink.svg"));
  fs.writeFileSync(path.join(marks, "wordmark-paper.svg"), `<svg>${"x".repeat(brand.BRAND_MAX_BYTES)}</svg>`);
  const urls = brand.brandUrls({ brandDir: marks });
  assert.deepEqual(urls, { ...GENERIC_BRAND, markInk: "/api/brand/mark-ink.svg" }, "own SVG files inside the folder only (a non-SVG, a link out and an oversize file fall back)");
  assert.ok(brand.readOwnBrandSvg({ brandDir: marks }, "mark-ink.svg")?.includes("<svg"));
  assert.equal(brand.readOwnBrandSvg({ brandDir: marks }, "mark-sand.svg"), null, "not an SVG = not served");
  assert.equal(brand.readOwnBrandSvg({ brandDir: marks }, "wordmark-ink.svg"), null, "a symlink out of the folder = not served");
  assert.equal(brand.isBrandFile("../studio.db"), false);
  assert.equal(brand.isBrandFile("mark-ink.svg"), true);
  assert.equal(brand.brandFileSchema.safeParse("mark-ink.svg.bak").success, false, "the route's param: one of the four names only");
  // brandUrls (every render) stats only: an unchanged file is not opened again; a changed one (size / mtime) is re-checked.
  const fsMod = (await import("node:fs")).default;
  const realOpen = fsMod.openSync;
  let opens = 0;
  fsMod.openSync = ((...args: Parameters<typeof realOpen>) => {
    opens++;
    return realOpen(...args);
  }) as typeof realOpen;
  try {
    brand.brandUrls({ brandDir: marks });
    assert.equal(opens, 0, "an unchanged mark is not read again on the next render");
    fs.writeFileSync(path.join(marks, "mark-sand.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    assert.equal(brand.brandUrls({ brandDir: marks }).markSand, "/api/brand/mark-sand.svg", "a changed file is checked again");
    assert.equal(opens, 1);
  } finally {
    fsMod.openSync = realOpen;
  }
  ok("brand marks: generic SVGs in public/brand; an install's own (STUDIO_BRAND_DIR) only as regular SVG files of at most 256 KB inside its folder, by a fixed name list through resolveInside + O_NOFOLLOW / fstat (a link out, an oversize file or a non-SVG falls back / is refused); the render path stats only and re-reads a mark only when it changes");

  // ---------------------------------------------------------------- episode naming + hand-off wording
  const naming = await import("../src/lib/shorts/naming");
  const handoffText = await import("../src/lib/shorts/handoff-text");
  const { NEUTRAL_PROFILE } = await import("../src/lib/profile");
  const re = naming.episodeSrtRe("Show.v2 ");
  assert.deepEqual([re.exec("Show.v2 12.srt")?.[1], re.test("ShowXv2 12.srt"), re.test("Show.v2 12 Reel 1.srt")], ["12", false, false], "the prefix is regex-escaped; only `<prefix>N.srt`");
  assert.equal(naming.reelsListName(3, "Episode "), "Episode 3 reels.json");
  assert.ok(naming.handoffNameRe("Episode ").test("Episode 3 reels 2026-10-08-1200.json") && !naming.handoffNameRe("Episode ").test("Other 3 reels.json"));
  const rf = naming.reelFileRes(3, 2, "Episode ");
  assert.deepEqual([rf.plain.test("episode 3 reel 2.mp4"), rf.versioned.exec("Episode 3 Reel 2 v4.mp4")?.[1], rf.plain.test("Episode 3 Reel 21.mp4")], [true, "4", false]);
  assert.equal(naming.captionName(3, 2, "Episode "), "Episode 3 Reel 2 caption.md");
  const { outputRank } = await import("../src/lib/shorts/outputs");
  assert.deepEqual([outputRank("Episode 3 Reel 2 v5.mp4", 3, 2, "Episode "), outputRank("Episode 3 Reel 2.mp4", 3, 2, "Episode "), outputRank("Other 3 Reel 2.mp4", 3, 2, "Episode ")], [5, 1, null]);
  const N = { skills: NEUTRAL_PROFILE.skills, episodes: NEUTRAL_PROFILE.episodes, owner: null };
  assert.equal(handoffText.pasteLine(3, "Title", "kit", "/x/l.json", 2, N), 'Run reel-cut on Ep3 (Title) on reel-kit v2. These moments are already approved, skip step 2 picking: /x/l.json. Copy the list into the episode folder as "Episode 3 reels.json" (if one is already there, ask me before replacing it) and keep each moment\'s k as its reel number. Open each reel on its cold open (cold_start to cold_end) under its hook words.');
  assert.equal(handoffText.explainerPasteLine("A line", { num: 3, start: 65 }, N), "Run explainer-reel on this idea from Episode 3 at 1:05: A line. Use reel-kit.");
  assert.equal(handoffText.formatLabel("kit", 4, N), "Reel kit v4");
  const kit = await import("../src/lib/shorts/kit");
  assert.equal(kit.parseKitNote(JSON.stringify({ kit: "reel-kit", version: 2, test: null }), "reel-kit").ok, true);
  assert.deepEqual(kit.parseKitNote(JSON.stringify({ kit: "other-kit", version: 2, test: null }), "reel-kit"), { ok: false, error: "Not the reel-kit kit.json shape." });
  ok("Lane A episode naming follows the profile prefix (regex-escaped; SRT, reel list, hand-off names, reel files, captions, output ranks) and the hand-off / explainer paste lines, format label and kit notes follow its skill names");

  // ---------------------------------------------------------------- scripts/leak-grep.sh
  const grep = path.join(process.cwd(), "scripts", "leak-grep.sh");
  const lg = path.join(base, "leak");
  fs.mkdirSync(path.join(lg, "tree", "sub"), { recursive: true });
  fs.mkdirSync(path.join(lg, "tree", "node_modules"));
  fs.writeFileSync(path.join(lg, "tree", "a.ts"), "const x = 'Zebracorn'; // fine\nconst DOM = 1;\n");
  fs.writeFileSync(path.join(lg, "tree", "sub", "b.md"), "Kept: zebracorn\nAlso Qux here\n");
  fs.writeFileSync(path.join(lg, "tree", "node_modules", "c.js"), "zebracorn");
  fs.writeFileSync(path.join(lg, "deny.txt"), "# comment\nzebracorn\nc:\\bQux\\b\nc:\\bDom\\b\n");
  const run = (allow: string) => {
    fs.writeFileSync(path.join(lg, "allow.txt"), allow);
    return spawnSync("/bin/bash", [grep, "--deny", path.join(lg, "deny.txt"), "--allow", path.join(lg, "allow.txt"), "--root", lg, "tree"], { encoding: "utf8" });
  };
  const r1 = run("");
  assert.equal(r1.status, 1);
  assert.deepEqual(r1.stdout.trim().split("\n").slice(0, -1), ["tree/a.ts:1: Zebracorn", "tree/sub/b.md:1: zebracorn", "tree/sub/b.md:2: Qux"], "case-insensitive by default, c: lines case-sensitive (an upper case DOM is no hit), node_modules skipped");
  const sha = crypto.createHash("sha256").update("zebracorn").digest("hex");
  const r2 = run(`zebracorn\ttree/a.ts\t# plain\nsha256:${sha}\ttree/sub/b.md\nqux\ttree/sub/b.md\n`);
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /0 hit\(s\), 3 allowed/);
  assert.equal(run("zebracorn tree/a.ts\n").status, 2, "an allowlist line without a TAB is refused");
  assert.equal(spawnSync("/bin/bash", [grep, "--deny", path.join(lg, "none.txt"), "tree"], { cwd: lg }).status, 2, "a missing denylist = exit 2");
  const realDeny = path.join(priv, "leak-denylist.txt");
  if (fs.existsSync(realDeny)) {
    const gate = spawnSync("/bin/bash", [grep, ...EXPORTED], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(gate.status, 0, `the leak gate over the exported folders:\n${gate.stdout.split("\n").slice(0, 20).join("\n")}`);
    ok(`scripts/leak-grep.sh: denylist + c: lines + plain / sha256 allowlist entries on a temp tree; the real gate over ${EXPORTED.join(", ")}: ${gate.stdout.trim().split("\n").pop()}`);
  } else {
    ok("scripts/leak-grep.sh: denylist + c: lines + plain / sha256 allowlist entries on a temp tree; the real gate: skipped (private)");
  }
}
