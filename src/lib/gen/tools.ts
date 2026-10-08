/**
 * Quick tools (pure, safe for client + server): one click on a Library image or video runs a fixed Higgsfield
 * job on it and lands the result next to the source's channel.
 *
 *   tool          image                                   video
 *   upscale       bytedance_image_upscale  resolution 4k  bytedance_video_upscale  resolution 2k
 *   remove_bg     image_background_remover                video_background_remover
 *   reframe_916   outpaint  aspect_ratio 9:16             workflow reframe  aspect_ratio 9:16, resolution 720p, duration = clip
 *
 * The settings here are only the tool's own choices; names and allowed values are checked against the live
 * `model get` / `workflow get` schema before a job is queued (never trusted blindly).
 * Quotes (verified 2026-09-29, CLI 1.1.23): image tools quote a flat price per image; video upscale and video
 * remove background quote the same with or without the real clip (no duration param exists), so their quote is
 * only a minimum; the reframe workflow quotes from `--duration` + `--resolution` (about 4.5 credits/s + 3).
 */
import type { GenDest } from "./layout";
import type { RefRole } from "./rules";
import type { ParamValue } from "./types";

export const TOOL_IDS = ["upscale", "remove_bg", "reframe_916"] as const;
export type ToolId = (typeof TOOL_IDS)[number];
export type ToolMedia = "image" | "video";

export const TOOL_LABEL: Record<ToolId, string> = {
  upscale: "Upscale",
  remove_bg: "Remove background",
  reframe_916: "Reframe 9:16",
};

/** Exact copy for tools whose quote does not know the clip length. */
export const MIN_QUOTE_TEXT = "Estimate may be low: Higgsfield quotes this without the clip length";

/**
 * Tools that had never run for real when they shipped (the owner, 2026-09-29: ship, marked untested): every VIDEO tool
 * (upscale, remove background, reframe 9:16). They carry a "First real run" note until one job of that tool +
 * media has finished `done` (derived from the jobs table, see firstRealRunOf in tooljobs.ts).
 */
export function untestedTool(tool: ToolId | string, media: ToolMedia | string): boolean {
  return media === "video" && (TOOL_IDS as readonly string[]).includes(tool);
}

/** Exact copy for the first real run of an untested tool. */
export const FIRST_RUN_TEXT = "This tool hasn't run for real yet. If Higgsfield rejects it before starting, no credits are spent.";

export type ToolSpec = {
  tool: ToolId;
  media: ToolMedia;
  /** Model job type, or the workflow name when `workflow` is true. */
  jobType: string;
  workflow: boolean;
  /** The tool's settings (validated against the schema at queue time). */
  params: Record<string, ParamValue>;
  /** Media param the source is sent as. */
  role: RefRole;
  /** Short settings summary for labels ("4k", "9:16 · 720p · 5.04 s"). */
  detail: string;
  /** false: Higgsfield's quote ignores the clip length, so it is shown as a minimum. */
  exactQuote: boolean;
};

/** Longest clip the video reframe accepts from Studio (Higgsfield states no limit; a 10 min clip would quote ~2,700 credits). */
export const REFRAME_MAX_SECONDS = 600;

/** Clip length as sent to the reframe workflow: seconds, 2 decimals. */
export function reframeDuration(durationS: number | null | undefined): number | null {
  if (durationS == null || !Number.isFinite(durationS) || durationS <= 0) return null;
  return Math.round(durationS * 100) / 100;
}

export function toolSpec(tool: ToolId, media: ToolMedia, durationS?: number | null): ToolSpec | { error: string } {
  const role: RefRole = media === "video" ? "video_references" : "image_references";
  if (tool === "upscale") {
    return media === "image"
      ? { tool, media, jobType: "bytedance_image_upscale", workflow: false, params: { resolution: "4k" }, role, detail: "4k", exactQuote: true }
      : { tool, media, jobType: "bytedance_video_upscale", workflow: false, params: { resolution: "2k" }, role, detail: "2k", exactQuote: false };
  }
  if (tool === "remove_bg") {
    return media === "image"
      ? { tool, media, jobType: "image_background_remover", workflow: false, params: {}, role, detail: "", exactQuote: true }
      : { tool, media, jobType: "video_background_remover", workflow: false, params: {}, role, detail: "", exactQuote: false };
  }
  if (media === "image") {
    return { tool, media, jobType: "outpaint", workflow: false, params: { aspect_ratio: "9:16" }, role, detail: "", exactQuote: true };
  }
  const duration = reframeDuration(durationS);
  if (duration == null) return { error: "The clip length is unknown (wait for indexing to finish)." };
  if (duration > REFRAME_MAX_SECONDS) return { error: `Reframe takes clips up to ${REFRAME_MAX_SECONDS / 60} minutes from Studio.` };
  return {
    tool,
    media,
    jobType: "reframe",
    workflow: true,
    params: { aspect_ratio: "9:16", resolution: "720p", duration },
    role,
    detail: `720p · ${duration} s`,
    exactQuote: true,
  };
}

/** Full label, e.g. "Upscale 4k", "Reframe 9:16". */
export function toolTitle(tool: ToolId, detail?: string | null): string {
  return tool === "upscale" && detail ? `${TOOL_LABEL[tool]} ${detail}` : TOOL_LABEL[tool];
}

/**
 * Where a tool's output goes: the source's own channel. Lane A -> Lane A; Lane B -> that client's folder when the
 * source is tagged to exactly one client, else Lane B/_shared.
 */
export function toolDest(sectionKey: string, clientCodes: string[]): GenDest {
  if (sectionKey === "rtm") return { section: "rtm" };
  if (sectionKey === "fkb") return { section: "fkb" };
  const codes = [...new Set(clientCodes)];
  return { section: "fkbpros", client: codes.length === 1 ? codes[0] : null };
}

/** What a tool job carries in GenInput.tool. */
export type ToolRequest = {
  id: ToolId;
  media: ToolMedia;
  workflow: boolean;
  exactQuote: boolean;
  detail: string;
  /** Params the cost command takes for this tool (the reframe workflow only accepts duration + resolution). */
  quoteParams: Record<string, ParamValue>;
  source: { assetId: number; path: string; filename: string };
};
