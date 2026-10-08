/**
 * Phase 7 slice 2 smoke checks (called by scripts/smoke.ts after smoke-ads.ts): better moments (the prompt, cold opens
 * checked like moments and dropped alone, the cold open as the card's main hook: linked / made / owned / Discard), the
 * hook gate (Settings value, unscored cards visible, kept never hidden, weaker behind Show weaker), the cold open picker
 * (valid / invalid / an episode without a word transcript), hook words 2 to 6 with one `*` block, Make explainer + its
 * paste line, Cut reel in the kit format (refuses a card without a cold open, cold_start / cold_end / kit_version, the
 * VERSION reader: good / missing / junk / symlink / oversize), the kit note reader (` kit.json` only, 64 KB, zod, cache,
 * error rows, refused names / symlinks / junk / shapes), medians + Kit tags + groups + the winner rule's edges, and the
 * kit-tests route. A FRESH temp DB, temp roots / cache / kit dir, a stub `claude` (CLAUDE_BIN) and FakeJev: never the
 * drive, never the real claude CLI, never Jev, Google or the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";
import { whisperJsonFor } from "./smoke-shorts";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const NOW = Date.UTC(2026, 9, 1, 18, 0, 0);
const DAY = 86_400_000;

function srtTime(s: number) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** 240 one-sentence cues (3 s every third, else 2 s) with a few planted problems. */
function reelCues() {
  const cues: { start: number; end: number; text: string }[] = [];
  let t = 0;
  for (let i = 0; i < 240; i++) {
    let text = `Point ${i} is a clear claim about ads.`;
    let d = i % 3 === 0 ? 3 : 2;
    if (i === 35) text = "This shit costs you real leads every week.";
    if (i === 50) text = "Leads — they leave fast if you wait.";
    if (i === 65) text = "We leverage the budget well this time.";
    if (i === 112) {
      text = "Yes.";
      d = 1;
    }
    if (i === 113) d = 7;
    cues.push({ start: t, end: t + d, text });
    t += d;
  }
  return cues;
}

export async function runReelsSmoke({ cfg, tmp, ok }: Ctx) {
  const { openDb, getDb } = await import("../src/lib/db");
  const rules = await import("../src/lib/shorts/rules");
  const episodes = await import("../src/lib/shorts/episodes");
  const transcript = await import("../src/lib/shorts/transcript");
  const moments = await import("../src/lib/shorts/moments");
  const board = await import("../src/lib/shorts/board");
  const handoff = await import("../src/lib/shorts/handoff");
  const handoffText = await import("../src/lib/shorts/handoff-text");
  const kit = await import("../src/lib/shorts/kit");
  const textread = await import("../src/lib/textread");
  const hookStore = await import("../src/lib/hooks/store");
  const { ShortMomentsQueue } = await import("../src/worker/shorts");
  const { HookScoreQueue } = await import("../src/worker/hooks");
  const { FakeJev } = await import("../src/lib/ai/fake");
  const { Jev } = await import("../src/lib/ai/jev");

  const db = openDb(path.join(tmp, "reels.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const quiet = () => {};
  const drive = { drivePath: cfg.drivePath, fakeUnmounted: false, driveMode: cfg.driveMode };
  const NSM = s.prepare("select id from sections where key = 'rtm'").pluck().get() as number;
  s.prepare("update roots set enabled = 0").run(); // seeded roots point at the real drive: never read here

  // ---------------------------------------------------------------- hook words: 2 to 6, one `*` block (pure)
  const overlay = rules.overlayRules([]);
  assert.equal(rules.normalizeHookWords("you paid for * this lead *."), "YOU PAID FOR *THIS LEAD*", "the marker kept, spaces inside it trimmed, outer punctuation off");
  assert.equal(rules.normalizeHookWords("*the 3 p's* of ad copy"), "*THE 3 P'S* OF AD COPY");
  assert.equal(rules.hookWordsPlain("YOU PAID FOR *THIS LEAD*"), "YOU PAID FOR THIS LEAD");
  assert.deepEqual(rules.splitHookWords("YOU PAID FOR *THIS LEAD*"), { before: "YOU PAID FOR", block: "THIS LEAD", after: "" });
  assert.equal(rules.splitHookWords("NO BLOCK HERE"), null);
  const hw = (w: string) => rules.checkHookWords(rules.normalizeHookWords(w), overlay);
  assert.equal(hw("YOU PAID FOR *THIS LEAD*"), null, "5 words with a block");
  assert.equal(hw("THE ONE THING EVERY AD MISSES"), null, "6 words, no block (the builder blocks the last line)");
  assert.equal(hw("*THE ONE THING EVERY* AD MISSES"), null, "6 words counted without the marker");
  assert.match(hw("THE ONE THING EVERY GOOD AD MISSES")!, /7 words \(2 to 6\)/, "7 words refused");
  assert.match(hw("STOP")!, /1 word/);
  assert.match(hw("*ONE* AND *TWO* BLOCKS")!, /ONE pair/, "at most one block");
  assert.match(hw("A *SINGLE STAR")!, /ONE pair/, "an unpaired marker");
  assert.match(hw("EMPTY ** BLOCK HERE")!, /marks no words/);
  assert.match(hw("*FOLLOW-UP* WINS")!, /hyphen/i, "the copy rules read the text without the marker");
  assert.match(hw("WHY *TEXAS* ADS FAIL")!, /state/i);
  ok("hook words (B5): 2 to 6 caps words counted without the `*` marker, at most one `*...*` orange block around at least one word, NSM's copy rules on the text without `*`, normalized with the marker kept");

  // ---------------------------------------------------------------- cold open checks (pure)
  const cues = reelCues();
  const at = (i: number) => cues[i].start;
  const en = (i: number) => cues[i].end;
  const moment = { startCue: 105, endCue: 119 };
  const co = (a: number, b: number) => rules.checkColdOpen({ start: at(a), end: en(b) }, { units: cues, episodeEnd: en(239), moment });
  const one = co(106, 106);
  assert.ok(one.ok && one.cold.start === Math.round((at(106) - 0.2) * 100) / 100 && one.cold.end === Math.round((en(106) + 0.2) * 100) / 100, "one sentence + the 0.2 s pad");
  assert.equal(one.ok && one.cold.text, "Point 106 is a clear claim about ads.");
  const two = co(107, 108);
  assert.ok(two.ok && two.cold.startUnit === 107 && two.cold.endUnit === 108 && two.cold.text.startsWith("Point 107"), "two adjacent sentences");
  const why = (v: ReturnType<typeof co>) => (v.ok ? "ok" : v.rule);
  assert.deepEqual(
    [why(co(106, 108)), why(co(112, 112)), why(co(113, 113)), why(co(100, 100)), why(co(118, 120))],
    ["cold_units", "cold_length", "cold_length", "cold_outside", "cold_outside"],
    "three sentences, 1.4 s, 7.4 s, before the moment, past its end",
  );
  const mOf = (a: number, b: number) => ({ startCue: a, endCue: b });
  const coIn = (i: number, m: { startCue: number; endCue: number }) => rules.checkColdOpen({ start: at(i), end: en(i) }, { units: cues, episodeEnd: en(239), moment: m });
  assert.deepEqual([why(coIn(35, mOf(30, 44))), why(coIn(50, mOf(45, 59))), why(coIn(65, mOf(60, 74)))], ["cold_profanity", "cold_copy", "cold_copy"], "profanity, a dash, an AI tell");
  assert.equal(why(rules.checkColdOpen({ start: NaN, end: 4 }, { units: cues, episodeEnd: 600, moment })), "cold_times");
  // Alex 2026-10-01: never a connector / filler first (it is heard first, with no context).
  const lead = (first: string) => [
    { start: 0, end: 3, text: `${first} you paid for this lead and lost it.` },
    { start: 3, end: 6, text: "Point two is a clear claim about ads." },
  ];
  const opener = (first: string) => why(rules.checkColdOpen({ start: 0, end: 3 }, { units: lead(first), episodeEnd: 60, moment: { startCue: 0, endCue: 1 } }));
  assert.deepEqual(
    ["So", "But,", "and", "Because", "Okay,", "Now", "Well", "Right,", "Alright", "Plus", "Then", "Like", "Yeah"].map(opener),
    Array(13).fill("cold_opener"),
    "a connector or filler first word drops the cold open",
  );
  assert.deepEqual(["You", "Sooner", "Nobody", "Wells"].map(opener), ["ok", "ok", "ok", "ok"], "other first words pass (whole words only)");
  assert.equal(rules.coldOpenerProblem("  Okay. So the leak is the form."), "okay");
  assert.equal(opener("Uh,"), "ok", "a filler like uh is cleaned out of the text first (cleanSpoken), so the line starts on its real first word");
  ok("cold open checks (B1): snapped to sentences + 0.2 s pad, inside the moment, one or two adjacent sentences, 2 to 6 s, never a connector / filler first word, no profanity, no dash used as punctuation, no AI tell; the transcript's own text");

  // ---------------------------------------------------------------- fixture episode (word-timed) + one without words
  const rootDir = path.join(tmp, "reels-root");
  const outside = path.join(tmp, "reels-outside");
  const epDir = path.join(rootDir, "Ep One");
  const ep2Dir = path.join(rootDir, "Ep Two");
  const reelDir = path.join(rootDir, "Reels");
  for (const d of [epDir, ep2Dir, reelDir, outside]) fs.mkdirSync(d, { recursive: true });
  const srtText = cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`).join("\n\n") + "\n";
  fs.writeFileSync(path.join(epDir, "NSM Ep1.srt"), srtText);
  fs.writeFileSync(path.join(ep2Dir, "NSM Ep2.srt"), srtText);
  const root = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(rootDir, NSM).lastInsertRowid);
  const insAsset = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status, duration_s, sha256, asset_class, thumb_path)
     values (?, ?, ?, ?, ?, 'mp4', 'video', 1, ?, 1, 'done', ?, ?, ?, 'x/thumb.webp')`,
  );
  const asset = (rel: string, cls: string | null = null, dur = 40) =>
    Number(insAsset.run(NSM, root, path.join(rootDir, rel), rel, path.basename(rel), NOW, dur, `sha-${rel}`, cls).lastInsertRowid);
  const master = asset("Ep One/Northstar Media Ep. 1.mov", "episode", en(239));
  asset("Ep Two/Northstar Media Ep. 2.mov", "episode", en(239));
  episodes.syncEpisodes(s, drive, NOW);
  const epList = episodes.listEpisodes(s);
  const ep1 = epList.find((e) => e.num === 1)!.id;
  const ep2 = epList.find((e) => e.num === 2)!.id;
  transcript.storeWords(
    s,
    { episodeId: ep1, num: 1, label: "", assetId: master, sha256: `sha-Ep One/Northstar Media Ep. 1.mov`, proxyPath: "x", durationS: en(239) },
    whisperJsonFor(cues),
    "ggml-small.en.bin",
    1000,
    NOW,
  );
  const sentences = episodes.getEpisode(s, ep1)!.sentences!;
  assert.equal(sentences.length, 240, "one sentence per cue");
  assert.equal(episodes.getEpisode(s, ep2)!.sentences, null, "Ep2 has no word transcript (cue units)");

  // ---------------------------------------------------------------- the moments job (stub claude)
  const stubDir = path.join(tmp, "reels-claude-stub");
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, "claude");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
D='${stubDir}'
N=$(cat "$D/count" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "$D/count"
printf '%s\\n' "$@" > "$D/args-$N.txt"
cat "$D/answer.json"
`,
  );
  fs.chmodSync(stub, 0o755);
  const savedBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = stub;
  const w = (k: number) => ({ a: 15 * k, b: 15 * k + 14 }); // window k = cues 15k .. 15k+14 (about 35 s)
  const mo = (k: number, hook: string, cold: [number, number] | null) => ({
    start: at(w(k).a),
    end: en(w(k).b),
    ...(cold ? { cold_start: at(cold[0]), cold_end: en(cold[1]) } : {}),
    first_line: "x",
    hook,
    why: "It stands alone.",
    layout: "stack",
  });
  const list = [
    mo(8, "THE ONE THING EVERY GOOD AD MISSES", [121, 121]), // 7 words: the moment is dropped
    mo(9, "*ONE* AND *TWO* BLOCKS", [136, 136]), // two blocks
    mo(10, "EMPTY ** BLOCK", [151, 151]), // an empty block
    mo(0, "you paid for *this lead*", [3, 3]), // a single sentence cold open
    mo(1, "THE ONE THING EVERY AD MISSES", [16, 17]), // two sentences; 6 words
    mo(2, "THE COST OF *WAITING*", [35, 35]), // profanity in the cold open
    mo(3, "WHY LEADS *LEAVE*", [50, 50]), // a dash in it
    mo(4, "THE BUDGET *TRAP*", [65, 65]), // an AI tell
    mo(5, "THREE LINES *TOO MANY*", [76, 78]), // three sentences
    mo(6, "OUTSIDE THE *MOMENT*", [3, 3]), // outside its moment
    mo(7, "NO COLD *OPEN*", null), // none proposed
  ];
  fs.writeFileSync(
    path.join(stubDir, "answer.json"),
    JSON.stringify({
      type: "result",
      is_error: false,
      duration_ms: 9000,
      result: JSON.stringify({ moments: list }),
      usage: { input_tokens: 3, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 7000 },
      modelUsage: { "claude-opus-5": { outputTokens: 900 } },
    }),
  );
  // W1's cold open line already is an NSM hook: the card links it (not owned).
  const coldW1 = "Point 16 is a clear claim about ads. Point 17 is a clear claim about ads.";
  const linked = hookStore.addTextHooks(s, { section: "rtm", clientCode: null }, [{ text: coldW1, source: "manual" }], NOW).ids[0];
  hookStore.setHooksPaused(s, true);
  const q = new ShortMomentsQueue(s, { cacheDir: cfg.cacheDir, logsDir: cfg.logsDir, drive, log: quiet, isStopped: () => false, timeoutMs: 15_000, idleMs: 5 });
  const jobId = moments.queueMoments(s, ep1, NOW);
  assert.equal((await q.drain()).done, 1);
  const args = fs.readFileSync(path.join(stubDir, "args-1.txt"), "utf8");
  for (const bit of ["cold_start", "COLD OPEN", "Never demo narration", "So now I'm going to go to Claude.", "self contained claim or lesson", "works as an opener", "*THIS LEAD*", "2 to 6 words", "ONE pair of asterisks", "no context at all", "WRONG pick", "never starts on a connector or a filler",
    "2 to 5 seconds from cold_start to cold_end (never over 6: a longer one is dropped)",
    "(So, But, And, Because, Or, Then, Like, Okay, Ok, Yeah, Um, Uh, Well, Now, Right, Alright, Also, Plus)"]) {
    assert.ok(args.includes(bit), `prompt has: ${bit}`);
  }
  const job = s.prepare("select status, result from jobs where id = ?").get(jobId) as { status: string; result: string };
  const res = JSON.parse(job.result) as import("../src/lib/shorts/moments").MomentJobResult;
  for (const gone of ["2 to 6 seconds from cold_start", "about 2 to 5 seconds spoken"]) assert.ok(!args.includes(gone), `the cold open length is stated once (not: ${gone})`);
  assert.deepEqual([job.status, res.promptVersion, res.attempts.length, res.attempts[0].returned, res.attempts[0].kept], ["done", 4, 1, 11, 8]);
  assert.deepEqual(res.attempts[0].dropped.map((d) => d.rule), ["hook", "hook", "hook"], "7 words, two blocks, an empty block: the whole moment dropped");
  assert.deepEqual(
    res.attempts[0].coldDropped!.map((d) => [d.hook, d.rule]),
    [
      ["THE COST OF *WAITING*", "cold_profanity"],
      ["WHY LEADS *LEAVE*", "cold_copy"],
      ["THE BUDGET *TRAP*", "cold_copy"],
      ["THREE LINES *TOO MANY*", "cold_units"],
      ["OUTSIDE THE *MOMENT*", "cold_outside"],
      ["NO COLD *OPEN*", "cold_missing"],
    ],
    "a bad cold open drops only the cold open (the card survives), its rule recorded in the job result",
  );
  type Row = { id: number; k: number; hook_words: string; hook_id: number; hook_owned: number; cold_start_s: number | null; cold_end_s: number | null; cold_text: string | null; cold_hook_id: number | null; cold_hook_owned: number };
  const cards = s.prepare("select * from shorts where job_id = ? order by k").all(jobId) as Row[];
  assert.equal(cards.length, 8);
  const [W0, W1, W2, W3, W4, W5, W6, W7] = cards;
  assert.deepEqual(
    cards.map((c) => [c.hook_words, c.cold_text != null]),
    [
      ["YOU PAID FOR *THIS LEAD*", true],
      ["THE ONE THING EVERY AD MISSES", true],
      ["THE COST OF *WAITING*", false],
      ["WHY LEADS *LEAVE*", false],
      ["THE BUDGET *TRAP*", false],
      ["THREE LINES *TOO MANY*", false],
      ["OUTSIDE THE *MOMENT*", false],
      ["NO COLD *OPEN*", false],
    ],
    "hook words stored with their marker; cold opens kept only where they passed",
  );
  const hk = (id: number) => s.prepare("select text, source, score_requested_at, archived_at from hooks where id = ?").get(id) as { text: string; source: string; score_requested_at: number | null; archived_at: number | null };
  assert.deepEqual([W0.cold_text, W0.cold_start_s, W0.cold_end_s, hk(W0.cold_hook_id!).source, W0.cold_hook_owned], ["Point 3 is a clear claim about ads.", 6.8, 10.2, "moment", 1], "W0: a new moment hook for its cold open (owned)");
  assert.ok(hk(W0.cold_hook_id!).score_requested_at && hk(W0.hook_id).score_requested_at, "both hooks requested for scoring");
  assert.deepEqual([W1.cold_text, W1.cold_hook_id, W1.cold_hook_owned], [coldW1, linked, 0], "W1: an equal NSM hook linked (not owned)");
  ok("moments job (stub claude, prompt v4: the cold open length stated once, the connector list from COLD_BAD_FIRST_WORDS): self contained claims, never demo narration, an opener first line, a cold open per moment that stands on its own (no connector / filler first) and hook words with one `*` block in the prompt; bad hooks drop the moment, bad cold opens only the cold open (recorded); the cold open line becomes the card's main hook (a new owned `moment` hook or an equal one linked), both hooks requested for scoring");

  // ---------------------------------------------------------------- main hook, scoring, rule B, the gate
  const before = board.boardData(s, NOW);
  assert.equal(before.gate, 2.6, "default gate 2.6");
  assert.ok(before.columns.idea.length === 8 && before.weaker.length === 0, "nothing scored yet: every card visible");
  assert.ok(before.columns.idea.every((c) => c.scoring), "marked scoring");
  const g = (id: number) => board.getCard(s, id, NOW)!;
  assert.deepEqual([g(W0.id).mainHookId, g(W0.id).hookId, g(W7.id).mainHookId], [W0.cold_hook_id, W0.hook_id, W7.hook_id], "main hook = the cold open's, else the first line's");
  const fj = new FakeJev();
  fj.respond = (_id, q2, state) => (q2.type === "score" && JSON.stringify(state).includes("Point 16 is") ? { score: 0 } : undefined);
  const jev = new Jev(s, fj, "jev-1.13.0", { sleep: async () => {} });
  await new HookScoreQueue(s, { jev, log: quiet, isStopped: () => false, idleMs: 5 }).drain();
  const scored = board.boardData(s, NOW);
  assert.deepEqual(scored.weaker.map((c) => c.id), [W1.id], "W1's main hook (its cold open) scored 1.0 < 2.6: behind Show weaker, although its first line scored 3.0");
  const w1 = scored.weaker[0];
  assert.deepEqual([w1.score?.overall, w1.line?.overall], [1, 3], "the main score and the first line's own score (shown small)");
  assert.equal(g(W7.id).line, null, "no cold open: the first line is the main hook (no small score)");
  assert.equal(scored.columns.idea.length, 7);
  board.setShortsGate(s, 1);
  assert.deepEqual([board.shortsGate(s), board.boardData(s, NOW).weaker.length], [1, 0], "Settings value: gate 1.0 hides nothing");
  assert.throws(() => board.setShortsGate(s, 5.5), /1 to 5/);
  s.prepare("update app_settings set value = 'abc' where key = 'shorts:gate'").run();
  assert.equal(board.shortsGate(s), 2.6, "a bad stored value = the default");
  board.setShortsGate(s, 2.6);
  board.keepShort(s, W1.id, NOW + 1);
  const keptB = board.boardData(s, NOW);
  assert.ok(keptB.weaker.length === 0 && keptB.columns.idea.some((c) => c.id === W1.id), "kept cards are never hidden");
  const actions = await import("../src/app/actions");
  assert.ok(!(await actions.setShortsGateAction({ value: 6 })).ok && !(await actions.setShortsGateAction({ value: 0.5 })).ok, "zod: 1 to 5");
  ok("hook gate (B3): undecided Idea cards whose MAIN hook overall < the gate (Settings `shorts:gate`, default 2.6, 1 to 5, a bad value = default) sit behind Show weaker; unscored cards stay visible marked scoring; kept cards never hidden; rule B on the main hook; the first line's score kept small");

  // ---------------------------------------------------------------- the cold open picker
  const ch = board.coldOpenChoices(s, W7.id);
  assert.deepEqual([ch.unit, ch.units.length, ch.units[0].i, ch.selected], ["sentence", 15, 105, []], "the moment's 15 sentences, none picked");
  assert.deepEqual(board.coldOpenChoices(s, W0.id).selected, [3], "the current cold open is marked");
  board.setColdOpen(s, W7.id, { start: at(106), end: en(106) }, NOW + 2);
  const w7 = s.prepare("select cold_text, cold_hook_id, cold_hook_owned from shorts where id = ?").get(W7.id) as { cold_text: string; cold_hook_id: number; cold_hook_owned: number };
  assert.deepEqual([w7.cold_text, w7.cold_hook_owned, hk(w7.cold_hook_id).source], ["Point 106 is a clear claim about ads.", 1, "moment"]);
  assert.ok(hk(w7.cold_hook_id).score_requested_at, "the new line is requested for scoring");
  assert.throws(() => board.setColdOpen(s, W7.id, { start: at(106), end: en(108) }), /one or two/, "three sentences refused");
  assert.throws(() => board.setColdOpen(s, W7.id, { start: at(3), end: en(3) }), /outside the moment/);
  assert.throws(() => board.setColdOpen(s, W7.id, { start: at(112), end: en(112) }), /2 to 6/, "too short");
  assert.throws(() => board.setColdOpen(s, W2.id, { start: at(35), end: en(35) }), /Profanity/, "re-validated on the server");
  board.setColdOpen(s, W7.id, { start: at(109), end: en(110) }, NOW + 3);
  const w7b = s.prepare("select cold_text, cold_hook_id from shorts where id = ?").get(W7.id) as { cold_text: string; cold_hook_id: number };
  assert.deepEqual([w7b.cold_hook_id, hk(w7b.cold_hook_id).text], [w7.cold_hook_id, w7b.cold_text], "a swap rewrites the card's own cold open hook in place");
  assert.ok(w7b.cold_text.startsWith("Point 109") && w7b.cold_text.includes("Point 110"));
  // An episode without a word transcript: the picker works on its SRT cues.
  const ins = s.prepare(
    `insert into shorts (episode_id, k, start_s, end_s, first_line, hook_words, why, layout, status, kept, hook_id, hook_owned, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, null, 'stack', 'idea', 1, null, 0, ?, ?)`,
  );
  const cueCard = Number(ins.run(ep2, 1, 0, en(14) + 0.2, "Point 0 is a clear claim about ads.", "CUE CARD *HERE*", NOW, NOW).lastInsertRowid);
  assert.equal(board.coldOpenChoices(s, cueCard).unit, "cue", "no word transcript: cue units");
  board.setColdOpen(s, cueCard, { start: at(4), end: en(5) }, NOW + 4);
  assert.equal(g(cueCard).cold?.text, "Point 4 is a clear claim about ads. Point 5 is a clear claim about ads.");
  assert.ok(!(await actions.setColdOpenAction({ id: W7.id, start: 5, end: 4 })).ok, "zod: a time range");
  assert.ok(!(await actions.setColdOpenAction({ id: W7.id, start: Number.NaN, end: 4 })).ok, "zod: finite");
  // A nudge that leaves the cold open outside the moment clears it.
  board.setColdOpen(s, W6.id, { start: at(90), end: en(90) }, NOW + 5);
  const nudged = board.nudgeShort(s, W6.id, "start", 1, NOW + 6);
  assert.deepEqual([nudged.coldCleared, g(W6.id).cold], [true, null], "a start nudged past the cold open clears it");
  ok("cold open picker (B4): the moment's sentences (cue units without a word transcript) with the current pick marked; set / swap re-checked on the server (three sentences, outside, too short, profanity refused); the new line linked / made as a hook and requested (a swap rewrites its own hook in place); a nudge past it clears it; zod on the action");

  // Gate fix: a card whose cold open IS its first line (insertCards links the cold column to the first line's owned
  // hook). A start nudge past it must not leave the old hook orphaned on the NSM Hooks tab; one that keeps the cold open
  // hands the hook's ownership to the cold column (so Discard still archives it).
  const sameCard = (a: number, b: number, k: number) => {
    const id = Number(ins.run(ep1, k, at(a) - 0.2, en(b) + 0.2, `Point ${a} is a clear claim about ads.`, "SAME LINE *TWICE*", NOW, NOW).lastInsertRowid);
    const h = moments.createMomentHook(s, `Point ${a} is a clear claim about ads.`, NOW);
    s.prepare("update shorts set hook_id = ?, hook_owned = 1 where id = ?").run(h, id);
    board.setColdOpen(s, id, { start: at(a), end: en(a) }, NOW + 5);
    return { id, h };
  };
  type Cols = { hook_id: number; hook_owned: number; cold_hook_id: number | null; cold_hook_owned: number; cold_text: string | null };
  const cols = (id: number) => s.prepare("select hook_id, hook_owned, cold_hook_id, cold_hook_owned, cold_text from shorts where id = ?").get(id) as Cols;
  const SA = sameCard(180, 195, 90);
  assert.deepEqual([cols(SA.id).cold_hook_id, cols(SA.id).cold_hook_owned, cols(SA.id).hook_owned], [SA.h, 0, 1], "the cold open is linked to the first line's owned hook");
  const sn = board.nudgeShort(s, SA.id, "start", 1, NOW + 6);
  const sa = cols(SA.id);
  assert.deepEqual([sn.coldCleared, sn.hookChanged, sa.cold_hook_id, sa.cold_text], [true, true, null, null], "the start nudged past the cold open clears it");
  assert.ok(hk(SA.h).archived_at != null, "the old first line hook (used by no live card now) is archived, not left orphaned");
  assert.ok(sa.hook_id !== SA.h && sa.hook_owned === 1 && hk(sa.hook_id).archived_at == null && hk(sa.hook_id).text === "Point 181 is a clear claim about ads.", "the new first line hook is live and owned");
  const SB = sameCard(200, 215, 91);
  board.nudgeShort(s, SB.id, "start", -1, NOW + 6);
  const sb = cols(SB.id);
  assert.deepEqual([sb.cold_hook_id, sb.cold_hook_owned, hk(SB.h).archived_at], [SB.h, 1, null], "a cold open the nudge keeps takes over the old hook's ownership (still live)");
  board.discardShort(s, SB.id, NOW + 6);
  assert.ok(hk(SB.h).archived_at != null && hk(sb.hook_id).archived_at != null, "so Discard archives both");
  board.discardShort(s, SA.id, NOW + 6);
  ok("gate fix: a start nudge on a card whose cold open is its first line (cold column linked to the first line's owned hook) archives the old hook when no live card uses it (no orphan on the Hooks tab), clears the cold open and links a live new first line hook; a cold open the nudge keeps takes over the hook's ownership, so Discard still archives it");

  // ---------------------------------------------------------------- Discard + ownership
  board.discardShort(s, W0.id, NOW + 7);
  assert.ok(hk(W0.hook_id).archived_at && hk(W0.cold_hook_id!).archived_at, "Discard archives both hooks the card owns");
  board.discardShort(s, W1.id, NOW + 8);
  assert.ok(hk(W1.hook_id).archived_at && hk(linked).archived_at == null, "a linked cold open hook is never archived");
  ok("Discard: the card's first line hook and its owned cold open hook archived (unless another live card uses them); a linked hook stays");

  // ---------------------------------------------------------------- Make explainer + paste line
  const ex = board.makeExplainer(s, W7.id, NOW + 9);
  assert.equal(ex.created, true);
  const exCard = g(ex.cardId);
  const w7start = (s.prepare("select start_s from shorts where id = ?").pluck().get(W7.id) as number);
  assert.deepEqual([exCard.explainer, exCard.hookId, exCard.source?.cardId, exCard.firstLine], [true, w7b.cold_hook_id, W7.id, w7b.cold_text], "Make explainer = Send to Shorts on the main hook, remembering the card");
  assert.equal(exCard.explainerLine, `Run nsm-explainer-reel on this idea from NSM Ep1 at ${handoffText.clockMSS(w7start)}: ${w7b.cold_text} Use nsm-reel-kit.`);
  assert.match(handoffText.clockMSS(w7start), /^\d+:\d{2}$/, "m:ss");
  assert.deepEqual(board.makeExplainer(s, W7.id, NOW + 10), { cardId: ex.cardId, created: false }, "one per hook");
  assert.throws(() => board.makeExplainer(s, ex.cardId), /already is an explainer/);
  const plain = board.sendHookToShorts(s, hookStore.addTextHooks(s, { section: "rtm", clientCode: null }, [{ text: "Speed to lead — beats every ad tweak", source: "manual" }], NOW).ids[0], NOW);
  const pl = g(plain.cardId).explainerLine!;
  assert.equal(pl, "Run nsm-explainer-reel on this idea: Speed to lead, beats every ad tweak. Use nsm-reel-kit.", "no source: no bracket; dashes out; a period added");
  for (const line of [pl, exCard.explainerLine!]) assert.ok(!/[–—]| - |--/.test(line), "no dashes in the paste line");
  assert.equal(handoffText.explainerPasteLine("Is it the ad?", { num: 6, start: 3725 }, (await import("../src/lib/shorts/naming")).handoffNames()), "Run nsm-explainer-reel on this idea from NSM Ep6 at 1:02:05: Is it the ad? Use nsm-reel-kit.");
  assert.ok(!(await actions.makeExplainerAction({ id: 0 })).ok, "zod: card id");
  ok("Make explainer (C1) + Copy paste line (C2): an explainer idea from the card's main hook that remembers its card; `Run nsm-explainer-reel on this idea[ from NSM EpN at m:ss]: <line>. Use nsm-reel-kit.` (no dashes, no file written)");

  // ---------------------------------------------------------------- Cut reel: kit format + VERSION reader
  const kitDir = cfg.reelKitDir;
  fs.mkdirSync(kitDir, { recursive: true });
  const ver = path.join(kitDir, "VERSION");
  assert.equal(kit.readKitVersion(kitDir, cfg.drivePath), 1, "missing VERSION = 1");
  fs.writeFileSync(ver, "3\n");
  assert.equal(kit.readKitVersion(kitDir, cfg.drivePath), 3, "a good VERSION");
  fs.writeFileSync(ver, "v2\n");
  assert.equal(kit.readKitVersion(kitDir, cfg.drivePath), 1, "junk = 1");
  fs.writeFileSync(ver, "0\n");
  assert.equal(kit.readKitVersion(kitDir, cfg.drivePath), 1, "0 = 1");
  fs.writeFileSync(ver, `2${" ".repeat(20)}\n`);
  assert.equal(kit.readKitVersion(kitDir, cfg.drivePath), 1, "over 16 bytes = 1");
  fs.rmSync(ver);
  fs.writeFileSync(path.join(outside, "VERSION"), "7\n");
  fs.symlinkSync(path.join(outside, "VERSION"), ver);
  assert.equal(kit.readKitVersion(kitDir, cfg.drivePath), 1, "a symlinked VERSION is refused (O_NOFOLLOW)");
  fs.rmSync(ver);
  fs.writeFileSync(ver, "2\n");
  assert.equal(kit.readKitVersion(kitDir, cfg.drivePath), 2);
  assert.equal(kit.readKitVersion(path.join(cfg.drivePath, "kit"), cfg.drivePath), 1, "never on the drive");
  assert.deepEqual([handoffText.HANDOFF_FORMATS[0], handoffText.DEFAULT_HANDOFF_FORMAT, handoffText.formatLabel("kit", 2, (await import("../src/lib/shorts/naming")).handoffNames())], ["kit", "kit", "NSM reel kit v2"], "kit first and the default");
  const hdir = cfg.handoffsDir;
  const hcfg = { handoffsDir: hdir, drivePath: cfg.drivePath, reelKitDir: kitDir };
  board.keepShort(s, W3.id, NOW + 11);
  board.keepShort(s, W5.id, NOW + 11);
  const filesBefore = fs.existsSync(hdir) ? fs.readdirSync(hdir).length : 0;
  assert.throws(() => handoff.cutReel(s, hcfg, { episodeId: ep1, cardIds: [W3.id, W5.id], format: "kit" }, NOW + 12), /pick a cold open first/i, "a card without a cold open is refused");
  assert.deepEqual([g(W3.id).status, g(W5.id).status, fs.existsSync(hdir) ? fs.readdirSync(hdir).length : 0], ["idea", "idea", filesBefore], "all or nothing: nothing moved, no list");
  board.setColdOpen(s, W3.id, { start: at(46), end: en(46) }, NOW + 13);
  board.setColdOpen(s, W5.id, { start: at(76), end: en(77) }, NOW + 13);
  const cut = handoff.cutReel(s, hcfg, { episodeId: ep1, cardIds: [W3.id, W5.id], format: "kit" }, NOW + 14);
  const listed = JSON.parse(fs.readFileSync(cut.path, "utf8"));
  assert.deepEqual(Object.keys(listed), ["episode", "master", "status", "clips", "kit_version"]);
  assert.equal(listed.kit_version, 2, "kit_version from VERSION");
  assert.deepEqual(Object.keys(listed.clips[0]), ["k", "start", "end", "layout", "hook", "first_line", "why", "cold_start", "cold_end"]);
  const c3 = s.prepare("select cold_start_s, cold_end_s from shorts where id = ?").get(W3.id) as { cold_start_s: number; cold_end_s: number };
  assert.deepEqual([listed.clips[0].hook, listed.clips[0].cold_start, listed.clips[0].cold_end], ["WHY LEADS *LEAVE*", c3.cold_start_s, c3.cold_end_s], "the hook words with their marker, the cold open in master seconds");
  assert.match(listed.status, /for a nsm-reel-kit v2 cut \(NSM reel kit v2\)/);
  assert.match(cut.line, /^Run nsm-reel-cut on Ep1 \(Ep One\) on nsm-reel-kit v2\. .*Open each reel on its cold open/);
  assert.ok(!/[–—]| - /.test(cut.line), "no dashes in the kit paste line");
  assert.deepEqual([g(W3.id).status, g(W3.id).handoff?.format, g(W3.id).handoff?.formatLabel, g(W3.id).handoff?.line], ["cutting", "kit", "NSM reel kit v2", cut.line], "the card remembers the kit version for its paste line");
  assert.ok(!(await actions.cutReelAction({ episodeId: ep1, cardIds: [W5.id], format: "kit3" })).ok);
  ok("Cut reel (D1): the kit format first and the default (old v2 / v3 / v1 kept for re-renders), refuses a card without a cold open (all or nothing), the list gains cold_start / cold_end per clip and kit_version (the ONE VERSION reader: good, missing, junk, 0, oversize, symlink, on the drive), the hook words keep their `*` marker, the paste line names the kit (no dashes)");

  // ---------------------------------------------------------------- kit notes (D2)
  const note = (version: number, test: { change: string; detail: string } | null) => JSON.stringify({ kit: "nsm-reel-kit", version, test });
  const reel = (stem: string) => asset(`Reels/${stem}.mp4`);
  const rA = reel("NSM A Reel v1");
  fs.writeFileSync(path.join(reelDir, "NSM A Reel kit.json"), note(1, null));
  const rB = reel("NSM B Reel v2");
  fs.writeFileSync(path.join(reelDir, "NSM B Reel kit.json"), note(1, { change: "hook 170px", detail: "the hook headline at 170px" }));
  const rC = reel("NSM C Reel");
  fs.writeFileSync(path.join(reelDir, "NSM C Reel kit.json"), "{nope");
  const rD = reel("NSM D Reel");
  fs.writeFileSync(path.join(reelDir, "NSM D Reel kit.json"), JSON.stringify({ kit: "nsm-reel-kit", version: 1, test: null, extra: true }));
  const rE = reel("NSM E Reel");
  fs.writeFileSync(path.join(outside, "NSM E Reel kit.json"), note(1, null));
  fs.symlinkSync(path.join(outside, "NSM E Reel kit.json"), path.join(reelDir, "NSM E Reel kit.json"));
  const rF = reel("NSM F Reel");
  fs.writeFileSync(path.join(reelDir, "NSM F Reel kit.json"), JSON.stringify({ kit: "nsm-reel-kit", version: 1, test: { change: "x", detail: "y".repeat(70_000) } }));
  const rG = reel("NSM G Reel");
  const rH = reel("NSM H Reel");
  fs.writeFileSync(path.join(reelDir, "NSM H Reel.json"), note(1, null)); // a .json without " kit": never read
  assert.equal(kit.kitNoteNameFor("NSM Ep5 Reel 1 v3.mp4"), "NSM Ep5 Reel 1 kit.json");
  assert.equal(kit.kitNoteNameFor("NSM Speed to Lead Reel v1.mp4"), "NSM Speed to Lead Reel kit.json");
  const bases = [rootDir];
  assert.throws(() => textread.readKitNote(path.join(reelDir, "NSM H Reel.json"), bases), /Not a kit note name/, "a .json without ` kit` refused");
  assert.throws(() => textread.readGuardedText(path.join(reelDir, "NSM A Reel kit.json"), bases), /\.srt \/ \.txt only/, "the default reader never reads .json");
  assert.throws(() => textread.readGuardedText(path.join(reelDir, "NSM A Reel kit.json"), bases, textread.CAPTION_EXTS), /\.md only/);
  fs.writeFileSync(path.join(reelDir, "notes kit.txt"), "x");
  assert.throws(() => textread.readKitNote(path.join(reelDir, "notes kit.txt"), bases), /Not a kit note name/, "a kit name with another extension");
  assert.throws(() => textread.readKitNote(path.join(reelDir, "NSM E Reel kit.json"), bases), /Outside/, "a symlink out of the roots");
  assert.throws(() => textread.readKitNote(path.join(reelDir, "NSM F Reel kit.json"), bases), /64 KB/, "over 64 KB");
  const sync1 = kit.syncKitNotes(s, drive, NOW);
  const row = (id: number) =>
    s.prepare("select note_name, version, test_change, test_detail, error from reel_kit_notes where asset_id = ?").get(id) as
      | { note_name: string; version: number | null; test_change: string | null; test_detail: string | null; error: string | null }
      | undefined;
  assert.deepEqual(row(rA), { note_name: "NSM A Reel kit.json", version: 1, test_change: null, test_detail: null, error: null });
  assert.deepEqual([row(rB)?.version, row(rB)?.test_change], [1, "hook 170px"]);
  assert.deepEqual(
    [row(rC)?.error, row(rD)?.error, /Outside/.test(row(rE)?.error ?? ""), /64 KB/.test(row(rF)?.error ?? ""), row(rG), row(rH)],
    [kit.KIT_NOTE_NOT_JSON, kit.kitNoteBadShape(), true, true, undefined, undefined],
    "junk, a wrong shape, a symlink out and an oversize note are error rows (never a crash); no note / a wrong name = no row",
  );
  assert.equal(sync1.read, 2);
  const tags = kit.kitTagsFor(s, [rA, rB, rC, rG]);
  assert.deepEqual(
    [tags.get(rA)?.label, tags.get(rB)?.label, tags.get(rC)?.label, tags.get(rC)?.error, tags.get(rG)],
    ["Kit v1", "Kit v1 · test: hook 170px", "Before kit", kit.KIT_NOTE_NOT_JSON, undefined],
    "Kit v1 / Kit v1 · test / a refused note counts as Before kit",
  );
  const readAtF = () => s.prepare("select read_at from reel_kit_notes where asset_id = ?").pluck().get(rF) as number;
  const fReadAt = readAtF();
  const sync2 = kit.syncKitNotes(s, drive, NOW + 1);
  assert.deepEqual([sync2.read, sync2.errors], [0, 0], "unchanged notes are not read again (size + mtime cache); a stored refusal is not counted again (gate fix)");
  assert.deepEqual([readAtF(), /64 KB/.test(row(rF)?.error ?? "")], [fReadAt, true], "the oversize refusal row is not rewritten (read_at kept)");
  fs.writeFileSync(path.join(reelDir, "NSM A Reel kit.json"), note(2, { change: "cold open 4 s", detail: "a longer cold open" }));
  fs.utimesSync(path.join(reelDir, "NSM A Reel kit.json"), new Date(NOW + 5000), new Date(NOW + 5000));
  assert.equal(kit.syncKitNotes(s, drive, NOW + 2).read, 1, "a changed note is read again");
  assert.deepEqual([row(rA)?.version, row(rA)?.test_change], [2, "cold open 4 s"]);
  fs.rmSync(path.join(reelDir, "NSM B Reel kit.json"));
  assert.equal(kit.syncKitNotes(s, drive, NOW + 3).removed, 1, "a note gone from a readable folder drops its row (Before kit)");
  fs.renameSync(rootDir, `${rootDir}.away`);
  kit.syncKitNotes(s, drive, NOW + 4);
  assert.ok(row(rA), "an unreadable root changes nothing");
  fs.renameSync(`${rootDir}.away`, rootDir);
  fs.writeFileSync(path.join(reelDir, "NSM F Reel kit.json"), note(1, null)); // the oversize note fixed
  const syncF = kit.syncKitNotes(s, drive, NOW + 5);
  assert.deepEqual([syncF.read, row(rF)?.error, row(rF)?.version], [1, null, 1], "a refused note that is fixed is read on the next pass");
  assert.equal(new ShortMomentsQueue(s, { cacheDir: cfg.cacheDir, logsDir: cfg.logsDir, drive, log: quiet, isStopped: () => false }).syncKitNotes()?.checked, 10, "the worker's queue runs the same pass (every NSM video checked)");
  ok("kit notes (D2): `<stem minus vN> kit.json` next to each NSM video, read only through the guarded reader (.json only for ` kit.json` names, never the default; 64 KB; no symlink out; zod on the exact tests.md shape); junk / wrong shape / symlink / oversize = error rows; cached by size + mtime; a stored refusal is not rewritten or counted again until it changes (gate fix); gone = Before kit; an unreadable root changes nothing");

  // ---------------------------------------------------------------- medians, tags, groups, the winner rule (D3)
  const K = (over: Partial<import("../src/lib/shorts/kit").KitShort> & { v: number | null; change?: string | null }): import("../src/lib/shorts/kit").KitShort => ({
    videoId: over.videoId ?? `v${Math.random()}`,
    title: over.title ?? "t",
    publishedAt: over.publishedAt ?? NOW - 30 * DAY,
    views: over.views === undefined ? 500 : over.views,
    avgViewPct: over.avgViewPct === undefined ? 20 : over.avgViewPct,
    assetId: 1,
    fileName: "f.mp4",
    kit: kit.kitTagOf(over.v == null ? null : { version: over.v, test_change: over.change ?? null, test_detail: over.change ? "d" : null, error: null }),
  });
  const shorts = [
    K({ videoId: "b1", v: 1, avgViewPct: 20 }),
    K({ videoId: "b2", v: 1, avgViewPct: 24 }),
    K({ videoId: "b0", v: 1, avgViewPct: 90, views: 0 }), // no views: never in a median
    K({ videoId: "bn", v: 1, avgViewPct: null }),
    K({ videoId: "win", v: 1, change: "hook 170px", avgViewPct: 28 }),
    K({ videoId: "young", v: 1, change: "a", avgViewPct: 40, publishedAt: NOW - 6.9 * DAY }),
    K({ videoId: "few", v: 1, change: "b", avgViewPct: 40, views: 299 }),
    K({ videoId: "close", v: 1, change: "c", avgViewPct: 26.9 }),
    K({ videoId: "edge", v: 1, change: "e", avgViewPct: 27 }),
    K({ videoId: "v2base", v: 2, avgViewPct: 30 }),
    K({ videoId: "v2test", v: 2, change: "d", avgViewPct: 60 }),
    K({ videoId: "old", v: null, avgViewPct: 10 }),
  ];
  const sum = kit.kitTests(shorts, NOW);
  assert.deepEqual(sum.versions, [
    { version: 1, baselineMedian: 22, baselineCount: 2 },
    { version: 2, baselineMedian: 30, baselineCount: 1 },
  ], "per version: the no-test reels' median (views > 0 and a % viewed) and count");
  const t = (id: string) => sum.tests.find((x) => x.videoId === id)!;
  assert.deepEqual([t("win").winner, t("win").beatBy, t("win").note], [true, 6, null], "7+ days, 300+ views, +6 points: a winner");
  assert.deepEqual([t("young").winner, t("young").daysUp, t("young").note], [false, 6, "up 6 of 7 days"], "6 days: not yet");
  assert.deepEqual([t("few").winner, t("few").note], [false, "299 of 300 views"], "299 views: not yet");
  assert.deepEqual([t("close").winner, t("close").beatBy, t("close").note], [false, 4.9, "beats the kit by 4.9 of 5 points"], "4.9 points: not a winner");
  assert.equal(t("edge").winner, true, "exactly 5 points wins");
  assert.deepEqual([t("v2test").winner, t("v2test").beatBy, t("v2test").note], [false, null, "not enough kit reels yet"], "one baseline reel: not enough kit reels yet");
  assert.deepEqual(kit.channelViewMedian(shorts), { median: 27.5, count: 10 }, "channel median over every Short with views > 0 and a % viewed");
  assert.deepEqual(
    kit.groupMedians(shorts).map((x) => [x.group, x.label, x.median, x.count, x.total]),
    [
      [kit.BEFORE_KIT, "Before kit", 10, 1, 1],
      ["v1", "Kit v1", 27, 7, 9],
      ["v2", "Kit v2", 45, 2, 2],
    ],
    "the Before kit / Kit vN groups with each group's median",
  );
  // The DB path: Shorts matched to reel files carry their kit note.
  const insV = s.prepare("insert into yt_videos (video_id, channel_id, title, published_at, duration_s, is_short, matched_asset_id, first_seen_at, last_synced_at) values (?, 'c', ?, ?, 30, 1, ?, 1, 1)");
  const insM = s.prepare("insert into yt_metrics (video_id, snapshot_date, start_date, end_date, views, avg_view_pct, synced_at) values (?, ?, '2026-09-01', '2026-10-01', ?, ?, 1)");
  insV.run("YA", "A reel", NOW - 10 * DAY, rA);
  insM.run("YA", "2026-09-30", 100, 10);
  insM.run("YA", "2026-10-01", 400, 33.5);
  insV.run("YG", "G reel", NOW - 10 * DAY, rG);
  insM.run("YG", "2026-10-01", 120, 20);
  insV.run("YX", "No file", NOW - 2 * DAY, null);
  const ks = kit.kitShorts(s);
  assert.deepEqual(
    ks.map((x) => [x.videoId, x.views, x.avgViewPct, x.kit.label]),
    [
      ["YX", null, null, "Before kit"],
      ["YA", 400, 33.5, "Kit v2 · test: cold open 4 s"],
      ["YG", 120, 20, "Before kit"],
    ],
    "latest snapshot per Short, the matched file's kit tag (no file / no note = Before kit)",
  );
  assert.deepEqual(kit.channelViewMedian(ks), { median: 26.75, count: 2 });
  s.prepare("update shorts set status = 'posted', output_asset_id = ?, yt_video_id = 'YA' where id = ?").run(rA, W4.id);
  const posted = board.boardData(s, NOW);
  const pc = posted.columns.posted.find((c) => c.id === W4.id)!;
  assert.deepEqual([pc.short?.avgViewPct, pc.kit?.label, posted.channelMedian], [33.5, "Kit v2 · test: cold open 4 s", { median: 26.75, count: 2 }], "Posted cards: % viewed vs the channel median and the reel's Kit tag");
  ok("comparison (D3): channel median % viewed over Shorts with views > 0 and a % viewed (with its count), Kit vN / Kit vN · test / Before kit tags from the matched file's note, Before kit / Kit vN groups with medians; winner = 7+ days, 300+ views, >= 5 points over the same version's no-test median with >= 2 baseline reels (6 days, 299 views, 4.9 points and one baseline reel are not)");

  // ---------------------------------------------------------------- the kit-tests route + the proxy
  const route = await import("../src/app/api/reels/kit-tests/route");
  const main = getDb().sqlite;
  const r1 = await route.GET(new Request("http://127.0.0.1:4747/api/reels/kit-tests"));
  const body = (await r1.json()) as Record<string, unknown>;
  assert.equal(r1.status, 200);
  assert.deepEqual(Object.keys(body), ["kit", "channelMedian", "channelCount", "versions", "tests"], "terse JSON");
  assert.equal(body.kit, "nsm-reel-kit");
  assert.ok(Array.isArray(body.versions) && Array.isArray(body.tests));
  assert.ok(!/\/Users\/|\/Volumes\/|TOKEN|token/.test(JSON.stringify(body)), "no paths, no secrets");
  assert.equal((await route.GET(new Request("http://127.0.0.1:4747/api/reels/kit-tests?version=1"))).status, 400, "no query parameters (zod)");
  void main;
  const { proxy } = await import("../src/proxy");
  const { NextRequest } = await import("next/server");
  const pres = proxy(new NextRequest("http://127.0.0.1:4747/api/reels/kit-tests", { headers: { host: "127.0.0.1:4747" } }));
  assert.notEqual(pres.status, 403, "a plain terminal curl (GET, no Origin, no Sec-Fetch-Site) passes the proxy");
  assert.equal(proxy(new NextRequest("http://127.0.0.1:4747/api/reels/kit-tests", { headers: { host: "127.0.0.1:4747", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status, 403, "another site's fetch is refused");
  const cRoute = await import("../src/app/api/shorts/[id]/sentences/route");
  const bad = await cRoute.GET(new Request("http://127.0.0.1:4747/api/shorts/x/sentences"), { params: Promise.resolve({ id: "x" }) } as never);
  assert.equal(bad.status, 400, "the picker route zod-validates its id");
  ok("GET /api/reels/kit-tests: read only, terse JSON {kit, channelMedian, channelCount, versions [{version, baselineMedian, baselineCount}], tests [...winner]}, no paths beyond file names, 400 on any query; a plain curl passes src/proxy.ts, a cross-site fetch does not; the picker route zod-validates");

  if (savedBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = savedBin;
  void W2;
  db.sqlite.close();
}
