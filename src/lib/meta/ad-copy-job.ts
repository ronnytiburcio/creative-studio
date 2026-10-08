/**
 * "Draft the rest" (Phase 6 slice 3, E2; server only): `ad_copy` job rows, what `claude -p` is told (FORMAT v4 for the
 * primaries, short headlines, one description, the channel's brand notes + hint + who's who + What works here, the
 * client's angle bank, the hook as the anchor, the copy rules, JSON only) and how its answer is read. The worker runs the
 * jobs (src/worker/ads.ts, one at a time, through src/lib/hooks/claude.ts); nothing here spawns anything.
 *
 * A job row: type `ad_copy`, asset_id null, input {channel, hookId, angleKey, filled}, result (AdCopyJobResult), log_path
 * logs/jobs/ad-copy-<id>.log. One active job per channel + hook. The dialog polls the job and fills only the slots that
 * are still empty when the draft lands (never what the owner typed meanwhile).
 */
import { AD_COPY_JOB } from "../jobs";
import type Database from "better-sqlite3";
import type { StudioConfig } from "../config";
import { briefOf, channelNoteParts, companyName, loadChannelNotes } from "../hooks/notes";
import { fill, profile } from "../profile";
import { laneNames } from "../clients-admin";
import { currentRubric } from "../hooks/store";
import { AI_TELLS } from "../hooks/variant-rules";
import { videoLines } from "../hooks/video";
import { metaClientsDir } from "./store";
import { readCreative } from "./match";
import { readClientAdMap, readCopyDocBlocks, type AngleBlock } from "./ad-map";
import { adChannel, adNaming, adRuleContext, angleBlockFor, prefillHook, type AdChannel } from "./new-ad";
import {
  checkAdLine,
  cleanCopyText,
  compileAdRules,
  conceptProblem,
  HEADLINE_WARN,
  DESC_WARN,
  HEADLINES_MIN,
  PRIMARIES_MIN,
  type AdCopy,
  type CompiledAdRules,
  type PsObj,
} from "./ad-copy-rules";

type Sql = Database.Database;

export { AD_COPY_JOB } from "../jobs";

export class AdCopyError extends Error {}

export type AdCopyJobInput = {
  channel: string;
  hookId: number | null;
  angleKey: string | null;
  /** What the dialog held when the owner clicked (empty strings = empty slots). */
  filled: AdCopy;
  /**
   * The hook that opens primary 1 (a hook longer than a headline, prefilled alone into primary 1 and not edited since):
   * the draft writes the REST of primary 1 after it (`AdDraft.p1`), and the dialog swaps it in only while primary 1 still
   * reads exactly this line. null = primary 1 counts as the owner's text.
   */
  p1Opening?: string | null;
};

export type AdDraft = {
  headlines: string[];
  primaries: string[];
  description: string | null;
  concept: string | null;
  psObj: PsObj | null;
  /** Primary 1 completed after its hook opening (only when the job had a p1Opening). */
  p1?: string | null;
};

export type AdCopyAttempt = {
  returned: { headlines: number; primaries: number; description: number };
  kept: { headlines: number; primaries: number; description: number };
  dropped: { field: "headline" | "primary" | "description"; text: string; reason: string }[];
  ms: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export type AdCopyJobResult = { attempts: AdCopyAttempt[]; draft: AdDraft | null; note: string | null };

/** primary 1 is exactly the hook opening (one line, untouched): the draft completes it. */
export function opensP1(filled: AdCopy, p1Opening: string | null | undefined): boolean {
  const p1 = (filled.primaries[0] ?? "").trim();
  return Boolean(p1Opening && p1 && !p1.includes("\n") && p1 === p1Opening.trim());
}

/**
 * How many of each field the draft must bring so the set reaches 3 headlines, 2 primaries and the description. A primary
 * 1 that is only the hook opening counts toward the 2 and is completed by the draft (`p1`: its rest).
 */
export function needed(filled: AdCopy, p1Opening: string | null = null): { headlines: number; primaries: number; description: boolean; p1: boolean } {
  const h = filled.headlines.filter((x) => x.trim()).length;
  const p1 = opensP1(filled, p1Opening);
  const p = filled.primaries.filter((x) => x.trim()).length;
  return { headlines: Math.max(0, HEADLINES_MIN - h), primaries: Math.max(0, PRIMARIES_MIN - p), description: !filled.description.trim(), p1 };
}

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const filledSchemaOk = (c: AdCopy) =>
  Array.isArray(c.headlines) && Array.isArray(c.primaries) && typeof c.description === "string" && c.headlines.length <= 5 && c.primaries.length <= 3;

// ------------------------------------------------------------------------------------------------ jobs

function activeJobFor(sql: Sql, channel: string, hookId: number | null): number | null {
  return (
    (sql
      .prepare(
        `select id from jobs where type = '${AD_COPY_JOB}' and status in ('pending','running')
           and json_extract(input, '$.channel') = ? and json_extract(input, '$.hookId') is ? limit 1`,
      )
      .pluck()
      .get(channel, hookId) as number | undefined) ?? null
  );
}

/** Queue "Draft the rest". Returns the job id. Throws AdCopyError. */
export function queueAdCopy(sql: Sql, input: AdCopyJobInput, now = Date.now()): number {
  const ch = adChannel(sql, input.channel);
  if (!ch) throw new AdCopyError(`Pick a client or ${laneNames(sql).fkb} first.`);
  if (!filledSchemaOk(input.filled)) throw new AdCopyError("Invalid copy.");
  if (input.hookId != null) {
    const h = prefillHook(sql, input.hookId);
    const fits = h && (ch.section === "fkb" ? h.section === "fkb" : h.section === "fkbpros" && (h.code == null || h.code === ch.code));
    if (!fits) throw new AdCopyError("That hook belongs to another channel.");
  }
  const opening = input.p1Opening ? clip(input.p1Opening, 300) : null;
  const need = needed(input.filled, opening);
  if (!need.headlines && !need.primaries && !need.description) throw new AdCopyError("Every slot already has text: empty a slot to draft it.");
  const clean: AdCopyJobInput = {
    channel: ch.code,
    hookId: input.hookId ?? null,
    angleKey: input.angleKey && /^[A-Za-z0-9:_-]{1,80}$/.test(input.angleKey) ? input.angleKey : null,
    filled: {
      headlines: input.filled.headlines.map((h) => clip(h, 300)),
      primaries: input.filled.primaries.map((p) => cleanCopyText(p).slice(0, 2500)),
      description: clip(input.filled.description, 300),
    },
    p1Opening: need.p1 ? opening : null,
  };
  return sql.transaction(() => {
    const active = activeJobFor(sql, clean.channel, clean.hookId);
    if (active) return active; // a second click while one is writing: the same job
    const info = sql
      .prepare(`insert into jobs (type, asset_id, input, status, priority, attempts, created_at) values ('${AD_COPY_JOB}', null, ?, 'pending', 0, 0, ?)`)
      .run(JSON.stringify(clean), now);
    return Number(info.lastInsertRowid);
  })();
}

export function cancelAdCopyJob(sql: Sql, jobId: number, now = Date.now()): boolean {
  return (
    sql
      .prepare(`update jobs set status = 'cancelled', error = 'Cancelled', finished_at = ? where id = ? and type = '${AD_COPY_JOB}' and status = 'pending'`)
      .run(now, jobId).changes > 0
  );
}

/** Run a failed or cancelled draft again (one more claude run). Refused while the same channel + hook has an active one. */
export function retryAdCopyJob(sql: Sql, jobId: number): boolean {
  const row = sql.prepare(`select input from jobs where id = ? and type = '${AD_COPY_JOB}' and status in ('error','cancelled')`).get(jobId) as { input: string } | undefined;
  if (!row) return false;
  const input = JSON.parse(row.input) as AdCopyJobInput;
  if (activeJobFor(sql, input.channel, input.hookId)) throw new AdCopyError("A draft for this ad is already being written.");
  return (
    sql
      .prepare(
        `update jobs set status = 'pending', error = null, result = null, started_at = null, finished_at = null, cancel_requested_at = null
          where id = ? and status in ('error','cancelled')`,
      )
      .run(jobId).changes > 0
  );
}

export type AdCopyJobView = {
  id: number;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  channel: string;
  channelCode: string;
  hookText: string | null;
  draft: AdDraft | null;
  note: string | null;
  error: string | null;
  attempts: number;
  dropped: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  logPath: string | null;
};

type JobRow = {
  id: number;
  status: AdCopyJobView["status"];
  error: string | null;
  input: string | null;
  result: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  log_path: string | null;
};

function toView(sql: Sql, r: JobRow): AdCopyJobView {
  let input: Partial<AdCopyJobInput> = {};
  let result: Partial<AdCopyJobResult> = {};
  try {
    input = JSON.parse(r.input ?? "{}");
    result = JSON.parse(r.result ?? "{}") ?? {};
  } catch {
    /* keep empty */
  }
  const ch = adChannel(sql, input.channel ?? null);
  const hookText = input.hookId ? ((sql.prepare("select text from hooks where id = ?").pluck().get(input.hookId) as string | undefined) ?? null) : null;
  return {
    id: r.id,
    status: r.status,
    channel: ch ? ch.label : (input.channel ?? "?"),
    channelCode: input.channel ?? "",
    hookText,
    draft: result.draft ?? null,
    note: result.note ?? null,
    error: r.error,
    attempts: result.attempts?.length ?? 0,
    dropped: (result.attempts ?? []).reduce((a, x) => a + x.dropped.length, 0),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    logPath: r.log_path,
  };
}

const JOB_COLS = "j.id, j.status, j.error, j.input, j.result, j.created_at, j.started_at, j.finished_at, j.log_path";

export function adCopyJob(sql: Sql, id: number): AdCopyJobView | null {
  const r = sql.prepare(`select ${JOB_COLS} from jobs j where j.id = ? and j.type = '${AD_COPY_JOB}'`).get(id) as JobRow | undefined;
  return r ? toView(sql, r) : null;
}

/** Draft jobs for the Jobs page: active first, then the most recent. */
export function adCopyJobs(sql: Sql, limit = 20): AdCopyJobView[] {
  const rows = sql
    .prepare(
      `select ${JOB_COLS} from jobs j where j.type = '${AD_COPY_JOB}'
        order by case j.status when 'running' then 0 when 'pending' then 1 else 2 end, coalesce(j.finished_at, j.created_at) desc limit ?`,
    )
    .all(limit) as JobRow[];
  return rows.map((r) => toView(sql, r));
}

// ------------------------------------------------------------------------------------------------ context + prompt

export type AdCopyContext = {
  channel: AdChannel;
  channelLabel: string;
  /** The section's brief under the current rubric version (`briefOf`). */
  brief: string;
  hook: { id: number; text: string; kind: "text" | "video" } | null;
  video: { spoken: string | null; onScreen: string | null } | null;
  angle: string | null;
  block: AngleBlock | null;
  /** Other angles of the client's bank (slug + first headline), for range. */
  bank: { slug: string; headline: string | null }[];
  /** Lane C: copy that runs now (its active ads), for its voice. */
  running: { headlines: string[]; primaries: string[] };
  notes: { notes: string[]; hint: string | null; whos: string[]; works: string[] };
  forbiddenTerms: string[];
  bans: string[];
  filled: AdCopy;
  need: { headlines: number; primaries: number; description: boolean; p1: boolean };
  /** The hook line primary 1 must open with (need.p1). */
  p1Opening: string | null;
  rules: CompiledAdRules;
};

export function adCopyContext(sql: Sql, cfg: Pick<StudioConfig, "metaEnvFile" | "clientDocsDir">, input: AdCopyJobInput): AdCopyContext {
  const ch = adChannel(sql, input.channel);
  if (!ch) throw new AdCopyError("The channel is gone.");
  const hook = input.hookId ? prefillHook(sql, input.hookId) : null;
  let video: AdCopyContext["video"] = null;
  if (hook?.kind === "video") {
    const a = sql.prepare("select a.spoken_open, a.description from hooks h join assets a on a.id = h.asset_id where h.id = ?").get(hook.id) as
      | { spoken_open: string | null; description: string | null }
      | undefined;
    if (a) {
      const l = videoLines(a.description, a.spoken_open);
      video = { spoken: l.spoken, onScreen: l.onScreen };
    }
  }
  const angle = input.angleKey ?? hook?.angle ?? null;
  const map = ch.section === "fkbpros" ? readClientAdMap(metaClientsDir(cfg.metaEnvFile), ch.code) : null;
  const { block } = ch.section === "fkbpros" ? angleBlockFor(cfg.clientDocsDir, map, ch.folder, angle) : { block: null };
  const bankMap = new Map<string, string | null>();
  if (ch.section === "fkbpros") {
    for (const [slug, b] of readCopyDocBlocks(cfg.clientDocsDir, ch.folder)) bankMap.set(slug, b.headlines[0] ?? null);
    for (const [slug, b] of map?.angles ?? []) if (!bankMap.has(slug)) bankMap.set(slug, b.headlines[0] ?? null);
  }
  const running = { headlines: [] as string[], primaries: [] as string[] };
  if (ch.section === "fkb" && ch.accountId != null) {
    const ads = sql.prepare("select creative from ads where account_id = ? and effective_status = 'ACTIVE' order by created_time desc limit 4").pluck().all(ch.accountId) as (string | null)[];
    for (const c of ads) {
      const cr = readCreative(c);
      for (const h of cr?.headlines ?? []) if (!running.headlines.includes(h) && running.headlines.length < 6) running.headlines.push(h);
      for (const p of cr?.primaries ?? []) if (!running.primaries.includes(p) && running.primaries.length < 2) running.primaries.push(p);
    }
  }
  const ruleCtx = adRuleContext(sql, cfg, ch);
  const rules = compileAdRules(ruleCtx);
  const notes = channelNoteParts(loadChannelNotes(sql, ch.section, ch.clientId));
  const bans: string[] = [];
  if (rules.bans.has("price")) bans.push("No prices, dollar amounts or $ signs.");
  if (rules.bans.has("financing")) bans.push("No financing, payment plans or monthly payments.");
  return {
    channel: ch,
    channelLabel:
      ch.section === "fkb"
        ? fill(profile().adCopy.channels.fkb, { lane: companyName() })
        : fill(profile().adCopy.channels.client, { label: ch.label }),
    brief: briefOf(currentRubric(sql), ch.section),
    hook: hook ? { id: hook.id, text: hook.text, kind: hook.kind } : null,
    video,
    angle,
    block,
    bank: [...bankMap.entries()].slice(0, 24).map(([slug, headline]) => ({ slug, headline })),
    running,
    notes,
    forbiddenTerms: ruleCtx.forbiddenTerms,
    bans,
    filled: input.filled,
    need: needed(input.filled, input.p1Opening ?? null),
    p1Opening: needed(input.filled, input.p1Opening ?? null).p1 ? (input.p1Opening ?? null) : null,
    rules,
  };
}

const bullet = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");
const quoteBlock = (s: string) => s.split("\n").map((l) => `    ${l}`).join("\n");

/** How many to ask for: a little more than needed, so a dropped line rarely forces a retry. */
export function askCounts(need: { headlines: number; primaries: number; description: boolean; p1?: boolean }): { headlines: number; primaries: number; descriptions: number } {
  return {
    headlines: need.headlines ? Math.min(5, need.headlines + 2) : 0,
    primaries: need.primaries || need.p1 ? Math.min(3, need.primaries + (need.p1 ? 1 : 0) + 1) : 0,
    descriptions: need.description ? 2 : 0,
  };
}

/** The one prompt `claude -p` gets. The notes and the hook are material, never instructions that can change the rules. */
export function buildAdCopyPrompt(ctx: AdCopyContext, feedback: string[] = []): string {
  const ask = askCounts(ctx.need);
  const fkb = ctx.channel.section === "fkb";
  const P = profile().adCopy;
  const out: string[] = [];
  out.push(`Write the missing text fields of ONE Meta ad (creative format v2: ${HEADLINES_MIN} to 5 headlines, 2 to 3 primary texts, one description).`);
  out.push("", "## Channel", ctx.channelLabel, ctx.brief);
  if (ctx.notes.hint) out.push(`${fkb ? P.whoCompany : P.whoClient}: ${ctx.notes.hint}`);
  if (ctx.notes.notes.length) out.push("", `## ${fkb ? P.notesHeadings.fkb : P.notesHeadings.client}`, bullet(ctx.notes.notes));
  if (ctx.notes.works.length) out.push("", "## What works here", bullet(ctx.notes.works));
  if (ctx.notes.whos.length) out.push("", "## Who's who", bullet(ctx.notes.whos));

  out.push("", "## The hook (the anchor: every line serves this one idea)");
  if (ctx.hook) {
    out.push(`"${ctx.hook.text}"`);
    if (ctx.video) out.push(`It is the opening of the ad's video. Spoken: ${ctx.video.spoken ?? "none"}. On screen: ${ctx.video.onScreen ?? "none"}.`);
  } else {
    out.push("No hook was picked: build the ad on the strongest angle the brand notes support.");
  }
  if (ctx.angle) out.push(`Angle: ${ctx.angle}`);
  if (ctx.block) {
    out.push("", "## This angle's approved block (match its facts and tone; never copy a line word for word)");
    if (ctx.block.headlines.length) out.push("Headlines:", bullet(ctx.block.headlines));
    ctx.block.primaries.forEach((p, i) => out.push(`Primary ${i + 1}:`, quoteBlock(p)));
    if (ctx.block.description) out.push(`Description: ${ctx.block.description}`);
  }
  if (ctx.bank.length) out.push("", "## The client's other approved angles (for range; stay on the hook's angle)", bullet(ctx.bank.map((b) => `${b.slug}${b.headline ? `: ${b.headline}` : ""}`)));
  if (ctx.running.headlines.length || ctx.running.primaries.length) {
    out.push("", `## ${P.runningHeading}`);
    if (ctx.running.headlines.length) out.push("Headlines:", bullet(ctx.running.headlines));
    ctx.running.primaries.forEach((p, i) => out.push(`Primary ${i + 1}:`, quoteBlock(p)));
  }

  const filledH = ctx.filled.headlines.filter((h) => h.trim());
  const filledP = ctx.filled.primaries.filter((p, i) => p.trim() && !(i === 0 && ctx.need.p1));
  out.push("", `## ${P.filledHeading}`);
  out.push(filledH.length ? bullet(filledH.map((h) => `Headline: ${h}`)) : "- No headlines yet.");
  filledP.forEach((p, i) => out.push(`Primary ${i + 1}:`, quoteBlock(p)));
  if (ctx.filled.description.trim()) out.push(`- Description: ${ctx.filled.description.trim()}`);

  out.push("", "## Task");
  if (ask.headlines) out.push(`- Write ${ask.headlines} headlines: short (${HEADLINE_WARN} characters or fewer), one line, no emoji, each a different way into the hook.`);
  if (ctx.need.p1 && ctx.p1Opening) out.push(fill(P.p1Line, { line: ctx.p1Opening }));
  if (ask.primaries) out.push(...P.formatLines.map((l) => fill(l, { n: ask.primaries })));
  if (ask.descriptions) out.push(`- Write ${ask.descriptions} description options: ${DESC_WARN} characters or fewer, one line, no emoji (only the first that passes the rules is used).`);
  if (!fkb) out.push(P.conceptLine);

  out.push("", "## Copy rules (a line that breaks one is thrown away)");
  const rules: string[] = [];
  rules.push(fkb ? P.voice.fkb : P.voice.client);
  rules.push(
    ...P.houseRules,
    `Emoji only in primary texts and only these: ${ctx.rules.palette.join(" ")} (one at the start of a line). No emoji in headlines or descriptions.`,
    "No URL or web address anywhere (the button carries the click).",
    "Only claims the notes allow; no invented numbers, reviews, years or guarantees.",
    ...ctx.bans,
    `None of these phrases: ${AI_TELLS.map((t) => `"${t}"`).join(", ")}.`,
  );
  if (ctx.forbiddenTerms.length) rules.push(`Never these words: ${ctx.forbiddenTerms.map((t) => `"${t}"`).join(", ")}.`);
  out.push(bullet(rules));
  if (feedback.length) out.push("", "## Your last answer broke these rules (fix them this time)", bullet(feedback));
  const shape = [
    ask.headlines ? `"headlines":["..."]` : `"headlines":[]`,
    ask.primaries ? `"primaries":["line one\\n\\nline two\\n\\n..."]` : `"primaries":[]`,
    ask.descriptions ? `"descriptions":["..."]` : `"descriptions":[]`,
    ...(fkb ? [] : [`"concept":"..."`, `"ps_obj":"ps"`]),
  ].join(",");
  out.push("", "## Output", `Reply with one JSON object only, no prose, no code fences: {${shape}}`);
  return out.join("\n");
}

export type RawAdDraft = { headlines: string[]; primaries: string[]; descriptions: string[]; concept: string | null; psObj: PsObj | null };

/** claude's reply text -> the drafted lines (code fences tolerated). Throws AdCopyError when there is no JSON object. */
export function parseAdDraft(text: string): RawAdDraft {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AdCopyError("claude's answer was not JSON.");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new AdCopyError("claude's answer was not valid JSON.");
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 8) : []);
  const descriptions = list(body.descriptions);
  if (!descriptions.length && typeof body.description === "string" && body.description.trim()) descriptions.push(body.description);
  const concept = typeof body.concept === "string" ? body.concept.trim().toLowerCase() : "";
  const ps = typeof body.ps_obj === "string" ? body.ps_obj.trim().toLowerCase() : "";
  const out: RawAdDraft = {
    headlines: list(body.headlines).map((h) => h.replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "")),
    primaries: list(body.primaries).map(doubleSpace),
    descriptions: descriptions.map((d) => d.replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "")),
    concept: conceptProblem(concept, adNaming()) == null ? concept : null,
    psObj: ps === "ps" || ps === "obj" ? ps : null,
  };
  if (!out.headlines.length && !out.primaries.length && !out.descriptions.length) throw new AdCopyError("claude's answer had no lines.");
  return out;
}

/** FORMAT v4's hard rule: a blank line between every line (single spaced lines are spread, never dropped). */
export function doubleSpace(p: string): string {
  return cleanCopyText(p)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Check one attempt's lines against the rules, the filled lines and what earlier attempts kept. Mutates `draft`. */
export function keepDrafted(raw: RawAdDraft, ctx: AdCopyContext, draft: AdDraft): AdCopyAttempt["dropped"] {
  const dropped: AdCopyAttempt["dropped"] = [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const taken = new Set(
    [...ctx.filled.headlines, ...ctx.filled.primaries.filter((_, i) => !(i === 0 && ctx.need.p1)), ctx.filled.description, ...draft.headlines, ...draft.primaries, draft.p1 ?? ""]
      .filter(Boolean)
      .map(norm),
  );
  const take = (field: "headline" | "primary" | "description", text: string, room: boolean, into: (t: string) => void) => {
    if (!room) return;
    const c = checkAdLine(text, field, ctx.rules);
    const problems = [...c.problems];
    if (field === "headline" && text.length > HEADLINE_WARN) problems.push(`${text.length} characters (draft headlines stay at ${HEADLINE_WARN} or fewer)`);
    if (field === "description" && text.length > DESC_WARN) problems.push(`${text.length} characters (draft descriptions stay at ${DESC_WARN} or fewer)`);
    if (field === "primary" && !text.includes("\n")) problems.push("Not FORMAT v4 (one line; it needs the place line, the pain, bullets and the close)");
    if (taken.has(norm(text))) problems.push("Same as a line already in the ad");
    if (problems.length) dropped.push({ field, text, reason: problems[0] });
    else {
      taken.add(norm(text));
      into(text);
    }
  };
  for (const h of raw.headlines) take("headline", h, draft.headlines.length < ctx.need.headlines, (t) => draft.headlines.push(t));
  const want = ctx.need.primaries + (ctx.need.p1 ? 1 : 0);
  for (const p of raw.primaries) {
    const have = draft.primaries.length + (draft.p1 ? 1 : 0);
    if (ctx.need.p1 && ctx.p1Opening && !draft.p1) {
      // Primary 1 opens with the hook: the hook line is forced in as its first line (a drafted first line that is
      // not the hook is kept as the second).
      const lines = p.split("\n\n");
      const opening = ctx.p1Opening.trim();
      const body = norm(lines[0]) === norm(opening) ? lines.slice(1) : lines;
      take("primary", [opening, ...body].join("\n\n"), true, (t) => (draft.p1 = t));
      continue;
    }
    take("primary", p, have < want, (t) => draft.primaries.push(t));
  }
  for (const d of raw.descriptions) take("description", d, ctx.need.description && draft.description == null, (t) => (draft.description = t));
  if (ctx.channel.section === "fkbpros") {
    draft.concept ??= raw.concept;
    draft.psObj ??= raw.psObj;
  }
  return dropped;
}

/** The draft covers every needed slot. */
export function draftComplete(ctx: AdCopyContext, draft: AdDraft): boolean {
  return (
    draft.headlines.length >= ctx.need.headlines &&
    draft.primaries.length >= ctx.need.primaries &&
    (!ctx.need.p1 || Boolean(draft.p1)) &&
    (!ctx.need.description || draft.description != null)
  );
}
