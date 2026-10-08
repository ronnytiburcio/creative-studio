/**
 * Spoken opening (server only): whisper.cpp over the first 15 s of a video's cached 480p proxy.
 *   proxy.mp4 (cache) -> ffprobe: any audio stream? -> ffmpeg: 15 s, 16 kHz mono wav (temp dir in the cache)
 *   -> whisper-cli (no timestamps, non-speech tokens suppressed) -> cleaned text.
 * Reads cache files only (never the drive). CLIs run with argument arrays, never a shell string.
 * No audio track or no speech is a normal outcome ("" = checked, nothing said), not an error.
 *
 * Phase 6 slice 2 adds the word-timed episode transcript (transcribeWords: the WHOLE proxy, one word per segment, JSON),
 * run by the worker's ShortMomentsQueue. Both uses share one lock (withWhisperLock), so the describe queue's openings
 * and an episode transcript never run whisper at the same time.
 */
import fs from "node:fs";
import path from "node:path";
import { lastLine, runCli } from "../gen/cli";

export const SPOKEN_OPEN_SECONDS = 15;

let whisperChain: Promise<unknown> = Promise.resolve();

/** Run `fn` when no other whisper run of this process is in flight (a simple FIFO lock). */
export function withWhisperLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = whisperChain.then(fn, fn);
  whisperChain = run.catch(() => undefined);
  return run;
}

export type SpokenOpening = { text: string; hasAudio: boolean; ms: number };

/** What the describe queue needs (the smoke test injects a fake). */
export interface SpokenOpeningAdapter {
  transcribeOpening(proxyPath: string, workDir: string): Promise<SpokenOpening>;
}

/**
 * Whisper's usual output on silence, music or room noise: bracketed / parenthesised non-speech tags anywhere
 * ("[BLANK_AUDIO]", "(music)", "[Applause]", "♪") and a few stock phrases when they are the whole transcript.
 */
const NON_SPEECH_TAG = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g;
const HALLUCINATED_WHOLE = new Set([
  "you",
  "thank you",
  "thank you so much",
  "thanks for watching",
  "thank you for watching",
  "thanks",
  "bye",
  "bye bye",
  "so",
  "oh",
  "um",
  "uh",
  "hmm",
  "okay",
]);

/** Strip non-speech tags and stock hallucinations; collapse whitespace. "" = no speech. */
export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(NON_SPEECH_TAG, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bare = text.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  if (!bare || HALLUCINATED_WHOLE.has(bare)) return "";
  return text;
}

export type WhisperStatus = { binFound: boolean; modelFound: boolean; bin: string; model: string };

function isExecutable(p: string) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Free check: are the whisper binary and model where the config says? */
export function whisperStatus(cfg: { whisperBin: string; whisperModel: string }): WhisperStatus {
  let modelFound = false;
  try {
    modelFound = fs.statSync(cfg.whisperModel).isFile();
  } catch {
    /* missing */
  }
  return { binFound: isExecutable(cfg.whisperBin), modelFound, bin: cfg.whisperBin, model: cfg.whisperModel };
}

export class WhisperCpp implements SpokenOpeningAdapter {
  constructor(
    private readonly opts: { bin: string; model: string; ffmpeg: string; ffprobe: string; seconds?: number },
  ) {}

  private async hasAudio(proxyPath: string): Promise<boolean> {
    const r = await runCli(
      this.opts.ffprobe,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", proxyPath],
      { timeoutMs: 30_000 },
    );
    if (r.code !== 0) throw new Error(`ffprobe: ${lastLine(r)}`);
    return r.stdout.trim().length > 0;
  }

  async transcribeOpening(proxyPath: string, workDir: string): Promise<SpokenOpening> {
    const started = Date.now();
    if (!(await this.hasAudio(proxyPath))) return { text: "", hasAudio: false, ms: Date.now() - started };
    fs.mkdirSync(workDir, { recursive: true });
    const wav = path.join(workDir, "opening.wav");
    const seconds = String(this.opts.seconds ?? SPOKEN_OPEN_SECONDS);
    const cut = await runCli(
      this.opts.ffmpeg,
      ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", proxyPath, "-t", seconds, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
      { timeoutMs: 60_000 },
    );
    if (cut.code !== 0 || !fs.existsSync(wav)) throw new Error(`ffmpeg audio cut: ${lastLine(cut)}`);
    // -nt: no timestamps, -np: only the text on stdout, -sns: suppress non-speech tokens. The .en model is English only.
    const r = await withWhisperLock(() =>
      runCli(this.opts.bin, ["-m", this.opts.model, "-f", wav, "-nt", "-np", "-sns", "-l", "en"], {
        timeoutMs: 180_000,
      }),
    );
    if (r.code !== 0) throw new Error(`whisper: ${lastLine(r)}`);
    return { text: cleanTranscript(r.stdout), hasAudio: true, ms: Date.now() - started };
  }
}

/** What the episode transcript needs (the smoke test points `bin` at a stub script). */
export type WordsRun = { json: string; hasAudio: boolean; ms: number; whisperMs: number };

/**
 * Word-timed transcript of a whole cached proxy: ffprobe (audio?) -> ffmpeg 16 kHz mono wav in `workDir` (under the
 * cache) -> whisper-cli `-ml 1 -sow -oj` (one word per segment, JSON) -> the JSON text. The caller deletes `workDir`.
 * Timeouts scale with the duration. Argument arrays only.
 */
export async function transcribeWords(
  opts: { bin: string; model: string; ffmpeg: string; ffprobe: string },
  proxyPath: string,
  workDir: string,
  durationS: number,
): Promise<WordsRun> {
  const started = Date.now();
  const probe = await runCli(opts.ffprobe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", proxyPath], {
    timeoutMs: 30_000,
  });
  if (probe.code !== 0) throw new Error(`ffprobe: ${lastLine(probe)}`);
  if (!probe.stdout.trim()) return { json: "", hasAudio: false, ms: Date.now() - started, whisperMs: 0 };
  fs.mkdirSync(workDir, { recursive: true });
  const wav = path.join(workDir, "episode.wav");
  const out = path.join(workDir, "words");
  const dur = Math.max(60, durationS || 0);
  const cut = await runCli(
    opts.ffmpeg,
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", proxyPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
    { timeoutMs: 60_000 + dur * 200 },
  );
  if (cut.code !== 0 || !fs.existsSync(wav)) throw new Error(`ffmpeg audio: ${lastLine(cut)}`);
  const w0 = Date.now();
  // -ml 1 -sow: one word per segment (the reel cut skill's caption recipe); -oj: JSON with ms offsets; -np: quiet; -sns: no
  // non-speech tokens. Up to 1 s of compute per second of audio before it is stopped (real runs take ~1/30 of that).
  const r = await withWhisperLock(() =>
    runCli(opts.bin, ["-m", opts.model, "-f", wav, "-l", "en", "-ml", "1", "-sow", "-oj", "-of", out, "-np", "-sns"], {
      timeoutMs: 120_000 + dur * 1000,
      maxStdout: 64 * 1024,
    }),
  );
  if (r.code !== 0) throw new Error(`whisper: ${lastLine(r)}`);
  const jsonPath = `${out}.json`;
  if (!fs.existsSync(jsonPath)) throw new Error("whisper wrote no JSON file");
  return { json: fs.readFileSync(jsonPath, "utf8"), hasAudio: true, ms: Date.now() - started, whisperMs: Date.now() - w0 };
}
