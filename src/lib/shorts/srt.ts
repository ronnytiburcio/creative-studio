/**
 * SRT cues and the moment time rules (Phase 6 A1 / B2), pure and client safe (no node imports).
 *
 * Cues come from the episode prep skill's whisper SRT: long cues (5 to 30 s) whose sentences often run across cue boundaries.
 * A moment's start / end are snapped to cue boundaries (the reel cut skill's step 2) and padded 0.2 s each side, clamped to the
 * episode. A cue "starts a sentence" when it is the first cue or the cue before it ends on . ! ? (a closing quote or
 * bracket allowed); it "ends a sentence" when its own text does.
 */

/** [start s, end s, text]: the compact form stored in `episodes.cues`. */
export type Cue = { start: number; end: number; text: string };

export const MOMENT_PAD_S = 0.2;
/** A model's start may land up to this far before a cue start and still mean that cue (it rounds times). */
export const SNAP_TOLERANCE_S = 0.5;
export const MOMENT_MIN_S = 30;
export const MOMENT_MAX_S = 90;
/** What the prompt asks for (the 30 to 90 s code check is the hard rule). */
export const MOMENT_TARGET_MAX_S = 60;

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function seconds(m: RegExpMatchArray): number {
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

/**
 * SRT text -> cues, sorted by start. Tolerates a BOM, CRLF / CR line ends, missing index lines, `.` as the millisecond
 * separator, multi-line cue text (joined with a space), formatting tags and blank-text cues (dropped).
 */
export function parseSrt(raw: string): Cue[] {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues: Cue[] = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const ma = a?.match(TIME);
    const mb = b?.match(TIME);
    if (!ma || !mb) continue;
    const start = seconds(ma);
    const end = seconds(mb);
    if (!(end > start)) continue;
    const body = lines
      .slice(at + 1)
      .join(" ")
      .replace(/<[^>]{1,40}>/g, "")
      .replace(/\{\\[^}]{0,40}\}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    cues.push({ start: round3(start), end: round3(end), text: body });
  }
  return cues.sort((x, y) => x.start - y.start || x.end - y.end);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cues as stored ([[s, e, t], ...]) <-> objects. */
export function packCues(cues: Cue[]): string {
  return JSON.stringify(cues.map((c) => [c.start, c.end, c.text]));
}
export function unpackCues(json: string | null | undefined): Cue[] {
  if (!json) return [];
  try {
    const rows = JSON.parse(json) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r): r is [number, number, string] => Array.isArray(r) && typeof r[0] === "number" && typeof r[1] === "number" && typeof r[2] === "string")
      .map(([start, end, text]) => ({ start, end, text }));
  } catch {
    return [];
  }
}

const ENDS_SENTENCE = /[.!?]["'”’)\]]*$/;

export function endsSentence(c: Cue): boolean {
  return ENDS_SENTENCE.test(c.text.trim());
}
export function startsSentence(cues: Cue[], i: number): boolean {
  return i === 0 || (i > 0 && endsSentence(cues[i - 1]));
}

/** The last cue that ends at or before the episode: the episode's speech end. */
export function cuesEnd(cues: Cue[]): number {
  return cues.length ? cues[cues.length - 1].end : 0;
}

/**
 * Start snap: the cue whose start is at or just before `t` (a cue starting within SNAP_TOLERANCE_S after `t` wins, so
 * 120.0 means the cue at 120.3, not the one at 112). -1 when there are no cues.
 */
export function startCueIndex(cues: Cue[], t: number): number {
  if (!cues.length) return -1;
  let best = 0;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].start <= t + SNAP_TOLERANCE_S) best = i;
    else break;
  }
  return best;
}

/** End snap: the cue whose end is at or just after `t` (a cue ending within SNAP_TOLERANCE_S before `t` wins). */
export function endCueIndex(cues: Cue[], t: number): number {
  if (!cues.length) return -1;
  for (let i = 0; i < cues.length; i++) if (cues[i].end >= t - SNAP_TOLERANCE_S) return i;
  return cues.length - 1;
}

export type Snapped = { startCue: number; endCue: number; start: number; end: number; duration: number };

/** Cue indices -> padded times (0.2 s each side, clamped to [0, episodeEnd]). */
export function padCues(cues: Cue[], startCue: number, endCue: number, episodeEnd: number): Snapped {
  const start = round2(Math.max(0, cues[startCue].start - MOMENT_PAD_S));
  const end = round2(Math.min(Math.max(episodeEnd, cues[endCue].end), cues[endCue].end + MOMENT_PAD_S));
  return { startCue, endCue, start, end, duration: round2(end - start) };
}

/** Snap a proposed [start, end] to cue boundaries + pad. null when there are no cues or the snap inverts. */
export function snapMoment(cues: Cue[], start: number, end: number, episodeEnd: number): Snapped | null {
  const a = startCueIndex(cues, start);
  const b = endCueIndex(cues, end);
  if (a < 0 || b < 0 || b < a) return null;
  return padCues(cues, a, b, episodeEnd);
}

/**
 * A stored moment's cue indices (the inverse of padCues): the cue whose start sits at start + pad, the cue whose end
 * sits at end - pad (nearest, so an edited SRT still lands somewhere sensible).
 */
export function cuesOfMoment(cues: Cue[], start: number, end: number): { startCue: number; endCue: number } | null {
  if (!cues.length) return null;
  let a = 0;
  let b = 0;
  for (let i = 0; i < cues.length; i++) {
    if (Math.abs(cues[i].start - (start + MOMENT_PAD_S)) < Math.abs(cues[a].start - (start + MOMENT_PAD_S))) a = i;
    if (Math.abs(cues[i].end - (end - MOMENT_PAD_S)) < Math.abs(cues[b].end - (end - MOMENT_PAD_S))) b = i;
  }
  return b >= a ? { startCue: a, endCue: b } : null;
}

/** Overlap of two ranges as a share of the shorter one (0..1). */
export function overlapShare(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return ov > 0 && shorter > 0 ? ov / shorter : 0;
}
export const OVERLAP_MAX = 0.5;

/** Whisper's fillers ("uh,", "um") out of a first line; the words are otherwise the owner's as transcribed. */
export function cleanSpoken(s: string): string {
  return s
    .replace(/(^|[\s,])(?:uh+|um+|erm|uhm)(?=[\s,.!?]|$),?/gi, "$1")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/^[\s,]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "04:12" / "1:04:12" */
export function fmtClock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
