/**
 * How a Library video is sent to an engine as a reference (pure).
 * The original goes as is when it is H.264 in an MP4/MOV container and under 200 MB. Anything else
 * (HEVC iPhone clips, ProRes, big episodes) first gets a 1080p H.264 "reference" transcode in STUDIO_CACHE
 * (never the 480p proxy: too soft to reference).
 */
export const VIDEO_REF_MAX_BYTES = 200 * 1024 * 1024;
export const REF_TRANSCODE_FILE = "ref1080.mp4";

export type VideoRefPlan = { action: "original" } | { action: "transcode"; reason: string };

export function videoRefPlan(v: { codec: string | null; bytes: number; ext: string }): VideoRefPlan {
  const codec = (v.codec ?? "").toLowerCase();
  if (codec !== "h264") return { action: "transcode", reason: `codec ${codec || "unknown"}` };
  if (!["mp4", "m4v", "mov"].includes(v.ext.toLowerCase())) return { action: "transcode", reason: `.${v.ext} container` };
  if (v.bytes >= VIDEO_REF_MAX_BYTES) return { action: "transcode", reason: `${Math.round(v.bytes / 1024 / 1024)} MB` };
  return { action: "original" };
}
