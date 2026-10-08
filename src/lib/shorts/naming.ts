/**
 * Lane A episode file names (Creative Studio slice 1d; server only). The episode prep and reel skills name their files
 * `<prefix>N.srt`, `<prefix>N reels.json`, `<prefix>N Reel K[ vN].mp4` and `<prefix>N Reel K caption.md`; the prefix is
 * the business profile's `episodes.prefix` (neutral "Episode "). Every function takes the prefix explicitly or reads
 * the active profile, so the original install's names stay exactly as its skills write them.
 */
import { profile } from "../profile";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The active profile's episode file prefix. */
export function episodePrefix(): string {
  return profile().episodes.prefix;
}

/** `<prefix>7` (the stem of the episode's SRT, the `episode` of a reel list). */
export function episodeStem(num: number, prefix = episodePrefix()): string {
  return `${prefix}${num}`;
}

/** `<prefix>N.srt` -> N (the prepped transcript; nothing else in the folder matches). */
export function episodeSrtRe(prefix = episodePrefix()): RegExp {
  return new RegExp(`^${escapeRe(prefix)}(\\d{1,4})\\.srt$`);
}

/** `<prefix>N reels.json`: the reel list the reel skill keeps in the episode folder (or a sibling). */
export function reelsListName(num: number, prefix = episodePrefix()): string {
  return `${episodeStem(num, prefix)} reels.json`;
}

/** Studio's hand-off list names: `<prefix>N reels[ yyyy-mm-dd-hhmm[-n]].json`. */
export function handoffNameRe(prefix = episodePrefix()): RegExp {
  return new RegExp(`^${escapeRe(prefix)}\\d{1,4} reels(?: \\d{4}-\\d{2}-\\d{2}-\\d{4}(?:-\\d{1,2})?)?\\.json$`);
}

/** Reel K of episode N: `<prefix>N Reel K.mp4` / `<prefix>N Reel K vV.mp4` (case-insensitive). */
export function reelFileRes(num: number, k: number, prefix = episodePrefix()): { plain: RegExp; versioned: RegExp } {
  const stem = escapeRe(episodeStem(num, prefix));
  return { plain: new RegExp(`^${stem} Reel ${k}\\.mp4$`, "i"), versioned: new RegExp(`^${stem} Reel ${k} v(\\d{1,3})\\.mp4$`, "i") };
}

/** Any reel number of episode N: `<prefix>N Reel K...` (case-insensitive). */
export function reelNumberRe(num: number, prefix = episodePrefix()): RegExp {
  return new RegExp(`^${escapeRe(episodeStem(num, prefix))} Reel (\\d{1,4})`, "i");
}

/** `<prefix>N Reel K caption.md`. */
export function captionName(num: number, k: number, prefix = episodePrefix()): string {
  return `${episodeStem(num, prefix)} Reel ${k} caption.md`;
}

/** What the hand-off wording reads from the active profile (src/lib/shorts/handoff-text.ts). */
export function handoffNames(): { skills: ReturnType<typeof profile>["skills"]; episodes: ReturnType<typeof profile>["episodes"]; owner: string | null } {
  const p = profile();
  return { skills: p.skills, episodes: p.episodes, owner: p.owner.name };
}
