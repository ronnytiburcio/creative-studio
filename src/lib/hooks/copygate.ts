/**
 * Jev copy gate for NEW Meta ad copy, Lane B clients and Lane C, and Lane A's own site / brand copy (server only):
 * scores headlines and primaries with the same rubric, state, questions and evaluation as the worker's HookScoreQueue
 * (src/lib/hooks/score.ts, unchanged), for `scripts/score-copy.ts` (the Lane B apply / launch skills and Lane C's ad
 * work call it through copy_score.py in META_ENV_FILE's folder, `_lib/`).
 *
 * - The channel comes from the request code (`copyGateChannel`): exactly "fkb" = Lane C's own section (client null: Lane C's
 *   brand notes, hint and What works here, the fkb dimensions); exactly "rtm" (2026-10-07) = the Lane A section (client
 *   null: the Lane A notes, the Lane A brief and avatars, the rtm dimensions, exactly what a Lane A hook is scored with); any
 *   other code = a Lane B client by `clients.code` in section fkbpros. Every line is a text hook (video null).
 * - Scored text: a headline whole; a primary's opening block (`scoredTextFor`): everything before the first ✅ line,
 *   else the first two paragraphs, else the first two sentences. That is what a customer reads before "more".
 * - Pass rule (`copyGateVerdict`, the owner 2026-10-02): overall >= COPY_GATE_BAR, and for primaries all three P's clear
 *   (PP_CLEAR). Unsure answers are reported and count at their value; being unsure never fails a line by itself.
 * - One Jev call per line (purpose `copy_gate`, inside the daily cap, logged in ai_calls by Jev.ask). Writes NOTHING
 *   else: no hooks, no hook_scores.
 * - Jev failures never throw out of `scoreCopyLines`: the line gets pass null + error. A failure that would repeat for
 *   every line (no key, daily cap, key refused) stops further calls and the rest of the lines carry the same error; Jev
 *   down after the adapter's retries ("unavailable") fails its own line only, until 3 lines in a row hit it (then the
 *   rest stop the same way). Only bad input (unknown code) throws CopyGateInputError.
 * - cost_usd sums the successful calls only; ai_calls is the full ledger (a billed failure is logged there).
 * - rubric_version is the section's EFFECTIVE version (landing page Phase 2 slice 1: on v3 Lane B / Lane C report 2, Lane A
 *   3), with rubric_version_global and context_fp beside it (`CopyGateOutput`). Scoring itself uses the current version.
 */
import type Database from "better-sqlite3";
import { z } from "zod";
import { jevFailureKind, JevRequestError, type JevAdapter } from "../ai/jev";
import { classifyThreshold } from "../ai/state";
import { loadChannelNotes, notesFingerprint, type ChannelNotes } from "./notes";
import { buildHookQuestions, buildHookState, evaluateHook, type HookEvaluation, type HookInput } from "./score";
import { currentRubric } from "./store";
import {
  bandOf,
  dimensionsFor,
  missingPs,
  PP_CLEAR,
  PP_IDS,
  PP_LABEL,
  type Dimension,
  type PpId,
  type RubricVersion,
  type ScoreBand,
} from "./rubric";
import { firstSentences } from "./text";
import { laneNames } from "../clients-admin";

type Sql = Database.Database;

/** The pass bar: overall (mean of the dimension levels, 1 to 5) at or above this. */
export const COPY_GATE_BAR = 3.0;
/** The request code that means Lane C's own section (the owner 2026-10-05), never a Lane B client code. */
export const COPY_GATE_FKB_CODE = "fkb" as const;
/** The request code that means the Lane A section (the owner 2026-10-07: Lane A's own website / brand copy). */
export const COPY_GATE_RTM_CODE = "rtm" as const;
/** The section every other request code is looked up in (a Lane B client by `clients.code`). */
export const COPY_GATE_CLIENT_SECTION = "fkbpros" as const;

export type CopyField = "headline" | "primary";
/** The Three P's as the output names them: PP_LABEL lowercased (PP_LABEL is typed as plain strings, so named here). */
export type PpWord = "person" | "pain" | "promise";

export const copyGateRequestSchema = z.object({
  code: z.string().trim().min(1).max(40),
  lines: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        field: z.enum(["headline", "primary"]),
        text: z.string().max(5_000).refine((s) => s.trim().length > 0, "text is empty"),
      }),
    )
    .min(1)
    .max(500)
    .refine((ls) => new Set(ls.map((l) => l.id)).size === ls.length, "line ids must be unique"),
});
export type CopyGateRequest = z.infer<typeof copyGateRequestSchema>;

export type CopyGateResult = {
  id: string;
  field: CopyField;
  scored_text: string;
  overall: number | null;
  band: ScoreBand;
  /** Dimension id -> level 1..5. */
  dims: Record<string, number>;
  pp: Record<PpWord, boolean> | null;
  pp_p: Record<PpWord, number | null> | null;
  avatar: string | null;
  style: string | null;
  stops_scroll: number | null;
  unsure: string[];
  /** null = not scored (see error). */
  pass: boolean | null;
  why: string[];
  error?: string;
};

/**
 * rubric_version = the request section's EFFECTIVE version (`sectionVersions`, landing page Phase 2 slice 1: Lane B
 * and Lane C stay 2 on v3, Lane A 3), the number copy_score.py keys its cache and labels by; rubric_version_global = the
 * current rubric version itself; context_fp = `copyGateContextFp` (everything Jev reads besides the line).
 */
export type CopyGateOutput = {
  rubric_version: number;
  rubric_version_global: number;
  context_fp: string;
  model: string;
  results: CopyGateResult[];
  cost_usd: number;
};

/** Bad input (unknown code): the CLI exits 1. */
export class CopyGateInputError extends Error {}

// ------------------------------------------------------------------------------------------- scored text (pure)

/** Collapse blank lines (and spaces around line breaks) to a single newline. */
const tidyLines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");

/**
 * What Jev scores for one line (grill Q1, the owner 2026-10-02): a headline whole (trimmed); a primary's opening block, cut
 * at the first rule that applies:
 *   (a) everything before its first line starting with ✅, when that is not line 1 (structured P1: the offer / place
 *       line plus the hook question);
 *   (b) else, when the text has a blank-line paragraph break, the first two paragraphs (the opener plus the next one,
 *       e.g. a P1 built on ⭐ / 📍 lines: its opener and the hook question);
 *   (c) else the first two sentences (a one-paragraph classic P2).
 */
export function scoredTextFor(field: CopyField, text: string): string {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (field === "headline") return t;
  const lines = t.split("\n");
  const firstCheck = lines.findIndex((l) => l.trimStart().startsWith("✅"));
  if (firstCheck > 0) {
    const block = tidyLines(lines.slice(0, firstCheck).join("\n"));
    if (block) return block;
  }
  const paragraphs = t.split(/\n[ \t]*\n/).map(tidyLines).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs.slice(0, 2).join("\n");
  return tidyLines(firstSentences(t, 2));
}

// ----------------------------------------------------------------------------------------------- verdict (pure)

const ppWord = (id: PpId) => PP_LABEL[id].toLowerCase() as PpWord;
/** { person, pain, promise } from the evaluation's P(yes) values, through `f`. */
const ppMap = <T>(pp: HookEvaluation["pp"], f: (v: number | null) => T) =>
  Object.fromEntries(PP_IDS.map((id) => [ppWord(id), f(pp[id])])) as Record<PpWord, T>;

export { bandOf };

/**
 * The pass rule (grill Q2): primary = overall >= COPY_GATE_BAR and all three P's clear; headline = overall >= the bar
 * (its P's are reported, never required). why = the dimensions at level 2 or below (labels), plus "missing <p>" for a
 * primary; "overall below 3.0" only when a failing line has nothing else to name. An unsure answer counts at its value
 * (an unsure level 2 is still weak); being unsure is never a fail by itself. An overall that is not a finite number is
 * not a score: pass null (the result becomes an unscored line).
 */
export function copyGateVerdict(
  field: CopyField,
  ev: Pick<HookEvaluation, "levels" | "overall" | "pp">,
  dims: Pick<Dimension, "id" | "label">[],
): { pass: boolean | null; why: string[] } {
  if (typeof ev.overall !== "number" || !Number.isFinite(ev.overall)) return { pass: null, why: [] };
  const why = dims.filter((d) => typeof ev.levels[d.id] === "number" && ev.levels[d.id] <= 2).map((d) => d.label);
  const missing = missingPs(ev.pp);
  if (field === "primary") why.push(...missing.map((id) => `missing ${ppWord(id)}`));
  const overallOk = ev.overall >= COPY_GATE_BAR;
  const pass = overallOk && (field === "headline" || missing.length === 0);
  if (!pass && !why.length) why.push(`overall below ${COPY_GATE_BAR.toFixed(1)}`);
  return { pass, why };
}

/** Every field of a result that is not scored: one shape for both results below. */
const UNSCORED = {
  overall: null,
  band: "unscored",
  dims: {},
  pp: null,
  pp_p: null,
  avatar: null,
  style: null,
  stops_scroll: null,
  unsure: [],
  pass: null,
  why: [],
} satisfies Omit<CopyGateResult, "id" | "field" | "scored_text" | "error">;

export function copyGateResult(
  line: { id: string; field: CopyField },
  scoredText: string,
  ev: HookEvaluation,
  dims: Dimension[],
): CopyGateResult {
  const { pass, why } = copyGateVerdict(line.field, ev, dims);
  if (pass === null) return unscoredResult(line, scoredText, "error: overall not computed");
  return {
    id: line.id,
    field: line.field,
    scored_text: scoredText,
    ...UNSCORED,
    // Display only (levels have one decimal, so 2 decimals is exact for 5 dimensions); pass uses the unrounded mean.
    overall: Math.round(ev.overall! * 100) / 100,
    band: bandOf(ev.overall),
    dims: ev.levels,
    pp: ppMap(ev.pp, (v) => typeof v === "number" && v >= PP_CLEAR),
    pp_p: ppMap(ev.pp, (v) => v),
    avatar: ev.avatar,
    style: ev.style,
    stops_scroll: ev.stopsScroll,
    unsure: ev.unsure,
    pass,
    why,
  };
}

/** A line that was not scored: pass null + error "<kind>: <message>". */
export function unscoredResult(line: { id: string; field: CopyField }, scoredText: string, error: string): CopyGateResult {
  return { id: line.id, field: line.field, scored_text: scoredText, ...UNSCORED, unsure: [], why: [], dims: {}, error };
}

/** Jev unavailable on this many lines in a row stops the run (each one already went through the adapter's retries). */
export const COPY_GATE_UNAVAILABLE_HALT = 3;

/**
 * "<kind>: <message>". halts = would repeat for every line (nokey, cap, auth); unavailable = Jev down after the
 * adapter's retries (its own line; COPY_GATE_UNAVAILABLE_HALT in a row stop the run); request (this line), error.
 */
export function copyGateError(e: unknown): { text: string; halts: boolean; unavailable: boolean } {
  const kind = jevFailureKind(e);
  const message = ((e as Error)?.message || "Scoring failed").replace(/\s+/g, " ").slice(0, 300);
  if (kind) return { text: `${kind}: ${message}`, halts: kind !== "unavailable", unavailable: kind === "unavailable" };
  return { text: `${e instanceof JevRequestError ? "request" : "error"}: ${message}`, halts: false, unavailable: false };
}

// ------------------------------------------------------------------------------------------------------ runner

/** Where a request code scores: Lane C's own section or the Lane A section (no client), or a Lane B client. */
export type CopyGateChannel =
  | { section: "fkb" | "rtm"; clientId: null }
  | { section: typeof COPY_GATE_CLIENT_SECTION; clientId: number };

/**
 * The request code's channel: exactly COPY_GATE_FKB_CODE = section fkb and exactly COPY_GATE_RTM_CODE = section rtm,
 * client null (even if a Lane B client ever had that code); else the Lane B client with that `clients.code`.
 * None of these = CopyGateInputError.
 */
export function copyGateChannel(sql: Sql, code: string): CopyGateChannel {
  if (code === COPY_GATE_FKB_CODE) return { section: "fkb", clientId: null };
  if (code === COPY_GATE_RTM_CODE) return { section: "rtm", clientId: null };
  const id = sql
    .prepare("select c.id from clients c join sections s on s.id = c.section_id where c.code = ? and s.key = ?")
    .pluck()
    .get(code, COPY_GATE_CLIENT_SECTION) as number | undefined;
  if (id == null) {
    throw new CopyGateInputError(`Unknown code "${code}": not a client code in ${laneNames(sql).fkbpros}, "${COPY_GATE_FKB_CODE}" or "${COPY_GATE_RTM_CODE}"`);
  }
  return { section: COPY_GATE_CLIENT_SECTION, clientId: id };
}

/**
 * Fingerprint (16 hex, `notesFingerprint`) of everything Jev reads for a text line in this channel except the line
 * itself: the state with its `hook` block left out (section, brief, <client key> / brand / scope, notes, What works here,
 * who's who, the avatars offered) plus the questions (dimensions with their levels, the Three P's, mechanics, avatar
 * choices). Same rubric content + same notes = same fingerprint; any edit Jev would see moves it. Free (no Jev call).
 */
/**
 * The context blocks Jev reads for a channel besides the line itself: the hook state of an empty text hook without its
 * `hook` block (channel {section, brief, <client key> | brand | scope, notes, what_works_here}, whos_who, avatars).
 * Shared by the copy gate fingerprint and the page scorer.
 */
export function channelContextState(rubric: RubricVersion, notes: ChannelNotes): Record<string, unknown> {
  const context = { ...buildHookState(rubric, emptyTextHook(notes)).state };
  delete context.hook;
  return context;
}

const emptyTextHook = (notes: ChannelNotes): HookInput => ({ ...notes, id: 0, kind: "text", text: "", video: null });

export function copyGateContextFp(rubric: RubricVersion, notes: ChannelNotes): string {
  return notesFingerprint({ context: channelContextState(rubric, notes), questions: buildHookQuestions(rubric, emptyTextHook(notes)) });
}

/**
 * Score every line (one Jev call each, `concurrency` at a time, results in input order). Throws only
 * CopyGateInputError (unknown code); Jev failures land on the lines.
 */
export async function scoreCopyLines(
  sql: Sql,
  jev: JevAdapter,
  req: CopyGateRequest,
  opts: { concurrency?: number; log?: (...args: unknown[]) => void } = {},
): Promise<CopyGateOutput> {
  const { section, clientId } = copyGateChannel(sql, req.code);
  const rubric = currentRubric(sql);
  const threshold = classifyThreshold(sql);
  const notes = loadChannelNotes(sql, section, clientId);
  const dims = dimensionsFor(rubric, section, "text");
  const results: CopyGateResult[] = new Array(req.lines.length);
  let cost = 0;
  let halted: string | null = null;
  let unavailableRun = 0;
  let next = 0;

  const one = async (i: number) => {
    const line = req.lines[i];
    const scoredText = scoredTextFor(line.field, line.text);
    if (halted) {
      results[i] = unscoredResult(line, scoredText, halted);
      return;
    }
    const input: HookInput = { ...notes, id: 0, kind: "text", text: scoredText, video: null };
    try {
      const questions = buildHookQuestions(rubric, input);
      const { state } = buildHookState(rubric, input);
      const res = await jev.ask(questions, state, "copy_gate");
      cost += res.cost;
      const ev = evaluateHook(rubric, input, res.full, threshold);
      unavailableRun = 0;
      results[i] = copyGateResult(line, scoredText, ev, dims);
      const r = results[i];
      opts.log?.(`copy gate: ${line.id} ${r.overall?.toFixed(2) ?? "?"} ${r.pass === null ? "unscored" : r.pass ? "pass" : "fail"} · ${res.inputTokens} tokens`);
    } catch (e) {
      const err = copyGateError(e);
      unavailableRun = err.unavailable ? unavailableRun + 1 : 0;
      if (err.halts || unavailableRun >= COPY_GATE_UNAVAILABLE_HALT) halted ??= err.text;
      results[i] = unscoredResult(line, scoredText, err.text);
      opts.log?.(`copy gate: ${line.id} not scored: ${err.text}`);
    }
  };

  const worker = async () => {
    while (next < req.lines.length) await one(next++);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, req.lines.length)) }, worker));
  return {
    rubric_version: rubric.sectionVersions[section],
    rubric_version_global: rubric.version,
    context_fp: copyGateContextFp(rubric, notes),
    model: jev.model,
    results,
    cost_usd: Math.round(cost * 1e8) / 1e8,
  };
}
