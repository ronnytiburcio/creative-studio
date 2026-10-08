/**
 * `npx tsx scripts/score-page.ts [--resolve] < request.json`: the Jev landing page section scorer (landing page Phase 2
 * slice 2; logic in src/lib/pages/pagegate.ts, rubric in src/lib/pages/rubric.ts). ADVISORY: it never blocks anything.
 * Called by the page-playbook skill (slice 3, scripts/score_page.py) with cwd = this repo, or from a terminal.
 *
 *   stdin  {"code": "rtm" | "fkb" | <SGD Pros client code>, "page_rubric_version"?: N,
 *           "page": {"url"?, "site"?, "stage"?, "headline"?}, "voice"?: ["verbatim market snippet", ...],
 *           "sections": [{"id": "S3", "part": "problem", "heading"?: "...", "text": "...", "ctas"?: ["label", ...]}]}
 *          part = one of the page rubric version's parts (v1: eyebrow, headline, subheadline, problem, solution, proof,
 *          offer, cta, ps, story; story's text = the headline + section headings, one per line), at most one section
 *          per part, 1 to 12 sections, text up to 5,000 characters (Jev reads the first 1,500)
 *   stdout (score)    {"page_rubric_version", "hook_rubric_version", "section_version", "context_fp", "model",
 *                      "sections": [{id, part, key, scored_text_chars, score, band, dims, why, unsure, error}],
 *                      "page_score", "freight_score", "cost_usd"}
 *          (--resolve) {"page_rubric_version", "hook_rubric_version", "section_version", "context_fp",
 *                      "sections": [{id, part, key, scored_text_chars}]}
 *
 * --resolve is FREE and READ ONLY: no Jev call, the DB is opened read only. Scoring = one Jev call per section through
 * the worker's adapter (pinned model, daily cap, ai_calls rows with purpose `page_score`); nothing else is written (no
 * hooks, hook_scores, notes or rubric_versions). stdout carries only that JSON; every log line goes to stderr. Exit 0
 * whenever the request was valid, even when Jev could not score (no key, daily cap, key refused, Jev down): those
 * sections come back score null + error. Exit 1 for bad input (not JSON, wrong shape, duplicate part, unknown part /
 * code / page_rubric_version) or a config / DB problem. The live DB is never migrated or seeded; a DB behind the
 * repo's migrations is refused (exit 1: restart Studio first), and a missing DB file too (exit 1; the CLI never creates one).
 */
import fs from "node:fs";
import path from "node:path";
import { getConfig, readTypesafeKey } from "../src/lib/config";
import { openDb, pendingMigrations } from "../src/lib/db";
import { HttpJevTransport, Jev } from "../src/lib/ai/jev";
import { pageGateRequestSchema, PageGateInputError, resolvePage, scorePage } from "../src/lib/pages/pagegate";

// Keep stdout pure JSON: anything a module logs goes to stderr.
const stdout = process.stdout;
console.log = (...args: unknown[]) => console.error(...args);
const log = (...args: unknown[]) => console.error(new Date().toISOString(), ...args);

function fail(message: string): never {
  console.error(`score-page: ${message}`);
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
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--resolve");
  if (unknown.length) fail(`unknown argument ${unknown[0]} (only --resolve)`);
  const resolveOnly = args.includes("--resolve");

  const raw = await readStdin();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    fail("stdin is not JSON");
  }
  const parsed = pageGateRequestSchema.safeParse(body);
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
    db = openDb(cfg.dbPath, resolveOnly ? { readonly: true } : { setup: false });
  } catch (e) {
    fail(`cannot open studio.db: ${(e as Error).message}`);
  }
  try {
    if (pendingMigrations(db.sqlite, path.join(__dirname, "..", "drizzle")).length) {
      console.error("score-page: studio.db is behind the repo's migrations; restart Studio first");
      process.exitCode = 1;
      return;
    }
    if (resolveOnly) {
      stdout.write(`${JSON.stringify(resolvePage(db.sqlite, parsed.data, cfg.jevModel))}\n`);
      return;
    }
    // The worker's pattern (src/worker/index.ts): the key is read by the transport only, fresh per request.
    const jev = new Jev(db.sqlite, new HttpJevTransport(() => readTypesafeKey(cfg)), cfg.jevModel, { log });
    const out = await scorePage(db.sqlite, jev, parsed.data, { concurrency: 2, log });
    stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    if (!(e instanceof PageGateInputError)) throw e;
    console.error(`score-page: ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.sqlite.close();
  }
}

main().catch((e) => {
  console.error("score-page: failed:", (e as Error)?.message ?? e);
  process.exit(1);
});
