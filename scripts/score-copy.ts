/**
 * `npx tsx scripts/score-copy.ts < request.json`: the Jev copy gate for NEW SGC + SGD Meta ad copy and NSM's own copy (logic in
 * src/lib/hooks/copygate.ts). Called by the ad skills' copy scorer (copy_score.py, outside this repo) with cwd = this repo.
 *
 *   stdin  {"code": "granite", "lines": [{"id": "h1", "field": "headline" | "primary", "text": "..."}]}
 *          code = an SGD Pros client code (section fkbpros), exactly "fkb" (SGD's own section, no client) or exactly
 *          "rtm" (the NSM section, no client: Northstar Media's own website / brand copy, 2026-10-07)
 *   stdout {"rubric_version": N, "rubric_version_global": N, "context_fp": "16 hex", "model": "...", "results": [{id,
 *           field, scored_text, overall, band, dims, pp, pp_p, avatar, style, stops_scroll, unsure, pass, why, error?}],
 *           "cost_usd": N}
 *          rubric_version = the code's section version (fkbpros / fkb 2, rtm 3 on rubric v3; copy_score.py's cache key),
 *          rubric_version_global = the current rubric version, context_fp = everything Jev reads besides the line
 *
 * stdout carries only that JSON; every log line goes to stderr. Exit 0 whenever the request was valid, even when Jev
 * could not score (no key, daily cap, key refused, Jev down): those lines come back pass null + error. Exit 1 for bad
 * input (not JSON, wrong shape, unknown code) or a config / DB problem. Same Jev adapter as the worker (pinned
 * model, daily cap, ai_calls rows with purpose `copy_gate`); nothing is written to hooks or hook_scores. cost_usd counts
 * the successful calls only (ai_calls is the full ledger).
 *
 * The live DB is opened WITHOUT migrations or the seed (the app and the worker own those); a DB behind the repo's
 * migrations is refused (exit 1: restart Studio first), and a missing DB file too (exit 1; the CLI never creates one).
 */
import fs from "node:fs";
import path from "node:path";
import { getConfig, readTypesafeKey } from "../src/lib/config";
import { openDb, pendingMigrations } from "../src/lib/db";
import { HttpJevTransport, Jev } from "../src/lib/ai/jev";
import { copyGateRequestSchema, CopyGateInputError, scoreCopyLines } from "../src/lib/hooks/copygate";

// Keep stdout pure JSON: anything a module logs goes to stderr.
const stdout = process.stdout;
console.log = (...args: unknown[]) => console.error(...args);
const log = (...args: unknown[]) => console.error(new Date().toISOString(), ...args);

function fail(message: string): never {
  console.error(`score-copy: ${message}`);
  process.exit(1);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    fail("stdin is not JSON");
  }
  const parsed = copyGateRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(`bad request: ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"}`);
  }

  let cfg;
  try {
    cfg = getConfig();
  } catch (e) {
    fail((e as Error).message);
  }
  // Never create a DB: a missing file (a wrong STUDIO_DB, another install's settings) is refused before opening.
  if (!isFile(cfg.dbPath)) fail("no Studio database at the configured path");
  let db;
  try {
    db = openDb(cfg.dbPath, { setup: false });
  } catch (e) {
    fail(`cannot open studio.db: ${(e as Error).message}`);
  }
  try {
    if (pendingMigrations(db.sqlite, path.join(__dirname, "..", "drizzle")).length) {
      console.error("score-copy: studio.db is behind the repo's migrations; restart Studio first");
      process.exitCode = 1;
      return;
    }
    // The worker's pattern (src/worker/index.ts): the key is read by the transport only, fresh per request.
    const jev = new Jev(db.sqlite, new HttpJevTransport(() => readTypesafeKey(cfg)), cfg.jevModel, { log });
    const out = await scoreCopyLines(db.sqlite, jev, parsed.data, { concurrency: 2, log });
    stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    if (!(e instanceof CopyGateInputError)) throw e;
    console.error(`score-copy: ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.sqlite.close();
  }
}

main().catch((e) => {
  console.error("score-copy: failed:", (e as Error)?.message ?? e);
  process.exit(1);
});
