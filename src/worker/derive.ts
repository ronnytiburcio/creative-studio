/**
 * Derived files. Everything is written into STUDIO_CACHE/<fingerprint>/ via a
 * temp file + rename. Sources are opened read only; nothing is written next to them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { FFMPEG, run } from "./proc";
import { OUTPUTS } from "../lib/variants";
import { REF_TRANSCODE_FILE } from "../lib/gen/refs";



export type SourceInfo = {
  path: string;
  ext: string;
  durationS: number | null;
  width: number | null;
  height: number | null;
};

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function tmpName(final: string) {
  const ext = path.extname(final);
  return `${final.slice(0, -ext.length)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}${ext}`;
}

async function ffmpeg(args: string[], timeoutMs: number) {
  const r = await run(FFMPEG, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeoutMs,
  });
  if (r.code !== 0) {
    const msg = r.stderr.trim().split("\n").slice(-2).join(" | ") || `exit ${r.code}`;
    throw new Error(`ffmpeg: ${msg}`);
  }
}

async function atomic(final: string, produce: (tmp: string) => Promise<void>) {
  await fs.mkdir(path.dirname(final), { recursive: true });
  const tmp = tmpName(final);
  try {
    await produce(tmp);
    const st = await fs.stat(tmp);
    if (st.size === 0) throw new Error("empty output");
    await fs.rename(tmp, final);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** poster.jpg (10% in, capped at 30s, long side 640) + sheet.jpg (6 frames, 3x2). */
export async function deriveVideoThumbs(src: SourceInfo, dir: string) {
  const dur = src.durationS ?? 0;
  const poster = path.join(dir, OUTPUTS.poster.file);
  const sheet = path.join(dir, OUTPUTS.sheet.file);
  if (!(await exists(poster))) {
    const t = Math.min(dur * 0.1, 30);
    const posterArgs = (seek: number, tmp: string) => [
      "-ss", seek.toFixed(3),
      "-i", src.path,
      "-frames:v", "1",
      "-vf", "scale='if(gt(iw,ih),min(640,iw),-2)':'if(gt(iw,ih),-2,min(640,ih))',format=yuvj420p",
      "-q:v", "4",
      tmp,
    ];
    await atomic(poster, async (tmp) => {
      await ffmpeg(posterArgs(t, tmp), 120_000);
      // Some files decode no frame at the seek point; fall back to the first frame.
      if (!(await exists(tmp)) || (await fs.stat(tmp)).size === 0) await ffmpeg(posterArgs(0, tmp), 120_000);
    });
  }
  if (!(await exists(sheet))) {
    const w = src.width ?? 16;
    const h = src.height ?? 9;
    const [tw, th] = w >= h ? [320, even((320 * h) / w)] : [even((320 * w) / h), 320];
    const args: string[] = [];
    let fc = "";
    for (let i = 0; i < 6; i++) {
      const t = dur > 0 ? (dur * (i + 0.5)) / 6 : 0;
      args.push("-ss", t.toFixed(3), "-i", src.path);
      fc += `[${i}:v]scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
    }
    fc += "[v0][v1][v2]hstack=3[t];[v3][v4][v5]hstack=3[b];[t][b]vstack=2,format=yuvj420p[out]";
    await atomic(sheet, (tmp) =>
      ffmpeg([...args, "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", "-q:v", "5", tmp], 300_000),
    );
  }
  return { poster, sheet };
}

/** proxy.mp4: 480p on the short side (never upscaled), H.264 (VideoToolbox), AAC, faststart. */
export async function deriveProxy(src: SourceInfo, dir: string) {
  const proxy = path.join(dir, OUTPUTS.proxy.file);
  if (await exists(proxy)) return { proxy };
  const vf =
    "scale='if(gt(iw,ih),-2,min(480,trunc(iw/2)*2))':'if(gt(iw,ih),min(480,trunc(ih/2)*2),-2)',format=yuv420p";
  // Generous timeout: long episodes. VideoToolbox is ~10x realtime on the M4 Max.
  const timeout = Math.max(10 * 60_000, (src.durationS ?? 0) * 1000 * 2);
  const common = ["-i", src.path, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, "-fpsmax", "30"];
  const tail = ["-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", "-tag:v", "avc1"];
  await atomic(proxy, async (tmp) => {
    try {
      await ffmpeg(
        [...common, "-c:v", "h264_videotoolbox", "-b:v", "1200k", "-maxrate", "2000k", "-bufsize", "4000k", ...tail, tmp],
        timeout,
      );
    } catch (e) {
      // Fallback to software x264 if VideoToolbox refuses the stream.
      await fs.rm(tmp, { force: true });
      await ffmpeg([...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", ...tail, tmp], timeout * 2).catch(
        (e2) => {
          throw new Error(`${(e as Error).message}; x264 fallback: ${(e2 as Error).message}`);
        },
      );
    }
  });
  return { proxy };
}

/** thumb.webp (~640px long side). HEIC goes through macOS sips into the cache first. */
export async function deriveImageThumb(src: SourceInfo, dir: string) {
  const thumb = path.join(dir, OUTPUTS.thumb.file);
  if (await exists(thumb)) return { thumb };
  await atomic(thumb, async (tmp) => {
    let input = src.path;
    let sipsTmp: string | null = null;
    try {
      if (src.ext === "heic") {
        sipsTmp = path.join(dir, `heic-${process.pid}-${randomUUID().slice(0, 8)}.jpg`);
        const r = await run("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", "1280", src.path, "--out", sipsTmp], {
          timeoutMs: 60_000,
        });
        if (r.code !== 0) throw new Error(`sips: ${r.stderr.trim() || r.stdout.trim()}`);
        input = sipsTmp;
      }
      await sharp(input, { failOn: "none", limitInputPixels: false })
        .rotate()
        .resize(640, 640, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(tmp);
    } finally {
      if (sipsTmp) await fs.rm(sipsTmp, { force: true });
    }
  });
  return { thumb };
}

/**
 * ref1080.mp4: the "reference" copy of a video sent to a generation engine when the original is not H.264
 * or too big (see src/lib/gen/refs.ts). 1080 on the short side (never upscaled), H.264 (VideoToolbox,
 * libx264 fallback), AAC, faststart. Cached per fingerprint and reused.
 */
export async function deriveReference1080(srcPath: string, dir: string) {
  const out = path.join(dir, REF_TRANSCODE_FILE);
  if (await exists(out)) return { ref: out };
  const vf =
    "scale='if(gt(iw,ih),-2,min(1080,trunc(iw/2)*2))':'if(gt(iw,ih),min(1080,trunc(ih/2)*2),-2)',format=yuv420p";
  const common = ["-i", srcPath, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, "-fpsmax", "60"];
  const tail = ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart", "-tag:v", "avc1"];
  const timeout = 30 * 60_000;
  await atomic(out, async (tmp) => {
    try {
      await ffmpeg([...common, "-c:v", "h264_videotoolbox", "-b:v", "8000k", "-maxrate", "12000k", "-bufsize", "16000k", ...tail, tmp], timeout);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      await ffmpeg([...common, "-c:v", "libx264", "-preset", "fast", "-crf", "20", ...tail, tmp], timeout * 2).catch((e2) => {
        throw new Error(`${(e as Error).message}; x264 fallback: ${(e2 as Error).message}`);
      });
    }
  });
  return { ref: out };
}
