/**
 * Hook scoring (Phase 4 C1 to C3): what Jev is asked about one hook and how the answers become a score. Pure functions
 * (no I/O); the worker's HookScoreQueue loads the inputs and writes the result, the smoke test drives these directly.
 *
 * One call per hook. State (small and relevant, TypeSafe's jev-1.13 guidance):
 *   hook      { text, kind }
 *   channel   { section, brief (the version's, `briefOf`), <client key> {name, who} (client hooks; the profile's
 *               `hooks.clientKey`), brand {name, who} (Lane C hooks), notes [lines]
 *               (client brand notes, Lane C's own notes or Lane A notes), what_works_here [lines] (client / Lane C hooks with
 *               items), scope (Lane B shared hooks) }
 *   whos_who  [lines]
 *   avatars   { <slug>: {person, pain, promise} }   (only the ones this hook may be matched to)
 *   video     { first_3_seconds, on_screen_text, spoken_opening }   (video hooks, slice 2; "none" when absent)
 * Questions: the applicable dimensions (score, 5 described levels), the Three P's (3 nouls), style (choice over the 9
 * copy mechanics + none), avatar (choice over the allowed avatars + none) and stops_scroll (noul).
 * Arithmetic stays in code: levels (Jev's 0-based score + 1), the overall mean, the Three P's rule, the unsure gate.
 */
import type { JevAnswer, JevQuestion } from "../ai/jev";
import { answerUnsure, OWNER_SOURCE, type StoredAnswer } from "../ai/classes";
import { briefOf, channelNoteParts, channelNotesFp, companyName, type ChannelNotes } from "./notes";
import { profile } from "../profile";
import type { VideoTextSource } from "./video";
import {
  avatarsFor,
  dimensionsFor,
  levelOf,
  NONE_AVATAR,
  overallOf,
  type HookKind,
  type RubricBriefs,
  type RubricContent,
} from "./rubric";

export type HookInput = ChannelNotes & {
  id: number;
  kind: HookKind;
  text: string;
  /**
   * Video hooks (slice 2): the description's opening line ("First 3 seconds", or "Early frame" when the proxy failed and
   * the poster stood in), its on-screen text line and the spoken opening; `textFrom` = where `text` came from.
   */
  video?: {
    firstSeconds: string | null;
    earlyFrame?: boolean;
    onScreenText: string | null;
    spokenOpening: string | null;
    textFrom?: VideoTextSource;
  } | null;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Is this a shared Lane B hook (no client)? Universal-only avatars are offered only then. */
export const isShared = (input: Pick<HookInput, "section" | "client">) => input.section === "fkbpros" && !input.client;

export function allowedAvatars(rubric: Pick<RubricContent, "avatars">, input: Pick<HookInput, "section" | "client">) {
  return avatarsFor(rubric, input.section, isShared(input));
}

function hookKindText(input: HookInput): string {
  if (input.kind === "text") return "text hook (an ad headline or opening line)";
  if (input.video?.textFrom === "opening") return "video hook with no words (hook.text describes its opening seconds)";
  return "video hook (the opening seconds of a video)";
}

/**
 * The state Jev reads for one hook, plus the fingerprint of the notes it carries (the Hooks tab's "notes changed" flag
 * compares it with `channelNotesFp` of the channel's current notes). `channel.brief` comes from the rubric version
 * (`briefOf`: its own brief since v3, else the legacy text), so pass the RubricVersion, not bare content, to score on it.
 */
export function buildHookState(
  rubric: RubricContent & { briefs?: RubricBriefs | null },
  input: HookInput,
): { state: Record<string, unknown>; notesFp: string } {
  const P = profile().hooks;
  const channel: Record<string, unknown> = {
    section: P.sections[input.section],
    brief: briefOf(rubric, input.section),
  };
  const parts = channelNoteParts(input);
  if (input.client) channel[P.clientKey] = { name: input.client.name, who: parts.hint || input.client.name };
  else if (input.section === "fkbpros") channel.scope = P.sharedScope;
  else if (input.section === "fkb") channel.brand = { name: companyName(), who: parts.hint || companyName() };
  if (parts.notes.length) channel.notes = parts.notes;
  if (parts.works.length) channel.what_works_here = parts.works;
  const state: Record<string, unknown> = {
    hook: { text: input.text, kind: hookKindText(input) },
    channel,
  };
  if (parts.whos.length) state.whos_who = parts.whos;
  state.avatars = Object.fromEntries(
    allowedAvatars(rubric, input).map((a) => [a.slug, { person: a.person, pain: a.pain, promise: a.promise }]),
  );
  if (input.kind === "video" && input.video) {
    const v: Record<string, string> = {};
    if (input.video.firstSeconds) {
      v.first_3_seconds = input.video.earlyFrame
        ? `Early frame (the first 3 seconds were not seen): ${clip(input.video.firstSeconds, 560)}`
        : clip(input.video.firstSeconds, 600);
    }
    v.on_screen_text = input.video.onScreenText ? clip(input.video.onScreenText, 600) : "none";
    v.spoken_opening = input.video.spokenOpening ? clip(input.video.spokenOpening, 600) : "none (no speech)";
    state.video = v;
  }
  return { state, notesFp: channelNotesFp(input) };
}

const noul = (instructions: string, yes: string, no: string): JevQuestion => ({ type: "noul", instructions, criteria: { true: yes, false: no } });

export function buildHookQuestions(rubric: RubricContent, input: HookInput): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {};
  for (const d of dimensionsFor(rubric, input.section, input.kind)) {
    q[d.id] = { type: "score", instructions: d.question, criteria: [...d.levels] };
  }
  const words = input.kind === "video" ? "the words in `hook.text`, `video.spoken_opening` and `video.on_screen_text` together" : "the words in `hook.text`";
  const pp = profile().hooks.pp;
  q.pp_person = noul(`Do ${words} clearly say who this is for, so one specific person would recognize themselves?`, pp.person.yes, pp.person.no);
  q.pp_pain = noul(`Do ${words} clearly state a specific problem the viewer has?`, pp.pain.yes, pp.pain.no);
  q.pp_promise = noul(`Do ${words} clearly state one specific outcome the viewer gets?`, pp.promise.yes, pp.promise.no);
  q.style = {
    type: "choice",
    instructions: `Which ONE copy mechanic do ${words} lean on most?`,
    criteria: Object.fromEntries(rubric.mechanics.map((m) => [m.id, `${m.label}: ${m.definition}`])),
  };
  const avatars = allowedAvatars(rubric, input);
  q.avatar = {
    type: "choice",
    instructions: `Which one person in \`avatars\` are ${words} written for?`,
    criteria: {
      ...Object.fromEntries(avatars.map((a) => [a.slug, `${a.label}: ${a.person}; pain: ${a.pain}.`])),
      [NONE_AVATAR]: "None of these people, or nobody in particular.",
    },
  };
  q.stops_scroll = noul(
    `Would ${words}, as the first thing someone sees or hears in a social feed, make that person stop scrolling?`,
    "Yes: it names the viewer's own situation, a striking number, a surprising claim or a pointed question that person would stop for.",
    "No: a slogan, a greeting, a statement about the company or generic words a scroller would pass.",
  );
  return q;
}

export type HookEvaluation = {
  answers: Record<string, StoredAnswer>;
  unsure: string[];
  /** Dimension id -> level 1..5 (one decimal). */
  levels: Record<string, number>;
  overall: number | null;
  pp: { pp_person: number | null; pp_pain: number | null; pp_promise: number | null };
  style: string | null;
  avatar: string | null;
  stopsScroll: number | null;
};

/**
 * Is one hook answer unsure? (the owner, 2026-09-30, slice 3.) A `score` answer (a rubric dimension) is unsure only when its
 * top two NEIGHBOURING levels together hold less than the threshold (a 5 level score that splits between 2 and 3 is a
 * clear "2 to 3", not a doubt); a score without level probabilities falls back to its confidence. Choice answers
 * (style, avatar) keep the classify gate (confidence under the threshold) and nouls (Three P's, stops_scroll) the
 * 0.25 to 0.75 band. Hooks only: classify's energy keeps its own rule.
 */
export function hookAnswerUnsure(a: Pick<StoredAnswer, "type" | "value" | "confidence" | "source" | "probabilities">, threshold: number): boolean {
  if (a.source === OWNER_SOURCE) return false;
  if (a.type === "score") {
    const probs = a.probabilities ?? {};
    const levels = Object.keys(probs)
      .map(Number)
      .filter((k) => Number.isInteger(k))
      .sort((x, y) => x - y);
    if (levels.length < 2) return (a.confidence ?? 0) < threshold;
    let best = 0;
    for (const k of levels) best = Math.max(best, (probs[String(k)] ?? 0) + (probs[String(k + 1)] ?? 0));
    return best < threshold;
  }
  return answerUnsure(a, threshold);
}

/** The unsure question ids of a stored answer set (the same rule the queue uses when it writes a score). */
export function hookUnsureIds(answers: Record<string, StoredAnswer>, threshold: number): string[] {
  return Object.entries(answers)
    .filter(([, a]) => hookAnswerUnsure(a, threshold))
    .map(([id]) => id);
}

/**
 * Jev's answers -> the stored score. Unsure = `hookAnswerUnsure` (neighbouring levels for scores, the classify gate for
 * choices, the noul band). Unsure answers are only marked (no Review queue for hooks).
 */
export function evaluateHook(rubric: RubricContent, input: HookInput, full: Record<string, JevAnswer>, threshold: number): HookEvaluation {
  const answers: Record<string, StoredAnswer> = {};
  const unsure: string[] = [];
  const levels: Record<string, number> = {};
  for (const [id, a] of Object.entries(full)) {
    const stored: StoredAnswer = { type: a.type, value: a.value, probabilities: a.probabilities, confidence: a.confidence, source: "jev" };
    answers[id] = stored;
    if (hookAnswerUnsure(stored, threshold)) unsure.push(id);
  }
  for (const d of dimensionsFor(rubric, input.section, input.kind)) {
    const a = full[d.id];
    if (a && typeof a.value === "number") levels[d.id] = levelOf(a.value);
  }
  const p = (id: string) => (full[id] && typeof full[id].value === "number" ? Number(full[id].value) : null);
  const choice = (id: string) => (full[id] && typeof full[id].value === "string" ? String(full[id].value) : null);
  return {
    answers,
    unsure,
    levels,
    overall: overallOf(Object.values(levels)),
    pp: { pp_person: p("pp_person"), pp_pain: p("pp_pain"), pp_promise: p("pp_promise") },
    style: choice("style"),
    avatar: choice("avatar"),
    stopsScroll: p("stops_scroll"),
  };
}

