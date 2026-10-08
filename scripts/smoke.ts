/**
 * `npm run smoke`: end-to-end check of migrations + ingest + derive + generation (fake engine) + describe (fake
 * vision, stub whisper) + classify (FakeJev) + hook scoring (FakeJev) on a temp DB, temp cache, an ffmpeg-generated fixture folder and a temp
 * folder standing in for the drive. Never touches the real DB, cache, env file or media drive, and never calls a paid
 * engine, Ollama, whisper or Jev.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { GenInput, ModelParam, ModelSchema } from "../src/lib/gen/types";
import { runMetaSmoke } from "./smoke-meta";
import { runFkbSmoke } from "./smoke-fkb";
import { runSlice3Smoke } from "./smoke-slice3";
import { runYouTubeSmoke } from "./smoke-youtube";
import { runGateFixSmoke } from "./smoke-gatefix";
import { runShortsSmoke } from "./smoke-shorts";
import { runShorts2Smoke } from "./smoke-shorts2";
import { runAdsSmoke } from "./smoke-ads";
import { runReelsSmoke } from "./smoke-reels";
import { runCopyGateSmoke } from "./smoke-copygate";
import { runRubricV3Smoke } from "./smoke-rubricv3";
import { runPageGateSmoke } from "./smoke-pagegate";
import { runStudioDefaultsSmoke } from "./smoke-studio-defaults";
import { runConfigSmoke } from "./smoke-config";
import { runProfileSmoke } from "./smoke-profile";
import { runScrubSmoke } from "./smoke-scrub";
import { runDemoSmoke } from "./smoke-demo";
import { runLaunchSmoke } from "./smoke-launch";
import { runManualSmoke } from "./smoke-manual";
import { runExportSmoke } from "./smoke-export";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "creative-studio-smoke-"));
process.env.STUDIO_ENV_FILE = path.join(tmp, "studio.env");
process.env.STUDIO_DB = path.join(tmp, "studio.db");
process.env.STUDIO_CACHE = path.join(tmp, "cache");
process.env.STUDIO_LOGS = path.join(tmp, "logs");
process.env.STUDIO_DRIVE = path.join(tmp, "drive"); // plain folder: "not mounted" for the engine, stands in for the drive
process.env.STUDIO_DRIVE_MODE = "external"; // the device check (a plain temp folder = unplugged); folder mode: smoke-studio-defaults.ts
process.env.META_ENV_FILE = path.join(tmp, "no-meta.env");
process.env.META_FKB_ENV_FILE = path.join(tmp, "no-fkb-meta.env"); // never the real META_FKB_ENV_FILE
process.env.STUDIO_CLIENT_DOCS_DIR = path.join(tmp, "fpc-clients"); // copy doc fixtures (Import approved copy)
process.env.YOUTUBE_CLIENT_SECRET_FILE = path.join(tmp, "no-client-secret.json"); // never the skill's real client secret
process.env.YOUTUBE_TOKEN_FILE = path.join(tmp, "no-youtube-token.json"); // never a real token
process.env.STUDIO_HANDOFFS = path.join(tmp, "handoffs"); // Cut reel lists: never ~/NSM-Studio/handoffs
process.env.STUDIO_REEL_KIT_DIR = path.join(tmp, "reel-kit"); // the kit VERSION file: never ~/.claude/skills/nsm-reel-kit
process.env.META_PENDING_DIR = path.join(tmp, "pending-fpc"); // ad orders: never the real META_PENDING_DIR
process.env.META_FKB_PENDING_DIR = path.join(tmp, "pending-fkb"); // never the real META_FKB_PENDING_DIR
// Creative Studio 1b / 1d: lanes, clients and the profile are seeded from a Studio config. The older checks were written
// against the original install's; the smoke seeds from a made-up stand-in of it (same rules and shapes, every name and
// trade word swapped: scripts/fixtures/studio.config.json, made by private/make-fixtures.ts), so it runs without private/.
process.env.STUDIO_CONFIG = path.join(process.cwd(), "scripts", "fixtures", "studio.config.json");

const FFMPEG = process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg";
let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}  ${msg}`);

function ff(args: string[]) {
  const r = spawnSync(FFMPEG, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
}

async function main() {
  const { ensureEnvFile, getConfig, ensureAppDirs, keyStatus } = await import("../src/lib/config");
  const { openDb } = await import("../src/lib/db");
  const { Engine } = await import("../src/worker/engine");
  const { resolveInside, resolveCacheFile } = await import("../src/lib/fsguard");
  const { listAssets, filterOptions, parseFilters } = await import("../src/lib/queries");
  const { SEED_VERSION } = await import("../src/lib/db/seed");
  const { WriteGuard, WriteGuardError } = await import("../src/lib/writeguard");
  const { FakeAdapter } = await import("../src/lib/gen/fake");
  const { retryErrored, requeueRunning, requestCancel } = await import("../src/lib/jobs");
  const { applyBrandGuard, BRAND_GUARD_SUFFIX, CODEX_SCHEMA } = await import("../src/lib/gen/types");
  const { videoRefPlan, REF_TRANSCODE_FILE } = await import("../src/lib/gen/refs");
  const { assignRoles, mediaCounts, ruleViolations, isProofPath } = await import("../src/lib/gen/rules");
  const { generationDetails, discardGenerated } = await import("../src/lib/gen/details");
  const { sidecarPathFor } = await import("../src/lib/gen/output");
  const { destLabel } = await import("../src/lib/gen/layout");
  const { planTool } = await import("../src/lib/gen/tooljobs");
  const { createArgs, costArgs, HiggsfieldAdapter, saveCapped, finishDownload } = await import("../src/lib/gen/higgsfield");
  const { JobNotFoundError, StartUncertainError } = await import("../src/lib/gen/types");
  const { quoteKey } = await import("../src/lib/gen/catalog");
  const { firstRealRunOf } = await import("../src/lib/gen/tooljobs");
  const { genJobs } = await import("../src/lib/queries");

  console.log(`smoke: ${tmp}`);
  assert.equal(ensureEnvFile(), true);
  assert.match(fs.readFileSync(process.env.STUDIO_ENV_FILE!, "utf8"), /^TYPESAFE_API_KEY=$/m);
  ok("env template created with empty TYPESAFE_API_KEY");
  const cfg = getConfig();
  ensureAppDirs(cfg);
  assert.deepEqual(keyStatus(cfg), {
    typesafe: false,
    meta: false,
    metaFileExists: false,
    fkbMeta: false,
    fkbMetaFileExists: false,
    ghl: false,
  });
  ok("key status reports presence only");

  // Fixture folder
  const fx = path.join(tmp, "fixture");
  fs.mkdirSync(path.join(fx, "Client Folder"), { recursive: true });
  fs.mkdirSync(path.join(fx, "build"), { recursive: true });
  fs.mkdirSync(path.join(fx, "renders", "Adam (Acme Restoration)", "v2"), { recursive: true });
  fs.mkdirSync(path.join(fx, "out", "check"), { recursive: true });
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(fx, "wide.mp4")]);
  ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    path.join(fx, "Client Folder", "tall.mov")]);
  ff(["-f", "lavfi", "-i", "testsrc=size=800x800", "-frames:v", "1", path.join(fx, "square.png")]);
  fs.copyFileSync(path.join(fx, "square.png"), path.join(fx, ".hidden.png"));
  fs.copyFileSync(path.join(fx, "square.png"), path.join(fx, "build", "ignored.png"));
  fs.copyFileSync(path.join(fx, "square.png"), path.join(fx, "old.bak.png"));
  fs.copyFileSync(path.join(fx, "square.png"), path.join(fx, "out", "check", "t_01.50.png"));
  ff(["-f", "lavfi", "-i", "testsrc=size=320x320", "-frames:v", "1", path.join(fx, "renders", "Adam (Acme Restoration)", "v2", "dom.png")]);
  fs.writeFileSync(path.join(fx, "notes.md"), "# not media");
  ok("fixture generated (2 videos, 2 png, 4 ignored incl. out/check/, 1 doc)");

  // DB: migrations + seed, then point roots at the fixture only.
  const db = openDb(cfg.dbPath);
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  assert.equal(s.pragma("journal_mode", { simple: true }), "wal");
  assert.equal((s.prepare("select count(*) n from sections").get() as { n: number }).n, 3, "rtm, fkbpros, fkb (seed v7)");
  assert.equal((s.prepare("select count(*) n from ad_accounts").get() as { n: number }).n, 9, "8 client accounts + SGD");
  assert.equal((s.prepare("select count(*) n from clients").get() as { n: number }).n, 8);
  assert.equal((s.prepare("select count(*) n from roots").get() as { n: number }).n, 8);
  assert.ok(s.prepare("select 1 from roots r join sections s on s.id = r.section_id where s.key = 'fkb' and r.path = ?").get(path.join(cfg.drivePath, "Summit Gardens and Decks Studio")), "SGD's media folder (seed v8)");
  assert.match(s.prepare("select body from notes where key = 'whos_who'").pluck().get() as string, /Morgan \(Morgan Price/, "who's who draft gets Morgan");
  const genBase = path.join(cfg.drivePath, "Studio Generated");
  for (const sub of ["NSM", "SGD Pros", "SGD"]) assert.ok(s.prepare("select 1 from roots where path = ?").get(path.join(genBase, sub)));
  assert.equal(
    s.prepare("select s.key from roots r join sections s on s.id = r.section_id where r.path = ?").pluck().get(path.join(genBase, "SGD")),
    "fkb",
    "Studio Generated/SGD is an SGD root (seed v8)",
  );
  assert.ok((s.prepare("select count(*) n from tag_rules").get() as { n: number }).n >= 27);
  assert.ok(s.prepare("select 1 from tag_rules where path_glob = ?").get(`${genBase}/SGD Pros/acme/**`));
  assert.equal(fs.existsSync(cfg.drivePath), false, "seeding must not touch the drive");
  assert.equal((s.prepare("select value from app_settings where key = 'seed_version'").get() as { value: string }).value, String(SEED_VERSION));
  for (const pattern of ["work-*/", "check/"]) assert.ok(s.prepare("select 1 from ignore_patterns where pattern = ?").get(pattern));
  ok(`migrations + seed v${SEED_VERSION} (WAL, 3 sections, 8 clients + 9 ad accounts, 8 roots incl. Studio Generated NSM / SGD Pros / SGD and SGD's media folder, 27 tag rules, work-*/ + check/ ignores, drive untouched)`);
  s.prepare("update roots set enabled = 0").run();
  const fk = (s.prepare("select id from sections where key = 'fkbpros'").get() as { id: number }).id;
  s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)").run(fx, fk, Date.now());
  s.prepare("insert into tag_rules (path_glob, client_codes, created_at) values (?, ?, ?)").run(
    "Client Folder/**",
    JSON.stringify(["acme", "granite"]),
    Date.now(),
  );

  const quiet = () => {};
  const run = async () => {
    const e = new Engine({ cfg, db, concurrency: 2, log: quiet });
    await e.scanAll();
    await e.drainQueue();
    return e;
  };

  // Pass 1
  await run();
  type A = { id: number; filename: string; kind: string; orientation: string; duration_s: number; derive_status: string;
    thumb_path: string | null; sheet_path: string | null; proxy_path: string | null; sha256: string; missing: number; path: string };
  const rows = () => s.prepare("select * from assets order by filename").all() as A[];
  let a = rows();
  assert.deepEqual(a.map((r) => r.filename), ["dom.png", "square.png", "tall.mov", "wide.mp4"]);
  ok("ingest: 4 assets, ignores honored (dotfile, build/, check/, *.bak*, non-media)");
  const by = (n: string) => a.find((r) => r.filename === n)!;
  assert.equal(by("wide.mp4").orientation, "16:9");
  assert.equal(by("tall.mov").orientation, "9:16");
  assert.equal(by("square.png").orientation, "1:1");
  assert.ok(Math.abs(by("wide.mp4").duration_s - 2) < 0.2);
  ok("ffprobe/sharp metadata: orientation buckets + duration");
  for (const r of a) assert.equal(r.derive_status, "done", `${r.filename} derive_status`);
  const exists = (rel: string | null) => !!rel && fs.existsSync(path.join(cfg.cacheDir, rel));
  for (const v of [by("wide.mp4"), by("tall.mov")]) {
    assert.ok(exists(v.thumb_path) && v.thumb_path!.endsWith("poster.jpg"));
    assert.ok(exists(v.sheet_path) && v.sheet_path!.endsWith("sheet.jpg"));
    assert.ok(exists(v.proxy_path) && v.proxy_path!.endsWith("proxy.mp4"));
    assert.ok(v.thumb_path!.startsWith(v.sha256 + "/"));
  }
  assert.ok(exists(by("square.png").thumb_path) && by("square.png").thumb_path!.endsWith("thumb.webp"));
  ok("cache: poster + sheet + proxy per video, thumb.webp per image, keyed by fingerprint");
  const tags = s
    .prepare("select c.code, ac.source from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ? order by c.code")
    .all(by("tall.mov").id) as { code: string; source: string }[];
  assert.deepEqual(tags, [{ code: "acme", source: "folder" }, { code: "granite", source: "folder" }]);
  assert.equal((s.prepare("select count(*) n from asset_clients where asset_id = ?").get(by("wide.mp4").id) as { n: number }).n, 0);
  const domTags = s
    .prepare("select c.code from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ?")
    .all(by("dom.png").id) as { code: string }[];
  assert.deepEqual(domTags.map((t) => t.code), ["acme"]);
  ok("tag rules -> asset_clients (source=folder); parentheses in globs are literal; untagged = shared");
  const folders = filterOptions({ kind: "all" }, parseFilters({})).folders.map((f) => f.path);
  for (const prefix of ["renders", "renders/Adam (Acme Restoration)", "renders/Adam (Acme Restoration)/v2"]) {
    assert.ok(folders.includes(prefix), `folder option ${prefix}`);
  }
  const rootValue = filterOptions({ kind: "all" }, parseFilters({})).folders.find((f) => f.depth === 0)!.value;
  const nested = listAssets({ kind: "all" }, parseFilters({ folder: `${rootValue}/renders/Adam (Acme Restoration)` }));
  assert.deepEqual(nested.items.map((i) => i.filename), ["dom.png"]);
  ok("folder filter: nested prefixes up to 3 levels, filter by path prefix");
  // manual tag survives re-application
  const harbor = (s.prepare("select id from clients where code = 'harbor'").get() as { id: number }).id;
  s.prepare("insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'manual', ?)").run(by("tall.mov").id, harbor, Date.now());

  // Pass 2: idempotent
  const jobsBefore = (s.prepare("select count(*) n from jobs").get() as { n: number }).n;
  const cacheListing = () => fs.readdirSync(cfg.cacheDir).sort().join(",");
  const cacheBefore = cacheListing();
  await run();
  a = rows();
  assert.equal(a.length, 4);
  assert.equal((s.prepare("select count(*) n from jobs").get() as { n: number }).n, jobsBefore);
  assert.equal(cacheListing(), cacheBefore);
  assert.equal((s.prepare("select count(*) n from asset_clients where source = 'manual'").get() as { n: number }).n, 1);
  ok("second run: no duplicate rows, no new jobs, cache unchanged, manual tag kept");

  // Soft-ignore: a row that newly matches an ignore pattern is hidden, not deleted.
  const tallId = by("tall.mov").id;
  const visibleCount = () => listAssets({ kind: "all" }, parseFilters({})).total;
  const before = visibleCount();
  s.prepare("insert into ignore_patterns (pattern) values ('Client Folder/')").run();
  await run();
  const hidden = s.prepare("select id, ignored from assets where id = ?").get(tallId) as { id: number; ignored: number };
  assert.equal(hidden.ignored, 1);
  assert.equal(visibleCount(), before - 1);
  assert.equal((s.prepare("select count(*) n from asset_clients where asset_id = ? and source = 'manual'").get(tallId) as { n: number }).n, 1);
  s.prepare("delete from ignore_patterns where pattern = 'Client Folder/'").run();
  await run();
  assert.equal((s.prepare("select ignored from assets where id = ?").get(tallId) as { ignored: number }).ignored, 0);
  assert.equal(visibleCount(), before);
  assert.equal((s.prepare("select count(*) n from asset_clients where asset_id = ? and source = 'manual'").get(tallId) as { n: number }).n, 1);
  ok("ignore pattern soft-hides (row + manual tag kept, excluded from queries); un-ignore restores same id");

  // Rename keeps the row id
  const wideId = by("wide.mp4").id;
  fs.renameSync(path.join(fx, "wide.mp4"), path.join(fx, "renamed.mp4"));
  await run();
  a = rows();
  assert.equal(a.length, 4);
  assert.equal(a.find((r) => r.filename === "renamed.mp4")?.id, wideId);
  ok("rename: same fingerprint updates the existing row (id kept)");

  // Missing while root readable
  fs.rmSync(path.join(fx, "square.png"));
  await run();
  assert.equal((s.prepare("select missing from assets where filename = 'square.png'").get() as { missing: number }).missing, 1);
  ok("deleted file while root readable -> missing=1");

  // Drive unmounted: rows under it are never marked missing, and no derive jobs run.
  fs.rmSync(path.join(fx, "Client Folder", "tall.mov"));
  const offline = new Engine({ cfg: { ...cfg, drivePath: fx }, db, concurrency: 2, log: quiet });
  assert.equal(offline.driveMounted, false);
  assert.equal(offline.accessibleRoots().length, 0);
  await offline.scanAll();
  await offline.drainQueue();
  assert.equal((s.prepare("select missing from assets where filename = 'tall.mov'").get() as { missing: number }).missing, 0);
  ok("drive unmounted: root skipped, vanished file NOT marked missing");
  await run();
  assert.equal((s.prepare("select missing from assets where filename = 'tall.mov'").get() as { missing: number }).missing, 1);
  ok("drive back: rescan marks the vanished file missing");

  // Path guard
  assert.equal(resolveInside("/etc/passwd", [cfg.cacheDir]), null);
  assert.equal(resolveInside(path.join(cfg.cacheDir, "../../../etc/passwd"), [cfg.cacheDir]), null);
  assert.equal(resolveCacheFile(cfg.cacheDir, "../studio.db"), null);
  assert.equal(resolveCacheFile(cfg.cacheDir, "/etc/passwd"), null);
  fs.symlinkSync("/etc", path.join(cfg.cacheDir, "escape"));
  assert.equal(resolveCacheFile(cfg.cacheDir, "escape/passwd"), null);
  const good = by("renamed.mp4") ?? a.find((r) => r.filename === "renamed.mp4")!;
  assert.ok(resolveCacheFile(cfg.cacheDir, good.proxy_path));
  ok("path guard rejects traversal, absolute and symlink escapes");

  // ------------------------------------------------------------ Phase 2: write guard
  fs.mkdirSync(cfg.drivePath);
  fs.mkdirSync(path.join(cfg.drivePath, "NorthstarMedia"));
  const guard = new WriteGuard({ drivePath: cfg.drivePath, mounted: () => true });
  const unplugged = new WriteGuard({ drivePath: cfg.drivePath, mounted: () => false });
  assert.throws(() => unplugged.ensureDir(path.join(genBase, "NSM")), WriteGuardError);
  assert.equal(fs.existsSync(genBase), false, "unmounted: nothing created");
  guard.ensureDir(path.join(genBase, "NSM"));
  assert.ok(fs.statSync(path.join(genBase, "NSM")).isDirectory());
  const stray = path.join(cfg.cacheDir, "stray.png");
  fs.copyFileSync(path.join(fx, "renders", "Adam (Acme Restoration)", "v2", "dom.png"), stray);
  assert.throws(() => guard.writeNewFile(path.join(tmp, "outside.txt"), "x"), WriteGuardError);
  assert.throws(() => guard.writeNewFile(path.join(cfg.drivePath, "NorthstarMedia", "x.txt"), "x"), WriteGuardError);
  assert.throws(() => guard.writeNewFile(`${genBase}/NSM/../../escape.txt`, "x"), WriteGuardError);
  assert.throws(() => guard.ensureDir(path.join(cfg.drivePath, "Elsewhere")), WriteGuardError);
  fs.symlinkSync(tmp, path.join(genBase, "NSM", "link"));
  assert.throws(() => guard.writeNewFile(path.join(genBase, "NSM", "link", "x.txt"), "x"), WriteGuardError);
  assert.throws(() => guard.moveIn(stray, path.join(fx, "moved.png")), WriteGuardError);
  assert.throws(() => guard.moveIn(stray, path.join(cfg.drivePath, "NorthstarMedia", "moved.png")), WriteGuardError);
  await assert.rejects(guard.trash(path.join(fx, "renamed.mp4")), WriteGuardError);
  await assert.rejects(guard.trash(path.join(cfg.drivePath, "NorthstarMedia")), WriteGuardError);
  assert.ok(fs.existsSync(stray) && fs.existsSync(path.join(fx, "renamed.mp4")));
  for (const f of [path.join(tmp, "outside.txt"), path.join(tmp, "escape.txt"), path.join(fx, "moved.png"), path.join(tmp, "x.txt")]) {
    assert.equal(fs.existsSync(f), false, `${f} must not exist`);
  }
  assert.deepEqual(fs.readdirSync(path.join(cfg.drivePath, "NorthstarMedia")), []);
  fs.rmSync(path.join(genBase, "NSM", "link"));
  ok("write guard: write, move and trash outside Studio Generated refused (.., symlink, drive root, unmounted)");

  // ------------------------------------------------------- Phase 2: fake engine end to end
  s.prepare("update roots set enabled = 1 where path like ?").run(`${genBase}/%`);
  // The engine sees the stand-in drive as a normal folder (its own drivePath points elsewhere), the guard as mounted.
  const genCfg = { ...cfg, drivePath: path.join(tmp, "not-the-drive") };
  const makeGenEngine = (fake: InstanceType<typeof FakeAdapter>) =>
    new Engine({ cfg: genCfg, db, concurrency: 2, log: quiet, gen: { adapters: { fake }, concurrency: { fake: 2 }, guard, pollMs: 5 } });
  type Dest = { section: "rtm" } | { section: "fkbpros"; client: string | null } | { section: "fkb" };
  const queueFake = (dest: Dest, extra: { status?: string; external_id?: string | null; prompt?: string } = {}) => {
    const prompt = extra.prompt ?? "Sunlit modern garden interior, wide shot";
    const input = {
      v: 1, engine: "fake", kind: "image", model: "gpt_image_2_5", modelLabel: "GPT Image 2.5", prompt,
      promptSent: applyBrandGuard(prompt, true), brandGuard: true, params: { quality: "low" },
      effectiveParams: { quality: "low", resolution: "1k", aspect_ratio: "9:16" },
      references: [{ assetId: by("dom.png").id, path: fs.realpathSync(path.join(fx, "renders", "Adam (Acme Restoration)", "v2", "dom.png")), kind: "image" }],
      dest, version: 1, versions: 1, runId: "smoke-run", estimateShown: 0.25,
    };
    return Number(
      s.prepare("insert into jobs (type, asset_id, input, status, external_id, started_at, created_at) values ('gen_image', null, ?, ?, ?, ?, ?)")
        .run(JSON.stringify(input), extra.status ?? "pending", extra.external_id ?? null, extra.status === "running" ? Date.now() : null, Date.now())
        .lastInsertRowid,
    );
  };
  type J = { status: string; external_id: string | null; result: string | null; error: string | null; log_path: string | null };
  const job = (jobId: number) => s.prepare("select status, external_id, result, error, log_path from jobs where id = ?").get(jobId) as J;
  const outputsOf = (jobId: number) => (JSON.parse(job(jobId).result ?? "{}").outputs ?? []) as { path: string; assetId: number }[];

  const fake = new FakeAdapter({ pollsUntilDone: 2 });
  const genEngine = makeGenEngine(fake);
  const toDom = queueFake({ section: "fkbpros", client: "acme" });
  const toRtm = queueFake({ section: "rtm" });
  const toFkb = queueFake({ section: "fkb" }); // Phase 5 slice 2: Studio Generated/SGD (the write guard makes the folder)
  await genEngine.drainGen();
  await genEngine.drainQueue();
  for (const jobId of [toDom, toRtm, toFkb]) {
    assert.equal(job(jobId).status, "done", `gen job ${jobId}: ${job(jobId).error}`);
    assert.match(job(jobId).external_id ?? "", /^fake-/);
    assert.ok(fs.existsSync(job(jobId).log_path!));
  }
  assert.equal(fake.starts, 3);
  const [domOut] = outputsOf(toDom);
  assert.equal(path.dirname(domOut.path), path.join(genBase, "SGD Pros", "acme"));
  assert.match(path.basename(domOut.path), /^\d{4}-\d{2}-\d{2}_fake_gpt_image_2_5_sunlit-modern-garden-interior-wide-shot_1\.png$/);
  const sidecar = JSON.parse(fs.readFileSync(domOut.path.replace(/\.png$/, ".gen.json"), "utf8"));
  assert.equal(sidecar.engine, "fake");
  assert.equal(sidecar.model, "gpt_image_2_5");
  assert.equal(sidecar.jobType, "gen_image");
  assert.equal(sidecar.studioJobId, toDom);
  assert.equal(sidecar.externalJobId, job(toDom).external_id);
  assert.equal(sidecar.credits, 0.25);
  assert.ok(sidecar.promptSent.endsWith(BRAND_GUARD_SUFFIX) && sidecar.prompt === "Sunlit modern garden interior, wide shot");
  assert.deepEqual(sidecar.references.map((r: { assetId: number }) => r.assetId), [by("dom.png").id]);
  const genRow = (assetId: number) =>
    s.prepare("select a.generated, a.derive_status, s.key section from assets a join sections s on s.id = a.section_id where a.id = ?").get(assetId) as {
      generated: number; derive_status: string; section: string };
  assert.deepEqual(genRow(domOut.assetId), { generated: 1, derive_status: "done", section: "fkbpros" });
  const domClients = s.prepare("select c.code, ac.source from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ?").all(domOut.assetId);
  assert.deepEqual(domClients, [{ code: "acme", source: "folder" }]);
  const [rtmOut] = outputsOf(toRtm);
  assert.equal(path.dirname(rtmOut.path), path.join(genBase, "NSM"));
  assert.deepEqual(genRow(rtmOut.assetId), { generated: 1, derive_status: "done", section: "rtm" });
  const [fkbOut] = outputsOf(toFkb);
  assert.equal(path.dirname(fkbOut.path), path.join(genBase, "SGD"), "SGD outputs land in Studio Generated/SGD");
  assert.deepEqual(genRow(fkbOut.assetId), { generated: 1, derive_status: "done", section: "fkb" });
  assert.equal(s.prepare("select count(*) from asset_clients where asset_id = ?").pluck().get(fkbOut.assetId), 0, "SGD files carry no client tag");
  assert.deepEqual(listAssets({ kind: "fkb" }, parseFilters({})).items.map((i) => i.id), [fkbOut.assetId], "the SGD Library shows it");
  assert.equal(destLabel({ section: "fkb" }, [], (await import("../src/lib/gen/layout")).destLabelsOf((await import("../src/lib/ui-labels")).uiLabels(db.sqlite))), "SGD (Summit Gardens and Decks)");
  const generatedIds = listAssets({ kind: "all" }, parseFilters({ source: "generated" })).items.map((i) => i.id).sort();
  assert.deepEqual(generatedIds, [domOut.assetId, rtmOut.assetId, fkbOut.assetId].sort());
  const originals = listAssets({ kind: "all" }, parseFilters({ source: "originals" })).items;
  assert.ok(originals.length > 0 && originals.every((i) => !i.generated));
  assert.equal(listAssets({ kind: "client", code: "acme" }, parseFilters({ source: "generated", shared: "0" })).items[0]?.id, domOut.assetId);
  ok("fake engine end to end: job -> file + sidecar in Studio Generated -> ingest -> generated flag -> acme via the absolute rule; an SGD run lands in Studio Generated/SGD (write guard) and in the SGD Library");

  // Same prompt again lands next to it without overwriting (collision-safe name).
  const again = queueFake({ section: "fkbpros", client: "acme" });
  await genEngine.drainGen();
  assert.equal(path.basename(outputsOf(again)[0].path), path.basename(domOut.path).replace(/_1\.png$/, "_1-2.png"));
  ok("collision-safe output names (_1 -> _1-2), sidecar per file");

  // -------------------------------------------------------- Phase 2: restart recovery
  const resumed = queueFake({ section: "rtm" }, { status: "running", external_id: "fake-before-restart" });
  const cutOff = queueFake({ section: "rtm" }, { status: "running", external_id: null });
  assert.equal(requeueRunning(s), 0, "derive requeue never touches generation jobs");
  const fake2 = new FakeAdapter();
  const restarted = makeGenEngine(fake2);
  assert.deepEqual(restarted.gen!.recover(), { resumed: 1, interrupted: 1 });
  await restarted.drainGen();
  assert.equal(fake2.starts, 0, "a running job with an external id is re-polled, never re-created");
  assert.ok(fake2.polls >= 1);
  assert.equal(job(resumed).status, "done");
  assert.equal(job(resumed).external_id, "fake-before-restart");
  assert.equal(outputsOf(resumed).length, 1);
  assert.equal(job(cutOff).status, "error");
  assert.match(job(cutOff).error ?? "", /Interrupted while starting/);
  ok("restart recovery: running job with external id re-polled (0 new starts); one without becomes a clear error");

  // ------------------------------------------------ Phase 2: queues stay apart, retries are explicit
  const failing = new FakeAdapter();
  failing.poll = async () => ({ state: "failed", status: "nsfw", reason: "flagged" });
  const failJob = queueFake({ section: "rtm" });
  await makeGenEngine(failing).drainGen();
  assert.equal(job(failJob).status, "error");
  assert.equal(job(failJob).external_id, null, "remote failure forgets the id so Retry creates a fresh job");
  assert.equal(JSON.parse(job(failJob).result!).failedExternalIds.length, 1);
  assert.equal(retryErrored(s), 0, "Retry all never re-runs paid generation jobs");
  assert.equal(job(failJob).status, "error");
  assert.equal(retryErrored(s, failJob), 1);
  assert.equal(job(failJob).status, "pending");
  const stuck = queueFake({ section: "rtm" });
  s.prepare("update jobs set input = json_set(input, '$.engine', 'nope') where id in (?, ?)").run(failJob, stuck);
  await genEngine.drainQueue();
  await genEngine.drainGen();
  assert.equal(job(stuck).status, "pending", "derive queue never claims a generation job; unknown engines wait");
  ok("derive queue ignores gen jobs; remote failure clears the id; Retry all skips gen, single Retry re-queues");

  // ------------------------------------------------ Phase 2 slice 2: video references + transcode decision
  assert.deepEqual(videoRefPlan({ codec: "h264", bytes: 5e6, ext: "mov" }), { action: "original" });
  assert.equal(videoRefPlan({ codec: "h264", bytes: 300 * 1024 * 1024, ext: "mp4" }).action, "transcode");
  assert.equal(videoRefPlan({ codec: "hevc", bytes: 5e6, ext: "mov" }).action, "transcode");
  assert.equal(videoRefPlan({ codec: "h264", bytes: 5e6, ext: "mkv" }).action, "transcode");
  fs.mkdirSync(path.join(fx, "Video Refs"));
  ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(fx, "Video Refs", "small.mp4")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=1", "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
    path.join(fx, "Video Refs", "hevc.mov")]);
  await run();
  const assetByName = (name: string) =>
    s.prepare("select id, sha256, codec, path from assets where filename = ?").get(name) as { id: number; sha256: string; codec: string; path: string };
  const small = assetByName("small.mp4");
  const hevc = assetByName("hevc.mov");
  assert.deepEqual([small.codec, hevc.codec], ["h264", "hevc"]);
  const videoPrompt = "Slow push-in on a finished garden";
  const videoJob = Number(
    s.prepare("insert into jobs (type, asset_id, input, status, created_at) values ('gen_video', null, ?, 'pending', ?)").run(
      JSON.stringify({
        v: 1, engine: "fake", kind: "video", model: "kling3_0", modelLabel: "Kling v3.0", prompt: videoPrompt, promptSent: videoPrompt,
        brandGuard: false, params: { aspect_ratio: "9:16" }, effectiveParams: { mode: "std", duration: 5, aspect_ratio: "9:16", sound: "on" },
        references: [
          { assetId: small.id, path: fs.realpathSync(small.path), kind: "video", role: "video_references" },
          { assetId: hevc.id, path: fs.realpathSync(hevc.path), kind: "video", role: "video_references" },
        ],
        dest: { section: "rtm" }, version: 1, versions: 1, runId: "smoke-video", estimateShown: 7.5,
      }),
      Date.now(),
    ).lastInsertRowid,
  );
  const videoFake = new FakeAdapter();
  const videoEngine = makeGenEngine(videoFake);
  await videoEngine.drainGen();
  await videoEngine.drainQueue();
  assert.equal(job(videoJob).status, "done", job(videoJob).error ?? "");
  const refTranscode = path.join(cfg.cacheDir, hevc.sha256, REF_TRANSCODE_FILE);
  assert.deepEqual(
    videoFake.lastRefs.map((r) => [r.role, r.path]),
    [["video_references", fs.realpathSync(small.path)], ["video_references", refTranscode]],
  );
  const probed = spawnSync(process.env.FFPROBE_PATH ?? "/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", refTranscode]).stdout.toString().trim();
  assert.equal(probed, "h264,360,640", "HEVC reference transcoded to H.264, never upscaled");
  const [videoOut] = outputsOf(videoJob);
  assert.equal(path.dirname(videoOut.path), path.join(genBase, "NSM"));
  assert.match(path.basename(videoOut.path), /_fake_kling3_0_slow-push-in-on-a-finished-garden_1\.mp4$/);
  const videoRow = s.prepare("select kind, generated, derive_status from assets where id = ?").get(videoOut.assetId);
  assert.deepEqual(videoRow, { kind: "video", generated: 1, derive_status: "done" });
  const videoSidecar = JSON.parse(fs.readFileSync(sidecarPathFor(videoOut.path), "utf8"));
  assert.equal(videoSidecar.jobType, "gen_video");
  assert.deepEqual(videoSidecar.references.map((r: { role: string }) => r.role), ["video_references", "video_references"]);
  ok("video: gen_video via the fake engine; small H.264 ref sent as the original, HEVC ref as a cached 1080p H.264 transcode");

  // -------------------------------------------- Phase 2 slice 2: model rules (CEL subset) + reference roles
  const media = (extra: ModelParam[] = []): ModelParam[] => [
    { name: "prompt", type: "string", default: null, required: true },
    { name: "image_references", type: "array", default: null, required: false },
    { name: "video_references", type: "array", default: null, required: false },
    { name: "audio_references", type: "array", default: null, required: false },
    { name: "start_image", type: "object|null", default: null, required: false },
    { name: "end_image", type: "object|null", default: null, required: false },
    ...extra,
  ];
  const seedance: ModelSchema = {
    jobType: "seedance_2_5", displayName: "Seedance 2.5", type: "video",
    params: media([{ name: "mode", type: "string", default: "t2v", required: false, enum: ["t2v", "omni_reference"] }]),
    rules: [
      { cel: 'params.mode != "t2v" || size(params.image_references) + size(params.video_references) + size(params.audio_references) + (params.start_image == null ? 0 : 1) + (params.end_image == null ? 0 : 1) == 0', message: "mode 't2v' does not accept reference media" },
      { cel: 'params.mode == "omni_reference" || (params.start_image == null && params.end_image == null)', message: "start_image and end_image are only allowed for mode 'omni_reference'" },
      { cel: "some_future_macro(params.x)", message: "unparsed rules are skipped" },
    ],
  };
  const minimax: ModelSchema = {
    jobType: "minimax_h3", displayName: "MiniMax H3", type: "video", params: media(),
    rules: [{ cel: "(params.start_image == null && params.end_image == null) || (size(params.image_references) == 0 && size(params.video_references) == 0 && size(params.audio_references) == 0)", message: "start_image/end_image cannot be mixed with reference media" }],
  };
  const veo: ModelSchema = { jobType: "veo3_1", displayName: "Veo", type: "video", params: media().filter((p) => ["prompt", "start_image"].includes(p.name)), rules: [] };
  const imgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, kind: "image" as const }));
  const seedRoles = assignRoles(seedance, imgs(2));
  assert.deepEqual(seedRoles.map((r) => r.role), ["start_image", "image_references"]);
  assert.deepEqual(ruleViolations(seedance, { mode: "t2v" }, mediaCounts(seedRoles)), [
    "mode 't2v' does not accept reference media",
    "start_image and end_image are only allowed for mode 'omni_reference'",
  ]);
  assert.deepEqual(ruleViolations(seedance, { mode: "omni_reference" }, mediaCounts(seedRoles)), []);
  const mmRoles = assignRoles(minimax, imgs(2));
  assert.deepEqual(ruleViolations(minimax, {}, mediaCounts(mmRoles)), ["start_image/end_image cannot be mixed with reference media"]);
  const mmFixed = assignRoles(minimax, imgs(2), { 100: "image_references", 101: "image_references" });
  assert.deepEqual(ruleViolations(minimax, {}, mediaCounts(mmFixed)), []);
  assert.deepEqual(assignRoles(veo, imgs(2)).map((r) => r.role), ["start_image", null]);
  assert.deepEqual(assignRoles(veo, [{ id: 1, kind: "video" }]).map((r) => r.role), [null]);
  assert.deepEqual(ruleViolations(CODEX_SCHEMA, {}, mediaCounts(assignRoles(CODEX_SCHEMA, imgs(5)))), ["ChatGPT image takes at most 4 references"]);
  ok("model rules checked before confirm (seedance t2v, minimax start+refs, ChatGPT max 4); roles auto-assign + overrides");

  // ------------------------------------------------------------------ Phase 2 slice 2: proof guard
  assert.ok(isProofPath("/Volumes/Media Drive/SGDPros ads/Adam - Work Gallery/garden 1.jpg"));
  assert.ok(isProofPath("/Volumes/Media Drive/SGDPros ads/Cedar Direct - Before After Gallery/a.jpg"));
  assert.ok(isProofPath("/x/dom - WORK GALLERY/sub/a.jpg"));
  assert.ok(!isProofPath("/Volumes/Media Drive/SGDPros ads/renders/Testing Future Ads/a.png"));
  assert.ok(!isProofPath("/x/renders/Adam - Work Gallery.png"), "file names are not folders");
  assert.ok(!isProofPath("/x/Before Afterlife/a.png"));
  fs.mkdirSync(path.join(fx, "Adam - Work Gallery"));
  ff(["-f", "lavfi", "-i", "testsrc=size=300x300", "-frames:v", "1", path.join(fx, "Adam - Work Gallery", "job-photo.png")]);
  await run();
  const cards = listAssets({ kind: "all" }, parseFilters({})).items;
  assert.equal(cards.find((c) => c.filename === "job-photo.png")?.proof, true);
  assert.ok(cards.filter((c) => c.filename !== "job-photo.png").every((c) => !c.proof));
  ok("proof guard: Work Gallery / Before After folders flagged (case-insensitive, folders only) and carried on cards");

  // ------------------------------------------ Phase 2 slice 2: Codex-style engine: restart rule + cancel
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const makeLocalEngine = (adapter: InstanceType<typeof FakeAdapter>) =>
    new Engine({ cfg: genCfg, db, concurrency: 2, log: quiet, gen: { adapters: { codex: adapter }, concurrency: { codex: 2 }, guard, pollMs: 5 } });
  const queueCodex = (extra: { status?: string; external_id?: string | null } = {}) => {
    const prompt = "Flat illustration of a coffee mug";
    return Number(
      s.prepare("insert into jobs (type, asset_id, input, status, external_id, started_at, created_at) values ('gen_image', null, ?, ?, ?, ?, ?)")
        .run(
          JSON.stringify({ v: 1, engine: "codex", kind: "image", model: "gpt_image", modelLabel: "ChatGPT image", prompt, promptSent: prompt,
            brandGuard: false, params: {}, effectiveParams: { aspect_ratio: "9:16" }, references: [], dest: { section: "rtm" },
            version: 1, versions: 1, runId: "smoke-codex", estimateShown: null }),
          extra.status ?? "pending", extra.external_id ?? null, extra.status === "running" ? Date.now() : null, Date.now(),
        ).lastInsertRowid,
    );
  };
  const localFake = new FakeAdapter({ resumable: false });
  const interruptedCodex = queueCodex({ status: "running", external_id: "thread-before-restart" });
  const localEngine = makeLocalEngine(localFake);
  assert.deepEqual(localEngine.gen!.recover(), { resumed: 0, interrupted: 1 });
  await localEngine.drainGen();
  assert.equal(localFake.starts, 0, "a running Codex job is never re-run by a restart");
  assert.equal(job(interruptedCodex).status, "error");
  assert.match(job(interruptedCodex).error ?? "", /^Interrupted .*Retry runs it again/);
  assert.equal(job(interruptedCodex).external_id, null);
  assert.equal(retryErrored(s, interruptedCodex), 1);
  await localEngine.drainGen();
  assert.equal(job(interruptedCodex).status, "done");
  assert.equal(localFake.starts, 1);
  ok("Codex restart rule: running job becomes 'Interrupted, retry' (0 re-runs); Retry runs it again");

  const hanging = new FakeAdapter({ hang: true, resumable: false });
  const hangEngine = makeLocalEngine(hanging);
  const longJob = queueCodex();
  const draining = hangEngine.drainGen();
  for (let i = 0; i < 500 && !(job(longJob).status === "running" && job(longJob).external_id); i++) await sleep(10);
  assert.equal(job(longJob).status, "running");
  assert.equal(requestCancel(s, longJob), "requested");
  await draining;
  assert.equal(job(longJob).status, "cancelled");
  assert.equal(hanging.cancels, 1);
  assert.equal(job(longJob).external_id, null);
  assert.equal(fs.existsSync(path.join(cfg.cacheDir, "gen-tmp", String(longJob))), false, "temp dir cleaned");
  assert.equal(requestCancel(s, longJob), null, "nothing to cancel once it ended");
  const queuedCodex = queueCodex();
  assert.equal(requestCancel(s, queuedCodex), "cancelled", "a pending job is cancelled on the spot");
  await hangEngine.drainGen();
  assert.equal(hanging.starts, 1);
  assert.equal(retryErrored(s, queuedCodex), 1, "Retry works on a cancelled Codex job");
  assert.equal(requestCancel(s, queuedCodex), "cancelled");
  ok("cancel: a running long job is killed via the adapter (status cancelled, temp cleaned); pending cancels at once");

  // ------------------------------------ Phase 2 slice 2: drawer details from the sidecar, through the guards
  const domPng = by("dom.png").id;
  const det = generationDetails(domOut.assetId, s, genCfg)!;
  assert.equal(det.source, "sidecar");
  assert.equal(det.prompt, "Sunlit modern garden interior, wide shot");
  assert.equal(det.credits, 0.25);
  assert.equal(det.billing, "credits");
  assert.equal(det.destination, "fkbpros:acme");
  assert.equal(det.params.aspect_ratio, "9:16");
  assert.deepEqual(det.references.map((r) => [r.id, r.role, r.available]), [[domPng, "image_references", true]]);
  const rtmSidecar = sidecarPathFor(rtmOut.path);
  const keep = fs.readFileSync(rtmSidecar);
  const evil = path.join(tmp, "evil.gen.json");
  fs.writeFileSync(evil, JSON.stringify({ engine: "evil", model: "x", prompt: "evil" }));
  fs.rmSync(rtmSidecar);
  fs.symlinkSync(evil, rtmSidecar);
  const viaJob = generationDetails(rtmOut.assetId, s, genCfg)!;
  assert.equal(viaJob.source, "job", "a sidecar that resolves outside the roots is never read");
  assert.equal(viaJob.prompt, "Sunlit modern garden interior, wide shot");
  fs.rmSync(rtmSidecar);
  fs.writeFileSync(rtmSidecar, keep);
  assert.equal(generationDetails(domPng, s, genCfg), null, "an original has no generation details");
  const codexOut = outputsOf(interruptedCodex)[0];
  assert.equal(generationDetails(codexOut.assetId, s, genCfg)!.billing, "chatgpt");
  ok("drawer details: sidecar read via the asset's guarded path (symlink escape refused, job-row fallback); ChatGPT billing");

  // ------------------------------------------------------ Phase 2 slice 2: Discard via the write guard
  const trashDir = path.join(tmp, "Trash");
  fs.mkdirSync(trashDir);
  const trashing = new WriteGuard({
    drivePath: cfg.drivePath,
    mounted: () => true,
    trashCmd: async (abs) => fs.renameSync(abs, path.join(trashDir, path.basename(abs))),
  });
  const domPngPath = s.prepare("select path from assets where id = ?").pluck().get(domPng) as string;
  assert.equal((await discardGenerated(domPng, s, genCfg, trashing)).ok, false, "an original is never discarded");
  s.prepare("update assets set generated = 1 where id = ?").run(domPng);
  assert.equal((await discardGenerated(domPng, s, genCfg, trashing)).ok, false, "outside Studio Generated is refused even if flagged");
  s.prepare("update assets set generated = 0 where id = ?").run(domPng);
  assert.ok(fs.existsSync(domPngPath));
  const unpluggedTrash = new WriteGuard({ drivePath: cfg.drivePath, mounted: () => false, trashCmd: trashing["trashCmd"] });
  assert.equal((await discardGenerated(rtmOut.assetId, s, genCfg, unpluggedTrash)).ok, false, "drive unplugged: refused");
  const discarded = await discardGenerated(rtmOut.assetId, s, genCfg, trashing);
  assert.ok(discarded.ok);
  assert.equal(fs.existsSync(rtmOut.path), false);
  assert.equal(fs.existsSync(rtmSidecar), false);
  assert.deepEqual(fs.readdirSync(trashDir).sort(), [path.basename(rtmOut.path), path.basename(rtmSidecar)].sort());
  assert.equal((s.prepare("select missing from assets where id = ?").get(rtmOut.assetId) as { missing: number }).missing, 1);
  assert.ok(!listAssets({ kind: "all" }, parseFilters({ source: "generated" })).items.some((i) => i.id === rtmOut.assetId));
  ok("Discard: file + sidecar trashed through the write guard inside Studio Generated; originals / outside / unplugged refused");

  // ------------------------------------------------------------ Phase 2 slice 3: quick tools
  // Stub schemas mirror `higgsfield model get` / `workflow get reframe` (CLI 1.1.23, 2026-09-29): the planner and
  // the worker run exactly as in the app, only the schema source and the engine are fakes.
  const arr = (name: string): ModelParam => ({ name, type: "array", default: null, required: false });
  const one = (role: string) => [{ cel: `size(params.${role}) == 1`, message: `exactly one ${role} entry is required` }];
  const toolSchemas: Record<string, ModelSchema> = {
    bytedance_image_upscale: { jobType: "bytedance_image_upscale", displayName: "Bytedance Image Upscale", type: "image", rules: one("image_references"),
      params: [arr("image_references"), { name: "remove_bg", type: "boolean", default: false, required: false },
        { name: "resolution", type: "string", default: "4k", required: false, enum: ["2k", "4k"] }] },
    bytedance_video_upscale: { jobType: "bytedance_video_upscale", displayName: "Bytedance Video Upscale", type: "video", rules: [],
      params: [{ name: "fps", type: "integer", default: 24, required: false },
        { name: "resolution", type: "string", default: "2k", required: false, enum: ["1080p", "2k", "4k"] },
        { name: "video_references", type: "array", default: null, required: true }] },
    image_background_remover: { jobType: "image_background_remover", displayName: "Image Background Remover", type: "image", rules: one("image_references"), params: [arr("image_references")] },
    video_background_remover: { jobType: "video_background_remover", displayName: "Video Background Remover", type: "video", rules: one("video_references"), params: [arr("video_references")] },
    outpaint: { jobType: "outpaint", displayName: "Outpaint", type: "image", rules: one("image_references"),
      params: [{ name: "aspect_ratio", type: "string", default: "21:9", required: false, enum: ["auto", "1:1", "9:16", "16:9", "21:9"] },
        { name: "folder_id", type: "string|null", default: null, required: false }, arr("image_references")] },
    reframe: { jobType: "reframe", displayName: "Reframe", type: "video", rules: [], costParams: ["duration", "resolution"],
      params: [{ name: "aspect_ratio", type: "string", default: null, required: true, enum: ["21:9", "16:9", "1:1", "9:16"] },
        { name: "duration", type: "number|null", default: null, required: false }, arr("image_references"),
        { name: "resolution", type: "string", default: "720p", required: false, enum: ["480p", "720p", "1080p"] },
        { name: "start_image", type: "object|null", default: null, required: false }, arr("video_references")] },
  };
  const schemaFor = async (spec: { jobType: string }) => toolSchemas[spec.jobType] ?? null;
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(fx, "Client Folder", "two.mp4")]);
  await run();
  const two = assetByName("two.mp4");
  const plan = async (assetId: number, tool: "upscale" | "remove_bg" | "reframe_916") => {
    const r = await planTool({ assetId, tool, sqlite: s, cfg: genCfg, schemaFor, engine: "fake", estimateShown: 1 });
    if (!r.ok) throw new Error(`planTool ${tool} ${assetId}: ${r.error}`);
    return r.input;
  };
  const upImg = await plan(domPng, "upscale");
  assert.deepEqual([upImg.kind, upImg.model, upImg.params, upImg.effectiveParams.resolution], ["tool", "bytedance_image_upscale", {}, "4k"]);
  assert.deepEqual(upImg.references, [{ assetId: domPng, path: fs.realpathSync(domPngPath), kind: "image", role: "image_references" }]);
  assert.deepEqual(upImg.dest, { section: "fkbpros", client: "acme" }, "one client tag -> that client's folder");
  assert.deepEqual([upImg.prompt, upImg.tool!.id, upImg.tool!.exactQuote, upImg.tool!.detail], ["", "upscale", true, "4k"]);
  const bgImg = await plan(domPng, "remove_bg");
  assert.deepEqual([bgImg.model, bgImg.params], ["image_background_remover", {}]);
  const rfImg = await plan(domPng, "reframe_916");
  assert.deepEqual([rfImg.model, rfImg.params, rfImg.tool!.workflow], ["outpaint", { aspect_ratio: "9:16" }, false]);
  const upVid = await plan(small.id, "upscale");
  assert.deepEqual([upVid.model, upVid.effectiveParams.resolution, upVid.references[0].role, upVid.tool!.exactQuote], ["bytedance_video_upscale", "2k", "video_references", false]);
  assert.deepEqual(upVid.dest, { section: "fkbpros", client: null }, "no client tag -> SGD Pros/_shared");
  const bgVid = await plan(hevc.id, "remove_bg");
  assert.deepEqual([bgVid.model, bgVid.tool!.exactQuote], ["video_background_remover", false]);
  const rfVid = await plan(two.id, "reframe_916");
  assert.deepEqual([rfVid.model, rfVid.tool!.workflow, rfVid.params], ["reframe", true, { aspect_ratio: "9:16", duration: 2 }]);
  assert.deepEqual(rfVid.tool!.quoteParams, { duration: 2, resolution: "720p" }, "reframe is quoted from duration + resolution");
  assert.deepEqual(rfVid.dest, { section: "fkbpros", client: null }, "two client tags -> SGD Pros/_shared");
  const rtmSource = outputsOf(resumed)[0].assetId;
  assert.deepEqual((await plan(rtmSource, "upscale")).dest, { section: "rtm" }, "NSM source -> NSM");
  s.prepare("update assets set duration_s = null where id = ?").run(small.id);
  assert.equal((await planTool({ assetId: small.id, tool: "reframe_916", sqlite: s, cfg: genCfg, schemaFor })).ok, false, "reframe needs the clip length");
  s.prepare("update assets set duration_s = 1 where id = ?").run(small.id);
  assert.equal((await planTool({ assetId: domPng, tool: "upscale", sqlite: s, cfg: genCfg, schemaFor: async () => null })).ok, false);
  // CLI arguments (never run here): tools send no --prompt; the video reframe is `generate workflow reframe`.
  assert.deepEqual(createArgs(upImg, [{ path: "/x/dom.png", role: "image_references", kind: "image" }]),
    ["generate", "create", "bytedance_image_upscale", "--image-references", "/x/dom.png", "--json"]);
  assert.deepEqual(createArgs(rfVid, [{ path: "/x/two.mp4", role: "video_references", kind: "video" }]),
    ["generate", "workflow", "reframe", "--aspect_ratio", "9:16", "--duration", "2", "--video-references", "/x/two.mp4", "--json"]);
  assert.deepEqual(costArgs("reframe", rfVid.tool!.quoteParams, {}, { prompt: false, workflow: true }),
    ["generate", "cost", "workflow", "reframe", "--duration", "2", "--resolution", "720p"]);
  assert.ok(!costArgs("image_background_remover", {}, { image_references: 1 }, { prompt: false }).includes("--prompt"));
  ok("quick tools plan: job type + params per tool (image 4k / video 2k upscale, bg remove, outpaint 9:16, reframe workflow with duration), dest from client tags, CLI args");

  const queueTool = (input: GenInput) =>
    Number(s.prepare("insert into jobs (type, asset_id, input, status, created_at) values ('gen_tool', null, ?, 'pending', ?)").run(JSON.stringify(input), Date.now()).lastInsertRowid);
  const toolJobs = [queueTool(upImg), queueTool(bgVid), queueTool(rfVid)];
  const toolFake = new FakeAdapter();
  const toolEngine = makeGenEngine(toolFake);
  await toolEngine.drainGen();
  await toolEngine.drainQueue();
  for (const j of toolJobs) assert.equal(job(j).status, "done", job(j).error ?? "");
  const call = (model: string) => toolFake.calls.find((c) => c.input.model === model)!;
  assert.deepEqual(toolFake.calls.map((c) => c.input.model).sort(), ["bytedance_image_upscale", "reframe", "video_background_remover"]);
  assert.equal(call("reframe").input.params.duration, 2, "video reframe duration passed to the engine");
  assert.deepEqual(call("video_background_remover").refs, [{ path: path.join(cfg.cacheDir, hevc.sha256, REF_TRANSCODE_FILE), role: "video_references", kind: "video" }],
    "HEVC source goes as the cached 1080p H.264 reference");
  assert.deepEqual(call("bytedance_image_upscale").refs.map((r) => r.path), [fs.realpathSync(domPngPath)], "image source goes as the original");
  const [upOut] = outputsOf(toolJobs[0]);
  assert.equal(path.dirname(upOut.path), path.join(genBase, "SGD Pros", "acme"));
  assert.match(path.basename(upOut.path), /^\d{4}-\d{2}-\d{2}_fake_upscale_dom_1\.png$/);
  const upSide = JSON.parse(fs.readFileSync(sidecarPathFor(upOut.path), "utf8"));
  assert.deepEqual([upSide.jobType, upSide.tool, upSide.toolDetail, upSide.source.assetId, upSide.source.path, upSide.credits],
    ["gen_tool", "upscale", "4k", domPng, fs.realpathSync(domPngPath), 2]);
  assert.equal(upSide.creditsMinimum, undefined);
  assert.deepEqual(genRow(upOut.assetId), { generated: 1, derive_status: "done", section: "fkbpros" });
  assert.deepEqual(s.prepare("select c.code from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ?").pluck().all(upOut.assetId), ["acme"]);
  const [bgOut] = outputsOf(toolJobs[1]);
  assert.equal(path.dirname(bgOut.path), path.join(genBase, "SGD Pros", "_shared"));
  assert.match(path.basename(bgOut.path), /_fake_remove_bg_hevc_1\.mp4$/);
  const bgSide = JSON.parse(fs.readFileSync(sidecarPathFor(bgOut.path), "utf8"));
  assert.deepEqual([bgSide.tool, bgSide.source.assetId, bgSide.creditsMinimum], ["remove_bg", hevc.id, true], "video bg remove: quote is a minimum");
  const [rfOut] = outputsOf(toolJobs[2]);
  assert.match(path.basename(rfOut.path), /_fake_reframe_916_two_1\.mp4$/);
  assert.equal((s.prepare("select kind from assets where id = ?").get(rfOut.assetId) as { kind: string }).kind, "video");
  const upDet = generationDetails(upOut.assetId, s, genCfg)!;
  assert.deepEqual([upDet.tool, upDet.toolDetail, upDet.toolSource?.id, upDet.toolSource?.available, upDet.creditsMinimum], ["upscale", "4k", domPng, true, false]);
  assert.equal(generationDetails(bgOut.assetId, s, genCfg)!.creditsMinimum, true);
  const views = genJobs();
  const upView = views.find((v) => v.id === toolJobs[0])!;
  assert.deepEqual([upView.tool?.title, upView.tool?.sourceName, upView.tool?.sourceId, upView.creditsMinimum], ["Upscale 4k", "dom.png", domPng, false]);
  assert.equal(views.find((v) => v.id === toolJobs[1])!.creditsMinimum, true);
  ok("quick tools via the fake engine: gen_tool jobs land in the source's channel folder, sidecar tool + source, generated + client tag, drawer + Jobs views");

  // ------------------------------------------------------------ Phase 2 gate fixes
  // 1. Pending Higgsfield jobs can be cancelled (nothing spent); once running they cannot. The worker's claim only
  //    flips a row that is still pending, so a cancelled row is never started.
  const hfJob = (status: "pending" | "running") => {
    const jobId = queueFake({ section: "rtm" }, { status });
    s.prepare("update jobs set input = json_set(input, '$.engine', 'higgsfield') where id = ?").run(jobId);
    return jobId;
  };
  const hfPending = hfJob("pending");
  const hfRunning = hfJob("running");
  const viewOf = (jobId: number) => genJobs().find((v) => v.id === jobId)!;
  assert.deepEqual([viewOf(hfPending).cancellable, viewOf(hfRunning).cancellable], [true, false]);
  assert.equal(requestCancel(s, hfRunning, { running: false }), null, "a running Higgsfield job is never cancelled");
  assert.equal(job(hfRunning).status, "running");
  assert.equal(requestCancel(s, hfPending, { running: false }), "cancelled");
  assert.equal(job(hfPending).status, "cancelled");
  assert.equal(requestCancel(s, hfPending, { running: false }), null, "already cancelled");
  const cancelledFake = new FakeAdapter();
  const pendingThenCancelled = queueFake({ section: "rtm" });
  assert.equal(requestCancel(s, pendingThenCancelled, { running: false }), "cancelled");
  await makeGenEngine(cancelledFake).drainGen();
  assert.equal(cancelledFake.starts, 0, "the worker never claims a cancelled job");
  assert.equal(job(pendingThenCancelled).status, "cancelled");
  s.prepare("update jobs set status = 'error', error = 'test' where id = ?").run(hfRunning);
  ok("gate: pending Higgsfield job cancels (nothing spent, never claimed); a running one is refused");

  // 2. Quote cache keys: every param and count exactly (false / 0 / "" never collide with the default).
  assert.notEqual(quoteKey("veo3_1", { generate_audio: false }), quoteKey("veo3_1", {}));
  assert.notEqual(quoteKey("kling3_0", { sound: "" }), quoteKey("kling3_0", {}));
  assert.notEqual(quoteKey("kling3_0", { duration: 0 }), quoteKey("kling3_0", {}));
  assert.notEqual(quoteKey("kling3_0", {}, { image_references: 0 }), quoteKey("kling3_0", {}, {}));
  assert.notEqual(quoteKey("kling3_0", {}, { start_image: 1 }), quoteKey("kling3_0", {}, { image_references: 1 }));
  assert.equal(quoteKey("m", { a: 1, b: true }), quoteKey("m", { b: true, a: 1 }), "key order does not matter");
  ok("gate: quote cache key includes false / 0 / empty params and counts exactly");

  // 3 + 4. The real Higgsfield adapter against a stub CLI (HIGGSFIELD_BIN): not found, uncertain create.
  const stub = path.join(tmp, "hf-stub.sh");
  fs.writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "generate get") echo "Error: Job not found" >&2; exit 3 ;;',
      '  "generate create") case "$HF_STUB_CREATE" in',
      '      noid) exit 0 ;;',
      '      refused) echo "Error: exactly one image_references entry is required" >&2; exit 4 ;;',
      '      *) echo "Error: connection reset" >&2; exit 1 ;;',
      "    esac ;;",
      "esac",
      "exit 2",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.HIGGSFIELD_BIN = stub;
  const hf = new HiggsfieldAdapter();
  const hfCtx = { tmpDir: path.join(tmp, "hf-ctx"), log: quiet };
  await assert.rejects(hf.poll("00000000-0000-4000-8000-000000000000"), JobNotFoundError);
  for (const [mode, cls] of [["noid", StartUncertainError], ["other", StartUncertainError]] as const) {
    process.env.HF_STUB_CREATE = mode;
    await assert.rejects(hf.start(upImg, [], hfCtx), (e: Error) => e instanceof cls && /may still have been created on Higgsfield/.test(e.message));
  }
  process.env.HF_STUB_CREATE = "refused";
  await assert.rejects(hf.start(upImg, [], hfCtx), (e: Error) => !(e instanceof StartUncertainError) && /exactly one/.test(e.message));
  delete process.env.HIGGSFIELD_BIN;
  delete process.env.HF_STUB_CREATE;

  const deadFake = new FakeAdapter();
  deadFake.poll = async () => {
    deadFake.polls++;
    throw new JobNotFoundError("Higgsfield has no job with this id (Job not found)");
  };
  const deadJob = queueFake({ section: "rtm" }, { status: "running", external_id: "fake-dead-id" });
  const deadEngine = makeGenEngine(deadFake);
  deadEngine.gen!.recover();
  await deadEngine.drainGen();
  assert.equal(job(deadJob).status, "error");
  assert.equal(job(deadJob).external_id, null, "a dead id is forgotten so Retry creates a fresh job");
  assert.deepEqual(JSON.parse(job(deadJob).result!).failedExternalIds, ["fake-dead-id"]);
  assert.match(job(deadJob).error ?? "", /not found.*spends credits again/i);
  assert.equal(deadFake.polls, 3, "three not-found polls in a row, then it stops");
  assert.equal(deadFake.starts, 0);

  const unsure = new FakeAdapter();
  unsure.start = async () => {
    throw new StartUncertainError("Create returned no job id. It may still have been created on Higgsfield: check there before retrying (a retry spends credits again).");
  };
  const unsureJob = queueFake({ section: "rtm" });
  await makeGenEngine(unsure).drainGen();
  assert.equal(job(unsureJob).status, "error");
  assert.equal(job(unsureJob).external_id, null);
  assert.equal(JSON.parse(job(unsureJob).result!).startUncertain, true);
  assert.equal(viewOf(unsureJob).startUncertain, true, "the Jobs page warns before a Retry");
  ok("gate: 'Job not found' (real adapter, exit 3) -> id cleared after 3 polls; create without an id / failed = may exist, flagged for Retry");

  // 5. Idempotent landing across a crash (planned target recorded before anything is written).
  class CrashyGuard extends WriteGuard {
    crash: "after-move" | "before-move" | null = null;
    moveIn(src: string, dest: string) {
      if (this.crash === "before-move") {
        this.crash = null;
        throw new Error("simulated crash before the move");
      }
      super.moveIn(src, dest);
      if (this.crash === "after-move") {
        this.crash = null;
        throw new Error("simulated crash after the move");
      }
    }
  }
  const crashy = new CrashyGuard({ drivePath: cfg.drivePath, mounted: () => true });
  const crashEngine = () =>
    new Engine({ cfg: genCfg, db, concurrency: 2, log: quiet, gen: { adapters: { fake: new FakeAdapter() }, concurrency: { fake: 2 }, guard: crashy, pollMs: 5 } });
  const rtmDir = path.join(genBase, "NSM");
  const listing = () => fs.readdirSync(rtmDir).sort();
  for (const mode of ["after-move", "before-move"] as const) {
    const jobId = queueFake({ section: "rtm" }, { prompt: `Crash test ${mode}` });
    crashy.crash = mode;
    await crashEngine().drainGen();
    assert.equal(job(jobId).status, "error", `${mode}: the crash fails the job`);
    const r = JSON.parse(job(jobId).result!);
    assert.equal(r.outputs.length, 0);
    const planned = r.planned[0].path as string;
    assert.ok(fs.existsSync(sidecarPathFor(planned)), `${mode}: sidecar written before the crash`);
    assert.equal(fs.existsSync(planned), mode === "after-move");
    assert.ok(job(jobId).external_id, "local failure keeps the id: Retry re-polls, never re-creates");
    const before = listing();
    assert.equal(retryErrored(s, jobId), 1);
    await crashEngine().drainGen();
    assert.equal(job(jobId).status, "done", job(jobId).error ?? "");
    assert.equal(outputsOf(jobId)[0].path, planned, `${mode}: resumed onto the planned target`);
    const added = listing().filter((f) => !before.includes(f));
    assert.deepEqual(added, mode === "after-move" ? [] : [path.basename(planned)], `${mode}: no duplicate "-2" file`);
    const mine = listing().filter((f) => f.includes(`crash-test-${mode}`));
    assert.deepEqual(mine.sort(), [path.basename(planned), path.basename(sidecarPathFor(planned))].sort(), `${mode}: one file + one sidecar, no orphan`);
    assert.equal(JSON.parse(fs.readFileSync(sidecarPathFor(planned), "utf8")).studioJobId, jobId);
  }
  ok("gate: landing is idempotent after a crash (after the move: only ingested; before it: orphan sidecar reused), no -2 duplicate");

  // 6. Partial Discard: the file goes, the sidecar cannot: the row is still hidden and the message says so.
  const partialOut = outputsOf(again)[0];
  const trashDir2 = path.join(tmp, "Trash2");
  fs.mkdirSync(trashDir2);
  const halfTrash = new WriteGuard({
    drivePath: cfg.drivePath,
    mounted: () => true,
    trashCmd: async (abs) => {
      if (abs.endsWith(".gen.json")) throw new WriteGuardError("trash failed");
      fs.renameSync(abs, path.join(trashDir2, path.basename(abs)));
    },
  });
  const partial = await discardGenerated(partialOut.assetId, s, genCfg, halfTrash);
  assert.ok(partial.ok && partial.sidecarLeft === true);
  assert.equal(fs.existsSync(partialOut.path), false);
  assert.ok(fs.existsSync(sidecarPathFor(partialOut.path)), "sidecar stayed");
  assert.equal((s.prepare("select missing from assets where id = ?").get(partialOut.assetId) as { missing: number }).missing, 1, "row hidden once the file is trashed");
  ok("gate: partial Discard (sidecar trash fails) still marks the row missing and reports sidecarLeft");

  // 7 + 8. Downloads: size cap counted while streaming; results named by their bytes, non-media refused.
  const dl = path.join(tmp, "dl");
  fs.mkdirSync(dl);
  async function* chunks(n: number, size: number) {
    for (let i = 0; i < n; i++) yield Buffer.alloc(size, 7);
  }
  const { Readable } = await import("node:stream");
  await assert.rejects(saveCapped(Readable.from(chunks(10, 1024)), path.join(dl, "big.download"), 4096), /larger than 4096 bytes/);
  assert.equal(fs.existsSync(path.join(dl, "big.download")), false, "over the cap: aborted and deleted");
  assert.equal(await saveCapped(Readable.from(chunks(3, 1024)), path.join(dl, "ok.download"), 4096), 3072);
  fs.writeFileSync(path.join(dl, "1.download"), "<html><body>Access denied</body></html>");
  await assert.rejects(finishDownload(path.join(dl, "1.download"), dl, 1), /not an image or a video/);
  assert.equal(fs.existsSync(path.join(dl, "1.download")), false, "non-media body removed");
  fs.copyFileSync(domPngPath, path.join(dl, "2.download"));
  assert.equal(path.basename(await finishDownload(path.join(dl, "2.download"), dl, 2)), "2.png");
  fs.copyFileSync(small.path, path.join(dl, "3.download"));
  assert.equal(path.basename(await finishDownload(path.join(dl, "3.download"), dl, 3)), "3.mp4");
  fs.copyFileSync(hevc.path, path.join(dl, "4.download"));
  assert.equal(path.basename(await finishDownload(path.join(dl, "4.download"), dl, 4)), "4.mov");
  ff(["-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1", path.join(dl, "5.jpg")]);
  fs.renameSync(path.join(dl, "5.jpg"), path.join(dl, "5.download"));
  assert.equal(path.basename(await finishDownload(path.join(dl, "5.download"), dl, 5)), "5.jpg");
  ok("gate: download size cap enforced while streaming (file removed); results sniffed (png/jpg/mp4/mov), HTML body refused");

  // 9 + 10. Server actions: a Higgsfield run / quick tool without a quote is refused; drive label in messages.
  const { queueGeneration, queueTool: queueToolAction } = await import("../src/app/actions");
  const jobCount = () => (s.prepare("select count(*) n from jobs").get() as { n: number }).n;
  const beforeActions = jobCount();
  const base = { model: "gpt_image_2_5", prompt: "A garden", brandGuard: false, params: {}, references: [], versions: 1, dest: "rtm" };
  const noQuote = await queueGeneration({ ...base, engine: "higgsfield", estimate: null });
  assert.ok(!noQuote.ok && /quote/i.test(noQuote.error), JSON.stringify(noQuote));
  const noToolQuote = await queueToolAction({ assetId: domPng, tool: "upscale", estimate: null });
  assert.ok(!noToolQuote.ok && /quote/i.test(noToolQuote.error));
  const codexNoQuote = await queueGeneration({ ...base, model: "gpt_image", engine: "codex", estimate: null });
  assert.deepEqual(codexNoQuote, { ok: false, error: `${path.basename(cfg.drivePath)} is not mounted.` }, "Codex needs no quote; unmounted message uses the configured drive label");
  assert.equal(jobCount(), beforeActions, "nothing queued");
  ok("gate: server refuses a Higgsfield run / quick tool without a quote (Codex exempt); 'not mounted' uses the drive label");

  // 14. Untested video tools carry "First real run" until one job of that tool + media is done.
  assert.equal(firstRealRunOf(s, "upscale", "video"), true, "video upscale never finished");
  assert.equal(firstRealRunOf(s, "remove_bg", "video"), false, "video bg remove finished above (fake engine)");
  assert.equal(firstRealRunOf(s, "upscale", "image"), false, "image tools are proven");
  const pendingUpVid = queueTool(upVid);
  assert.equal(viewOf(pendingUpVid).firstRun, true);
  assert.equal(viewOf(toolJobs[0]).firstRun, false);
  ok("gate: first real run derived from done jobs per tool + media (video only)");

  // ------------------------------------------------------------ Phase 3: describe (fake vision, stub whisper)
  const { loopbackUrl } = await import("../src/lib/config");
  const { FakeVision } = await import("../src/lib/ai/fake");
  const { WhisperCpp, cleanTranscript } = await import("../src/lib/ai/whisper");
  const { normalizeDescription, DESCRIBE_PROMPT_VERSION } = await import("../src/lib/ai/describe");
  const { requestDescribe, retryDescribeErrors, setDescribePaused, describeSummary } = await import("../src/lib/ai/state");
  const { ftsTerm } = await import("../src/lib/queries");
  const { FFMPEG: FFMPEG_BIN, FFPROBE: FFPROBE_BIN } = await import("../src/worker/proc");

  assert.equal(loopbackUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(loopbackUrl("http://localhost:11434/"), "http://localhost:11434");
  for (const bad of ["http://example.com:11434", "http://10.0.0.5:11434", "http://127.0.0.1.nip.io", "http://127.0.0.1:11434/api", "file:///tmp", "http://u:p@127.0.0.1:1"]) {
    assert.equal(loopbackUrl(bad), null, bad);
  }
  assert.equal(cleanTranscript(" [BLANK_AUDIO] "), "");
  assert.equal(cleanTranscript("(music) you"), "");
  assert.equal(cleanTranscript(" Thank you. "), "");
  assert.equal(cleanTranscript("[MUSIC] Hello from the  quartzite showroom. ♪"), "Hello from the quartzite showroom.");
  assert.equal(normalizeDescription('**Shows:** a sink. People: none\n\nText: "none"'), "Shows: a sink.\nPeople: none\nText: none");
  assert.equal(ftsTerm('" OR x:*'), '{description spoken_open} : "OR x:*"*');
  assert.equal(ftsTerm("*"), null);
  ok("describe helpers: Ollama URL loopback only, whisper hallucinations stripped, labelled lines normalized, FTS terms quoted");

  // A root of its own so only these files are due: a png + a byte-identical copy, a video with audio, one without.
  s.prepare("update roots set enabled = 0").run();
  const dfx = path.join(tmp, "describe-fixture");
  fs.mkdirSync(dfx);
  s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)").run(dfx, fk, Date.now());
  ff(["-f", "lavfi", "-i", "testsrc=size=320x320", "-frames:v", "1", path.join(dfx, "pic.png")]);
  fs.copyFileSync(path.join(dfx, "pic.png"), path.join(dfx, "pic-copy.png"));
  ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=330:duration=4",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dfx, "talk.mp4")]);
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dfx, "silent.mp4")]);
  await run();
  const dRow = (name: string) =>
    s.prepare("select id, sha256, description, description_model, description_version, spoken_open, described_at, describe_error, describe_requested_at from assets where path = ?")
      .get(path.join(dfx, name)) as { id: number; sha256: string; description: string | null; description_model: string | null;
        description_version: number | null; spoken_open: string | null; described_at: number | null; describe_error: string | null; describe_requested_at: number | null };
  assert.equal(dRow("pic.png").sha256, dRow("pic-copy.png").sha256);

  // Stub whisper: counts its calls, checks it got the 16 kHz wav, prints a line with non-speech tags around the words.
  const whisperCalls = path.join(tmp, "whisper-calls.txt");
  const stubWhisper = path.join(tmp, "stub-whisper.sh");
  fs.writeFileSync(stubWhisper, `#!/bin/sh\necho call >> "${whisperCalls}"\n[ -s "$4" ] || exit 9\necho " [MUSIC] Hello from the quartzite showroom. "\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, "stub-model.bin"), "x");
  const whisper = new WhisperCpp({ bin: stubWhisper, model: path.join(tmp, "stub-model.bin"), ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN });
  const whisperCount = () => (fs.existsSync(whisperCalls) ? fs.readFileSync(whisperCalls, "utf8").trim().split("\n").length : 0);
  const vision = new FakeVision();
  const describeEngine = (opts: { promptVersion?: number } = {}) =>
    new Engine({ cfg, db, log: quiet, describe: { vision, whisper, whisperReady: () => true, idleMs: 5, ...opts } });

  // Paused: nothing runs...
  setDescribePaused(s, true);
  let de = describeEngine();
  let counts = await de.drainDescribe();
  assert.equal(vision.calls.length, 0);
  assert.equal(dRow("pic.png").description, null);
  // ...except "Describe again", which also fills the byte-identical copy without a second model call.
  assert.equal(requestDescribe(s, dRow("pic.png").id), true);
  counts = await de.drainDescribe();
  assert.equal(vision.calls.length, 1);
  assert.equal(counts?.described, 1);
  const pic = dRow("pic.png");
  assert.equal(pic.description, "Shows: a zebrawood image scene with a pendant lamp.\nPeople: none\nText: none");
  assert.equal(pic.describe_requested_at, null, "request cleared");
  assert.deepEqual([pic.description_model, pic.description_version], [vision.model, DESCRIBE_PROMPT_VERSION]);
  assert.equal(dRow("pic-copy.png").description, pic.description, "same fingerprint, same description");
  assert.equal(dRow("talk.mp4").description, null, "the rest waits while paused");
  assert.equal(vision.calls[0].images.length, 1);
  assert.deepEqual([...vision.calls[0].images[0].subarray(0, 2)], [0xff, 0xd8], "thumb sent as JPEG");
  ok("describe paused: backfill waits; Describe again runs anyway, clears the request, copies onto the same-fingerprint file (1 model call)");

  // Resume with the originals unreadable and the drive unmounted: describe reads cache files only.
  setDescribePaused(s, false);
  fs.renameSync(dfx, `${dfx}-away`);
  try {
    de = describeEngine();
    assert.equal(de.driveMounted, false);
    counts = await de.drainDescribe();
  } finally {
    fs.renameSync(`${dfx}-away`, dfx);
  }
  assert.equal(vision.calls.length, 3, "talk.mp4 + silent.mp4 only");
  assert.equal(counts?.error, 0);
  for (const name of ["talk.mp4", "silent.mp4"]) assert.match(dRow(name).description ?? "", /^Shows: a zebrawood video scene/);
  const videoCall = vision.calls[1];
  assert.equal(videoCall.images.length, 2);
  assert.ok(videoCall.prompt.includes("first 3 seconds") && videoCall.prompt.includes("contact sheet"));
  assert.equal(dRow("talk.mp4").spoken_open, "Hello from the quartzite showroom.");
  assert.equal(dRow("silent.mp4").spoken_open, "", "no audio track: checked, empty, not an error");
  assert.equal(dRow("silent.mp4").describe_error, null);
  assert.equal(whisperCount(), 1, "whisper ran for the clip with audio only");
  const firstImages = s.prepare("select first_image from descriptions where first_image is not null").pluck().all();
  assert.deepEqual(firstImages, ["opening", "opening"]);
  assert.equal(fs.existsSync(path.join(cfg.cacheDir, "describe-tmp", String(dRow("talk.mp4").id))), false, "temp dir cleaned");
  ok("describe with the originals gone + drive unmounted (cache only): videos get opening frames + sheet; spoken opening from the proxy, empty without audio");

  // A new duplicate reuses the fingerprint cache (no model call); a changed file loses its old description.
  fs.copyFileSync(path.join(dfx, "pic.png"), path.join(dfx, "pic-again.png"));
  await run();
  assert.equal(dRow("pic-again.png").description, null);
  counts = await describeEngine().drainDescribe();
  assert.equal(counts?.cached, 1);
  assert.equal(vision.calls.length, 3, "no model call for a known fingerprint");
  assert.equal(dRow("pic-again.png").description, pic.description);
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x320", "-frames:v", "1", path.join(dfx, "pic-again.png")]);
  await run();
  assert.equal(dRow("pic-again.png").description, null, "new bytes: description cleared, due again");
  await describeEngine().drainDescribe();
  assert.equal(vision.calls.length, 4);
  ok("fingerprint cache: a new copy is described without a model call; changed bytes are described again");

  // Plain search: a word only in descriptions / spoken openings (FTS5), prefix match, hostile syntax harmless.
  const search = (q: string) => listAssets({ kind: "all" }, parseFilters({ q })).items.map((i) => i.filename).sort();
  assert.deepEqual(search("zebraw"), ["pic-again.png", "pic-copy.png", "pic.png", "silent.mp4", "talk.mp4"]);
  assert.deepEqual(search("quartzite"), ["talk.mp4"]);
  assert.deepEqual(search("zebrawood talk"), ["talk.mp4"], "every term must match (description or filename)");
  assert.deepEqual(search("silent"), ["silent.mp4"], "filename search unchanged");
  for (const hostile of ['"', "NEAR(zebra", "zebra*)", "description:x OR", "-zebra", "^"]) search(hostile);
  ok("plain search matches descriptions + spoken openings via FTS5 (prefix, AND across terms), filename search kept, hostile input safe");

  // A new prompt version (or model) makes everything due again; the spoken opening is reused, not re-transcribed.
  const v2 = describeEngine({ promptVersion: DESCRIBE_PROMPT_VERSION + 1 });
  assert.ok(v2.describe!.claimNext(), "due again under the new version");
  const callsBefore = vision.calls.length;
  await v2.drainDescribe();
  assert.equal(vision.calls.length - callsBefore, 4, "one call per distinct fingerprint (pic, pic-again, talk, silent)");
  assert.equal(dRow("talk.mp4").description_version, DESCRIBE_PROMPT_VERSION + 1);
  assert.equal(dRow("talk.mp4").spoken_open, "Hello from the quartzite showroom.");
  assert.equal(whisperCount(), 1, "spoken opening reused across prompt versions");
  assert.equal(describeSummary(s, vision.model, DESCRIBE_PROMPT_VERSION + 1).done, 5);
  ok("prompt version bump: every asset due again, one model call per fingerprint, spoken opening reused");

  // Ollama off: back off without touching any asset. A real failure is stored on that asset and skipped until retried.
  vision.mode = "unavailable";
  const talkId = dRow("talk.mp4").id;
  requestDescribe(s, talkId);
  counts = await describeEngine({ promptVersion: DESCRIBE_PROMPT_VERSION + 1 }).drainDescribe();
  assert.equal(counts?.unavailable, 1);
  assert.equal(dRow("talk.mp4").describe_error, null, "Ollama off is not an asset error");
  assert.ok(dRow("talk.mp4").describe_requested_at, "request kept for when Ollama is back");
  assert.equal((s.prepare("select count(*) n from assets where describe_error is not null").get() as { n: number }).n, 0);
  vision.mode = "fail";
  const v3 = describeEngine({ promptVersion: DESCRIBE_PROMPT_VERSION + 2 });
  counts = await v3.drainDescribe();
  assert.equal(counts?.error, 5, "each due asset fails once, then is skipped");
  assert.match(dRow("talk.mp4").describe_error ?? "", /fake vision failure/);
  assert.equal(dRow("talk.mp4").describe_requested_at, null, "the request it ran for is cleared");
  assert.equal(dRow("talk.mp4").description_version, DESCRIBE_PROMPT_VERSION + 1, "the last good description stays");
  assert.equal(v3.describe!.claimNext(), null, "errored assets are skipped by the backfill");
  vision.mode = "ok";
  assert.equal(retryDescribeErrors(s), 5);
  assert.ok(v3.describe!.claimNext());
  counts = await v3.drainDescribe();
  assert.equal(counts?.described, 4, "pic-copy gets pic's description through the fingerprint");
  assert.equal((s.prepare("select count(*) n from assets where describe_error is not null").get() as { n: number }).n, 0);
  ok("Ollama unavailable: no asset errors, request kept; a failed describe is stored, skipped, and runs again after Retry");

  // ------------------------------------------------------------ Phase 3 slice 2: classify (FakeJev, never Jev)
  const jevLib = await import("../src/lib/ai/jev");
  const { Jev, HttpJevTransport, JevCapReachedError, JevAuthError, JevRequestError, localDayStart, nextLocalDayStart, costUsd, choiceConfidence, setDailyCapUsd, jevSpend } = jevLib;
  const { FakeJev } = await import("../src/lib/ai/fake");
  const { CLASSIFY_VERSION, clientQuestionId, needsReview } = await import("../src/lib/ai/classes");
  const { requestClassify, setClassifyPaused, classifyPaused, retryClassifyErrors, classifySummary } = await import("../src/lib/ai/state");
  const { confirmReview, setManualClass, removeJevClient } = await import("../src/lib/ai/review");
  const { confirmReviewAction } = await import("../src/app/actions");
  const DV = DESCRIBE_PROMPT_VERSION + 2; // the describe section above left every fixture file at this prompt version

  // Day math (America/New_York, DST safe), cost, choice confidence.
  assert.equal(new Date(localDayStart(Date.parse("2026-09-30T03:30:00Z"))).toISOString(), "2026-09-29T04:00:00.000Z", "23:30 EDT is still the 29th");
  assert.equal(new Date(localDayStart(Date.parse("2026-12-01T15:00:00Z"))).toISOString(), "2026-12-01T05:00:00.000Z", "EST");
  assert.equal(new Date(nextLocalDayStart(Date.parse("2026-11-01T12:00:00Z"))).toISOString(), "2026-11-02T05:00:00.000Z", "across the DST change");
  assert.equal(costUsd(1_000_000), 0.042);
  assert.equal(Math.round(choiceConfidence({ a: 0.88, b: 0.12, c: 0 }) * 100) / 100, 0.82);
  assert.equal(classifyPaused(s), true, "seed v5 starts classify paused");
  const hints = s.prepare("select count(*) from clients where classify_hint is not null and length(classify_hint) > 40").pluck().get();
  assert.equal(hints, 8);
  ok("jev helpers: New York day start/next (DST safe), $0.042 per 1M input tokens, choice confidence; seed v5: 8 client hints, classify paused");

  // The real HTTP transport against a stub fetch: the key goes only into the Authorization header, never into
  // ai_calls or an error; 529 is retried, 401 / 422 are not; every call that reached the network is logged.
  const SECRET = "tsk_SMOKE_SECRET_1234567890";
  const seen: { auth: string | null; body: string }[] = [];
  const replies: { status: number; body: unknown; retryAfter?: string }[] = [];
  const stubFetch = (async (_url: string, init: RequestInit) => {
    seen.push({ auth: new Headers(init.headers).get("authorization"), body: String(init.body ?? "") });
    const r = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.retryAfter ? { "retry-after": r.retryAfter } : {} });
  }) as typeof fetch;
  const httpJev = new Jev(s, new HttpJevTransport(() => SECRET, stubFetch), "jev-1.13.0", { sleep: async () => {} });
  const q1 = { yes: { type: "noul" as const, instructions: "Is it a garden?" } };
  replies.push({ status: 529, body: { error: "overloaded" }, retryAfter: "0" });
  replies.push({ status: 200, body: { model: "jev-1.13.0", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1000, output_tokens: 9 } } });
  const okRes = await httpJev.ask(q1, { description: "a garden" }, "test");
  assert.equal(okRes.answers.yes, 0.9);
  assert.equal(seen.length, 2, "529 retried once");
  assert.equal(seen[0].auth, `Bearer ${SECRET}`);
  assert.ok(!seen[0].body.includes(SECRET), "the key is not in the body");
  replies.push({ status: 401, body: { error: "invalid key" } });
  await assert.rejects(httpJev.ask(q1, {}, "test"), JevAuthError);
  replies.push({ status: 422, body: { detail: "questions.yes.criteria: bad" } });
  await assert.rejects(httpJev.ask(q1, {}, "test"), (e: Error) => e instanceof JevRequestError && /criteria/.test(e.message));
  assert.equal(seen.length, 4, "401 and 422 are never retried");
  const calls = s.prepare("select * from ai_calls").all() as Record<string, unknown>[];
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.error ?? null), [null, "HTTP 401", calls[2].error]);
  assert.ok(Math.abs((calls[0].cost_usd as number) - 0.000042) < 1e-12);
  assert.ok(!JSON.stringify(calls).includes(SECRET), "the key never lands in ai_calls");
  ok("jev adapter: key only in the Authorization header (never in ai_calls or errors), 529 retried, 401/422 not retried, every call logged with cost");

  // A 200 is billed even when its body does not parse: usage.input_tokens is read loosely and logged with its cost.
  replies.push({ status: 200, body: { answers: "not an object", usage: { input_tokens: 2000 } } });
  await assert.rejects(httpJev.ask(q1, {}, "test"), JevRequestError);
  const odd = s.prepare("select input_tokens, cost_usd, error from ai_calls order by id desc limit 1").get() as { input_tokens: number | null; cost_usd: number; error: string };
  assert.deepEqual([odd.input_tokens, odd.error], [2000, "Unexpected response shape"]);
  assert.ok(Math.abs(odd.cost_usd - costUsd(2000)) < 1e-12, "billed, so it counts toward the daily cap");
  ok("jev adapter: a 200 with an unexpected shape still logs its input tokens and cost");

  // Classify with FakeJev: its own root (SGD Pros) + one NSM image. Only these assets are due.
  const fj = new FakeJev();
  const jev = new Jev(s, fj, "jev-1.13.0", { sleep: async () => {} });
  const classifyEngine = (opts: { version?: number } = {}) =>
    new Engine({ cfg, db, log: quiet, classify: { jev, visionModel: vision.model, describeVersion: DV, idleMs: 5, ...opts } });
  const rtmSec = (s.prepare("select id from sections where key = 'rtm'").get() as { id: number }).id;
  const rfx = path.join(tmp, "rtm-fixture");
  fs.mkdirSync(rfx);
  s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)").run(rfx, rtmSec, Date.now());
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360", "-frames:v", "1", path.join(rfx, "thumb.png")]);
  await run();
  const rtmId = (s.prepare("select id from assets where path = ?").get(path.join(rfx, "thumb.png")) as { id: number }).id;
  s.prepare("update assets set description = 'Shows: a thumbnail.', description_model = ?, description_version = ?, described_at = ? where id = ?").run(vision.model, DV, Date.now(), rtmId);
  const idOf = (name: string) => dRow(name).id;
  const cPic = idOf("pic.png");
  const cTalk = idOf("talk.mp4");
  const cSilent = idOf("silent.mp4");
  const cRow = (id: number) =>
    s.prepare("select asset_class, class_source, class_confidence, energy, needs_review, classified_at, classify_version, classify_error, classify_requested_at from assets where id = ?").get(id) as {
      asset_class: string | null; class_source: string | null; class_confidence: number | null; energy: number | null; needs_review: number | null;
      classified_at: number | null; classify_version: number | null; classify_error: string | null; classify_requested_at: number | null };
  const unsureOf = (id: number) => JSON.parse((s.prepare("select unsure from classifications where asset_id = ?").pluck().get(id) as string) ?? "null");
  const tagsOf = (id: number) =>
    (s.prepare("select c.code, ac.source from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ? order by c.code").all(id) as { code: string; source: string }[])
      .map((t) => `${t.code}:${t.source}`);
  const nameIn = (state: unknown) => ((state as { file?: { name?: string } }).file?.name ?? "");
  // Per file: what the fake Jev answers (everything else: first option, score 2, noul 0.1).
  const script: Record<string, Record<string, { choice?: string; confidence?: number; score?: number; noul?: number }>> = {
    "pic.png": {
      asset_class: { choice: "static_ad", confidence: 0.95 },
      [clientQuestionId("cedar")]: { noul: 0.9 },
      [clientQuestionId("everest")]: { noul: 0.85 },
      client_universal: { noul: 0.05 },
      energy: { score: 3, confidence: 0.9 },
      brand_safe: { noul: 0.9 },
      visual_format: { choice: "headliner", confidence: 0.9 },
      pp_person: { noul: 0.5 },
      pp_pain: { noul: 0.9 },
      pp_promise: { noul: 0.9 },
    },
    "talk.mp4": {
      asset_class: { choice: "video_ad", confidence: 0.5 },
      [clientQuestionId("acme")]: { noul: 0.9 },
      [clientQuestionId("granite")]: { noul: 0.9 },
      client_universal: { noul: 0.05 },
      brand_safe: { noul: 0.9 },
      pp_person: { noul: 0.9 },
      pp_pain: { noul: 0.9 },
      pp_promise: { noul: 0.9 },
    },
    "silent.mp4": { asset_class: { choice: "broll", confidence: 0.95 }, client_universal: { noul: 0.9 }, brand_safe: { noul: 0.9 } },
    "thumb.png": { asset_class: { choice: "thumbnail", confidence: 0.9 }, brand_safe: { noul: 0.9 }, energy: { score: 2, confidence: 0.9 } },
  };
  fj.respond = (id, _q, state) => script[nameIn(state)]?.[id] ?? (id === "brand_safe" ? { noul: 0.95 } : id === "client_universal" ? { noul: 0.9 } : undefined);

  // Paused: nothing is sent. "Classify again" runs anyway.
  const ce = classifyEngine();
  let cc = await ce.drainClassify();
  assert.equal(fj.requests.length, 0, "paused: no Jev call");
  assert.equal(requestClassify(s, cPic), true);
  cc = await ce.drainClassify();
  assert.equal(cc?.classified, 1, JSON.stringify({ cc, row: cRow(cPic), calls: s.prepare("select error from ai_calls order by id desc limit 2").all() }));
  assert.equal(fj.requests.length, 1);
  let r = cRow(cPic);
  assert.deepEqual([r.asset_class, r.class_source, r.energy, r.needs_review, r.classify_version, r.classify_requested_at], ["static_ad", "jev", 4, 0, CLASSIFY_VERSION, null]);
  assert.deepEqual(unsureOf(cPic), ["pp_person"], "noul at 0.5 is unsure; everything else confident");
  // Only an unsure category, client group or brand safe queues Review (2026-09-30); a soft unsure answer only shows.
  assert.deepEqual(tagsOf(cPic), ["cedar:jev", "everest:jev"], "cedar + everest is a known shared pair: applied as jev rows");
  const q0 = fj.requests[0].questions;
  assert.ok(q0.asset_class && q0.energy && q0.brand_safe && q0.visual_format && q0.pp_person && q0[clientQuestionId("harbor")] && q0.client_universal);
  assert.ok(!q0.hookable, "hookable is for videos only");
  const st0 = fj.requests[0].state as Record<string, unknown>;
  assert.ok(st0.description && (st0.file as Record<string, string>).folder && !("spoken_opening" in st0));
  const callRows = s.prepare("select purpose, asset_id, model, cost_usd, state_chars, answers from ai_calls where purpose = 'classify'").all() as { purpose: string; asset_id: number; model: string; cost_usd: number; state_chars: number; answers: string }[];
  assert.equal(callRows.length, 1);
  assert.equal(callRows[0].asset_id, cPic);
  assert.ok(callRows[0].cost_usd > 0 && callRows[0].state_chars > 50 && JSON.parse(callRows[0].answers).asset_class.probabilities);
  ok("classify paused: nothing sent; Classify again runs it: class, energy 1-5, jev client rows (shared pair), unsure list, one ai_calls row with answers + cost");

  // Resume: the rest (incl. the NSM image) in one pass. Gate: unsure class, two unrelated clients, shared, dropped Ps.
  setClassifyPaused(s, false);
  cc = await ce.drainClassify();
  assert.equal(cc?.classified, 5, "pic-copy, pic-again, talk, silent and the NSM image");
  assert.equal(cRow(rtmId).asset_class, "thumbnail");
  const rtmReq = fj.requests.find((q) => nameIn(q.state) === "thumb.png")!;
  assert.ok(!Object.keys(rtmReq.questions).some((k) => k.startsWith("client_")), "NSM assets never get client questions");
  r = cRow(cTalk);
  assert.equal(r.needs_review, 1);
  assert.deepEqual(unsureOf(cTalk), ["asset_class", "clients"], "class under 0.7; acme + granite both yes is not a shared set");
  assert.deepEqual(tagsOf(cTalk), [], "unsure client group: nothing applied");
  const talkReq = fj.requests.find((q) => nameIn(q.state) === "talk.mp4")!;
  assert.ok(talkReq.questions.hookable && !talkReq.questions.visual_format, "videos: hookable yes, visual format no");
  assert.equal((talkReq.state as Record<string, unknown>).spoken_opening, "Hello from the quartzite showroom.");
  assert.equal((talkReq.state as { file: { length: string } }).file.length, "under 10 seconds", "duration bucket computed in code");
  r = cRow(cSilent);
  assert.deepEqual([r.asset_class, r.needs_review], ["broll", 0]);
  assert.deepEqual(tagsOf(cSilent), [], "universal: shared (no rows)");
  const silentAnswers = JSON.parse(s.prepare("select answers from classifications where asset_id = ?").pluck().get(cSilent) as string);
  assert.equal(silentAnswers.pp_person.dropped, true, "speculative Three P's dropped for b-roll");
  assert.equal(classifySummary(s, { jevModel: "jev-1.13.0", visionModel: vision.model }, CLASSIFY_VERSION, DV).needsReview, 1, "only talk.mp4: pic.png's unsure Person does not queue it");
  assert.deepEqual(
    [needsReview(["energy", "hookable", "pp_person", "visual_format"]), needsReview(["brand_safe"]), needsReview(["clients"]), needsReview(["asset_class"])],
    [false, true, true, true],
    "Review triggers: category, clients, brand safe only",
  );
  ok("classify gate: class under threshold and two unrelated clients -> Review (no rows applied); universal -> shared; Three P's dropped off ads; NSM never asked about clients");

  // Folder + manual rows are never overwritten or removed; with them the client questions are not asked; jev rows
  // are replaced on a re-classify; the Tagger (folder rules on every scan) never deletes jev or manual rows.
  const clientId = (code: string) => (s.prepare("select id from clients where code = ?").get(code) as { id: number }).id;
  s.prepare("insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'manual', ?)").run(idOf("pic-again.png"), clientId("fairway"), Date.now());
  s.prepare("insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'folder', ?)").run(cSilent, clientId("bluebird"), Date.now());
  script["pic.png"][clientQuestionId("everest")] = { noul: 0.05 };
  for (const id of [idOf("pic-again.png"), cSilent, cPic]) requestClassify(s, id);
  const beforeTags = fj.requests.length;
  await ce.drainClassify();
  const reqFor = (name: string) => fj.requests.slice(beforeTags).find((q) => nameIn(q.state) === name)!;
  assert.ok(!Object.keys(reqFor("pic-again.png").questions).some((k) => k.startsWith("client_")), "a manual tag: clients not asked");
  assert.deepEqual((reqFor("pic-again.png").state as { client_tags: string[] }).client_tags, ["Fay / Fairway Home Pros"]);
  assert.deepEqual(tagsOf(idOf("pic-again.png")), ["fairway:manual"]);
  assert.deepEqual(tagsOf(cSilent), ["bluebird:folder"]);
  assert.deepEqual(tagsOf(cPic), ["cedar:jev"], "jev rows replaced (everest dropped)");
  await run(); // full rescan: the Tagger applies folder rules to every asset
  assert.deepEqual(tagsOf(cPic), ["cedar:jev"], "Tagger leaves jev rows alone");
  assert.deepEqual(tagsOf(idOf("pic-again.png")), ["fairway:manual"], "Tagger leaves manual rows alone");
  s.prepare("delete from asset_clients where asset_id = ? and source = 'folder'").run(cSilent);
  // A folder rule that now matches a client Jev had applied turns that row into a folder row (folder wins).
  const copyId = idOf("pic-copy.png");
  s.prepare("insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'jev', ?)").run(copyId, clientId("delta"), Date.now());
  const ruleId = Number(s.prepare("insert into tag_rules (path_glob, client_codes, created_at) values ('pic-copy.png', '[\"delta\"]', ?)").run(Date.now()).lastInsertRowid);
  await run();
  assert.deepEqual(tagsOf(copyId), ["delta:folder"], "jev row promoted to folder by a matching rule");
  s.prepare("delete from tag_rules where id = ?").run(ruleId);
  await run();
  assert.deepEqual(tagsOf(copyId), [], "rule removed: only the folder row goes");
  ok("folder/manual tags never touched (clients not asked when present), jev rows replaced on re-classify, Tagger rescan keeps jev + manual rows and promotes a matching jev row to folder");

  // A new folder rule drops the asset's other jev rows too (folder always wins; Jev only answers for untagged assets).
  for (const [code, src] of [["cedar", "jev"], ["everest", "jev"], ["fairway", "manual"]]) {
    s.prepare("insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, ?, ?)").run(copyId, clientId(code), src, Date.now());
  }
  const rule2 = Number(s.prepare("insert into tag_rules (path_glob, client_codes, created_at) values ('pic-copy.png', '[\"delta\"]', ?)").run(Date.now()).lastInsertRowid);
  await run();
  assert.deepEqual(tagsOf(copyId), ["delta:folder", "fairway:manual"], "stale jev rows gone, manual kept");
  s.prepare("delete from tag_rules where id = ?").run(rule2);
  await run();
  assert.deepEqual(tagsOf(copyId), ["fairway:manual"]);
  s.prepare("delete from asset_clients where asset_id = ?").run(copyId);
  ok("a folder row added by the Tagger removes the asset's stale jev rows; manual rows stay");

  // A manual class survives a re-classify (not asked again); the other answers refresh. A new description = due.
  assert.deepEqual(setManualClass(s, cPic, "before_after"), { ok: true });
  assert.deepEqual([cRow(cPic).asset_class, cRow(cPic).class_source], ["before_after", "manual"]);
  script["pic.png"].energy = { score: 1, confidence: 0.9 };
  const beforeManual = fj.requests.length;
  s.prepare("update assets set described_at = ? where id = ?").run(Date.now() + 1000, cPic); // Describe again landed
  assert.ok(ce.classify!.claimNext(), "a newer description makes it due again");
  await ce.drainClassify();
  const manualReq = fj.requests.slice(beforeManual).find((q) => nameIn(q.state) === "pic.png")!;
  assert.ok(!manualReq.questions.asset_class && !manualReq.questions.visual_format && !manualReq.questions.pp_person, "manual before/after: class and ad questions not asked");
  r = cRow(cPic);
  assert.deepEqual([r.asset_class, r.class_source, r.energy], ["before_after", "manual", 2]);
  const corr = s.prepare("select question, jev_answer, ronny_answer from ai_corrections where asset_id = ?").all(cPic) as { question: string; jev_answer: string; ronny_answer: string }[];
  assert.deepEqual(corr, [{ question: "asset_class", jev_answer: '"static_ad"', ronny_answer: '"before_after"' }]);
  ok("a manual class is kept on re-classify (not asked again, ad questions skipped), energy refreshed; a newer description makes an asset due; the change is a correction");

  // Daily cap: nothing is sent, nothing logged, the queue waits until the next New York midnight.
  const callsBeforeCap = (s.prepare("select count(*) from ai_calls").pluck().get() as number);
  setDailyCapUsd(s, jevSpend(s).todayUsd); // already reached
  requestClassify(s, cSilent);
  const capEngine = classifyEngine();
  cc = await capEngine.drainClassify();
  assert.equal(cc?.capped, 1);
  assert.equal(s.prepare("select count(*) from ai_calls").pluck().get(), callsBeforeCap, "no call made");
  assert.equal(capEngine.classify!.state, "waiting");
  assert.match(capEngine.classify!.note ?? "", /Daily Jev cap reached/);
  assert.equal((await capEngine.drainClassify())?.classified, 0, "still waiting");
  assert.equal(cRow(cSilent).classify_error, null, "the cap is not an asset error");
  await assert.rejects(jev.ask(q1, {}, "test"), JevCapReachedError);
  setDailyCapUsd(s, 1);
  ok("daily cap: refused before sending (no ai_calls row, no asset error), the queue waits until the next local day");

  // Parallel calls reserve their estimate before sending, so a burst cannot pass the cap before any of it is logged.
  const { jevReservedUsd, estimateTokens } = jevLib;
  const est = costUsd(estimateTokens(q1, JSON.stringify({})));
  setDailyCapUsd(s, jevSpend(s).todayUsd + 2.5 * est);
  const burstBefore = fj.requests.length;
  const burst = await Promise.allSettled(Array.from({ length: 5 }, () => jev.ask(q1, {}, "test")));
  assert.deepEqual(burst.map((b) => b.status), ["fulfilled", "fulfilled", "rejected", "rejected", "rejected"]);
  assert.ok(burst.slice(2).every((b) => b.status === "rejected" && b.reason instanceof JevCapReachedError));
  assert.equal(fj.requests.length - burstBefore, 2, "only the calls that fit were sent");
  assert.ok(jevReservedUsd() < 1e-12, "reservations released once the calls are logged");
  setDailyCapUsd(s, 1);
  ok("daily cap vs parallel calls: in-flight estimates are reserved (2 of 5 sent, 3 refused unsent), released after logging");

  // Review confirm: Alex's answers, corrections for what differs, manual sources, needs_review cleared.
  const beforeReview = (s.prepare("select count(*) from ai_corrections").pluck().get() as number);
  const res = confirmReview(s, { assetId: cTalk, assetClass: "talking_head", clients: ["acme"], nouls: { hookable: true, brand_safe: true }, energy: 2 });
  assert.ok(res.ok && res.corrections === 4, JSON.stringify(res));
  r = cRow(cTalk);
  assert.deepEqual([r.asset_class, r.class_source, r.needs_review, r.energy], ["talking_head", "manual", 0, 2]);
  assert.deepEqual(tagsOf(cTalk), ["acme:manual"]);
  const tc = s.prepare("select question, jev_answer, ronny_answer from ai_corrections where asset_id = ? order by id").all(cTalk) as { question: string; jev_answer: string; ronny_answer: string }[];
  assert.deepEqual(tc.map((c) => c.question), ["asset_class", "clients", "hookable", "energy"]);
  assert.deepEqual(JSON.parse(tc[1].jev_answer), ["acme", "granite"]);
  assert.equal((s.prepare("select count(*) from ai_corrections").pluck().get() as number) - beforeReview, 4);
  assert.deepEqual(unsureOf(cTalk), []);
  const bad = await confirmReviewAction({ assetId: cTalk, assetClass: "not_a_class" as never });
  assert.ok(!bad.ok, "server action validates with zod");
  assert.equal(removeJevClient(s, cPic, "cedar"), true, "drawer: removing a Jev chip");
  assert.deepEqual(tagsOf(cPic), []);
  assert.ok(s.prepare("select 1 from ai_corrections where asset_id = ? and question = 'clients'").get(cPic));
  ok("review confirm: corrections for class / clients / yes-no / energy, confirmed tags manual, class manual, needs_review cleared; bad input refused; drawer chip removal is a correction");

  // Corrections become examples in later calls; the Alex-confirmed answers survive a re-classify.
  script["talk.mp4"].hookable = { noul: 0.05 };
  requestClassify(s, cTalk);
  requestClassify(s, idOf("pic-copy.png"));
  const beforeEx = fj.requests.length;
  await ce.drainClassify();
  const exReq = fj.requests.slice(beforeEx).find((q) => nameIn(q.state) === "pic-copy.png")!;
  const instr = exReq.questions.asset_class.instructions as { owners_recent_corrections: { category: string }[] };
  assert.ok(instr.owners_recent_corrections.some((e) => e.category === "talking_head"), "category corrections ride in the class question");
  assert.ok(((exReq.state as { owners_recent_client_tags?: unknown[] }).owners_recent_client_tags ?? []).length >= 1, "client corrections in the state");
  const talkAnswers = JSON.parse(s.prepare("select answers from classifications where asset_id = ?").pluck().get(cTalk) as string);
  assert.deepEqual([talkAnswers.hookable.value, talkAnswers.hookable.source], [1, (await import("../src/lib/ai/classes")).OWNER_SOURCE], "Alex's yes survives Jev's new no");
  assert.equal(cRow(cTalk).asset_class, "talking_head");
  ok("recent corrections feed later calls (class examples in the question, client examples in the state); Alex's answers survive re-classify");

  // Jev down / key missing: waits, no asset error; a refused request (422) is an asset error until Retry.
  fj.mode = "overloaded";
  requestClassify(s, cSilent);
  cc = await classifyEngine().drainClassify();
  assert.equal(cc?.unavailable, 1);
  assert.equal(cRow(cSilent).classify_error, null);
  assert.ok(cRow(cSilent).classify_requested_at, "request kept");
  assert.match(String(s.prepare("select error from ai_calls order by id desc limit 1").pluck().get()), /overloaded/);
  fj.mode = "ok";
  fj.hasKey = false;
  const beforeNoKey = s.prepare("select count(*) from ai_calls").pluck().get();
  cc = await classifyEngine().drainClassify();
  assert.equal(cc?.unavailable, 1);
  assert.equal(s.prepare("select count(*) from ai_calls").pluck().get(), beforeNoKey, "no key: nothing sent or logged");
  fj.hasKey = true;
  fj.mode = "invalid";
  cc = await classifyEngine().drainClassify();
  assert.equal(cc?.error, 1);
  assert.match(cRow(cSilent).classify_error ?? "", /422/);
  assert.equal(cRow(cSilent).classify_requested_at, null);
  fj.mode = "ok";
  s.prepare("update assets set classify_version = null where id = ?").run(cSilent); // due for the backfill again
  assert.equal(classifyEngine().classify!.claimNext(), null, "an errored asset is skipped");
  assert.equal(retryClassifyErrors(s), 1);
  cc = await classifyEngine().drainClassify();
  assert.equal(cc?.classified, 1);
  assert.equal(classifyEngine({ version: CLASSIFY_VERSION + 1 }).classify!.claimNext() != null, true, "a new CLASSIFY_VERSION makes everything due");
  ok("Jev overloaded / no key: the queue waits, no asset error, request kept; a 422 is an asset error, skipped until Retry");

  // Alex's client decision is durable: Review confirm "shared" -> a later classify asks no client question, applies
  // nothing and never queues the file for clients.
  const clientQs = (q: { questions: Record<string, unknown> }) => Object.keys(q.questions).filter((k) => k.startsWith("client_"));
  script["pic-copy.png"] = { [clientQuestionId("cedar")]: { noul: 0.9 }, client_universal: { noul: 0.05 } };
  requestClassify(s, copyId);
  await ce.drainClassify();
  assert.deepEqual(tagsOf(copyId), ["cedar:jev"]);
  assert.deepEqual(confirmReview(s, { assetId: copyId, clients: [] }), { ok: true, corrections: 1 });
  assert.deepEqual(tagsOf(copyId), [], "shared = no rows");
  assert.ok(s.prepare("select clients_decided_at from assets where id = ?").pluck().get(copyId), "decision recorded");
  script["pic-copy.png"][clientQuestionId("acme")] = { noul: 0.5 }; // would make the client group unsure if asked
  requestClassify(s, copyId);
  let beforeDecided = fj.requests.length;
  await ce.drainClassify();
  let dReq = fj.requests.slice(beforeDecided).find((q) => nameIn(q.state) === "pic-copy.png")!;
  assert.ok(dReq, "re-classified");
  assert.deepEqual(clientQs(dReq), [], "no client questions after Alex decided");
  assert.deepEqual([tagsOf(copyId), unsureOf(copyId).includes("clients"), cRow(copyId).needs_review], [[], false, 0]);
  const vNext = classifyEngine({ version: CLASSIFY_VERSION + 1 });
  beforeDecided = fj.requests.length;
  await vNext.drainClassify();
  dReq = fj.requests.slice(beforeDecided).find((q) => nameIn(q.state) === "pic-copy.png")!;
  assert.ok(dReq && clientQs(dReq).length === 0 && tagsOf(copyId).length === 0, "a CLASSIFY_VERSION bump keeps the decision");
  await classifyEngine().drainClassify(); // back to the current version for the rest of the run
  ok("Alex's client decision is durable: confirm shared -> re-classify (also a version bump) sends no client question, applies nothing, no Review");

  // Removing a Jev chip in the drawer: the chips he kept become his (manual), the removed one never comes back.
  script["silent.mp4"] = { ...script["silent.mp4"], [clientQuestionId("cedar")]: { noul: 0.9 }, [clientQuestionId("everest")]: { noul: 0.85 }, client_universal: { noul: 0.05 } };
  requestClassify(s, cSilent);
  await ce.drainClassify();
  assert.deepEqual(tagsOf(cSilent), ["cedar:jev", "everest:jev"]);
  assert.equal(removeJevClient(s, cSilent, "everest"), true);
  assert.deepEqual(tagsOf(cSilent), ["cedar:manual"], "the kept Jev chip becomes Alex's");
  requestClassify(s, cSilent);
  beforeDecided = fj.requests.length;
  await ce.drainClassify();
  dReq = fj.requests.slice(beforeDecided).find((q) => nameIn(q.state) === "silent.mp4")!;
  assert.ok(dReq && clientQs(dReq).length === 0);
  assert.deepEqual(tagsOf(cSilent), ["cedar:manual"], "the removed chip stays gone");
  ok("drawer: removing a Jev chip makes the rest Alex's decision (manual); a re-classify asks nothing and the chip stays gone");

  // A description written while Jev is answering is newer than the one classified: the asset is due again.
  assert.equal(ce.classify!.claimNext(), null, "nothing due");
  requestClassify(s, cTalk);
  const midRow = ce.classify!.claimNext()!;
  assert.equal(midRow.id, cTalk);
  fj.duringCall = () => void s.prepare("update assets set described_at = ? where id = ?").run(Date.now(), cTalk);
  assert.equal((await ce.classify!.runOne(midRow)).outcome, "classified");
  fj.duringCall = null;
  assert.equal(ce.classify!.claimNext()?.id, cTalk, "due again: it classified the older description");
  await ce.drainClassify();
  assert.equal(ce.classify!.claimNext(), null, "classified against the new description: done");
  ok("classify vs a description written mid-call: classify_described_at is the one read at claim time, so the asset is due again");

  // Small shared helpers: folder labels, orientation use (derived, never asked), Jev failure kinds.
  const mediaLib = await import("../src/lib/media");
  assert.deepEqual([mediaLib.folderOf("a/b/c.png", "/Volumes/X/SGD Pros Media"), mediaLib.folderOf("c.png", "/Volumes/X/Root"), mediaLib.folderOf("a/b/c.png")], ["SGD Pros Media/a/b", "Root", "a/b"]);
  assert.deepEqual(
    [mediaLib.orientationUse("video", "9:16", 30), mediaLib.orientationUse("video", "16:9", 600), mediaLib.orientationUse("image", "9:16", null), mediaLib.orientationUse("image", "4:5", null), mediaLib.orientationUse("video", "other", 5), mediaLib.orientationUse("image", null, null)],
    ["Reels / Shorts", "YouTube", "Static (story)", "Static (feed)", "Either", null],
  );
  assert.deepEqual([jevLib.jevFailureKind(new JevCapReachedError("x", 0)), jevLib.jevFailureKind(new JevAuthError("x")), jevLib.jevFailureKind(new JevRequestError("x"))], ["cap", "auth", null]);
  ok("helpers: folderOf (root label + dir, or dir alone for search), orientationUse, jevFailureKind");

  // ------------------------------------------------------------ Phase 3 slice 3: search by meaning (FakeJev, never Jev)
  const meaningLib = await import("../src/lib/ai/search");
  const { meaningSearch, prefilter, makeBatches, MeaningCache, RateLimiter, MEANING_STATE_CHARS, MEANING_STRONG, meaningTerms, meaningFts, categoryHits } = meaningLib;
  const setDesc = (id: number, text: string | null, spoken: string | null = null) =>
    s.prepare("update assets set description = ?, spoken_open = coalesce(?, spoken_open) where id = ?").run(text, spoken, id);
  const cCopy = idOf("pic-copy.png");
  const cAgain = idOf("pic-again.png");
  setDesc(cPic, "Shows: a small garden with white shaker cabinets and a quartz island.\nText: \"FREE QUOTE this week\"");
  setDesc(cCopy, "Shows: a deck before and after: an old tub, then a walk-in shower.");
  setDesc(cAgain, null);
  setDesc(cTalk, "Shows: a householder talking to the camera in her garden.", "We loved our new small garden.");
  setDesc(cSilent, "Shows: a slow pan over a finished basement bar.");
  setDesc(rtmId, "Shows: a YouTube thumbnail with a flowchart and a big face.");
  const noFilters = parseFilters({});

  assert.deepEqual(meaningTerms("Show me the householder talking about a SMALL garden"), ["householder", "talking", "small", "garden"]);
  assert.equal(meaningFts(meaningTerms('" OR x:* NEAR( kitch')), '"near"* OR "kitch"*', "only letters and digits reach MATCH, each quoted");
  assert.equal(meaningFts(["a1", "b2"], "AND"), '"a1"* AND "b2"*');
  assert.ok(categoryHits("before and after deck").includes("before_after") && categoryHits("Riley intro").includes("intro_outro"));
  let pre = prefilter(s, "small garden", { kind: "fkbpros" }, noFilters);
  assert.deepEqual(pre.candidates.slice(0, 2).map((c) => c.id).sort(), [cPic, cTalk].sort(), "text matches first");
  assert.equal(pre.textMatches, 2);
  assert.deepEqual(pre.candidates.map((c) => c.id).sort(), [cPic, cTalk, cSilent, cCopy].sort(), "padded with the scope's other described files; NSM and undescribed left out");
  assert.equal(pre.undescribed, 1, "pic-again (no description) counted");
  pre = prefilter(s, "small garden", { kind: "fkbpros" }, parseFilters({ kind: "video" }));
  assert.deepEqual(pre.candidates.map((c) => c.id).sort(), [cTalk, cSilent].sort(), "Library filters apply");
  pre = prefilter(s, "garden", { kind: "client", code: "acme" }, parseFilters({ shared: "0" }));
  assert.deepEqual(pre.candidates.map((c) => c.id), [cTalk], "client channel without shared: only its tagged files");
  pre = prefilter(s, "before and after", { kind: "fkbpros" }, parseFilters({ cls: "broll" }));
  assert.deepEqual(pre.candidates.map((c) => c.id), [cSilent], "category filter narrows the candidates");
  ok("meaning prefilter: query words quoted (never raw MATCH), all-words matches first, padded inside the channel + filters, undescribed left out and counted");

  // Rerank with FakeJev: one noul per candidate, best first, >= 0.5 strong, the rest weaker; one ai_calls row per request.
  const P: Record<string, number> = { [`a${cTalk}`]: 0.92, [`a${cPic}`]: 0.71, [`a${cCopy}`]: 0.3, [`a${cSilent}`]: 0.05 };
  const fjs = new FakeJev();
  fjs.respond = (id) => ({ noul: P[id] ?? 0 });
  const sJev = new Jev(s, fjs, "jev-1.13.0", { sleep: async () => {} });
  const mkDeps = (limiter = new RateLimiter(20)) => ({ sql: s, jev: sJev, cache: new MeaningCache(), limiter, inflight: new Map() });
  const deps = mkDeps();
  const searchCalls = () => s.prepare("select count(*) from ai_calls where purpose = 'search'").pluck().get() as number;
  let out = await meaningSearch(deps, { query: "householder talking about a small garden", scope: { kind: "fkbpros" }, filters: noFilters });
  assert.ok(out.ok, JSON.stringify(out));
  if (!out.ok) throw new Error("unreachable");
  assert.deepEqual(out.ranking.map((r) => r.id), [cTalk, cPic, cCopy, cSilent], "sorted by P(yes)");
  assert.deepEqual(out.ranking.filter((r) => r.p >= MEANING_STRONG).map((r) => r.id), [cTalk, cPic], "strong >= 0.5; the rest behind weaker matches");
  assert.equal(out.requests, 1);
  assert.equal(out.undescribed, 1);
  assert.equal(fjs.requests.length, 1);
  const sq = fjs.requests[0].questions[`a${cTalk}`];
  assert.equal(sq.type, "noul");
  assert.match(JSON.stringify(sq.instructions), /candidates\.a\d+.*householder talking about a small garden/);
  const sState = fjs.requests[0].state as { candidates: Record<string, Record<string, string>> };
  assert.deepEqual(sState.candidates[`a${cTalk}`], {
    kind: "video",
    category: "Talking head",
    file: "talk.mp4",
    description: "Shows: a householder talking to the camera in her garden.",
    spoken_opening: "We loved our new small garden.",
  }, "compact record: kind, category label, file, (folder,) description, spoken opening");
  assert.equal(searchCalls(), 1, "one ai_calls row, purpose search");
  ok("meaning rerank: one noul per candidate in a compact state, ranked by P(yes), >= 0.5 strong and the rest weaker, logged as purpose search");

  // Same normalized query + scope + filters: served from the cache (no call); other filters: a new search.
  out = await meaningSearch(deps, { query: "  Householder TALKING about a small   garden ", scope: { kind: "fkbpros" }, filters: noFilters });
  assert.ok(out.ok && out.cached && out.ranking[0].id === cTalk);
  assert.equal(fjs.requests.length, 1, "cache hit: no new Jev call");
  out = await meaningSearch(deps, { query: "householder talking about a small garden", scope: { kind: "fkbpros" }, filters: parseFilters({ kind: "video" }) });
  assert.ok(out.ok && !out.cached);
  assert.equal(fjs.requests.length, 2, "other filters: a new search");
  const [same1, same2] = await Promise.all([
    meaningSearch(deps, { query: "quartz island", scope: { kind: "fkbpros" }, filters: noFilters }),
    meaningSearch(deps, { query: "quartz island", scope: { kind: "fkbpros" }, filters: noFilters }),
  ]);
  assert.ok(same1.ok && same2.ok);
  assert.equal(fjs.requests.length, 3, "two identical searches at once share one run");
  ok("meaning cache: the same query (case / spacing ignored) + scope + filters within 10 minutes makes no call; identical searches in flight share one run");

  // Batches: many long candidates stay under the state budget and the per-request count; every candidate asked once.
  const many = Array.from({ length: 130 }, (_, i) => ({
    id: 10_000 + i, kind: "video" as const, filename: `clip-${i}.mp4`, relPath: `Some Folder/clip-${i}.mp4`,
    description: `Shows: ${"a long description of a garden renovation ".repeat(20 + (i % 15))}`, spokenOpen: "Hello there.", assetClass: "broll",
  }));
  const batches = makeBatches("garden renovation", many, 25, 12_000);
  assert.ok(batches.length >= 10, `${batches.length} batches`);
  for (const b of batches) {
    assert.ok(b.ids.length <= 25 && b.ids.length >= 1);
    assert.ok(JSON.stringify(b.state).length <= 12_000, `state ${JSON.stringify(b.state).length} chars`);
    assert.deepEqual(Object.keys(b.questions), b.ids.map((id) => `a${id}`));
  }
  assert.deepEqual(batches.flatMap((b) => b.ids), many.map((c) => c.id), "each candidate once, in order");
  assert.ok(makeBatches("q", many).every((b) => b.ids.length <= 25 && b.stateChars <= MEANING_STATE_CHARS));
  assert.equal(makeBatches("q", many.slice(0, 1))[0].state.candidates[`a${many[0].id}`].category, "B-roll");
  assert.ok(fjs.requests.every((r) => JSON.stringify(r.state).length <= MEANING_STATE_CHARS));
  ok("meaning batches: at most 25 candidates and a state under the character budget per request, every candidate asked exactly once");

  // Rate limit: a token bucket per minute; over it the search is refused before any call (cache hits stay free).
  const t0 = 1_000_000;
  const rl = new RateLimiter(2, 60_000, t0);
  assert.deepEqual([rl.take(t0), rl.take(t0), rl.take(t0)], [true, true, false]);
  assert.ok(rl.retryAfterS(t0) > 0 && rl.retryAfterS(t0) <= 30);
  assert.equal(rl.take(t0 + 30_000), true, "refilled after half a minute");
  const tight = mkDeps(new RateLimiter(1));
  assert.ok((await meaningSearch(tight, { query: "basement bar", scope: { kind: "fkbpros" }, filters: noFilters })).ok);
  const before429 = fjs.requests.length;
  out = await meaningSearch(tight, { query: "walk-in shower", scope: { kind: "fkbpros" }, filters: noFilters });
  assert.ok(!out.ok && out.reason === "rate" && (out.retryAfterS ?? 0) > 0);
  assert.equal(fjs.requests.length, before429, "refused before any call");
  assert.ok((await meaningSearch(tight, { query: "basement  bar", scope: { kind: "fkbpros" }, filters: noFilters })).ok, "a cached search is not rate limited");
  // The route handler itself (zod, the shared deps on globalThis swapped for FakeJev): 400 on bad input, 200 with cards
  // + match, 429 with retry-after over the limit, terse bodies.
  const route = await import("../src/app/api/search/meaning/route");
  (globalThis as { __rtmMeaningSearch?: unknown }).__rtmMeaningSearch = { jev: sJev, cache: new MeaningCache(), limiter: new RateLimiter(1), inflight: new Map() };
  const get = (qs: string) => route.GET(new Request(`http://127.0.0.1:4747/api/search/meaning?${qs}`));
  assert.equal((await get("scope=fkbpros&q=x")).status, 400, "q under 2 characters");
  assert.equal((await get("scope=client&q=garden")).status, 400, "client scope without a client");
  assert.equal((await get("scope=fkbpros&q=garden&kind=nope")).status, 400, "unknown filter value");
  let resp = await get("scope=fkbpros&q=householder%20in%20a%20garden");
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as { ok: boolean; strong: { id: number; match: number }[]; weak: { id: number; match: number }[]; undescribed: number };
  assert.deepEqual([body.ok, body.strong.map((c) => c.id), body.weak.map((c) => c.id).sort(), body.undescribed], [true, [cTalk, cPic], [cCopy, cSilent].sort(), 1]);
  assert.equal(body.strong[0].match, 0.92);
  resp = await get("scope=fkbpros&q=shaker%20cabinets");
  assert.equal(resp.status, 429);
  assert.ok(Number(resp.headers.get("retry-after")) > 0);
  assert.deepEqual(Object.keys(await resp.json()).sort(), ["message", "ok", "reason"]);
  ok("meaning rate limit: token bucket refuses over the limit before any call (cache hits free); route: zod 400s, 200 with ranked cards + match, 429 + retry-after");

  // Paid search only from the app itself: another site's navigation (or the address bar) is refused before any work.
  const beforeXsite = fjs.requests.length;
  const getWith = (headers: Record<string, string>) =>
    route.GET(new Request("http://127.0.0.1:4747/api/search/meaning?scope=fkbpros&q=householder%20in%20a%20garden", { headers }));
  assert.equal((await getWith({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).status, 403);
  assert.equal((await getWith({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" })).status, 403);
  assert.equal((await getWith({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" })).status, 403, "typed into the address bar");
  assert.equal((await getWith({ "sec-fetch-mode": "navigate" })).status, 403, "no site header but a navigation");
  assert.equal(fjs.requests.length, beforeXsite, "no Jev call");
  assert.equal((await getWith({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" })).status, 200, "the app's own fetch (cached here)");
  ok("meaning route: only same-origin fetches (or header-less non-navigations) pass; cross-site / address-bar navigations get 403 without a Jev call");

  // Daily cap: the whole search is refused up front with the cap message (no call, no row); Jev down / no key: terse refusals.
  const beforeCapCalls = searchCalls();
  const beforeCapReq = fjs.requests.length;
  setDailyCapUsd(s, jevSpend(s).todayUsd);
  out = await meaningSearch(mkDeps(), { query: "quartz", scope: { kind: "fkbpros" }, filters: noFilters });
  assert.ok(!out.ok && out.reason === "cap");
  if (!out.ok) assert.equal(out.message, "Daily Jev cap reached. Plain search still works.");
  assert.deepEqual([searchCalls(), fjs.requests.length], [beforeCapCalls, beforeCapReq], "nothing sent or logged");
  setDailyCapUsd(s, 1);
  fjs.mode = "overloaded";
  out = await meaningSearch(mkDeps(), { query: "quartz", scope: { kind: "fkbpros" }, filters: noFilters });
  assert.ok(!out.ok && out.reason === "unavailable");
  fjs.mode = "ok";
  fjs.hasKey = false;
  out = await meaningSearch(mkDeps(), { query: "quartz", scope: { kind: "fkbpros" }, filters: noFilters });
  assert.ok(!out.ok && out.reason === "nokey");
  fjs.hasKey = true;
  ok("meaning daily cap: refused before sending with \"Daily Jev cap reached. Plain search still works.\" (no call, no row); Jev down / no key: terse refusals");

  // The real HTTP transport (stub fetch): the key only in the Authorization header, never in an ai_calls row.
  const sSeen: string[] = [];
  const answerAll = (async (_url: string, init: RequestInit) => {
    sSeen.push(new Headers(init.headers).get("authorization") ?? "");
    const req = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul", noul: 0.6 }]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 900 } }), { status: 200 });
  }) as typeof fetch;
  const httpDeps = { ...mkDeps(), jev: new Jev(s, new HttpJevTransport(() => SECRET, answerAll), "jev-1.13.0", { sleep: async () => {} }) };
  out = await meaningSearch(httpDeps, { query: "flowchart thumbnail", scope: { kind: "all" }, filters: noFilters });
  assert.ok(out.ok && out.ranking.length === 5 && out.inputTokens === 900, JSON.stringify(out));
  assert.deepEqual(sSeen, [`Bearer ${SECRET}`]);
  const searchRows = s.prepare("select * from ai_calls where purpose = 'search'").all();
  assert.ok(searchRows.length >= 4);
  assert.ok(!JSON.stringify(searchRows).includes(SECRET), "the key never lands in ai_calls");
  ok("meaning search over the real HTTP adapter: scope all (both sections), key only in the Authorization header, never in ai_calls");

  // ------------------------------------------------------------ Phase 4 slice 1: hooks, rubric v1, hook scoring (FakeJev)
  const rubricLib = await import("../src/lib/hooks/rubric");
  const { dimensionsFor, overallOf, missingPs } = rubricLib;
  const RUBRIC_V1 = (await import("./smoke-legacy-rubric")).legacyV1() as import("../src/lib/hooks/rubric").RubricContent;
  const starter = (await import("../src/lib/profile")).profile().rubric;
  const hookStore = await import("../src/lib/hooks/store");
  const { currentRubric, hooksPaused, setHooksPaused, addTextHooks, parsePasted, importApprovedCopy, requestScore, setHookArchived, hookScoreSummary } = hookStore;
  const { parseCopyDoc, CopyDocError } = await import("../src/lib/hooks/copydoc");
  const { firstSentence } = await import("../src/lib/hooks/text");
  const { buildHookState, buildHookQuestions } = await import("../src/lib/hooks/score");
  const notesLib = await import("../src/lib/hooks/notes");
  const seedData = await (await import("./smoke-legacy-rubric")).seedTexts(); // slice 1c: the profile's seed texts
  const { seed } = await import("../src/lib/db/seed");
  const { listHooks, parseHookFilters } = await import("../src/lib/hooks/queries");
  const actions = await import("../src/app/actions");

  // Seed v8 (Phase 5 slice 2) already added the SGD rubric version on top of v1. The Phase 4 checks below were written
  // for the v1-only world, so they run on it (v1 current); the Phase 5 slice 2 checks re-run step 8 over their scores.
  s.prepare("delete from rubric_versions where version > 1").run();
  s.prepare("update rubric_versions set current = 1 where version = 1").run();
  // Seed v6: rubric v1 current, notes as drafts, 8 client brand notes, scoring paused; idempotent; no dashes.
  const rv = currentRubric(s);
  assert.equal(rv.version, 1);
  assert.equal(s.prepare("select count(*) from rubric_versions where current = 1").pluck().get(), 1);
  assert.deepEqual([rv.dimensions.length, rv.mechanics.length, rv.avatars.length], [6, 10, 15]);
  assert.ok(rv.dimensions.every((d) => d.levels.length === 5));
  assert.deepEqual(rv.avatars.filter((a) => a.universalOnly).map((a) => a.slug).sort(), ["busy_easyquote", "vettedrating_responsive"]);
  assert.deepEqual(
    [dimensionsFor(rv, "fkbpros", "text").length, dimensionsFor(rv, "fkbpros", "video").length, dimensionsFor(rv, "rtm", "text").length, dimensionsFor(rv, "rtm", "video").length],
    [5, 6, 4, 5],
    "SGD Pros text 5 / video 6; NSM text 4 / video 5",
  );
  assert.equal(hooksPaused(s), true, "hook scoring starts paused");
  const brandNotes = s.prepare("select code, brand_notes, brand_notes_saved_at from clients").all() as { code: string; brand_notes: string; brand_notes_saved_at: number | null }[];
  assert.equal(brandNotes.filter((c) => c.brand_notes && c.brand_notes.split("\n").length >= 5 && c.brand_notes_saved_at == null).length, 8);
  for (const k of ["rtm", "whos_who"] as const) assert.ok(notesLib.getNote(s, k)?.body && notesLib.getNote(s, k)?.savedAt == null);
  const seeded = [
    ...Object.values(seedData.CLIENT_BRAND_NOTES),
    seedData.RTM_NOTES,
    seedData.WHOS_WHO,
    ...rubricLib.SECTION_KEYS.map((k) => notesLib.legacyBrief(k)),
    // Rubric v3 (landing page Phase 2 slice 1): the new NSM brief and the 5 NSM avatars are outgoing copy rules too
    // (since slice 1c the profile's starter rubric carries them).
    starter.briefs.rtm ?? "",
    ...starter.avatars.filter((a) => a.section === "rtm").flatMap((a) => [a.label, a.person, a.pain, a.promise]),
  ];
  for (const text of seeded) assert.ok(!/[—–]| - /.test(text), `no dashes as punctuation: ${text.slice(0, 60)}`);
  for (const d of RUBRIC_V1.dimensions) for (const l of d.levels) assert.ok(!/[—–]| - /.test(l));
  // Alex edited a note and a brand note; the seed runs again (as after a version bump): nothing is clobbered or doubled.
  s.prepare("update clients set brand_notes = 'Alex wrote this.', brand_notes_saved_at = 1 where code = 'granite'").run();
  s.prepare("update notes set body = 'Edited NSM notes.', saved_at = 1 where key = 'rtm'").run();
  s.prepare("update app_settings set value = '5' where key = 'seed_version'").run();
  seed(s, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  assert.equal(s.prepare("select count(*) from rubric_versions").pluck().get(), 1, "no second rubric version");
  assert.equal(s.prepare("select brand_notes from clients where code = 'granite'").pluck().get(), "Alex wrote this.");
  assert.equal(notesLib.getNote(s, "rtm")?.body, "Edited NSM notes.");
  s.prepare("update clients set brand_notes = ?, brand_notes_saved_at = null where code = 'granite'").run(seedData.CLIENT_BRAND_NOTES.granite);
  s.prepare("update notes set body = ?, saved_at = null where key = 'rtm'").run(seedData.RTM_NOTES);
  ok("seed v6: rubric v1 current (6 dimensions x 5 levels, 9 mechanics + none, 12 + 3 avatars, 2 universal only), draft notes for NSM, who's who and 8 clients (no dashes), scoring paused; re-seeding never clobbers edits");

  // Paste parsing + dedupe per channel (archived included), shared vs client channels are separate.
  assert.deepEqual(parsePasted("- Hook one\n\n1. Hook two\n  hook ONE!  \n• Hook three\n2) Hook two"), ["Hook one", "Hook two", "Hook three"]);
  const domCh = { section: "fkbpros" as const, clientCode: "acme" };
  const firstAdd = addTextHooks(s, domCh, parsePasted("Hated your garden for 10 years?\nThe hardest part of a renovation, handled").map((text) => ({ text, source: "pasted" as const })), 1000);
  assert.equal(firstAdd.added, 2);
  const againAdd = addTextHooks(s, domCh, [{ text: "hated your GARDEN for 10 years", source: "pasted" }, { text: "A brand new hook", source: "pasted" }]);
  assert.deepEqual([againAdd.added, againAdd.skipped], [1, 1], "case and punctuation do not make a new hook");
  const sharedAdd = addTextHooks(s, { section: "fkbpros", clientCode: null }, [{ text: "Hated your garden for 10 years?", source: "manual" }]);
  assert.equal(sharedAdd.added, 1, "the shared channel is its own channel");
  setHookArchived(s, againAdd.ids[0], true);
  assert.equal(addTextHooks(s, domCh, [{ text: "A brand new hook!", source: "pasted" }]).skipped, 1, "an archived hook is never re-added");
  setHookArchived(s, againAdd.ids[0], false);
  assert.ok(!(await actions.addHookAction({ scope: { kind: "client", code: "acme" }, text: "x" })).ok, "zod: too short");
  assert.ok(!(await actions.pasteHooksAction({ scope: { kind: "client", code: "NOPE!" } as never, text: "a hook" })).ok, "zod: bad client code");
  assert.ok(!(await actions.pasteHooksAction({ scope: { kind: "rtm" }, text: "\n  \n" })).ok, "nothing to add");
  // (A successful action revalidates Next's cache, which needs the Next runtime: the store call it wraps is tested instead.)
  addTextHooks(s, { section: "rtm", clientCode: null }, parsePasted("Boosted posts got you likes, not leads?\nStop paying an agency to ignore you").map((text) => ({ text, source: "pasted" as const })));
  ok("hooks: paste parsing (markers, blanks, dupes), dedupe per channel on normalized text (archived included), shared separate, server actions zod-validated");

  // Copy doc parsing on a fixture file: headlines, Part C, FORMAT v3, static slot, angle slugs, first sentences, dedupe.
  const docDir = path.join(process.env.STUDIO_CLIENT_DOCS_DIR!, "Adam AcmeCo");
  fs.mkdirSync(docDir, { recursive: true });
  const doc = [
    "# Adam — Final Launch Ad Copy",
    "## Ad 01 — Pain hook (video SGC_ad_1)",
    "**Primary:** Still cooking in a garden you've hated for 10 years? You don't have to gamble. Tap below.",
    "**Headline:** Get Matched With a Vetted Pro",
    "**Description:** Free consultation. No obligation.",
    "**CTA:** Get Quote",
    "# Part C — Angle blocks",
    "## Angle `pain-hook-10-years` — ad 01 (SGC_ad_1.mp4) — Pain hook",
    "Headlines (H1 first; up to 5 ship per ad):",
    "- H1: Get Matched With a Vetted Pro",
    "- H2: Hated Your Garden for 10 Years?  *(added 2026-09-09, approved)*",
    "Primaries (P1 first):",
    "- P1: Still cooking in a garden you've hated for 10 years? More text here.",
    "- P2: No demo. Your garden, updated in about 3 days.",
    "Description: Free consultation.",
    "### 02 `trust-we-vet` (garden, LEARN_MORE)",
    "- H1: We Vet Them So You Don't Have To",
    "```",
    "**Headline:** Inside a code block",
    "```",
    "| Ad | **Headline:** in a table |",
    "# FORMAT v3 PRIMARIES",
    "## trust-we-vet",
    "**P1 (structured):**",
    "🏠 Free garden renovation consultation for Maple County householders.",
    "",
    "Is finding a installer you trust the hardest part?",
    "## Static slot 2026-09-27",
    "### Angle `static_freewalkthrough`: Free walkthrough",
    "**H1:** Maple County Free Garden Walkthrough",
  ].join("\n");
  fs.writeFileSync(path.join(docDir, "ACME-ad-copy-final.md"), doc);
  const parsed = parseCopyDoc(doc).map((l) => `${l.kind[0]}|${l.angle ?? "-"}|${l.text}`);
  assert.deepEqual(parsed, [
    "p|pain-hook-10-years|Still cooking in a garden you've hated for 10 years?",
    "h|pain-hook-10-years|Get Matched With a Vetted Pro",
    "h|pain-hook-10-years|Hated Your Garden for 10 Years?",
    "p|pain-hook-10-years|No demo. Your garden, updated in about 3 days.",
    "h|trust-we-vet|We Vet Them So You Don't Have To",
    "p|trust-we-vet|Free garden renovation consultation for Maple County householders.",
    "h|static_freewalkthrough|Maple County Free Garden Walkthrough",
  ]);
  assert.equal(firstSentence("Visit St. Albion homes today. Then more."), "Visit St. Albion homes today.");
  const imp1 = importApprovedCopy(s, "acme", process.env.STUDIO_CLIENT_DOCS_DIR!);
  assert.deepEqual([imp1.found, imp1.added, imp1.skipped], [7, 6, 1], "the Part C H2 was already pasted into acme");
  const imp2 = importApprovedCopy(s, "acme", process.env.STUDIO_CLIENT_DOCS_DIR!);
  assert.deepEqual([imp2.added, imp2.skipped], [0, 7], "re-runnable: nothing added twice");
  assert.equal(s.prepare("select angle_slug from hooks where text = 'Get Matched With a Vetted Pro'").pluck().get(), "pain-hook-10-years");
  assert.throws(() => importApprovedCopy(s, "granite", process.env.STUDIO_CLIENT_DOCS_DIR!), CopyDocError);
  const missingDoc = await actions.importApprovedCopyAction({ code: "granite" });
  assert.ok(!missingDoc.ok && /Approved copy not found/.test(missingDoc.error), JSON.stringify(missingDoc));
  assert.equal(cfg.clientDocsDir, process.env.STUDIO_CLIENT_DOCS_DIR, "the action reads STUDIO_CLIENT_DOCS_DIR");
  ok("import approved copy: headlines, Part C, FORMAT v3 and static slot lines, first sentence of each primary (short ones extended), angle slugs, code blocks / tables / descriptions ignored, deduped, re-runnable, terse error when the file is missing");

  // Scoring with FakeJev: paused -> nothing; Score again runs while paused. Applicable dimensions per section / kind,
  // avatar options (universal only on shared), state (notes, who's who), overall = mean of levels, unsure marked.
  const hj = new FakeJev();
  const hookJev = new Jev(s, hj, "jev-1.13.0", { sleep: async () => {} });
  const hookEngine = () => new Engine({ cfg, db, log: quiet, hooks: { jev: hookJev, idleMs: 5 } });
  const hookId = (text: string) => s.prepare("select id from hooks where text = ? and parent_id is null order by id limit 1").pluck().get(text) as number;
  const hDom = hookId("The hardest part of a renovation, handled");
  const hShared = s.prepare("select id from hooks where client_id is null and section_id = ? and text = ?").pluck().get(fk, "Hated your garden for 10 years?") as number;
  const hRtm = hookId("Boosted posts got you likes, not leads?");
  const hookScript: Record<string, Record<string, { score?: number; confidence?: number; noul?: number; choice?: string; probabilities?: Record<string, number> }>> = {
    "The hardest part of a renovation, handled": {
      specificity: { score: 3, confidence: 0.9 },
      avatar_match: { score: 2, confidence: 0.9 },
      // Split so that no two neighbouring levels reach the 0.7 threshold (0.35 + 0.3): unsure under the slice 3 rule.
      curiosity_gap: { score: 1, confidence: 0.5, probabilities: { "0": 0.35, "1": 0.3, "3": 0.35 } },
      offer_clarity: { score: 4, confidence: 0.9 },
      brand_fit: { score: 3, confidence: 0.9 },
      pp_person: { noul: 0.9 },
      pp_pain: { noul: 0.8 },
      pp_promise: { noul: 0.6 },
      style: { choice: "negative", confidence: 0.9 },
      avatar: { choice: "abandoned_job_finish", confidence: 0.9 },
      stops_scroll: { noul: 0.5 },
    },
  };
  const textOf = (state: unknown) => ((state as { hook?: { text?: string } }).hook?.text ?? "");
  hj.respond = (id, _q, state) => hookScript[textOf(state)]?.[id];
  const he = hookEngine();
  let hc = await he.drainHooks();
  assert.equal(hj.requests.length, 0, "paused: no Jev call");
  assert.equal(requestScore(s, [hDom, hShared, hRtm]), 3);
  hc = await he.drainHooks();
  assert.equal(hc?.scored, 3, JSON.stringify(hc));
  const reqOf = (text: string) => hj.requests.find((r) => textOf(r.state) === text)!;
  const domReq = reqOf("The hardest part of a renovation, handled");
  const dims = (q: Record<string, unknown>) => Object.keys(q).filter((k) => rv.dimensions.some((d) => d.id === k));
  assert.deepEqual(dims(domReq.questions), ["specificity", "avatar_match", "curiosity_gap", "offer_clarity", "brand_fit"]);
  assert.deepEqual(dims(reqOf("Boosted posts got you likes, not leads?").questions), ["specificity", "avatar_match", "curiosity_gap", "brand_fit"], "NSM: no offer clarity");
  for (const r of [domReq, reqOf("Boosted posts got you likes, not leads?")]) {
    assert.ok(r.questions.pp_person && r.questions.pp_pain && r.questions.pp_promise && r.questions.style && r.questions.avatar && r.questions.stops_scroll);
    assert.ok(!r.questions.visual_stop_power, "visual stop power is video only");
  }
  const avatarOpts = (text: string) => Object.keys((reqOf(text).questions.avatar as { criteria: Record<string, string> }).criteria);
  assert.ok(!avatarOpts("The hardest part of a renovation, handled").includes("vettedrating_responsive"), "client hook: no universal-only avatars");
  assert.equal(avatarOpts("The hardest part of a renovation, handled").length, 11, "10 client avatars + none");
  const sharedReq = hj.requests.find((r) => textOf(r.state) === "Hated your garden for 10 years?")!;
  assert.ok(Object.keys((sharedReq.questions.avatar as { criteria: Record<string, string> }).criteria).includes("busy_easyquote"), "shared hook: universal-only avatars offered");
  assert.deepEqual(avatarOpts("Boosted posts got you likes, not leads?").sort(), ["none", "rtm_installer_burning_spend", "rtm_owner_agency_fed_up", "rtm_owner_boosted_posts"]);
  const domState = domReq.state as { channel: { notes?: string[]; installer?: { name: string }; scope?: string }; whos_who?: string[]; avatars: Record<string, unknown> };
  assert.deepEqual(domState.channel.notes, notesLib.noteLines(seedData.CLIENT_BRAND_NOTES.acme), "client brand notes in the state");
  assert.equal(domState.channel.installer?.name, "Adam / Acme Restoration");
  assert.deepEqual(domState.whos_who, notesLib.noteLines(seedData.WHOS_WHO), "seed v8 added Morgan to the unsaved draft");
  assert.equal(Object.keys(domState.avatars).length, 10);
  assert.deepEqual((reqOf("Boosted posts got you likes, not leads?").state as { channel: { notes: string[] } }).channel.notes, notesLib.noteLines(seedData.RTM_NOTES), "NSM notes for NSM hooks");
  assert.match((sharedReq.state as { channel: { scope: string } }).channel.scope, /shared/);
  type HS = { overall: number; pp_person: number; pp_pain: number; pp_promise: number; style: string; avatar: string; stops_scroll: number; notes_fp: string; unsure: string; call_id: number; rubric_version: number };
  const hsRow = (hid: number) => s.prepare("select * from hook_scores where hook_id = ?").get(hid) as HS;
  const dRowScore = hsRow(hDom);
  assert.ok(Math.abs(dRowScore.overall - overallOf([4, 3, 2, 5, 4])!) < 1e-9 && Math.abs(dRowScore.overall - 3.6) < 1e-9, `overall ${dRowScore.overall}`);
  assert.deepEqual([dRowScore.style, dRowScore.avatar, dRowScore.pp_promise, dRowScore.rubric_version], ["negative", "abandoned_job_finish", 0.6, 1]);
  assert.deepEqual(JSON.parse(dRowScore.unsure).sort(), ["curiosity_gap", "pp_promise", "stops_scroll"], "score confidence 0.5 and nouls at 0.5 / 0.6 are unsure (still clear at >= 0.5)");
  assert.match(dRowScore.notes_fp, /^[0-9a-f]{16}$/);
  const input = he.hooks!.inputFor({ id: hDom, kind: "text", section: "fkbpros", text: "The hardest part of a renovation, handled", client_id: s.prepare("select id from clients where code = 'acme'").pluck().get() as number, asset_id: null, score_requested_at: null });
  assert.equal(buildHookState(rv, input).notesFp, dRowScore.notes_fp, "fingerprint of the notes the state carried");
  assert.notEqual(buildHookState(rv, { ...input, client: { ...input.client!, brandNotes: "Changed notes." } }).notesFp, dRowScore.notes_fp, "changed notes, new fingerprint");
  assert.equal(buildHookState(rv, { ...input, text: "another hook" }).notesFp, dRowScore.notes_fp, "the hook text is not part of the notes fingerprint");
  assert.ok(Object.keys(buildHookQuestions(rv, { ...input, kind: "video", video: { firstSeconds: "a reveal", onScreenText: "WOW", spokenOpening: "hi" } })).includes("visual_stop_power"), "video hooks get visual stop power (slice 2)");
  const hookCalls = s.prepare("select count(*) from ai_calls where purpose = 'hook_score' and error is null").pluck().get();
  assert.equal(hookCalls, 3, "one ai_calls row per hook, purpose hook_score");
  assert.equal(s.prepare("select score_requested_at from hooks where id = ?").pluck().get(hDom), null, "request cleared");
  ok("hook scoring (FakeJev): paused sends nothing, Score again runs anyway; SGD Pros text 5 dimensions, NSM 4, video adds visual stop power; avatar options per section (universal only on shared); notes + who's who in the state; overall = mean of levels; unsure marked; notes fingerprint stored; one hook_score call each");

  // Three P's rule (sort B), score only, the Three P's filter, and the facet-less list query.
  const a3 = addTextHooks(s, domCh, [{ text: "All three clear hook", source: "manual" }, { text: "Missing pain hook", source: "manual" }]).ids;
  hookScript["All three clear hook"] = { specificity: { score: 2 }, avatar_match: { score: 2 }, curiosity_gap: { score: 2 }, offer_clarity: { score: 2 }, brand_fit: { score: 2 }, pp_person: { noul: 0.9 }, pp_pain: { noul: 0.9 }, pp_promise: { noul: 0.9 } };
  hookScript["Missing pain hook"] = { specificity: { score: 4 }, avatar_match: { score: 4 }, curiosity_gap: { score: 4 }, offer_clarity: { score: 4 }, brand_fit: { score: 4 }, pp_person: { noul: 0.9 }, pp_pain: { noul: 0.2 }, pp_promise: { noul: 0.9 } };
  requestScore(s, a3);
  await he.drainHooks();
  const order = (sp: Record<string, string>) =>
    listHooks({ kind: "client", code: "acme" }, parseHookFilters(sp)).rows.filter((r) => r.score).map((r) => r.text);
  const ruleOrder = order({});
  assert.ok(ruleOrder.indexOf("All three clear hook") < ruleOrder.indexOf("Missing pain hook"), `rule B: ${ruleOrder.join(" | ")}`);
  const scoreOrder = order({ sort: "score" });
  assert.equal(scoreOrder[0], "Missing pain hook", "score only: the 5.0 first");
  assert.deepEqual(missingPs({ pp_person: 0.9, pp_pain: 0.2, pp_promise: 0.9 }), ["pp_pain"]);
  const missingRow = listHooks({ kind: "client", code: "acme" }, parseHookFilters({})).rows.find((r) => r.text === "Missing pain hook")!;
  assert.deepEqual([missingRow.score?.missing, missingRow.score?.overall], [["pp_pain"], 5]);
  assert.ok(!order({ pp: "1" }).includes("Missing pain hook") && order({ pp: "1" }).includes("All three clear hook"), "Three P's clear filter");
  assert.ok(listHooks({ kind: "fkbpros" }, parseHookFilters({})).rows.some((r) => r.clientCode === null), "All SGD Pros shows shared hooks too");
  assert.ok(listHooks({ kind: "client", code: "acme" }, parseHookFilters({})).rows.every((r) => r.clientCode === "acme"));
  ok("Three P's rule: all three clear sort first (a 3.0 above a 5.0 missing Pain), score only sorts by overall, Three P's filter, Missing: Pain computed; All SGD Pros includes shared, a client channel only its own");

  // A new rubric version makes every live hook due once Rescore is clicked (slice 3: saving alone makes only never-scored
  // hooks due); old scores stay; archived hooks never are.
  const due = (version: number) => hookScoreSummary(s, version).queued;
  s.prepare("update hooks set score_requested_at = null").run();
  const liveHooks = s.prepare("select count(*) from hooks where archived_at is null").pluck().get() as number;
  setHookArchived(s, hShared, true);
  const scoredLive = s.prepare("select count(*) from hooks h where h.archived_at is null and exists (select 1 from hook_scores x where x.hook_id = h.id)").pluck().get() as number;
  s.transaction(() => {
    s.prepare("update rubric_versions set current = 0 where version = 1").run();
    s.prepare("insert into rubric_versions (version, dimensions, mechanics, avatars, note, current, created_at) select 2, dimensions, mechanics, avatars, 'test', 1, ? from rubric_versions where version = 1").run(Date.now());
  })();
  assert.equal(currentRubric(s).version, 2);
  assert.equal(due(2), liveHooks - 1 - scoredLive, "before Rescore only never-scored hooks are due under v2");
  hookStore.approveRescore(s);
  assert.equal(due(2), liveHooks - 1, "after Rescore every live hook is due under v2 (the archived one is not)");
  assert.equal(s.prepare("select count(*) from hook_scores where rubric_version = 1").pluck().get(), 5, "v1 scores stay");
  setHooksPaused(s, false);
  const beforeV2 = hj.requests.length;
  assert.ok(he.hooks!.claimNext(), "unpaused: the backfill claims under v2");
  setHooksPaused(s, true);
  assert.equal(he.hooks!.claimNext(), null, "paused again: nothing without a request");
  assert.equal(hj.requests.length, beforeV2);
  s.transaction(() => {
    s.prepare("delete from rubric_versions where version = 2").run();
    s.prepare("update rubric_versions set current = 1 where version = 1").run();
  })();
  setHookArchived(s, hShared, false);
  ok("rubric version change: never-scored hooks due at once, scored ones only after Rescore (archived ones never), old scores stay; paused = requests only");

  // A refused request (422) is stored on the hook and skipped until Score again; Jev down waits without touching it.
  hj.mode = "invalid";
  requestScore(s, [hRtm]);
  hc = await hookEngine().drainHooks();
  assert.equal(hc?.error, 1);
  assert.match(s.prepare("select score_error from hooks where id = ?").pluck().get(hRtm) as string, /422/);
  hj.mode = "overloaded";
  requestScore(s, [hRtm]);
  assert.equal(s.prepare("select score_error from hooks where id = ?").pluck().get(hRtm), null, "Score again clears the error");
  hc = await hookEngine().drainHooks();
  assert.equal(hc?.unavailable, 1);
  assert.ok(s.prepare("select score_requested_at from hooks where id = ?").pluck().get(hRtm), "request kept while Jev is down");
  hj.mode = "ok";
  assert.equal((await hookEngine().drainHooks())?.scored, 1);
  assert.ok(!(await actions.scoreHooksAgainAction({ ids: [] })).ok, "zod: at least one id");
  ok("hook scoring errors: a 422 is stored on the hook until Score again; Jev overloaded waits with the request kept");

  // Search by meaning: up to 400 candidates, and the who's who note rides in every request's state.
  const { MEANING_CANDIDATES, prefilter: prefilter4, makeBatches: makeBatches4 } = meaningLib;
  assert.equal(MEANING_CANDIDATES, 400);
  const insFiller = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, description, description_model, description_version)
     values (?, (select id from roots where path = ?), ?, ?, ?, 'png', 'image', 1, ?, ?, 'Shows: a filler zzqfiller garden.', 'x', 1)`,
  );
  s.transaction(() => {
    for (let i = 0; i < 430; i++) insFiller.run(fk, dfx, path.join(dfx, `filler-${i}.png`), `filler-${i}.png`, `filler-${i}.png`, 1000 + i, Date.now());
  })();
  const pre400 = prefilter4(s, "zzqfiller", { kind: "fkbpros" }, noFilters);
  assert.equal(pre400.candidates.length, 400, "400 candidates");
  const whos = notesLib.noteLines(notesLib.whosWho(s));
  const b400 = makeBatches4("zzqfiller", pre400.candidates, 25, meaningLib.MEANING_STATE_CHARS, whos);
  assert.equal(b400.length, 16);
  assert.ok(b400.every((b) => JSON.stringify(b.state.whos_who) === JSON.stringify(whos) && b.stateChars <= meaningLib.MEANING_STATE_CHARS));
  const beforeWho = fjs.requests.length;
  out = await meaningSearch(mkDeps(), { query: "Riley intro zzqfiller", scope: { kind: "fkbpros" }, filters: noFilters });
  assert.ok(out.ok && out.requests === 16, JSON.stringify(out.ok ? { requests: out.requests } : out));
  assert.deepEqual((fjs.requests[beforeWho].state as { whos_who: string[] }).whos_who, whos, "who's who in the search state");
  s.prepare("delete from assets where filename like 'filler-%'").run();
  ok("search by meaning: up to 400 candidates (16 requests of 25), the who's who note rides in every request's state under the budget");

  // ------------------------------------------------------------ Phase 4 slice 2: video hooks, Client tab, notes changed, coverage
  const videoLib = await import("../src/lib/hooks/video");
  const clientLib = await import("../src/lib/hooks/client");
  const coverageLib = await import("../src/lib/hooks/coverage");
  const { getAsset } = await import("../src/lib/queries");
  const { requestChangedRescore } = hookStore;
  const notesChanged = hookStore.changedSinceScored;
  // DB rows only (the sync, the drawer and scoring never read the files): one SGD Pros root, one NSM root.
  const vfk = path.join(tmp, "vh-fkb");
  const vrt = path.join(tmp, "vh-rtm");
  s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)").run(vfk, fk, Date.now());
  s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)").run(vrt, rtmSec, Date.now());
  const insV = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, description, description_model,
       description_version, spoken_open, described_at)
     values (?, (select id from roots where path = ?), ?, ?, ?, 'mp4', ?, 1, 1, 1, ?, 'x', 1, ?, ?)`,
  );
  const insCls = s.prepare("insert or replace into classifications (asset_id, model, version, answers, unsure, created_at) values (?, 'jev-1.13.0', 2, ?, '[]', 1)");
  const setHookable = (aid: number, p: number) => insCls.run(aid, JSON.stringify({ hookable: { type: "noul", value: p, probabilities: {}, confidence: null, source: "jev" } }));
  const vdesc = (opening: string, text: string, label = "First 3 seconds") => `${label}: ${opening}\nShows: a garden.\nText: ${text}\nLooks like: video ad`;
  const vid = (root: string, sec: number, rel: string, desc: string | null, spoken: string | null, hookable?: number, kind = "video") => {
    const aid = Number(insV.run(sec, root, path.join(root, rel), rel, path.basename(rel), kind, desc, spoken, desc ? 1000 : null).lastInsertRowid);
    if (hookable != null) setHookable(aid, hookable);
    return aid;
  };
  const clientIdOf = (c: string) => s.prepare("select id from clients where code = ?").pluck().get(c) as number;
  const tag = (aid: number, c: string) => s.prepare("insert or ignore into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'folder', 1)").run(aid, clientIdOf(c));
  const vA = vid(vfk, fk, "ads/hook-a.mp4", vdesc("A dark garden.", "none"), "Hated your garden for ten years? Here is the fix.", 0.8);
  tag(vA, "acme");
  const vLow = vid(vfk, fk, "ads/low.mp4", vdesc("A room.", "none"), "Not quite a hook at all.", 0.74);
  const vIntro = vid(vfk, fk, "Intro/intro1.mov", vdesc("Riley in the mint garden.", '"Gardens transformed" | "in 3 days" | "[small logo]"'), "");
  const vOutro = vid(vfk, fk, "Outro/Outtro3.mov", vdesc("Riley waves.", "none"), "Want yours next? Tap below.", 0.9);
  const vOutro2 = vid(vfk, fk, "Intro/Outtro/o2.mov", vdesc("Riley waves.", "none"), "Tap below for yours.", 0.9);
  const vRtm = vid(vrt, rtmSec, "reels/r1.mp4", vdesc("A man points at a phone mockup.", "none"), null, 0.9);
  const vTwo = vid(vfk, fk, "ads/two.mp4", vdesc("A deck.", "none"), "Two clients share this one video ad.", 0.8);
  tag(vTwo, "acme");
  tag(vTwo, "granite");
  const vOther = vid(vfk, fk, "ads/other.mp4", vdesc("A slow pan.", '"Free walkthrough"'), "", 0.1);
  const vUndesc = vid(vfk, fk, "ads/undescribed.mp4", null, null, 0.9);
  const vHook = (aid: number) =>
    s.prepare("select id, text, source, section_id, client_id from hooks where asset_id = ? and kind = 'video'").all(aid) as { id: number; text: string; source: string; section_id: number; client_id: number | null }[];
  assert.ok(videoLib.isOutroPath("Outro/a.mov") && videoLib.isOutroPath("x/OUTTRO/a.mov") && !videoLib.isOutroPath("Outro.mov"));
  assert.ok(videoLib.isIntroPath("Intro/a.mov") && !videoLib.isIntroPath("Intros/a.mov"));
  const runOn = "Still stepping over that old tub every morning, SGD Pros connect South Jersey householders with a local team that takes the tub out and builds a walk-in shower in its place";
  assert.equal(videoLib.spokenHookLine(runOn), "Still stepping over that old tub every morning", "a whisper run-on is cut at its first clause break");
  assert.equal(videoLib.spokenHookLine("You paid for this lead then you lost it to a text message that speed to lead watch Someone is scrolling Facebook and they see your ad and tap it"), "You paid for this lead then you lost it to a text message that speed to lead watch");
  let sync = videoLib.syncVideoHooks(s);
  assert.equal(sync.created, 4, JSON.stringify(sync));
  assert.deepEqual(vHook(vA).map((h) => [h.text, h.source, h.client_id]), [["Hated your garden for ten years?", "asset", clientIdOf("acme")]], "spoken first sentence, one client tag = that client");
  assert.deepEqual(vHook(vIntro).map((h) => [h.text, h.client_id]), [["Gardens transformed in 3 days", null]], "Intro clip without speech: on-screen text (pieces joined to 4+ words, placeholder dropped), shared");
  assert.deepEqual(vHook(vRtm).map((h) => [h.text, h.section_id, h.client_id]), [["A man points at a phone mockup.", rtmSec, null]], "NSM, no words: the opening line");
  assert.deepEqual(vHook(vTwo).map((h) => h.client_id), [null], "two client tags = SGD Pros shared");
  for (const aid of [vLow, vOutro, vOutro2, vOther, vUndesc]) assert.equal(vHook(aid).length, 0, `no hook for asset ${aid}`);
  sync = videoLib.syncVideoHooks(s);
  assert.deepEqual(sync, { created: 0, refreshed: 0, moved: 0 }, "idempotent");
  ok("video hooks: hookable >= 0.75 and every SGD Pros Intro clip get one (0.74, outros incl. an Outtro folder inside Intro, and undescribed videos do not); text = spoken first sentence (run-ons cut at a clause break), else on-screen text, else the opening line; channel from the tags (one client / shared / NSM); a second sync changes nothing");

  // Re-classify / re-describe keep the row (text refreshed); tags move it; hidden when missing; described later = created.
  const aHookId = vHook(vA)[0].id;
  setHookable(vA, 0.95);
  s.prepare("update assets set spoken_open = ?, described_at = 2000 where id = ?").run("Still hate that garden from 1990? We fixed ours.", vA);
  sync = videoLib.syncVideoHooks(s);
  assert.deepEqual([sync.created, sync.refreshed], [0, 1]);
  assert.deepEqual(vHook(vA).map((h) => [h.id, h.text]), [[aHookId, "Still hate that garden from 1990?"]], "same row, text refreshed");
  setHookable(vA, 0.2);
  videoLib.syncVideoHooks(s);
  assert.equal(vHook(vA).length, 1, "no longer hookable: the row is never deleted");
  tag(vIntro, "granite");
  sync = videoLib.syncVideoHooks(s);
  assert.deepEqual([sync.moved, vHook(vIntro)[0].client_id], [1, clientIdOf("granite")], "a tag moves it to that client");
  s.prepare("delete from asset_clients where asset_id = ?").run(vIntro);
  videoLib.syncVideoHooks(s);
  assert.equal(vHook(vIntro)[0].client_id, null, "tag removed: shared again");
  const domVideo = () => listHooks({ kind: "client", code: "acme" }, parseHookFilters({ view: "video" })).rows.map((r) => r.id);
  assert.ok(domVideo().includes(aHookId));
  s.prepare("update assets set missing = 1 where id = ?").run(vA);
  assert.ok(!domVideo().includes(aHookId), "missing file: hidden");
  assert.equal(s.prepare("select count(*) from hooks where id = ?").pluck().get(aHookId), 1, "not deleted");
  const qBefore = hookScoreSummary(s, 1).total;
  s.prepare("update assets set missing = 0 where id = ?").run(vA);
  assert.equal(hookScoreSummary(s, 1).total, qBefore + 1, "hidden hooks are not counted (or scored)");
  s.prepare("update assets set description = ?, spoken_open = '', described_at = 1000 where id = ?").run(vdesc("A white garden.", '"Refinishing in days"'), vUndesc);
  assert.equal(videoLib.syncVideoHooks(s).created, 1, "described later: created then");
  assert.equal(vHook(vUndesc)[0].text, "Refinishing in days");
  ok("video hooks stay in sync: re-classify never duplicates or deletes, re-describe refreshes the text on the same row, client tags move it (and back to shared), a missing file hides it (row kept, not counted), a video described later gets its hook then");

  // "Add as hook" for any other video; the drawer shows the hook with its link.
  const added = videoLib.addVideoHook(s, vOther);
  assert.ok(added.ok && added.created);
  assert.equal(vHook(vOther)[0].text, "Free walkthrough");
  const addedAgain = videoLib.addVideoHook(s, vOther);
  assert.ok(addedAgain.ok && !addedAgain.created && addedAgain.id === vHook(vOther)[0].id, "one hook per video");
  assert.throws(() => s.prepare("insert into hooks (section_id, kind, text, norm, asset_id, source, created_at) values (?, 'video', 'x', 'x', ?, 'asset', 1)").run(fk, vOther), /UNIQUE/, "the partial unique index holds");
  const img = vid(vfk, fk, "ads/pic.png", "Shows: a photo.", null, undefined, "image");
  assert.ok(!videoLib.addVideoHook(s, img).ok, "images cannot be video hooks");
  assert.ok(!(await actions.addVideoHookAction({ assetId: -1 })).ok, "zod");
  const detail = getAsset(vOther)!;
  assert.ok(detail.hook && /\/fkbpros\/all\/hooks\?view=video&focus=\d+$/.test(detail.hook.href), JSON.stringify(detail.hook));
  assert.equal(getAsset(vLow)!.hook, null, "no hook yet: the drawer offers Add as hook");
  setHookArchived(s, vHook(vOther)[0].id, true);
  assert.ok(videoLib.addVideoHook(s, vOther).ok && s.prepare("select archived_at from hooks where asset_id = ?").pluck().get(vOther) == null, "Add as hook restores an archived one");
  ok("Add as hook: any described video (once), images refused, the partial unique index holds, zod on the action; the drawer gets the hook with its Hooks tab link (Video view, focused row), or null");

  // Video scoring: the state carries the opening, on-screen text and spoken opening; visual stop power is asked; the
  // Three P's read the spoken line + on-screen text together; NSM video = 5 dimensions, SGD Pros video = 6.
  const vEarly = vid(vfk, fk, "ads/early.mp4", vdesc("A poster frame.", '"Big reveal"', "Early frame"), "Watch this garden change.", 0.9);
  videoLib.syncVideoHooks(s);
  const vIds = [aHookId, vHook(vRtm)[0].id, vHook(vEarly)[0].id];
  const beforeV = hj.requests.length;
  requestScore(s, vIds);
  hc = await hookEngine().drainHooks();
  assert.equal(hc?.scored, 3, JSON.stringify(hc));
  const vReq = (hid: number) => {
    const text = s.prepare("select text from hooks where id = ?").pluck().get(hid) as string;
    return hj.requests.slice(beforeV).find((r) => textOf(r.state) === text)!;
  };
  type VState = { hook: { kind: string }; video: { first_3_seconds?: string; on_screen_text: string; spoken_opening: string } };
  const aState = vReq(aHookId).state as VState;
  assert.deepEqual(aState.video, { first_3_seconds: "A dark garden.", on_screen_text: "none", spoken_opening: "Still hate that garden from 1990? We fixed ours." });
  assert.deepEqual(dims(vReq(aHookId).questions), ["specificity", "avatar_match", "curiosity_gap", "offer_clarity", "visual_stop_power", "brand_fit"], "SGD Pros video: 6");
  assert.deepEqual(dims(vReq(vIds[1]).questions), ["specificity", "avatar_match", "curiosity_gap", "visual_stop_power", "brand_fit"], "NSM video: 5");
  assert.match((vReq(aHookId).questions.pp_pain as { instructions: string }).instructions, /video\.spoken_opening.*video\.on_screen_text/);
  assert.match((vReq(vIds[1]).state as VState).hook.kind, /no words/);
  assert.match((vReq(vIds[2]).state as VState).video.first_3_seconds!, /^Early frame \(the first 3 seconds were not seen\): A poster frame\./);
  assert.equal((vReq(vIds[2]).state as VState).video.on_screen_text, "Big reveal");
  const vScore = s.prepare("select overall, answers from hook_scores where hook_id = ? and rubric_version = 1").get(aHookId) as { overall: number; answers: string };
  assert.ok("visual_stop_power" in JSON.parse(vScore.answers) && Math.abs(vScore.overall - 3) < 1e-9, "6 levels of 3 (FakeJev default score 2) = 3.0");
  // Re-described after its score (gate fix 3): never due by itself, not even while scoring runs; it shows in the Hooks
  // tab's "changed since scored" banner (reason: the description) and its Score again click requests exactly it.
  const aScoredAt = s.prepare("select scored_at from hook_scores where hook_id = ? and rubric_version = 1").pluck().get(aHookId) as number;
  s.prepare("update assets set described_at = ? where id = ?").run(aScoredAt + 1, vA);
  const dueNow = () => s.prepare(`select count(*) from hooks h where h.id = ? and ${hookStore.HOOK_DUE}`).pluck().get({ version: 1 }, aHookId);
  assert.equal(dueNow(), 0, "a re-described video is not due by itself");
  setHooksPaused(s, false);
  const staleClaim = hookEngine().hooks!.claimNext();
  setHooksPaused(s, true);
  assert.notEqual(staleClaim?.id, aHookId, "not claimed even while scoring runs");
  const domVid = hookStore.changedSinceScored(s, { kind: "client", code: "acme" }, "video");
  assert.deepEqual([domVid.ids.includes(aHookId), domVid.described >= 1, domVid.notes], [true, true, 0], "the banner lists it with the description as the reason");
  assert.ok(hookStore.changedSinceScored(s, { kind: "fkbpros" }, "video").ids.includes(aHookId), "All SGD Pros too");
  assert.equal(hookStore.changedSinceScored(s, { kind: "client", code: "acme" }, "text").described, 0, "the Text view has no re-described videos");
  (await import("../src/lib/ai/state")).requestDescribe(s, vA);
  assert.equal(s.prepare("select score_requested_at from hooks where id = ?").pluck().get(aHookId), null, "a drawer Describe again requests no hook score");
  s.prepare("update assets set describe_requested_at = null where id = ?").run(vA);
  const bannerCalls = hj.requests.length;
  assert.equal(hookStore.requestChangedRescore(s, { kind: "client", code: "acme" }, "video"), domVid.count, "Score again requests exactly the listed ones");
  await hookEngine().drainHooks();
  assert.equal(hj.requests.length, bannerCalls + domVid.count, "one call each (while paused: they were requested)");
  assert.equal(hookStore.changedSinceScored(s, { kind: "client", code: "acme" }, "video").count, 0, "rescored: the banner clears");
  ok("video scoring (FakeJev): state carries the opening line (Early frame labelled), on-screen text and spoken opening; visual stop power asked (SGD Pros video 6 dimensions, NSM 5); Three P's on spoken + on-screen text; no-words hooks say so; a re-described video is never due by itself (gate fix: it joins the changed-since-scored banner, Describe again requests nothing, the banner's Score again requests exactly those)");

  // Client tab: brand notes save + saved marker, the one-line hint, What works here CRUD + pin, zod on the actions.
  const tabBefore = clientLib.clientTabData(s, "acme");
  assert.equal(tabBefore.brandNotesSavedAt, null, "seeded draft: Draft, check me");
  assert.ok(tabBefore.rules.some((r) => r.glob === "Client Folder/**"), "folder rules that tag this client");
  assert.ok(!(await actions.saveBrandNotesAction({ code: "NOPE!", body: "x" })).ok, "zod: code");
  assert.ok(!(await actions.saveClientHintAction({ code: "acme", hint: "x".repeat(301) })).ok, "zod: one short line");
  assert.ok(!(await actions.addWorkAction({ code: "acme", body: " " })).ok, "zod: empty item");
  assert.ok(!(await actions.pinHookAction({ hookId: 0, pinned: true })).ok, "zod: hook id");
  clientLib.saveHint(s, "acme", "Adam of Acme:\n gardens and decks ");
  assert.equal(s.prepare("select classify_hint from clients where code = 'acme'").pluck().get(), "Adam of Acme: gardens and decks", "one line");
  const w1 = clientLib.addWork(s, "acme", "Free in-home walkthrough beats free quote");
  const w2 = clientLib.addWork(s, "acme", "Maple County   in the first line");
  clientLib.editWork(s, "acme", w2, "Maple County in the first line works");
  clientLib.moveWork(s, "acme", w2, "up");
  const hPinText = hookId("All three clear hook");
  clientLib.pinHook(s, hPinText);
  clientLib.pinHook(s, hPinText);
  assert.throws(() => clientLib.pinHook(s, hShared), clientLib.ClientTabError, "shared hooks have no Client tab");
  assert.throws(() => clientLib.editWork(s, "granite", w1, "not granite's"), clientLib.ClientTabError, "items belong to their client");
  const works = clientLib.listWorks(s, "acme");
  assert.deepEqual(works.map((w) => w.body ?? `pin:${w.hook?.text}`), ["Maple County in the first line works", "Free in-home walkthrough beats free quote", "pin:All three clear hook"]);
  assert.deepEqual(notesLib.worksLines(s, clientLib.worksOwner(s, "acme")), ["Maple County in the first line works", "Free in-home walkthrough beats free quote", "Pinned hook: All three clear hook"]);
  assert.ok(listHooks({ kind: "client", code: "acme" }, parseHookFilters({})).rows.find((r) => r.id === hPinText)?.pinned, "the row shows Pinned");
  // Gate fix 5: a pin rides along only while its hook is live AND still this client's (archived / moved = left out of
  // the state and the fingerprint, shown on the Client tab as stale with Unpin; back when the hook is back).
  const worksDom = () => notesLib.worksLines(s, clientLib.worksOwner(s, "acme"));
  const fpDom = () => notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkbpros", clientIdOf("acme")));
  const fpPinned = fpDom();
  setHookArchived(s, hPinText, true);
  assert.ok(!worksDom().includes("Pinned hook: All three clear hook") && fpDom() !== fpPinned, "archived pin: out of the state and the fingerprint");
  assert.equal(clientLib.listWorks(s, "acme").find((w) => w.hook?.id === hPinText)?.hook?.state, "archived");
  setHookArchived(s, hPinText, false);
  assert.ok(worksDom().includes("Pinned hook: All three clear hook") && fpDom() === fpPinned, "restored: back");
  const aPin = vHook(vA)[0];
  assert.equal(aPin.client_id, clientIdOf("acme"));
  clientLib.pinHook(s, aPin.id);
  assert.ok(worksDom().includes(`Pinned hook: ${aPin.text}`));
  tag(vA, "granite"); // two client tags: the video hook moves to SGD Pros shared
  videoLib.syncVideoHooks(s);
  assert.ok(!worksDom().includes(`Pinned hook: ${aPin.text}`), "moved to another channel: out of the old client's state");
  const movedItem = clientLib.listWorks(s, "acme").find((w) => w.hook?.id === aPin.id)!;
  assert.deepEqual([movedItem.hook!.state, movedItem.hook!.href], ["moved", `/fkbpros/all/hooks?view=video&focus=${aPin.id}`], "shown as no longer in this channel, linking to its new channel");
  assert.ok(!clientLib.pinnedHookIds(s, [aPin.id]).has(aPin.id), "the moved row is not marked Pinned in its new channel");
  s.prepare("delete from asset_clients where asset_id = ? and client_id = ?").run(vA, clientIdOf("granite"));
  videoLib.syncVideoHooks(s);
  assert.ok(worksDom().includes(`Pinned hook: ${aPin.text}`), "moved back: the pin rides along again");
  assert.equal(clientLib.unpinHook(s, aPin.id), 1);
  clientLib.removeWork(s, "acme", w1);
  assert.equal(clientLib.unpinHook(s, hPinText), 1);
  assert.deepEqual(clientLib.listWorks(s, "acme").map((w) => w.body), ["Maple County in the first line works"]);
  clientLib.saveBrandNotes(s, "acme", seedData.CLIENT_BRAND_NOTES.acme);
  assert.ok(clientLib.clientTabData(s, "acme").brandNotesSavedAt, "saved: the Draft label goes away");
  ok("Client tab: brand notes save sets the saved marker, the hint is one line, What works here adds / edits / reorders / removes and pins a client hook once (shared refused, items scoped to their client), the row shows Pinned; server actions zod-validated; a pinned hook that is archived or moved to another channel leaves the state + fingerprint (shown stale, back when the hook is back)");

  // Notes changed (D5): the fingerprint covers exactly what the state used; an edit flags the scored hooks, Score again
  // requests exactly those, nothing rescores by itself.
  const domText = (scope: { kind: "client"; code: string } | { kind: "fkbpros" } = { kind: "client", code: "acme" }) => notesChanged(s, scope, "text").count;
  clientLib.removeWork(s, "acme", w2);
  // Creative Studio 1b: the seeded hint comes from the Studio config (STUDIO_CONFIG = scripts/fixtures/studio.config.json here).
  clientLib.saveHint(s, "acme", getConfig().studio.clients!.find((c) => c.code === "acme")!.hint!);
  // Rescore acme's text hooks with the current notes so the flag starts clear.
  const domScored = s
    .prepare(`select h.id from hooks h join hook_scores hs on hs.hook_id = h.id and hs.rubric_version = 1 where h.client_id = ? and h.kind = 'text' and h.archived_at is null`)
    .pluck()
    .all(clientIdOf("acme")) as number[];
  requestScore(s, domScored);
  await hookEngine().drainHooks();
  assert.equal(domText(), 0, "just scored: no flag");
  const input2 = hookEngine().hooks!.inputFor({ id: hDom, kind: "text", section: "fkbpros", text: "x", client_id: clientIdOf("acme"), asset_id: null, score_requested_at: null });
  assert.equal(notesLib.channelNotesFp(notesLib.loadChannelNotes(s, "fkbpros", clientIdOf("acme"))), buildHookState(rv, input2).notesFp, "one definition for the state and the flag");
  const wx = clientLib.addWork(s, "acme", "Before and afters from Midvale");
  assert.equal(domText(), domScored.length, "What works here changed: every scored acme text hook flagged");
  assert.equal(domText({ kind: "fkbpros" }), domScored.length, "All SGD Pros counts them too");
  assert.equal(notesChanged(s, { kind: "client", code: "granite" }, "text").count, 0, "other clients unaffected");
  clientLib.removeWork(s, "acme", wx);
  assert.equal(domText(), 0, "back to the scored notes: no flag (an empty list is not in the state or the fingerprint)");
  clientLib.saveBrandNotes(s, "acme", `${seedData.CLIENT_BRAND_NOTES.acme}\nA new line Alex added.`);
  assert.equal(domText(), domScored.length, "brand notes changed");
  const notesCallsBefore = hj.requests.length;
  await hookEngine().drainHooks();
  assert.equal(hj.requests.length, notesCallsBefore, "nothing rescores by itself (paused, no request)");
  assert.ok(!(await actions.rescoreChangedAction({ scope: { kind: "client", code: "acme" }, view: "audio" as never })).ok, "zod: view");
  assert.equal(requestChangedRescore(s, { kind: "client", code: "acme" }, "text"), domScored.length, "Score again requests exactly those");
  assert.equal(domText(), 0, "requested ones are not counted again");
  await hookEngine().drainHooks();
  assert.equal(hj.requests.length, notesCallsBefore + domScored.length, "one call per flagged hook");
  assert.equal(domText(), 0, "rescored with the current notes");
  assert.deepEqual((hj.requests.at(-1)!.state as { channel: { notes: string[] } }).channel.notes.at(-1), "A new line Alex added.");
  clientLib.addWork(s, "acme", "Pinned proof works");
  clientLib.pinHook(s, hPinText);
  requestScore(s, [hPinText]);
  await hookEngine().drainHooks();
  assert.deepEqual((hj.requests.at(-1)!.state as { channel: { what_works_here: string[] } }).channel.what_works_here, ["Pinned proof works", "Pinned hook: All three clear hook"], "What works here rides in the state");
  ok("notes changed: the fingerprint covers exactly the state's notes (hint, brand notes, What works here only when non-empty, who's who); an edit flags that channel's scored hooks (All SGD Pros too, other clients not), nothing rescores by itself, Score again requests exactly those and clears the flag");

  // Coverage strips: live hooks per copy mechanic (unscored and none apart), statics per visual format (SGD Pros).
  const cov = coverageLib.mechanicCoverage(s, { kind: "client", code: "acme" });
  assert.equal(cov.cells.length, 9);
  const styleCounts = s
    .prepare(
      `select hs.style, count(*) as n from hooks h join hook_scores hs on hs.hook_id = h.id and hs.rubric_version = 1
        where h.client_id = ? and h.archived_at is null and (h.parent_id is null or h.kept = 1) group by hs.style`,
    )
    .all(clientIdOf("acme")) as { style: string; n: number }[];
  for (const c of cov.cells) assert.equal(c.count, styleCounts.find((x) => x.style === c.id)?.n ?? 0, c.id);
  const liveDom = s.prepare(`select count(*) from hooks h where h.client_id = ? and ${hookStore.HOOK_LIVE}`).pluck().get(clientIdOf("acme")) as number;
  assert.equal(cov.total, liveDom, "text + video live hooks");
  assert.equal(cov.unscored + cov.none + cov.cells.reduce((a, c) => a + c.count, 0), cov.total);
  assert.ok(cov.cells.some((c) => c.count === 0), "gaps exist (zero)");
  const insStatic = (rel: string, fmt: string) => {
    const aid = vid(vfk, fk, rel, "Shows: an ad.", null, undefined, "image");
    s.prepare("update assets set asset_class = 'static_ad' where id = ?").run(aid);
    insCls.run(aid, JSON.stringify({ visual_format: { type: "choice", value: fmt, probabilities: {}, confidence: 0.9 } }));
    return aid;
  };
  const st1 = insStatic("statics/a.png", "headliner");
  insStatic("statics/b.png", "grid");
  insStatic("statics/c.png", "not_an_ad");
  tag(st1, "acme");
  const fAll = coverageLib.formatCoverage(s, { kind: "fkbpros" });
  assert.equal(fAll.cells.length, 7);
  assert.deepEqual([fAll.cells.find((c) => c.id === "headliner")!.count, fAll.cells.find((c) => c.id === "grid")!.count, fAll.other >= 1], [1, 1, true]);
  const fDom = coverageLib.formatCoverage(s, { kind: "client", code: "acme" });
  assert.deepEqual([fDom.total, fDom.cells.find((c) => c.id === "headliner")!.count, fDom.cells.filter((c) => c.count === 0).length], [1, 1, 6], "a client counts its own statics; 6 gaps");
  const every = coverageLib.allCoverage(s);
  assert.deepEqual(
    [every.length, every[0].formats, every[1].key, every[1].formats?.total, every[2].formats?.total],
    [11, null, "fkb", 0, fAll.total],
    "NSM, SGD (Phase 5 slice 2), All SGD Pros, 8 clients; NSM has no statics strip",
  );
  ok("coverage: live hooks per copy mechanic match the current version's style answers (unscored + none apart, gaps = 0), statics per visual format from classify (not an ad apart, a client only its own), every channel for the Rubric page");

  // ------------------------------------------------------------ Phase 4 slice 3: rewrite variants (stub claude), rubric editing, jobs
  {
  const vrules = await import("../src/lib/hooks/variant-rules");
  const variantsLib = await import("../src/lib/hooks/variants");
  const claudeLib = await import("../src/lib/hooks/claude");
  const scoreLib = await import("../src/lib/hooks/score");
  const rubricEdit = await import("../src/lib/hooks/rubric-edit");

  // Copy rules (pure): each rule, SGD Pros compounds allowed vs NSM none, names from the client row + "Never name" lines,
  // literal claims the notes forbid, AI tells, length, dedupe.
  const allClients = (s.prepare("select code, name, brand_notes as brandNotes from clients order by sort").all() as { code: string; name: string; brandNotes: string | null }[]);
  const domClient = allClients.find((c) => c.code === "acme")!;
  const drakeClient = { ...allClients.find((c) => c.code === "bluebird")!, brandNotes: seedData.CLIENT_BRAND_NOTES.bluebird };
  assert.ok(vrules.clientBannedNames(drakeClient).includes("Toby") && vrules.clientBannedNames(drakeClient).includes("Bluebird Carpentry"), "names from the row + Never name");
  assert.ok(!vrules.clientBannedNames({ ...domClient, brandNotes: "Never speak as Adam, and never name them." }).includes("them"), "pronouns are not names");
  const { houseRulesFor } = await import("../src/lib/profile");
  const fkbRules = vrules.compileVariantRules({ section: "fkbpros", client: drakeClient, allClients, existingNorms: new Set([rubricLib.normHook("Finally, Someone Reliable")]), house: houseRulesFor("fkbpros") });
  const rtmRules = vrules.compileVariantRules({ section: "rtm", client: null, allClients, existingNorms: new Set(), house: houseRulesFor("rtm") });
  const sharedRules = vrules.compileVariantRules({ section: "fkbpros", client: null, allClients, existingNorms: new Set(), house: houseRulesFor("fkbpros") });
  const verdict = (t: string, r = fkbRules) => {
    const v = vrules.checkVariant(t, r);
    return v.ok ? "ok" : v.rule;
  };
  assert.equal(verdict("Tired of stepping into a walk-in tub?"), "ok", "SGD Pros: a hyphen inside a compound is fine");
  assert.equal(verdict("A 10-year garden, finished"), "ok", "digit + letter compound");
  assert.equal(verdict("Your garden - finished"), "dash", "hyphen as punctuation");
  assert.equal(verdict("Your garden, finished 2-3 weeks"), "dash", "a digit range is punctuation");
  assert.equal(verdict("Your garden — finished"), "dash", "em dash");
  assert.equal(verdict("Your garden – finished"), "dash", "en dash");
  assert.equal(verdict("A walk-in shower for your routine", rtmRules), "dash", "NSM: no hyphenated compounds at all");
  assert.equal(verdict("Toby finishes what others leave"), "name", "a person from Never name");
  assert.equal(verdict("Bluebird Carpentry finishes it"), "name", "the company");
  assert.equal(verdict("Acme Restoration does it", sharedRules), "name", "shared SGD Pros hooks never name any installer");
  assert.equal(verdict("Why cedar wins more jobs", rtmRules), "name", "NSM: no client codes");
  assert.equal(verdict("Installers in New Jersey: stop burning ad spend", rtmRules), "state", "NSM: no US state names");
  assert.equal(verdict("Eastport gardens done right in New York"), "ok", "SGD Pros may name places");
  assert.equal(verdict("Gardens from $99 a month"), "claim", "no price when the notes say any price");
  assert.equal(verdict("A licensed Eastport team"), "claim", "licensed is not allowed for this client");
  assert.equal(verdict("Unlock the garden you wanted"), "ai_tell");
  assert.equal(verdict("It's not just a garden, it's a home"), "ai_tell");
  assert.equal(verdict("A seamless renovation in Eastport"), "ai_tell");
  assert.ok(vrules.AI_TELLS.includes("delve") && vrules.AI_TELLS.includes("in today's") && vrules.AI_TELLS.includes("game changer"));
  assert.equal(verdict("Hi"), "length");
  assert.equal(verdict("x".repeat(201)), "length");
  assert.equal(verdict("FINALLY... someone reliable!"), "duplicate", "normalized duplicate of the original");
  const acc = new Set<string>();
  assert.deepEqual([vrules.checkVariant("Same line twice", fkbRules, acc).ok, vrules.checkVariant("same line, twice!", fkbRules, acc).ok], [true, false], "dedupe within a batch");
  assert.ok(vrules.clientClaimBans(seedData.CLIENT_BRAND_NOTES.harbor).every((b) => b.id !== "licensed"), "Hana's notes allow licensed: not banned");
  ok("variant copy rules: SGD Pros compounds allowed (walk-in, 10-year) but dashes / punctuation hyphens / ranges refused, NSM refuses every hyphen, US states and client codes; installer names from the client row + Never name lines (shared = every client); literal claims the notes forbid ($ price, licensed); AI tells; 3 to 200 characters; duplicates of the original, the channel or the batch");

  // The claude runner against a stub script (CLAUDE_BIN): argument array, minimal env (no API key even when the worker has
  // one), never --dangerously-skip-permissions, no tools / MCP / settings, stdin /dev/null, cwd under STUDIO_CACHE.
  const stubDir = path.join(tmp, "claude-stub");
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, "claude");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
D='${stubDir}'
N=$(cat "$D/count" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "$D/count"
printf '%s\\n' "$@" > "$D/args-$N.txt"
/usr/bin/env > "$D/env-$N.txt"
pwd > "$D/cwd-$N.txt"
MODE=$(head -n 1 "$D/queue"); tail -n +2 "$D/queue" > "$D/queue.next"; mv "$D/queue.next" "$D/queue"
case "$MODE" in
  sleep) sleep 20 ;;
  badjson) echo "I could not do that." ;;
  auth) cat "$D/auth.json" ;;
  *) cat "$D/$MODE.json" ;;
esac
`,
  );
  fs.chmodSync(stub, 0o755);
  process.env.CLAUDE_BIN = stub;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-claude";
  const answer = (variants: { text: string; mechanic: string }[]) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, result: JSON.stringify({ variants }), usage: { input_tokens: 3, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 2400 }, modelUsage: { "claude-haiku-4-5": { outputTokens: 5 }, "claude-opus-5": { outputTokens: 120 } }, total_cost_usd: 0.01 });
  const good = [
    { text: "Your installer vanished mid job? A vetted pro finishes it", mechanic: "negative" },
    { text: "Eastport householders: a half done garden, finished by a vetted pro", mechanic: "call_out" },
    { text: "3 weeks of no shows. 1 torn up garden. One call fixes it.", mechanic: "lead_number" },
    { text: "Nobody tells you the deposit guy is never coming back", mechanic: "taboo" },
    { text: "Torn up today, a finished garden soon, with a vetted local pro", mechanic: "transformation" },
  ];
  const mostlyBad = [
    { text: "Acme Restoration finishes it", mechanic: "negative" },
    { text: "Unlock a finished garden", mechanic: "call_out" },
    { text: "Your garden — finished", mechanic: "lead_number" },
    { text: "Maple County householders: a stalled garden, finished by a vetted pro", mechanic: "call_out" },
    { text: "The garden you gave up on can still be finished", mechanic: "made_up_mechanic" },
  ];
  fs.writeFileSync(path.join(stubDir, "good.json"), answer(good));
  fs.writeFileSync(path.join(stubDir, "bad.json"), answer(mostlyBad));
  fs.writeFileSync(
    path.join(stubDir, "second.json"),
    answer([
      { text: "A vetted pro who finishes what the last one left", mechanic: "be_specific" },
      { text: "The garden you gave up on can still be finished", mechanic: "transformation" },
    ]),
  );
  fs.writeFileSync(path.join(stubDir, "allbad.json"), answer([{ text: "Unlock it — now", mechanic: "negative" }]));
  fs.writeFileSync(path.join(stubDir, "auth.json"), JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" }));
  const queueStub = (...modes: string[]) => fs.writeFileSync(path.join(stubDir, "queue"), modes.join("\n") + "\n");
  const stubCalls = () => Number(fs.readFileSync(path.join(stubDir, "count"), "utf8").trim() || 0);
  const vEngine = (timeoutMs = 15_000) => new Engine({ cfg, db, log: quiet, variants: { timeoutMs } });
  const jobOf = (jid: number) => s.prepare("select status, error, result, log_path from jobs where id = ?").get(jid) as { status: string; error: string | null; result: string | null; log_path: string };

  setHooksPaused(s, true);
  queueStub("good");
  const vJob = variantsLib.queueVariants(s, hDom, "lean on the finish, not the start");
  assert.throws(() => variantsLib.queueVariants(s, hDom, null), /already being written/, "one active job per hook");
  assert.equal((await vEngine().drainVariants())?.done, 1);
  const args1 = fs.readFileSync(path.join(stubDir, "args-1.txt"), "utf8").split("\n");
  for (const flag of ["-p", "--output-format", "json", "--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--safe-mode", "--no-session-persistence", "--disable-slash-commands", "--system-prompt"]) {
    assert.ok(args1.includes(flag), `claude gets ${flag}`);
  }
  assert.equal(args1[args1.indexOf("--tools") + 1], "", "--tools \"\" (no built-in tools)");
  assert.equal(args1[args1.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.ok(!args1.some((a) => /dangerously|skip-permissions/.test(a)), "never --dangerously-skip-permissions");
  const env1 = fs.readFileSync(path.join(stubDir, "env-1.txt"), "utf8");
  assert.ok(!/ANTHROPIC|API_KEY|TYPESAFE/.test(env1), "no API key in claude's env");
  assert.match(env1, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
  assert.deepEqual(env1.split("\n").filter(Boolean).map((l) => l.split("=")[0]).filter((k) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(k)).sort(), ["HOME", "LANG", "LOGNAME", "NODE_ENV", "PATH", "TMPDIR", "USER"]);
  assert.ok(fs.readFileSync(path.join(stubDir, "cwd-1.txt"), "utf8").trim().startsWith(path.join(fs.realpathSync(cfg.cacheDir), "claude-tmp")), "cwd under STUDIO_CACHE");
  assert.ok(!fs.existsSync(path.join(cfg.cacheDir, "claude-tmp", `variants-${vJob}`)), "the temp dir is removed after the run");
  const prompt1 = args1.slice(args1.indexOf("--system-prompt") + 2).join("\n");
  for (const bit of ["lean on the finish, not the start", "Copy mechanics", "Three P's", "Connector voice", "Brand notes", "exactly 5", '{"variants"']) assert.ok(prompt1.includes(bit), `prompt has: ${bit}`);
  assert.ok(prompt1.includes(seedData.CLIENT_BRAND_NOTES.acme.split("\n")[0]), "the client's brand notes are in the prompt");
  const j1 = jobOf(vJob);
  const r1 = JSON.parse(j1.result!) as { survivors: number[]; attempts: { model: string; returned: number }[] };
  assert.deepEqual([j1.status, r1.survivors.length, r1.attempts.length, r1.attempts[0].model], ["done", 5, 1, "claude-opus-5"], "the model with the most output is recorded");
  assert.match(fs.readFileSync(j1.log_path, "utf8"), /kept +\[negative\]/);
  assert.equal(path.dirname(j1.log_path), path.join(cfg.logsDir, "jobs"));
  const vRows = s.prepare("select id, kind, source, parent_id, kept, variant_mechanic, score_requested_at, section_id, client_id from hooks where variant_job_id = ? order by id").all(vJob) as {
    id: number; kind: string; source: string; parent_id: number; kept: number | null; variant_mechanic: string; score_requested_at: number | null; section_id: number; client_id: number;
  }[];
  assert.ok(vRows.every((r) => r.kind === "text" && r.source === "variant" && r.parent_id === hDom && r.kept === null && r.score_requested_at && r.client_id === clientIdOf("acme")));
  // Scored at once even though scoring is paused (they were requested); undecided variants never join the backfill.
  const vBefore = hj.requests.length;
  await hookEngine().drainHooks();
  assert.equal(hj.requests.length, vBefore + 5, "variants scored while paused");
  const domList = () => listHooks({ kind: "client", code: "acme" }, parseHookFilters({}));
  const parentRow = domList().rows.find((r) => r.id === hDom)!;
  assert.deepEqual([parentRow.variants.length, parentRow.undecided], [5, 5], "the parent row carries its variants");
  assert.ok(!domList().rows.some((r) => r.parentId === hDom), "undecided variants are hidden from the main list");
  assert.ok(parentRow.variants.every((v) => v.score && v.variantMechanic));
  const ruleB = parentRow.variants.map((v) => [v.score!.missing.length === 0 ? 0 : 1, -(v.score!.overall ?? 0)]);
  assert.deepEqual(ruleB, [...ruleB].sort((a, b) => a[0] - b[0] || a[1] - b[1]), "variants ranked by rule B");
  assert.equal(variantsLib.keepVariant(s, vRows[0].id), true);
  assert.equal(variantsLib.discardVariant(s, vRows[1].id), true);
  assert.equal(variantsLib.discardVariant(s, vRows[0].id), false, "a kept variant is decided");
  // Gate fix 8: a kept variant counts for dedupe like any top level hook (paste / import skip its text).
  assert.deepEqual(
    [addTextHooks(s, domCh, [{ text: good[0].text.toUpperCase(), source: "pasted" }]).skipped, addTextHooks(s, domCh, [{ text: good[2].text, source: "pasted" }]).skipped],
    [1, 0],
    "a kept variant's text is skipped; an undecided variant's is not a channel hook yet",
  );
  s.prepare("delete from hooks where parent_id is null and norm = ? and source = 'pasted'").run(rubricLib.normHook(good[2].text));
  const after = domList();
  assert.ok(after.rows.some((r) => r.id === vRows[0].id && r.source === "variant" && r.parentId === hDom), "kept = a normal live hook (source variant, parent kept)");
  assert.equal(after.rows.find((r) => r.id === hDom)!.undecided, 3);
  assert.ok(!after.rows.find((r) => r.id === hDom)!.variants.some((v) => v.id === vRows[1].id), "discarded = gone");
  assert.ok(s.prepare("select archived_at from hooks where id = ?").pluck().get(vRows[1].id), "discard archives it");
  assert.ok(!(await actions.queueVariantsAction({ hookId: hDom, steer: "x".repeat(500) })).ok, "zod: steer length");
  assert.throws(() => variantsLib.queueVariants(s, vRows[2].id, null), /live hook/, "an undecided variant cannot be rewritten");
  assert.equal(claudeLib.parseClaudeJson(answer(good)).model, "claude-opus-5", "the writer = most output tokens");
  assert.equal(claudeLib.resolveClaude()?.cmd, fs.realpathSync(stub), "CLAUDE_BIN resolved to its real path");
  ok("rewrite variants (stub claude): argument array with -p, JSON output, no tools, no MCP, no settings, safe mode, no session; never skip-permissions; env = HOME/USER/LOGNAME/LANG/TMPDIR/NODE_ENV/PATH only (no API key); cwd under the cache; prompt has notes, steer, mechanics, Three P's, rules; 5 variant hooks (text, parent, undecided) scored at once while paused, ranked under the parent (rule B), hidden from the list; Keep = live hook (its text now dedupes pastes), Discard = archived; log in logs/jobs");

  // Fewer than 3 survive = one retry of the whole call (told what broke); survivors of both runs kept. Still fewer = done
  // with a note; none = error. Timeout, bad JSON and a signed-out CLI = job errors (Retry runs it again).
  const hRetry = addTextHooks(s, domCh, [{ text: "Stalled garden renovation?", source: "manual" }]).ids[0];
  const callsBefore = stubCalls();
  queueStub("bad", "good");
  const jRetry = variantsLib.queueVariants(s, hRetry, null);
  await vEngine().drainVariants();
  const rr = JSON.parse(jobOf(jRetry).result!) as { survivors: number[]; attempts: { kept: number; dropped: { rule: string }[] }[]; note: string | null };
  assert.equal(stubCalls(), callsBefore + 2, "one retry");
  assert.deepEqual(rr.attempts.map((a) => a.kept), [2, 3], "2 passed, then the retry filled up to 5");
  assert.deepEqual(rr.attempts[0].dropped.map((d) => d.rule).sort(), ["ai_tell", "dash", "name"]);
  assert.equal(rr.survivors.length, 5);
  const retryPrompt = fs.readFileSync(path.join(stubDir, `args-${callsBefore + 2}.txt`), "utf8");
  assert.match(retryPrompt, /Your last answer broke these rules/);
  assert.equal(s.prepare("select variant_mechanic from hooks where variant_job_id = ? and text = ?").pluck().get(jRetry, "The garden you gave up on can still be finished"), null, "an unknown mechanic id is kept as null");
  const hFew = addTextHooks(s, domCh, [{ text: "Garden still unfinished?", source: "manual" }]).ids[0];
  queueStub("second", "allbad");
  const jFew = variantsLib.queueVariants(s, hFew, null);
  await vEngine().drainVariants();
  assert.deepEqual([jobOf(jFew).status, JSON.parse(jobOf(jFew).result!).survivors.length], ["done", 2]);
  assert.match(JSON.parse(jobOf(jFew).result!).note, /Only 2 variants passed/);
  queueStub("allbad", "allbad");
  const jNone = variantsLib.queueVariants(s, hRetry, null);
  await vEngine().drainVariants();
  assert.deepEqual([jobOf(jNone).status, jobOf(jNone).error], ["error", "No variant passed the copy rules (see the log)."]);
  queueStub("sleep");
  const jSlow = variantsLib.queueVariants(s, hRetry, null);
  const t0 = Date.now();
  await vEngine(1_500).drainVariants();
  assert.ok(Date.now() - t0 < 10_000, "the timeout kills the run (process group)");
  assert.match(jobOf(jSlow).error!, /took longer than 2 s/);
  queueStub("badjson");
  assert.ok(variantsLib.retryVariantJob(s, jSlow), "Retry an errored job");
  await vEngine().drainVariants();
  assert.match(jobOf(jSlow).error!, /no JSON|not JSON|not valid JSON/);
  queueStub("auth");
  variantsLib.retryVariantJob(s, jSlow);
  await vEngine().drainVariants();
  assert.match(jobOf(jSlow).error!, /claude auth login/);
  const jPend = variantsLib.queueVariants(s, hFew, null);
  assert.equal(variantsLib.cancelVariantJob(s, jPend), true, "Cancel while pending");
  assert.equal(jobOf(jPend).status, "cancelled");
  s.prepare("update jobs set status = 'running' where id = ?").run(jPend);
  assert.equal(vEngine().variants!.recover(), 1, "a running job after a restart becomes an error");
  assert.match(jobOf(jPend).error!, /Interrupted/);
  const views = variantsLib.variantJobs(s);
  const vView = views.find((v) => v.id === jRetry)!;
  assert.deepEqual([vView.status, vView.survivors, vView.returned, vView.attempts, vView.channel], ["done", 5, 10, 2, "Adam"]);
  ok("variants retry: under 3 survivors = one retry told which rules broke (survivors of both kept, up to 5), still under 3 = done with a note, none = error; timeout (process group killed), bad JSON and a signed-out CLI are job errors; Retry and Cancel (pending only); a running job after a restart is an error; Jobs page rows (survivors, returned, runs, channel)");

  // Gate fix 1 (E2): five DIFFERENT mechanics, in code. A variant whose mechanic a kept survivor already uses is dropped
  // (rule mechanic) after the copy rules; it counts toward the retry threshold, and the retry is told the taken mechanics.
  fs.writeFileSync(
    path.join(stubDir, "dupmech.json"),
    answer([
      { text: "Half done garden? A vetted pro can finish the job", mechanic: "negative" },
      { text: "The installer left and the cabinets never got hung", mechanic: "negative" },
      { text: "Stuck with bare walls and no installer to call", mechanic: "negative" },
      { text: "Your torn up garden deserves a pro who shows up", mechanic: "negative" },
      { text: "Householders with a stalled renovation: this is for you", mechanic: "call_out" },
    ]),
  );
  fs.writeFileSync(
    path.join(stubDir, "mechretry.json"),
    answer([
      { text: "Nobody warns you a renovation can stall for months", mechanic: "negative" },
      { text: "Renovation stalled? Householders, this one is for you", mechanic: "call_out" },
      { text: "2 months of plywood counters is 2 months too long", mechanic: "lead_number" },
      { text: "Nobody admits the second installer is the easy part", mechanic: "taboo" },
      { text: "From bare studs to a finished garden with one call", mechanic: "transformation" },
    ]),
  );
  const hMech = addTextHooks(s, domCh, [{ text: "Garden renovation stuck halfway?", source: "manual" }]).ids[0];
  const mechCalls = stubCalls();
  queueStub("dupmech", "mechretry");
  const jMech = variantsLib.queueVariants(s, hMech, null);
  await vEngine().drainVariants();
  const rm = JSON.parse(jobOf(jMech).result!) as { survivors: number[]; attempts: { kept: number; dropped: { rule: string; detail: string }[] }[] };
  assert.equal(stubCalls(), mechCalls + 2, "2 survivors after the mechanic check = one retry");
  assert.deepEqual(rm.attempts.map((a) => a.kept), [2, 3]);
  assert.deepEqual(rm.attempts[0].dropped.map((d) => [d.rule, d.detail]), Array(3).fill(["mechanic", vrules.MECHANIC_CLASH]));
  assert.deepEqual(rm.attempts[1].dropped.map((d) => d.rule), ["mechanic", "mechanic"], "the retry's repeats are dropped too");
  const mechs = s.prepare("select variant_mechanic from hooks where variant_job_id = ? order by id").pluck().all(jMech) as string[];
  assert.deepEqual([mechs.length, new Set(mechs).size], [5, 5], "five kept variants, five different mechanics");
  assert.match(fs.readFileSync(path.join(stubDir, `args-${mechCalls + 2}.txt`), "utf8"), /already use these mechanics, so pick others: negative, call_out/);
  assert.match(fs.readFileSync(jobOf(jMech).log_path, "utf8"), /dropped \[negative\] .* <- same copy mechanic as another variant/);

  // Gate fix 7: the parent is re-checked when claude answers (archived meanwhile = a clear job error, nothing written),
  // and Retry refuses an archived hook until it is restored.
  queueStub("mechretry"); // five passing lines for this hook (another hook's undecided variants do not dedupe)
  const jArch = variantsLib.queueVariants(s, hFew, null);
  setHookArchived(s, hFew, true);
  await vEngine().drainVariants();
  assert.deepEqual([jobOf(jArch).status, jobOf(jArch).error], ["error", "The hook was archived while claude was writing."]);
  assert.equal(s.prepare("select count(*) from hooks where variant_job_id = ?").pluck().get(jArch), 0, "nothing written");
  assert.throws(() => variantsLib.retryVariantJob(s, jArch), /archived: restore it first/);
  setHookArchived(s, hFew, false);
  assert.equal(variantsLib.retryVariantJob(s, jArch), true, "restored: Retry works");
  assert.equal(variantsLib.cancelVariantJob(s, jArch), true);

  // Gate fix 6: the generic job Retry never re-queues a hook_variants row (its own action has the one-active-job and
  // live-hook checks); derive and generation rows still retry there.
  const jobsLib = await import("../src/lib/jobs");
  assert.equal(jobsLib.retryErrored(s, jSlow), 0, "a hook_variants error is not retried by the generic path");
  assert.equal(jobOf(jSlow).status, "error");
  const dj = Number(s.prepare("insert into jobs (type, asset_id, status, priority, attempts, error, created_at) values ('derive_thumb', ?, 'error', 0, 1, 'x', 1)").run(vA).lastInsertRowid);
  assert.equal(jobsLib.retryErrored(s, dj), 1, "a derive error still is");
  s.prepare("delete from jobs where id = ?").run(dj);
  ok("variants gate fixes: a repeated copy mechanic is dropped after the copy rules (rule mechanic) and counts toward the retry, which is told the taken mechanics (five kept, five mechanics); a hook archived while claude writes = job error with nothing written, Retry refused until restored; the generic job Retry skips hook_variants rows");

  // Rubric editing: saving = a new version (never in place), zod checks, nothing due until Rescore, Rescore makes due, old
  // scores kept and shown (labelled) until the new one lands.
  const v1 = currentRubric(s);
  const edited = structuredClone({ dimensions: v1.dimensions, mechanics: v1.mechanics, avatars: v1.avatars });
  edited.dimensions[0].levels[0] = "Generic: could run for any company; nothing a viewer could picture or check.";
  edited.dimensions.push({ id: "new_dim", label: "Proof", short: "Proof", question: "How much proof does `hook.text` carry?", appliesTo: { kinds: ["text"], sections: ["fkbpros"] }, levels: ["None.", "Implied.", "One proof.", "Two proofs.", "Proof all through."] });
  edited.avatars = edited.avatars.filter((a) => a.slug !== "stalled_diy");
  assert.throws(() => hookStore.saveRubricVersion(s, edited, ""), /note/);
  assert.throws(() => hookStore.saveRubricVersion(s, { ...v1 }, "no change"), /Nothing changed/);
  assert.throws(() => hookStore.saveRubricVersion(s, { ...edited, dimensions: edited.dimensions.filter((d) => !d.appliesTo.kinds.includes("video")) }, "no video dims"), /hooks need at least one dimension/);
  assert.throws(() => hookStore.saveRubricVersion(s, { ...edited, mechanics: edited.mechanics.map((m, i) => (i === 0 ? { ...m, label: "Renamed" } : m)) }, "renamed"), /keep their names/);
  assert.ok(!(await actions.saveRubricAction({ content: { dimensions: [], mechanics: [], avatars: [] } as never, note: "x" })).ok, "action: refused by the checks");
  s.prepare("update hooks set score_requested_at = null, score_error = null").run();
  (await import("../src/lib/ai/jev")).setDailyCapUsd(s, 20); // earlier checks spent FakeJev "dollars" up to the cap
  setHooksPaused(s, false);
  await hookEngine().drainHooks(); // every never-scored live hook first, so only the new version's rescore is left
  const scoredBefore2 = s.prepare("select count(*) from hook_scores").pluck().get() as number;
  const v2 = hookStore.saveRubricVersion(s, edited, "Proof dimension for SGD Pros text; stalled_diy removed");
  assert.equal(v2, v1.version + 1);
  assert.equal(s.prepare("select count(*) from rubric_versions where current = 1").pluck().get(), 1);
  assert.deepEqual(JSON.parse(s.prepare("select dimensions from rubric_versions where version = ?").pluck().get(v1.version) as string)[0].levels[0], v1.dimensions[0].levels[0], "v1 unchanged");
  const preview = hookStore.rescorePreview(s);
  const liveScored = s.prepare(`select count(*) from hooks h where ${hookStore.HOOK_LIVE} and exists (select 1 from hook_scores x where x.hook_id = h.id)`).pluck().get() as number;
  assert.deepEqual([preview.version, preview.approved, preview.count], [v2, false, liveScored], "N hooks will be rescored");
  assert.ok(preview.usd > 0 && Math.abs(preview.usd - preview.count * hookStore.hookScoreUnitUsd(s)) < 1e-12, "about $X from the average hook_score cost");
  const beforeSave = hj.requests.length;
  await hookEngine().drainHooks();
  assert.equal(hj.requests.length, beforeSave, "saving alone spends nothing, even with scoring on");
  const staleRow = domList().rows.find((r) => r.id === hDom)!;
  assert.deepEqual([staleRow.score?.version, staleRow.score?.stale], [v1.version, true], "the old score still shows, labelled");
  assert.equal(hookStore.approveRescore(s), liveScored);
  await hookEngine().drainHooks();
  assert.equal(hj.requests.length, beforeSave + liveScored, "Rescore: every live scored hook once");
  const fresh = domList().rows.find((r) => r.id === hDom)!;
  assert.deepEqual([fresh.score?.version, fresh.score?.stale], [v2, false]);
  assert.ok(fresh.score!.dims.some((d) => d.id === "new_dim"), "the new dimension is asked and shown");
  assert.equal(s.prepare("select count(*) from hook_scores").pluck().get(), scoredBefore2 + liveScored, "old scores kept");
  assert.ok(!Object.keys((hj.requests.at(-1)!.questions.avatar as { criteria: Record<string, string> }).criteria).includes("stalled_diy"), "a removed avatar is no longer offered");
  // Gate fix 4: the Rescore line covers what the click releases. While paused, "Rescore and resume scoring" also scores
  // the never-scored backlog (not errors, not ones already requested): N rescored + M waiting, cost for both.
  const hNew = addTextHooks(s, { section: "rtm", clientCode: null }, [{ text: "A line nobody has scored yet", source: "manual" }]).ids[0];
  const hNewErr = addTextHooks(s, { section: "rtm", clientCode: null }, [{ text: "A line whose scoring failed", source: "manual" }]).ids[0];
  s.prepare("update hooks set score_error = 'Jev refused (422)' where id = ?").run(hNewErr);
  assert.equal(hookStore.rescorePreview(s).waiting, 0, "scoring runs: the click releases nothing extra");
  setHooksPaused(s, true);
  const p4 = hookStore.rescorePreview(s);
  assert.deepEqual([p4.paused, p4.waiting], [true, 1], "paused: the never-scored hook waits (the errored one does not)");
  assert.ok(Math.abs(p4.usd - (p4.count + p4.waiting) * hookStore.hookScoreUnitUsd(s)) < 1e-12, "the cost covers rescored + waiting");
  requestScore(s, [hNew]);
  assert.equal(hookStore.rescorePreview(s).waiting, 0, "a requested hook runs anyway (not released by the click)");
  setHookArchived(s, hNew, true);
  setHookArchived(s, hNewErr, true);
  assert.ok(rubricEdit.slugId("Visual stop power", []) === "visual_stop_power" && rubricEdit.slugId("style", []) === "style_2", "ids from labels; reserved ids avoided");
  ok("rubric editing: save = a new current version (v1 untouched), checks refuse no note / no change / a kind without dimensions / renamed mechanics; N hooks will be rescored, about $X; nothing is due or spent until Rescore (even with scoring on), old scores show labelled with their version; Rescore scores each live hook once with the new dimension, old scores kept, removed avatars not offered; while paused the line adds the never-scored backlog the click releases (N rescored + M waiting, cost for both)");

  // NSM notes / who's who editing (not versioned): saving clears the Draft label and raises the notes changed flag.
  assert.equal(notesChanged(s, { kind: "rtm" }, "text").count, 0);
  notesLib.saveNote(s, "rtm", `${seedData.RTM_NOTES}\nNever say growth hacking.`);
  assert.ok(notesLib.getNote(s, "rtm")!.savedAt, "saved: no longer a draft");
  assert.ok(notesChanged(s, { kind: "rtm" }, "text").count > 0, "NSM hooks flagged");
  const beforeWho = notesChanged(s, { kind: "client", code: "acme" }, "text").count;
  notesLib.saveNote(s, "whos_who", `${seedData.WHOS_WHO}\nAlex is the NSM face.`);
  assert.ok(notesChanged(s, { kind: "client", code: "acme" }, "text").count > beforeWho, "who's who flags every channel");
  assert.ok(!(await actions.saveNoteAction({ key: "other", body: "x" })).ok, "zod: note key");
  ok("notes editing: NSM notes and who's who save without a version, the Draft label goes away, the hooks scored with the old text are flagged (who's who in every channel); nothing rescores by itself");

  // Unsure rule (Alex, 2026-09-30): a level score is unsure only when its two most likely neighbouring levels together
  // are under the threshold; choices and nouls keep their rules; stored scores are recomputed once, idempotently.
  const sc = (probabilities: Record<string, number>) => ({ type: "score" as const, value: 1.5, probabilities, confidence: 0.5, source: "jev" as const });
  assert.equal(scoreLib.hookAnswerUnsure(sc({ "1": 0.5, "2": 0.4, "3": 0.1 }), 0.7), false, "split between 2 and 3 = sure");
  assert.equal(scoreLib.hookAnswerUnsure(sc({ "0": 0.35, "2": 0.3, "4": 0.35 }), 0.7), true, "spread over far levels = unsure");
  assert.equal(scoreLib.hookAnswerUnsure({ type: "score", value: 2, probabilities: {}, confidence: 0.5, source: "jev" }, 0.7), true, "no probabilities: confidence");
  assert.equal(scoreLib.hookAnswerUnsure({ type: "choice", value: "x", probabilities: { x: 0.6 }, confidence: 0.6, source: "jev" }, 0.7), true, "choice keeps the gate");
  assert.equal(scoreLib.hookAnswerUnsure({ type: "noul", value: 0.6, probabilities: {}, confidence: null, source: "jev" }, 0.7), true, "noul band");
  const oneScore = s.prepare("select hook_id, rubric_version from hook_scores limit 1").get() as { hook_id: number; rubric_version: number };
  s.prepare("update hook_scores set unsure = '[\"everything\"]' where hook_id = ? and rubric_version = ?").run(oneScore.hook_id, oneScore.rubric_version);
  s.prepare("delete from app_settings where key = 'hooks:unsure_rule'").run();
  assert.ok(hookStore.recomputeHookUnsure(s, 0.7) >= 1);
  assert.notEqual(s.prepare("select unsure from hook_scores where hook_id = ? and rubric_version = ?").pluck().get(oneScore.hook_id, oneScore.rubric_version), '["everything"]');
  assert.equal(hookStore.recomputeHookUnsure(s, 0.7), 0, "runs once per rule version");
  // Gate fix 9: a new classify threshold (the Settings action forces this) moves the stored marks at once, SQL only.
  const splitScore = { specificity: { type: "score", value: 1.5, probabilities: { "1": 0.45, "2": 0.35, "3": 0.2 }, confidence: 0.45, source: "jev" } };
  s.prepare("update hook_scores set answers = ?, unsure = '[]' where hook_id = ? and rubric_version = ?").run(JSON.stringify(splitScore), oneScore.hook_id, oneScore.rubric_version);
  const unsureOf = () => JSON.parse(s.prepare("select unsure from hook_scores where hook_id = ? and rubric_version = ?").pluck().get(oneScore.hook_id, oneScore.rubric_version) as string) as string[];
  const jevBefore9 = hj.requests.length;
  assert.equal(hookStore.recomputeHookUnsure(s, 0.9), 0, "not forced: the rule marker stops it");
  assert.ok(hookStore.recomputeHookUnsure(s, 0.9, true) >= 1 && unsureOf().includes("specificity"), "threshold 0.9: 0.8 on neighbours is unsure");
  hookStore.recomputeHookUnsure(s, 0.7, true);
  assert.deepEqual(unsureOf(), [], "back to 0.7: sure again");
  assert.equal(hj.requests.length, jevBefore9, "no Jev");
  assert.match(fs.readFileSync(path.join(process.cwd(), "src/app/actions.ts"), "utf8"), /setClassifyThreshold\(sql, value\);\s*\/\/[^\n]*\n\s*const n = recomputeHookUnsure\(sql, value, true\)/, "the threshold action recomputes the hook marks");
  ok("unsure rule (Alex's amendment): a score is unsure only when its top two neighbouring levels hold less than the threshold (falls back to confidence without probabilities); choices and nouls unchanged; stored scores recomputed from their probabilities once (idempotent, no Jev) and again, forced, when the classify threshold changes");

  // Jobs page + Settings: the Hook scoring summary counts undecided variants' requests, errors list + Retry all, spend by purpose.
  requestScore(s, [hRtm]);
  s.prepare("update hooks set score_error = 'Jev refused (422)' where id = ?").run(hDom);
  const sum = hookScoreSummary(s, currentRubric(s).version);
  assert.deepEqual([sum.requested, sum.errors, sum.paused], [1, 1, true]);
  assert.ok(sum.total === s.prepare(`select count(*) from hooks h where ${hookStore.HOOK_LIVE}`).pluck().get(), "total = live hooks (undecided variants apart)");
  const errs = hookStore.hookErrors(s);
  assert.deepEqual([errs.length, errs[0].id, errs[0].href], [1, hDom, `/fkbpros/acme/hooks?focus=${hDom}`]);
  assert.equal(hookStore.retryHookErrors(s), 1);
  assert.equal(hookScoreSummary(s, currentRubric(s).version).errors, 0);
  const spend = (await import("../src/lib/ai/jev")).jevSpendByPurpose(s);
  assert.ok(spend.find((p) => p.purpose === "hook_score")!.allTimeCalls >= 5 && spend.some((p) => p.purpose === "classify"));
  s.prepare("update hooks set score_requested_at = null").run();
  delete process.env.ANTHROPIC_API_KEY;
  ok("Jobs + Settings: the Hook scoring summary (live total, requested incl. variants, errors, paused), error rows link to the row and Retry all = Score again, Jev spend by purpose");

  // Gate fix 10, paged 2026-10-06: the Hooks tab shows HOOKS_PAGE (15) rows a page (`?page=`), server rendered; no
  // page in the URL = the page holding `focus` (a variant's parent row), else page 1; a page past the end = the last.
  assert.deepEqual(
    [{}, { page: "2" }, { page: "0" }, { page: "abc" }, { page: "999999" }].map((q) => parseHookFilters(q).page),
    [null, 2, 1, 1, 999_999],
    "page: null when absent, else a whole page number >= 1",
  );
  const many = addTextHooks(s, { section: "rtm", clientCode: null }, Array.from({ length: 405 }, (_, i) => ({ text: `Paging hook number ${i + 1} for the paging check`, source: "pasted" as const })));
  assert.equal(many.added, 405);
  const page1 = listHooks({ kind: "rtm" }, parseHookFilters({}));
  assert.deepEqual([page1.rows.length, page1.total > 405, page1.page], [15, true, 1], "first page: 15 of all");
  const page2 = listHooks({ kind: "rtm" }, parseHookFilters({ page: "2" }));
  assert.deepEqual([page2.rows.length, page2.page], [15, 2]);
  assert.ok(page2.rows.every((r) => !page1.rows.some((x) => x.id === r.id)), "page 2 = the next 15 in the same order");
  const lastPage = Math.ceil(page1.total / 15);
  const past = listHooks({ kind: "rtm" }, parseHookFilters({ page: "999999" }));
  assert.deepEqual([past.page, past.rows.length], [lastPage, page1.total - (lastPage - 1) * 15], "a page past the end = the last page");
  const all = Array.from({ length: lastPage }, (_, i) => listHooks({ kind: "rtm" }, parseHookFilters({ page: String(i + 1) })).rows.map((r) => r.id)).flat();
  const deep = all[all.length - 3];
  const focused = listHooks({ kind: "rtm" }, parseHookFilters({ focus: String(deep) }));
  assert.deepEqual([focused.page, focused.rows.some((r) => r.id === deep)], [Math.floor((all.length - 3) / 15) + 1, true], "focus opens the page holding the hook");
  assert.equal(listHooks({ kind: "rtm" }, parseHookFilters({ focus: String(deep), page: "1" })).page, 1, "an explicit page wins over focus");
  for (const hid of many.ids) setHookArchived(s, hid, true);
  ok("Hooks tab paging: 15 a page via ?page= in sort order, a page past the end shows the last, focus opens its page unless a page is given");

  // Jobs page Clear (2026-10-06): hides an error from the lists, the counts and Retry all until a DIFFERENT error shows;
  // the job / file / hook itself is never changed.
  {
    const cleared = await import("../src/lib/cleared");
    const { jobsData, aiJobErrors, getStatus } = await import("../src/lib/queries");
    const aid = s
      .prepare("select a.id from assets a join roots r on r.id = a.root_id where r.enabled = 1 and a.missing = 0 and a.ignored = 0 order by a.id limit 1")
      .pluck()
      .get() as number;
    const now = Date.now();
    const addErr = (err: string) =>
      Number(s.prepare("insert into jobs (type, asset_id, status, error, attempts, created_at, finished_at) values ('derive_thumb', ?, 'error', ?, 1, ?, ?)").run(aid, err, now, now).lastInsertRowid);
    const j1 = addErr("Input file contains unsupported image format");
    const j2 = addErr("ffmpeg exited 1");
    const shown = () => jobsData().errors.map((e) => e.id);
    assert.ok(shown().includes(j1) && shown().includes(j2));
    const badge = getStatus().worker.error;
    assert.equal(cleared.clearErrors(s, ["derive"], j1), 1, "one row cleared");
    assert.equal(cleared.clearErrors(s, ["derive"], j1), 0, "clearing it again does nothing");
    assert.ok(!shown().includes(j1) && shown().includes(j2), "a cleared row leaves the list, the other stays");
    assert.equal(getStatus().worker.error, badge - 1, "the sidebar badge drops it");
    assert.equal(
      (s.prepare("select status || '|' || error from jobs where id = ?").pluck().get(j1) as string),
      "error|Input file contains unsupported image format",
      "the job itself is unchanged",
    );
    assert.equal(retryErrored(s, j1), 1, "Retry on the row still works");
    s.prepare("update jobs set status = 'error', error = 'Input file contains unsupported image format' where id = ?").run(j1);
    assert.ok(!shown().includes(j1), "the same error again stays cleared");
    s.prepare("update jobs set error = 'a new problem' where id = ?").run(j1);
    assert.ok(shown().includes(j1), "a different error shows again");
    cleared.clearErrors(s, ["derive"], j1);
    const retried = retryErrored(s);
    assert.equal(s.prepare("select status from jobs where id = ?").pluck().get(j1), "error", "Retry all skips cleared errors");
    assert.ok(retried >= 1 && s.prepare("select status from jobs where id = ?").pluck().get(j2) === "pending", "and retries the rest");
    // Describe / classify / hook / Meta / YouTube errors, and Clear all.
    s.prepare("update assets set describe_error = 'Ollama said no' where id = ?").run(aid);
    assert.ok(aiJobErrors().describe.some((e) => e.id === aid));
    s.prepare("update ad_accounts set ghl_error = 'GHL 500' where id = (select min(id) from ad_accounts)").run();
    s.prepare("insert into app_settings (key, value) values ('youtube:error', 'YouTube 403 (quotaExceeded)') on conflict(key) do update set value = excluded.value").run();
    const before = cleared.unclearedCount(s);
    assert.ok(before >= 3);
    assert.equal(cleared.clearErrors(s, cleared.CLEAR_KINDS), before, "Clear all clears every error showing");
    assert.equal(cleared.unclearedCount(s), 0);
    assert.ok(!aiJobErrors().describe.some((e) => e.id === aid), "a cleared describe error leaves the list");
    assert.equal(s.prepare("select describe_error from assets where id = ?").pluck().get(aid), "Ollama said no", "the file still keeps its error (still skipped)");
    assert.equal(cleared.clearedIds(s, "meta").size, 1);
    assert.ok(cleared.clearedIds(s, "youtube").has(0));
    s.prepare("update app_settings set value = 'YouTube 500 (backendError)' where key = 'youtube:error'").run();
    assert.equal(cleared.clearedIds(s, "youtube").size, 0, "a new YouTube error shows again");
    s.prepare("update assets set describe_error = null where id = ?").run(aid);
    s.prepare("update ad_accounts set ghl_error = null").run();
    s.prepare("delete from app_settings where key = 'youtube:error'").run();
    s.prepare("delete from jobs where id in (?, ?)").run(j1, j2);
  }
  ok("Jobs page Clear: hides one error or all of them from the lists, counts, sidebar badge and Retry all, never changes the job / file; a different error shows again");

  }

  // Phase 5 slice 1: Meta + GHL sync, the Running tab reads, roots outside the drive (stub transports only).
  await runMetaSmoke({ s, cfg, tmp, ok });
  await runFkbSmoke({ s, cfg, tmp, ok });
  // Phase 5 slice 3: calibration, flags, thresholds, test order (a fresh DB, stub rows only).
  await runSlice3Smoke({ cfg, tmp, ok });
  // Phase 5 slice 4: YouTube OAuth + Shorts sync + NSM calibration + ad groups (a fresh DB, stub transports only).
  await runYouTubeSmoke({ cfg, tmp, ok });
  // Phase 5 gate fixes: refresh gaps, GHL partial reads, windows, flags, video links, test order, slots, Graph params.
  await runGateFixSmoke({ cfg, tmp, ok });
  // Phase 6 slice 1: episodes, the guarded SRT reader, moments (stub claude), cards + moment hooks, the board.
  await runShortsSmoke({ cfg, tmp, ok });
  // Phase 6 slice 2: word-timed transcripts (stub whisper), automatic moves, captions, Posted, Send to Shorts, Cut reel.
  await runShorts2Smoke({ cfg, tmp, ok });
  // Phase 6 slice 3: new PAUSED ads (rules, prefill, media, order writer, Stage, read-back, Cancel, ad_copy via stub claude).
  await runAdsSmoke({ cfg, tmp, ok });
  // Phase 7 slice 2: cold opens + main hooks, the gate, the picker, hook words, Make explainer, the kit hand-off, kit notes, medians, kit tests.
  await runReelsSmoke({ cfg, tmp, ok });
  // Jev copy gate (scripts/score-copy.ts): scored text, the pass rule, failures as pass null, the CLI (FakeJev, empty key).
  await runCopyGateSmoke({ cfg, tmp, ok });
  // Landing page Phase 2 slice 1: rubric v3 (NSM context), per section versions, 0023 backfill, seed step 11, byte identity.
  await runRubricV3Smoke({ cfg, tmp, ok });
  // Landing page Phase 2 slice 2: the page section scorer (PAGE_RUBRICS v1, state, evaluate, failures, --resolve, context_fp, CLI).
  await runPageGateSmoke({ cfg, tmp, ok });
  // Creative Studio slice 1a: STUDIO_DRIVE_MODE (folder vs external), the install identity + its shell twin, loadConfig.
  await runStudioDefaultsSmoke({ cfg, tmp, ok });
  // Creative Studio slice 1b: the Studio config, seed-once, migration 0024, Settings > Clients / Lanes, per-client sync options.
  await runConfigSmoke({ cfg, tmp, ok });
  // Creative Studio slice 1c: the business profile (byte identity with the pre-refactor snapshot, the neutral denylist, schema).
  await runProfileSmoke({ cfg, tmp, ok });
  // Creative Studio slice 1d: neutral defaults + the config env layer, the original install's exact values, brand marks,
  // episode naming, the leak gate.
  await runScrubSmoke({ cfg, tmp, ok });
  // Creative Studio Phase 2: the demo pack (config, media vs make-demo, no key, port refusal, STUDIO_IDENTITY / STUDIO_ENGINES,
  // isolation from an install's identity + env file, the sample data insert twice: idempotent, no paid / network rows).
  await runDemoSmoke({ cfg, tmp, ok });
  // Creative Studio Phase 4b: the port resolver (bash / zsh = loadConfig), start.sh, tool paths from the env file, the whisper default.
  await runLaunchSmoke({ cfg, tmp, ok });
  // Creative Studio Phase 3: the manual (config keys + schema keys documented, .env.example = envTemplate, links + anchors,
  // npm scripts, no em / en dash, screenshot slots vs images/SHOTS.md, every page in the index).
  await runManualSmoke({ ok });
  // Creative Studio Phase 4a: the public export (mapping, dirty refusal, each gate on a planted hit, target refusals, re-export, real export).
  await runExportSmoke({ tmp, ok });

  db.sqlite.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`smoke: PASS (${step} checks)`);
}

main().catch((e) => {
  console.error("smoke: FAIL");
  console.error(e);
  console.error(`(left temp dir for inspection: ${tmp})`);
  process.exit(1);
});
