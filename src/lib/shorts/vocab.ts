/**
 * Shorts board vocabulary (client safe: no node imports, no profile): the card statuses and layouts, and the hook words
 * rules the card UI shows (2 to 6 caps words, one optional `*...*` orange block). The moment checks that read the
 * business profile are src/lib/shorts/rules.ts (server only), which re-exports all of this.
 */

export const SHORT_STATUSES = ["idea", "cutting", "review", "ready", "posted"] as const;
export type ShortStatus = (typeof SHORT_STATUSES)[number];
export const SHORT_STATUS_LABEL: Record<ShortStatus, string> = {
  idea: "Idea",
  cutting: "Cutting",
  review: "Review",
  ready: "Ready to post",
  posted: "Posted",
};

/** The reel cut skill's layouts (step 4 + its Ep5 learnings: `stack` is the one that works on the OBS masters). */
export const SHORT_LAYOUTS = ["stack", "center", "blurfill", "pip"] as const;
export type ShortLayout = (typeof SHORT_LAYOUTS)[number];
export const SHORT_LAYOUT_LABEL: Record<ShortLayout, string> = {
  stack: "Stack",
  center: "Center",
  blurfill: "Blur fill",
  pip: "Picture in picture",
};
export const DEFAULT_LAYOUT: ShortLayout = "stack";

export const HOOK_WORDS_MIN = 2;
/** Phase 7 B5: the hook words are the reel's opening headline, 2 to 6 words (counted without the `*` marker). */
export const HOOK_WORDS_MAX = 6;
/** The orange block marker: the part between ONE `*...*` pair sits in the kit's orange block (the reel kit's open.md). */
export const HOOK_BLOCK_MARK = "*";
/**
 * The caps overlay text: upper case, single spaces, outer punctuation off; a `*...*` pair (the orange block) is kept
 * with the spaces inside it trimmed ("you paid for * this lead *" -> "YOU PAID FOR *THIS LEAD*").
 */
export function normalizeHookWords(s: string): string {
  let t = s
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/^["'“”‘’\s.,:;!?]+|["“”\s.,:;]+$/g, "")
    .trim()
    .toUpperCase();
  const parts = t.split(HOOK_BLOCK_MARK);
  if (parts.length === 3) {
    t = [parts[0].trim(), `${HOOK_BLOCK_MARK}${parts[1].trim()}${HOOK_BLOCK_MARK}`, parts[2].trim()].filter(Boolean).join(" ");
    t = t.replace(/^["'“”‘’\s.,:;!?]+|["“”\s.,:;]+$/g, "").trim();
  }
  return t;
}

/** The hook words without the block marker (what the copy rules and the word count read). */
export function hookWordsPlain(s: string): string {
  return s.split(HOOK_BLOCK_MARK).join(" ").replace(/\s+/g, " ").trim();
}

/** The hook words split around the orange block (client safe: the card shows the block part in orange). */
export function splitHookWords(s: string): { before: string; block: string; after: string } | null {
  const parts = s.split(HOOK_BLOCK_MARK);
  if (parts.length !== 3 || !parts[1].trim()) return null;
  return { before: parts[0].trim(), block: parts[1].trim(), after: parts[2].trim() };
}

export function hookWordCount(s: string): number {
  return hookWordsPlain(s).split(/\s+/).filter(Boolean).length;
}
