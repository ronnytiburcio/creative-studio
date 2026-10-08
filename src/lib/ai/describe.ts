/**
 * Describe prompt (client safe: no node imports). A fixed, versioned prompt: bump DESCRIBE_PROMPT_VERSION on any
 * wording change and every asset becomes eligible again (descriptions are cached per fingerprint + model + version).
 * The opening line of each prompt (what the library mostly holds) comes from the business profile (`profile.describe`,
 * Creative Studio slice 1c; the builders take it as an argument, the worker passes the active profile): a profile that keeps its line byte for byte needs no
 * version bump.
 *
 * Chosen after trying variants on real Library assets (docs/DECISIONS.md, Phase 3 slice 1): labelled lines keep the
 * output compact and predictable for Jev; the "copy only what you can see" rule stops the model from completing
 * cut-off overlay text, and "[small logo]" stops it from misreading tiny logos; roles are named only when an action
 * shows them; for video the opening line comes first (it matches image 1, and later lines were sometimes dropped).
 */
import type { ResolvedProfile } from "../profile-shared";

/** What the prompt builders read from the business profile. */
export type DescribeLines = Pick<ResolvedProfile, "describe">;

export const DESCRIBE_PROMPT_VERSION = 1;

const RULES =
  'Rules: report only what is visible. Copy text exactly as shown, keeping its spelling and capitals. If text is cut off, blurry or covered, copy only the letters you can see and end with "..."; never guess, complete or correct words. Text too small to read (a logo on a shirt, a label far away) is written as [small logo] or [small text], never guessed. Do not guess brand names, places, platforms or purposes that are not written or shown. Always write every line, each on its own line, even when the answer is none.';

const PEOPLE = (where: string) =>
  `People: how many, and a role only when it is clear from what they are doing (presenter talking to camera, worker installing, person posing); otherwise just "person". "none" if nobody is visible. Never name anyone unless the name is written ${where}.`;

/** The image prompt (the opening line from the profile). */
export function imagePrompt(p: DescribeLines): string {
  return [p.describe.image, ...IMAGE_PROMPT_REST].join("\n");
}

const IMAGE_PROMPT_REST = [
  "",
  "Write plain text, no markdown, under 150 words, one labeled line each:",
  "Shows: what is on screen: objects, rooms, materials, colors, actions.",
  PEOPLE("in the image"),
  "Setting: where it is.",
  'Text: every piece of readable text in the image (overlays, captions, logos, signs, buttons), copied word for word in quotes, separated by " | ". "none" if there is no text.',
  "Looks like: one or two of: job photo, before/after, static ad with copy, talking head, b-roll, screen recording, AI render, logo/graphic, thumbnail, other.",
  "",
  RULES,
];

/**
 * Video: image 1 = the opening (3 frames from the first 3 s of the cached proxy, side by side); image 2 = the cached
 * contact sheet (6 frames across the whole video). Without a proxy (its derive failed) image 1 is the poster, an
 * early frame, and the opening line is labelled "Early frame" so nothing claims to be the first 3 seconds.
 */
export function videoPrompt(firstImage: "opening" | "poster", p: DescribeLines): string {
  const image1 =
    firstImage === "opening"
      ? "Image 1 shows the opening of the video: 3 frames from its first 3 seconds, left to right."
      : "Image 1 is one frame from early in the video.";
  const first =
    firstImage === "opening"
      ? "First 3 seconds: in one sentence, what happens at the very start (image 1). Describe the scene and action, not the frames."
      : "Early frame: in one sentence, what image 1 shows.";
  return [
    p.describe.video,
    `${image1} Image 2 is a contact sheet: 6 frames from across the whole video, in time order, left to right, top row first.`,
    "",
    "Write plain text, no markdown, under 150 words, one labeled line each, in this order:",
    first,
    "Shows: what happens across the whole video (image 2): objects, rooms, materials, actions, camera movement.",
    PEOPLE("on screen"),
    "Setting: where it is.",
    'Text: every readable on-screen text (captions, overlays, logos, signs), copied word for word in quotes, separated by " | ". "none" if there is no text.',
    "Looks like: one or two of: talking head, b-roll, before/after, video ad with captions, screen recording, AI render, logo/graphic animation, job footage, other.",
    "",
    RULES,
  ].join("\n");
}

const LABELS = ["Shows", "People", "Setting", "Text", "Looks like", "First 3 seconds", "Early frame"];
const LABEL_RE = new RegExp(`\\s*\\b(${LABELS.join("|")}):`, "g");

/**
 * Tidy the model's answer: one labelled line each (the model sometimes runs them together), no markdown bullets or
 * bold, no blank lines, `"none"` -> none. Content is never rewritten.
 */
export function normalizeDescription(raw: string): string {
  const text = raw
    .replace(/\r/g, "")
    .replace(/\*\*/g, "")
    .replace(/^[ \t]*[-*•][ \t]+/gm, "")
    .replace(LABEL_RE, (_m, label: string) => `\n${label}:`)
    .split("\n")
    .map((line) => line.trim().replace(/:\s*"none"\.?$/i, ": none"))
    .filter(Boolean)
    .join("\n");
  return text.trim();
}

/** Human label for the describe block (drawer): "qwen3-vl:8b-instruct · prompt v1". */
export function describedWith(model: string | null, version: number | null): string {
  if (!model) return "";
  return version != null ? `${model} · prompt v${version}` : model;
}
