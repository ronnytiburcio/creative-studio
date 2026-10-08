/**
 * Jev copy gate smoke checks (called by scripts/smoke.ts after smoke-reels.ts): the scored text (structured P1 opening
 * block before the first ✅ line, classic P2 first two sentences, headline whole), the pass rule (headline = overall >=
 * 3.0; primary = that AND all three P's, incl. a primary failing only on a missing P), why[], bands, the state + purpose
 * (`copy_gate`, nothing written to hooks / hook_scores), the error paths (no key / key refused = every line pass null +
 * error and no further calls; a 422 = that line only), an unknown code, code "fkb" (SGD's own section: SGD's notes in the
 * state, the fkb dimensions, no client), code "rtm" (the NSM section: NSM notes, brief and avatars in the state, the rtm
 * dimensions, no client), and the CLI (stdout pure JSON, exit codes) run against the smoke's empty-key env
 * file. A FRESH temp DB and FakeJev: never Jev or the network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const P1 =
  "🛁 Free deck renovation matching for North Jersey householders.\n\nStill putting off your deck because renovation sounds like months of mess?\n\n✅ Matched with a vetted family owned local pro\n✅ Most decks done in about a week\n\n👇 Tap below to get started.";
const P1_STARS =
  "🏠 Garden refinishing for Lakeside householders. No full gut needed.\n\nTired of cabinets that make the whole garden look 1995?\n\n⭐ 4.9 stars from local families\n📍 Munro and Orland counties\n\n👇 Tap below to get matched.";
const P2 =
  "Dr. Ruiz in St. Albion waited two years to fix her deck. Then a vetted local pro finished it in about a week! You could be next. Tap below.";

export async function runCopyGateSmoke({ cfg, tmp, ok }: Ctx) {
  const dbmod = await import("../src/lib/db");
  const { openDb } = dbmod;
  const gate = await import("../src/lib/hooks/copygate");
  const { FakeJev } = await import("../src/lib/ai/fake");
  const { Jev } = await import("../src/lib/ai/jev");
  const notesMod = await import("../src/lib/hooks/notes");
  const { dimensionsFor } = await import("../src/lib/hooks/rubric");
  const { currentRubric } = await import("../src/lib/hooks/store");

  // ---------------------------------------------------------------- scored text (pure)
  assert.equal(
    gate.scoredTextFor("primary", P1),
    "🛁 Free deck renovation matching for North Jersey householders.\nStill putting off your deck because renovation sounds like months of mess?",
    "structured P1: everything before the first ✅ line, blank lines collapsed",
  );
  assert.equal(
    gate.scoredTextFor("primary", P2),
    "Dr. Ruiz in St. Albion waited two years to fix her deck. Then a vetted local pro finished it in about a week!",
    "classic P2 (one paragraph): the first two sentences, abbreviations skipped, punctuation kept",
  );
  assert.equal(gate.scoredTextFor("primary", "One sentence only, no end"), "One sentence only, no end");
  assert.equal(gate.scoredTextFor("primary", "First line.\r\n\r\nSecond line? Third.\r\n\r\nNot this."), "First line.\nSecond line? Third.", "CRLF: the first two paragraphs");
  assert.equal(
    gate.scoredTextFor("primary", P1_STARS),
    "🏠 Garden refinishing for Lakeside householders. No full gut needed.\nTired of cabinets that make the whole garden look 1995?",
    "a P1 on ⭐ / 📍 lines (no ✅): the two sentence opener AND the question paragraph",
  );
  assert.equal(gate.scoredTextFor("primary", "One. Two. Three.\nFour."), "One. Two.", "one paragraph, no blank line: the first two sentences");
  assert.equal(gate.scoredTextFor("primary", "✅ Starts with a check. Then more. And more."), "✅ Starts with a check. Then more.", "a ✅ first line falls back to sentences");
  assert.equal(gate.scoredTextFor("headline", "  Most Decks Done in About a Week. Really.  "), "Most Decks Done in About a Week. Really.", "headline whole, trimmed");
  ok("copy gate: scored text (before the first ✅ line, else the first two paragraphs, else the first two sentences; headline whole)");

  // ---------------------------------------------------------------- verdict (pure)
  const dims = [
    { id: "specificity", label: "Specificity" },
    { id: "curiosity_gap", label: "Curiosity gap" },
  ];
  const allClear = { pp_person: 0.9, pp_pain: 0.8, pp_promise: 0.5 };
  const noPain = { pp_person: 0.9, pp_pain: 0.49, pp_promise: 0.7 };
  const good = { levels: { specificity: 3, curiosity_gap: 3 }, overall: 3.0 };
  assert.deepEqual(gate.copyGateVerdict("headline", { ...good, pp: noPain }, dims), { pass: true, why: [] }, "headline: 3.0 passes, P's not required");
  assert.deepEqual(gate.copyGateVerdict("primary", { ...good, pp: allClear }, dims), { pass: true, why: [] }, "primary: 3.0 + all P's (0.5 is clear)");
  assert.deepEqual(gate.copyGateVerdict("primary", { ...good, pp: noPain }, dims), { pass: false, why: ["missing pain"] }, "primary fails on a missing P alone");
  assert.deepEqual(
    gate.copyGateVerdict("primary", { levels: { specificity: 2, curiosity_gap: 3.6 }, overall: 2.8, pp: { pp_person: null, pp_pain: 0.1, pp_promise: 0.9 } }, dims),
    { pass: false, why: ["Specificity", "missing person", "missing pain"] },
  );
  assert.deepEqual(gate.copyGateVerdict("headline", { levels: { specificity: 2.9, curiosity_gap: 2.9 }, overall: 2.9, pp: allClear }, dims), {
    pass: false,
    why: ["overall below 3.0"],
  });
  assert.deepEqual(gate.copyGateVerdict("headline", { levels: { specificity: 1.5, curiosity_gap: 5 }, overall: 3.25, pp: noPain }, dims), {
    pass: true,
    why: ["Specificity"],
  }, "a weak dimension is named on a passing line too");
  assert.deepEqual(gate.copyGateVerdict("headline", { levels: {}, overall: null, pp: allClear }, dims), { pass: null, why: [] }, "no overall = not scored");
  assert.deepEqual(gate.copyGateVerdict("primary", { levels: { specificity: 1 }, overall: NaN, pp: noPain }, dims), { pass: null, why: [] }, "NaN = not scored");
  assert.equal(gate.COPY_GATE_BAR, 3.0);
  assert.deepEqual([gate.bandOf(null), gate.bandOf(2.4), gate.bandOf(2.5), gate.bandOf(3.49), gate.bandOf(3.5), gate.bandOf(5), gate.bandOf(NaN), gate.bandOf(Infinity)], ["unscored", "low", "mid", "mid", "high", "high", "unscored", "unscored"]);
  const nanResult = gate.copyGateResult({ id: "x", field: "primary" }, "t", {
    answers: {}, unsure: ["specificity"], levels: { specificity: 1 }, overall: NaN, pp: { pp_person: 1, pp_pain: 1, pp_promise: 1 }, style: "none", avatar: "none", stopsScroll: 1,
  }, []);
  assert.equal(nanResult.pass, null);
  assert.equal(nanResult.error, "error: overall not computed");
  assert.equal(nanResult.band, "unscored");
  ok("copy gate: pass rule (headline 3.0 only, primary 3.0 + all three P's), why[] (weak dimensions, missing P's), bands, a non-finite overall = not scored");

  // ---------------------------------------------------------------- scoreCopyLines end to end (FakeJev, fresh DB)
  const db = openDb(path.join(tmp, "copygate.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const fj = new FakeJev();
  const jev = new Jev(s, fj, "jev-1.13.0", { sleep: async () => {} });
  const counts = () => s.prepare("select (select count(*) from hooks), (select count(*) from hook_scores)").raw().get() as number[];
  const before = counts();
  const calls = () => s.prepare("select purpose, error from ai_calls order by id").all() as { purpose: string; error: string | null }[];
  const lines = [
    { id: "h1", field: "headline" as const, text: "Most Decks Done in About a Week" },
    { id: "p1", field: "primary" as const, text: P1 },
    { id: "p2", field: "primary" as const, text: P2 },
  ];

  // Defaults: every dimension 0-based 2 (level 3, overall 3.0), every P at 0.1 -> headline passes, primaries miss the P's.
  let out = await gate.scoreCopyLines(s, jev, { code: "granite", lines });
  // rubric_version = the section's effective version (SGD Pros keeps 2 on v3); the global one beside it.
  assert.equal(out.rubric_version, currentRubric(s).sectionVersions.fkbpros);
  assert.equal(out.rubric_version_global, (s.prepare("select version from rubric_versions where current = 1").pluck().get() as number));
  assert.match(out.context_fp, /^[0-9a-f]{16}$/);
  assert.equal(out.model, "jev-1.13.0");
  assert.deepEqual(out.results.map((r) => r.id), ["h1", "p1", "p2"], "input order kept");
  const [h1, p1] = out.results;
  assert.equal(h1.pass, true);
  assert.equal(h1.overall, 3);
  assert.equal(h1.band, "mid");
  assert.deepEqual(h1.pp, { person: false, pain: false, promise: false });
  assert.deepEqual(h1.why, []);
  assert.equal(p1.pass, false, "primary at 3.0 fails on the P's alone");
  assert.deepEqual(p1.why, ["missing person", "missing pain", "missing promise"]);
  assert.equal(p1.scored_text, gate.scoredTextFor("primary", P1));
  assert.ok("offer_clarity" in p1.dims && Object.values(p1.dims).every((v) => v === 3), "SGD Pros text dimensions, levels 1..5");
  assert.equal(p1.pp_p?.pain, 0.1);
  assert.ok(typeof p1.avatar === "string" && typeof p1.style === "string" && p1.stops_scroll === 0.1);
  assert.ok(out.cost_usd > 0);
  assert.equal(fj.requests.length, 3, "one Jev call per line");
  const st = fj.requests[1].state as { hook: { text: string; kind: string }; channel: { section: string; installer?: { name: string } } };
  assert.equal(st.hook.text, p1.scored_text, "Jev reads the opening block only");
  assert.match(st.hook.kind, /^text hook/);
  assert.equal(st.channel.section, "SGD Pros");
  assert.ok(st.channel.installer?.name, "the client's installer block (brand notes) is in the state");
  assert.ok(!("video" in (fj.requests[1].state as object)));
  assert.deepEqual(calls().map((c) => c.purpose), ["copy_gate", "copy_gate", "copy_gate"]);
  assert.deepEqual(counts(), before, "nothing written to hooks / hook_scores");
  ok("copy gate: scoreCopyLines on FakeJev (one call per line, purpose copy_gate, client notes in the state, no hooks rows)");

  // Code "fkb" (2026-10-05): SGD's own section, client null. SGD's brand notes (with a marker line) and hint in the state,
  // the fkb text dimensions, no installer block; nothing written to hooks / hook_scores; "fkb" is exact (after the trim).
  const fkbMarker = "SGD smoke marker: speak as Summit Gardens and Decks itself.";
  const fkbNotesBefore = notesMod.getNoteRow(s, notesMod.FKB_NOTE_KEY)?.body ?? null;
  const fkbNotes = `${fkbNotesBefore ?? ""}\n${fkbMarker}`;
  s.prepare("insert into notes (key, body, saved_at, updated_at) values (?, ?, null, ?) on conflict(key) do update set body = excluded.body").run(
    notesMod.FKB_NOTE_KEY,
    fkbNotes,
    Date.now(),
  );
  const graniteState = st;
  const fkbSent = fj.requests.length;
  out = await gate.scoreCopyLines(s, jev, gate.copyGateRequestSchema.parse({ code: " fkb ", lines }));
  assert.deepEqual(out.results.map((r) => [r.id, r.pass]), [["h1", true], ["p1", false], ["p2", false]], "fkb lines are scored (defaults: headline passes, primaries miss the P's)");
  assert.equal(fj.requests.length - fkbSent, 3, "one Jev call per fkb line");
  const fkbDims = dimensionsFor(currentRubric(s), "fkb", "text").map((d) => d.id).sort();
  assert.ok(fkbDims.length > 0);
  for (const r of out.results) assert.deepEqual(Object.keys(r.dims).sort(), fkbDims, `${r.id}: the fkb section's text dimensions`);
  const fkbSt = fj.requests[fkbSent + 1].state as {
    hook: { text: string };
    channel: { section: string; installer?: unknown; brand?: { name: string; who: string }; notes?: string[] };
  };
  assert.equal(fkbSt.hook.text, gate.scoredTextFor("primary", P1));
  assert.equal(fkbSt.channel.section, `SGD (${notesMod.companyName()})`, "SGD's section, not SGD Pros");
  assert.equal(fkbSt.channel.brand?.name, notesMod.companyName(), "SGD's brand block");
  assert.ok(!("installer" in fkbSt.channel), "no client's installer block");
  assert.deepEqual(fkbSt.channel.notes, notesMod.noteLines(fkbNotes), "SGD's own section notes");
  assert.ok(fkbSt.channel.notes?.includes(fkbMarker));
  assert.ok(!(graniteState.channel as { notes?: string[] }).notes?.includes(fkbMarker), "a client's state never carries SGD's notes");
  const fkbHint = notesMod.getNoteRow(s, notesMod.FKB_HINT_KEY)?.body?.trim();
  if (fkbHint) assert.equal(fkbSt.channel.brand?.who, fkbHint, "SGD's one-line hint");
  assert.deepEqual(calls().slice(-3).map((c) => c.purpose), ["copy_gate", "copy_gate", "copy_gate"]);
  assert.deepEqual(counts(), before, "fkb: nothing written to hooks / hook_scores");
  assert.deepEqual(gate.copyGateChannel(s, "fkb"), { section: "fkb", clientId: null });
  assert.equal(gate.copyGateChannel(s, "granite").section, "fkbpros");
  for (const bad of ["SGD", "fkbpros", "fkb "]) assert.throws(() => gate.copyGateChannel(s, bad), gate.CopyGateInputError, `"${bad}" is not "fkb"`);
  // An existing SGD Pros client code still scores exactly as before (client notes, installer block).
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines: lines.slice(1, 2) });
  const graniteAgain = fj.requests[fj.requests.length - 1].state as typeof st;
  assert.equal(graniteAgain.channel.section, "SGD Pros");
  assert.deepEqual(graniteAgain.channel, graniteState.channel, "the client's channel state is unchanged by the fkb run");
  assert.deepEqual(out.results[0].dims, p1.dims);
  // Put SGD's notes back so no later check sees the marker line.
  if (fkbNotesBefore === null) s.prepare("delete from notes where key = ?").run(notesMod.FKB_NOTE_KEY);
  else s.prepare("update notes set body = ? where key = ?").run(fkbNotesBefore, notesMod.FKB_NOTE_KEY);
  ok('copy gate: code "fkb" = SGD\'s own section (SGD notes + brand block in the state, fkb dimensions, no client, no hooks rows); "fkb" exact; SGD Pros codes unchanged');

  // Code "rtm" (2026-10-07): the NSM section, client null, exactly as an NSM hook is scored: the NSM notes (with a marker
  // line), the NSM brief, the NSM avatars only, the rtm text dimensions; no installer / brand / scope block; nothing
  // written to hooks / hook_scores; "rtm" exact (after the trim); SGD Pros codes unchanged after it.
  const rtmMarker = "NSM smoke marker: small business owners running Meta ads.";
  const rtmNotesBefore = notesMod.getNote(s, "rtm")?.body ?? null;
  const rtmNotes = `${rtmNotesBefore ?? ""}\n${rtmMarker}`;
  s.prepare("insert into notes (key, body, saved_at, updated_at) values ('rtm', ?, null, ?) on conflict(key) do update set body = excluded.body").run(
    rtmNotes,
    Date.now(),
  );
  const rtmSent = fj.requests.length;
  out = await gate.scoreCopyLines(s, jev, gate.copyGateRequestSchema.parse({ code: " rtm ", lines }));
  assert.deepEqual(out.results.map((r) => [r.id, r.pass]), [["h1", true], ["p1", false], ["p2", false]], "rtm lines are scored (defaults)");
  assert.equal(fj.requests.length - rtmSent, 3, "one Jev call per rtm line");
  const rtmDims = dimensionsFor(currentRubric(s), "rtm", "text").map((d) => d.id).sort();
  assert.ok(rtmDims.length > 0);
  for (const r of out.results) assert.deepEqual(Object.keys(r.dims).sort(), rtmDims, `${r.id}: the rtm section's text dimensions`);
  const rtmSt = fj.requests[rtmSent + 1].state as {
    hook: { text: string };
    channel: { section: string; brief: string; installer?: unknown; brand?: unknown; scope?: unknown; notes?: string[] };
    avatars: Record<string, unknown>;
  };
  assert.equal(rtmSt.hook.text, gate.scoredTextFor("primary", P1));
  assert.equal(rtmSt.channel.section, "NSM (Northstar Media)", "the NSM section, not SGD Pros");
  assert.equal(rtmSt.channel.brief, notesMod.briefOf(currentRubric(s), "rtm"), "the NSM brief of the current version");
  assert.ok(!("installer" in rtmSt.channel) && !("brand" in rtmSt.channel) && !("scope" in rtmSt.channel), "no client, brand or shared scope block");
  assert.deepEqual(rtmSt.channel.notes, notesMod.noteLines(rtmNotes), "the NSM notes");
  assert.ok(rtmSt.channel.notes?.includes(rtmMarker));
  const rtmAvatars = Object.keys(rtmSt.avatars).filter((k) => k !== "none");
  assert.ok(rtmAvatars.length > 0 && rtmAvatars.every((k) => k.startsWith("rtm_")), "only the NSM avatars are offered");
  assert.ok(!(graniteState.channel as { notes?: string[] }).notes?.includes(rtmMarker), "a client's state never carries the NSM notes");
  assert.deepEqual(calls().slice(-3).map((c) => c.purpose), ["copy_gate", "copy_gate", "copy_gate"]);
  assert.deepEqual(counts(), before, "rtm: nothing written to hooks / hook_scores");
  assert.deepEqual(gate.copyGateChannel(s, "rtm"), { section: "rtm", clientId: null });
  for (const bad of ["NSM", "rtm ", "rtmx"]) assert.throws(() => gate.copyGateChannel(s, bad), gate.CopyGateInputError, `"${bad}" is not "rtm"`);
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines: lines.slice(1, 2) });
  assert.deepEqual((fj.requests[fj.requests.length - 1].state as typeof st).channel, graniteState.channel, "the client's channel state is unchanged by the rtm run");
  assert.deepEqual(out.results[0].dims, p1.dims);
  if (rtmNotesBefore === null) s.prepare("delete from notes where key = 'rtm'").run();
  else s.prepare("update notes set body = ? where key = 'rtm'").run(rtmNotesBefore);
  ok('copy gate: code "rtm" = the NSM section (NSM notes + brief + NSM avatars in the state, rtm dimensions, no client, no hooks rows); "rtm" exact; SGD Pros codes unchanged');

  // P's clear -> primaries pass; one weak dimension drags a line under the bar and is named.
  fj.respond = (id) => (id.startsWith("pp_") ? { noul: 0.8 } : id === "specificity" ? { score: 0.5 } : undefined);
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines });
  for (const r of out.results) {
    assert.equal(r.dims.specificity, 1.5);
    assert.ok(r.overall! < 3 && r.pass === false, `${r.id} under the bar`);
    assert.deepEqual(r.why, ["Specificity"]);
  }
  fj.respond = (id) => (id.startsWith("pp_") ? { noul: 0.8 } : id === "specificity" ? { score: 4 } : undefined);
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines });
  assert.deepEqual(out.results.map((r) => r.pass), [true, true, true]);
  assert.deepEqual(out.results[1].pp, { person: true, pain: true, promise: true });
  // Unsure never fails a line: a split score (0.3 / 0.3 / 0.4 over far apart levels) is marked, the line still passes.
  fj.respond = (id) => (id.startsWith("pp_") ? { noul: 0.8 } : id === "brand_fit" ? { score: 2, probabilities: { "0": 0.3, "2": 0.4, "4": 0.3 } } : undefined);
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines });
  assert.ok(out.results.every((r) => r.unsure.includes("brand_fit") && r.pass === true), "unsure reported, never a fail");
  // ...but an unsure answer still counts at its value (plan amended at the Phase 1 gate): a primary whose only weak
  // dimension is unsure at level <= 2 fails, names it in why[] and lists it in unsure[].
  fj.respond = (id) =>
    id.startsWith("pp_") ? { noul: 0.8 } : id === "specificity" ? { score: 0.5, probabilities: { "0": 0.35, "2": 0.3, "4": 0.35 } } : undefined;
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines: [lines[1]] });
  const [weakUnsure] = out.results;
  assert.equal(weakUnsure.dims.specificity, 1.5);
  assert.ok(weakUnsure.unsure.includes("specificity"), "the weak dimension is unsure");
  assert.equal(weakUnsure.pass, false, "an unsure weak dimension still counts at its value");
  assert.deepEqual(weakUnsure.why, ["Specificity"]);
  fj.respond = () => undefined;
  ok("copy gate: P's clear pass a primary, a weak dimension fails and is named, unsure never fails a line by itself but counts at its value (an unsure level <= 2 still fails and is named)");

  // ---------------------------------------------------------------- failures: pass null + error, never a throw
  const nCalls = calls().length;
  fj.hasKey = false;
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines });
  assert.ok(out.results.every((r) => r.pass === null && r.overall === null && r.band === "unscored" && /^nokey: /.test(r.error ?? "")));
  assert.equal(out.cost_usd, 0);
  assert.equal(calls().length, nCalls, "no key = nothing sent, nothing logged");
  fj.hasKey = true;
  fj.mode = "unauthorized";
  const sent = fj.requests.length;
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines: [...lines, { id: "h2", field: "headline", text: "Another headline" }] });
  assert.ok(out.results.every((r) => r.pass === null && /^auth: /.test(r.error ?? "")), "key refused: every line pass null");
  assert.ok(fj.requests.length - sent <= 2, "no further calls after a refused key (concurrency 2)");
  fj.mode = "overloaded"; // 529 after the adapter's retries = "unavailable": its own line, 3 in a row stop the run
  const sent529 = fj.requests.length;
  const five = [0, 1, 2, 3, 4].map((n) => ({ id: `u${n}`, field: "headline" as const, text: `Headline number ${n}` }));
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines: five });
  assert.ok(out.results.every((r) => r.pass === null && /^unavailable: Jev is overloaded \(529\)/.test(r.error ?? "")));
  const sentTexts = new Set(fj.requests.slice(sent529).map((q) => (q.state as { hook: { text: string } }).hook.text));
  assert.ok(sentTexts.has("Headline number 2") && !sentTexts.has("Headline number 4"), "3 unavailable lines in a row stop further calls");
  fj.mode = "ok";
  // One unavailable line among good ones fails alone (no halt).
  const flaky = {
    keyPresent: () => true,
    get: () => fj.get(),
    post: async (p: "/systemone", body: unknown) =>
      (body as { state: { hook: { text: string } } }).state.hook.text === "Flaky line"
        ? { status: 529, retryAfter: "0", body: { error: "overloaded" } }
        : fj.post(p, body),
  };
  const flakyJev = new Jev(s, flaky, "jev-1.13.0", { sleep: async () => {} });
  out = await gate.scoreCopyLines(s, flakyJev, {
    code: "granite",
    lines: [{ id: "f", field: "headline", text: "Flaky line" }, ...lines],
  });
  assert.equal(out.results[0].pass, null);
  assert.match(out.results[0].error ?? "", /^unavailable: /);
  assert.deepEqual(out.results.slice(1).map((r) => r.pass === null), [false, false, false], "the other lines are scored");
  fj.mode = "invalid";
  const sent422 = fj.requests.length;
  out = await gate.scoreCopyLines(s, jev, { code: "granite", lines: lines.slice(0, 2) });
  assert.ok(out.results.every((r) => r.pass === null && /^request: Jev refused the request \(HTTP 422\)/.test(r.error ?? "")), "a 422 is that line's error");
  assert.equal(fj.requests.length - sent422, 2, "a request error does not stop the other lines");
  fj.mode = "ok";
  await assert.rejects(gate.scoreCopyLines(s, jev, { code: "nope", lines }), (e) =>
    e instanceof gate.CopyGateInputError && e.message === 'Unknown code "nope": not a client code in SGD Pros, "fkb" or "rtm"',
  );
  assert.equal(gate.copyGateRequestSchema.safeParse({ code: "granite", lines: [{ id: "a", field: "description", text: "x" }] }).success, false);
  assert.equal(gate.copyGateRequestSchema.safeParse({ code: "granite", lines: [{ id: "a", field: "headline", text: "  " }] }).success, false);
  assert.equal(gate.copyGateRequestSchema.safeParse({ code: "granite", lines: [lines[0], { ...lines[0] }] }).success, false, "duplicate ids refused");
  assert.deepEqual(counts(), before);
  assert.deepEqual(dbmod.pendingMigrations(s), [], "a migrated DB has nothing pending");
  ok("copy gate: no key / key refused = every line pass null + error (no more calls); unavailable = that line, 3 in a row stop; 422 = that line; unknown code + bad input refused");
  s.close();

  // ---------------------------------------------------------------- the CLI (the smoke's env file: empty key, temp DB)
  const envFile = process.env.STUDIO_ENV_FILE!;
  assert.ok(envFile.startsWith(tmp) && /^TYPESAFE_API_KEY=$/m.test(fs.readFileSync(envFile, "utf8")), "the CLI runs on the smoke's empty-key env only");
  assert.ok(process.env.STUDIO_DB!.startsWith(tmp));
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const cli = (input: string) => spawnSync(tsx, [path.join(process.cwd(), "scripts", "score-copy.ts")], { input, env: process.env, encoding: "utf8", timeout: 60_000 });
  let r = cli(JSON.stringify({ code: "granite", lines: lines.slice(0, 2) }));
  assert.equal(r.status, 0, r.stderr);
  const cliOut = JSON.parse(r.stdout) as { results: { pass: null; error: string; scored_text: string }[]; cost_usd: number; rubric_version: number };
  assert.equal(r.stdout.trim().split("\n").length, 1, "stdout is one JSON line");
  assert.deepEqual(cliOut.results.map((x) => x.pass), [null, null]);
  assert.ok(cliOut.results.every((x) => /^nokey: /.test(x.error)) && cliOut.results[1].scored_text === gate.scoredTextFor("primary", P1));
  assert.equal(cliOut.cost_usd, 0);
  r = cli("not json");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /stdin is not JSON/);
  r = cli(JSON.stringify({ code: "zzz", lines: lines.slice(0, 1) }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown code "zzz": not a client code in SGD Pros, "fkb" or "rtm"/);
  r = cli(JSON.stringify({ code: "fkb", lines: lines.slice(0, 1) }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok((JSON.parse(r.stdout) as { results: { error: string }[] }).results.every((x) => /^nokey: /.test(x.error)), "fkb through the CLI: exit 0");
  r = cli(JSON.stringify({ code: "rtm", lines: lines.slice(0, 2) }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok((JSON.parse(r.stdout) as { results: { error: string }[] }).results.every((x) => /^nokey: /.test(x.error)), "rtm through the CLI: exit 0");
  r = cli(JSON.stringify({ code: "granite", lines: [] }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad request: lines/);
  // A DB behind the repo's migrations is refused (and never migrated by the CLI).
  const behindFile = path.join(tmp, "copygate-behind.db");
  const behind = openDb(behindFile, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  behind.sqlite.prepare("delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)").run();
  const behindRows = behind.sqlite.prepare("select count(*) from __drizzle_migrations").pluck().get();
  assert.equal(dbmod.pendingMigrations(behind.sqlite).length, 1);
  behind.sqlite.close();
  r = spawnSync(tsx, [path.join(process.cwd(), "scripts", "score-copy.ts")], {
    input: JSON.stringify({ code: "granite", lines: lines.slice(0, 1) }),
    env: { ...process.env, STUDIO_DB: behindFile },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /studio\.db is behind the repo's migrations; restart Studio first/);
  const after = openDb(behindFile, { setup: false });
  assert.equal(after.sqlite.prepare("select count(*) from __drizzle_migrations").pluck().get(), behindRows, "the CLI ran no migration");
  after.sqlite.close();
  assert.throws(() => openDb(path.join(tmp, "copygate-missing.db"), { setup: false }), "setup: false never creates a DB file");
  // No DB at the configured path: refused by the CLI before opening, nothing created.
  const noDb = path.join(tmp, "copygate-none.db");
  r = spawnSync(tsx, [path.join(process.cwd(), "scripts", "score-copy.ts")], {
    input: JSON.stringify({ code: "granite", lines: lines.slice(0, 1) }),
    env: { ...process.env, STUDIO_DB: noDb },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /score-copy: no Studio database at the configured path/);
  assert.equal(fs.existsSync(noDb), false, "the CLI never creates a DB");
  // From another folder: the same config and DB (the identity is found from the module, not the cwd).
  r = spawnSync(tsx, [path.join(process.cwd(), "scripts", "score-copy.ts")], { input: JSON.stringify({ code: "granite", lines: lines.slice(0, 1) }), env: process.env, cwd: tmp, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  ok("copy gate CLI: pure JSON on stdout, no key = exit 0 with pass null per line (fkb and rtm too), bad JSON / unknown code / empty lines / a DB behind the migrations (left unmigrated) / a missing DB (nothing created) = exit 1; runs from another folder");
}
