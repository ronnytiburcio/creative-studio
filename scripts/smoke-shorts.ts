/**
 * Phase 6 slice 1 smoke checks (called by scripts/smoke.ts; slice 2's are in smoke-shorts2.ts): the guarded text reader, SRT parsing, episode discovery
 * (the SRT stem is the key, the longest episode video in a folder is the master, other SRT names skipped, not prepped
 * folders, unreadable roots skipped, gone + back, the parse cache), the moment rules (snap + pad, sentence start / end,
 * 30 to 90 s, profanity, hook words, dashes, AI tells, overlap), the short_moments job end to end against a stub `claude`
 * script (args, env, retry under 3, zero survivors, timeout, Cancel / Retry / recover), cards + NSM `moment` hooks
 * (dedupe link, score request, scored by the HookScoreQueue with FakeJev), the board (rule B, columns, Keep / Discard,
 * k never reused, nudge, hook words, layout) and the actions' zod. A FRESH temp DB and temp folders standing in for the
 * episode folders: never the drive, never the real claude CLI, never Jev.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const NOW = Date.UTC(2026, 8, 30, 16, 0, 0);

/** 40 cues of 5 s. Sentence j spans cues 3j..3j+2 (so cues 0, 3, 6 ... start a sentence; 2, 5, 8 ... end one). */
export function fixtureCueTexts(): string[] {
  const t: string[] = [];
  for (let j = 0; j < 14; j++) {
    t.push(`Sentence ${j} starts with a clear point`, "and keeps going with more detail", `then lands the payoff number ${j}.`);
  }
  t.length = 40;
  t[39] = "Thanks for watching.";
  t[9] = "Uh, sentence 3 starts with a clear point"; // a filler the first line drops
  t[18] = "Sentence 6 has a dash — right here"; // a first line with an em dash
  t[21] = "Sentence 7 helps you leverage the budget"; // an AI tell in the first line
  t[30] = "Shit, sentence 10 starts badly"; // profanity in the first 3 s
  return t;
}

function srtTime(s: number) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * whisper-cli `-oj -ml 1 -sow` output for these cues: each cue's words spread evenly over its time (so the sentences of
 * the word transcript are the fixture's sentences: 15 s each, cue 39 alone), plus an empty and a non-speech segment.
 */
export function whisperJsonFor(cues: { start: number; end: number; text: string }[]): string {
  const segs: { offsets: { from: number; to: number }; text: string }[] = [{ offsets: { from: 0, to: 0 }, text: "" }];
  for (const c of cues) {
    const ws = c.text.split(/\s+/).filter(Boolean);
    const d = (c.end - c.start) / ws.length;
    ws.forEach((w, i) => segs.push({ offsets: { from: Math.round((c.start + i * d) * 1000), to: Math.round((c.start + (i + 1) * d) * 1000) }, text: ` ${w}` }));
  }
  const last = cues.length ? cues[cues.length - 1].end * 1000 : 0;
  segs.push({ offsets: { from: last, to: last }, text: " [BLANK_AUDIO]" });
  return JSON.stringify({ systeminfo: "stub", model: { type: "small" }, transcription: segs });
}

/** The fixture SRT: BOM, CRLF line ends, one cue split over two lines. */
export function fixtureSrt(): string {
  const texts = fixtureCueTexts();
  const blocks = texts.map((text, i) => {
    const body = i === 1 ? "and keeps going\r\nwith more detail" : ` ${text}`;
    return `${i + 1}\r\n${srtTime(i * 5)} --> ${srtTime(i * 5 + 5)}\r\n${body}`;
  });
  return `﻿${blocks.join("\r\n\r\n")}\r\n`;
}

export async function runShortsSmoke({ cfg, tmp, ok }: Ctx) {
  const { openDb } = await import("../src/lib/db");
  const textread = await import("../src/lib/textread");
  const srt = await import("../src/lib/shorts/srt");
  const rules = await import("../src/lib/shorts/rules");
  const episodes = await import("../src/lib/shorts/episodes");
  const moments = await import("../src/lib/shorts/moments");
  const board = await import("../src/lib/shorts/board");
  const hookStore = await import("../src/lib/hooks/store");
  const { Engine } = await import("../src/worker/engine");
  const { ShortMomentsQueue } = await import("../src/worker/shorts");
  const { HookScoreQueue } = await import("../src/worker/hooks");
  const { FakeJev } = await import("../src/lib/ai/fake");
  const { Jev } = await import("../src/lib/ai/jev");
  const { parseHookFilters } = await import("../src/lib/hooks/queries");

  const db = openDb(path.join(tmp, "shorts.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const quiet = () => {};

  // ---------------------------------------------------------------- SRT parsing
  const cues = srt.parseSrt(fixtureSrt());
  assert.equal(cues.length, 40, "40 cues (BOM + CRLF tolerated)");
  assert.deepEqual(cues[1], { start: 5, end: 10, text: "and keeps going with more detail" }, "a two-line cue is joined with a space");
  assert.equal(cues[0].text, "Sentence 0 starts with a clear point", "BOM and leading space gone");
  const odd = srt.parseSrt("2\n00:00:05.5 --> 00:00:07.25\n<i>later</i>\n\n1\n00:00:01,000 --> 00:00:03,000\nfirst\n\n3\n00:00:09,000 --> 00:00:10,000\n\n\nno times here\n");
  assert.deepEqual(
    odd.map((c) => [c.start, c.end, c.text]),
    [
      [1, 3, "first"],
      [5.5, 7.25, "later"],
    ],
    "sorted by start, '.' millis, tags stripped, a cue without text and a block without times dropped",
  );
  assert.deepEqual(srt.unpackCues(srt.packCues(cues)), cues, "pack / unpack round trip");
  assert.deepEqual([srt.startsSentence(cues, 0), srt.startsSentence(cues, 3), srt.startsSentence(cues, 4), srt.endsSentence(cues[2]), srt.endsSentence(cues[3])], [true, true, false, true, false]);
  ok("SRT parse: BOM, CRLF, multi-line cues joined, '.' or ',' millis, tags stripped, empty / broken blocks dropped, sorted; sentence start / end marks; packed form round trips");

  // ---------------------------------------------------------------- snapping + pad
  assert.equal(srt.startCueIndex(cues, 15), 3, "a start on a cue start");
  assert.equal(srt.startCueIndex(cues, 17.9), 3, "a start inside a cue snaps back to its start");
  assert.equal(srt.startCueIndex(cues, 19.7), 4, "a start within 0.5 s before a cue means that cue");
  assert.equal(srt.endCueIndex(cues, 60), 11, "an end on a cue end");
  assert.equal(srt.endCueIndex(cues, 57.2), 11, "an end inside a cue snaps forward to its end");
  assert.equal(srt.endCueIndex(cues, 55.3), 10, "an end within 0.5 s after a cue end means that cue");
  assert.deepEqual(srt.snapMoment(cues, 15, 60, 205), { startCue: 3, endCue: 11, start: 14.8, end: 60.2, duration: 45.4 }, "0.2 s pad each side");
  assert.deepEqual([srt.padCues(cues, 0, 8, 205).start, srt.padCues(cues, 30, 39, 200).end], [0, 200], "the pad is clamped to the episode");
  assert.deepEqual(srt.cuesOfMoment(cues, 14.8, 60.2), { startCue: 3, endCue: 11 }, "stored times map back to their cues");
  assert.equal(srt.overlapShare({ start: 0, end: 40 }, { start: 20, end: 100 }), 0.5, "overlap = share of the shorter clip");
  assert.equal(srt.cleanSpoken("Uh, so they're doing, uh, the meta um ads"), "so they're doing, the meta ads");
  ok("snapping: start = the cue start at / just before (0.5 s tolerance), end = the cue end at / just after, 0.2 s pad clamped to the episode, stored times map back to cues; overlap share; fillers out");

  // ---------------------------------------------------------------- guarded text reader
  const rootDir = path.join(tmp, "shorts-root");
  const outside = path.join(tmp, "shorts-outside");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const folder1 = path.join(rootDir, "Demo One");
  const folder2 = path.join(rootDir, "Demo Two "); // a trailing space, like `NC Garden Renovation Ad `
  const folder3 = path.join(rootDir, "Not Prepped");
  for (const f of [folder1, folder2, folder3]) fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(folder1, "NSM Ep1.srt"), fixtureSrt());
  fs.writeFileSync(path.join(folder1, "NSM Ep1 Reel 1.srt"), fixtureSrt());
  fs.writeFileSync(path.join(folder1, "NSM Ep1 take1303.srt"), fixtureSrt());
  fs.writeFileSync(path.join(folder1, "NSM Ep1 transcript.txt"), "plain text");
  fs.writeFileSync(path.join(folder2, "NSM Ep2.srt"), fixtureSrt());
  fs.writeFileSync(path.join(outside, "evil.srt"), fixtureSrt());
  fs.writeFileSync(path.join(rootDir, "master.mov"), "not text");
  const bases = [rootDir];
  assert.equal(textread.readGuardedText(path.join(folder1, "NSM Ep1.srt"), bases).text.startsWith("1\r\n"), true, "inside the root: read, BOM removed");
  assert.throws(() => textread.readGuardedText(path.join(outside, "evil.srt"), bases), /Outside the enabled roots/, "a path outside the roots");
  assert.throws(() => textread.readGuardedText(path.join(folder1, "..", "..", "shorts-outside", "evil.srt"), bases), /Outside/, "a .. escape");
  fs.symlinkSync(path.join(outside, "evil.srt"), path.join(folder1, "NSM Ep8.srt"));
  assert.throws(() => textread.readGuardedText(path.join(folder1, "NSM Ep8.srt"), bases), /Outside/, "a symlink out of the root");
  fs.symlinkSync(path.join(rootDir, "master.mov"), path.join(rootDir, "sneaky.srt"));
  assert.throws(() => textread.readGuardedText(path.join(rootDir, "sneaky.srt"), bases), /not a \.srt/, "a .srt symlink to a video");
  assert.throws(() => textread.readGuardedText(path.join(rootDir, "master.mov"), bases), /\.srt \/ \.txt only/, "a wrong extension");
  assert.throws(() => textread.readGuardedText(path.join(folder1, "NSM Ep1 transcript.txt"), bases, [".srt"]), /only/, "the episode sync reads .srt only");
  fs.writeFileSync(path.join(rootDir, "huge.srt"), Buffer.alloc(textread.TEXT_MAX_BYTES + 1, 0x41));
  assert.throws(() => textread.readGuardedText(path.join(rootDir, "huge.srt"), bases), /Larger than 2 MB/, "over 2 MB");
  assert.throws(() => textread.readGuardedText("relative/NSM Ep1.srt", bases), /Outside/, "a relative path");
  assert.ok(!textread.listGuardedDir(outside, bases).length && textread.listGuardedDir(folder1, bases).includes("NSM Ep1.srt"), "folder listings are guarded too");
  fs.rmSync(path.join(rootDir, "huge.srt"));
  ok("guarded text reader: inside an enabled root only (outside, .. and symlink escapes refused), .srt / .txt only on the path AND its real path (a .srt symlink to a video refused), 2 MB cap before reading, read only; listings guarded");

  // ---------------------------------------------------------------- episode discovery
  const NSM = s.prepare("select id from sections where key = 'rtm'").pluck().get() as number;
  s.prepare("update roots set enabled = 0").run(); // the seeded roots point at the real drive: never read here
  const root = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(rootDir, NSM).lastInsertRowid);
  // A root under the stand-in drive (a plain folder = "not mounted" for the smoke): unreadable, so skipped.
  const lockedDir = path.join(cfg.drivePath, "NSM Locked");
  fs.mkdirSync(path.join(lockedDir, "Ep Nine"), { recursive: true });
  fs.writeFileSync(path.join(lockedDir, "Ep Nine", "NSM Ep9.srt"), fixtureSrt());
  const lockedRoot = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(lockedDir, NSM).lastInsertRowid);
  const insAsset = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status, duration_s, sha256, asset_class, thumb_path)
     values (?, ?, ?, ?, ?, 'mov', 'video', 1, 1, 1, 'done', ?, ?, ?, ?)`,
  );
  const asset = (rootId: number, base: string, rel: string, dur: number, cls: string | null) =>
    Number(insAsset.run(NSM, rootId, path.join(base, rel), rel, path.basename(rel), dur, `sha-${rel}`, cls, "abc/thumb.webp").lastInsertRowid);
  const master1 = asset(root, rootDir, "Demo One/Northstar Media Ep. 9.mov", 205, "episode");
  asset(root, rootDir, "Demo One/teaser.mov", 31, "episode"); // shorter: not the master
  asset(root, rootDir, "Demo One/b-roll.mov", 400, null); // not an episode
  const master2 = asset(root, rootDir, "Demo Two /Northstar Media Ep.2.mov", 205, "episode");
  const master3 = asset(root, rootDir, "Not Prepped/NSM Ep10.mov", 300, "episode");
  asset(lockedRoot, lockedDir, "Ep Nine/NSM Ep9.mov", 205, "episode");
  const drive = { drivePath: cfg.drivePath, fakeUnmounted: false, driveMode: cfg.driveMode };
  const r1 = episodes.syncEpisodes(s, drive, NOW);
  const all = episodes.listEpisodes(s);
  const eps = all.filter((e) => e.cueCount > 0);
  assert.deepEqual(
    eps.map((e) => [e.label, e.masterAssetId, e.cueCount, e.durationS]),
    [
      ["Ep1 · Demo One", master1, 40, 205],
      ["Ep2 · Demo Two", master2, 40, 205],
    ],
    "the SRT stem names the episode; the longest episode video is the master; the folder name is trimmed",
  );
  assert.equal(r1.errors.length, 1, "the symlinked NSM Ep8.srt is refused (recorded, not read)");
  assert.match(all.find((e) => e.num === 8)?.readError ?? "", /Outside/, "listed with its reason (the picker shows it disabled)");
  assert.ok(!s.prepare("select 1 from episodes where stem like '%Reel%' or stem like '%take%' or num = 9").get(), "Reel / take SRTs and the unreadable root's episode are skipped");
  assert.deepEqual(episodes.notPreppedFolders(s, drive).map((f) => [f.title, f.masterAssetId]), [["Not Prepped", master3]], "a master folder without NSM EpN.srt: Not prepped yet (an unreadable root's folder is not listed)");
  fs.rmSync(path.join(folder1, "NSM Ep8.srt"));
  const r2 = episodes.syncEpisodes(s, drive, NOW + 1);
  assert.equal(r2.read, 0, "unchanged SRTs are not read again (size + mtime cache)");
  assert.ok(s.prepare("select gone_at from episodes where stem = 'NSM Ep8'").pluck().get(), "a vanished SRT is marked gone (its root is readable)");
  const ep1 = eps[0].id;
  const ep2 = eps[1].id;
  // Gone and back: the row (and its id) survives.
  fs.renameSync(path.join(folder2, "NSM Ep2.srt"), path.join(folder2, "NSM Ep2.srt.bak"));
  episodes.syncEpisodes(s, drive, NOW + 2);
  assert.deepEqual(episodes.listEpisodes(s).map((e) => e.id), [ep1], "gone = hidden");
  fs.renameSync(path.join(folder2, "NSM Ep2.srt.bak"), path.join(folder2, "NSM Ep2.srt"));
  fs.utimesSync(path.join(folder2, "NSM Ep2.srt"), new Date(), new Date(Date.now() + 5000));
  const r3 = episodes.syncEpisodes(s, drive, NOW + 3);
  assert.deepEqual([episodes.listEpisodes(s).map((e) => e.id), r3.read], [[ep1, ep2], 1], "back with the same id; a new mtime is read again");
  // The drive "unplugged": the locked root's episodes are never marked gone (there are none here) and nothing is read.
  assert.equal(s.prepare("select count(*) from episodes where folder like ?").pluck().get(`${lockedDir}%`), 0);
  ok("episodes: NSM EpN.srt stem = the episode, paired with the longest episode video in its folder (trailing space trimmed), Reel / take / Short SRTs skipped, a refused SRT recorded with its reason, not prepped folders listed, an unreadable root skipped, size + mtime cache, gone and back keeps the id");

  // ---------------------------------------------------------------- moment rules (pure)
  const clients = s.prepare("select c.code, c.name, c.brand_notes as brandNotes from clients c join sections x on x.id = c.section_id where x.key = 'fkbpros'").all() as {
    code: string;
    name: string;
    brandNotes: string | null;
  }[];
  const overlay = rules.overlayRules(clients);
  const ctxOf = (taken: { start: number; end: number }[] = []) => ({ cues, episodeEnd: 205, taken, overlay });
  const m = (start: number, end: number, hook = "THE MISTAKE EVERYONE MAKES", why = "A clean teardown.", layout = "stack") => ({ start, end, firstLine: "ignored", hook, why, layout });
  const good = rules.checkMoment(m(15, 60), ctxOf());
  assert.ok(good.ok);
  assert.deepEqual(
    good.ok && [good.moment.start, good.moment.end, good.moment.firstLine, good.moment.hookWords, good.moment.layout],
    [14.8, 60.2, "Sentence 1 starts with a clear point and keeps going with more detail then lands the payoff number 1.", "THE MISTAKE EVERYONE MAKES", "stack"],
    "snapped + padded; first line = the transcript's first sentence at the start, not claude's",
  );
  const filler = rules.checkMoment(m(45, 90), ctxOf());
  assert.equal(filler.ok && filler.moment.firstLine, "Sentence 3 starts with a clear point and keeps going with more detail then lands the payoff number 3.", "whisper's filler dropped");
  const why = (v: ReturnType<typeof rules.checkMoment>) => (v.ok ? "ok" : v.rule);
  assert.deepEqual(
    [
      why(rules.checkMoment(m(20, 60), ctxOf())),
      why(rules.checkMoment(m(15, 50), ctxOf())),
      why(rules.checkMoment(m(0, 15), ctxOf())),
      why(rules.checkMoment(m(15, 150), ctxOf())),
      why(rules.checkMoment(m(90, 300), ctxOf())),
      why(rules.checkMoment(m(150, 195), ctxOf())),
      why(rules.checkMoment(m(90, 135), ctxOf())),
      why(rules.checkMoment(m(105, 150), ctxOf())),
      why(rules.checkMoment(m(15, 60, "GAME-CHANGER ADS"), ctxOf())),
      why(rules.checkMoment(m(15, 60, "ADS"), ctxOf())),
      why(rules.checkMoment(m(15, 60, "WHY TEXAS ADS FAIL"), ctxOf())),
      why(rules.checkMoment(m(15, 60, "THE MISTAKE", "We delve into it."), ctxOf())),
      why(rules.checkMoment(m(15, 60, "THE MISTAKE", "Short — punchy."), ctxOf())),
      why(rules.checkMoment(m(16, 59), ctxOf([{ start: 14.8, end: 60.2 }]))),
      why(rules.checkMoment(m(NaN, 60), ctxOf())),
    ],
    ["start", "end", "length", "length", "outside", "profanity", "copy", "copy", "hook", "hook", "hook", "copy", "copy", "overlap", "times"],
    "mid sentence start / end, under 30 / over 90 s, outside the episode, profanity in 3 s, a dash or an AI tell in the first line or why, hook hyphen / 1 word / a state, overlap with a live card, no times",
  );
  const lay = rules.checkMoment(m(15, 60, "the mistake everyone makes.", "ok", "vertical"), ctxOf());
  assert.deepEqual(lay.ok && [lay.moment.hookWords, lay.moment.layout], ["THE MISTAKE EVERYONE MAKES", "stack"], "hook in caps without outer punctuation; an unknown layout falls back to stack");
  ok("moment checks: inside the episode, start on a sentence-start cue, end on a sentence-end cue, 30 to 90 s after the snap, no profanity in the first 3 s, first line from the transcript, hook 2 to 5 caps words under NSM's rules (no hyphen, no AI tell, no state / client), no dash or AI tell in first line or why, >= 50% overlap dropped");

  // ---------------------------------------------------------------- word-timed transcripts (slice 2): moments snap to sentences
  // Stored directly here (the transcriber itself runs against a stub whisper in scripts/smoke-shorts2.ts).
  const transcript = await import("../src/lib/shorts/transcript");
  const giveWords = (epId: number, masterId: number) =>
    transcript.storeWords(
      s,
      { episodeId: epId, num: 0, label: "", assetId: masterId, sha256: s.prepare("select sha256 from assets where id = ?").pluck().get(masterId) as string, proxyPath: "x", durationS: 205 },
      whisperJsonFor(cues),
      "ggml-small.en.bin",
      1000,
      NOW,
    );
  assert.deepEqual(giveWords(ep1, master1), { words: cues.reduce((n, c) => n + c.text.split(/\s+/).length, 0), sentences: 14, source: "srt", aligned: 1 }, "14 sentences (13 of 15 s + the sign off), the SRT text on the words times");
  giveWords(ep2, master2);
  assert.equal(episodes.getEpisode(s, ep1)!.sentences!.length, 14);

  // ---------------------------------------------------------------- the stub claude + the job
  const stubDir = path.join(tmp, "shorts-claude-stub");
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, "claude");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
D='${stubDir}'
N=$(cat "$D/count" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "$D/count"
printf '%s\\n' "$@" > "$D/args-$N.txt"
/usr/bin/env > "$D/env-$N.txt"
pwd > "$D/cwd-$N.txt"
MODE=$(head -n 1 "$D/queue"); tail -n +2 "$D/queue" > "$D/queue.next"; mv "$D/queue.next" "$D/queue"
case "$MODE" in
  sleep) sleep 20 ;;
  badjson) echo "I could not do that." ;;
  *) cat "$D/$MODE.json" ;;
esac
`,
  );
  fs.chmodSync(stub, 0o755);
  const savedBin = process.env.CLAUDE_BIN;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_BIN = stub;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-claude";
  const answer = (list: Record<string, unknown>[]) =>
    JSON.stringify({
      type: "result",
      is_error: false,
      duration_ms: 9000,
      result: JSON.stringify({ moments: list }),
      usage: { input_tokens: 3, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 7000 },
      modelUsage: { "claude-haiku-4-5": { outputTokens: 4 }, "claude-opus-5": { outputTokens: 900 } },
    });
  const mo = (start: number, end: number, hook: string, extra: Record<string, unknown> = {}) => ({ start, end, first_line: "x", hook, why: "It stands alone.", layout: "stack", ...extra });
  fs.writeFileSync(
    path.join(stubDir, "good.json"),
    answer([
      mo(15, 60, "THE MISTAKE EVERYONE MAKES"),
      mo(75, 120, "WHY THE NUMBER WINS", { layout: "center" }),
      mo(120.2, 165, "THE PAYOFF IN 45 SECONDS"),
      mo(16, 59, "SAME MOMENT AGAIN"), // overlap with the first
      mo(20, 60, "STARTS MID SENTENCE"),
      mo(30, 75, "GAME-CHANGER ADS"),
      mo(0, 15, "TOO SHORT"),
      mo(90, 300, "PAST THE END"),
      mo(150, 195, "BAD WORD FIRST"),
      mo(90, 135, "DASH IN THE LINE"),
      mo(45, 90, "THE PAYOFF AGAIN", { why: "We delve into the payoff." }),
    ]),
  );
  fs.writeFileSync(path.join(stubDir, "one.json"), answer([mo(15, 60, "ONE GOOD MOMENT"), mo(20, 60, "MID SENTENCE")]));
  fs.writeFileSync(path.join(stubDir, "two.json"), answer([mo(75, 120, "SECOND GOOD MOMENT"), mo(165, 200, "THE LAST ONE"), mo(16, 59, "OVERLAPS THE KEPT ONE")]));
  fs.writeFileSync(path.join(stubDir, "none.json"), answer([mo(20, 60, "MID SENTENCE")]));
  fs.writeFileSync(path.join(stubDir, "few.json"), answer([mo(120.2, 165, "ONLY ONE LEFT")]));
  const queueStub = (...modes: string[]) => fs.writeFileSync(path.join(stubDir, "queue"), modes.join("\n") + "\n");
  const stubCalls = () => Number(fs.readFileSync(path.join(stubDir, "count"), "utf8").trim() || 0);
  const shortsEngine = (timeoutMs = 15_000) => new Engine({ cfg, db, log: quiet, shorts: { timeoutMs } });
  const jobOf = (jid: number) =>
    s.prepare("select status, error, result, log_path from jobs where id = ?").get(jid) as { status: string; error: string | null; result: string | null; log_path: string };

  // An NSM hook that already has the second moment's first line: the card links to it instead of making one.
  const line2 = "Sentence 5 starts with a clear point and keeps going with more detail then lands the payoff number 5.";
  const existing = hookStore.addTextHooks(s, { section: "rtm", clientCode: null }, [{ text: line2, source: "manual" }], NOW).ids[0];
  hookStore.setHooksPaused(s, true);

  queueStub("good");
  const job1 = moments.queueMoments(s, ep1, NOW);
  assert.throws(() => moments.queueMoments(s, ep1, NOW), /already being written/, "one active job per episode");
  assert.throws(() => moments.queueMoments(s, 99999, NOW), /not available/, "an unknown episode is refused");
  assert.equal((await shortsEngine().drainShorts())?.done, 1, "the engine runs the job (worker wiring)");
  const args1 = fs.readFileSync(path.join(stubDir, "args-1.txt"), "utf8").split("\n");
  for (const flag of ["-p", "--output-format", "--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--safe-mode", "--no-session-persistence", "--disable-slash-commands", "--system-prompt"]) {
    assert.ok(args1.includes(flag), `claude gets ${flag}`);
  }
  assert.equal(args1[args1.indexOf("--tools") + 1], "", "--tools \"\"");
  assert.equal(args1[args1.indexOf("--system-prompt") + 1], moments.momentsSystemPrompt(), "the moments system prompt");
  assert.ok(!args1.some((a) => /dangerously|skip-permissions/.test(a)), "never --dangerously-skip-permissions");
  const env1 = fs.readFileSync(path.join(stubDir, "env-1.txt"), "utf8");
  assert.ok(!/ANTHROPIC|API_KEY|TYPESAFE/.test(env1), "no API key in claude's env");
  assert.deepEqual(
    env1.split("\n").filter(Boolean).map((l) => l.split("=")[0]).filter((k) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(k)).sort(),
    ["HOME", "LANG", "LOGNAME", "NODE_ENV", "PATH", "TMPDIR", "USER"],
  );
  assert.ok(fs.readFileSync(path.join(stubDir, "cwd-1.txt"), "utf8").trim().startsWith(path.join(fs.realpathSync(cfg.cacheDir), "claude-tmp")), "cwd under STUDIO_CACHE");
  const prompt1 = args1.slice(args1.indexOf("--system-prompt") + 2).join("\n");
  for (const bit of ["Ep1 · Demo One", "30 to 60 seconds", "before and after reveal", "No profanity in the first 3 seconds", "14 sentences", "#2 [15.0-30.0] Sentence 1 starts with a clear point", "#4 [45.0-60.0] sentence 3 starts", '{"moments"', "stack", "delve"]) {
    assert.ok(prompt1.includes(bit), `prompt has: ${bit}`);
  }
  const j1 = jobOf(job1);
  const res1 = JSON.parse(j1.result!) as { survivors: number[]; attempts: { returned: number; kept: number; model: string; dropped: { rule: string }[] }[] };
  assert.deepEqual([j1.status, res1.attempts.length, res1.attempts[0].returned, res1.attempts[0].kept, res1.attempts[0].model], ["done", 1, 11, 3, "claude-opus-5"]);
  assert.deepEqual(
    res1.attempts[0].dropped.map((d) => d.rule),
    ["overlap", "overlap", "hook", "length", "outside", "profanity", "copy", "copy"],
    "every drop recorded with its rule (a start inside a sentence snaps to that sentence's start: here it overlaps the first)",
  );
  assert.equal(path.basename(j1.log_path), `short-moments-${job1}.log`);
  assert.match(fs.readFileSync(j1.log_path, "utf8"), /dropped .*shares half or more/);
  assert.match(fs.readFileSync(j1.log_path, "utf8"), /14 sentences \(word-timed transcript\)/);
  const cards = s.prepare("select * from shorts where job_id = ? order by k").all(job1) as {
    id: number; k: number; start_s: number; end_s: number; first_line: string; hook_words: string; layout: string; status: string; kept: number | null; hook_id: number; hook_owned: number;
  }[];
  assert.deepEqual(
    cards.map((c) => [c.k, c.start_s, c.end_s, c.layout, c.status, c.kept]),
    [
      [1, 14.8, 60.2, "stack", "idea", null],
      [2, 74.8, 120.2, "center", "idea", null],
      [3, 119.8, 165.2, "stack", "idea", null],
    ],
    "3 undecided Idea cards numbered 1..3",
  );
  const hk = (id: number) => s.prepare("select id, section_id, client_id, kind, text, source, score_requested_at, archived_at from hooks where id = ?").get(id) as {
    id: number; section_id: number; client_id: number | null; kind: string; text: string; source: string; score_requested_at: number | null; archived_at: number | null;
  };
  assert.deepEqual([hk(cards[0].hook_id).section_id, hk(cards[0].hook_id).client_id, hk(cards[0].hook_id).kind, hk(cards[0].hook_id).source, cards[0].hook_owned], [NSM, null, "text", "moment", 1]);
  assert.equal(hk(cards[0].hook_id).text, cards[0].first_line);
  assert.ok(hk(cards[0].hook_id).score_requested_at && hk(cards[2].hook_id).score_requested_at, "new moment hooks are requested for scoring");
  assert.deepEqual([cards[1].hook_id, cards[1].hook_owned], [existing, 0], "an equal NSM hook is linked, not duplicated");
  assert.ok(hk(existing).score_requested_at, "a linked hook that was never scored is asked for");
  ok("short_moments job (stub claude): -p, JSON, no tools / MCP / settings, safe mode, no session, the moments system prompt, never skip-permissions, minimal env (no API key), cwd under the cache; prompt = rules + the word-timed transcript's sentences; 3 of 11 kept (each drop's rule recorded + logged), Idea cards k 1..3, NSM `moment` text hooks requested for scoring, an equal NSM hook linked instead");

  // Scored by the existing HookScoreQueue (FakeJev): requests run while scoring is paused; NSM dimensions.
  const fj = new FakeJev();
  fj.respond = (id, _q, state) => {
    const text = JSON.stringify(state);
    if (id === "pp_person" || id === "pp_pain" || id === "pp_promise") return { noul: text.includes("payoff number 5") && id === "pp_pain" ? 0.1 : 0.9 };
    if (id === "specificity") return { score: text.includes("payoff number 5.") ? 4 : text.includes("payoff number 1.") ? 1 : 3 };
    return undefined;
  };
  const jev = new Jev(s, fj, "jev-1.13.0", { sleep: async () => {} });
  const hq = new HookScoreQueue(s, { jev, log: quiet, isStopped: () => false, idleMs: 5 });
  await hq.drain();
  assert.equal(fj.requests.length, 3, "the three moment hooks were scored (once each) while scoring is paused");
  assert.ok(fj.requests.every((r) => (r.state as { channel: { section: string } }).channel.section === "NSM (Northstar Media)"), "on the NSM channel");
  assert.ok(!Object.keys(fj.requests[0].questions).includes("offer_clarity"), "NSM dimensions (no Offer clarity)");
  const b1 = board.boardData(s);
  assert.deepEqual([b1.undecided, b1.columns.idea.length, b1.columns.cutting.length], [3, 3, 0]);
  assert.deepEqual(
    b1.columns.idea.map((c) => c.k),
    [3, 1, 2],
    "rule B: all three P's clear first by overall (k3 over k1), then the one missing Pain (k2) even with the highest overall",
  );
  assert.ok(b1.columns.idea.every((c) => c.score && !c.scoring && c.episode === "Ep1 · Demo One" && c.master?.assetId === master1));
  assert.deepEqual(b1.columns.idea[2].score!.missing, ["pp_pain"]);
  assert.equal(parseHookFilters({ source: "moment" }).source, "moment", "the Hooks tab Source filter takes `moment` (From an episode)");
  assert.equal(s.prepare(`select count(*) from hooks h join sections x on x.id = h.section_id where x.key = 'rtm' and h.source = 'moment' and ${hookStore.HOOK_LIVE}`).pluck().get(), 2, "two live NSM moment hooks");
  ok("moment hooks scored by the HookScoreQueue (FakeJev, NSM dimensions, on request while paused); the board's Idea column sorts by rule B; the Hooks tab Source filter finds them");

  // ---------------------------------------------------------------- the board: keep / discard / k / status / nudge / words / layout
  const [c1, c2, c3] = cards;
  assert.equal(board.keepShort(s, c1.id, NOW + 10), true);
  assert.equal(board.keepShort(s, c1.id, NOW + 11), false, "already decided");
  assert.equal(board.discardShort(s, c3.id, NOW + 12), true);
  assert.ok(hk(c3.hook_id).archived_at, "Discard archives the hook made for the card");
  assert.equal(board.discardShort(s, c2.id, NOW + 13), true);
  assert.equal(hk(existing).archived_at, null, "a hook the card only linked to is left alone");
  assert.deepEqual([board.boardData(s).columns.idea.map((c) => c.id), board.boardData(s).undecided], [[c1.id], 0], "discarded cards leave the board");
  assert.throws(() => board.setShortStatus(s, c3.id, "cutting"), /discarded/);
  // k is never reused: card 3 was the highest and is discarded; the next job numbers from 4.
  queueStub("two", "none");
  const job2 = moments.queueMoments(s, ep1, NOW + 20);
  await shortsEngine().drainShorts();
  const ks2 = s.prepare("select k, start_s from shorts where job_id = ? order by k").all(job2) as { k: number; start_s: number }[];
  assert.ok(ks2.length >= 1 && ks2[0].k === 4, `k continues after the discarded #3 (got ${ks2.map((x) => x.k).join(",")})`);
  const prompt2 = fs.readFileSync(path.join(stubDir, `args-${stubCalls()}.txt`), "utf8");
  assert.match(prompt2, /Moments already on the board[^\n]*\n- 14\.8 to 60\.2 s: THE MISTAKE EVERYONE MAKES/, "live cards are listed so claude avoids them");
  assert.ok(!/119\.8 to 165\.2/.test(prompt2.split("## For each moment")[0]), "a discarded card is not");
  // Moves by hand, any direction; leaving Idea marks an undecided card kept.
  const c4 = s.prepare("select id from shorts where job_id = ? order by k limit 1").pluck().get(job2) as number;
  assert.equal(board.setShortStatus(s, c4, "review", NOW + 30), true);
  assert.deepEqual([board.getCard(s, c4)!.status, board.getCard(s, c4)!.kept], ["review", true]);
  board.setShortStatus(s, c4, "cutting", NOW + 31);
  board.setShortStatus(s, c1.id, "posted", NOW + 32);
  board.setShortStatus(s, c1.id, "idea", NOW + 33);
  const b2 = board.boardData(s);
  assert.deepEqual([b2.columns.cutting.map((c) => c.id), b2.columns.idea.some((c) => c.id === c1.id)], [[c4], true], "any column, any direction");
  // Hook words + layout.
  assert.equal(board.setShortHookWords(s, c1.id, "  stop the scroll fast. "), "STOP THE SCROLL FAST");
  assert.throws(() => board.setShortHookWords(s, c1.id, "stop"), /1 word/);
  assert.throws(() => board.setShortHookWords(s, c1.id, "follow-up wins"), /hyphen/i);
  assert.throws(() => board.setShortHookWords(s, c1.id, "unlock more leads"), /AI tell/);
  assert.equal(board.setShortLayout(s, c1.id, "blurfill"), true);
  ok("board: Keep, Discard (owned hook archived, a linked hook left alone), discarded cards gone and frozen, k never reused (next job starts at 4), live cards fed to the next prompt, status moved by hand any direction (leaving Idea = kept), hook words normalized to caps under NSM's rules, layout");

  // Nudge (slice 1 rule, kept for an episode without a word transcript): one cue at a time. The words are made
  // not current for this block (a version mismatch), so the board falls back to the SRT cues.
  s.prepare("update episodes set words_version = 0 where id = ?").run(ep1);
  assert.equal(board.getCard(s, c1.id)!.nudgeUnit, "cue");
  const before = hk(c1.hook_id);
  s.prepare("update hooks set score_requested_at = null where id = ?").run(c1.hook_id);
  const n1 = board.nudgeShort(s, c1.id, "start", -1, NOW + 40);
  assert.deepEqual([n1.start, n1.end, n1.firstLine, n1.hookChanged], [9.8, 60.2, "Then lands the payoff number 0.", true]);
  const after = hk(c1.hook_id);
  assert.deepEqual([after.id, after.text, Boolean(after.score_requested_at)], [before.id, n1.firstLine, true], "the card's own hook takes the new line and is requested again");
  const n2 = board.nudgeShort(s, c1.id, "end", 1, NOW + 41);
  assert.deepEqual([n2.end, n2.hookChanged, board.getCard(s, c1.id)!.firstLine], [65.2, false, n1.firstLine], "end +1 cue: same first line");
  board.nudgeShort(s, c1.id, "end", -1, NOW + 42);
  assert.throws(() => {
    for (let i = 0; i < 10; i++) board.nudgeShort(s, c1.id, "end", -1, NOW + 43 + i);
  }, /a moment is 30 to 90 s/, "never under 30 s");
  // The first cue is the limit.
  for (let i = 0; i < 2; i++) board.nudgeShort(s, c1.id, "start", -1, NOW + 61 + i);
  assert.throws(() => board.nudgeShort(s, c1.id, "start", -1, NOW + 70), /first cue/);
  // A card linked to someone else's hook gets a new hook of its own when its first line changes.
  const linkedCard = s.prepare("select id, hook_id from shorts where hook_owned = 0 and archived_at is null limit 1").get() as { id: number; hook_id: number } | undefined;
  assert.ok(linkedCard, "the card linked to the existing hook is still on the board");
  {
    board.nudgeShort(s, linkedCard.id, "start", -1, NOW + 80);
    const nowCard = s.prepare("select hook_id, hook_owned from shorts where id = ?").get(linkedCard.id) as { hook_id: number; hook_owned: number };
    assert.ok(nowCard.hook_id !== linkedCard.hook_id && nowCard.hook_owned === 1 && hk(linkedCard.hook_id).archived_at == null, "a linked hook is never edited");
  }
  s.prepare("update episodes set words_version = ? where id = ?").run((await import("../src/lib/shorts/words")).WORDS_VERSION, ep1);
  // Nudge by sentence once the word transcript is current (slice 2).
  const sent = episodes.getEpisode(s, ep1)!.sentences!;
  const sv = rules.checkMoment(m(45, 90, "THE SENTENCE NUDGE"), { cues: sent, unit: "sentence", episodeEnd: 205, taken: [], overlay });
  assert.ok(sv.ok);
  const [sc] = moments.insertCards(s, ep1, 0, [sv.ok ? sv.moment : (null as never)], NOW + 90);
  assert.deepEqual([board.getCard(s, sc)!.nudgeUnit, board.getCard(s, sc)!.start, board.getCard(s, sc)!.end], ["sentence", 44.8, 90.2]);
  const ns1 = board.nudgeShort(s, sc, "start", -1, NOW + 91);
  assert.deepEqual(
    [ns1.start, ns1.end, ns1.firstLine],
    [29.8, 90.2, "Sentence 2 starts with a clear point and keeps going with more detail then lands the payoff number 2."],
    "start one sentence earlier: the whole previous sentence (15 s), its first line",
  );
  assert.equal(board.nudgeShort(s, sc, "end", 1, NOW + 92).end, 105.2, "end one sentence later");
  assert.throws(() => board.nudgeShort(s, sc, "start", -1, NOW + 95), /a moment is 30 to 90 s/, "over 90 s refused (14.8 to 105.2)");
  assert.equal(board.nudgeShort(s, sc, "start", 1, NOW + 96).start, 44.8);
  board.discardShort(s, sc, NOW + 97);
  ok("nudge: start / end one cue at a time while an episode has no current word transcript (re-snapped with the pad, 30 to 90 s enforced, the first / last cue is the limit; a new start rewrites the first line and the card's own hook, same row, requested for scoring; a linked hook is never edited), one SENTENCE at a time once it has one");

  // ---------------------------------------------------------------- retry, errors, Cancel / Retry / recover
  const callsBefore = stubCalls();
  queueStub("one", "two");
  const jR = moments.queueMoments(s, ep2, NOW + 100);
  await shortsEngine().drainShorts();
  const rR = JSON.parse(jobOf(jR).result!) as { survivors: number[]; attempts: { kept: number }[]; note: string | null };
  assert.equal(stubCalls(), callsBefore + 2, "fewer than 3 = one retry");
  assert.deepEqual([jobOf(jR).status, rR.attempts.map((a) => a.kept), rR.survivors.length, rR.note], ["done", [1, 2], 3, null], "survivors of both answers kept");
  const retryPrompt = fs.readFileSync(path.join(stubDir, `args-${callsBefore + 2}.txt`), "utf8");
  assert.match(retryPrompt, /Your last answer broke these rules[\s\S]*shares half or more/);
  assert.match(retryPrompt, /These moments passed and are kept/);
  queueStub("none", "few");
  const jFew = moments.queueMoments(s, ep2, NOW + 110);
  await shortsEngine().drainShorts();
  const rFew = JSON.parse(jobOf(jFew).result!) as { survivors: number[]; note: string | null };
  assert.deepEqual([jobOf(jFew).status, rFew.survivors.length], ["done", 1], "still under 3 after the retry: done with what survived");
  assert.match(rFew.note!, /Only 1 moment passed/);
  queueStub("none", "none");
  const jNone = moments.queueMoments(s, ep2, NOW + 120);
  await shortsEngine().drainShorts();
  assert.deepEqual([jobOf(jNone).status, jobOf(jNone).error], ["error", "No moment passed the checks (see the log)."], "zero survivors = a job error");
  queueStub("badjson");
  const jBad = moments.queueMoments(s, ep2, NOW + 130);
  await shortsEngine().drainShorts();
  assert.deepEqual([jobOf(jBad).status, jobOf(jBad).error], ["error", "claude printed no JSON result"]);
  queueStub("sleep");
  const jSlow = moments.queueMoments(s, ep2, NOW + 140);
  const t0 = Date.now();
  await shortsEngine(1_500).drainShorts();
  assert.ok(Date.now() - t0 < 10_000, "the timeout kills the run");
  assert.match(jobOf(jSlow).error!, /longer than 2 s/);
  // Cancel while pending, Retry on error / cancelled, one active per episode, recover after a restart.
  const jC = moments.queueMoments(s, ep2, NOW + 150);
  assert.equal(moments.cancelMomentJob(s, jC), true);
  assert.equal(moments.cancelMomentJob(s, jC), false, "only a pending job");
  assert.equal(moments.retryMomentJob(s, jC), true);
  assert.throws(() => moments.retryMomentJob(s, jSlow), /already being written/, "one active job per episode");
  s.prepare("update jobs set status = 'running' where id = ?").run(jC);
  const q = new ShortMomentsQueue(s, { cacheDir: cfg.cacheDir, logsDir: cfg.logsDir, drive, log: quiet, isStopped: () => false });
  assert.equal(q.recover(), 1);
  assert.match(jobOf(jC).error!, /Interrupted/);
  assert.equal(moments.retryMomentJob(s, jSlow), true, "Retry once nothing else is active");
  s.prepare("update jobs set status = 'cancelled' where id = ?").run(jSlow);
  const views = moments.momentJobs(s);
  assert.ok(views.some((v) => v.id === jR && v.survivors === 3 && v.returned === 5 && v.attempts === 2 && v.episode === "Ep2 · Demo Two"), "the Jobs page list");
  assert.deepEqual(moments.momentsActivity(s).active, 0);
  ok("retry: under 3 survivors = one retry told what broke (survivors of both kept), zero = error, bad JSON and a timeout = errors; Cancel while pending, Retry on error / cancelled (one active job per episode), a running job after a restart = Interrupted; Jobs page list + activity");

  // ---------------------------------------------------------------- actions (zod) + episode gone
  const actions = await import("../src/app/actions");
  assert.ok(!(await actions.newShortAction({ episodeId: -1 })).ok, "zod: episode id");
  assert.ok(!(await actions.setShortStatusAction({ id: c1.id, status: "shipped" })).ok, "zod: status");
  assert.ok(!(await actions.nudgeShortAction({ id: c1.id, edge: "start", dir: 2 as never })).ok, "zod: nudge direction");
  assert.ok(!(await actions.setShortLayoutAction({ id: c1.id, layout: "split" })).ok, "zod: layout");
  assert.ok(!(await actions.setShortHookWordsAction({ id: c1.id, words: "x".repeat(200) })).ok, "zod: hook length");
  fs.rmSync(path.join(folder2, "NSM Ep2.srt"));
  episodes.syncEpisodes(s, drive, NOW + 200);
  assert.throws(() => moments.queueMoments(s, ep2, NOW + 201), /not available/, "a gone episode takes no new job");
  assert.ok(board.boardData(s).columns.idea.some((c) => c.episodeId === ep2), "its cards stay on the board");

  if (savedBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = savedBin;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  db.sqlite.close();
  ok("actions zod-validate episode, status, nudge, layout and hook words; a gone episode takes no new job while its cards stay");
}
