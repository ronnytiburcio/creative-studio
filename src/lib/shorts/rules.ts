/**
 * The moment checks (Phase 6 B2 / C1), server only: they read the business profile's copy rules. The board vocabulary
 * (statuses, layouts, hook words) is src/lib/shorts/vocab.ts (client safe) and re-exported here.
 *
 * checkMoment() is the gate every `claude -p` candidate passes before it becomes a card: inside the episode, snapped to
 * unit boundaries + 0.2 s pad (src/lib/shorts/srt.ts; units = the word-timed transcript's sentences since slice 2, the
 * SRT cues before: then the start cue must begin a sentence and the end cue end one), 30 to 90 s after the snap, no profanity in the first 3 s, `first_line` replaced by the transcript's own
 * first sentence at the start, the caps hook 2 to 6 words (Phase 7: the reel's opening headline, one optional `*...*`
 * orange block) under Lane A's copy rules (no dash or hyphen at all, no AI tell, no client name or code, no US state), no
 * dash used as punctuation and no AI tell in the first line or the why, and no near duplicate (>= 50% of the shorter clip
 * shared with a live card of the episode or an earlier survivor). Phase 7 B1: then the moment's cold open
 * (checkColdOpen: one or two whole adjacent sentences inside it, 2 to 6 s after the pad, no profanity, no dash / AI tell);
 * a bad cold open drops only the cold open, never the moment.
 */
import { firstSentence } from "../hooks/text";
import { aiTellIn, checkVariant, compileVariantRules, dashProblem, type VariantRuleContext } from "../hooks/variant-rules";
import { houseRulesFor, profile } from "../profile";
import {
  cleanSpoken,
  cuesEnd,
  endsSentence,
  MOMENT_MAX_S,
  MOMENT_MIN_S,
  OVERLAP_MAX,
  overlapShare,
  round2,
  snapMoment,
  startsSentence,
  type Cue,
} from "./srt";
import {
  DEFAULT_LAYOUT,
  HOOK_BLOCK_MARK,
  HOOK_WORDS_MAX,
  HOOK_WORDS_MIN,
  hookWordCount,
  hookWordsPlain,
  normalizeHookWords,
  SHORT_LAYOUTS,
  splitHookWords,
  type ShortLayout,
} from "./vocab";

export {
  DEFAULT_LAYOUT,
  HOOK_BLOCK_MARK,
  HOOK_WORDS_MAX,
  HOOK_WORDS_MIN,
  hookWordCount,
  hookWordsPlain,
  normalizeHookWords,
  SHORT_LAYOUT_LABEL,
  SHORT_LAYOUTS,
  SHORT_STATUS_LABEL,
  SHORT_STATUSES,
  splitHookWords,
  type ShortLayout,
  type ShortStatus,
} from "./vocab";

export const WHY_MAX = 400;
export const FIRST_LINE_MAX = 220;
/** A job proposes 5 to 8; at most this many cards per job. */
export const MOMENTS_MAX = 8;
/** Fewer survivors than this = one retry of the whole call. */
export const MOMENTS_MIN_SURVIVORS = 3;

const PROFANITY = /\b(fuck\w*|shit\w*|bitch\w*|asshole\w*|bastard\w*|dick\w*|piss\w*|goddamn\w*|damn\w*|cunt\w*|motherf\w*)\b/i;

/** The words spoken in the first `s` seconds (cue text spread evenly over its time). */
export function spokenWithin(cues: Cue[], startCue: number, from: number, s: number): string {
  const out: string[] = [];
  for (let i = startCue; i < cues.length && cues[i].start < from + s; i++) {
    const c = cues[i];
    const words = c.text.split(/\s+/).filter(Boolean);
    const dur = Math.max(0.1, c.end - c.start);
    const a = Math.max(0, (from - c.start) / dur);
    const b = Math.min(1, (from + s - c.start) / dur);
    const i0 = Math.floor(a * words.length);
    const i1 = Math.ceil(b * words.length);
    out.push(...words.slice(i0, Math.max(i0 + 1, i1)));
  }
  return out.join(" ");
}

/**
 * Lane A's copy rules for the overlay (the same compiled rules as Lane A hook variants, read on the text without `*`), the
 * 2 to 6 word rule and the block marker rule (no `*`, or exactly one pair around at least one word).
 */
export function checkHookWords(words: string, rules: ReturnType<typeof compileVariantRules>): string | null {
  const stars = words.split(HOOK_BLOCK_MARK).length - 1;
  if (stars !== 0 && stars !== 2) return "hook: mark the orange block with ONE pair of * (at most one block)";
  if (stars === 2 && !splitHookWords(words)) return "hook: the * pair marks no words";
  const n = hookWordCount(words);
  if (n < HOOK_WORDS_MIN || n > HOOK_WORDS_MAX) return `hook is ${n} word${n === 1 ? "" : "s"} (${HOOK_WORDS_MIN} to ${HOOK_WORDS_MAX})`;
  // A fresh dedupe set: two cards may share an overlay.
  const v = checkVariant(hookWordsPlain(words), rules, new Set());
  return v.ok ? null : `hook: ${v.detail}`;
}

/** Lane A's compiled copy rules (house rules from the active profile; no dedupe against hooks: an overlay is not a hook row). */
export function overlayRules(allClients: VariantRuleContext["allClients"]) {
  return compileVariantRules({ section: "rtm", client: null, allClients, existingNorms: new Set(), house: houseRulesFor("rtm") });
}

/**
 * The prose rules for a first line, a why and a cold open (spoken words): the profile's `copyRules.dashes.prose` policy
 * (server only) and AI tells.
 */
export function proseProblem(text: string, what: string): string | null {
  const d = dashProblem(text, profile().copyRules.dashes.prose);
  if (d) return `${what}: ${d}`;
  const tell = aiTellIn(text);
  return tell ? `${what}: AI tell "${tell}"` : null;
}

/**
 * What a moment snaps to: `sentence` = the word-timed transcript's sentences (slice 2: every unit starts and ends a
 * sentence), `cue` = the episode-prep SRT's cues (slice 1; only cues marked S / E qualify).
 */
export type MomentUnit = "sentence" | "cue";

/**
 * The transcript's first sentence at the start (fillers out), capped at a word boundary. With sentences it is the start
 * sentence itself (a sentence under 4 words, like "Okay.", joins the next one, as firstSentence does); with cues it is the
 * first sentence of the start cue's text.
 */
export function firstLineAt(cues: Cue[], startCue: number, endCue: number, unit: MomentUnit = "cue"): string {
  let line: string;
  if (unit === "sentence") {
    const parts: string[] = [];
    for (let i = startCue; i <= endCue; i++) {
      const t = cleanSpoken(cues[i].text);
      if (t) parts.push(t);
      if (parts.join(" ").split(/\s+/).filter(Boolean).length >= 4) break;
    }
    line = parts.join(" ");
  } else {
    const text = cleanSpoken(
      cues
        .slice(startCue, endCue + 1)
        .map((c) => c.text)
        .join(" "),
    );
    line = firstSentence(text);
  }
  if (line.length > FIRST_LINE_MAX) {
    const cut = line.slice(0, FIRST_LINE_MAX);
    line = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,;:]$/, "")}…`;
  }
  return line ? line[0].toUpperCase() + line.slice(1) : line;
}

export type RawMoment = {
  start: number;
  end: number;
  firstLine: string;
  hook: string;
  why: string;
  layout: string;
  /** Phase 7 B1: claude's cold open (NaN when it gave none). */
  coldStart?: number;
  coldEnd?: number;
};
export type CheckedMoment = {
  start: number;
  end: number;
  startCue: number;
  endCue: number;
  firstLine: string;
  hookWords: string;
  why: string;
  layout: ShortLayout;
  /** The checked cold open, or null (none proposed, or it broke a rule: `coldDropped` says which). */
  cold: ColdOpen | null;
  coldDropped: { rule: string; detail: string } | null;
};
export type MomentVerdict = { ok: true; moment: CheckedMoment } | { ok: false; rule: string; detail: string };

export type MomentCheckContext = {
  cues: Cue[];
  /** The master's duration (else the last cue's end). */
  episodeEnd: number;
  /** Live (not archived) cards of the episode + the survivors so far. */
  taken: { start: number; end: number }[];
  overlay: ReturnType<typeof compileVariantRules>;
  /** What `cues` holds (default `cue`, slice 1). Sentences need no S / E check: each one starts and ends a sentence. */
  unit?: MomentUnit;
};

/** One candidate through every code rule (see the module comment). */
export function checkMoment(m: RawMoment, ctx: MomentCheckContext): MomentVerdict {
  const fail = (rule: string, detail: string): MomentVerdict => ({ ok: false, rule, detail });
  const { cues } = ctx;
  if (!cues.length) return fail("transcript", "the transcript has no cues");
  const end = Math.max(ctx.episodeEnd, cuesEnd(cues));
  if (!Number.isFinite(m.start) || !Number.isFinite(m.end) || m.end <= m.start) return fail("times", "start / end are not a time range");
  if (m.start < 0 || m.end > end + 1) return fail("outside", `outside the episode (0 to ${round2(end)} s)`);
  const snap = snapMoment(cues, m.start, m.end, end);
  if (!snap) return fail("times", "start / end do not land on the transcript");
  const unit = ctx.unit ?? "cue";
  if (unit === "cue" && !startsSentence(cues, snap.startCue)) return fail("start", `starts mid sentence (cue ${snap.startCue + 1})`);
  if (unit === "cue" && !endsSentence(cues[snap.endCue])) return fail("end", `ends mid sentence (cue ${snap.endCue + 1})`);
  if (snap.duration < MOMENT_MIN_S || snap.duration > MOMENT_MAX_S) {
    return fail("length", `${Math.round(snap.duration)} s after snapping (${MOMENT_MIN_S} to ${MOMENT_MAX_S})`);
  }
  if (PROFANITY.test(spokenWithin(cues, snap.startCue, cues[snap.startCue].start, 3))) return fail("profanity", "profanity in the first 3 seconds");
  const firstLine = firstLineAt(cues, snap.startCue, snap.endCue, unit);
  if (!firstLine) return fail("first_line", "no words at the start");
  const hookWords = normalizeHookWords(m.hook ?? "");
  const hookProblem = checkHookWords(hookWords, ctx.overlay);
  if (hookProblem) return fail("hook", hookProblem);
  const why = (m.why ?? "").replace(/\s+/g, " ").trim().slice(0, WHY_MAX);
  const prose = proseProblem(firstLine, "first line") ?? proseProblem(why, "why");
  if (prose) return fail("copy", prose);
  const range = { start: snap.start, end: snap.end };
  const clash = ctx.taken.find((t) => overlapShare(t, range) >= OVERLAP_MAX);
  if (clash) return fail("overlap", `shares half or more with ${Math.round(clash.start)} to ${Math.round(clash.end)} s`);
  const layout = (SHORT_LAYOUTS as readonly string[]).includes(m.layout) ? (m.layout as ShortLayout) : DEFAULT_LAYOUT;
  // A bad cold open drops only the cold open: the moment survives without one (Phase 7 B1).
  let cold: ColdOpen | null = null;
  let coldDropped: { rule: string; detail: string } | null = null;
  if (m.coldStart == null || m.coldEnd == null || !Number.isFinite(m.coldStart) || !Number.isFinite(m.coldEnd)) {
    coldDropped = { rule: "cold_missing", detail: "no cold open proposed" };
  } else {
    const cv = checkColdOpen({ start: m.coldStart, end: m.coldEnd }, { units: cues, episodeEnd: end, moment: { startCue: snap.startCue, endCue: snap.endCue } });
    if (cv.ok) cold = cv.cold;
    else coldDropped = { rule: cv.rule, detail: cv.detail };
  }
  return {
    ok: true,
    moment: { start: snap.start, end: snap.end, startCue: snap.startCue, endCue: snap.endCue, firstLine, hookWords, why, layout, cold, coldDropped },
  };
}

// ------------------------------------------------------------------------------------------------ cold open (Phase 7 B1)

/** The cold open: one or two whole adjacent sentences inside the moment, 2 to 6 s after the 0.2 s pad. */
export const COLD_MIN_S = 2;
export const COLD_MAX_S = 6;
export const COLD_MAX_UNITS = 2;
export const COLD_TEXT_MAX = 220;

/**
 * Words a cold open may not start on (the owner 2026-10-01: the cold open is heard first, with no context, so it never opens
 * on a connector or a filler).
 */
export const COLD_BAD_FIRST_WORDS = [
  "so", "but", "and", "because", "or", "then", "like", "okay", "ok", "yeah", "um", "uh", "well", "now", "right", "alright", "also", "plus",
] as const;

/** The cold open's first word when it is a connector / filler, else null. */
export function coldOpenerProblem(text: string): string | null {
  const first = (text.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z']/g, "");
  return (COLD_BAD_FIRST_WORDS as readonly string[]).includes(first) ? first : null;
}

export type ColdOpen = { start: number; end: number; startUnit: number; endUnit: number; text: string };
export type ColdVerdict = { ok: true; cold: ColdOpen } | { ok: false; rule: string; detail: string };

/**
 * A proposed cold open (claude's `cold_start` / `cold_end`, or the picker's sentence times) through the code rules:
 * snapped to unit boundaries + 0.2 s pad like a moment, inside the moment's units, at most two adjacent units, 2 to 6 s,
 * no connector / filler as its first word (COLD_BAD_FIRST_WORDS, the owner 2026-10-01), no profanity, no dash used as
 * punctuation and no AI tell in its text. The text is the transcript's own.
 */
export function checkColdOpen(
  raw: { start: number; end: number },
  ctx: { units: Cue[]; episodeEnd: number; moment: { startCue: number; endCue: number } },
): ColdVerdict {
  const fail = (rule: string, detail: string): ColdVerdict => ({ ok: false, rule, detail });
  const { units } = ctx;
  if (!units.length) return fail("transcript", "the transcript has no sentences");
  if (!Number.isFinite(raw.start) || !Number.isFinite(raw.end) || raw.end <= raw.start) return fail("cold_times", "cold open start / end are not a time range");
  const snap = snapMoment(units, raw.start, raw.end, Math.max(ctx.episodeEnd, cuesEnd(units)));
  if (!snap) return fail("cold_times", "cold open start / end do not land on the transcript");
  if (snap.startCue < ctx.moment.startCue || snap.endCue > ctx.moment.endCue) return fail("cold_outside", "cold open is outside the moment");
  const n = snap.endCue - snap.startCue + 1;
  if (n > COLD_MAX_UNITS) return fail("cold_units", `cold open is ${n} sentences (one or two)`);
  if (snap.duration < COLD_MIN_S || snap.duration > COLD_MAX_S) {
    return fail("cold_length", `cold open is ${snap.duration.toFixed(2)} s after snapping (${COLD_MIN_S} to ${COLD_MAX_S})`);
  }
  let text = cleanSpoken(
    units
      .slice(snap.startCue, snap.endCue + 1)
      .map((u) => u.text)
      .join(" "),
  );
  if (!text) return fail("cold_text", "no words in the cold open");
  if (text.length > COLD_TEXT_MAX) text = `${text.slice(0, COLD_TEXT_MAX - 1).trimEnd()}…`;
  text = text[0].toUpperCase() + text.slice(1);
  const opener = coldOpenerProblem(text);
  if (opener) return fail("cold_opener", `cold open starts on "${opener}" (a connector or filler: it needs context)`);
  if (PROFANITY.test(text)) return fail("cold_profanity", "profanity in the cold open");
  const prose = proseProblem(text, "cold open");
  if (prose) return fail("cold_copy", prose);
  return { ok: true, cold: { start: snap.start, end: snap.end, startUnit: snap.startCue, endUnit: snap.endCue, text } };
}
