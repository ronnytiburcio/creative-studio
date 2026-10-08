/**
 * Plain text helpers shared by the copy doc import (copydoc.ts), the video hook text rule (video.ts) and the copy gate
 * (copygate.ts). Client safe.
 */

/** Abbreviations whose full stop does not end a sentence ("St. Albans", "Dr. Smith", "No. 1"). */
const ABBREV = /\b(?:St|Mt|Mr|Mrs|Ms|Dr|Jr|Sr|vs|etc|No)\.$/i;

/** End offsets of the sentences in `text`: each . ! ? run followed by whitespace or the end (abbreviations skipped). */
function* sentenceEnds(text: string): Generator<number> {
  const re = /[.!?]+(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (!ABBREV.test(text.slice(0, end))) yield end;
  }
}

/**
 * The first sentence (up to the first . ! ? followed by a space or the end; common abbreviations are skipped). A first
 * sentence under 4 words ("No demo.", "About 3 days.") is not a hook on its own, so the next sentence joins it.
 */
export function firstSentence(s: string): string {
  const text = s.trim();
  for (const end of sentenceEnds(text)) {
    const head = text.slice(0, end);
    if (head.split(/\s+/).length < 4 && end < text.length) continue;
    return head.trim();
  }
  return text;
}

/** The first `n` sentences (same sentence ends as firstSentence, punctuation kept, no short-sentence join), or all of it. */
export function firstSentences(s: string, n: number): string {
  const text = s.trim();
  let count = 0;
  for (const end of sentenceEnds(text)) if (++count === n) return text.slice(0, end);
  return text;
}
