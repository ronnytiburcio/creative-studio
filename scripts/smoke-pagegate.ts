/**
 * Landing page Phase 2 slice 2 smoke checks (called by scripts/smoke.ts after the rubric v3 checks): the page section
 * scorer (src/lib/pages/*, scripts/score-page.ts). PAGE_RUBRICS v1's shape (every part 2 to 4 score questions with
 * exactly 5 levels, no reserved ids, no dashes, nothing that rewards call handling), the state (brief / notes / avatars
 * from the code's channel, the part's job, clipped text, voice; never the section key), evaluate math (levels, mean,
 * band, why at <= 2, unsure, page and freight summaries), one call per section with purpose `page_score` and nothing
 * but ai_calls rows written, the halting rules (no key, cap, 401; unavailable; a 422 fails one section only), bad
 * input refused (unknown part / code / page_rubric_version, duplicate part), `--resolve` (free, no Jev request, read
 * only), context_fp (moves with the NSM note, not for rtm when an SGC client note changes) and the CLI (pure JSON on
 * stdout, exit codes). FRESH temp DBs and FakeJev only: never the live DB, Jev or the network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";
import { CALL_HANDLING } from "./smoke-rubricv3";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

/** The pinned Jev model id the smoke's Jev adapters use (part of context_fp). */
const PINNED = "jev-1.13.0";

const LONG_PROBLEM = `You boosted a post last month and got 40 likes and zero calls. ${"You check the ad account every night and still cannot say what a lead costs. ".repeat(40)}`;

export async function runPageGateSmoke({ cfg, tmp, ok }: Ctx) {
  const dbmod = await import("../src/lib/db");
  const { openDb } = dbmod;
  const pr = await import("../src/lib/pages/rubric");
  const ps = await import("../src/lib/pages/score");
  const pg = await import("../src/lib/pages/pagegate");
  const { RESERVED_QUESTION_IDS } = await import("../src/lib/hooks/rubric-edit");
  const { NONE_AVATAR, avatarsFor } = await import("../src/lib/hooks/rubric");
  const notesLib = await import("../src/lib/hooks/notes");
  const { currentRubric } = await import("../src/lib/hooks/store");
  const { FakeJev } = await import("../src/lib/ai/fake");
  const { Jev } = await import("../src/lib/ai/jev");

  // ---------------------------------------------------------------- PAGE_RUBRICS v1 shape (pure)
  const v1 = pr.pageRubric(pr.CURRENT_PAGE_RUBRIC);
  assert.ok(v1 && v1.version === pr.CURRENT_PAGE_RUBRIC && pr.CURRENT_PAGE_RUBRIC === 1);
  assert.equal(pr.pageRubric(2), null);
  assert.equal(pr.pageRubric(0), null);
  assert.deepEqual(
    v1.parts.map((p) => p.id),
    ["eyebrow", "headline", "subheadline", "problem", "solution", "proof", "offer", "cta", "ps", "story"],
    "9 skeleton parts + the story test, skeleton order",
  );
  assert.deepEqual(v1.parts.filter((p) => p.freight).map((p) => p.id), ["eyebrow", "headline", "subheadline", "offer", "cta", "ps"], "freight = headline complex + offer section");
  const texts: string[] = [];
  for (const part of v1.parts) {
    assert.ok(part.dims.length >= 2 && part.dims.length <= 4, `${part.id}: 2 to 4 dimensions`);
    const ids = part.dims.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length, `${part.id}: unique dimension ids`);
    assert.equal(new Set(part.dims.map((d) => d.label)).size, ids.length, `${part.id}: unique labels`);
    for (const d of part.dims) {
      assert.ok(/^[a-z][a-z_]*$/.test(d.id), `${d.id}: snake case id`);
      assert.ok(!RESERVED_QUESTION_IDS.includes(d.id) && d.id !== NONE_AVATAR, `${d.id}: not a reserved id`);
      assert.equal(d.levels.length, 5, `${part.id}.${d.id}: exactly 5 levels`);
      assert.equal(new Set(d.levels).size, 5, `${part.id}.${d.id}: 5 different levels`);
      assert.ok(d.question.includes("`section.") || d.question.includes("`page."), `${part.id}.${d.id}: the question names the state keys it reads`);
      texts.push(d.label, d.question, ...d.levels);
    }
    const q = ps.buildPageQuestions(part);
    assert.deepEqual(Object.keys(q), ids);
    assert.ok(Object.values(q).every((x) => x.type === "score" && x.criteria.length === 5), `${part.id}: every question is a 5 level score`);
    texts.push(part.label, part.job, part.passes, part.fails);
  }
  assert.equal(v1.parts.reduce((n, p) => n + p.dims.length, 0), 28, "28 dimensions over 10 calls");
  for (const t of texts) {
    assert.ok(!/[—–]| - /.test(t) && !/\w-\w/.test(t), `no dashes or hyphenated compounds: ${t.slice(0, 60)}`);
    assert.ok(!CALL_HANDLING.test(t), `never rewards call handling (Alex 2026-10-07): ${t.slice(0, 60)}`);
    assert.ok(!/speed to lead|how fast .*(call|reach)|reaches out|call (them|you) back/i.test(t), `no level rewards fast call backs: ${t.slice(0, 60)}`);
  }
  assert.ok(Object.isFrozen(pr.PAGE_RUBRICS), "versions are a frozen map (append, never edit)");
  ok("page rubric v1: 10 parts (6 freight), 28 dimensions, every part 2 to 4 score questions with exactly 5 distinct levels, no reserved ids, questions name their state keys, no dashes, nothing rewards call handling");

  // ---------------------------------------------------------------- evaluate math (pure)
  const problem = pr.pagePart(v1, "problem")!;
  const fakeAns = (score: number, probabilities?: Record<string, number>) => ({ type: "score" as const, value: score, probabilities: probabilities ?? { [String(Math.round(score))]: 1 }, confidence: 0.9 });
  let ev = ps.evaluatePageSection(problem, { intimacy: fakeAns(0.5), market_words: fakeAns(2), reader_focus: fakeAns(4), stray: fakeAns(0) }, 0.6);
  assert.deepEqual(ev.levels, { intimacy: 1.5, market_words: 3, reader_focus: 5 }, "level = score + 1 (one decimal); unknown answers ignored");
  assert.ok(Math.abs(ev.score! - (1.5 + 3 + 5) / 3) < 1e-12, "section score = mean of levels");
  assert.equal(ev.band, "mid");
  assert.deepEqual(ev.why, ["Intimacy"], "why = labels at level 2 or below");
  assert.deepEqual(ev.unsure, []);
  ev = ps.evaluatePageSection(problem, { intimacy: fakeAns(1, { "0": 0.3, "2": 0.4, "4": 0.3 }), market_words: fakeAns(1, { "1": 0.5, "2": 0.5 }), reader_focus: fakeAns(1) }, 0.6);
  assert.deepEqual(ev.levels, { intimacy: 2, market_words: 2, reader_focus: 2 });
  assert.deepEqual(ev.why, ["Intimacy", "Market words", "Reader focus"], "level 2 counts as weak");
  assert.deepEqual(ev.unsure, ["intimacy"], "unsure = the hook rule (top two neighbouring levels under the threshold), a clear 2 to 3 split is not unsure");
  assert.equal(ev.band, "low");
  assert.deepEqual(ps.evaluatePageSection(problem, {}, 0.6), { levels: {}, score: null, band: "unscored", why: [], unsure: [] });
    assert.deepEqual(
    ps.pageSummary(v1, [
      { part: "headline", score: 4 },
      { part: "problem", score: 2 },
      { part: "offer", score: 3.5 },
      { part: "proof", score: null },
    ]),
    { page_score: 3.17, freight_score: 3.75 },
    "page = mean of scored sections, freight = mean of freight parts, unscored left out",
  );
  assert.deepEqual(ps.pageSummary(v1, [{ part: "problem", score: null }]), { page_score: null, freight_score: null });
  ok("page evaluate: levels (score + 1), section mean, band, why at <= 2, unsure (hook neighbour rule), page_score + freight_score (2 decimals, unscored left out)");

  // ---------------------------------------------------------------- state + scorePage end to end (FakeJev, fresh DB)
  const db = openDb(path.join(tmp, "pagegate.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const fj = new FakeJev();
  const jev = new Jev(s, fj, "jev-1.13.0", { sleep: async () => {} });
  const hookRubric = currentRubric(s);
  assert.equal(hookRubric.version, 3, "a fresh DB is on hook rubric v3 (NSM context)");
  const tableCounts = () =>
    s.prepare("select (select count(*) from hooks), (select count(*) from hook_scores), (select count(*) from rubric_versions), (select count(*) from app_settings)").raw().get() as number[];
  const notesSnap = () => JSON.stringify(s.prepare("select key, body, saved_at, updated_at from notes order by key").all());
  const clientsSnap = () => JSON.stringify(s.prepare("select code, brand_notes, classify_hint from clients order by code").all());
  const before = { counts: tableCounts(), notes: notesSnap(), clients: clientsSnap() };
  const calls = () => s.prepare("select purpose, error from ai_calls order by id").all() as { purpose: string; error: string | null }[];

  const req = (over: Record<string, unknown> = {}) =>
    pg.pageGateRequestSchema.parse({
      code: "rtm",
      page: { url: "https://northstarmedia.com", site: "rtm", stage: "before", headline: "Meta ads that turn ad spend into booked calls." },
      sections: [
        { id: "H1", part: "headline", text: "Meta ads that turn ad spend into booked calls." },
        { id: "S3", part: "problem", heading: "You already know why the ads are not working.", text: LONG_PROBLEM },
        { id: "S6", part: "proof", heading: "75 leads in 90 days", text: "75 leads on about $13.9K of spend across 9 accounts, last 90 days ending 2026-09-04." },
        { id: "CTA", part: "cta", text: "Five quick questions. I read every one myself.", ctas: ["Book a call", "Send it to Alex"] },
      ],
      ...over,
    });

  let out = await pg.scorePage(s, jev, req());
  assert.equal(out.page_rubric_version, 1);
  assert.equal(out.hook_rubric_version, 3);
  assert.equal(out.section_version, hookRubric.sectionVersions.rtm);
  assert.equal(out.section_version, 3, "rtm reads the v3 context");
  assert.match(out.context_fp, /^[0-9a-f]{16}$/);
  assert.equal(out.model, "jev-1.13.0");
  assert.deepEqual(out.sections.map((x) => [x.id, x.part]), [["H1", "headline"], ["S3", "problem"], ["S6", "proof"], ["CTA", "cta"]], "input order kept");
  assert.equal(fj.requests.length, 4, "one Jev call per section");
  assert.deepEqual(calls().map((c) => c.purpose), ["page_score", "page_score", "page_score", "page_score"], "purpose page_score, one ai_calls row each");
  for (const x of out.sections) {
    assert.equal(x.error, null);
    assert.equal(x.score, 3, "FakeJev default (0 based 2) = level 3 everywhere");
    assert.equal(x.band, "mid");
    assert.deepEqual(Object.keys(x.dims), pr.pagePart(v1, x.part)!.dims.map((d) => d.id), `${x.id}: its part's dimensions`);
    assert.match(x.key, /^[0-9a-f]{64}$/);
  }
  assert.equal(out.page_score, 3);
  assert.equal(out.freight_score, 3, "headline + cta are freight");
  assert.ok(out.cost_usd > 0);
  assert.deepEqual(tableCounts(), before.counts, "no hooks / hook_scores / rubric_versions / app_settings rows written");
  assert.equal(notesSnap(), before.notes, "notes untouched");
  assert.equal(clientsSnap(), before.clients, "clients untouched");

  // What Jev read for the problem section.
  const probReq = fj.requests[1];
  const st = probReq.state as {
    page: { site: string; headline: string };
    part: { id: string; job: string; passes: string; fails: string };
    section: { heading: string; text: string; ctas: string[] };
    channel: { section: string; brief: string; notes?: string[]; installer?: unknown; brand?: unknown; scope?: unknown };
    whos_who?: string[];
    avatars: Record<string, { person: string; pain: string; promise: string }>;
    voice?: unknown;
    hook?: unknown;
  };
  assert.deepEqual(Object.keys(probReq.questions), problem.dims.map((d) => d.id), "the part's questions only");
  assert.equal(st.part.id, "problem");
  assert.equal(st.part.job, problem.job, "the part's job from the page rubric");
  assert.equal(st.page.headline, "Meta ads that turn ad spend into booked calls.");
  assert.equal(st.section.heading, "You already know why the ads are not working.");
  assert.equal(st.section.text.length, ps.PAGE_TEXT_CLIP, "text clipped to 1,500 characters");
  assert.ok(st.section.text.endsWith("…") && LONG_PROBLEM.startsWith(st.section.text.slice(0, 200)));
  assert.equal(out.sections[1].scored_text_chars, ps.PAGE_TEXT_CLIP);
  assert.equal(out.sections[2].scored_text_chars, req().sections[2].text.length);
  assert.equal(st.channel.section, "NSM (Northstar Media)");
  assert.equal(st.channel.brief, notesLib.briefOf(hookRubric, "rtm"));
  assert.equal(st.channel.brief, (await import("../src/lib/profile")).profile().rubric.briefs.rtm, "the v3 NSM brief (Meta ads for small business owners; the profile starter's, slice 1c)");
  assert.deepEqual(st.channel.notes, notesLib.noteLines(notesLib.getNote(s, "rtm")?.body), "the NSM notes");
  assert.ok((st.channel.notes ?? []).length > 0);
  assert.deepEqual(st.whos_who, notesLib.noteLines(notesLib.whosWho(s)), "who's who");
  assert.deepEqual(Object.keys(st.avatars).sort(), avatarsFor(hookRubric, "rtm", false).map((a) => a.slug).sort(), "the NSM avatars of the current hook rubric");
  assert.equal(Object.keys(st.avatars).length, 5);
  assert.ok(!("installer" in st.channel) && !("brand" in st.channel) && !("scope" in st.channel));
  assert.ok(!("hook" in st) && !("voice" in st), "no hook block; no voice when none was sent");
  const stateJson = JSON.stringify(probReq.state);
  assert.ok(!/"key"/.test(stateJson) && !stateJson.includes(out.sections[1].key), "the state never carries the section key");
  assert.ok(!/TYPESAFE|api[_ ]?key|authorization/i.test(JSON.stringify(probReq)), "nor any API key");
  assert.ok(!/"stage"|"url"/.test(stateJson), "stage and url are not in the state (same words score the same before and after)");
  const ctaSt = fj.requests[3].state as typeof st;
  assert.deepEqual(ctaSt.section.ctas, ["Book a call", "Send it to Alex"]);
  assert.equal(ctaSt.section.heading, null);
  // An SGD Pros client page reads its own context (installer block, SGD Pros avatars), SGD its brand block.
  const sentGranite = fj.requests.length;
  const graniteOut = await pg.scorePage(s, jev, req({ code: "granite", sections: [{ id: "H1", part: "headline", text: "A walk in shower in about a week." }] }));
  const graniteSt = fj.requests[sentGranite].state as typeof st;
  assert.equal(graniteSt.channel.section, "SGD Pros");
  assert.ok(graniteSt.channel.installer, "the client's installer block");
  assert.equal(graniteSt.channel.brief, notesLib.briefOf(hookRubric, "fkbpros"));
  assert.equal(graniteSt.channel.brief, notesLib.legacyBrief("fkbpros"), "SGD Pros context unchanged by v3");
  assert.ok(Object.keys(graniteSt.avatars).every((k) => !k.startsWith("rtm_")) && Object.keys(graniteSt.avatars).length > 0);
  assert.equal(graniteOut.section_version, 2, "SGD Pros section version stays 2");
  const fkbOut = await pg.scorePage(s, jev, req({ code: "fkb", sections: [{ id: "H1", part: "headline", text: "Your garden, done right." }] }));
  assert.equal((fj.requests.at(-1)!.state as typeof st).channel.section, `SGD (${notesLib.companyName()})`);
  assert.equal(fkbOut.section_version, 2);
  // Voice rides along, clipped and capped.
  const voice = Array.from({ length: 20 }, (_, i) => `${"I paid for ads and nobody called. ".repeat(12)} #${i}`);
  await pg.scorePage(s, jev, req({ voice, sections: [{ id: "S3", part: "problem", text: "Short problem." }] }));
  const vs = (fj.requests.at(-1)!.state as { voice: string[] }).voice;
  assert.equal(vs.length, ps.PAGE_VOICE_MAX);
  assert.ok(vs.every((v) => v.length <= ps.PAGE_VOICE_CLIP));
  assert.deepEqual(calls().slice(-3).map((c) => c.purpose), ["page_score", "page_score", "page_score"]);
  assert.deepEqual(tableCounts(), before.counts);
  ok("page scorer: one Jev call per section (purpose page_score, ai_calls rows only, hooks / hook_scores / notes / rubric_versions untouched); state = page headline, the part's job, clipped text (1,500), ctas, the code's channel (rtm: v3 brief, NSM notes, who's who, the 5 NSM avatars; granite: installer + SGD Pros brief + avatars, section v2; fkb: brand block), voice (15 max, 300 chars); never the key, stage or url");

  // The answering model is reported when Jev names one (the pinned id when nothing answered, see the no key run).
  fj.answeredBy = "jev-1.13.1";
  assert.equal((await pg.scorePage(s, jev, req({ sections: [{ id: "H1", part: "headline", text: "x" }] }))).model, "jev-1.13.1");
  fj.answeredBy = "jev-1.13.0";
  // Weak dimensions are named, an unsure one listed, scores per section.
  fj.respond = (id, _q, state) =>
    (state as { part: { id: string } }).part.id === "cta"
      ? id === "vivid_label"
        ? { score: 0.5 }
        : id === "what_happens_next"
          ? { score: 3, probabilities: { "0": 0.3, "2": 0.35, "4": 0.35 } }
          : { score: 4 }
      : undefined;
  out = await pg.scorePage(s, jev, req());
  const cta = out.sections.find((x) => x.part === "cta")!;
  assert.deepEqual(cta.dims, { vivid_label: 1.5, what_happens_next: 4, one_wording_family: 5 });
  assert.equal(cta.score, 3.5);
  assert.equal(cta.band, "high");
  assert.deepEqual(cta.why, ["Vivid label"]);
  assert.deepEqual(cta.unsure, ["what_happens_next"]);
  assert.equal(out.freight_score, round2((3 + 3.5) / 2));
  assert.equal(out.page_score, round2((3 + 3 + 3 + 3.5) / 4));
  fj.respond = () => undefined;
  ok("page scorer: per section dims / score / band / why / unsure from Jev's answers; page and freight summaries");

  // ---------------------------------------------------------------- failures: score null + error, never a throw
  const nCalls = calls().length;
  fj.hasKey = false;
  out = await pg.scorePage(s, jev, req());
  assert.ok(out.sections.every((x) => x.score === null && x.band === "unscored" && /^nokey: /.test(x.error ?? "")), "no key: every section unscored");
  assert.equal(calls().length, nCalls, "no key = nothing sent, nothing logged");
  assert.equal(out.cost_usd, 0);
  assert.deepEqual([out.page_score, out.freight_score], [null, null]);
  assert.equal(out.model, "jev-1.13.0", "nothing answered: the pinned id");
  fj.hasKey = true;
  // Cap: a spend row over today's cap refuses before sending.
  const capRow = s.prepare("insert into ai_calls (created_at, purpose, provider, model, questions, state_chars, cost_usd, ms) values (?, 'test', 'jev', 'x', '{}', 0, 50, 0)").run(Date.now()).lastInsertRowid;
  const sentCap = fj.requests.length;
  out = await pg.scorePage(s, jev, req());
  assert.ok(out.sections.every((x) => x.score === null && /^cap: /.test(x.error ?? "")), "cap: every section unscored");
  assert.equal(fj.requests.length, sentCap, "cap = nothing sent");
  s.prepare("delete from ai_calls where id = ?").run(capRow);
  fj.mode = "unauthorized";
  const sent401 = fj.requests.length;
  out = await pg.scorePage(s, jev, req());
  assert.ok(out.sections.every((x) => x.score === null && /^auth: /.test(x.error ?? "")), "key refused: every section unscored");
  assert.ok(fj.requests.length - sent401 <= 2, "no further calls after a refused key (concurrency 2)");
  fj.mode = "overloaded";
  const sent529 = fj.requests.length;
  const fiveParts = ["eyebrow", "headline", "subheadline", "problem", "solution"];
  out = await pg.scorePage(s, jev, req({ sections: fiveParts.map((p, i) => ({ id: `u${i}`, part: p, text: `Text ${i}` })) }));
  assert.ok(out.sections.every((x) => /^unavailable: /.test(x.error ?? "")));
  const sentParts = new Set(fj.requests.slice(sent529).map((q) => (q.state as { part: { id: string } }).part.id));
  assert.ok(sentParts.has("subheadline") && !sentParts.has("solution"), "3 unavailable sections in a row stop further calls");
  fj.mode = "ok";
  // A 422 on one section fails that section only.
  const flaky = {
    keyPresent: () => true,
    get: () => fj.get(),
    post: async (p: "/systemone", body: unknown) =>
      (body as { state: { part: { id: string } } }).state.part.id === "proof"
        ? { status: 422, retryAfter: null, body: { detail: "questions.x: bad" } }
        : fj.post(p, body),
  };
  out = await pg.scorePage(s, new Jev(s, flaky, "jev-1.13.0", { sleep: async () => {} }), req());
  assert.deepEqual(out.sections.map((x) => x.error === null), [true, true, false, true], "the other sections are scored");
  assert.match(out.sections[2].error ?? "", /^request: Jev refused the request \(HTTP 422\)/);
  assert.equal(out.page_score, 3, "the failed section is left out of the summary");
  assert.deepEqual(tableCounts(), before.counts);
  ok("page scorer failures: no key / cap = nothing sent, every section unscored; 401 stops further calls; unavailable 3 in a row stop; a 422 fails that section only");

  // ---------------------------------------------------------------- bad input
  const refused = (r: unknown, re: RegExp) => assert.throws(() => pg.resolvePage(s, r as never, PINNED), (e) => e instanceof pg.PageGateInputError && re.test((e as Error).message));
  refused(req({ sections: [{ id: "x", part: "bonuses", text: "A bonus." }] }), /^Unknown part "bonuses"/);
  refused(req({ code: "nope" }), /^Unknown code "nope"/);
  refused(req({ page_rubric_version: 2 }), /^Unknown page_rubric_version 2$/);
  await assert.rejects(pg.scorePage(s, jev, req({ code: "NSM" })), pg.PageGateInputError, "the code is exact");
  const isValidRequest = (body: unknown) => pg.pageGateRequestSchema.safeParse(body).success;
  const base = { code: "rtm", sections: [{ id: "a", part: "headline", text: "x" }] };
  assert.equal(isValidRequest(base), true);
  assert.equal(isValidRequest({ ...base, sections: [{ id: "a", part: "headline", text: "x" }, { id: "b", part: "headline", text: "y" }] }), false, "duplicate part refused");
  assert.equal(isValidRequest({ ...base, sections: [{ id: "a", part: "headline", text: "x" }, { id: "a", part: "problem", text: "y" }] }), false, "duplicate id refused");
  assert.equal(isValidRequest({ ...base, sections: [] }), false, "no sections refused");
  assert.equal(isValidRequest({ ...base, sections: Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, part: `p${i}`, text: "x" })) }), false, "13 sections refused");
  assert.equal(isValidRequest({ ...base, sections: [{ id: "a", part: "headline", text: "  " }] }), false, "empty text with no ctas refused");
  assert.equal(isValidRequest({ ...base, sections: [{ id: "a", part: "cta", text: "", ctas: ["Get my plan"] }] }), true, "a cta with labels only is fine");
  assert.equal(isValidRequest({ ...base, sections: [{ id: "a", part: "headline", text: "x".repeat(5_001) }] }), false, "text over 5,000 refused");
  assert.equal(isValidRequest({ ...base, page_rubric_version: 1.5 }), false);
  ok("page scorer input: unknown part / code (exact) / page_rubric_version refused (PageGateInputError), duplicate part or id, 0 or 13 sections, empty text, oversize text refused by the schema");

  // ---------------------------------------------------------------- --resolve: free, consistent with scoring
  const sentResolve = fj.requests.length;
  const callsResolve = calls().length;
  const res = pg.resolvePage(s, req(), PINNED);
  assert.equal(fj.requests.length, sentResolve, "--resolve makes no Jev request");
  assert.equal(calls().length, callsResolve, "and logs nothing");
  const scored = await pg.scorePage(s, jev, req());
  assert.deepEqual(
    { ...res, sections: res.sections },
    {
      page_rubric_version: scored.page_rubric_version,
      hook_rubric_version: scored.hook_rubric_version,
      section_version: scored.section_version,
      context_fp: scored.context_fp,
      sections: scored.sections.map(({ id, part, key, scored_text_chars }) => ({ id, part, key, scored_text_chars })),
    },
    "resolve = the scoring run's versions, context_fp and keys",
  );
  // Keys: the same words score the same before and after; any word Jev reads moves them.
  const key = (over: Record<string, unknown>) => pg.resolvePage(s, req(over), PINNED).sections.find((x) => x.part === "problem")!.key;
  const k0 = res.sections[1].key;
  assert.equal(key({ page: { url: "https://x.example", site: "rtm", stage: "after", headline: "Meta ads that turn ad spend into booked calls." } }), k0, "stage and url do not move the key");
  assert.notEqual(key({ page: { site: "rtm", headline: "Another headline." } }), k0, "the headline Jev reads moves the key");
  const moved = req();
  moved.sections[1].heading = "A new heading.";
  assert.notEqual(pg.resolvePage(s, moved, PINNED).sections[1].key, k0, "the heading moves the key");
  const tail = req();
  tail.sections[1].text = `${LONG_PROBLEM}Words past the clip.`;
  assert.equal(pg.resolvePage(s, tail, PINNED).sections[1].key, k0, "words past the 1,500 clip (not read) do not move the key");
  assert.equal(pg.resolvePage(s, req({ page: { site: "rtm" } }), PINNED).sections[0].key, pg.resolvePage(s, req({ page: { site: "rtm", headline: "Meta ads that turn ad spend into booked calls." } }), PINNED).sections[0].key, "no page.headline = the headline section's text");
  assert.equal(key({ page: { site: "rtm", headline: "  Meta ads that turn ad spend into booked calls.  " } }), k0, "an explicit headline is normalized like the fallback (trim)");
  assert.equal(key({ page: { site: "rtm", headline: "Two lines\r\nof headline" } }), key({ page: { site: "rtm", headline: "Two lines\nof headline" } }), "CRLF folded");
  ok("--resolve: no Jev request, nothing logged, same versions / context_fp / keys as scoring; key ignores stage and url and text past the clip, moves with the headline or heading");

  // ---------------------------------------------------------------- context_fp
  const fp = (code: string, over: Record<string, unknown> = {}, model = PINNED) => pg.resolvePage(s, req({ code, ...over }), model).context_fp;
  const rtm0 = fp("rtm");
  const granite0 = fp("granite");
  const fkb0 = fp("fkb");
  assert.equal(new Set([rtm0, granite0, fkb0]).size, 3, "each channel has its own context_fp");
  assert.equal(fp("rtm"), rtm0, "stable");
  s.prepare("update clients set brand_notes = coalesce(brand_notes, '') || char(10) || 'Smoke: an SGC client note line.' where code = 'granite'").run();
  assert.equal(fp("rtm"), rtm0, "an SGC client note does not move rtm's context_fp");
  assert.notEqual(fp("granite"), granite0, "it moves that client's");
  assert.equal(fp("fkb"), fkb0);
  const graniteBeforeRtmEdit = fp("granite");
  const rtmNote = notesLib.getNote(s, "rtm")!.body;
  notesLib.saveNote(s, "rtm", `${rtmNote}\nSmoke: a new NSM note line.`);
  const rtm1 = fp("rtm");
  assert.notEqual(rtm1, rtm0, "the NSM note moves rtm's context_fp");
  assert.equal(fp("granite"), graniteBeforeRtmEdit, "the NSM note does not move an SGC client's context_fp");
  assert.notEqual(fp("granite"), rtm1);
  assert.notEqual(fp("rtm", {}, "jev-1.14.0"), rtm1, "the pinned Jev model id is in context_fp (a pin change misses the cache)");
  assert.equal(pg.resolvePage(s, req(), "jev-1.14.0").section_version, 3, "section_version is still reported, outside the fp");
  assert.notEqual(fp("rtm", { voice: ["I paid for ads and nobody called."] }), rtm1, "voice moves it");
  assert.equal(fp("rtm", { voice: ["  ", ""] }), rtm1, "blank voice = no voice");
  assert.equal(fp("rtm", { page_rubric_version: 1 }), rtm1, "explicit current version = default");
  // Put the notes back for any later check.
  s.prepare("update notes set body = ? where key = 'rtm'").run(rtmNote);
  ok("context_fp: per channel, moves with the NSM note (rtm only, an SGC client's stays), not for rtm when an SGC client note changes (that client's moves), moves with voice and the pinned model id");
  s.close();

  // ---------------------------------------------------------------- the CLI (the smoke's env file: empty key, temp DB)
  const envFile = process.env.STUDIO_ENV_FILE!;
  assert.ok(envFile.startsWith(tmp) && /^TYPESAFE_API_KEY=$/m.test(fs.readFileSync(envFile, "utf8")), "the CLI runs on the smoke's empty-key env only");
  assert.ok(process.env.STUDIO_DB!.startsWith(tmp));
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const script = path.join(process.cwd(), "scripts", "score-page.ts");
  const cli = (input: string, args: string[] = []) => spawnSync(tsx, [script, ...args], { input, env: process.env, encoding: "utf8", timeout: 60_000 });
  const live = openDb(process.env.STUDIO_DB!, { setup: false });
  const smokeCalls = () => live.sqlite.prepare("select count(*) from ai_calls").pluck().get() as number;
  const callsBefore = smokeCalls();
  const body = JSON.stringify(req());
  let r = cli(body);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1, "stdout is one JSON line");
  const cliOut = JSON.parse(r.stdout) as { sections: { score: null; error: string }[]; cost_usd: number; page_rubric_version: number; context_fp: string };
  assert.ok(cliOut.sections.length === 4 && cliOut.sections.every((x) => x.score === null && /^nokey: /.test(x.error)), "no key: exit 0, every section unscored");
  assert.equal(cliOut.cost_usd, 0);
  r = cli(body, ["--resolve"]);
  assert.equal(r.status, 0, r.stderr);
  const resolved = JSON.parse(r.stdout) as Record<string, unknown> & { sections: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(resolved), ["page_rubric_version", "hook_rubric_version", "section_version", "context_fp", "sections"]);
  assert.deepEqual(Object.keys(resolved.sections[0]), ["id", "part", "key", "scored_text_chars"]);
  assert.equal(resolved.context_fp, cliOut.context_fp);
  assert.equal(smokeCalls(), callsBefore, "neither a no key run nor --resolve logs an ai_calls row");
  for (const [input, args, re] of [
    ["not json", [], /stdin is not JSON/],
    [body, ["--fast"], /unknown argument --fast/],
    [JSON.stringify({ ...req(), code: "zzz" }), [], /Unknown code "zzz"/],
    [JSON.stringify({ ...req(), code: "zzz" }), ["--resolve"], /Unknown code "zzz"/],
    [JSON.stringify({ ...req(), page_rubric_version: 9 }), ["--resolve"], /Unknown page_rubric_version 9/],
    [JSON.stringify({ ...req(), sections: [{ id: "a", part: "faq", text: "Q?" }] }), [], /Unknown part "faq"/],
    [JSON.stringify({ ...req(), sections: [{ id: "a", part: "ps", text: "x" }, { id: "b", part: "ps", text: "y" }] }), [], /bad request: sections: at most one section per part/],
  ] as [string, string[], RegExp][]) {
    r = cli(input, args);
    assert.equal(r.status, 1, `${args.join(" ")} ${input.slice(0, 40)}: exit 1`);
    assert.equal(r.stdout, "", "nothing on stdout");
    assert.match(r.stderr, re);
  }
  live.sqlite.close();
  // --resolve opens the DB read only: a read only file still resolves.
  const roFile = path.join(tmp, "pagegate-ro.db");
  const ro = openDb(roFile, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(ro.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  ro.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  ro.sqlite.pragma("journal_mode = DELETE");
  ro.sqlite.close();
  const mtime = fs.statSync(roFile).mtimeMs;
  fs.chmodSync(roFile, 0o444);
  r = spawnSync(tsx, [script, "--resolve"], { input: body, env: { ...process.env, STUDIO_DB: roFile }, encoding: "utf8", timeout: 60_000 });
  fs.chmodSync(roFile, 0o644);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((JSON.parse(r.stdout) as { sections: unknown[] }).sections.length, 4);
  assert.equal(fs.statSync(roFile).mtimeMs, mtime, "the file was not written");
  const roDb = openDb(roFile, { readonly: true });
  assert.throws(() => roDb.sqlite.prepare("insert into notes (key, body, updated_at) values ('x', 'y', 0)").run(), /readonly/i, "readonly: writes throw");
  roDb.sqlite.close();
  // The live DB's mode: WAL, with a committed write still in the -wal file. --resolve reads it (the WAL row is seen) and
  // leaves the main file and the WAL alone.
  const walFile = path.join(tmp, "pagegate-wal.db");
  const wal = openDb(walFile, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  wal.sqlite.pragma("wal_autocheckpoint = 0");
  wal.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  assert.equal(wal.sqlite.pragma("journal_mode", { simple: true }), "wal");
  const walNote = notesLib.getNote(wal.sqlite, "rtm")!.body;
  wal.sqlite.prepare("update notes set body = ? where key = 'rtm'").run(`${walNote}\nSmoke: a line only in the WAL.`);
  const walFp = pg.resolvePage(wal.sqlite, req(), cfg.jevModel).context_fp; // the CLI's pinned id
  const stamp = (f: string) => fs.existsSync(f) ? `${fs.statSync(f).size}:${fs.statSync(f).mtimeMs}` : "none";
  const walBefore = [stamp(walFile), stamp(`${walFile}-wal`)];
  assert.ok(fs.statSync(`${walFile}-wal`).size > 0, "the write sits in the -wal file");
  r = spawnSync(tsx, [script, "--resolve"], { input: body, env: { ...process.env, STUDIO_DB: walFile }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((JSON.parse(r.stdout) as { context_fp: string }).context_fp, walFp, "--resolve on a WAL DB reads the WAL (same context_fp as the writer sees)");
  assert.deepEqual([stamp(walFile), stamp(`${walFile}-wal`)], walBefore, "main file and -wal untouched");
  wal.sqlite.close();
  // No DB at the configured path: refused (both modes), and no file is created.
  const noDb = path.join(tmp, "pagegate-none.db");
  for (const args of [[], ["--resolve"]]) {
    r = spawnSync(tsx, [script, ...args], { input: body, env: { ...process.env, STUDIO_DB: noDb }, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /score-page: no Studio database at the configured path/);
    assert.equal(fs.existsSync(noDb), false, "the CLI never creates a DB");
  }
  // Run from another folder: same config, same result (the identity comes from the module's location, not the cwd).
  r = spawnSync(tsx, [script, "--resolve"], { input: body, env: process.env, cwd: tmp, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  ok("score-page CLI: pure JSON on stdout (one line), no key = exit 0 with every section unscored, --resolve = versions + context_fp + keys on a read only DB file and on a WAL mode DB with uncheckpointed writes (nothing written, no ai_calls), bad JSON / unknown argument / code / part / page_rubric_version / duplicate part = exit 1 with nothing on stdout; a missing DB = exit 1 and nothing created; runs from another folder");
}

const round2 = (v: number) => Math.round(v * 100) / 100;
