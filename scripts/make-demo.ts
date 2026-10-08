/**
 * `npx tsx scripts/make-demo.ts`: makes the demo pack's media (`demo/media/`, committed) and its manifest
 * (`demo/manifest.json`: every file's path, bytes and sha256). Everything is drawn here, on this Mac: sharp renders SVG
 * drawings to JPEG / PNG (fake static ads, a before / after pair, a thumbnail, a brand mark, a quote card, video
 * frames) and ffmpeg turns those frames into short H.264 clips (a slide "episode" with its matching SRT, a cut reel, a
 * vertical short, b-roll pans, two talking head stand-ins). No stock, no AI generation, no network.
 *
 *   npx tsx scripts/make-demo.ts            regenerate demo/media + demo/manifest.json
 *   npx tsx scripts/make-demo.ts --check    regenerate into a temp folder and compare with the manifest (exit 1 on a
 *                                           difference); nothing in demo/ is touched
 *
 * Deterministic: fixed drawings, fixed ffmpeg arguments (single thread, bitexact flags, no metadata) and no clock or
 * random input, so the same sharp / libvips / fonts and ffmpeg / x264 versions produce byte identical files. Another
 * machine (other fonts, another x264) produces the same list, sizes close and the same dimensions and durations, but not
 * necessarily the same bytes; the committed files are what screenshots use.
 *
 * Every brand, business, person and place here is invented (the leak gate scans demo/ too).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { FFMPEG } from "../src/worker/proc";

const REPO = path.resolve(__dirname, "..");
export const DEMO_DIR = path.join(REPO, "demo");
export const DEMO_MEDIA_DIR = path.join(DEMO_DIR, "media");
export const DEMO_MANIFEST = path.join(DEMO_DIR, "manifest.json");
/** The demo pack's budget (committed media, the whole folder). */
export const DEMO_MAX_BYTES = 5 * 1024 * 1024;

// ------------------------------------------------------------------------------------------------ the folder layout

/** Lane A (the made-up creator brand) and Lane B (three made-up clients) folders under demo/media. */
export const LANE_A_FOLDER = "Harbor and Pine";
export const CLIENTS_FOLDER = "Clients";
export const CLIENT_FOLDERS = { crumb: "Crumb and Crust Bakery", ironleaf: "Ironleaf Fitness", spoke: "Spoke and Chain Cycles" } as const;
export const EPISODE_FOLDER = `${LANE_A_FOLDER}/Episodes/Episode 1 Shooting on a Budget`;

const A = (p: string) => `${LANE_A_FOLDER}/${p}`;
const C = (code: keyof typeof CLIENT_FOLDERS, p: string) => `${CLIENTS_FOLDER}/${CLIENT_FOLDERS[code]}/${p}`;

/** Every file the demo pack holds, relative to demo/media (the smoke compares this list with the folder). */
export const DEMO_PATHS = {
  episode: `${EPISODE_FOLDER}/Episode 1.mp4`,
  episodeSrt: `${EPISODE_FOLDER}/Episode 1.srt`,
  reel: `${EPISODE_FOLDER}/Episode 1 Reel 1.mp4`,
  short: A("Shorts/window-light-in-60-seconds.mp4"),
  brollHarbor: A("B-roll/harbor-morning-pan.mp4"),
  brollDesk: A("B-roll/desk-setup-slider.mp4"),
  talkingHead: A("Talking head/intro-take-3.mp4"),
  thumbnail: A("Thumbnails/episode-1-thumbnail.jpg"),
  mark: A("Brand/harbor-and-pine-mark.png"),
  quote: A("Brand/quote-card-light-is-free.jpg"),
  crumbBox: C("crumb", "static-weekend-box.jpg"),
  crumbClass: C("crumb", "static-sourdough-class.jpg"),
  crumbBefore: C("crumb", "before-after-cake-before.jpg"),
  crumbAfter: C("crumb", "before-after-cake-after.jpg"),
  crumbBaker: C("crumb", "baker-talking-head.mp4"),
  ironFree: C("ironleaf", "static-first-class-free.jpg"),
  ironReset: C("ironleaf", "static-six-week-reset.jpg"),
  ironBroll: C("ironleaf", "class-broll.mp4"),
  spokeTune: C("spoke", "static-spring-tune-up.jpg"),
  spokeBeforeAfter: C("spoke", "before-after-bike.jpg"),
} as const;
export type DemoKey = keyof typeof DEMO_PATHS;
export const DEMO_FILES: string[] = Object.values(DEMO_PATHS).slice().sort();

// ------------------------------------------------------------------------------------------------ drawing helpers

const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
const NAVY = "#1F3A4D";
const PINE = "#2F5D50";
const SAND = "#F2E8D8";
const CREAM = "#FFF8EE";
const ORANGE = "#E2703A";
const INK = "#1B1B1B";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function svg(w: number, h: number, body: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
}

type TextOpts = { size: number; fill?: string; weight?: number; anchor?: "start" | "middle" | "end"; lh?: number };
/** One or more lines of text starting at (x, y) (the first baseline). */
function text(x: number, y: number, lines: string | string[], o: TextOpts): string {
  const list = Array.isArray(lines) ? lines : [lines];
  const lh = o.lh ?? Math.round(o.size * 1.15);
  return list
    .map(
      (l, i) =>
        `<text x="${x}" y="${y + i * lh}" font-family="${FONT}" font-size="${o.size}" font-weight="${o.weight ?? 700}" fill="${o.fill ?? INK}" text-anchor="${o.anchor ?? "start"}">${esc(l)}</text>`,
    )
    .join("");
}

function button(x: number, y: number, w: number, h: number, label: string, bg = ORANGE, fg = "#FFFFFF"): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${bg}"/>` + text(x + w / 2, y + h * 0.64, label, { size: Math.round(h * 0.42), fill: fg, anchor: "middle" });
}

const loaf = (cx: number, cy: number, s: number) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${170 * s}" ry="${95 * s}" fill="#C98A4B"/><ellipse cx="${cx}" cy="${cy - 18 * s}" rx="${150 * s}" ry="${70 * s}" fill="#DDA466"/>` +
  [-80, -25, 30, 85].map((dx) => `<path d="M${cx + dx * s - 30 * s} ${cy - 45 * s} q${30 * s} ${-25 * s} ${60 * s} 0" stroke="#F3D3A1" stroke-width="${9 * s}" fill="none" stroke-linecap="round"/>`).join("");

const box = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#B9855A"/><rect x="${x - 12}" y="${y - 40}" width="${w + 24}" height="56" rx="14" fill="#CC9A6E"/><rect x="${x + w / 2 - 22}" y="${y - 40}" width="44" height="${h + 40}" fill="${ORANGE}" opacity="0.85"/>`;

function cake(cx: number, cy: number, s: number, done: boolean): string {
  if (!done) {
    return `<rect x="${cx - 150 * s}" y="${cy - 40 * s}" width="${300 * s}" height="${120 * s}" rx="${10 * s}" fill="#E8D3B0"/><rect x="${cx - 120 * s}" y="${cy - 120 * s}" width="${240 * s}" height="${80 * s}" rx="${8 * s}" fill="#E1C69C"/>` +
      `<ellipse cx="${cx}" cy="${cy + 85 * s}" rx="${200 * s}" ry="${22 * s}" fill="#D9D2C5"/>`;
  }
  const candles = [-70, -20, 30, 80].map((dx) => `<rect x="${cx + dx * s - 6 * s}" y="${cy - 175 * s}" width="${12 * s}" height="${55 * s}" fill="#7FB3D5"/><ellipse cx="${cx + dx * s}" cy="${cy - 185 * s}" rx="${8 * s}" ry="${14 * s}" fill="#F6C343"/>`).join("");
  return `<ellipse cx="${cx}" cy="${cy + 85 * s}" rx="${200 * s}" ry="${22 * s}" fill="#D9D2C5"/><rect x="${cx - 150 * s}" y="${cy - 40 * s}" width="${300 * s}" height="${120 * s}" rx="${10 * s}" fill="#F4B6C2"/>` +
    `<rect x="${cx - 120 * s}" y="${cy - 120 * s}" width="${240 * s}" height="${80 * s}" rx="${8 * s}" fill="#F8CFD8"/>` +
    [0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${cx - 125 * s + i * 50 * s}" cy="${cy - 40 * s}" r="${14 * s}" fill="#FFFFFF"/>`).join("") + candles;
}

const dumbbell = (cx: number, cy: number, s: number) =>
  `<rect x="${cx - 150 * s}" y="${cy - 10 * s}" width="${300 * s}" height="${20 * s}" rx="${8 * s}" fill="#4A4A4A"/>` +
  [-150, -120, 100, 130].map((dx) => `<rect x="${cx + dx * s}" y="${cy - 60 * s}" width="${22 * s}" height="${120 * s}" rx="${6 * s}" fill="#2B2B2B"/>`).join("");

function bike(cx: number, cy: number, s: number, color: string, rusty = false): string {
  const wheel = (x: number) => `<circle cx="${x}" cy="${cy}" r="${85 * s}" fill="none" stroke="#222" stroke-width="${12 * s}"/><circle cx="${x}" cy="${cy}" r="${10 * s}" fill="#222"/>`;
  const frame = `<path d="M${cx - 130 * s} ${cy} L${cx - 40 * s} ${cy - 120 * s} L${cx + 90 * s} ${cy - 120 * s} L${cx + 130 * s} ${cy} M${cx - 40 * s} ${cy - 120 * s} L${cx} ${cy} L${cx + 90 * s} ${cy - 120 * s} M${cx - 130 * s} ${cy} L${cx} ${cy}" stroke="${color}" stroke-width="${14 * s}" fill="none" stroke-linejoin="round"/>`;
  const seat = `<rect x="${cx - 70 * s}" y="${cy - 150 * s}" width="${60 * s}" height="${14 * s}" rx="${6 * s}" fill="#222"/><path d="M${cx + 90 * s} ${cy - 120 * s} L${cx + 100 * s} ${cy - 165 * s} L${cx + 140 * s} ${cy - 170 * s}" stroke="#222" stroke-width="${10 * s}" fill="none"/>`;
  const rust = rusty ? [-90, 10, 60].map((dx) => `<circle cx="${cx + dx * s}" cy="${cy - 60 * s}" r="${16 * s}" fill="#8B4A2B" opacity="0.7"/>`).join("") : "";
  return wheel(cx - 130 * s) + wheel(cx + 130 * s) + frame + seat + rust;
}

function windowLight(x: number, y: number, w: number, h: number): string {
  const panes = [0, 1].flatMap((i) => [0, 1].map((j) => `<rect x="${x + 12 + i * (w / 2)}" y="${y + 12 + j * (h / 2)}" width="${w / 2 - 24}" height="${h / 2 - 24}" fill="#DDEFF7"/>`)).join("");
  const rays = `<polygon points="${x + w},${y} ${x + w * 2.6},${y + h * 0.9} ${x + w * 2.6},${y + h * 1.9} ${x + w},${y + h}" fill="#FFF3C4" opacity="0.55"/>`;
  return rays + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#F7F3EA" stroke="#9C8F7A" stroke-width="10"/>` + panes;
}

/** A simple presenter: head and shoulders (no face, no real person). */
const presenter = (cx: number, cy: number, s: number, shirt = PINE) =>
  `<rect x="${cx - 110 * s}" y="${cy + 70 * s}" width="${220 * s}" height="${200 * s}" rx="${90 * s}" fill="${shirt}"/><circle cx="${cx}" cy="${cy}" r="${70 * s}" fill="#D9A77F"/><path d="M${cx - 72 * s} ${cy - 10 * s} q${72 * s} ${-110 * s} ${144 * s} 0" fill="#3B2A20"/>`;

const harborScene = (w: number, h: number) =>
  `<rect width="${w}" height="${h}" fill="#BFD9E6"/><circle cx="${w * 0.18}" cy="${h * 0.28}" r="${h * 0.12}" fill="#FCE3A6"/>` +
  `<path d="M0 ${h * 0.62} L${w * 0.15} ${h * 0.42} L${w * 0.32} ${h * 0.58} L${w * 0.5} ${h * 0.38} L${w * 0.7} ${h * 0.6} L${w * 0.86} ${h * 0.45} L${w} ${h * 0.6} L${w} ${h} L0 ${h} Z" fill="${PINE}"/>` +
  `<rect y="${h * 0.66}" width="${w}" height="${h * 0.34}" fill="${NAVY}"/>` +
  [0.12, 0.38, 0.61, 0.84].map((f, i) => `<path d="M${w * f - 40} ${h * 0.7} L${w * f + 40} ${h * 0.7} L${w * f + 28} ${h * 0.78} L${w * f - 28} ${h * 0.78} Z" fill="${i % 2 ? CREAM : ORANGE}"/><rect x="${w * f - 3}" y="${h * 0.56}" width="6" height="${h * 0.14}" fill="#EDEDED"/>`).join("");

const deskScene = (w: number, h: number) =>
  `<rect width="${w}" height="${h}" fill="${SAND}"/><rect y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="#A47551"/>` +
  windowLight(w * 0.06, h * 0.12, w * 0.16, h * 0.42) +
  `<rect x="${w * 0.42}" y="${h * 0.3}" width="${w * 0.2}" height="${h * 0.26}" rx="8" fill="#2E2E2E"/><rect x="${w * 0.51}" y="${h * 0.56}" width="${w * 0.02}" height="${h * 0.06}" fill="#2E2E2E"/>` +
  `<rect x="${w * 0.72}" y="${h * 0.2}" width="${w * 0.012}" height="${h * 0.42}" fill="#555"/><circle cx="${w * 0.726}" cy="${h * 0.18}" r="${h * 0.05}" fill="#F7F3EA" stroke="#555" stroke-width="4"/>` +
  `<rect x="${w * 0.8}" y="${h * 0.14}" width="${w * 0.14}" height="${h * 0.48}" fill="#FFFFFF" stroke="#DDD" stroke-width="4"/>`;

const gymScene = (w: number, h: number) =>
  `<rect width="${w}" height="${h}" fill="#E6EBE4"/><rect y="${h * 0.7}" width="${w}" height="${h * 0.3}" fill="#6B7F6A"/>` +
  [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => `<rect x="${w * f - 4}" y="${h * 0.1}" width="8" height="${h * 0.6}" fill="#9AA79A"/>`).join("") +
  [0.18, 0.42, 0.66, 0.88].map((f, i) => presenter(w * f, h * 0.42, 0.55, i % 2 ? "#3E6A8A" : PINE)).join("") +
  [0.25, 0.55, 0.8].map((f) => dumbbell(w * f, h * 0.82, 0.35)).join("");

const bakeryScene = (w: number, h: number) =>
  `<rect width="${w}" height="${h}" fill="#F3E6D3"/><rect y="${h * 0.55}" width="${w}" height="${h * 0.45}" fill="#8C5E3C"/>` +
  [0.25, 0.75].map((f) => `<rect x="${w * f - w * 0.18}" y="${h * 0.12}" width="${w * 0.36}" height="${h * 0.06}" fill="#B98B5E"/>`).join("") +
  loaf(w * 0.25, h * 0.1, w / 2200) + loaf(w * 0.75, h * 0.1, w / 2200);

async function jpeg(file: string, w: number, h: number, body: string, quality = 76) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(svg(w, h, body)).jpeg({ quality, chromaSubsampling: "4:2:0" }).toFile(file);
}

async function png(file: string, w: number, h: number, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(svg(w, h, body)).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(file);
}

/** A static ad (1080 x 1350): a colored field, a drawing, a headline, a sub line and a call to action. */
function staticAd(o: { bg: string; band: string; brand: string; art: string; headline: string[]; sub: string[]; cta: string; fg?: string }): string {
  const fg = o.fg ?? INK;
  return (
    `<rect width="1080" height="1350" fill="${o.bg}"/><rect y="0" width="1080" height="96" fill="${o.band}"/>` +
    text(60, 64, o.brand, { size: 38, fill: "#FFFFFF", weight: 600 }) +
    o.art +
    text(60, 880, o.headline, { size: 76, fill: fg, lh: 86 }) +
    text(60, 880 + o.headline.length * 86 + 40, o.sub, { size: 38, fill: fg, weight: 400, lh: 48 }) +
    button(60, 1190, 440, 96, o.cta)
  );
}

// ------------------------------------------------------------------------------------------------ ffmpeg

/** The fixed tail of every encode: one thread, no metadata, bitexact muxing and encoding. */
const H264 = ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-threads", "1", "-x264-params", "threads=1:lookahead-threads=1"];
const EXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-movflags", "+faststart"];

function ff(args: string[]) {
  const r = spawnSync(FFMPEG, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || "").slice(-600)}`);
}

/** Speech-like stand-in audio (a soft tone whose loudness moves like syllables): no voice, deterministic. */
const voiceLike = (seconds: number) => [
  "-f",
  "lavfi",
  "-i",
  `aevalsrc='0.08*sin(2*PI*170*t)*(0.55+0.45*sin(2*PI*3.1*t))*(0.6+0.4*sin(2*PI*0.7*t))':s=22050:d=${seconds}`,
];
const AAC = ["-c:a", "aac", "-b:a", "32k", "-ac", "1"];

/** A slow push-in on one still (vertical or horizontal). */
function stillPush(still: string, out: string, w: number, h: number, seconds: number, fps: number, crf: number) {
  const frames = seconds * fps;
  ff([
    "-i", still,
    "-vf", `zoompan=z='min(1+0.10*on/${frames},1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`,
    "-frames:v", String(frames), "-r", String(fps), ...H264, "-crf", String(crf), "-an", ...EXACT, out,
  ]);
}

/** A sideways pan across a wide still. */
function pan(still: string, out: string, w: number, h: number, seconds: number, fps: number, travel: number) {
  ff([
    "-loop", "1", "-framerate", String(fps), "-t", String(seconds), "-i", still,
    "-vf", `crop=${w}:${h}:x='${travel}*t/${seconds}':y=0,format=yuv420p`,
    "-r", String(fps), ...H264, "-crf", "30", "-an", ...EXACT, out,
  ]);
}

/** A presenter stand-in over a background, bobbing gently, with speech-like stand-in audio. */
function talking(bg: string, fig: string, out: string, seconds: number, fps: number, figX: number, figY: number) {
  ff([
    "-loop", "1", "-framerate", String(fps), "-t", String(seconds), "-i", bg,
    "-loop", "1", "-framerate", String(fps), "-t", String(seconds), "-i", fig,
    ...voiceLike(seconds),
    "-filter_complex", `[0:v][1:v]overlay=x=${figX}:y='${figY}+5*sin(t*5)':shortest=1,format=yuv420p[v]`,
    "-map", "[v]", "-map", "2:a", "-t", String(seconds), "-r", String(fps), ...H264, "-crf", "30", ...AAC, ...EXACT, out,
  ]);
}

// ------------------------------------------------------------------------------------------------ the episode + SRT

/** Episode 1's transcript: 30 cues of 5 s, one sentence each (made up for the demo). */
export const EPISODE_CUES: string[] = [
  "Welcome back to Harbor and Pine, where we make good video with very little gear.",
  "Today is all about shooting on a budget.",
  "Here is the truth nobody tells beginners.",
  "Your camera matters far less than your light.",
  "A window is the best light you will ever own, and it is free.",
  "Put the window in front of you, never behind you.",
  "Turn off every overhead light in the room.",
  "Mixed color light makes skin look tired and green.",
  "Now let's talk about sound, because people forgive bad video but not bad audio.",
  "A twenty dollar lapel mic beats the best camera microphone.",
  "Clip it a hand width below your chin.",
  "Record a few seconds of silence before you start talking.",
  "Soft things in the room, like a couch or a rug, kill the echo.",
  "Next, framing.",
  "Put your eyes on the top third of the frame.",
  "Leave a little space above your head, not a lot.",
  "Shoot vertical if the video lives on your phone feed.",
  "Shoot horizontal if it lives on YouTube.",
  "Now the part that really saves money.",
  "Batch your filming into one morning a week.",
  "Same shirt, same light, same spot, five videos in a row.",
  "You set up once and you look consistent for a month.",
  "Here is my whole kit for under two hundred dollars.",
  "A phone, a lapel mic, a cheap tripod and a white foam board.",
  "The foam board bounces window light back into the shadows.",
  "That is the entire secret behind the soft look.",
  "If you try one thing this week, move your desk to the window.",
  "Then film one short and post it before you overthink it.",
  "Tell me in the comments what you shot.",
  "See you next week at Harbor and Pine.",
];
export const CUE_SECONDS = 5;
export const EPISODE_SECONDS = EPISODE_CUES.length * CUE_SECONDS;

const srtTime = (s: number) => {
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},000`;
};

export function episodeSrt(): string {
  return EPISODE_CUES.map((t, i) => `${i + 1}\n${srtTime(i * CUE_SECONDS)} --> ${srtTime((i + 1) * CUE_SECONDS)}\n${t}\n`).join("\n");
}

const SLIDES: { title: string; lines: string[] }[] = [
  { title: "Shooting on a Budget", lines: ["Harbor and Pine · Episode 1"] },
  { title: "Light beats gear", lines: ["Your camera matters less", "than your light"] },
  { title: "Use the window", lines: ["In front of you", "never behind you"] },
  { title: "Fix your sound", lines: ["A $20 lapel mic", "a hand width below your chin"] },
  { title: "Kill the echo", lines: ["Couch, rug, curtains", "soft things soak it up"] },
  { title: "Frame it right", lines: ["Eyes on the top third", "a little headroom"] },
  { title: "Batch your filming", lines: ["One morning a week", "five videos in a row"] },
  { title: "The $200 kit", lines: ["Phone · lapel mic", "tripod · foam board"] },
  { title: "Your one thing", lines: ["Move your desk", "to the window"] },
  { title: "Then post it", lines: ["One short this week", "before you overthink it"] },
];

function slideSvg(i: number): string {
  const s = SLIDES[i];
  const bg = i === 0 ? NAVY : i % 2 ? SAND : CREAM;
  const fg = i === 0 ? "#FFFFFF" : NAVY;
  return (
    `<rect width="640" height="360" fill="${bg}"/><rect x="0" y="330" width="640" height="30" fill="${i === 0 ? ORANGE : PINE}"/>` +
    text(40, 120, s.title, { size: 44, fill: fg }) +
    text(40, 180, s.lines, { size: 26, fill: fg, weight: 400, lh: 34 }) +
    text(40, 352, `HARBOR & PINE   ${i + 1} / ${SLIDES.length}`, { size: 14, fill: "#FFFFFF", weight: 600 })
  );
}

// ------------------------------------------------------------------------------------------------ the pack

type Maker = (abs: string, tmp: string) => Promise<void>;

const MAKERS: Record<DemoKey, Maker> = {
  async episode(abs, tmp) {
    const slides: string[] = [];
    for (let i = 0; i < SLIDES.length; i++) {
      const f = path.join(tmp, `slide-${i}.png`);
      await png(f, 640, 360, slideSvg(i));
      slides.push(f);
    }
    const fig = path.join(tmp, "episode-presenter.png");
    await png(fig, 150, 150, `<circle cx="75" cy="75" r="72" fill="#FFFFFF" opacity="0.9"/>` + presenter(75, 60, 0.45));
    const per = EPISODE_SECONDS / SLIDES.length;
    const inputs = slides.flatMap((f) => ["-loop", "1", "-framerate", "10", "-t", String(per), "-i", f]);
    const concat = slides.map((_, i) => `[${i}:v]`).join("") + `concat=n=${slides.length}:v=1:a=0[bg]`;
    ff([
      ...inputs,
      "-loop", "1", "-framerate", "10", "-t", String(EPISODE_SECONDS), "-i", fig,
      "-filter_complex", `${concat};[bg][${slides.length}:v]overlay=x=470:y='170+3*sin(t*4)':shortest=1,format=yuv420p[v]`,
      "-map", "[v]", "-r", "10", "-g", "100", ...H264, "-crf", "32", "-tune", "stillimage", "-an", ...EXACT, abs,
    ]);
  },
  async episodeSrt(abs) {
    fs.writeFileSync(abs, episodeSrt());
  },
  async reel(abs, tmp) {
    const still = path.join(tmp, "reel.png");
    await png(still, 720, 1280,
      `<rect width="720" height="1280" fill="${CREAM}"/>` + windowLight(60, 380, 260, 380) + presenter(470, 640, 1.1) +
        `<rect x="40" y="120" width="640" height="190" rx="24" fill="${NAVY}"/>` +
        text(360, 205, "WINDOW", { size: 76, fill: "#FFFFFF", anchor: "middle" }) +
        `<rect x="190" y="225" width="340" height="70" rx="12" fill="${ORANGE}"/>` + text(360, 280, "LIGHT", { size: 60, fill: "#FFFFFF", anchor: "middle" }) +
        text(360, 1150, "A window is the best light you will ever own.", { size: 28, fill: NAVY, weight: 500, anchor: "middle" }));
    stillPush(still, abs, 360, 640, 12, 15, 31);
  },
  async short(abs, tmp) {
    const still = path.join(tmp, "short.png");
    await png(still, 720, 1280,
      `<rect width="720" height="1280" fill="${SAND}"/>` + windowLight(80, 300, 300, 440) +
        text(360, 900, ["Window light", "in 60 seconds"], { size: 72, fill: NAVY, anchor: "middle", lh: 84 }) +
        text(360, 1100, "Harbor and Pine", { size: 34, fill: PINE, weight: 600, anchor: "middle" }));
    stillPush(still, abs, 360, 640, 10, 15, 31);
  },
  async brollHarbor(abs, tmp) {
    const still = path.join(tmp, "harbor.png");
    await png(still, 1120, 360, harborScene(1120, 360));
    pan(still, abs, 640, 360, 6, 15, 480);
  },
  async brollDesk(abs, tmp) {
    const still = path.join(tmp, "desk.png");
    await png(still, 1040, 360, deskScene(1040, 360));
    pan(still, abs, 640, 360, 6, 15, 400);
  },
  async talkingHead(abs, tmp) {
    const bg = path.join(tmp, "th-bg.png");
    const fig = path.join(tmp, "th-fig.png");
    await png(bg, 640, 360, deskScene(640, 360));
    await png(fig, 240, 240, presenter(120, 80, 0.75));
    talking(bg, fig, abs, 8, 15, 330, 120);
  },
  async thumbnail(abs) {
    await jpeg(abs, 1280, 720,
      `<rect width="1280" height="720" fill="${NAVY}"/>` + windowLight(820, 120, 260, 360) + presenter(980, 420, 1.3, ORANGE) +
        text(70, 230, ["LIGHT", "BEATS"], { size: 150, fill: "#FFFFFF", lh: 160 }) +
        `<rect x="60" y="420" width="560" height="170" rx="16" fill="${ORANGE}"/>` + text(90, 555, "GEAR", { size: 150, fill: "#FFFFFF" }),
      80);
  },
  async mark(abs) {
    await png(abs, 512, 512,
      `<rect width="512" height="512" rx="96" fill="${NAVY}"/><path d="M256 92 L366 262 L316 262 L396 382 L116 382 L196 262 L146 262 Z" fill="${PINE}" stroke="#FFFFFF" stroke-width="10" stroke-linejoin="round"/>` +
        `<path d="M96 420 q40 -26 80 0 t80 0 t80 0 t80 0" stroke="${ORANGE}" stroke-width="16" fill="none" stroke-linecap="round"/>`);
  },
  async quote(abs) {
    await jpeg(abs, 1080, 1080,
      `<rect width="1080" height="1080" fill="${PINE}"/>` + text(90, 260, "“", { size: 220, fill: ORANGE }) +
        text(90, 420, ["The best light", "you will ever own", "is free. It's", "called a window."], { size: 84, fill: "#FFFFFF", lh: 100 }) +
        text(90, 940, "Harbor and Pine", { size: 40, fill: SAND, weight: 600 }));
  },
  async crumbBox(abs) {
    await jpeg(abs, 1080, 1350, staticAd({
      bg: "#F6E7D4", band: "#8C5E3C", brand: "Crumb and Crust Bakery", art: box(300, 380, 480, 300) + loaf(420, 330, 0.55) + loaf(660, 330, 0.55),
      headline: ["The weekend box", "feeds four for brunch"], sub: ["Two loaves, six pastries, jam.", "Order by Thursday night."], cta: "Order your box",
    }));
  },
  async crumbClass(abs) {
    await jpeg(abs, 1080, 1350, staticAd({
      bg: "#FFF4E6", band: "#8C5E3C", brand: "Crumb and Crust Bakery", art: loaf(540, 480, 1.4),
      headline: ["Bake real sourdough", "in one Sunday class"], sub: ["Small class, eight seats.", "Take your starter home."], cta: "Save a seat",
    }));
  },
  async crumbBefore(abs) {
    await jpeg(abs, 1080, 1080,
      `<rect width="1080" height="1080" fill="#EFE8DC"/>` + cake(540, 600, 1.4, false) + text(60, 110, "BEFORE", { size: 64, fill: "#6E6255" }) +
        text(60, 1010, "Plain layers, no frosting yet", { size: 38, fill: "#6E6255", weight: 400 }));
  },
  async crumbAfter(abs) {
    await jpeg(abs, 1080, 1080,
      `<rect width="1080" height="1080" fill="#FCEFF2"/>` + cake(540, 600, 1.4, true) + text(60, 110, "AFTER", { size: 64, fill: "#B0466B" }) +
        text(60, 1010, "Birthday cake, ready for pickup", { size: 38, fill: "#B0466B", weight: 400 }));
  },
  async crumbBaker(abs, tmp) {
    const bg = path.join(tmp, "bakery-bg.png");
    const fig = path.join(tmp, "baker-fig.png");
    await png(bg, 360, 640, bakeryScene(360, 640));
    await png(fig, 240, 300, presenter(120, 90, 0.8, "#FFFFFF"));
    talking(bg, fig, abs, 8, 15, 60, 250);
  },
  async ironFree(abs) {
    await jpeg(abs, 1080, 1350, staticAd({
      bg: "#E8EFE6", band: PINE, brand: "Ironleaf Fitness", art: dumbbell(540, 460, 1.6),
      headline: ["Your first class", "is free"], sub: ["No contract. No pressure.", "Small groups, real coaches."], cta: "Book a free class",
    }));
  },
  async ironReset(abs) {
    await jpeg(abs, 1080, 1350, staticAd({
      bg: "#1F2B26", band: ORANGE, brand: "Ironleaf Fitness", fg: "#FFFFFF",
      art: `<rect x="240" y="200" width="600" height="18" rx="9" fill="#BFC7C2"/>` + presenter(540, 400, 1.2, ORANGE),
      headline: ["Six weeks to your", "first real pull up"], sub: ["The Six Week Reset starts Monday.", "Three classes a week."], cta: "Join the reset",
    }));
  },
  async ironBroll(abs, tmp) {
    const still = path.join(tmp, "gym.png");
    await png(still, 1040, 360, gymScene(1040, 360));
    pan(still, abs, 640, 360, 6, 15, 400);
  },
  async spokeTune(abs) {
    await jpeg(abs, 1080, 1350, staticAd({
      bg: "#E9F0F5", band: NAVY, brand: "Spoke and Chain Cycles", art: bike(540, 560, 1.5, "#2C7DA0"),
      headline: ["Spring tune up", "in 48 hours"], sub: ["Brakes, gears, chain and tires.", "Or the tune up is free."], cta: "Book a tune up",
    }));
  },
  async spokeBeforeAfter(abs) {
    await jpeg(abs, 1080, 1080,
      `<rect width="540" height="1080" fill="#D9D4CC"/><rect x="540" width="540" height="1080" fill="#E9F0F5"/><rect x="532" width="16" height="1080" fill="#FFFFFF"/>` +
        bike(270, 600, 0.95, "#7D7D7D", true) + bike(810, 600, 0.95, "#2C7DA0") +
        text(40, 100, "BEFORE", { size: 60, fill: "#5E5A55" }) + text(580, 100, "AFTER", { size: 60, fill: NAVY }));
  },
};

/** Make every demo file under `outDir` (created; existing files are replaced). */
export async function makeDemoMedia(outDir: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "creative-studio-make-demo-"));
  try {
    for (const key of Object.keys(DEMO_PATHS) as DemoKey[]) {
      const abs = path.join(outDir, DEMO_PATHS[key]);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      await MAKERS[key](abs, tmp);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export type ManifestEntry = { path: string; bytes: number; sha256: string };
export type Manifest = { files: ManifestEntry[]; totalBytes: number };

/** Every regular file under `dir` (relative, sorted), skipping dotfiles. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

export function manifestOf(dir: string): Manifest {
  const files = listFiles(dir).map((rel) => {
    const buf = fs.readFileSync(path.join(dir, rel));
    return { path: rel, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
  });
  return { files, totalBytes: files.reduce((s, f) => s + f.bytes, 0) };
}

export function readManifest(file = DEMO_MANIFEST): Manifest {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
}

/** Differences between two manifests (empty = identical). */
export function manifestDiff(a: Manifest, b: Manifest): string[] {
  const out: string[] = [];
  const mb = new Map(b.files.map((f) => [f.path, f]));
  const ma = new Map(a.files.map((f) => [f.path, f]));
  for (const f of a.files) {
    const o = mb.get(f.path);
    if (!o) out.push(`only in the first: ${f.path}`);
    else if (o.sha256 !== f.sha256) out.push(`differs: ${f.path} (${f.bytes} vs ${o.bytes} bytes)`);
  }
  for (const f of b.files) if (!ma.has(f.path)) out.push(`only in the second: ${f.path}`);
  return out;
}

async function main() {
  const check = process.argv.includes("--check");
  if (check) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "creative-studio-demo-check-"));
    try {
      await makeDemoMedia(tmp);
      const diff = manifestDiff(readManifest(), manifestOf(tmp));
      if (diff.length) {
        console.error(`make-demo --check: ${diff.length} difference(s)\n  ${diff.join("\n  ")}`);
        process.exit(1);
      }
      console.log(`make-demo --check: the regenerated pack is byte identical to demo/manifest.json (${DEMO_FILES.length} files)`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  fs.rmSync(DEMO_MEDIA_DIR, { recursive: true, force: true });
  await makeDemoMedia(DEMO_MEDIA_DIR);
  const m = manifestOf(DEMO_MEDIA_DIR);
  fs.writeFileSync(DEMO_MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
  const mb = (m.totalBytes / 1024 / 1024).toFixed(2);
  console.log(`make-demo: ${m.files.length} files, ${mb} MB in demo/media (budget ${DEMO_MAX_BYTES / 1024 / 1024} MB)`);
  if (m.totalBytes > DEMO_MAX_BYTES) {
    console.error("make-demo: over budget");
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
