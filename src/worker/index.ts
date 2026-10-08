/**
 * Studio worker: `npm run worker`.
 * Watches enabled roots (read only), keeps the index fresh, derives posters /
 * contact sheets / thumbs / proxies into STUDIO_CACHE, runs generation jobs
 * (outputs land in Studio Generated through the write guard), describes images / videos with the local
 * Ollama vision model + whisper.cpp (cache files only), classifies the descriptions with Jev (text only) and scores
 * hooks against the rubric with Jev (text only), rewrites hook variants and proposes Shorts moments from prepped Lane A
 * episode transcripts and drafts new PAUSED ad copy with `claude -p` (subscription CLI, no tools), reads its own staged ad
 * order files back (the apply skills write the outcome into them),
 * reads Meta ads + GHL leads once a day (GET only toward Meta; the GHL contacts search only) and the Lane A channel's YouTube
 * Shorts once a day (GET only toward the YouTube Data / Analytics APIs; the token refresh posts to oauth2.googleapis.com).
 */
// First: the env file's tool paths into the process environment before ./proc (and the rest) load.
import "./tool-env";
import { ensureAppDirs, ensureEnvFile, getConfig, readTypesafeKey } from "../lib/config";
import { openDb } from "../lib/db";
import { CodexAdapter } from "../lib/gen/codex";
import { HiggsfieldAdapter } from "../lib/gen/higgsfield";
import { writeGuardFor } from "../lib/writeguard";
import { OllamaVision } from "../lib/ai/ollama";
import { WhisperCpp, whisperStatus } from "../lib/ai/whisper";
import { HttpJevTransport, Jev } from "../lib/ai/jev";
import { MetaGraph } from "../lib/meta/graph";
import { GhlClient } from "../lib/meta/ghl";
import { metaClientsDir } from "../lib/meta/store";
import { Engine } from "./engine";
import { FFMPEG, FFPROBE } from "./proc";

function main() {
  const created = ensureEnvFile();
  let cfg;
  try {
    cfg = getConfig();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  ensureAppDirs(cfg);
  if (created) console.log(`config: created template ${cfg.envFile}`);
  console.log(`worker: db=${cfg.dbPath} cache=${cfg.cacheDir}`);
  const db = openDb(cfg.dbPath);
  const whisperReady = () => {
    const w = whisperStatus(cfg);
    return w.binFound && w.modelFound;
  };
  const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
  const insCall = db.sqlite.prepare("insert into meta_calls (at, identity, kind, path, status, ms, error) values (?, ?, ?, ?, ?, ?, ?)");
  const logCall = (c: { identity: string; kind: string; path: string; status: number | null; ms: number; error: string | null }) =>
    insCall.run(Date.now(), c.identity, c.kind, c.path.slice(0, 200), c.status, c.ms, c.error);
  // One Jev adapter for classify and hook scoring. The key is read by the transport only, fresh per request (never
  // logged or stored).
  const jev = new Jev(db.sqlite, new HttpJevTransport(() => readTypesafeKey(cfg)), cfg.jevModel, { log });
  const engine = new Engine({
    cfg,
    db,
    concurrency: 2,
    gen: {
      adapters: { higgsfield: new HiggsfieldAdapter(), codex: new CodexAdapter() },
      concurrency: { higgsfield: 3, codex: 2 },
      guard: writeGuardFor(cfg),
    },
    describe: {
      vision: new OllamaVision(cfg.ollamaUrl, cfg.visionModel),
      whisper: new WhisperCpp({ bin: cfg.whisperBin, model: cfg.whisperModel, ffmpeg: FFMPEG, ffprobe: FFPROBE }),
      whisperReady,
    },
    classify: {
      jev,
      spokenReady: whisperReady,
      concurrency: 2,
    },
    hooks: { jev, concurrency: 2 },
    variants: {},
    // Shorts board (Phase 6): episode sync (guarded SRT reads, never a write), word-timed episode transcripts (whisper
    // over the cached proxy only), the board's automatic moves + moments jobs (`claude -p`, one at a time).
    shorts: { words: { bin: cfg.whisperBin, model: cfg.whisperModel, ready: whisperReady } },
    // New PAUSED ads (Phase 6 slice 3): Draft the rest (`claude -p`, one at a time) + reading Studio's own order files
    // back every 60 s. Studio never writes to Meta: the apply skills do, in a live session.
    ads: {},
    meta: {
      // Tokens / keys are read by these adapters only, fresh per request (never logged or stored). Every request is
      // logged in meta_calls (path only).
      graph: (identity) =>
        new MetaGraph({ identity, envFile: identity === "fkb" ? cfg.metaFkbEnvFile : cfg.metaEnvFile, onCall: logCall, log }),
      // GHL: one key for both identities. META_ENV_FILE's key already reaches Lane C's sub-account too; Lane C's ad leads
      // would carry source `fkb-fb-ad` (DECISIONS "Phase 5 slice 1 verify" / slice 2): until one exists Lane C counts Meta leads.
      ghl: (identity) => new GhlClient({ identity, envFile: cfg.metaEnvFile, onCall: logCall }),
      cacheDir: cfg.cacheDir,
      clientsDir: metaClientsDir(cfg.metaEnvFile),
      universalRegistry: cfg.universalRegistry,
    },
    // YouTube Shorts (Phase 5 slice 4): Studio's own read-only token, refreshed by src/lib/youtube/auth.ts only (never
    // logged or stored anywhere but its 0600 file). Idle ("off") until the owner clicks Connect YouTube in Settings.
    youtube: { cfg },
  });

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`worker: ${sig}, shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    try {
      await engine.stop();
      db.sqlite.close();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => console.error("uncaught", e));
  process.on("unhandledRejection", (e) => console.error("unhandled rejection", e));

  engine.start().catch((e) => {
    console.error("worker start failed", e);
    process.exit(1);
  });
}

main();
