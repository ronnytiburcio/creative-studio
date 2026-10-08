/**
 * Word-timed transcripts (Phase 6 slice 2, the owner's decision, 2026-10-01), pure and client safe (no node imports).
 *
 * The worker runs the local whisper-cli over an episode master's CACHED proxy (never the drive) with one word per segment
 * (`-ml 1 -sow -oj`), and stores the words as whisper wrote them (`episodes.words`). Everything else happens here at read
 * time, so a change to the fixes or the split never needs a new transcription:
 *   - parseWhisperWords(): whisper's JSON -> words (empty segments dropped, times in seconds);
 *   - fixWords(): the episode prep's proper-noun replacements (the profile's list, properNounFixes), multi-word ones merged
 *     into one word that spans their time;
 *   - sentencesOf(): words -> sentences (a word ending on . ! ? ends one, common abbreviations excepted; a pause of 0.8 s
 *     or more between two words also ends one), start = the first word's start, end = the last word's end.
 * Moments snap to these sentences (src/lib/shorts/rules.ts) instead of the SRT's long cues, so a moment can begin on any
 * sentence. The episode-prep SRT still decides whether an episode is prepped (Studio never writes it).
 */
import type { Cue } from "./srt";
import { profile } from "../profile";

/** Bump when the whisper call or the stored shape changes: every episode is then due again. */
export const WORDS_VERSION = 1;
/** A pause this long between two words ends a sentence even without punctuation. */
export const SENTENCE_PAUSE_S = 0.8;

export type Word = { start: number; end: number; text: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** whisper-cli `-oj` output (transcription[].offsets in ms, text with a leading space) -> words. Throws on a bad shape. */
export function parseWhisperWords(json: string): Word[] {
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    throw new Error("whisper wrote no JSON");
  }
  const list = (body as { transcription?: unknown }).transcription;
  if (!Array.isArray(list)) throw new Error("whisper's JSON has no transcription list");
  const out: Word[] = [];
  for (const seg of list) {
    const o = (seg ?? {}) as { offsets?: { from?: unknown; to?: unknown }; text?: unknown };
    const text = typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim() : "";
    const from = Number(o.offsets?.from);
    const to = Number(o.offsets?.to);
    if (!text || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    // Non-speech tags whisper sometimes still prints ("[BLANK_AUDIO]", "(music)").
    if (/^[[(*♪].*[\])*♪]$/.test(text)) continue;
    out.push({ start: round2(from / 1000), end: round2(Math.max(from, to) / 1000), text });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function packWords(words: Word[]): string {
  return JSON.stringify(words.map((w) => [w.start, w.end, w.text]));
}

export function unpackWords(json: string | null | undefined): Word[] {
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

/**
 * The episode prep's proper-noun pass (the "known whisper misses"), word by word: the business profile's
 * `transcripts.properNounFixes` (Creative Studio slice 1c; server only). `from` = the spoken words in lower case without
 * punctuation; `to` = what replaces them. Kept as ONE list: change it in the profile only.
 */
export function properNounFixes(): { from: string[]; to: string }[] {
  return profile().transcripts.properNounFixes;
}

const LEAD = /^["'“‘(\[]+/;
const TRAIL = /["'”’)\].,!?;:…]+$/;

/** A word's core for matching: lower case, outer punctuation off, a possessive 's kept apart. */
function core(text: string): { core: string; possessive: boolean } {
  let c = text.toLowerCase().replace(LEAD, "").replace(TRAIL, "");
  const possessive = /['’]s$/.test(c);
  if (possessive) c = c.replace(/['’]s$/, "");
  return { core: c, possessive };
}

/** The proper-noun fixes applied (see properNounFixes). A merged word spans its parts' time and keeps the last one's punctuation. */
export function fixWords(words: Word[]): Word[] {
  const out: Word[] = [];
  const cores = words.map((w) => core(w.text));
  for (let i = 0; i < words.length; ) {
    let hit: { n: number; to: string } | null = null;
    for (const f of properNounFixes()) {
      const n = f.from.length;
      if (i + n > words.length) continue;
      let ok = true;
      for (let j = 0; j < n; j++) {
        const c = cores[i + j];
        // A possessive only on the last word ("Ronnie's"); inner words must be plain.
        if (c.core !== f.from[j] || (c.possessive && j < n - 1)) {
          ok = false;
          break;
        }
      }
      if (ok && (!hit || n > hit.n)) hit = { n, to: f.to };
    }
    if (!hit) {
      out.push(words[i]);
      i++;
      continue;
    }
    const first = words[i];
    const last = words[i + hit.n - 1];
    const lead = first.text.match(LEAD)?.[0] ?? "";
    const trail = last.text.match(TRAIL)?.[0] ?? "";
    let to = hit.to;
    // Keep a capital at a sentence start ("Steel glue" -> "Steel blue").
    if (/^[a-z]/.test(to) && /^[A-Z]/.test(first.text.replace(LEAD, ""))) to = to[0].toUpperCase() + to.slice(1);
    const poss = cores[i + hit.n - 1].possessive ? "'s" : "";
    out.push({ start: first.start, end: last.end, text: `${lead}${to}${poss}${trail}` });
    i += hit.n;
  }
  return out;
}

/** Abbreviations whose full stop does not end a sentence (the same list as hooks/text.ts). */
const ABBREV = /^(?:St|Mt|Mr|Mrs|Ms|Dr|Jr|Sr|vs|etc|No)\.$/i;
const ENDS = /[.!?]["'”’)\]]*$/;

/** Does this word end a sentence? (. ! ? at its end, an abbreviation or a lone initial excepted). */
export function wordEndsSentence(text: string): boolean {
  const t = text.trim();
  if (!ENDS.test(t)) return false;
  const bare = t.replace(/["'”’)\]]+$/, "");
  if (ABBREV.test(bare) || /^[A-Z]\.$/.test(bare)) return false;
  return true;
}

/**
 * Words -> sentences as Cue objects (start, end, text): a sentence ends on a word that ends one, or before a pause of
 * SENTENCE_PAUSE_S or more. The words are joined with single spaces as spoken (fillers stay; the first line drops them).
 */
export function sentencesOf(words: Word[]): Cue[] {
  const out: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].start, end: Math.max(...cur.map((w) => w.end)), text: cur.map((w) => w.text).join(" ") });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const next = words[i + 1];
    if (wordEndsSentence(w.text) || (next && next.start - w.end >= SENTENCE_PAUSE_S)) flush();
  }
  flush();
  return out;
}

/** Matching key of a word: lower case letters and digits only ("I'd," -> "id"). */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Index pairs [i in a, j in b] of a longest common subsequence of two short key lists. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] && a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** Whisper words a cue may match: those overlapping the cue widened by this much each side. */
const ALIGN_SLACK_S = 1.5;
/** Below this share of matched SRT words the alignment is not trusted (whisper's words are used instead). */
export const ALIGN_MIN_SHARE = 0.6;

/**
 * The SRT's words with whisper's times (see the module comment). `matched` = SRT words that got a whisper word's time;
 * `total` = all SRT words.
 */
export function alignToSrt(cues: Cue[], words: Word[]): { words: Word[]; matched: number; total: number } {
  const out: Word[] = [];
  let matched = 0;
  let ptr = 0;
  for (const c of cues) {
    const toks = c.text.split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    let a = ptr;
    while (a < words.length && words[a].end < c.start - ALIGN_SLACK_S) a++;
    let b = a;
    while (b < words.length && words[b].start < c.end + ALIGN_SLACK_S) b++;
    const pairs = lcsPairs(
      toks.map(norm),
      words.slice(a, b).map((w) => norm(w.text)),
    );
    const times: ({ start: number; end: number } | null)[] = toks.map(() => null);
    for (const [i, j] of pairs) times[i] = { start: words[a + j].start, end: words[a + j].end };
    matched += pairs.length;
    if (pairs.length) ptr = a + pairs[pairs.length - 1][1] + 1;
    // Unmatched runs: spread evenly between the matched neighbours (or the cue's own edges).
    for (let i = 0; i < toks.length; ) {
      if (times[i]) {
        i++;
        continue;
      }
      let k = i;
      while (k < toks.length && !times[k]) k++;
      const left = i > 0 ? times[i - 1]!.end : c.start;
      const right = k < toks.length ? times[k]!.start : c.end;
      const lo = Math.min(left, right);
      const step = Math.max(0, right - lo) / (k - i);
      for (let x = i; x < k; x++) times[x] = { start: lo + step * (x - i), end: lo + step * (x - i + 1) };
      i = k;
    }
    toks.forEach((t, i) => {
      const prevEnd = out.length ? out[out.length - 1].end : 0;
      const start = Math.max(times[i]!.start, prevEnd);
      out.push({ start: round2(start), end: round2(Math.max(start, times[i]!.end)), text: t });
    });
  }
  return { words: out, matched, total: out.length };
}

export type EpisodeSentences = { sentences: Cue[]; source: "srt" | "whisper"; aligned: number };

/**
 * The sentences moments snap to: the SRT's text on whisper's times when the alignment holds (>= 60% of the SRT's words
 * matched), else whisper's own words; the proper-noun fixes applied either way. Empty when there are no words.
 */
export function episodeSentences(cues: Cue[], stored: string | Word[] | null | undefined): EpisodeSentences {
  const ws = Array.isArray(stored) ? stored : unpackWords(stored);
  if (!ws.length) return { sentences: [], source: "whisper", aligned: 0 };
  if (cues.length) {
    const al = alignToSrt(cues, ws);
    const share = al.total ? al.matched / al.total : 0;
    if (share >= ALIGN_MIN_SHARE) return { sentences: sentencesOf(fixWords(al.words)), source: "srt", aligned: share };
    return { sentences: sentencesOf(fixWords(ws)), source: "whisper", aligned: share };
  }
  return { sentences: sentencesOf(fixWords(ws)), source: "whisper", aligned: 0 };
}

/** Stored words alone (no SRT) -> sentences (fixes applied first). */
export function sentencesFromStored(json: string | null | undefined): Cue[] {
  return sentencesOf(fixWords(unpackWords(json)));
}
