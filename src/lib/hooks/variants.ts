/**
 * Rewrite variants (Phase 4 E1 to E5, slice 3; server only): the `hook_variants` job rows, what `claude -p` is told
 * about a hook (its scores, the channel's notes, the avatar, the mechanics, the Three P's rule, the owner's steer), how its
 * answer is read, and Keep / Discard. The worker runs the jobs (src/worker/variants.ts); nothing here spawns anything.
 *
 * A job row: type `hook_variants`, asset_id null, input {hookId, steer}, result (see VariantJobResult), log_path
 * logs/jobs/hook-variants-<id>.log. One active job per hook. Variants are `variant` hooks: parent = the original,
 * same channel, kind text (for a video hook they are new opening lines to film or say), kept null = undecided and
 * hidden from the main list, scored at once (requested, so they run even while scoring is paused).
 */
import { VARIANT_JOB } from "../jobs";
import type Database from "better-sqlite3";
import { clientShortName } from "../media";
import { briefOf, channelNoteParts, loadChannelNotes, type ChannelNotes } from "./notes";
import { currentRubric, HOOK_LIVE, rubricVersions } from "./store";
import { hooksPath } from "./sql";
import { videoLines } from "./video";
import { AI_TELLS, VARIANT_MAX_CHARS, VARIANT_MIN_CHARS, type VariantRuleContext } from "./variant-rules";
import {
  dimensionsFor,
  levelOf,
  NONE_MECHANIC,
  normHook,
  PP_CLEAR,
  PP_IDS,
  PP_LABEL,
  type Avatar,
  type HookKind,
  type Mechanic,
  type SectionKey,
} from "./rubric";
import type { StoredAnswer } from "../ai/classes";
import { fill, houseRulesFor, profile } from "../profile";
import { laneNames } from "../clients-admin";

type Sql = Database.Database;

export { VARIANT_JOB } from "../jobs";
export const VARIANT_COUNT = 5;
/** Fewer survivors than this after the rule check = one retry of the whole call. */
export const VARIANT_MIN_SURVIVORS = 3;
export const STEER_MAX = 200;

export type VariantJobInput = { hookId: number; steer: string | null };

export type VariantAttempt = {
  returned: number;
  kept: number;
  dropped: { text: string; mechanic: string | null; rule: string; detail: string }[];
  ms: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export type VariantJobResult = {
  attempts: VariantAttempt[];
  /** Variant hook ids written by this job. */
  survivors: number[];
  note: string | null;
};

export class VariantError extends Error {}

// ------------------------------------------------------------------------------------------------ jobs

/** The active (pending / running) variants job of a hook, if any. */
function activeJobFor(sql: Sql, hookId: number): number | null {
  return (
    (sql
      .prepare(`select id from jobs where type = '${VARIANT_JOB}' and status in ('pending','running') and json_extract(input, '$.hookId') = ? limit 1`)
      .pluck()
      .get(hookId) as number | undefined) ?? null
  );
}

/** Queue "Rewrite variants" for a live hook (top level or kept variant). Returns the job id. */
export function queueVariants(sql: Sql, hookId: number, steer: string | null, now = Date.now()): number {
  const ok = sql.prepare(`select 1 from hooks h where h.id = ? and ${HOOK_LIVE}`).get(hookId);
  if (!ok) throw new VariantError("Only a live hook can be rewritten (not archived, not an undecided variant).");
  const clean = steer ? steer.replace(/\s+/g, " ").trim().slice(0, STEER_MAX) : "";
  return sql.transaction(() => {
    if (activeJobFor(sql, hookId)) throw new VariantError("Variants for this hook are already being written.");
    const input: VariantJobInput = { hookId, steer: clean || null };
    const info = sql
      .prepare(`insert into jobs (type, asset_id, input, status, priority, attempts, created_at) values ('${VARIANT_JOB}', null, ?, 'pending', 0, 0, ?)`)
      .run(JSON.stringify(input), now);
    return Number(info.lastInsertRowid);
  })();
}

/** Cancel a variants job that has not started (nothing ran). True when this call cancelled it. */
export function cancelVariantJob(sql: Sql, jobId: number, now = Date.now()): boolean {
  return (
    sql
      .prepare(`update jobs set status = 'cancelled', error = 'Cancelled', finished_at = ? where id = ? and type = '${VARIANT_JOB}' and status = 'pending'`)
      .run(now, jobId).changes > 0
  );
}

/**
 * Run a failed or cancelled variants job again (one more `claude -p` run on the subscription). Refused while the hook
 * has another active job, and for a hook that is no longer live (archived: restore it first).
 */
export function retryVariantJob(sql: Sql, jobId: number): boolean {
  const row = sql.prepare(`select input from jobs where id = ? and type = '${VARIANT_JOB}' and status in ('error','cancelled')`).get(jobId) as
    | { input: string }
    | undefined;
  if (!row) return false;
  const hookId = (JSON.parse(row.input) as VariantJobInput).hookId;
  if (!sql.prepare(`select 1 from hooks h where h.id = ? and ${HOOK_LIVE}`).get(hookId)) {
    const archived = sql.prepare("select archived_at is not null from hooks where id = ?").pluck().get(hookId);
    throw new VariantError(archived ? "The hook is archived: restore it first, then Retry." : "Only a live hook can be rewritten.");
  }
  if (activeJobFor(sql, hookId)) throw new VariantError("Variants for this hook are already being written.");
  return (
    sql
      .prepare(
        `update jobs set status = 'pending', error = null, result = null, started_at = null, finished_at = null, cancel_requested_at = null
          where id = ? and status in ('error','cancelled')`,
      )
      .run(jobId).changes > 0
  );
}

/** Keep: the variant becomes a normal live hook in its channel (source `variant`, parent link kept). */
export function keepVariant(sql: Sql, hookId: number): boolean {
  return sql.prepare("update hooks set kept = 1 where id = ? and parent_id is not null and kept is null and archived_at is null").run(hookId).changes > 0;
}

/** Discard: archived (kept = 0), never shown again; its score stays for Phase 5 calibration history. */
export function discardVariant(sql: Sql, hookId: number, now = Date.now()): boolean {
  return (
    sql
      .prepare("update hooks set kept = 0, archived_at = ?, score_requested_at = null where id = ? and parent_id is not null and kept is null and archived_at is null")
      .run(now, hookId).changes > 0
  );
}

// ------------------------------------------------------------------------------------------------ context + prompt

export type VariantContext = {
  hook: { id: number; kind: HookKind; text: string; section: SectionKey; sectionId: number; clientId: number | null };
  /** "<lane> client: Acme / Acme Renovations" etc. */
  channelLabel: string;
  /** The section's brief under the current rubric version (`briefOf`). */
  brief: string;
  notes: ChannelNotes;
  video: { spoken: string | null; onScreen: string | null; opening: string | null } | null;
  score: null | {
    version: number;
    overall: number | null;
    dims: { id: string; label: string; level: number | null }[];
    pp: Record<(typeof PP_IDS)[number], number | null>;
    style: string | null;
  };
  avatar: Avatar | null;
  /** The 9 copy mechanics (current version, without "none"). */
  mechanics: Mechanic[];
  rules: VariantRuleContext;
};

/** Everything the prompt and the rule check need for one hook (throws VariantError when it is gone). */
export function variantContext(sql: Sql, hookId: number): VariantContext {
  const h = sql
    .prepare(
      `select h.id, h.kind, h.text, h.section_id, h.client_id, h.asset_id, s.key as section
         from hooks h join sections s on s.id = h.section_id where h.id = ?`,
    )
    .get(hookId) as { id: number; kind: HookKind; text: string; section_id: number; client_id: number | null; asset_id: number | null; section: SectionKey } | undefined;
  if (!h) throw new VariantError("The hook is gone.");
  const notes = loadChannelNotes(sql, h.section, h.client_id);
  const labels = profile().variants.channels;
  const channelLabel =
    h.section === "rtm" ? labels.rtm : h.section === "fkb" ? labels.fkb : notes.client ? fill(labels.client, { name: notes.client.name }) : labels.shared;
  let video: VariantContext["video"] = null;
  if (h.kind === "video" && h.asset_id) {
    const a = sql.prepare("select description, spoken_open from assets where id = ?").get(h.asset_id) as
      | { description: string | null; spoken_open: string | null }
      | undefined;
    if (a) {
      const l = videoLines(a.description, a.spoken_open);
      video = { spoken: l.spoken, onScreen: l.onScreen, opening: l.opening };
    }
  }
  const versions = rubricVersions(sql);
  const current = currentRubric(sql);
  const sc = sql
    .prepare("select rubric_version, answers, overall, pp_person, pp_pain, pp_promise, style, avatar from hook_scores where hook_id = ? order by rubric_version desc limit 1")
    .get(hookId) as
    | { rubric_version: number; answers: string; overall: number | null; pp_person: number | null; pp_pain: number | null; pp_promise: number | null; style: string | null; avatar: string | null }
    | undefined;
  let score: VariantContext["score"] = null;
  let avatar: Avatar | null = null;
  if (sc) {
    const rubric = versions.get(sc.rubric_version) ?? current;
    let answers: Record<string, StoredAnswer> = {};
    try {
      answers = JSON.parse(sc.answers);
    } catch {
      /* keep empty */
    }
    score = {
      version: sc.rubric_version,
      overall: sc.overall,
      dims: dimensionsFor(rubric, h.section, h.kind).map((d) => ({
        id: d.id,
        label: d.label,
        level: typeof answers[d.id]?.value === "number" ? levelOf(answers[d.id].value as number) : null,
      })),
      pp: { pp_person: sc.pp_person, pp_pain: sc.pp_pain, pp_promise: sc.pp_promise },
      style: sc.style,
    };
    avatar = (sc.avatar && (current.avatars.find((a) => a.slug === sc.avatar) ?? rubric.avatars.find((a) => a.slug === sc.avatar))) || null;
  }
  const allClients = (
    sql
      .prepare("select c.code, c.name, c.brand_notes from clients c join sections s on s.id = c.section_id where s.key = 'fkbpros' order by c.sort, c.id")
      .all() as { code: string; name: string; brand_notes: string | null }[]
  ).map((c) => ({ code: c.code, name: c.name, brandNotes: c.brand_notes }));
  // Dedupe against the original, every hook in the channel that is live, and the undecided variants of this hook.
  const norms = sql
    .prepare(
      `select h.norm from hooks h where h.section_id = ? and h.client_id is ?
          and ((h.archived_at is null and (h.parent_id is null or h.kept = 1)) or (h.parent_id = ? and h.kept is null and h.archived_at is null))`,
    )
    .pluck()
    .all(h.section_id, h.client_id, h.id) as string[];
  const existingNorms = new Set([...norms, normHook(h.text)]);
  const client = notes.client ? allClients.find((c) => c.code === notes.client!.code) ?? null : null;
  return {
    hook: { id: h.id, kind: h.kind, text: h.text, section: h.section, sectionId: h.section_id, clientId: h.client_id },
    channelLabel,
    brief: briefOf(current, h.section),
    notes,
    video,
    score,
    avatar,
    mechanics: current.mechanics.filter((m) => m.id !== NONE_MECHANIC),
    rules: { section: h.section, client, allClients, existingNorms, ownNotes: notes.fkb?.brandNotes ?? null, house: houseRulesFor(h.section) },
  };
}

/** The dimensions to lift: the lowest levels (up to 2; all ties at the bottom). */
export function weakestDims(score: VariantContext["score"]): { label: string; level: number }[] {
  if (!score) return [];
  const dims = score.dims.filter((d): d is { id: string; label: string; level: number } => d.level != null).sort((a, b) => a.level - b.level);
  if (!dims.length) return [];
  const floor = dims[0].level;
  const out = dims.filter((d, i) => i < 2 || d.level <= floor + 0.05);
  return out.map((d) => ({ label: d.label, level: d.level }));
}

const bullet = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

/**
 * The one prompt `claude -p` gets. The owner's steer and the notes are quoted as material, never as instructions that can
 * change the rules. `feedback` (the retry) lists the rules the first answer broke.
 */
export function buildVariantPrompt(ctx: VariantContext, steer: string | null, feedback: string[] = []): string {
  const P = profile().variants;
  const parts = channelNoteParts(ctx.notes);
  const fkb = ctx.hook.section === "fkbpros";
  const own = ctx.hook.section === "fkb";
  const mechIds = ctx.mechanics.map((m) => m.id);
  const weak = weakestDims(ctx.score);
  const out: string[] = [];
  out.push(
    `Rewrite one ${ctx.hook.kind === "video" ? "video hook (the opening line of a video)" : "ad hook"} into exactly ${VARIANT_COUNT} new variants.`,
  );
  out.push("", "## Channel", ctx.channelLabel, ctx.brief);
  if (ctx.notes.client) out.push(`${P.whoClient}: ${parts.hint || ctx.notes.client.name}`);
  if (own && parts.hint) out.push(`${P.whoCompany}: ${parts.hint}`);
  if (parts.notes.length) {
    out.push("", `## ${fkb ? P.notesHeadings.client : own ? P.notesHeadings.fkb : P.notesHeadings.rtm}`, bullet(parts.notes));
  }
  if (parts.works.length) out.push("", "## What works here", bullet(parts.works));
  if (parts.whos.length) out.push("", "## Who's who", bullet(parts.whos));

  out.push("", "## The hook", `"${ctx.hook.text}"`);
  if (ctx.video) {
    out.push(
      P.videoLine,
      `Spoken opening now: ${ctx.video.spoken ?? "none"}`,
      `On-screen text now: ${ctx.video.onScreen ?? "none"}`,
      `What the first seconds show: ${ctx.video.opening ?? "unknown"}`,
    );
  }
  if (ctx.score) {
    const s = ctx.score;
    out.push(
      "",
      `## Its scores (rubric v${s.version}, levels 1 to 5)`,
      `Overall ${s.overall != null ? s.overall.toFixed(1) : "unknown"}`,
      ...s.dims.map((d) => `- ${d.label}: ${d.level != null ? d.level.toFixed(1) : "no answer"}`),
      `Three P's: ${PP_IDS.map((id) => `${PP_LABEL[id]} ${s.pp[id] != null && (s.pp[id] as number) >= PP_CLEAR ? "clear" : "missing"}`).join(", ")}`,
      `Copy mechanic it leans on: ${s.style ? (ctx.mechanics.find((m) => m.id === s.style)?.label ?? s.style) : "unknown"}`,
    );
    if (weak.length) out.push(`Weakest: ${weak.map((w) => `${w.label} (${w.level.toFixed(1)})`).join(", ")}.`);
  } else {
    out.push("", "## Its scores", "Not scored yet. Aim to lift Specificity and Curiosity gap.");
  }
  out.push("", "## Avatar (keep this person and this promise)");
  if (ctx.avatar) {
    out.push(`Person: ${ctx.avatar.person}`, `Pain: ${ctx.avatar.pain}`, `Promise: ${ctx.avatar.promise}`);
  } else {
    out.push("No avatar matched. Keep the person and the promise the hook already speaks to.");
  }

  out.push("", "## Copy mechanics (pick from these ids)", ...ctx.mechanics.map((m) => `- ${m.id}: ${m.label}. ${m.definition}`));
  out.push(
    "",
    "## The Three P's rule",
    "A strong hook makes three things clear: the Person it is for (so they recognize themselves), their Pain (the specific problem) and the Promise (the one outcome they get). Every variant should make all three clear.",
  );
  if (steer) out.push("", `## ${P.steerHeading}`, `"${steer}"`);

  out.push(
    "",
    "## Task",
    `Write exactly ${VARIANT_COUNT} variants. Each one uses a DIFFERENT copy mechanic from the list, chosen to lift the weakest scores${weak.length ? ` (${weak.map((w) => w.label).join(", ")})` : ""}.`,
    "Keep the same avatar and the same promise. Say it in plain, specific words a real person would use.",
    `Keep the original's shape and length: a short headline stays a short headline (no more than about ${Math.max(6, Math.round(ctx.hook.text.split(/\s+/).length * 1.6))} words), a sentence stays one sentence.`,
  );
  out.push("", "## Copy rules (a variant that breaks one is thrown away)");
  const rules: string[] = [...(own ? P.rules.fkb : fkb ? P.rules.fkbpros : P.rules.rtm)];
  rules.push(
    `None of these phrases: ${AI_TELLS.map((t) => `"${t}"`).join(", ")}.`,
    `Each variant is ${VARIANT_MIN_CHARS} to ${VARIANT_MAX_CHARS} characters, one line, no quotes around it, no emoji, no hashtags.`,
    "Not a copy of the original hook or of each other.",
  );
  out.push(bullet(rules));
  if (feedback.length) out.push("", "## Your last answer broke these rules (fix them this time)", bullet(feedback));
  out.push(
    "",
    "## Output",
    `Reply with one JSON object only, no prose, no code fences: {"variants":[{"text":"...","mechanic":"<id>"}]} with exactly ${VARIANT_COUNT} items; mechanic is one of: ${mechIds.join(", ")}.`,
  );
  return out.join("\n");
}

export type RawVariant = { text: string; mechanic: string | null };

/** claude's reply text -> the variants (code fences and stray prose tolerated). Throws VariantError when there is no list. */
export function parseVariants(text: string, mechanicIds: string[]): RawVariant[] {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new VariantError("claude's answer was not JSON.");
  let body: unknown;
  try {
    body = JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new VariantError("claude's answer was not valid JSON.");
  }
  const list = (body as { variants?: unknown }).variants;
  if (!Array.isArray(list) || !list.length) throw new VariantError("claude's answer had no variants list.");
  return list
    .slice(0, 10)
    .map((v) => {
      const o = (v ?? {}) as { text?: unknown; mechanic?: unknown };
      const mech = typeof o.mechanic === "string" ? o.mechanic.trim() : "";
      return {
        text: typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "") : "",
        mechanic: mechanicIds.includes(mech) ? mech : null,
      };
    })
    .filter((v) => v.text);
}

export const ARCHIVED_WHILE_WRITING = "The hook was archived while claude was writing.";

/**
 * Insert the surviving variants (one transaction). Returns their ids. They are requested for scoring at once. The parent
 * is re-read inside the transaction: gone or archived meanwhile = a VariantError (the job ends in that error, nothing
 * is written).
 */
export function insertVariants(sql: Sql, ctx: VariantContext, jobId: number, variants: RawVariant[], now = Date.now()): number[] {
  const ins = sql.prepare(
    `insert into hooks (section_id, client_id, kind, text, norm, source, parent_id, kept, variant_mechanic, variant_job_id, score_requested_at, created_at)
     values (?, ?, 'text', ?, ?, 'variant', ?, null, ?, ?, ?, ?)`,
  );
  return sql.transaction(() => {
    const parent = sql.prepare("select archived_at from hooks where id = ?").get(ctx.hook.id) as { archived_at: number | null } | undefined;
    if (!parent) throw new VariantError("The hook was deleted while claude was writing.");
    if (parent.archived_at != null) throw new VariantError(ARCHIVED_WHILE_WRITING);
    return variants.map((v) => Number(ins.run(ctx.hook.sectionId, ctx.hook.clientId, v.text, normHook(v.text), ctx.hook.id, v.mechanic, jobId, now, now).lastInsertRowid));
  })();
}

// ------------------------------------------------------------------------------------------------ Jobs page

export type VariantJobView = {
  id: number;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  hookId: number;
  hookText: string;
  channel: string;
  href: string;
  steer: string | null;
  error: string | null;
  survivors: number;
  returned: number;
  attempts: number;
  note: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  logPath: string | null;
};

/** Variants jobs for the Jobs page: active first, then the most recent. */
export function variantJobs(sql: Sql, limit = 30): VariantJobView[] {
  const rows = sql
    .prepare(
      `select j.id, j.status, j.error, j.input, j.result, j.created_at, j.started_at, j.finished_at, j.log_path,
              h.id as hook_id, h.text, h.kind, s.key as section, c.code, c.name as cname
         from jobs j left join hooks h on h.id = json_extract(j.input, '$.hookId')
         left join sections s on s.id = h.section_id left join clients c on c.id = h.client_id
        where j.type = '${VARIANT_JOB}'
        order by case j.status when 'running' then 0 when 'pending' then 1 else 2 end, coalesce(j.finished_at, j.created_at) desc
        limit ?`,
    )
    .all(limit) as {
    id: number;
    status: VariantJobView["status"];
    error: string | null;
    input: string | null;
    result: string | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    log_path: string | null;
    hook_id: number | null;
    text: string | null;
    kind: HookKind | null;
    section: SectionKey | null;
    code: string | null;
    cname: string | null;
  }[];
  const L = laneNames(sql);
  return rows.map((r) => {
    let input: Partial<VariantJobInput> = {};
    let result: Partial<VariantJobResult> = {};
    try {
      input = JSON.parse(r.input ?? "{}");
      result = JSON.parse(r.result ?? "{}") ?? {};
    } catch {
      /* keep empty */
    }
    const base = hooksPath(r.section, r.code);
    return {
      id: r.id,
      status: r.status,
      hookId: r.hook_id ?? input.hookId ?? 0,
      hookText: r.text ?? "(hook deleted)",
      channel: r.section === "rtm" ? L.rtm : r.section === "fkb" ? L.fkb : r.cname ? clientShortName(r.cname) : `${L.fkbpros} shared`,
      href: `${base}?${r.kind === "video" ? "view=video&" : ""}focus=${r.hook_id ?? ""}`,
      steer: input.steer ?? null,
      error: r.error,
      survivors: result.survivors?.length ?? 0,
      returned: (result.attempts ?? []).reduce((a, x) => a + x.returned, 0),
      attempts: result.attempts?.length ?? 0,
      note: result.note ?? null,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      logPath: r.log_path,
    };
  });
}

/** Per parent hook id: its active variants job ("Writing variants…" on the row), for the Hooks tab. */
export function activeVariantJobs(sql: Sql, hookIds: number[]): Map<number, { id: number; status: "pending" | "running" }> {
  if (!hookIds.length) return new Map();
  const rows = sql
    .prepare(
      `select id, status, json_extract(input, '$.hookId') as hook from jobs
        where type = '${VARIANT_JOB}' and status in ('pending','running')
          and json_extract(input, '$.hookId') in (select value from json_each(?))`,
    )
    .all(JSON.stringify(hookIds)) as { id: number; status: "pending" | "running"; hook: number }[];
  return new Map(rows.map((r) => [r.hook, { id: r.id, status: r.status }]));
}
