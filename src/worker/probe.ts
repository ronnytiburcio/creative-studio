import sharp from "sharp";
import { FFPROBE, run } from "./proc";
import { orientationBucket, type Kind, type Orientation } from "../lib/media";

export type ProbeResult = {
  durationS: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  orientation: Orientation | null;
  hasVideo: boolean;
  hasAudio: boolean;
};

type FfStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
};

function rate(s?: string): number | null {
  if (!s) return null;
  const [a, b] = s.split("/").map(Number);
  if (!a || !b) return null;
  const v = a / b;
  return isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : null;
}

export async function probeAv(file: string): Promise<ProbeResult> {
  const { code, stdout, stderr } = await run(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { timeoutMs: 60_000 },
  );
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.trim().split("\n").pop() ?? code}`);
  const j = JSON.parse(stdout) as { streams?: FfStream[]; format?: { duration?: string } };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration);
  let width = v?.width ?? null;
  let height = v?.height ?? null;
  const rot =
    v?.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ??
    (v?.tags?.rotate ? Number(v.tags.rotate) : 0);
  if (width && height && Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  return {
    durationS: isFinite(dur) && dur > 0 ? dur : null,
    width,
    height,
    fps: rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate),
    codec: v?.codec_name ?? a?.codec_name ?? null,
    orientation: orientationBucket(width, height),
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
  };
}

async function sipsDims(file: string): Promise<{ w: number; h: number } | null> {
  const { code, stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], {
    timeoutMs: 30_000,
  });
  if (code !== 0) return null;
  const w = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  return w && h ? { w, h } : null;
}

export async function probeImage(file: string, ext: string): Promise<ProbeResult> {
  let width: number | null = null;
  let height: number | null = null;
  let codec: string | null = ext;
  if (ext === "heic") {
    const d = await sipsDims(file);
    if (d) ({ w: width, h: height } = d);
    codec = "heic";
  } else {
    const m = await sharp(file, { failOn: "none" }).metadata();
    width = m.width ?? null;
    height = m.pageHeight && m.pages && m.pages > 1 ? m.pageHeight : (m.height ?? null);
    codec = m.format ?? ext;
    if (width && height && m.orientation && m.orientation >= 5) [width, height] = [height, width];
  }
  return {
    durationS: null,
    width,
    height,
    fps: null,
    codec,
    orientation: orientationBucket(width, height),
    hasVideo: false,
    hasAudio: false,
  };
}

export async function probe(file: string, kind: Kind, ext: string): Promise<ProbeResult> {
  return kind === "image" ? probeImage(file, ext) : probeAv(file);
}
