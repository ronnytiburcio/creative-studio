/**
 * Phase 6 slice 2 smoke checks (called by scripts/smoke.ts after smoke-shorts.ts): the word-timed transcript (whisper's
 * JSON, the proper-noun fixes, sentences, the transcriber against a STUB whisper script with real ffmpeg over a fixture
 * proxy in the temp cache: cache only, due again on a new fingerprint, waiting without a proxy, errors), moments waiting
 * for it, the automatic moves (reel folders, the three reel names, newest vN, k / episode / folder / hidden mismatches
 * ignored, Link / Unlink, forward only, backward holds), the caption gate (every location, the guarded .md read refusing
 * outside roots / symlinks), Posted via a linked yt_video + its numbers, Send to Shorts (NSM only, explainer card), the
 * hand-off writer (its folder, new files only, never overwrite, never on the drive, the nsm-reel-cut list shape, cards to
 * Cutting) and the actions' zod. A FRESH temp DB and temp folders: never the drive, never the real whisper / claude, no Jev.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { StudioConfig } from "../src/lib/config";
import { fixtureSrt, whisperJsonFor } from "./smoke-shorts";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const NOW = Date.UTC(2026, 9, 1, 16, 0, 0);

export async function runShorts2Smoke({ cfg, tmp, ok }: Ctx) {
  const { openDb } = await import("../src/lib/db");
  const words = await import("../src/lib/shorts/words");
  const srt = await import("../src/lib/shorts/srt");
  const rules = await import("../src/lib/shorts/rules");
  const episodes = await import("../src/lib/shorts/episodes");
  const transcript = await import("../src/lib/shorts/transcript");
  const moments = await import("../src/lib/shorts/moments");
  const board = await import("../src/lib/shorts/board");
  const outputs = await import("../src/lib/shorts/outputs");
  const handoff = await import("../src/lib/shorts/handoff");
  const handoffText = await import("../src/lib/shorts/handoff-text");
  const textread = await import("../src/lib/textread");
  const { getConfig } = await import("../src/lib/config");
  const hookStore = await import("../src/lib/hooks/store");
  const { ShortMomentsQueue } = await import("../src/worker/shorts");
  const { FFMPEG } = await import("../src/worker/proc");

  const db = openDb(path.join(tmp, "shorts2.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const quiet = () => {};
  const drive = { drivePath: cfg.drivePath, fakeUnmounted: false, driveMode: cfg.driveMode };

  // ---------------------------------------------------------------- words: parse, fixes, sentences (pure)
  const parsed = words.parseWhisperWords(
    JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 0 }, text: "" },
        { offsets: { from: 90, to: 390 }, text: " What's" },
        { offsets: { from: 390, to: 1000 }, text: " up?" },
        { offsets: { from: 1000, to: 1000 }, text: " [BLANK_AUDIO]" },
        { offsets: { from: 1000, to: 1200 }, text: " (music)" },
        { offsets: { from: 1200, to: "x" }, text: " bad" },
      ],
    }),
  );
  assert.deepEqual(parsed, [
    { start: 0.09, end: 0.39, text: "What's" },
    { start: 0.39, end: 1, text: "up?" },
  ], "empty, non-speech and broken segments dropped; ms -> s");
  assert.throws(() => words.parseWhisperWords("nope"), /no JSON/);
  assert.throws(() => words.parseWhisperWords("{}"), /no transcription/);
  const W = (texts: string[], gap = 0) => texts.map((t, i) => ({ start: i * (0.5 + gap), end: i * (0.5 + gap) + 0.5, text: t }));
  const fixed = words.fixWords(
    W(["Alix's", "new", "Hicks", "field", "video,", "the", "sun", "it", "model.", "Steel", "glue", "trust", "trip", "Claudia", "seed", "S", "E", "E", "D", "brine", "it", "up!", "referral"]),
  );
  assert.deepEqual(
    fixed.map((w) => w.text),
    ["Alex's", "new", "Higgsfield", "video,", "Sonnet", "it", "model.", "Steel blue", "trust strip", "Claude", "Seed", "brighten it up!", "Refero"],
    "nsm-episode-prep's proper-noun list: single and multi-word fixes, possessive, punctuation and a sentence-start capital kept",
  );
  assert.deepEqual([fixed[2].start, fixed[2].end], [1, 2], "a merged word spans its parts' time");
  assert.equal(words.properNounFixes().length, 11, "one list");
  const sents = words.sentencesOf([
    ...W(["Talk", "to", "Dr.", "Smith", "today."]),
    { start: 3, end: 3.4, text: "Then" },
    { start: 3.4, end: 3.8, text: "pause" },
    { start: 4.7, end: 5, text: "here" },
    { start: 5.1, end: 5.5, text: "now?" },
  ]);
  assert.deepEqual(
    sents.map((x) => [x.text, x.start, x.end]),
    [
      ["Talk to Dr. Smith today.", 0, 2.5],
      ["Then pause", 3, 3.8],
      ["here now?", 4.7, 5.5],
    ],
    "a sentence ends on . ! ? (Dr. excepted) or before a 0.8 s pause; times from its first and last word",
  );
  // The SRT's text on whisper's times: whisper lost its punctuation (as on the real Ep1), the SRT has it.
  const srtCues = [
    { start: 0, end: 6, text: "All right. So we got a client, Alex's 3rd one." },
    { start: 6, end: 10, text: "Let's take a look." },
  ];
  const wsp = W(["all", "right", "so", "we", "got", "a", "client", "alix's", "third", "one", "um", "let's", "take", "a", "look"]);
  const al = words.alignToSrt(srtCues, wsp);
  assert.deepEqual([al.matched, al.total], [12, 14], "12 of 14 SRT words matched (\"Alex's 3rd\" vs whisper's \"alix's third\": those two get interpolated times)");
  assert.deepEqual(al.words.map((w) => w.text), ["All", "right.", "So", "we", "got", "a", "client,", "Alex's", "3rd", "one.", "Let's", "take", "a", "look."], "the SRT's words");
  assert.ok(al.words.every((w, i) => i === 0 || w.start >= al.words[i - 1].end - 1e-9), "times never go backwards");
  const es = words.episodeSentences(srtCues, wsp);
  assert.deepEqual(
    [es.source, es.sentences.map((x) => x.text)],
    ["srt", ["All right.", "So we got a client, Alex's 3rd one.", "Let's take a look."]],
    "sentences from the SRT's punctuation on whisper's times",
  );
  assert.deepEqual([es.sentences[0].start, es.sentences[0].end, es.sentences[2].start], [0, 1, 5.5], "times are whisper's (word 0 to 1, \"let's\" at 5.5)");
  const off = words.episodeSentences([{ start: 0, end: 10, text: "Totally different words in this cue here." }], wsp);
  assert.deepEqual([off.source, off.sentences.length], ["whisper", 1], "under 60% matched: whisper's own words");
  // Sentence units: every unit qualifies (no S / E rule); the first line joins a short sentence with the next.
  const units = [
    { start: 0, end: 2, text: "Okay." },
    { start: 2, end: 20, text: "Uh, here is the mistake everyone makes with their ads." },
    { start: 20, end: 40, text: "And this is the fix that works." },
  ];
  assert.equal(rules.firstLineAt(units, 0, 2, "sentence"), "Okay. here is the mistake everyone makes with their ads.", "under 4 words joins the next sentence (fillers out)");
  assert.equal(rules.firstLineAt(units, 1, 2, "sentence"), "Here is the mistake everyone makes with their ads.");
  const overlay = rules.overlayRules([]);
  const sv = rules.checkMoment({ start: 2, end: 40, firstLine: "", hook: "THE MISTAKE", why: "ok", layout: "stack" }, { cues: units, unit: "sentence", episodeEnd: 60, taken: [], overlay });
  assert.ok(sv.ok && sv.moment.start === 1.8 && sv.moment.end === 40.2, "a sentence start / end with the 0.2 s pad");
  ok("word transcript (pure): whisper's -oj JSON parsed (empty / non-speech / broken segments dropped), the SRT's text aligned onto whisper's word times (per cue LCS, unmatched words interpolated, >= 60% or whisper's own words), nsm-episode-prep's 11 proper-noun fixes (multi-word merged over their time, possessive, punctuation, capital), sentences on . ! ? (abbreviations excepted) or a 0.8 s pause, sentence-unit first lines and checks");

  // ---------------------------------------------------------------- fixture episodes with proxies in the temp cache
  const NSM = s.prepare("select id from sections where key = 'rtm'").pluck().get() as number;
  s.prepare("update roots set enabled = 0").run(); // seeded roots point at the real drive: never read here
  const rootDir = path.join(tmp, "shorts2-root");
  const outside = path.join(tmp, "shorts2-outside");
  fs.mkdirSync(outside, { recursive: true });
  const f1 = path.join(rootDir, "Ep One");
  const f1b = path.join(rootDir, "Ep One Takes"); // a sibling with NSM Ep1 reels.json: Ep1's reels may land here too
  const f2 = path.join(rootDir, "Ep Two");
  const f3 = path.join(rootDir, "Ep Three");
  for (const f of [f1, f1b, f2, f3]) fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(f1, "NSM Ep1.srt"), fixtureSrt());
  fs.writeFileSync(path.join(f2, "NSM Ep2.srt"), fixtureSrt());
  fs.writeFileSync(path.join(f3, "NSM Ep3.srt"), fixtureSrt());
  fs.writeFileSync(path.join(f1b, "NSM Ep1 reels.json"), "[]");
  fs.writeFileSync(path.join(f2, "NSM Ep1 reels.json"), "[]"); // Ep2's folder: an Ep1 list here makes it an Ep1 reel folder too (sibling)
  const root = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(rootDir, NSM).lastInsertRowid);
  const insAsset = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status, duration_s, sha256, asset_class, thumb_path, proxy_path)
     values (?, ?, ?, ?, ?, 'mp4', 'video', 1, ?, 1, 'done', ?, ?, ?, ?, ?)`,
  );
  let mt = NOW + 1000; // file mtimes (ms): after the cards' Cutting time unless a test says otherwise
  const asset = (rel: string, opts: { dur?: number; cls?: string | null; proxy?: string | null; sha?: string; mtime?: number } = {}) =>
    Number(
      insAsset.run(NSM, root, path.join(rootDir, rel), rel, path.basename(rel), opts.mtime ?? mt++, opts.dur ?? 40, opts.sha ?? `sha2-${rel}`, opts.cls ?? null, "x/thumb.webp", opts.proxy ?? null).lastInsertRowid,
    );
  // Proxies in the temp cache: one with an audio track, one without.
  const mkProxy = (rel: string, audio: boolean) => {
    const out = path.join(cfg.cacheDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const args = audio
      ? ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-c:a", "aac", out]
      : ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:d=2", "-c:v", "libx264", out];
    const r = spawnSync(FFMPEG, args);
    assert.equal(r.status, 0, `ffmpeg fixture ${rel}`);
  };
  mkProxy("ep1sha/proxy.mp4", true);
  mkProxy("ep3sha/proxy.mp4", false);
  const m1 = asset("Ep One/Northstar Media Ep. 1.mov", { dur: 205, cls: "episode", proxy: "ep1sha/proxy.mp4", sha: "ep1sha" });
  const m2 = asset("Ep Two/Northstar Media Ep. 2.mov", { dur: 205, cls: "episode", proxy: null, sha: "ep2sha" }); // no proxy yet
  const m3 = asset("Ep Three/Northstar Media Ep. 3.mov", { dur: 205, cls: "episode", proxy: "ep3sha/proxy.mp4", sha: "ep3sha" }); // proxy without audio
  episodes.syncEpisodes(s, drive, NOW);
  const epList = episodes.listEpisodes(s);
  const [ep1, ep2, ep3] = [1, 2, 3].map((n) => epList.find((e) => e.num === n)!.id);
  assert.deepEqual(
    JSON.parse(s.prepare("select reel_dirs from episodes where id = ?").pluck().get(ep1) as string),
    [f1, f1b, f2].sort((a, b) => (a === f1 ? -1 : b === f1 ? 1 : a.localeCompare(b))),
    "reel folders: the episode folder first, plus every sibling holding NSM Ep1 reels.json",
  );
  assert.deepEqual(JSON.parse(s.prepare("select reel_dirs from episodes where id = ?").pluck().get(ep2) as string), [f2], "no list for Ep2 elsewhere: its own folder only");
  assert.deepEqual(
    epList.map((e) => [e.num, e.transcript.state]),
    [
      [1, "queued"],
      [2, "waiting_proxy"],
      [3, "queued"],
    ],
    "picker states before the transcriber ran",
  );

  // ---------------------------------------------------------------- the transcriber (stub whisper, real ffmpeg)
  const stubDir = path.join(tmp, "shorts2-whisper-stub");
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, "whisper-cli");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
D='${stubDir}'
N=$(cat "$D/count" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "$D/count"
printf '%s\\n' "$@" > "$D/args-$N.txt"
OF=""; F=""
while [ $# -gt 0 ]; do
  case "$1" in
    -of) OF="$2"; shift ;;
    -f) F="$2"; shift ;;
  esac
  shift
done
[ -f "$F" ] && echo yes > "$D/wav-$N.txt"
ls -l "$F" >> "$D/wav-$N.txt" 2>&1
cp "$D/words.json" "$OF.json"
`,
  );
  fs.chmodSync(stub, 0o755);
  const model = path.join(stubDir, "ggml-small.en.bin");
  fs.writeFileSync(model, "model");
  const cues = srt.parseSrt(fixtureSrt());
  fs.writeFileSync(path.join(stubDir, "words.json"), whisperJsonFor(cues));
  let ready = true;
  const q = new ShortMomentsQueue(s, {
    cacheDir: cfg.cacheDir,
    logsDir: cfg.logsDir,
    drive,
    log: quiet,
    isStopped: () => false,
    now: () => NOW,
    words: { bin: stub, model, ready: () => ready },
  });
  ready = false;
  assert.equal(await q.transcribeNext(), "none", "whisper not ready: nothing runs");
  ready = true;
  // A proxy path that leaves the cache is never opened (cache only).
  s.prepare("update assets set proxy_path = null where id = ?").run(m3);
  s.prepare("update assets set proxy_path = '../shorts2-outside/x.mp4' where id = ?").run(m1);
  assert.equal(await q.transcribeNext(), "error");
  assert.match(s.prepare("select words_error from episodes where id = ?").pluck().get(ep1) as string, /missing from the cache/, "a proxy outside STUDIO_CACHE is refused");
  s.prepare("update assets set proxy_path = 'ep1sha/proxy.mp4' where id = ?").run(m1);
  s.prepare("update assets set proxy_path = 'ep3sha/proxy.mp4' where id = ?").run(m3);
  s.prepare("update episodes set words_sha = null, words_error = null").run(); // next pass
  const drained = await q.drainWords();
  assert.deepEqual(drained, { done: 1, error: 1 }, "Ep1 transcribed; Ep3's proxy has no audio (an error); Ep2 waits for its proxy");
  const args = fs.readFileSync(path.join(stubDir, "args-1.txt"), "utf8").split("\n");
  for (const flag of ["-m", "-f", "-l", "-ml", "-sow", "-oj", "-of", "-np", "-sns"]) assert.ok(args.includes(flag), `whisper gets ${flag}`);
  assert.equal(args[args.indexOf("-ml") + 1], "1", "-ml 1: one word per segment");
  assert.equal(args[args.indexOf("-m") + 1], model);
  const wav = args[args.indexOf("-f") + 1];
  assert.ok(wav.startsWith(path.join(cfg.cacheDir, "words-tmp")) && wav.endsWith(".wav"), "a 16 kHz wav under STUDIO_CACHE/words-tmp");
  assert.match(fs.readFileSync(path.join(stubDir, "wav-1.txt"), "utf8"), /^yes/, "the wav existed while whisper ran");
  assert.ok(!fs.existsSync(path.dirname(wav)), "the temp folder (wav + JSON) is deleted after");
  const e1 = s.prepare("select words_sha, words_version, words_model, word_count, sentence_count, words_error, words_running_at from episodes where id = ?").get(ep1) as Record<string, unknown>;
  assert.deepEqual(
    [e1.words_sha, e1.words_version, e1.words_model, e1.sentence_count, e1.words_error, e1.words_running_at],
    ["ep1sha", words.WORDS_VERSION, "ggml-small.en.bin", 14, null, null],
    "words stored with the master's fingerprint, the words version and the model name",
  );
  assert.match(s.prepare("select words_error from episodes where id = ?").pluck().get(ep3) as string, /no audio/);
  const states = Object.fromEntries(episodes.listEpisodes(s).map((e) => [e.num, e.transcript]));
  assert.deepEqual([states[1], states[2].state, states[3].state], [{ state: "ready", sentences: 14, words: e1.word_count }, "waiting_proxy", "error"]);
  assert.equal(await q.transcribeNext(), "none", "nothing due: a failure waits 6 hours, a done one until its fingerprint changes");
  assert.equal(transcript.nextWordsDue(s, "ggml-small.en.bin", NOW + transcript.WORDS_RETRY_MS + 60_000)?.episodeId, ep3, "the failure is retried after 6 hours");
  // A new fingerprint (the master changed, so did its proxy): due again; the old words are not used meanwhile.
  s.prepare("update assets set sha256 = 'ep1sha-v2' where id = ?").run(m1);
  assert.equal(episodes.getEpisode(s, ep1)!.sentences, null, "words for another fingerprint are not current");
  assert.equal(episodes.listEpisodes(s).find((e) => e.id === ep1)!.transcript.state, "queued");
  assert.equal(transcript.nextWordsDue(s, "ggml-small.en.bin", NOW)?.episodeId, ep1, "due again on a new fingerprint");
  assert.equal(transcript.nextWordsDue(s, "ggml-medium.en.bin", NOW)?.episodeId, ep3, "another whisper model makes every episode due (even a failed one; Ep3 first by number)");
  // Gate fix: a whisper / ffmpeg failure never stores its raw text (it can name paths): a fixed phrase on the episode,
  // the detail in the worker log only.
  const workerLog: string[] = [];
  const qLog = new ShortMomentsQueue(s, { cacheDir: cfg.cacheDir, logsDir: cfg.logsDir, drive, log: (...a: unknown[]) => workerLog.push(a.join(" ")), isStopped: () => false, now: () => NOW, words: { bin: stub, model, ready: () => true } });
  fs.writeFileSync(path.join(stubDir, "fail"), "1");
  fs.writeFileSync(stub, fs.readFileSync(stub, "utf8").replace("#!/bin/sh\n", `#!/bin/sh\nif [ -f '${stubDir}/fail' ]; then echo "error: failed to open /Users/someone/secret folder/model.bin" >&2; exit 3; fi\n`));
  assert.equal(await qLog.transcribeNext(), "error");
  assert.equal(s.prepare("select words_error from episodes where id = ?").pluck().get(ep1), "The word transcript failed (see the log)", "the episode stores a fixed phrase");
  assert.ok(workerLog.some((l) => l.includes("/Users/someone/secret folder")), "the detail stays in the worker log");
  fs.rmSync(path.join(stubDir, "fail"));
  s.prepare("update episodes set words_error = null, words_sha = null where id = ?").run(ep1); // due again (as before this check)
  ok("terse errors (gate fix): a whisper / ffmpeg failure stores \"The word transcript failed (see the log)\" on the episode (the picker shows it), the raw text (paths) only in the worker log");
  ok("word transcript (stub whisper, real ffmpeg): cache only (a proxy path outside STUDIO_CACHE refused), -ml 1 -sow -oj, a temp wav under STUDIO_CACHE/words-tmp deleted after, stored with fingerprint + version + model, no proxy = waits, no audio = an error retried after 6 hours, due again on a new fingerprint or model; picker states");

  // Moments wait for it: a pending job on an episode without a current transcript is not claimed.
  s.prepare("update assets set sha256 = 'ep3sha-v2' where id = ?").run(m3); // Ep3 due again too (it would go first by number)
  assert.equal(transcript.nextWordsDue(s, "ggml-small.en.bin", NOW)?.episodeId, ep3);
  const jWait = moments.queueMoments(s, ep1, NOW);
  assert.equal(q.claimNext(), null, "Ep1's words are for the old fingerprint: the job waits");
  assert.equal(moments.momentJobs(s).find((j) => j.id === jWait)!.waitingWords, true, "shown as waiting for the word-timed transcript");
  assert.equal(transcript.nextWordsDue(s, "ggml-small.en.bin", NOW)?.episodeId, ep1, "an episode with a waiting job goes first");
  assert.deepEqual(await q.drainWords(), { done: 1, error: 1 });
  const claimed = q.claimNext();
  assert.equal(claimed?.id, jWait, "claimed once its transcript is current");
  s.prepare("update jobs set status = 'cancelled' where id = ?").run(jWait);
  assert.throws(() => moments.momentContext(s, ep3), /Waiting for the word-timed transcript/, "never falls back to the SRT cues");
  // Gate fix: an unexpected failure (here an fs error naming a cache path) stores a fixed phrase on the job row; the
  // detail stays in the job's log file.
  {
    const jFs = moments.queueMoments(s, ep1, NOW);
    const job = q.claimNext()!;
    assert.equal(job.id, jFs);
    const tmpRoot = path.join(cfg.cacheDir, "claude-tmp");
    const aside = `${tmpRoot}.aside`;
    if (fs.existsSync(tmpRoot)) fs.renameSync(tmpRoot, aside);
    fs.writeFileSync(tmpRoot, "a file where the work folder's parent should be");
    try {
      assert.equal(await q.runOne(job), "error");
    } finally {
      fs.rmSync(tmpRoot, { force: true });
      if (fs.existsSync(aside)) fs.renameSync(aside, tmpRoot);
    }
    const row = s.prepare("select status, error, log_path from jobs where id = ?").get(jFs) as { status: string; error: string; log_path: string };
    assert.deepEqual([row.status, row.error], ["error", "Moments failed (see the log)"], "a fixed phrase, never the fs error text");
    assert.match(fs.readFileSync(row.log_path, "utf8"), /claude-tmp/, "the detail is in the job's log");
    const { terseJobError } = await import("../src/lib/jobs");
    assert.equal(terseJobError(new moments.MomentsError("The episode is gone."), [moments.MomentsError], "x"), "The episode is gone.", "known terse classes pass");
    assert.equal(terseJobError(new Error("ENOENT: /Users/x/y"), [moments.MomentsError], "fallback"), "fallback", "anything else is the fallback");
  }
  ok("moments wait for the word-timed transcript (not claimed, shown as waiting, its episode transcribed first), then run; no fallback to the SRT cues");
  ok("terse errors (gate fix): an unexpected moments failure (an fs error naming a cache path) stores \"Moments failed (see the log)\" on the job row (only MomentsError / ClaudeError text passes), the detail in the job's log; runOne never throws from its cleanup");

  // ---------------------------------------------------------------- reel files -> Review (forward only)
  assert.deepEqual(
    [
      outputs.outputRank("NSM Ep1 Reel 4.mp4", 1, 4),
      outputs.outputRank("NSM Ep1 Reel 4 v3.mp4", 1, 4),
      outputs.outputRank("NSM Ep1 Reel 4 v12.MP4", 1, 4),
      outputs.outputRank("reels/reel4/out/reel4.mp4", 1, 4),
      outputs.outputRank("NSM Ep1 Reel 4B v1.mp4", 1, 4),
      outputs.outputRank("NSM Ep1 Reel 41.mp4", 1, 4),
      outputs.outputRank("NSM Ep2 Reel 4.mp4", 1, 4),
      outputs.outputRank("reels/reel5/out/reel4.mp4", 1, 4),
      outputs.outputRank("NSM Ep1 Reel 4.mov", 1, 4),
      outputs.outputRank("old/NSM Ep1 Reel 4.mp4", 1, 4),
    ],
    [1, 3, 12, 0, null, null, null, null, null, null],
    "names: plain = 1, vN = N, reels/reelK/out/reelK.mp4 = 0; 4B, 41, another episode, another k, .mov and a sub-folder are not reel 4",
  );
  const insCard = s.prepare(
    `insert into shorts (episode_id, k, start_s, end_s, first_line, hook_words, why, layout, status, kept, created_at, updated_at)
     values (?, ?, 10, 50, 'A first line here.', 'THE HOOK WORDS', 'why', 'stack', ?, 1, ?, ?)`,
  );
  const card = (ep: number, k: number, status: string) => Number(insCard.run(ep, k, status, NOW, NOW).lastInsertRowid);
  const cA = card(ep1, 4, "cutting");
  const cB = card(ep1, 5, "cutting");
  const cIdea = card(ep1, 6, "idea");
  const cOther = card(ep2, 4, "cutting");
  const a4 = asset("Ep One/NSM Ep1 Reel 4.mp4");
  const a4v2 = asset("Ep One/NSM Ep1 Reel 4 v2.mp4");
  asset("Ep One Takes/reels/reel4/out/reel4.mp4");
  asset("Ep One/NSM Ep1 Reel 41 v9.mp4");
  asset("Ep One/NSM Ep2 Reel 4 v9.mp4");
  asset("Not A Reel Folder/NSM Ep1 Reel 4 v9.mp4");
  const hidden = asset("Ep One/NSM Ep1 Reel 4 v8.mp4");
  s.prepare("update assets set missing = 1 where id = ?").run(hidden);
  const a5 = asset("Ep One Takes/reels/reel5/out/reel5.mp4");
  asset("Ep One/NSM Ep1 Reel 4 v20.mp4", { mtime: NOW - 10 * 60_000 }); // an older reel with the same number: never counts
  asset("Ep One/NSM Ep1 Reel 6.mp4"); // card 6 is still an Idea: no automatic move from Idea
  const r1 = outputs.syncBoard(s, drive, NOW + 10);
  const g = (id: number) => board.getCard(s, id)!;
  assert.deepEqual(
    [g(cA).status, g(cA).output?.assetId, g(cA).output?.source, g(cB).status, g(cB).output?.assetId, g(cIdea).status, g(cOther).status, r1.toReview],
    ["review", a4v2, "auto", "review", a5, "idea", "cutting", 2],
    "Cutting -> Review on the best visible match written after the card entered Cutting (v2 over plain; an older v20, the hidden v8, reel 41, Ep2's name and a non-reel folder ignored; reels/reel5/out in the sibling folder); Idea never moves; Ep2's card 4 does not take Ep1's files",
  );
  void a4;
  const a4v3 = asset("Ep One/NSM Ep1 Reel 4 v3.mp4");
  assert.equal(outputs.syncBoard(s, drive, NOW + 20).outputsUpdated, 1);
  assert.equal(g(cA).output?.assetId, a4v3, "a newer version replaces the automatic output while in Review");
  // Backward by hand: stays until a NEW file shows up.
  board.setShortStatus(s, cA, "cutting", NOW + 30);
  assert.equal(s.prepare("select hold_key from shorts where id = ?").pluck().get(cA), `out:${a4v3}`);
  outputs.syncBoard(s, drive, NOW + 31);
  assert.equal(g(cA).status, "cutting", "moved back by hand: the same file does not move it again");
  const a4v4 = asset("Ep One/NSM Ep1 Reel 4 v4.mp4");
  outputs.syncBoard(s, drive, NOW + 32);
  assert.deepEqual([g(cA).status, g(cA).output?.assetId], ["review", a4v4], "a new version is the next forward trigger");
  assert.deepEqual(
    [...outputs.usedReelNumbers(s, { num: 1, reelDirs: episodes.getEpisode(s, ep1)!.reelDirs })].sort((a, b) => a - b),
    [4, 5, 6, 41],
    "reel numbers already used by Ep1's files (hidden ones too), never by another episode's names",
  );
  assert.equal(moments.nextK(s, ep1), 42, "a new card's number skips every used reel number (and every card number)");
  ok("reel files -> Review: the episode folder + a sibling with NSM EpN reels.json, NSM EpN Reel K.mp4 / K vN.mp4 (highest N) / reels/reelK/out/reelK.mp4, only files written after the card entered Cutting, k / episode / folder / hidden mismatches ignored, never from Idea, a newer version updates Review, a backward move holds until a new file; new card numbers skip used reel numbers");

  // Link a file / Unlink.
  const other = asset("Ep One Takes/my final cut.mp4");
  const fkbAsset = Number(
    s
      .prepare(
        `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status) values ((select id from sections where key='fkb'), ?, ?, 'x.mp4', 'x.mp4', 'mp4', 'video', 1, 1, 1, 'done')`,
      )
      .run(root, path.join(rootDir, "fkb-x.mp4")).lastInsertRowid,
  );
  assert.throws(() => outputs.linkOutput(s, cB, fkbAsset, drive, NOW), /visible NSM video/, "only an NSM video");
  assert.throws(() => outputs.linkOutput(s, cB, hidden, drive, NOW), /visible NSM video/, "never a hidden file");
  assert.deepEqual(outputs.linkOutput(s, cB, other, drive, NOW + 40), { filename: "my final cut.mp4", moved: false });
  outputs.syncBoard(s, drive, NOW + 41);
  assert.deepEqual([g(cB).output?.assetId, g(cB).output?.source], [other, "manual"], "a manual link is never overwritten by the match");
  assert.throws(() => outputs.unlinkOutput(s, cA, drive), /matched automatically/);
  assert.deepEqual(outputs.unlinkOutput(s, cB, drive, NOW + 42), { rematched: true });
  assert.deepEqual([g(cB).output?.assetId, g(cB).output?.source, g(cB).status], [a5, "auto", "review"], "Unlink = back to the automatic match; the column stays");
  ok("Link a file: a visible NSM video only, manual links survive the sync, Unlink returns to the automatic match");

  // ---------------------------------------------------------------- captions + Approve
  assert.throws(() => outputs.approveShort(s, cA, drive, NOW + 50), /No caption file yet: add NSM Ep1 Reel 4 caption\.md next to the reel/);
  assert.equal(g(cA).status, "review");
  fs.writeFileSync(path.join(f1, "NSM Ep1 Reel 4 caption.md"), "# Caption\n\nThe hook line for Instagram.\n\nFull breakdown on YouTube, link in bio.\n#ads #marketing\n");
  outputs.syncBoard(s, drive, NOW + 51);
  assert.equal(g(cA).caption, null, "looked up 1 ms ago (the refused Approve): the sync waits up to 60 s before looking again");
  outputs.syncBoard(s, drive, NOW + 50 + 60_000);
  assert.deepEqual(g(cA).caption, { filename: "NSM Ep1 Reel 4 caption.md", preview: "Caption\nThe hook line for Instagram.\nFull breakdown on YouTube, link in bio.\n#ads #marketing" }, "found by the sync, first lines shown");
  assert.deepEqual(outputs.approveShort(s, cA, drive, NOW + 52), { posted: false });
  assert.equal(g(cA).status, "ready", "Approve with a caption: Ready to post");
  // Gate fix: the worker's sync looks captions up only for Review / Ready cards and only when something may have changed.
  {
    const cap = (id: number) => s.prepare("select caption_path, caption_preview, caption_checked_at from shorts where id = ?").get(id) as { caption_path: string | null; caption_preview: string | null; caption_checked_at: number };
    const capFile = path.join(f1, "NSM Ep1 Reel 4 caption.md");
    const outId = g(cA).output!.assetId;
    const outMtime = s.prepare("select mtime from assets where id = ?").pluck().get(outId) as number;
    const t0 = cap(cA).caption_checked_at;
    s.prepare("update assets set mtime = ? where id = ?").run(t0 - 10, outId); // the reel is older than the last check
    fs.utimesSync(capFile, (t0 - 10) / 1000, (t0 - 10) / 1000);
    outputs.syncBoard(s, drive, t0 + 1);
    assert.equal(cap(cA).caption_checked_at, t0, "nothing changed since the last check: no lookup");
    fs.writeFileSync(capFile, "Edited caption line.");
    fs.utimesSync(capFile, (t0 + 100) / 1000, (t0 + 100) / 1000);
    outputs.syncBoard(s, drive, t0 + 101);
    assert.deepEqual([cap(cA).caption_preview, cap(cA).caption_checked_at], ["Edited caption line.", t0 + 101], "an edited caption file is read again");
    s.prepare("update shorts set status = 'posted', caption_path = null, caption_preview = null where id = ?").run(cA);
    outputs.syncBoard(s, drive, t0 + 102);
    assert.equal(cap(cA).caption_path, null, "Posted cards are never looked up by the sync");
    s.prepare("update shorts set status = 'ready' where id = ?").run(cA);
    outputs.syncBoard(s, drive, t0 + 103);
    assert.equal(cap(cA).caption_path, null, "no caption yet: looked up again at most every 60 s");
    outputs.syncBoard(s, drive, t0 + 101 + 60_000);
    assert.equal(cap(cA).caption_path, capFile, "and found on the next minute");
    s.prepare("update assets set mtime = ? where id = ?").run(outMtime, outId);
  }
  ok("caption lookups (gate fix): the worker's sync reads captions for Review / Ready cards only (never Posted), a found one again only when the reel or the caption file is newer than the last check, a missing one at most every 60 s (Approve still looks right then)");
  // reels/reelK/*caption*.md (any reel folder), a symlink out of the roots refused, a .md only rule.
  fs.mkdirSync(path.join(f1b, "reels", "reel5"), { recursive: true });
  fs.writeFileSync(path.join(outside, "evil caption.md"), "secret");
  fs.symlinkSync(path.join(outside, "evil caption.md"), path.join(f1b, "reels", "reel5", "a caption.md"));
  assert.equal(outputs.findCaption(s, cB, drive).state, "none", "a caption symlink out of the roots is refused");
  fs.writeFileSync(path.join(f1b, "reels", "reel5", "reel5 caption.md"), "Reel five caption.");
  const fc = outputs.findCaption(s, cB, drive);
  assert.deepEqual([fc.state, fc.state === "found" && path.basename(fc.path)], ["found", "reel5 caption.md"], "reels/reelK/*caption*.md");
  assert.throws(() => textread.readGuardedText(path.join(f1, "NSM Ep1 Reel 4 caption.md"), [rootDir]), /\.srt \/ \.txt only/, "the default reader never reads .md");
  assert.throws(() => textread.readGuardedText(path.join(f1, "NSM Ep1.srt"), [rootDir], textread.CAPTION_EXTS), /\.md only/, "the caption read never reads .srt");
  assert.throws(() => textread.readGuardedText(path.join(outside, "evil caption.md"), [rootDir], textread.CAPTION_EXTS), /Outside/);
  // Explainer: any *caption*.md in the reel's folder (and the parent of an out/ folder).
  const hRtm = hookStore.addTextHooks(s, { section: "rtm", clientCode: null }, [{ text: "Speed to lead beats every ad tweak you make.", source: "manual" }], NOW).ids[0];
  const sent1 = board.sendHookToShorts(s, hRtm, NOW + 60);
  assert.equal(sent1.created, true);
  assert.deepEqual(board.sendHookToShorts(s, hRtm, NOW + 61), { cardId: sent1.cardId, created: false }, "one live card per hook");
  const ex = g(sent1.cardId);
  assert.deepEqual(
    [ex.explainer, ex.episodeId, ex.k, ex.status, ex.kept, ex.hookId, ex.hookOwned, ex.firstLine, ex.hookWords],
    [true, null, null, "idea", true, hRtm, false, "Speed to lead beats every ad tweak you make.", ""],
    "Send to Shorts: an explainer idea (no episode, no number, kept, the hook linked but not owned)",
  );
  const fkbHook = hookStore.addTextHooks(s, { section: "fkb", clientCode: null }, [{ text: "A garden in two weeks, not two months.", source: "manual" }], NOW).ids[0];
  assert.throws(() => board.sendHookToShorts(s, fkbHook), /for NSM hooks/, "NSM hooks only");
  hookStore.setHookArchived(s, hRtm, true, NOW);
  assert.throws(() => board.sendHookToShorts(s, hRtm), /Restore the hook/);
  hookStore.setHookArchived(s, hRtm, false, NOW);
  outputs.syncBoard(s, drive, NOW + 62);
  assert.equal(g(sent1.cardId).status, "idea", "an explainer never moves by itself");
  const exDir = path.join(rootDir, "Speed Reel");
  fs.mkdirSync(path.join(exDir, "out"), { recursive: true });
  const exOut = asset("Speed Reel/out/final.mp4");
  assert.deepEqual(outputs.linkOutput(s, sent1.cardId, exOut, drive, NOW + 63), { filename: "final.mp4", moved: true }, "Link a file moves an explainer to Review");
  assert.equal(outputs.findCaption(s, sent1.cardId, drive).state, "none");
  assert.equal(g(sent1.cardId).caption, null, "no caption file yet: none stored");
  fs.writeFileSync(path.join(exDir, "NSM Speed Reel caption.md"), "Speed caption.");
  const fx = outputs.findCaption(s, sent1.cardId, drive);
  assert.equal(fx.state === "found" && path.basename(fx.path), "NSM Speed Reel caption.md", "an explainer's caption in the reel's folder (out/'s parent)");
  // Link a file looks the caption up at once (no worker sync in between): the card shows it and Approve is open.
  const exOut2 = asset("Speed Reel/out/final v2.mp4");
  outputs.linkOutput(s, sent1.cardId, exOut2, drive, NOW + 63);
  assert.deepEqual(
    [s.prepare("select caption_path from shorts where id = ?").pluck().get(sent1.cardId), g(sent1.cardId).caption],
    [path.join(exDir, "NSM Speed Reel caption.md"), { filename: "NSM Speed Reel caption.md", preview: "Speed caption." }],
    "Link a file stores the caption right away",
  );
  // Unlink back to an automatic match stores that reel's caption at once too (the stored one blanked first to prove it).
  outputs.linkOutput(s, cB, other, drive, NOW + 63);
  s.prepare("update shorts set caption_path = null, caption_preview = null where id = ?").run(cB);
  outputs.unlinkOutput(s, cB, drive, NOW + 63);
  assert.equal(g(cB).caption?.filename, "reel5 caption.md", "Unlink to the automatic match stores its caption right away");
  ok("Link a file / Unlink look the caption up at once through the guarded reader (no wait for the worker's 15 s sync): stored and shown on the card");
  board.discardShort(s, sent1.cardId, NOW + 64);
  assert.equal(s.prepare("select archived_at from hooks where id = ?").pluck().get(hRtm), null, "discarding an explainer never archives the hook");
  ok("captions: NSM EpN Reel K caption.md next to the reel / in a reel folder, reels/reelK/*caption*.md, an explainer's *caption*.md in its folder; the .md read is guarded (outside roots and symlink escapes refused; .md only for captions, never by default); Approve needs one; Send to Shorts = an explainer idea (NSM only, one per hook), Review only by Link a file");

  // ---------------------------------------------------------------- Posted via a linked YouTube Short
  const insVid = s.prepare(
    "insert into yt_videos (video_id, channel_id, title, published_at, duration_s, is_short, matched_asset_id, match_source, first_seen_at, last_synced_at) values (?, 'UCx', ?, ?, 40, 1, ?, 'auto', 1, 1)",
  );
  // A card in Review with a linked Short stays in Review (Approve first).
  insVid.run("revShort001", "Review short", NOW, a5);
  outputs.syncBoard(s, drive, NOW + 70);
  assert.equal(g(cB).status, "review", "forward only from the column right before: Review never jumps to Posted");
  insVid.run("postShort01", "The reel on YouTube", NOW, a4v4);
  s.prepare("insert into yt_metrics (video_id, snapshot_date, start_date, end_date, views, avg_view_pct, synced_at) values ('postShort01', '2026-10-01', '2026-09-30', '2026-09-30', 1234, 61.5, 1)").run();
  assert.equal(outputs.syncBoard(s, drive, NOW + 71).toPosted, 1);
  assert.deepEqual(
    [g(cA).status, g(cA).short],
    ["posted", { videoId: "postShort01", title: "The reel on YouTube", views: 1234, avgViewPct: 61.5, snapshot: "2026-10-01" }],
    "Ready -> Posted when a Short is linked to the reel; its latest views and average % viewed on the card",
  );
  board.setShortStatus(s, cA, "ready", NOW + 72);
  outputs.syncBoard(s, drive, NOW + 73);
  assert.equal(g(cA).status, "ready", "moved back by hand: the same Short does not move it again");
  insVid.run("postShort02", "Re-upload", NOW + 1000, a4v4);
  outputs.syncBoard(s, drive, NOW + 74);
  assert.deepEqual([g(cA).status, g(cA).short?.videoId], ["posted", "postShort02"], "another Short linked to it is the next trigger");
  // Approve when its Short is already linked goes straight on to Posted.
  fs.writeFileSync(path.join(f1, "NSM Ep1 Reel 5 caption.md"), "Five.");
  assert.deepEqual(outputs.approveShort(s, cB, drive, NOW + 75), { posted: true });
  assert.equal(g(cB).status, "posted");
  ok("Posted: Ready to post -> Posted when a YouTube Short is linked to the reel (never from Review), its views and average % viewed on the card; a backward move holds until another Short; Approve with an already linked Short goes on to Posted");

  // ---------------------------------------------------------------- the hand-off writer + Cut reel
  const hdir = path.join(tmp, "shorts2-handoffs");
  const listOk = { episode: "NSM Ep1", master: "/x.mov", status: "s", clips: [] };
  const p1 = handoff.writeHandoffFile(hdir, cfg.drivePath, "NSM Ep1 reels.json", listOk, new Date(NOW));
  assert.equal(p1, path.join(fs.realpathSync(hdir), "NSM Ep1 reels.json"));
  assert.equal(fs.statSync(hdir).mode & 0o777, 0o700, "the folder is created 0700");
  assert.equal(fs.statSync(p1).mode & 0o777, 0o600, "the file 0600");
  const p2 = handoff.writeHandoffFile(hdir, cfg.drivePath, "NSM Ep1 reels.json", { ...listOk, status: "second" }, new Date(2026, 9, 1, 14, 32));
  assert.equal(path.basename(p2), "NSM Ep1 reels 2026-10-01-1432.json", "an existing file is never overwritten: the dated name instead");
  const p3 = handoff.writeHandoffFile(hdir, cfg.drivePath, "NSM Ep1 reels.json", { ...listOk, status: "third" }, new Date(2026, 9, 1, 14, 32));
  assert.equal(path.basename(p3), "NSM Ep1 reels 2026-10-01-1432-2.json");
  assert.equal(JSON.parse(fs.readFileSync(p1, "utf8")).status, "s", "the first file is untouched");
  fs.mkdirSync(cfg.drivePath, { recursive: true });
  assert.throws(() => handoff.writeHandoffFile(path.join(cfg.drivePath, "handoffs"), cfg.drivePath, "NSM Ep1 reels.json", listOk), /not be on the media drive/, "never on the drive");
  fs.symlinkSync(path.join(cfg.drivePath), path.join(tmp, "drive-link"));
  assert.throws(() => handoff.writeHandoffFile(path.join(tmp, "drive-link", "h"), cfg.drivePath, "NSM Ep1 reels.json", listOk), /media drive/, "nor through a symlink to it");
  fs.symlinkSync(outside, path.join(tmp, "handoff-link"));
  assert.throws(() => handoff.writeHandoffFile(path.join(tmp, "handoff-link"), cfg.drivePath, "NSM Ep1 reels.json", listOk), /not a plain folder/, "the folder itself is never a symlink");
  for (const bad of ["../NSM Ep1 reels.json", "evil.json", "NSM Ep1 reels.json.sh", "NSM Ep1 reels.txt"]) {
    assert.throws(() => handoff.writeHandoffFile(hdir, cfg.drivePath, bad, listOk), /Not a hand-off file name/, bad);
  }
  assert.throws(() => handoff.writeHandoffFile(hdir, cfg.drivePath, "NSM Ep2 reels.json", { big: "x".repeat(70_000) }), /64 KB/);
  assert.ok(!fs.existsSync(path.join(hdir, "NSM Ep2 reels.json")));
  ok("hand-off writer: its own folder (created 0700, never a symlink, never on the drive even through a symlink), files 0600, NSM EpN reels[ dated].json names only, new files only (an existing one never overwritten: dated, then -2), JSON only, 64 KB cap");

  // Cut reel: kept Idea cards of one episode -> the list in nsm-reel-cut's shape, cards to Cutting.
  const keep1 = card(ep1, 7, "idea");
  const keep2 = card(ep1, 8, "idea");
  asset("Ep One/NSM Ep1 Reel 7 v2.mp4", { mtime: NOW - 86_400_000 }); // an old reel already numbered 7
  s.prepare("update shorts set start_s = 123.456, end_s = 170.1, layout = 'center', hook_words = 'STOP THE SCROLL', why = null where id = ?").run(keep2);
  const undecided = card(ep1, 9, "idea");
  s.prepare("update shorts set kept = null where id = ?").run(undecided);
  const otherEp = card(ep2, 7, "idea");
  // Phase 7 B4: Cut reel needs a cold open on every card (smoke-reels.ts covers the refusal); these fixtures get one.
  s.prepare("update shorts set cold_start_s = start_s + 1, cold_end_s = start_s + 4.5, cold_text = 'A cold open line.' where episode_id is not null").run();
  // The kit dir is required (gate fix); its VERSION is only read for the kit format, so any temp folder serves the old ones.
  const kitDir = path.join(tmp, "shorts2-kit");
  fs.mkdirSync(kitDir, { recursive: true });
  const hcfg = { handoffsDir: hdir, drivePath: cfg.drivePath, reelKitDir: kitDir };
  assert.throws(() => handoff.cutReel(s, hcfg, { episodeId: ep1, cardIds: [keep1, undecided], format: "v2" }), /not a kept idea/, "undecided cards refused");
  assert.throws(() => handoff.cutReel(s, hcfg, { episodeId: ep1, cardIds: [keep1, otherEp], format: "v2" }), /same episode/, "one episode only");
  assert.throws(() => handoff.cutReel(s, hcfg, { episodeId: ep1, cardIds: [], format: "v2" }), /at least one/);
  assert.throws(() => handoff.cutReel(s, hcfg, { episodeId: ep1, cardIds: [keep1], format: "v9" as never }), /Pick a format/);
  assert.throws(() => handoff.cutReel(s, hcfg, { episodeId: ep1, cardIds: [cA], format: "v2" }), /not a kept idea/, "a card already past Idea");
  // Gate fix: all or nothing. A hand-off write that fails rolls the renumbering and the move back (no orphan list).
  const badDir = path.join(tmp, "shorts2-handoffs-link");
  fs.mkdirSync(path.join(tmp, "shorts2-handoffs-real"), { recursive: true });
  fs.symlinkSync(path.join(tmp, "shorts2-handoffs-real"), badDir);
  assert.throws(() => handoff.cutReel(s, { handoffsDir: badDir, drivePath: cfg.drivePath, reelKitDir: kitDir }, { episodeId: ep1, cardIds: [keep2, keep1], format: "v3" }, NOW + 79), /not a plain folder/);
  assert.deepEqual([g(keep1).k, g(keep1).status, g(keep2).status, g(keep1).handoff], [7, "idea", "idea", null], "the failed write left card 7 un-renumbered and both in Idea");
  assert.deepEqual(fs.readdirSync(path.join(tmp, "shorts2-handoffs-real")), [], "and wrote no list");
  ok("Cut reel all or nothing (gate fix): a hand-off write that fails rolls back the renumbering and the move to Cutting, and leaves no list");
  const cut = handoff.cutReel(s, hcfg, { episodeId: ep1, cardIds: [keep2, keep1], format: "v3" }, NOW + 80);
  const d80 = new Date(NOW + 80);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d80.getFullYear()}-${pad2(d80.getMonth() + 1)}-${pad2(d80.getDate())}-${pad2(d80.getHours())}${pad2(d80.getMinutes())}`;
  assert.equal(path.basename(cut.path), `NSM Ep1 reels ${stamp}.json`, "NSM Ep1 reels.json existed: a dated name");
  const list = JSON.parse(fs.readFileSync(cut.path, "utf8"));
  // nsm-reel-cut's own example (NC Garden Renovation Ad /NSM Ep5 reels.json): {episode, master, status, clips: [{k, start, end, layout, hook, first_line, why, ...}]}.
  // Phase 7 slice 2: the old keys kept, `kit_version` (null for the old formats) and each clip's cold open added after them.
  assert.deepEqual(Object.keys(list), ["episode", "master", "status", "clips", "kit_version"], "the skill example's top level + kit_version");
  assert.deepEqual(list.clips.map((c: Record<string, unknown>) => Object.keys(c)), [
    ["k", "start", "end", "layout", "hook", "first_line", "why", "cold_start", "cold_end"],
    ["k", "start", "end", "layout", "hook", "first_line", "why", "cold_start", "cold_end"],
  ]);
  assert.deepEqual([list.kit_version, list.clips[0].cold_start, list.clips[0].cold_end], [null, 124.46, 127.96], "v3: no kit version; the cold open in master seconds (2 decimals)");
  assert.deepEqual(cut.renumbered, [{ from: 7, to: 42 }], "card 7 collides with the old NSM Ep1 Reel 7: it gets the next free number first");
  assert.equal(g(keep1).k, 42);
  assert.deepEqual(
    [list.episode, list.master, list.clips.map((c: { k: number }) => c.k), list.clips[0].start, list.clips[0].end, list.clips[0].layout, list.clips[0].hook, list.clips[0].why],
    ["NSM Ep1", path.join(rootDir, "Ep One/Northstar Media Ep. 1.mov"), [8, 42], 123.46, 170.1, "center", "STOP THE SCROLL", ""],
    "ordered by k (the reel numbers), seconds with 2 decimals, the caps hook, the master's path",
  );
  assert.equal(s.prepare("select cutting_at from shorts where id = ?").pluck().get(keep1), NOW + 80, "Cutting time recorded (only later reel files count)");
  assert.ok(list.status.startsWith(`APPROVED by Alex 2026-10-01 in ${getConfig().appName} for a v3 cut`), list.status);
  assert.equal(cut.line, handoffText.pasteLine(1, "Ep One", "v3", cut.path, null, (await import("../src/lib/shorts/naming")).handoffNames()));
  assert.match(cut.line, /^Run nsm-reel-cut on Ep1 \(Ep One\) in v3\. These moments are already approved by Alex, skip step 2 picking: .*\. Copy the list into the episode folder as "NSM Ep1 reels\.json"/);
  assert.ok(!/[–—]| - /.test(cut.line), "no dashes in the paste line");
  assert.deepEqual(
    [g(keep1).status, g(keep2).status, g(keep1).handoff?.format, g(keep1).handoff?.path, g(undecided).status, cut.cards],
    ["cutting", "cutting", "v3", cut.path, "idea", 2],
    "the cards move to Cutting and remember the file + format",
  );
  assert.ok(!fs.readdirSync(f1).some((n) => /reels.*\.json$/.test(n)), "nothing written to the episode folder");
  assert.equal(board.getCard(s, keep1, NOW + 80 + 9 * 60_000)!.linkHint, false, "no hint in the first 10 minutes of Cutting");
  assert.equal(board.getCard(s, keep1, NOW + 80 + 10 * 60_000)!.linkHint, true, "a Cutting card with no reel after 10 minutes: Reel already made? Link a file");
  assert.deepEqual(episodes.listEpisodes(s).find((e) => e.id === ep1)!.keptIdeas, 1, "one kept idea left (#6) for cmd+K Cut reel");
  ok("Cut reel: kept Idea cards of ONE episode (undecided / other episode / past Idea refused), a card whose number an older reel uses renumbered first, the list in nsm-reel-cut's reels.json shape (episode, master, status, clips [k, start, end, layout, hook, first_line, why]; 2 decimals; by k), a dated name when the plain one exists, the paste line (no dashes), cards to Cutting with the file + format; nothing in the episode folder");

  // ---------------------------------------------------------------- actions (zod)
  const actions = await import("../src/app/actions");
  assert.ok(!(await actions.cutReelAction({ episodeId: ep1, cardIds: [keep1], format: "v4" })).ok, "zod: format");
  assert.ok(!(await actions.cutReelAction({ episodeId: ep1, cardIds: [keep1], format: "kit2" })).ok, "zod: format (kit, v2, v3, v1 only)");
  assert.ok(!(await actions.cutReelAction({ episodeId: ep1, cardIds: [], format: "v2" })).ok, "zod: at least one card");
  assert.ok(!(await actions.cutReelAction({ episodeId: -1, cardIds: [1], format: "v2" })).ok, "zod: episode");
  assert.ok(!(await actions.approveShortAction({ id: 0 })).ok, "zod: card id");
  assert.ok(!(await actions.linkShortOutputAction({ id: 1, assetId: -2 })).ok, "zod: asset id");
  assert.ok(!(await actions.unlinkShortOutputAction({ id: 1.5 })).ok, "zod: card id");
  assert.ok(!(await actions.sendHookToShortsAction({ hookId: 0 })).ok, "zod: hook id");
  assert.equal(cfg.handoffsDir, process.env.STUDIO_HANDOFFS, "the smoke's hand-off folder (never ~/NSM-Studio/handoffs)");
  void m2;
  void ep3;
  db.sqlite.close();
  ok("slice 2 actions zod-validate Cut reel (episode, 1 to 20 cards, kit / v1 / v2 / v3), Approve, Link / Unlink a file and Send to Shorts");
}
