/**
 * Jev landing page section scorer (server only; landing page Phase 2 slice 2, design B): the runner behind
 * `scripts/score-page.ts`. ADVISORY: it blocks nothing and writes NOTHING but the `ai_calls` rows Jev.ask logs (purpose
 * `page_score`, inside the daily cap): no hooks, hook_scores, notes, rubric_versions or settings.
 *
 * - The channel comes from the request code exactly like the copy gate (`copyGateChannel`: "rtm", "fkb", else a Lane B
 *   client code), and the context Jev reads is the hook state's own channel / whos_who / avatars blocks
 *   (`pageContextState` = `buildHookState` on the CURRENT hook rubric without its `hook` block): `briefOf` for the
 *   section, the section notes, who's who and the section's avatars. Lane A pages read the v3 Lane A context, Lane B and
 *   Lane C pages their unchanged context.
 * - The page rubric version comes from the request (`page_rubric_version`, default CURRENT_PAGE_RUBRIC); an unknown
 *   version, an unknown part, a duplicate part or an unknown code = PageGateInputError (the CLI exits 1).
 * - `resolvePage` is FREE (no Jev call, read only): versions, context_fp and each section's cache key. The skill's
 *   cache (slice 3) keys a score by (code, part, key, page_rubric_version, context_fp).
 *     key        = sha256 of the request side of the state (page {site, headline} + part + section {heading, clipped
 *                  text, ctas}): everything Jev reads that the request controls. `stage` and `url` are not in it, so
 *                  the same words score the same before and after.
 *     context_fp = 16 hex (`notesFingerprint`) of {page_rubric_version, the pinned Jev model id, the context blocks
 *                  (brief, notes, hint, who's who, What works here, avatars offered), the voice snippets}. NOT the
 *                  section version (reported beside it): a hook rubric edit that leaves the context blocks alone (e.g.
 *                  Lane A dimensions only) keeps every cached page score; one that changes them moves the blocks anyway.
 *                  Together with page_rubric_version (questions + part lines) the three cover the whole Jev input.
 * - One Jev call per section (`concurrency` at a time, results in input order). Failures never throw: the section gets
 *   score null + error "<kind>: <message>" with the copy gate's halting rules (`copyGateError`): no key / cap / key
 *   refused stop further calls and mark the rest, Jev unavailable fails its own section until 3 in a row, a 422 fails
 *   that section only.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { JevAdapter } from "../ai/jev";
import { classifyThreshold } from "../ai/state";
import { channelContextState, copyGateChannel, CopyGateInputError, copyGateError, COPY_GATE_UNAVAILABLE_HALT } from "../hooks/copygate";
import { loadChannelNotes, notesFingerprint, type ChannelNotes } from "../hooks/notes";
import type { RubricVersion, ScoreBand, SectionKey } from "../hooks/rubric";
import { currentRubric } from "../hooks/store";
import { CURRENT_PAGE_RUBRIC, pagePart, pageRubric, type PagePart, type PageRubric } from "./rubric";
import {
  buildPageQuestions,
  buildPageState,
  evaluatePageSection,
  pageRequestState,
  pageScoredText,
  pageSummary,
  pageVoice,
  round2,
  type PageInfo,
  type PageSectionInput,
} from "./score";

type Sql = Database.Database;

export const PAGE_SECTIONS_MAX = 12;

export const pageGateRequestSchema = z.object({
  code: z.string().trim().min(1).max(40),
  page_rubric_version: z.number().int().positive().optional(),
  page: z
    .object({
      url: z.string().max(2_000).optional(),
      site: z.string().trim().max(80).optional(),
      stage: z.string().trim().max(40).optional(),
      headline: z.string().trim().max(500).nullable().optional(),
    })
    .default({}),
  voice: z.array(z.string().max(5_000)).max(50).optional(),
  sections: z
    .array(
      z
        .object({
          id: z.string().min(1).max(200),
          part: z.string().trim().min(1).max(40),
          heading: z.string().trim().max(500).nullable().optional(),
          text: z.string().max(5_000).default(""),
          ctas: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
        })
        .refine((s) => s.text.trim().length > 0 || s.ctas.length > 0, "text is empty (and no ctas)"),
    )
    .min(1)
    .max(PAGE_SECTIONS_MAX)
    .refine((ss) => new Set(ss.map((s) => s.id)).size === ss.length, "section ids must be unique")
    .refine((ss) => new Set(ss.map((s) => s.part)).size === ss.length, "at most one section per part"),
});
export type PageGateRequest = z.infer<typeof pageGateRequestSchema>;

/** Bad input (unknown code, unknown page_rubric_version, a part the version does not have): the CLI exits 1. */
export class PageGateInputError extends Error {}

export type PageSectionResolved = { id: string; part: string; key: string; scored_text_chars: number };

export type PageResolveOutput = {
  page_rubric_version: number;
  /** The current hook rubric version (global). */
  hook_rubric_version: number;
  /** The code's section version on that hook rubric (rtm 3, fkbpros / fkb 2 on v3): what its context was built on. */
  section_version: number;
  context_fp: string;
  sections: PageSectionResolved[];
};

export type PageSectionResult = PageSectionResolved & {
  /** Mean of the dimension levels (2 decimals), null = not scored (see error). */
  score: number | null;
  band: ScoreBand;
  /** Dimension id -> level 1..5. */
  dims: Record<string, number>;
  why: string[];
  unsure: string[];
  error: string | null;
};

export type PageScoreOutput = Omit<PageResolveOutput, "sections"> & {
  /** The model that answered (Jev's own id) when any call succeeded, else the pinned id. */
  model: string;
  sections: PageSectionResult[];
  page_score: number | null;
  freight_score: number | null;
  cost_usd: number;
};

/**
 * The context blocks Jev reads for a code (everything but the page / part / section): the hook state for an empty text
 * hook of that channel without its `hook` block, i.e. channel {section, brief, <client key> | brand | scope, notes,
 * what_works_here}, whos_who and avatars. One definition with the hook scorer and the copy gate.
 */
export function pageContextState(rubric: RubricVersion, notes: ChannelNotes): Record<string, unknown> {
  return channelContextState(rubric, notes);
}

/** sha256 (hex) of the request side of a section's state. */
export function pageSectionKey(part: PagePart, page: PageInfo, section: PageSectionInput): string {
  return createHash("sha256").update(JSON.stringify(pageRequestState(part, page, section))).digest("hex");
}

export function pageContextFp(pageVersion: number, model: string, context: Record<string, unknown>, voice: string[] | null): string {
  return notesFingerprint({ page_rubric_version: pageVersion, model, context, voice });
}

type Resolved = {
  rubric: PageRubric;
  hookRubric: RubricVersion;
  section: SectionKey;
  page: PageInfo;
  context: Record<string, unknown>;
  voice: string[] | null;
  contextFp: string;
  sections: { input: PageSectionInput; part: PagePart; key: string; scoredChars: number }[];
};

function resolve(sql: Sql, req: PageGateRequest, model: string): Resolved {
  const version = req.page_rubric_version ?? CURRENT_PAGE_RUBRIC;
  const rubric = pageRubric(version);
  if (!rubric) throw new PageGateInputError(`Unknown page_rubric_version ${version}`);
  let channel;
  try {
    channel = copyGateChannel(sql, req.code);
  } catch (e) {
    if (e instanceof CopyGateInputError) throw new PageGateInputError(e.message);
    throw e;
  }
  const sections = req.sections.map((s) => {
    const part = pagePart(rubric, s.part);
    if (!part) throw new PageGateInputError(`Unknown part "${s.part}" (page rubric v${rubric.version}: ${rubric.parts.map((p) => p.id).join(", ")})`);
    return { s, part };
  });
  const hookRubric = currentRubric(sql);
  const notes = loadChannelNotes(sql, channel.section, channel.clientId);
  const context = pageContextState(hookRubric, notes);
  const voice = pageVoice(req.voice);
  const headlinePart = req.sections.find((s) => s.part === "headline");
  const page: PageInfo = {
    site: req.page.site?.trim() || null,
    // One normalization for both sources (CRLF fold + clip), so the same headline always gives the same keys.
    headline: pageScoredText(req.page.headline ?? "") || (headlinePart ? pageScoredText(headlinePart.text) : "") || null,
  };
  return {
    rubric,
    hookRubric,
    section: channel.section,
    page,
    context,
    voice,
    contextFp: pageContextFp(rubric.version, model, context, voice),
    sections: sections.map(({ s, part }) => {
      const input: PageSectionInput = { id: s.id, part: part.id, heading: s.heading?.trim() || null, text: s.text, ctas: s.ctas };
      return { input, part, key: pageSectionKey(part, page, input), scoredChars: pageScoredText(s.text).length };
    }),
  };
}

function header(r: Resolved): Omit<PageResolveOutput, "sections"> {
  return {
    page_rubric_version: r.rubric.version,
    hook_rubric_version: r.hookRubric.version,
    section_version: r.hookRubric.sectionVersions[r.section],
    context_fp: r.contextFp,
  };
}

const resolvedOf = (s: Resolved["sections"][number]): PageSectionResolved => ({ id: s.input.id, part: s.part.id, key: s.key, scored_text_chars: s.scoredChars });

/**
 * FREE: versions, context_fp and each section's key. No Jev call, reads only. `model` = the pinned Jev model id (config
 * STUDIO_JEV_MODEL; part of context_fp). Throws PageGateInputError on bad input.
 */
export function resolvePage(sql: Sql, req: PageGateRequest, model: string): PageResolveOutput {
  const r = resolve(sql, req, model);
  return { ...header(r), sections: r.sections.map(resolvedOf) };
}

/**
 * Score every section (one Jev call each, purpose `page_score`). Throws only PageGateInputError; Jev failures land on
 * the sections. cost_usd sums the successful calls only (ai_calls is the full ledger).
 */
export async function scorePage(
  sql: Sql,
  jev: JevAdapter,
  req: PageGateRequest,
  opts: { concurrency?: number; log?: (...args: unknown[]) => void } = {},
): Promise<PageScoreOutput> {
  const r = resolve(sql, req, jev.model);
  const threshold = classifyThreshold(sql);
  const results: PageSectionResult[] = new Array(r.sections.length);
  let cost = 0;
  let answeredBy: string | null = null;
  let halted: string | null = null;
  let unavailableRun = 0;
  let next = 0;

  const unscored = (i: number, error: string): PageSectionResult => ({
    ...resolvedOf(r.sections[i]),
    score: null,
    band: "unscored",
    dims: {},
    why: [],
    unsure: [],
    error,
  });

  const one = async (i: number) => {
    const s = r.sections[i];
    if (halted) {
      results[i] = unscored(i, halted);
      return;
    }
    try {
      const state = buildPageState(s.part, r.page, s.input, r.context, r.voice);
      const res = await jev.ask(buildPageQuestions(s.part), state, "page_score");
      cost += res.cost;
      answeredBy = res.model || answeredBy;
      unavailableRun = 0;
      const ev = evaluatePageSection(s.part, res.full, threshold);
      results[i] =
        ev.score === null
          ? unscored(i, "error: score not computed")
          : { ...resolvedOf(s), score: round2(ev.score), band: ev.band, dims: ev.levels, why: ev.why, unsure: ev.unsure, error: null };
      opts.log?.(`page score: ${s.input.id} (${s.part.id}) ${results[i].score?.toFixed(2) ?? "unscored"} · ${res.inputTokens} tokens`);
    } catch (e) {
      const err = copyGateError(e);
      unavailableRun = err.unavailable ? unavailableRun + 1 : 0;
      if (err.halts || unavailableRun >= COPY_GATE_UNAVAILABLE_HALT) halted ??= err.text;
      results[i] = unscored(i, err.text);
      opts.log?.(`page score: ${s.input.id} (${s.part.id}) not scored: ${err.text}`);
    }
  };

  const worker = async () => {
    while (next < r.sections.length) await one(next++);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, r.sections.length)) }, worker));
  return {
    ...header(r),
    model: answeredBy ?? jev.model,
    sections: results,
    ...pageSummary(r.rubric, results),
    cost_usd: Math.round(cost * 1e8) / 1e8,
  };
}
