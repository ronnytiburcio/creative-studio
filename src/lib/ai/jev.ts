/**
 * Jev (TypeSafe) adapter (server only): the one way Studio asks Jev anything.
 *
 *   ask(questions, state, purpose, { assetId }) -> { answers, probabilities, confidence, cost, model, inputTokens, ms }
 *
 * - Pinned model (config STUDIO_JEV_MODEL, a versioned id; aliases are refused at config load). A response answered by
 *   another model id is accepted but logged, and the answering id is what ai_calls records.
 * - Daily cap (app_settings `jev:daily_cap_usd`, default $1): before every call today's spend (America/New_York day,
 *   summed from ai_calls) plus the estimates of this process's calls still in flight plus a conservative estimate for
 *   this call must stay under the cap (capWouldPass), else JevCapReachedError and no request is made. The in-flight
 *   reservation is per process: the web (search) and the worker (classify) each see only their own, so the cap can be
 *   overshot by at most one process's in-flight estimates (a few cents at most), never by a burst of parallel calls.
 * - Retries 429 / 529 / 5xx / network errors with exponential backoff honouring `retry-after`; never 401 / 422.
 * - Every call that reaches the network is logged in ai_calls (success or failure): purpose, answering model, asset,
 *   questions, state size (never the state, never the key), input tokens, answers + probabilities, min confidence,
 *   cost, ms, error.
 * - The key is read by the HTTP transport only (readTypesafeKey), fresh per request, and goes nowhere but the
 *   Authorization header. Error messages are terse and never include it.
 *
 * The smoke test swaps the transport for FakeJev (src/lib/ai/fake.ts): tests never call the real API.
 */
import type Database from "better-sqlite3";
import { z } from "zod";
import { ENV_FILE, tildePath } from "../config";

type Sql = Database.Database;

export const JEV_API = "https://api.typesafe.ai/v1";
/** USD per 1M input tokens (output is free). */
export const JEV_PRICE_PER_M_INPUT = 0.042;
export const JEV_TIMEZONE = "America/New_York";

export const DAILY_CAP_KEY = "jev:daily_cap_usd";
export const DEFAULT_DAILY_CAP_USD = 1;
export const MAX_DAILY_CAP_USD = 20;

export type AiPurpose = "classify" | "search" | "hook_score" | "copy_gate" | "page_score" | "test";

export type JevInstructions = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: "choice"; instructions: JevInstructions; criteria: Record<string, string | null> }
  | { type: "score"; instructions: JevInstructions; criteria: string[] }
  | { type: "noul"; instructions: JevInstructions; criteria?: { true: string; false: string } };

/** One answer, normalized. value: the choice, the 0-based score, or P(yes) for a noul. */
export type JevAnswer = {
  type: JevQuestion["type"];
  value: string | number;
  probabilities: Record<string, number>;
  /** choice / score: Jev's confidence; noul: null (a noul has no confidence, its value is the probability). */
  confidence: number | null;
};

export type JevAskResult = {
  answers: Record<string, string | number>;
  probabilities: Record<string, Record<string, number>>;
  confidence: Record<string, number | null>;
  /** The normalized answers keyed by question id (what classify stores). */
  full: Record<string, JevAnswer>;
  cost: number;
  model: string;
  inputTokens: number;
  ms: number;
  /** ai_calls row id. */
  callId: number;
};

export interface JevAdapter {
  readonly model: string;
  ask(
    questions: Record<string, JevQuestion>,
    state: unknown,
    purpose: AiPurpose,
    opts?: { assetId?: number | null; signal?: AbortSignal },
  ): Promise<JevAskResult>;
}

// ------------------------------------------------------------------- errors

export class JevError extends Error {}
/** No TYPESAFE_API_KEY in the env file: nothing was sent. */
export class JevKeyMissingError extends JevError {}
const NO_KEY_TEXT = `No Jev key (TYPESAFE_API_KEY in ${tildePath(ENV_FILE)})`;
/** 401: the key was refused. Never retried. */
export class JevAuthError extends JevError {}
/** Jev is unreachable, overloaded (529), rate limited (429) or erroring (5xx) after the retries, or timed out. */
export class JevUnavailableError extends JevError {}
/** Today's spend plus this call would pass the daily cap: nothing was sent. `resumeAt` = next local midnight. */
export class JevCapReachedError extends JevError {
  constructor(
    message: string,
    readonly resumeAt: number,
  ) {
    super(message);
  }
}
/** 422 / other 4xx / an answer that does not match the question: a problem with this one request. Never retried. */
export class JevRequestError extends JevError {}

/**
 * Why a call failed, for callers that wait instead of failing (classify queue, search refusals): cap, nokey, auth,
 * unavailable; null = anything else (a request error, a bug), which is the asset's / the search's own failure.
 */
export type JevFailureKind = "cap" | "nokey" | "auth" | "unavailable";

export function jevFailureKind(e: unknown): JevFailureKind | null {
  if (e instanceof JevCapReachedError) return "cap";
  if (e instanceof JevKeyMissingError) return "nokey";
  if (e instanceof JevAuthError) return "auth";
  if (e instanceof JevUnavailableError) return "unavailable";
  return null;
}

// ---------------------------------------------------------------- transport

export type JevHttpResponse = { status: number; retryAfter: string | null; body: unknown };

/** The network side of the adapter (FakeJev replaces it in the smoke test). */
export interface JevTransport {
  keyPresent(): boolean;
  post(path: "/systemone", body: unknown, signal: AbortSignal): Promise<JevHttpResponse>;
  get(path: "/models", signal: AbortSignal): Promise<JevHttpResponse>;
}

export class HttpJevTransport implements JevTransport {
  constructor(
    private readonly readKey: () => string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  keyPresent() {
    return Boolean(this.readKey());
  }

  private async send(path: string, init: { method: "GET" | "POST"; body?: unknown }, signal: AbortSignal): Promise<JevHttpResponse> {
    const key = this.readKey();
    if (!key) throw new JevKeyMissingError(NO_KEY_TEXT);
    const res = await this.fetchImpl(`${JEV_API}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        accept: "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body: status decides */
    }
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body };
  }

  post(path: "/systemone", body: unknown, signal: AbortSignal) {
    return this.send(path, { method: "POST", body }, signal);
  }

  get(path: "/models", signal: AbortSignal) {
    return this.send(path, { method: "GET" }, signal);
  }
}

// ------------------------------------------------------------ local day math

function tzOffsetMs(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Epoch ms of the start (00:00) of the America/New_York day containing `now` (DST safe). */
export function localDayStart(now = Date.now(), timeZone = JEV_TIMEZONE): number {
  const offset = tzOffsetMs(now, timeZone);
  const local = new Date(now + offset);
  const midnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // The offset at midnight can differ from now's on a DST day: settle it with one more lookup.
  let start = midnightAsUtc - offset;
  start = midnightAsUtc - tzOffsetMs(start, timeZone);
  return start;
}

/**
 * Epoch ms of `hour`:00 wall-clock time in `timeZone` on the local day that holds `at`. Computed as a wall-clock time
 * (the offset looked up at that time), so a DST transition day still gives e.g. 06:00 local, never 05:00 or 07:00.
 */
export function localTimeOn(at: number, hour: number, timeZone = JEV_TIMEZONE): number {
  const offset = tzOffsetMs(at, timeZone);
  const local = new Date(at + offset);
  const wallAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour);
  // The offset at that wall time can differ from `at`'s on a DST day: settle it with one more lookup.
  let t = wallAsUtc - offset;
  t = wallAsUtc - tzOffsetMs(t, timeZone);
  return t;
}

/** Epoch ms of the next local midnight after `now`. */
export function nextLocalDayStart(now = Date.now(), timeZone = JEV_TIMEZONE): number {
  return localDayStart(localDayStart(now, timeZone) + 36 * 3_600_000, timeZone);
}

// ------------------------------------------------------------- spend + cap

export function costUsd(inputTokens: number): number {
  return (inputTokens * JEV_PRICE_PER_M_INPUT) / 1_000_000;
}

function setting(sql: Sql, key: string): string | null {
  return (sql.prepare("select value from app_settings where key = ?").pluck().get(key) as string | null | undefined) ?? null;
}

export function dailyCapUsd(sql: Sql): number {
  const raw = setting(sql, DAILY_CAP_KEY);
  const v = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_DAILY_CAP_USD) : DEFAULT_DAILY_CAP_USD;
}

export function setDailyCapUsd(sql: Sql, usd: number) {
  sql
    .prepare("insert into app_settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
    .run(DAILY_CAP_KEY, String(usd));
}

export type JevSpend = { todayUsd: number; allTimeUsd: number; todayCalls: number; allTimeCalls: number; capUsd: number };

/** Estimates of this process's Jev calls that were sent but not logged yet (reserved against the cap). */
let inFlightUsd = 0;

/** What this process has reserved for calls in flight (0 when idle). */
export function jevReservedUsd(): number {
  return inFlightUsd;
}

/**
 * The one cap check (Jev.ask per request, meaningSearch up front for the whole search): would today's logged spend +
 * this process's in-flight reservations + `estimateUsd` pass the daily cap?
 */
export function capWouldPass(sql: Sql, estimateUsd: number, now = Date.now()): { exceeded: boolean; spend: JevSpend } {
  const spend = jevSpend(sql, now);
  return { exceeded: spend.todayUsd + inFlightUsd + estimateUsd > spend.capUsd, spend };
}

export function jevSpend(sql: Sql, now = Date.now()): JevSpend {
  const row = sql
    .prepare(
      `select coalesce(sum(case when created_at >= @start then cost_usd end), 0) as today,
              coalesce(sum(cost_usd), 0) as total,
              coalesce(sum(created_at >= @start), 0) as today_calls,
              count(*) as calls
         from ai_calls where provider = 'jev'`,
    )
    .get({ start: localDayStart(now) }) as { today: number; total: number; today_calls: number; calls: number };
  return { todayUsd: row.today, allTimeUsd: row.total, todayCalls: row.today_calls, allTimeCalls: row.calls, capUsd: dailyCapUsd(sql) };
}

export type PurposeSpend = { purpose: string; todayUsd: number; allTimeUsd: number; todayCalls: number; allTimeCalls: number };

/** Jev spend per purpose (classify / search / hook_score / ...), today (America/New_York) and all time. */
export function jevSpendByPurpose(sql: Sql, now = Date.now()): PurposeSpend[] {
  return (
    sql
      .prepare(
        `select purpose, coalesce(sum(case when created_at >= @start then cost_usd end), 0) as today, coalesce(sum(cost_usd), 0) as total,
                coalesce(sum(created_at >= @start), 0) as today_calls, count(*) as calls
           from ai_calls where provider = 'jev' group by purpose order by total desc`,
      )
      .all({ start: localDayStart(now) }) as { purpose: string; today: number; total: number; today_calls: number; calls: number }[]
  ).map((r) => ({ purpose: r.purpose, todayUsd: r.today, allTimeUsd: r.total, todayCalls: r.today_calls, allTimeCalls: r.calls }));
}

/**
 * Conservative token estimate for the cap check: ~3 characters per token (real calls run at ~3.1 to 3.5) plus 50 per
 * question. The state is billed once per request, not once per question (measured 2026-09-30: classify calls whose
 * state differs by 412 characters differ by ~150 tokens; a 6-question search probe with a 2,780-character state and
 * 1,807 characters of questions was billed 1,496 tokens), so it is counted once.
 */
export function estimateTokens(questions: Record<string, JevQuestion>, stateJson: string): number {
  const n = Math.max(1, Object.keys(questions).length);
  return Math.ceil((stateJson.length + JSON.stringify(questions).length) / 3) + 50 * n;
}

// --------------------------------------------------------------- response

const Probs = z.record(z.string(), z.number());
const ChoiceAnswer = z.object({ choice: z.string(), probabilities: Probs, confidence: z.number().optional() }).loose();
const ScoreAnswer = z.object({ score: z.number(), probabilities: Probs.optional(), confidence: z.number().optional() }).loose();
const NoulAnswer = z.object({ noul: z.number().min(0).max(1) }).loose();
const Response = z
  .object({
    model: z.string().max(100),
    answers: z.record(z.string(), z.unknown()),
    usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().optional() }).loose(),
  })
  .loose();

/** usage.input_tokens read loosely (for a 200 whose body fails the strict parse), or null. */
function billedTokens(body: unknown): number | null {
  const usage = body && typeof body === "object" ? (body as { usage?: unknown }).usage : null;
  const n = usage && typeof usage === "object" ? (usage as { input_tokens?: unknown }).input_tokens : null;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Choice confidence as TypeSafe defines it: (n x top probability - 1) / (n - 1). */
export function choiceConfidence(probabilities: Record<string, number>): number {
  const ps = Object.values(probabilities);
  const n = ps.length;
  if (n < 2) return 1;
  return Math.max(0, Math.min(1, (n * Math.max(...ps) - 1) / (n - 1)));
}

function normalizeAnswer(q: JevQuestion, raw: unknown, id: string): JevAnswer {
  const fail = () => new JevRequestError(`Jev answer for "${id}" does not match a ${q.type} question`);
  if (q.type === "choice") {
    const a = ChoiceAnswer.safeParse(raw);
    if (!a.success || !(a.data.choice in q.criteria)) throw fail();
    return { type: "choice", value: a.data.choice, probabilities: a.data.probabilities, confidence: a.data.confidence ?? choiceConfidence(a.data.probabilities) };
  }
  if (q.type === "score") {
    const a = ScoreAnswer.safeParse(raw);
    if (!a.success || a.data.score < 0 || a.data.score > q.criteria.length - 1) throw fail();
    const probabilities = a.data.probabilities ?? {};
    return { type: "score", value: a.data.score, probabilities, confidence: a.data.confidence ?? (Object.keys(probabilities).length ? choiceConfidence(probabilities) : null) };
  }
  const a = NoulAnswer.safeParse(raw);
  if (!a.success) throw fail();
  return { type: "noul", value: a.data.noul, probabilities: { yes: a.data.noul, no: 1 - a.data.noul }, confidence: null };
}

/** Terse error text from a 4xx body: TypeSafe's 422 names the bad field; keep it short and never echo much. */
function bodyDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const detail = b.detail ?? b.error ?? b.message;
  const text = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : "";
  return text.replace(/\s+/g, " ").slice(0, 240);
}

// ------------------------------------------------------------------ adapter

export type JevOptions = {
  log?: (...args: unknown[]) => void;
  /** Per request (default 60 s). */
  timeoutMs?: number;
  /** Attempts for 429 / 529 / 5xx / network errors (default 4). */
  attempts?: number;
  /** Test hook: backoff sleeps. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const realSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const secs = retryAfter != null ? Number(retryAfter) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
}

export class Jev implements JevAdapter {
  private warnedModels = new Set<string>();

  constructor(
    private readonly sql: Sql,
    private readonly transport: JevTransport,
    readonly model: string,
    private readonly opts: JevOptions = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Refuse (no request) when today's spend + calls in flight + this call's estimate would pass the cap, else reserve
   * the estimate (synchronously, so parallel calls see each other). The caller releases it once the call is logged.
   */
  private reserveCap(estimateUsd: number) {
    const now = this.now();
    const { exceeded, spend } = capWouldPass(this.sql, estimateUsd, now);
    if (exceeded) {
      throw new JevCapReachedError(`Daily Jev cap reached ($${spend.todayUsd.toFixed(4)} of $${spend.capUsd.toFixed(2)} today)`, nextLocalDayStart(now));
    }
    inFlightUsd += estimateUsd;
  }

  private logCall(row: {
    purpose: AiPurpose;
    model: string;
    assetId: number | null;
    questions: Record<string, JevQuestion>;
    stateChars: number;
    inputTokens: number | null;
    answers: Record<string, JevAnswer> | null;
    ms: number;
    error: string | null;
  }): number {
    const confidences = row.answers ? Object.values(row.answers).map((a) => a.confidence).filter((c): c is number => c != null) : [];
    const result = this.sql
      .prepare(
        `insert into ai_calls (created_at, purpose, provider, model, asset_id, questions, state_chars, input_tokens, answers,
           min_confidence, cost_usd, ms, error)
         values (?, ?, 'jev', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        row.purpose,
        row.model,
        row.assetId,
        JSON.stringify(row.questions),
        row.stateChars,
        row.inputTokens,
        row.answers ? JSON.stringify(row.answers) : null,
        confidences.length ? Math.min(...confidences) : null,
        row.inputTokens != null ? costUsd(row.inputTokens) : 0,
        row.ms,
        row.error,
      );
    return Number(result.lastInsertRowid);
  }

  async ask(
    questions: Record<string, JevQuestion>,
    state: unknown,
    purpose: AiPurpose,
    opts: { assetId?: number | null; signal?: AbortSignal } = {},
  ): Promise<JevAskResult> {
    if (!Object.keys(questions).length) throw new JevRequestError("No questions to ask");
    if (!this.transport.keyPresent()) throw new JevKeyMissingError(NO_KEY_TEXT);
    const stateJson = JSON.stringify(state ?? {});
    const estimate = costUsd(estimateTokens(questions, stateJson));
    this.reserveCap(estimate);
    try {
      return await this.send(questions, state, stateJson, purpose, opts);
    } finally {
      // Every path of send() has logged its ai_calls row (or sent nothing) by now.
      inFlightUsd = Math.max(0, inFlightUsd - estimate);
    }
  }

  private async send(
    questions: Record<string, JevQuestion>,
    state: unknown,
    stateJson: string,
    purpose: AiPurpose,
    opts: { assetId?: number | null; signal?: AbortSignal },
  ): Promise<JevAskResult> {
    const body = { state, model: this.model, questions };
    const started = this.now();
    const attempts = this.opts.attempts ?? 4;
    const sleep = this.opts.sleep ?? realSleep;
    const assetId = opts.assetId ?? null;
    const base = { purpose, model: this.model, assetId, questions, stateChars: stateJson.length };
    let lastError = "Jev did not answer";

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (opts.signal?.aborted) throw new JevUnavailableError("Stopped");
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: JevHttpResponse;
      try {
        res = await this.transport.post("/systemone", body, signal);
      } catch (e) {
        if (e instanceof JevKeyMissingError) throw e;
        if (opts.signal?.aborted) {
          this.logCall({ ...base, inputTokens: null, answers: null, ms: this.now() - started, error: "Stopped (worker shutting down)" });
          throw new JevUnavailableError("Stopped");
        }
        lastError = timeout.aborted ? "Jev timed out" : "Jev is not reachable";
        if (attempt < attempts - 1) {
          await sleep(retryDelayMs(attempt, null));
          continue;
        }
        break;
      }

      if (res.status === 200) {
        const parsed = Response.safeParse(res.body);
        if (!parsed.success) {
          // A 200 is billed even when the rest of the body does not parse: log its cost if usage is readable.
          this.logCall({ ...base, inputTokens: billedTokens(res.body), answers: null, ms: this.now() - started, error: "Unexpected response shape" });
          throw new JevRequestError("Jev returned an unexpected response");
        }
        const data = parsed.data;
        const inputTokens = data.usage.input_tokens;
        if (data.model !== this.model && !this.warnedModels.has(data.model)) {
          this.warnedModels.add(data.model);
          this.opts.log?.(`jev: answered by ${data.model}, pinned ${this.model}`);
        }
        const full: Record<string, JevAnswer> = {};
        try {
          for (const [id, q] of Object.entries(questions)) {
            if (!(id in data.answers)) throw new JevRequestError(`Jev returned no answer for "${id}"`);
            full[id] = normalizeAnswer(q, data.answers[id], id);
          }
        } catch (e) {
          this.logCall({ ...base, model: data.model, inputTokens, answers: null, ms: this.now() - started, error: (e as Error).message });
          throw e;
        }
        const ms = this.now() - started;
        const callId = this.logCall({ ...base, model: data.model, inputTokens, answers: full, ms, error: null });
        return {
          answers: Object.fromEntries(Object.entries(full).map(([id, a]) => [id, a.value])),
          probabilities: Object.fromEntries(Object.entries(full).map(([id, a]) => [id, a.probabilities])),
          confidence: Object.fromEntries(Object.entries(full).map(([id, a]) => [id, a.confidence])),
          full,
          cost: costUsd(inputTokens),
          model: data.model,
          inputTokens,
          ms,
          callId,
        };
      }

      const detail = bodyDetail(res.body);
      if (res.status === 401 || res.status === 403) {
        this.logCall({ ...base, inputTokens: null, answers: null, ms: this.now() - started, error: `HTTP ${res.status}` });
        throw new JevAuthError(`Jev refused the key (HTTP ${res.status})`);
      }
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastError = res.status === 429 ? "Jev rate limit (429)" : res.status === 529 ? "Jev is overloaded (529)" : `Jev error (HTTP ${res.status})`;
        if (attempt < attempts - 1) {
          await sleep(retryDelayMs(attempt, res.retryAfter));
          continue;
        }
        break;
      }
      const message = `Jev refused the request (HTTP ${res.status})${detail ? `: ${detail}` : ""}`;
      this.logCall({ ...base, inputTokens: null, answers: null, ms: this.now() - started, error: message });
      throw new JevRequestError(message);
    }
    this.logCall({ ...base, inputTokens: null, answers: null, ms: this.now() - started, error: lastError });
    throw new JevUnavailableError(lastError);
  }
}

// ------------------------------------------------------------------- status

export type JevStatus = {
  keyPresent: boolean;
  reachable: boolean;
  /** Model ids GET /v1/models listed (null when not reachable). */
  models: string[] | null;
  pinned: string;
  pinnedListed: boolean | null;
  error: string | null;
};

function modelIds(body: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 3 || v == null) return;
    if (typeof v === "string") {
      if (/^jev[-\w.]*$/i.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
  };
  visit(body, 0);
  return [...out].slice(0, 20);
}

/** Free check for Settings: key present + `GET /v1/models` answers (no tokens are spent). Never throws. */
export async function jevStatus(transport: JevTransport, pinned: string): Promise<JevStatus> {
  const keyPresent = transport.keyPresent();
  if (!keyPresent) return { keyPresent, reachable: false, models: null, pinned, pinnedListed: null, error: "No key" };
  try {
    const res = await transport.get("/models", AbortSignal.timeout(5_000));
    if (res.status === 401 || res.status === 403) return { keyPresent, reachable: true, models: null, pinned, pinnedListed: null, error: "Key refused" };
    if (res.status !== 200) return { keyPresent, reachable: false, models: null, pinned, pinnedListed: null, error: `HTTP ${res.status}` };
    const models = modelIds(res.body);
    return { keyPresent, reachable: true, models, pinned, pinnedListed: models.length ? models.includes(pinned) : null, error: null };
  } catch {
    return { keyPresent, reachable: false, models: null, pinned, pinnedListed: null, error: "Not reachable" };
  }
}
