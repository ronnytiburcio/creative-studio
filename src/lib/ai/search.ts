/**
 * Search by meaning (server only): the Library's "Meaning" switch.
 *
 *   meaningSearch(deps, { query, scope, filters }) -> ranked asset ids with P(match), or a terse refusal
 *
 * 1. Prefilter (free, local): inside the channel + filters (never the plain `q`), FTS5 over description, spoken opening,
 *    filename and path (any query word, bm25 order), then files whose category the query names, then the scope's other
 *    described files newest first, up to MEANING_CANDIDATES. Undescribed images / videos are left out and counted.
 * 2. Rerank (paid): one Jev noul per candidate ("Does `candidates.a<id>` match this search: ...?"), TypeSafe's
 *    line-by-line recipe: each request's state holds the who's who note (who the people in the files are, Phase 4) and
 *    its batch's compact records (kind, category label, file, folder, description, spoken opening) keyed by id, packed
 *    under MEANING_STATE_CHARS; requests run MEANING_CONCURRENCY at a time. Every request goes through Jev.ask()
 *    (daily cap, retries, ai_calls row with purpose `search`).
 * 3. Cache: the same normalized query + scope + filters returns the stored ranking for 10 minutes (no Jev call);
 *    identical searches already running share one run.
 * 4. Rate limit: a token bucket (MEANING_RATE_PER_MIN paid searches per minute, per server process); cache hits are free.
 *
 * The route handler (src/app/api/search/meaning/route.ts) is the one place a paid call runs outside the worker
 * (DECISIONS "Phase 3 grilling"). The smoke test drives this module with FakeJev.
 */
import type Database from "better-sqlite3";
import { LIBRARY_FROM, scopeWhere, type LibraryFilters, type Scope } from "../queries";
import { CATEGORIES, CATEGORY_LABEL, isCategory, type CategoryId } from "./classes";
import { folderOf } from "../media";
import { capWouldPass, costUsd, estimateTokens, jevFailureKind, type JevAdapter, type JevQuestion } from "./jev";
import { noteLines, whosWho } from "../hooks/notes";

type Sql = Database.Database;

export const MEANING_MIN_QUERY = 2;
export const MEANING_MAX_QUERY = 200;
/** Candidates Jev ranks per search (200 -> 400 in Phase 4: broad queries covered a quarter of All clients (Lane B)). */
export const MEANING_CANDIDATES = 400;
/** Candidates per request (one noul each). */
export const MEANING_BATCH = 25;
/**
 * State budget per request in characters. Jev allows 32k tokens for state + the longest question; real calls run at
 * ~3.5 characters per token, so 40k characters is ~11-13k tokens, far under the limit even for odd text.
 */
export const MEANING_STATE_CHARS = 40_000;
/** Requests in flight at once (4 -> 8 with 400 candidates, so a full search is still two waves; TypeSafe allows 40/s). */
export const MEANING_CONCURRENCY = 8;
/** P(yes) at or above this is a match; the rest sit behind "Show weaker matches". */
export const MEANING_STRONG = 0.5;
export const MEANING_CACHE_MS = 10 * 60_000;
export const MEANING_RATE_PER_MIN = 20;

/** Per-record trims (characters): descriptions run ~400 on average, 1,650 at most. */
const TRIM = { description: 1200, spoken: 500, file: 120, folder: 100 };

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have in into is it its of on or that the their them then there these " +
    "this those to was were what when where which who with without about any some show shows showing find me my our " +
    "your one ones file files video videos image images photo photos clip clips picture pictures something like"
  ).split(" "),
);

/** Extra words that point at a category (the label itself always counts). */
const CATEGORY_WORDS: Partial<Record<CategoryId, string[]>> = {
  before_after: ["before and after", "before after", "before/after", "transformation"],
  static_ad: ["static", "statics"],
  video_ad: ["video ad", "video ads"],
  hook_clip: ["hook", "hooks"],
  intro_outro: ["intro", "intros", "outro", "outros"],
  talking_head: ["talking head", "talking to camera", "talking to the camera"],
  testimonial: ["testimonial", "testimonials", "review", "reviews"],
  broll: ["b roll", "broll"],
  vsl: ["vsl", "sales video"],
  episode: ["episode", "episodes", "podcast"],
  short: ["short", "shorts", "reel", "reels"],
  thumbnail: ["thumbnail", "thumbnails"],
  ai_render: ["render", "renders", "rendering"],
  screen_demo: ["screen recording", "screenshot", "screen demo", "website"],
  brand_asset: ["logo", "logos", "banner", "brand kit"],
  reference: ["inspo", "inspiration", "reference"],
};

const normalizeText = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The query as the cache key sees it (case and spacing do not matter). */
export function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Query words for the FTS prefilter: letters / digits, 2+ characters, no stopwords, at most 12. */
export function meaningTerms(q: string): string[] {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}

/**
 * The prefilter's FTS5 query: every (AND) or any (OR) query word, each a quoted string with a prefix star over every
 * column (`"garden"* OR "small"*`). Built from meaningTerms only (letters and digits), never raw user syntax.
 */
export function meaningFts(terms: string[], op: "AND" | "OR" = "OR"): string | null {
  return terms.length ? terms.map((t) => `"${t}"*`).join(` ${op} `) : null;
}

/** Categories the query names ("before and after", "thumbnail", "intro" ...). */
export function categoryHits(q: string): CategoryId[] {
  const text = ` ${normalizeText(q)} `;
  return CATEGORIES.filter((c) =>
    [c.label, c.id.replace(/_/g, " "), ...(CATEGORY_WORDS[c.id] ?? [])].some((w) => text.includes(` ${normalizeText(w)} `)),
  ).map((c) => c.id);
}

const DESCRIBED = "a.kind in ('image','video') and a.description is not null and a.description != ''";
const UNDESCRIBED = "a.kind in ('image','video') and (a.description is null or a.description = '')";

export type Candidate = {
  id: number;
  kind: "image" | "video";
  filename: string;
  relPath: string;
  description: string;
  spokenOpen: string | null;
  assetClass: string | null;
};

export type Prefilter = {
  candidates: Candidate[];
  /** Candidates found by the text match (FTS5) or a named category; the rest are padding. */
  textMatches: number;
  /** Images / videos in the scope without a description (left out). */
  undescribed: number;
};

/** Step 1: the candidate set (free, local). */
export function prefilter(sql: Sql, query: string, scope: Scope, filters: LibraryFilters, limit = MEANING_CANDIDATES): Prefilter {
  const w = scopeWhere(scope, filters);
  const undescribed = sql.prepare(`select count(*) ${LIBRARY_FROM} where ${w.sql} and ${UNDESCRIBED}`).pluck().get(...w.params) as number;
  const ids: number[] = [];
  const seen = new Set<number>();
  const add = (list: number[]) => {
    for (const id of list) {
      if (ids.length >= limit) return;
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  };
  // Files matching every query word first, then any word (each in bm25 order).
  const terms = meaningTerms(query);
  for (const fts of new Set([meaningFts(terms, "AND"), meaningFts(terms, "OR")])) {
    if (!fts || ids.length >= limit) continue;
    add(
      sql
        .prepare(
          `select a.id ${LIBRARY_FROM} join asset_fts on asset_fts.rowid = a.id
            where asset_fts match ? and ${w.sql} and ${DESCRIBED}
            order by bm25(asset_fts, 1.0, 1.0, 0.7, 0.5), a.mtime desc limit ?`,
        )
        .pluck()
        .all(fts, ...w.params, limit) as number[],
    );
  }
  const cats = categoryHits(query);
  if (cats.length && ids.length < limit) {
    add(
      sql
        .prepare(
          `select a.id ${LIBRARY_FROM} where ${w.sql} and ${DESCRIBED} and a.asset_class in (${cats.map(() => "?").join(",")})
            order by a.mtime desc, a.id desc limit ?`,
        )
        .pluck()
        .all(...w.params, ...cats, limit) as number[],
    );
  }
  const textMatches = ids.length;
  if (ids.length < limit) {
    add(
      sql
        .prepare(`select a.id ${LIBRARY_FROM} where ${w.sql} and ${DESCRIBED} order by a.mtime desc, a.id desc limit ?`)
        .pluck()
        .all(...w.params, limit + ids.length) as number[],
    );
  }
  if (!ids.length) return { candidates: [], textMatches: 0, undescribed };
  const rows = sql
    .prepare(
      `select id, kind, filename, rel_path as relPath, description, spoken_open as spokenOpen, asset_class as assetClass
         from assets where id in (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Candidate[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { candidates: ids.map((id) => byId.get(id)!).filter(Boolean), textMatches, undescribed };
}

// ------------------------------------------------------------------ batches

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A candidate as Jev reads it: only what a match needs. */
export function candidateRecord(c: Candidate): Record<string, string> {
  const dir = folderOf(c.relPath); // relative only: the root label would cost tokens on every record and not help
  const rec: Record<string, string> = { kind: c.kind };
  if (isCategory(c.assetClass)) rec.category = CATEGORY_LABEL[c.assetClass];
  rec.file = clip(c.filename, TRIM.file);
  if (dir) rec.folder = clip(dir.length > TRIM.folder ? `…${dir.slice(-(TRIM.folder - 1))}` : dir, TRIM.folder + 1);
  rec.description = clip(c.description.trim(), TRIM.description);
  if (c.kind === "video") rec.spoken_opening = c.spokenOpen ? clip(c.spokenOpen.trim(), TRIM.spoken) : "none";
  return rec;
}

export const candidateKey = (id: number) => `a${id}`;

export function meaningQuestion(key: string, query: string): JevQuestion {
  return {
    type: "noul",
    instructions: `Does \`candidates.${key}\` match this search: "${query}"?`,
    criteria: {
      true: "Its description, spoken opening, file name or folder shows it is what the search asks for (`whos_who` says who the people in the files are).",
      false: "It is about something else, or only shares a word with the search.",
    },
  };
}

export type BatchState = { whos_who?: string[]; candidates: Record<string, Record<string, string>> };
export type Batch = { ids: number[]; state: BatchState; questions: Record<string, JevQuestion>; stateChars: number };

/**
 * Pack candidates (in prefilter order) into requests: at most `max` each and a state under `budget` characters. Every
 * request carries the who's who lines (when given) ahead of its candidates; they count toward the budget.
 */
export function makeBatches(
  query: string,
  candidates: Candidate[],
  max = MEANING_BATCH,
  budget = MEANING_STATE_CHARS,
  whos: string[] = [],
): Batch[] {
  const batches: Batch[] = [];
  const empty = (): BatchState => (whos.length ? { whos_who: whos, candidates: {} } : { candidates: {} });
  let cur: Batch | null = null;
  for (const c of candidates) {
    const key = candidateKey(c.id);
    const rec = candidateRecord(c);
    const recChars = JSON.stringify({ [key]: rec }).length;
    if (!cur || cur.ids.length >= max || cur.stateChars + recChars > budget) {
      const state = empty();
      cur = { ids: [], state, questions: {}, stateChars: JSON.stringify(state).length };
      batches.push(cur);
    }
    cur.ids.push(c.id);
    cur.state.candidates[key] = rec;
    cur.questions[key] = meaningQuestion(key, query);
    cur.stateChars += recChars;
  }
  for (const b of batches) b.stateChars = JSON.stringify(b.state).length;
  return batches;
}

// -------------------------------------------------------- cache + rate limit

export type Ranked = { id: number; p: number };

export type MeaningResult = {
  ranking: Ranked[];
  candidates: number;
  textMatches: number;
  undescribed: number;
  requests: number;
  inputTokens: number;
  ms: number;
};

/** Stored rankings by normalized query + scope + filters, for MEANING_CACHE_MS. In memory: gone on restart. */
export class MeaningCache {
  private map = new Map<string, { at: number; value: MeaningResult }>();

  constructor(
    private readonly ttlMs = MEANING_CACHE_MS,
    private readonly max = 100,
  ) {}

  get(key: string, now = Date.now()): MeaningResult | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: MeaningResult, now = Date.now()) {
    this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/** Token bucket: `capacity` paid searches, refilled evenly over a minute. */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity = MEANING_RATE_PER_MIN,
    private readonly windowMs = 60_000,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number) {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.capacity) / this.windowMs);
    this.last = now;
  }

  take(now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Seconds until the next search is allowed. */
  retryAfterS(now = Date.now()): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * this.windowMs) / this.capacity / 1000);
  }
}

export function cacheKey(query: string, scope: Scope, filters: LibraryFilters): string {
  const f = { ...filters, q: "", sort: "newest", meaning: true, page: 1 };
  return JSON.stringify({ q: normalizeQuery(query), scope, f });
}

// -------------------------------------------------------------------- search

export type MeaningDeps = {
  sql: Sql;
  jev: JevAdapter;
  cache: MeaningCache;
  limiter: RateLimiter;
  /** Identical searches already running (shared, never run twice at once). */
  inflight: Map<string, Promise<MeaningOutcome>>;
  now?: () => number;
  concurrency?: number;
};

export type MeaningFailure = "rate" | "cap" | "nokey" | "auth" | "unavailable" | "error";

export type MeaningOutcome =
  | ({ ok: true; cached: boolean } & MeaningResult)
  | { ok: false; reason: MeaningFailure; message: string; retryAfterS?: number };

export const MEANING_MESSAGES: Record<MeaningFailure, string> = {
  rate: "Too many searches by meaning in the last minute. Try again shortly.",
  cap: "Daily Jev cap reached. Plain search still works.",
  nokey: "Search by meaning needs the Jev key (Settings). Plain search still works.",
  auth: "Jev refused the key (Settings). Plain search still works.",
  unavailable: "Jev is not answering right now. Plain search still works.",
  error: "Search by meaning failed. Plain search still works.",
};

function failure(reason: MeaningFailure, extra: { retryAfterS?: number } = {}): MeaningOutcome {
  return { ok: false, reason, message: MEANING_MESSAGES[reason], ...extra };
}

/** Steps 2 + 3: prefilter, rank, cache. `query` is already validated (MEANING_MIN_QUERY..MEANING_MAX_QUERY). */
export async function meaningSearch(deps: MeaningDeps, req: { query: string; scope: Scope; filters: LibraryFilters }): Promise<MeaningOutcome> {
  const now = deps.now ?? Date.now;
  const query = req.query.replace(/\s+/g, " ").trim();
  const key = cacheKey(query, req.scope, req.filters);
  const hit = deps.cache.get(key, now());
  if (hit) return { ok: true, cached: true, ...hit };
  const running = deps.inflight.get(key);
  if (running) return running;

  const run = (async (): Promise<MeaningOutcome> => {
    const started = now();
    const pre = prefilter(deps.sql, query, req.scope, req.filters);
    const empty: MeaningResult = { ranking: [], candidates: 0, textMatches: 0, undescribed: pre.undescribed, requests: 0, inputTokens: 0, ms: 0 };
    if (!pre.candidates.length) return { ok: true, cached: false, ...empty };
    const batches = makeBatches(query, pre.candidates, MEANING_BATCH, MEANING_STATE_CHARS, noteLines(whosWho(deps.sql)));

    // Refuse the whole search up front when it would pass today's cap (Jev.ask checks and reserves each request again).
    const estimate = batches.reduce((sum, b) => sum + costUsd(estimateTokens(b.questions, JSON.stringify(b.state))), 0);
    if (capWouldPass(deps.sql, estimate, now()).exceeded) return failure("cap");
    if (!deps.limiter.take(now())) return failure("rate", { retryAfterS: deps.limiter.retryAfterS(now()) });

    const scores = new Map<number, number>();
    let inputTokens = 0;
    let failed: unknown = null;
    let next = 0;
    const worker = async () => {
      while (!failed && next < batches.length) {
        const b = batches[next++];
        try {
          const res = await deps.jev.ask(b.questions, b.state, "search");
          inputTokens += res.inputTokens;
          for (const id of b.ids) scores.set(id, Number(res.answers[candidateKey(id)]));
        } catch (e) {
          failed ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? MEANING_CONCURRENCY, batches.length) }, worker));
    if (failed) return failure(jevFailureKind(failed) ?? "error");

    const order = new Map(pre.candidates.map((c, i) => [c.id, i]));
    const ranking = pre.candidates
      .map((c) => ({ id: c.id, p: Math.round((scores.get(c.id) ?? 0) * 1000) / 1000 }))
      .sort((a, b) => b.p - a.p || order.get(a.id)! - order.get(b.id)!);
    const result: MeaningResult = {
      ranking,
      candidates: pre.candidates.length,
      textMatches: pre.textMatches,
      undescribed: pre.undescribed,
      requests: batches.length,
      inputTokens,
      ms: now() - started,
    };
    deps.cache.set(key, result, now());
    return { ok: true, cached: false, ...result };
  })();

  deps.inflight.set(key, run);
  try {
    return await run;
  } finally {
    deps.inflight.delete(key);
  }
}
