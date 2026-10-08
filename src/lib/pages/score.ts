/**
 * Landing page section scoring (landing page Phase 2 slice 2, design A2 / A3): what Jev is asked about one page part and
 * how the answers become a score. Pure functions (no I/O); src/lib/pages/pagegate.ts loads the inputs, the smoke test
 * drives these directly.
 *
 * One call per part, all its dimensions in that call (the state is billed once). State (small and relevant, the hook
 * state's discipline):
 *   page      { site, headline }            the page's H1: context for the subheadline, the proof and the story
 *   part      { id, job, passes, fails }    one line each from skeleton.md, versioned with the page rubric
 *   section   { heading, text, ctas }       text clipped to PAGE_TEXT_CLIP characters
 *   channel   { section, brief, <client key> | brand | scope, notes, what_works_here }   exactly the copy gate's block
 *   whos_who  [lines]
 *   avatars   { slug: {person, pain, promise} }   the section's avatars from the current hook rubric
 *   voice     [verbatim market snippets]   optional, up to PAGE_VOICE_MAX, each clipped to PAGE_VOICE_CLIP
 * The channel / whos_who / avatars blocks come from the hook state builder (`pageContextState` in pagegate.ts), so a
 * page reads exactly the context the copy gate and the hook scorer read for the same code.
 * Arithmetic stays in code: levels (Jev's 0-based score + 1), the section score (mean), why (level <= 2), unsure (the
 * hook rule: top two neighbouring levels under the threshold), the page and freight summaries.
 */
import type { JevAnswer, JevQuestion } from "../ai/jev";
import { hookAnswerUnsure } from "../hooks/score";
import { bandOf, levelOf, overallOf, type ScoreBand } from "../hooks/rubric";
import type { PagePart, PageRubric } from "./rubric";

/** Characters of a section's text Jev reads (the rest is cut, `scored_text_chars` says how many were read). */
export const PAGE_TEXT_CLIP = 1_500;
/** At most this many voice snippets ride along, each clipped to PAGE_VOICE_CLIP characters. */
export const PAGE_VOICE_MAX = 15;
export const PAGE_VOICE_CLIP = 300;

export type PageSectionInput = {
  id: string;
  part: string;
  heading: string | null;
  text: string;
  ctas: string[];
};

export type PageInfo = { site: string | null; headline: string | null };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What Jev reads of a section's text: trimmed, CRLF folded, clipped to PAGE_TEXT_CLIP. */
export function pageScoredText(text: string): string {
  return clip(text.replace(/\r\n?/g, "\n").trim(), PAGE_TEXT_CLIP);
}

/** The voice snippets the state carries (trimmed, blanks dropped, clipped), or null when there are none. */
export function pageVoice(voice: string[] | null | undefined): string[] | null {
  const v = (voice ?? []).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, PAGE_VOICE_MAX).map((s) => clip(s, PAGE_VOICE_CLIP));
  return v.length ? v : null;
}

/** The request side of the state (page + part + section): what a section's cache `key` hashes. */
export function pageRequestState(part: PagePart, page: PageInfo, section: PageSectionInput): Record<string, unknown> {
  return {
    page: { site: page.site, headline: page.headline },
    part: { id: part.id, job: part.job, passes: part.passes, fails: part.fails },
    section: { heading: section.heading, text: pageScoredText(section.text), ctas: section.ctas },
  };
}

/**
 * The full state for one part: the request side, then the channel context (`context` = the hook state's channel,
 * whos_who and avatars blocks for the code, built once per run) and the voice snippets.
 */
export function buildPageState(
  part: PagePart,
  page: PageInfo,
  section: PageSectionInput,
  context: Record<string, unknown>,
  voice: string[] | null,
): Record<string, unknown> {
  const state: Record<string, unknown> = { ...pageRequestState(part, page, section), ...context };
  if (voice?.length) state.voice = voice;
  return state;
}

/** One `score` question per dimension of the part, levels low to high. */
export function buildPageQuestions(part: PagePart): Record<string, JevQuestion> {
  return Object.fromEntries(part.dims.map((d) => [d.id, { type: "score", instructions: d.question, criteria: [...d.levels] } satisfies JevQuestion]));
}

export type PageSectionEvaluation = {
  /** Dimension id -> level 1..5 (one decimal). */
  levels: Record<string, number>;
  /** Mean of the levels (unrounded), null when none answered. */
  score: number | null;
  band: ScoreBand;
  /** Labels of the dimensions at level 2 or below (the copy gate's rule). */
  why: string[];
  unsure: string[];
};

/** Jev's answers for one part -> levels, the section score, band, why and unsure. */
export function evaluatePageSection(part: PagePart, full: Record<string, JevAnswer>, threshold: number): PageSectionEvaluation {
  const levels: Record<string, number> = {};
  const unsure: string[] = [];
  for (const d of part.dims) {
    const a = full[d.id];
    if (!a || typeof a.value !== "number") continue;
    levels[d.id] = levelOf(a.value);
    if (hookAnswerUnsure({ type: a.type, value: a.value, confidence: a.confidence, source: "jev", probabilities: a.probabilities }, threshold)) unsure.push(d.id);
  }
  const score = overallOf(Object.values(levels));
  const why = part.dims.filter((d) => typeof levels[d.id] === "number" && levels[d.id] <= 2).map((d) => d.label);
  return { levels, score, band: bandOf(score), why, unsure };
}

/** Two decimals for display; null stays null. */
export const round2 = (v: number | null) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * page_score = mean of every scored section's score; freight_score = mean over the freight parts only (the headline
 * complex + the offer section). Unscored (errored) sections are left out; null when nothing was scored.
 */
export function pageSummary(rubric: PageRubric, sections: { part: string; score: number | null }[]): { page_score: number | null; freight_score: number | null } {
  const freight = new Set(rubric.parts.filter((p) => p.freight).map((p) => p.id as string));
  const scored = sections.filter((s): s is { part: string; score: number } => typeof s.score === "number" && Number.isFinite(s.score));
  return {
    page_score: round2(overallOf(scored.map((s) => s.score))),
    freight_score: round2(overallOf(scored.filter((s) => freight.has(s.part)).map((s) => s.score))),
  };
}
