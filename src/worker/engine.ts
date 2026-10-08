/**
 * Ingest engine: scan + watch roots, fingerprint, probe, soft-ignore, and lifecycle.
 * Tagging lives in ./tags.ts, the derive queue in ./queue.ts, the generation queue in ./gen.ts, the describe queue
 * (Ollama + whisper, cache files only) in ./describe.ts, the classify queue (Jev, text only) in ./classify.ts, the hook
 * scoring queue (Jev, text only) in ./hooks.ts, the Meta + GHL sync (read only toward Meta and GHL) in ./meta.ts.
 * Roots may live off the drive (e.g. the clients' Static Ads folders in ~/Downloads): those are scanned, watched and
 * derived whatever the drive's state; only roots under STUDIO_DRIVE wait for it.
 * READ ONLY toward roots: the engine itself writes only to the SQLite DB and STUDIO_CACHE. The one
 * exception is the generation queue, which lands outputs in "<drive>/Studio Generated/" through
 * src/lib/writeguard.ts (never anything else on the drive).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import type { Db } from "../lib/db";
import type { StudioConfig } from "../lib/config";
import { driveMounted, isUnder, rootAccessible } from "../lib/fsguard";
import { kindForExt, type Kind } from "../lib/media";
import { buildIgnoreMatcher, parseCodes, type IgnoreMatcher } from "../lib/patterns";
import { markIgnored, markMissing } from "../lib/jobs";
import { generatedBase } from "../lib/gen/layout";
import { sidecarPathFor } from "../lib/gen/output";
import type { GenAdapter, GenEngineId } from "../lib/gen/types";
import type { WriteGuard } from "../lib/writeguard";
import { originalFileFor } from "../lib/originals";
import { killEngineChildren } from "../lib/gen/cli";
import { fingerprint } from "./fingerprint";
import { probe } from "./probe";
import { killAllChildren, run } from "./proc";
import { Tagger } from "./tags";
import { DeriveQueue, type QueueAsset } from "./queue";
import { GenQueue } from "./gen";
import { DescribeQueue } from "./describe";
import { ClassifyQueue } from "./classify";
import { HookScoreQueue } from "./hooks";
import { HookVariantQueue } from "./variants";
import { ShortMomentsQueue } from "./shorts";
import { AdQueue } from "./ads";
import { MetaSyncQueue, type MetaSyncQueueOptions } from "./meta";
import { YouTubeSyncQueue, type YouTubeSyncQueueOptions } from "./youtube";
import type { VisionAdapter } from "../lib/ai/ollama";
import type { JevAdapter } from "../lib/ai/jev";
import { generationDetails } from "../lib/gen/details";
import { toolTitle } from "../lib/gen/tools";
import type { SpokenOpeningAdapter } from "../lib/ai/whisper";

type RootRow = { id: number; path: string; section_id: number; enabled: number; section_key: string };

type AssetRow = QueueAsset & {
  section_id: number;
  bytes: number;
  mtime: number;
  missing: number;
  ignored: number;
  generated: number;
};

export type EngineOptions = {
  cfg: StudioConfig;
  db: Db;
  concurrency?: number;
  log?: (...args: unknown[]) => void;
  /** Generation queue (Phase 2). Omitted = no generation in this engine. */
  gen?: {
    adapters: Partial<Record<GenEngineId, GenAdapter>>;
    concurrency: Partial<Record<GenEngineId, number>>;
    guard: WriteGuard;
    pollMs?: number;
  };
  /** Describe queue (Phase 3). Omitted = no describing in this engine. */
  describe?: {
    vision: VisionAdapter;
    whisper: SpokenOpeningAdapter | null;
    whisperReady?: () => boolean;
    promptVersion?: number;
    idleMs?: number;
  };
  /** Classify queue (Phase 3 slice 2, Jev). Omitted = no classifying in this engine. */
  classify?: {
    jev: JevAdapter;
    /** Describe model a description must come from (default: the configured vision model; the smoke test's fake). */
    visionModel?: string;
    /** whisper available (videos wait for their spoken opening). */
    spokenReady?: () => boolean;
    version?: number;
    describeVersion?: number;
    concurrency?: number;
    idleMs?: number;
    now?: () => number;
  };
  /** Hook scoring queue (Phase 4, Jev). Omitted = no hook scoring in this engine. */
  hooks?: {
    jev: JevAdapter;
    concurrency?: number;
    idleMs?: number;
    now?: () => number;
  };
  /** Rewrite variants queue (Phase 4 slice 3, `claude -p`, one job at a time). Omitted = no variants in this engine. */
  variants?: {
    timeoutMs?: number;
    idleMs?: number;
  };
  /** Shorts moments queue + episode sync (Phase 6, `claude -p`, one job at a time). Omitted = no Shorts in this engine. */
  shorts?: {
    timeoutMs?: number;
    idleMs?: number;
    /** Word-timed episode transcripts (Phase 6 slice 2): whisper-cli + model; omitted / null = off. */
    words?: { bin: string; model: string; ready?: () => boolean; ffmpeg?: string; ffprobe?: string } | null;
  };
  /**
   * New PAUSED ads (Phase 6 slice 3): "Draft the rest" jobs (`claude -p`, one at a time) + the order read-back every
   * 60 s (guarded reads of Studio's own order files; never a write). Omitted = neither in this engine.
   */
  ads?: {
    timeoutMs?: number;
    idleMs?: number;
    ordersMs?: number;
  };
  /** Meta + GHL sync (Phase 5, read only). Omitted = no Meta sync in this engine. */
  meta?: Omit<MetaSyncQueueOptions, "log" | "isStopped">;
  /** YouTube Shorts sync (Phase 5 slice 4, read only). Omitted = no YouTube sync in this engine. */
  youtube?: Omit<YouTubeSyncQueueOptions, "log" | "isStopped">;
};

const toPosix = (p: string) => p.split(path.sep).join("/");
const hashOf = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");

/** Tiny promise pool. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(runners);
}

export class Engine {
  readonly cfg: StudioConfig;
  readonly db: Db;
  private readonly log: (...args: unknown[]) => void;
  private readonly tagger: Tagger;
  private readonly queue: DeriveQueue;
  readonly gen: GenQueue | null = null;
  readonly describe: DescribeQueue | null = null;
  readonly classify: ClassifyQueue | null = null;
  readonly hooks: HookScoreQueue | null = null;
  readonly variants: HookVariantQueue | null = null;
  readonly shorts: ShortMomentsQueue | null = null;
  readonly ads: AdQueue | null = null;
  readonly meta: MetaSyncQueue | null = null;
  readonly youtube: YouTubeSyncQueue | null = null;

  driveMounted = false;
  private lastDriveChange = 0;
  private watcher: FSWatcher | null = null;
  private roots: RootRow[] = [];
  private ignore: IgnoreMatcher = () => false;
  private rootsHash = "";
  private rulesHash = "";
  private scanning = false;
  private rescanRequested = false;
  private scanSeen = 0;
  private scanFile: string | null = null;
  private inflight = new Map<string, Promise<void>>();
  private claimedMoves = new Set<number>();
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private cacheBytes: number | null = null;
  private accessibleHash = "";

  constructor(opts: EngineOptions) {
    this.cfg = opts.cfg;
    this.db = opts.db;
    this.log = opts.log ?? ((...args) => console.log(new Date().toISOString(), ...args));
    this.driveMounted = driveMounted(this.cfg);
    this.tagger = new Tagger(this.sql);
    this.queue = new DeriveQueue(this.sql, {
      cacheDir: this.cfg.cacheDir,
      concurrency: opts.concurrency ?? 2,
      log: this.log,
      readableRootIds: () => this.accessibleRoots().map((root) => root.id),
      sourceReadable: (asset) => {
        // Read the mount state fresh but leave this.driveMounted to tick(), which owns transitions.
        const root = this.roots.find((r) => r.id === asset.root_id);
        return Boolean(
          root &&
            root.enabled &&
            rootAccessible(root.path, this.cfg.drivePath, driveMounted(this.cfg)) &&
            fs.existsSync(asset.path),
        );
      },
      isStopped: () => this.stopped,
    });
    if (opts.gen) {
      this.gen = new GenQueue(this.sql, {
        ...opts.gen,
        cacheDir: this.cfg.cacheDir,
        logsDir: this.cfg.logsDir,
        ingest: async (file) => {
          await this.ingestFile(file);
          const row = this.sql.prepare("select id from assets where path = ?").get(file) as { id: number } | undefined;
          return row?.id ?? null;
        },
        originalFor: (assetId) => originalFileFor(assetId, this.sql, this.cfg),
        log: this.log,
        isStopped: () => this.stopped,
      });
    }
    if (opts.describe) {
      this.describe = new DescribeQueue(this.sql, {
        ...opts.describe,
        cacheDir: this.cfg.cacheDir,
        log: this.log,
        isStopped: () => this.stopped,
      });
    }
    if (opts.classify) {
      this.classify = new ClassifyQueue(this.sql, {
        ...opts.classify,
        visionModel: opts.classify.visionModel ?? this.cfg.visionModel,
        describeVersion: opts.classify.describeVersion ?? opts.describe?.promptVersion,
        // Studio Generated files: the prompt from the sidecar (read through the guards) or the job row.
        generationPrompt: (assetId) => {
          const d = generationDetails(assetId, this.sql, this.cfg);
          if (!d) return null;
          return d.tool ? `Quick tool: ${toolTitle(d.tool, d.toolDetail)}` : d.prompt || null;
        },
        log: this.log,
        isStopped: () => this.stopped,
      });
    }
    if (opts.hooks) {
      this.hooks = new HookScoreQueue(this.sql, { ...opts.hooks, log: this.log, isStopped: () => this.stopped });
    }
    if (opts.variants) {
      this.variants = new HookVariantQueue(this.sql, {
        ...opts.variants,
        cacheDir: this.cfg.cacheDir,
        logsDir: this.cfg.logsDir,
        log: this.log,
        isStopped: () => this.stopped,
      });
    }
    if (opts.shorts) {
      this.shorts = new ShortMomentsQueue(this.sql, {
        ...opts.shorts,
        cacheDir: this.cfg.cacheDir,
        logsDir: this.cfg.logsDir,
        drive: { drivePath: this.cfg.drivePath, fakeUnmounted: this.cfg.fakeUnmounted, driveMode: this.cfg.driveMode },
        log: this.log,
        isStopped: () => this.stopped,
      });
    }
    if (opts.ads) {
      this.ads = new AdQueue(this.sql, {
        ...opts.ads,
        cfg: this.cfg,
        cacheDir: this.cfg.cacheDir,
        logsDir: this.cfg.logsDir,
        log: this.log,
        isStopped: () => this.stopped,
      });
    }
    if (opts.meta) {
      this.meta = new MetaSyncQueue(this.sql, { ...opts.meta, log: this.log, isStopped: () => this.stopped });
    }
    if (opts.youtube) {
      this.youtube = new YouTubeSyncQueue(this.sql, { ...opts.youtube, log: this.log, isStopped: () => this.stopped });
    }
    this.loadSettings();
  }

  private get sql() {
    return this.db.sqlite;
  }

  // ---------------------------------------------------------------- settings

  /** Reload roots, ignores, tag rules. Returns which parts changed. */
  loadSettings(): { rootsChanged: boolean; rulesChanged: boolean } {
    const roots = this.sql
      .prepare(
        `select r.id, r.path, r.section_id, r.enabled, s.key as section_key
           from roots r join sections s on s.id = r.section_id order by r.id`,
      )
      .all() as RootRow[];
    const ignores = (this.sql.prepare("select pattern from ignore_patterns order by id").all() as { pattern: string }[]).map(
      (row) => row.pattern,
    );
    const rules = (
      this.sql.prepare("select id, path_glob, client_codes from tag_rules order by id").all() as {
        id: number;
        path_glob: string;
        client_codes: string;
      }[]
    ).map((row) => ({ id: row.id, pathGlob: row.path_glob, clientCodes: parseCodes(row.client_codes) }));
    const clients = this.sql.prepare("select id, code from clients").all() as { id: number; code: string }[];

    const rootsHash = hashOf([roots, ignores]);
    const rulesHash = hashOf([rules, clients]);
    const changed = { rootsChanged: rootsHash !== this.rootsHash, rulesChanged: rulesHash !== this.rulesHash };
    this.roots = roots;
    this.ignore = buildIgnoreMatcher(ignores);
    this.tagger.load(rules, clients);
    this.rootsHash = rootsHash;
    this.rulesHash = rulesHash;
    return changed;
  }

  private enabledRoots() {
    return this.roots.filter((root) => root.enabled);
  }

  private isAccessible(root: RootRow) {
    return rootAccessible(root.path, this.cfg.drivePath, this.driveMounted);
  }

  accessibleRoots() {
    return this.enabledRoots().filter((root) => this.isAccessible(root));
  }

  private rootFor(abs: string): RootRow | undefined {
    // Longest matching enabled root wins.
    return this.enabledRoots()
      .filter((root) => isUnder(abs, root.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }

  private relFor(root: RootRow, abs: string) {
    return toPosix(path.relative(root.path, abs));
  }

  /** True when the root-relative path or any parent dir matches an ignore pattern. */
  private ignoredRel(rel: string, isDir = false): boolean {
    const segments = rel.split("/").filter(Boolean);
    for (let i = 1; i <= segments.length; i++) {
      if (this.ignore(segments.slice(0, i).join("/"), i < segments.length || isDir)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------- scan

  /** Full scan of every enabled + accessible root. Serialized. */
  async scanAll(): Promise<void> {
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.scanning = true;
    try {
      do {
        this.rescanRequested = false;
        this.scanSeen = 0;
        for (const root of this.accessibleRoots()) {
          if (this.stopped) return;
          await this.scanRoot(root);
        }
      } while (this.rescanRequested && !this.stopped);
    } finally {
      this.scanning = false;
      this.scanFile = null;
      this.heartbeat();
    }
  }

  private async walk(root: RootRow, dir: string, out: string[]) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      this.log("walk: cannot read", dir, (e as Error).message);
      return;
    }
    for (const entry of entries) {
      if (this.stopped) return;
      const abs = path.join(dir, entry.name);
      const rel = this.relFor(root, abs);
      if (entry.isSymbolicLink()) continue; // never follow links out of a root
      if (entry.isDirectory()) {
        if (this.ignore(rel, true)) continue;
        await this.walk(root, abs, out);
      } else if (entry.isFile()) {
        if (this.ignore(rel, false)) continue;
        if (!kindForExt(path.extname(entry.name))) continue;
        out.push(abs);
      }
    }
  }

  async scanRoot(root: RootRow) {
    const startedAt = Date.now();
    const files: string[] = [];
    await this.walk(root, root.path, files);
    this.log(`scan: ${root.path} -> ${files.length} media files`);
    const seen = new Set(files);
    await pool(files, 4, async (abs) => {
      if (this.stopped) return;
      this.scanFile = abs;
      try {
        await this.ingestFile(abs, root);
      } catch (e) {
        this.log("ingest error", abs, (e as Error).message);
      }
      this.scanSeen++;
      if (this.scanSeen % 50 === 0) this.heartbeat();
    });
    if (this.stopped) return;
    // Reconcile rows under this root that the walk did not see.
    if (!this.isAccessible(root)) return; // drive went away mid-scan: never mark missing
    const rows = this.sql
      .prepare("select id, path, rel_path, missing, ignored from assets where root_id = ?")
      .all(root.id) as { id: number; path: string; rel_path: string; missing: number; ignored: number }[];
    const toHide: number[] = [];
    const toMissing: number[] = [];
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      if (this.ignoredRel(row.rel_path)) {
        if (!row.ignored) toHide.push(row.id); // soft-hide: keeps the row and its manual tags
      } else if (!row.missing && !fs.existsSync(row.path)) {
        toMissing.push(row.id);
      }
    }
    markIgnored(this.sql, toHide);
    markMissing(this.sql, toMissing);
    this.log(
      `scan: ${root.path} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (missing +${toMissing.length}, hidden by ignore +${toHide.length})`,
    );
  }

  // ------------------------------------------------------------------ ingest

  /** Serialize ingests per path (scan + watcher can race). */
  ingestFile(abs: string, root?: RootRow): Promise<void> {
    const previous = this.inflight.get(abs) ?? Promise.resolve();
    const next = previous.then(() => this.ingestFileInner(abs, root)).finally(() => {
      if (this.inflight.get(abs) === next) this.inflight.delete(abs);
    });
    this.inflight.set(abs, next);
    return next;
  }

  private async ingestFileInner(abs: string, rootHint?: RootRow) {
    const root = rootHint ?? this.rootFor(abs);
    if (!root || !root.enabled) return;
    const rel = this.relFor(root, abs);
    if (!rel || rel.startsWith("..")) return;
    if (this.ignoredRel(rel)) return;
    const ext = path.extname(abs).slice(1).toLowerCase();
    const kind = kindForExt(ext) as Kind | null;
    if (!kind) return;
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(abs);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const mtime = Math.round(stat.mtimeMs);
    const generated = this.isGenerated(abs);
    const existing = this.sql.prepare("select * from assets where path = ?").get(abs) as AssetRow | undefined;

    // Fast path: unchanged file. Still un-hide / un-miss it and keep folder tags current.
    if (existing && existing.sha256 && existing.bytes === stat.size && existing.mtime === mtime) {
      if (
        existing.missing ||
        existing.ignored ||
        existing.root_id !== root.id ||
        existing.rel_path !== rel ||
        Boolean(existing.generated) !== generated
      ) {
        this.sql
          .prepare("update assets set missing = 0, ignored = 0, root_id = ?, section_id = ?, rel_path = ?, generated = ? where id = ?")
          .run(root.id, root.section_id, rel, generated ? 1 : 0, existing.id);
      }
      this.tagger.apply(existing.id, rel, abs);
      this.queue.ensureDerived(existing.id);
      return;
    }

    const fp = await fingerprint(abs, stat.size);

    // Move / rename detection: same fingerprint, old path gone -> keep the old row id.
    // Claimed ids are reserved until this ingest finishes so two concurrent new copies
    // of the same file cannot both take over one row (the probe below awaits).
    let moved: AssetRow | undefined;
    if (!existing) {
      const candidates = this.sql
        .prepare("select * from assets where sha256 = ? and path != ? order by missing desc, id")
        .all(fp, abs) as AssetRow[];
      moved = candidates.find(
        (candidate) => !this.claimedMoves.has(candidate.id) && (candidate.missing || !fs.existsSync(candidate.path)),
      );
      if (moved) this.claimedMoves.add(moved.id);
    }
    try {
      await this.writeIngest(abs, root, rel, kind, ext, stat, mtime, fp, existing, moved, generated);
    } finally {
      if (moved) this.claimedMoves.delete(moved.id);
    }
  }

  private async writeIngest(
    abs: string,
    root: RootRow,
    rel: string,
    kind: Kind,
    ext: string,
    stat: fs.Stats,
    mtime: number,
    fp: string,
    existing: AssetRow | undefined,
    moved: AssetRow | undefined,
    generated: boolean,
  ) {

    let meta: Awaited<ReturnType<typeof probe>> | null = null;
    let probeError: string | null = null;
    try {
      meta = await probe(abs, kind, ext);
    } catch (e) {
      probeError = (e as Error).message;
    }

    const cols = {
      section_id: root.section_id,
      root_id: root.id,
      path: abs,
      rel_path: rel,
      filename: path.basename(abs),
      ext,
      sha256: fp,
      kind,
      bytes: stat.size,
      duration_s: meta?.durationS ?? null,
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      orientation: meta?.orientation ?? null,
      fps: meta?.fps ?? null,
      codec: meta?.codec ?? null,
      created_at: Math.round(stat.birthtimeMs || stat.ctimeMs),
      mtime,
      indexed_at: Date.now(),
      generated: generated ? 1 : 0,
    };

    let id: number;
    const target = moved ?? existing;
    if (target) {
      const shaChanged = target.sha256 !== fp;
      this.sql
        .prepare(
          `update assets set section_id=@section_id, root_id=@root_id, path=@path, rel_path=@rel_path,
             filename=@filename, ext=@ext, sha256=@sha256, kind=@kind, bytes=@bytes, duration_s=@duration_s,
             width=@width, height=@height, orientation=@orientation, fps=@fps, codec=@codec,
             created_at=@created_at, mtime=@mtime, indexed_at=@indexed_at, generated=@generated, missing=0, ignored=0
           where id=@id`,
        )
        .run({ ...cols, id: target.id });
      if (shaChanged) {
        this.sql
          .prepare(
            `update assets set thumb_path=null, sheet_path=null, proxy_path=null, derive_status='pending', derive_error=null,
               description=null, description_model=null, description_version=null, spoken_open=null, described_at=null,
               describe_error=null where id=?`,
          )
          .run(target.id); // new bytes: the old description no longer applies (the describe queue picks it up again)
        this.sql.prepare("delete from jobs where asset_id = ? and status != 'running'").run(target.id);
      }
      id = target.id;
      if (moved) this.log(`moved: ${moved.path} -> ${abs} (id ${id})`);
    } else {
      const result = this.sql
        .prepare(
          `insert into assets (section_id, root_id, path, rel_path, filename, ext, sha256, kind, bytes, duration_s,
             width, height, orientation, fps, codec, created_at, mtime, indexed_at, generated, missing, derive_status)
           values (@section_id, @root_id, @path, @rel_path, @filename, @ext, @sha256, @kind, @bytes, @duration_s,
             @width, @height, @orientation, @fps, @codec, @created_at, @mtime, @indexed_at, @generated, 0, 'pending')`,
        )
        .run(cols);
      id = Number(result.lastInsertRowid);
    }
    if (probeError) {
      this.sql.prepare("update assets set derive_error = ? where id = ?").run(`probe: ${probeError}`, id);
    }
    this.tagger.apply(id, rel, abs);
    this.queue.ensureDerived(id);
  }

  /** Made by Studio: a sidecar sits next to it, or it lives under Studio Generated. */
  private isGenerated(abs: string): boolean {
    return fs.existsSync(sidecarPathFor(abs)) || isUnder(abs, generatedBase(this.cfg.drivePath));
  }

  reapplyAllTags() {
    const count = this.tagger.applyAll();
    this.log(`tags: reapplied folder rules to ${count} assets`);
  }

  /** Run derive jobs until nothing is claimable (smoke tests and one-shot runs). */
  drainQueue() {
    return this.queue.drain();
  }

  /** Run generation jobs until nothing is claimable (smoke tests). */
  async drainGen() {
    await this.gen?.drain();
  }

  /** Describe until nothing is due (smoke tests). */
  async drainDescribe() {
    return this.describe?.drain();
  }

  /** Classify until nothing is due or the queue has to wait (smoke tests). */
  async drainClassify() {
    return this.classify?.drain();
  }

  /** Score hooks until nothing is due or the queue has to wait (smoke tests). */
  async drainHooks() {
    return this.hooks?.drain();
  }

  /** Run every pending hook_variants job (smoke tests). */
  async drainVariants() {
    return this.variants?.drain();
  }

  /** Run every pending short_moments job (smoke tests). */
  async drainShorts() {
    return this.shorts?.drain();
  }

  /** Run every pending ad_copy job (smoke tests). */
  async drainAds() {
    return this.ads?.drain();
  }

  /** Run the YouTube sync that is due now, if any (smoke tests). */
  async drainYouTube() {
    return this.youtube?.drain();
  }

  /** Run the Meta sync that is due now, if any (smoke tests). */
  async drainMeta() {
    return this.meta?.drain();
  }

  // ------------------------------------------------------------------- watch

  private async startWatcher() {
    await this.stopWatcher();
    const roots = this.accessibleRoots();
    if (roots.length === 0) return;
    const watcher = chokidar.watch(
      roots.map((root) => root.path),
      {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        useFsEvents: true,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
        ignored: (p: string, stats?: fs.Stats) => {
          const root = this.rootFor(p);
          if (!root) return false;
          const rel = this.relFor(root, p);
          if (!rel) return false;
          return this.ignoredRel(rel, stats?.isDirectory() ?? false);
        },
      },
    );
    const onFile = (p: string) => {
      if (!kindForExt(path.extname(p))) return;
      this.ingestFile(p).catch((e) => this.log("watch ingest error", p, (e as Error).message));
    };
    watcher.on("add", onFile);
    watcher.on("change", onFile);
    watcher.on("unlink", (p) => setTimeout(() => this.handleGone(p, false), 3000));
    watcher.on("unlinkDir", (p) => setTimeout(() => this.handleGone(p, true), 3000));
    watcher.on("error", (e) => this.log("watcher error", (e as Error).message));
    this.watcher = watcher;
    this.log(`watch: ${roots.length} roots (fsevents)`);
  }

  private async stopWatcher() {
    if (!this.watcher) return;
    const watcher = this.watcher;
    this.watcher = null;
    try {
      await watcher.close();
    } catch {
      /* ignore */
    }
    this.log("watch: stopped");
  }

  /** A file/dir vanished. Only mark missing while its root is readable (never on unmount). */
  private handleGone(p: string, isDir: boolean) {
    if (this.stopped) return;
    const mounted = driveMounted(this.cfg);
    const root = this.rootFor(p);
    if (!root) return;
    // A root on the drive waits out an eject (and the first seconds after a mount change); a root elsewhere never does.
    if (isUnder(root.path, this.cfg.drivePath) && (!mounted || Date.now() - this.lastDriveChange < 15_000)) return;
    if (!rootAccessible(root.path, this.cfg.drivePath, mounted)) return;
    const rows = (
      isDir
        ? this.sql.prepare("select id, path from assets where missing = 0 and substr(path, 1, ?) = ?").all(p.length + 1, p + "/")
        : this.sql.prepare("select id, path from assets where missing = 0 and path = ?").all(p)
    ) as { id: number; path: string }[];
    const gone = rows.filter((row) => !fs.existsSync(row.path)).map((row) => row.id);
    markMissing(this.sql, gone);
    if (gone.length) this.log(`missing: ${gone.length} under ${p}`);
  }

  // ---------------------------------------------------------------- heartbeat

  heartbeat(message?: string) {
    const counts = this.queue.counts();
    const runningLabels = [...this.queue.running.values(), ...(this.gen ? [...this.gen.running.values()].map((l) => `gen: ${l}`) : [])];
    const currentFile = runningLabels.length
      ? runningLabels.join("  |  ")
      : this.scanFile
        ? `scan: ${this.scanFile}`
        : null;
    this.sql
      .prepare(
        `update worker_status set pid=?, last_seen=?, drive_mounted=?, queue_pending=?, queue_running=?, queue_error=?,
           current_file=?, scan_state=?, scan_seen=?, cache_bytes=coalesce(?, cache_bytes),
           cache_bytes_at=case when ? is null then cache_bytes_at else ? end, message=?,
           describe_state=?, describe_current=?, describe_note=?, classify_state=?, classify_current=?, classify_note=?,
           hooks_state=?, hooks_current=?, hooks_note=?, meta_state=?, meta_current=?, meta_note=?,
           yt_state=?, yt_current=?, yt_note=? where id = 1`,
      )
      .run(
        process.pid,
        Date.now(),
        this.driveMounted ? 1 : 0,
        counts.pending,
        counts.running,
        counts.error,
        currentFile,
        this.stopped ? "stopped" : this.scanning ? "scanning" : this.driveMounted ? "watching" : "paused",
        this.scanSeen,
        this.cacheBytes,
        this.cacheBytes,
        Date.now(),
        message ?? null,
        this.describe ? (this.stopped ? "off" : this.describe.state) : "off",
        this.describe?.current ?? null,
        this.describe?.note ?? null,
        this.classify ? (this.stopped ? "off" : this.classify.state) : "off",
        this.classify?.current ?? null,
        this.classify?.note ?? null,
        this.hooks ? (this.stopped ? "off" : this.hooks.state) : "off",
        this.hooks?.current ?? null,
        this.hooks?.note ?? null,
        this.meta ? (this.stopped ? "off" : this.meta.state) : "off",
        this.meta?.current ?? null,
        this.meta?.note ?? null,
        this.youtube ? (this.stopped ? "off" : this.youtube.state) : "off",
        this.youtube?.current ?? null,
        this.youtube?.note ?? null,
      );
  }

  private async measureCache() {
    try {
      const result = await run("/usr/bin/du", ["-sk", this.cfg.cacheDir], { timeoutMs: 60_000 });
      const kb = Number(result.stdout.trim().split(/\s+/)[0]);
      if (isFinite(kb)) this.cacheBytes = kb * 1024;
    } catch {
      /* ignore */
    }
  }

  // --------------------------------------------------------------- lifecycle

  private async tick() {
    if (this.stopped) return;
    const mounted = driveMounted(this.cfg);
    const { rootsChanged, rulesChanged } = this.loadSettings();
    if (mounted !== this.driveMounted) {
      this.driveMounted = mounted;
      this.lastDriveChange = Date.now();
      if (!mounted) {
        // Closes every watcher (so nothing holds the drive), then watches the roots that do not live on it.
        this.log("drive: unmounted -> stopping drive watchers, browsing from cache");
        await this.startWatcher();
      } else {
        this.log("drive: mounted -> rescanning");
        await this.startWatcher();
        void this.scanAll();
      }
    } else if (rootsChanged) {
      this.log("settings: roots/ignores changed -> restart watch + rescan");
      await this.startWatcher();
      void this.scanAll();
    } else if (this.accessibleHash !== hashOf(this.accessibleRoots().map((root) => root.id))) {
      // A root folder appeared or vanished (e.g. Studio Generated created on first use).
      this.log("roots: accessibility changed -> restart watch + rescan");
      await this.startWatcher();
      void this.scanAll();
    }
    this.accessibleHash = hashOf(this.accessibleRoots().map((root) => root.id));
    if (rulesChanged && !rootsChanged) this.reapplyAllTags();
    this.heartbeat();
  }

  async start() {
    const requeued = this.queue.requeueInterrupted();
    if (requeued) this.log(`queue: requeued ${requeued} interrupted jobs`);
    const swept = this.queue.sweepTempFiles();
    if (swept) this.log(`cache: removed ${swept} leftover temp files from an interrupted run`);
    if (this.gen) {
      const { resumed, interrupted } = this.gen.recover();
      if (resumed || interrupted) this.log(`gen: re-polling ${resumed} running job(s), ${interrupted} interrupted mid-start`);
      this.gen.sweepTemp();
      try {
        const parts = this.gen.sweepParts();
        if (parts) this.log(`gen: removed ${parts} leftover .part file(s) in Studio Generated`);
      } catch (e) {
        this.log("gen: .part sweep skipped", (e as Error).message);
      }
    }
    this.describe?.sweepTemp();
    this.sql.prepare("update worker_status set started_at = ? where id = 1").run(Date.now());
    this.lastDriveChange = Date.now();
    this.log(`drive: ${this.cfg.drivePath} ${this.driveMounted ? "mounted" : "NOT mounted"}`);
    this.heartbeat("starting");
    this.queue.start();
    this.gen?.start();
    this.describe?.start();
    this.classify?.start();
    this.hooks?.start();
    this.variants?.start();
    this.shorts?.start();
    this.ads?.start();
    this.meta?.start();
    this.youtube?.start();
    this.accessibleHash = hashOf(this.accessibleRoots().map((root) => root.id));
    await this.startWatcher();
    void this.scanAll();
    this.timers.push(setInterval(() => void this.tick().catch((e) => this.log("tick error", e)), 5000));
    this.timers.push(
      setInterval(() => {
        if (!this.scanning) void this.scanAll(); // accessible roots only: off-drive roots keep their rescan while unplugged
      }, 15 * 60_000),
    );
    void this.measureCache();
    this.timers.push(setInterval(() => void this.measureCache(), 60_000));
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.forEach(clearInterval);
    const describeStopped = this.describe?.stop(); // aborts an in-flight Ollama request; nothing half-written
    const classifyStopped = this.classify?.stop(); // aborts in-flight Jev requests; nothing half-written
    const hooksStopped = this.hooks?.stop(); // same for hook scoring
    const variantsStopped = this.variants?.stop(); // kills a running claude (its job becomes an Interrupted error)
    const shortsStopped = this.shorts?.stop(); // same for a moments run
    const adsStopped = this.ads?.stop(); // same for a Draft the rest run
    const metaStopped = this.meta?.stop(); // ends after the current request (upserts are per step, nothing half-written)
    const ytStopped = this.youtube?.stop(); // same for the YouTube read
    await this.gen?.stop(); // lets an in-flight create return its id so it is stored
    killAllChildren();
    killEngineChildren();
    await describeStopped;
    await classifyStopped;
    await hooksStopped;
    await variantsStopped;
    await shortsStopped;
    await adsStopped;
    await metaStopped;
    await ytStopped;
    await this.stopWatcher();
    this.queue.requeueInterrupted();
    this.queue.running.clear();
    this.heartbeat("stopped");
  }
}
