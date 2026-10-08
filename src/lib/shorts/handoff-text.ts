/**
 * Cut reel hand-off wording (Phase 6 D; client safe): the formats the reel cut skill knows and the line the owner pastes
 * into a live Claude session. The skill names, the episode file prefix and the owner's name come from the business
 * profile (`skills`, `episodes`, `owner`): server code passes `profile()`, client components the same values from
 * `useLabels()`. No dashes (it goes to a Claude session, but it reads like the owner's own words).
 *
 * Phase 7 slice 2: `kit` (the reel kit) is the first format and the default; v2 / v3 / v1 stay for re-rendering an old
 * reel. Explainer idea cards get their own paste line for the explainer skill (no file written).
 */
import type { ResolvedProfile } from "../profile-shared";

export const HANDOFF_FORMATS = ["kit", "v2", "v3", "v1"] as const;
export type HandoffFormat = (typeof HANDOFF_FORMATS)[number];
export const DEFAULT_HANDOFF_FORMAT: HandoffFormat = "kit";

/** What the wording needs from the profile (`skills`, `episodes`, `owner`). */
export type HandoffNames = { skills: ResolvedProfile["skills"]; episodes: ResolvedProfile["episodes"]; owner?: string | null };

const FORMAT_LABEL: Record<Exclude<HandoffFormat, "kit">, string> = {
  v2: "narrated motion graphics",
  v3: "footage + graphics, fast cut",
  v1: "plain cut",
};

/** A format's label: the kit format is the profile's kit label ("Reel kit"). */
export function handoffFormatLabel(format: HandoffFormat, n: HandoffNames): string {
  return format === "kit" ? n.episodes.kitLabel : FORMAT_LABEL[format];
}

/** The one line under each format in the Cut reel dialog. */
export function handoffFormatHint(format: HandoffFormat, n: HandoffNames): string {
  switch (format) {
    case "kit":
      return `The one reel format (${n.skills.reelKit}): the hook headline from frame 0 over the cold open, a swipe back, the moment in your own voice at 1.25x with zoomed screen crops, short CAM shots and kit graphics.`;
    case "v2":
      return "Your cloned voice reads a script you approve over brand motion graphics.";
    case "v3":
      return "Real footage (webcam + deck or screen) cut fast with graphics.";
    case "v1":
      return "The original plain ffmpeg cut with captions.";
  }
}

/** "<kit label> v1" for the kit format, else the format's own label. */
export function formatLabel(format: HandoffFormat, kitVersion: number | null, n: HandoffNames): string {
  return format === "kit" ? `${handoffFormatLabel("kit", n)} v${kitVersion ?? 1}` : handoffFormatLabel(format, n);
}

/** The ready-to-paste line for a live session (the reel cut skill with the approved list, step 2 skipped). */
export function pasteLine(num: number, title: string, format: HandoffFormat, file: string, kitVersion: number | null, n: HandoffNames): string {
  const owner = n.owner ?? null;
  const how = format === "kit" ? `on ${n.skills.reelKit} v${kitVersion ?? 1}` : `in ${format}`;
  const tail = format === "kit" ? " Open each reel on its cold open (cold_start to cold_end) under its hook words." : "";
  return (
    `Run ${n.skills.reelCut} on Ep${num} (${title}) ${how}. These moments are already approved${owner ? ` by ${owner}` : ""}, skip step 2 picking: ${file}. ` +
    `Copy the list into the episode folder as "${n.episodes.prefix}${num} reels.json" (if one is already there, ask me before replacing it) and keep each moment's k as its reel number.${tail}`
  );
}

/** "4:12" (m:ss), "1:04:12" past an hour. */
export function clockMSS(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Dashes used as punctuation out of a line the owner pastes (a compound like "follow-up" stays). */
export function undash(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+-{1,2}\s+/g, ", ")
    .replace(/--+/g, ", ")
    .replace(/^[-\s,]+/, "")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Explainer idea cards (Phase 7 C2): `Run <explainer> on this idea[ from <prefix>N at m:ss]: <line>. Use <reel kit>.`
 * The bracket only when the card came from an episode card (Make explainer); m:ss = that moment's start.
 */
export function explainerPasteLine(line: string, from: { num: number; start: number } | null, n: HandoffNames): string {
  const text = undash(line.replace(/\s+/g, " ").trim());
  const end = /[.!?]$/.test(text) ? "" : ".";
  const where = from ? ` from ${n.episodes.prefix}${from.num} at ${clockMSS(from.start)}` : "";
  return `Run ${n.skills.explainer} on this idea${where}: ${text}${end} Use ${n.skills.reelKit}.`;
}
