/**
 * Hooks data access shared by the app (server actions, pages) and the worker (server only): the current rubric version,
 * the scoring pause, "Score again", adding / pasting / importing text hooks (deduped per channel), archiving, the
 * scoring summary, the Rescore preview and "changed since scored" (notes or a re-described video). The shared SQL
 * fragments (HOOK_LIVE, LATEST_SCORE, the channel condition) live in sql.ts and are re-exported here. All SQL is
 * parameterized.
 */
import fs from "node:fs";
import type Database from "better-sqlite3";
import { notCleared } from "../cleared";
import { copyDocPath, parseCopyDoc } from "./copydoc";
import { briefsOf, channelNotesFp, loadChannelNotes } from "./notes";
import { hookUnsureIds, type HookEvaluation } from "./score";
import type { StoredAnswer } from "../ai/classes";
import { getSetting, setSetting } from "../ai/state";
import {
  computeSectionVersions,
  HOOK_MAX_CHARS,
  normHook,
  parseBriefs,
  parseSectionVersions,
  rubricHasFkb,
  type HookSource,
  type RubricContent,
  type RubricVersion,
  type SectionKey,
  type SectionVersions,
} from "./rubric";
import { canonicalRubric, RUBRIC_NOTE_MAX, rubricContentSchema, sameRubric } from "./rubric-edit";
import { HOOK_ACTIVE, HOOK_LIVE, HOOK_VISIBLE, hookScopeSql, hooksPath, LATEST_SCORE, type HookScope } from "./sql";
import { laneNames } from "../clients-admin";

type Sql = Database.Database;

export const HOOKS_PAUSED_KEY = "hooks:paused";

/** A hooks channel: Lane A, Lane B shared (client null) or one Lane B client. */
export type HookChannel = { section: SectionKey; clientCode: string | null };

export { HOOK_ACTIVE, HOOK_LIVE, HOOK_VISIBLE, hookScopeSql, LATEST_SCORE, type HookScope };

/**
 * Write one hook score (insert, or replace the same hook + rubric version). The one writer of `hook_scores` rows from an
 * evaluation: the worker's HookScoreQueue (a Jev answer) and the demo seed (scripts/demo-data.ts, fixed answers, model
 * `demo`, no call id).
 */
export function storeHookScore(
  sql: Sql,
  s: { hookId: number; version: number; ev: HookEvaluation; notesFp: string; model: string; callId: number | null; now: number },
): void {
  sql
    .prepare(
      `insert into hook_scores (hook_id, rubric_version, answers, unsure, overall, pp_person, pp_pain, pp_promise, style, avatar,
         stops_scroll, notes_fp, model, call_id, scored_at)
       values (@hook, @version, @answers, @unsure, @overall, @person, @pain, @promise, @style, @avatar, @stops, @fp, @model, @call, @now)
       on conflict (hook_id, rubric_version) do update set answers = excluded.answers, unsure = excluded.unsure,
         overall = excluded.overall, pp_person = excluded.pp_person, pp_pain = excluded.pp_pain, pp_promise = excluded.pp_promise,
         style = excluded.style, avatar = excluded.avatar, stops_scroll = excluded.stops_scroll, notes_fp = excluded.notes_fp,
         model = excluded.model, call_id = excluded.call_id, scored_at = excluded.scored_at`,
    )
    .run({
      hook: s.hookId,
      version: s.version,
      answers: JSON.stringify(s.ev.answers),
      unsure: JSON.stringify(s.ev.unsure),
      overall: s.ev.overall,
      person: s.ev.pp.pp_person,
      pain: s.ev.pp.pp_pain,
      promise: s.ev.pp.pp_promise,
      style: s.ev.style,
      avatar: s.ev.avatar,
      stops: s.ev.stopsScroll,
      fp: s.notesFp,
      model: s.model,
      call: s.callId,
      now: s.now,
    });
}

/** Paused = only "Score again" requests run. Seeded paused (seed v6); anything but "0" is paused. */
export function hooksPaused(sql: Sql): boolean {
  return getSetting(sql, HOOKS_PAUSED_KEY) !== "0";
}

export function setHooksPaused(sql: Sql, paused: boolean) {
  setSetting(sql, HOOKS_PAUSED_KEY, paused ? "1" : "0");
}

// ------------------------------------------------------------------------------------------------ rubric

type RubricRow = {
  version: number;
  dimensions: string;
  mechanics: string;
  avatars: string;
  note: string | null;
  created_at: number;
  rescore_at: number | null;
  briefs: string | null;
  section_versions: string | null;
};

function toRubric(r: RubricRow): RubricVersion {
  return {
    version: r.version,
    dimensions: JSON.parse(r.dimensions),
    mechanics: JSON.parse(r.mechanics),
    avatars: JSON.parse(r.avatars),
    note: r.note,
    createdAt: r.created_at,
    rescoreAt: r.rescore_at,
    briefs: parseBriefs(r.briefs),
    sectionVersions: parseSectionVersions(r.section_versions, r.version),
  };
}

const RUBRIC_COLS = "version, dimensions, mechanics, avatars, note, created_at, rescore_at, briefs, section_versions";

/** The one current rubric version (seed v6 guarantees there is one). */
export function currentRubric(sql: Sql): RubricVersion {
  const row = sql.prepare(`select ${RUBRIC_COLS} from rubric_versions where current = 1`).get() as RubricRow | undefined;
  if (!row) throw new Error("No current rubric version (seed v6 did not run)");
  return toRubric(row);
}

/** Every version by number (the Hooks tab shows a hook's latest score with the dimensions of the version it used). */
export function rubricVersions(sql: Sql): Map<number, RubricVersion> {
  const rows = sql.prepare(`select ${RUBRIC_COLS} from rubric_versions order by version`).all() as RubricRow[];
  return new Map(rows.map((r) => [r.version, toRubric(r)]));
}

export class RubricEditError extends Error {}

/**
 * Save an edited rubric as a NEW version (never an in-place edit) and make it current. Nothing becomes due for the
 * hooks that already have a score until the owner clicks Rescore (`approveRescore`); hooks never scored are due as always.
 * Old scores stay. The editor does not edit briefs: the current version's are carried forward. The new row stores its
 * section versions (`computeSectionVersions`): a section whose content did not change keeps its number, so the copy
 * gate's Lane B / Lane C keys only move when their own content does. Throws RubricEditError with a plain message when the
 * content does not pass.
 */
export function saveRubricVersion(sql: Sql, content: RubricContent, note: string, now = Date.now()): number {
  const current = currentRubric(sql);
  const parsed = rubricContentSchema(current.mechanics, rubricHasFkb(current), laneNames(sql)).safeParse(content);
  if (!parsed.success) throw new RubricEditError(parsed.error.issues[0]?.message ?? "The rubric does not pass the checks.");
  const clean = canonicalRubric(parsed.data);
  const text = note.replace(/\s+/g, " ").trim().slice(0, RUBRIC_NOTE_MAX);
  if (text.length < 3) throw new RubricEditError("Add a short note: what changed and why.");
  if (sameRubric(clean, current)) throw new RubricEditError("Nothing changed.");
  return sql.transaction(() => {
    const next = ((sql.prepare("select max(version) from rubric_versions").pluck().get() as number | null) ?? 0) + 1;
    const briefs = briefsOf(current);
    const sectionVersions = computeSectionVersions(
      { content: current, briefs, sectionVersions: current.sectionVersions },
      { content: clean, briefs },
      next,
    );
    sql.prepare("update rubric_versions set current = 0 where current = 1").run();
    sql
      .prepare(
        `insert into rubric_versions (version, dimensions, mechanics, avatars, note, current, created_at, rescore_at, briefs, section_versions)
         values (?, ?, ?, ?, ?, 1, ?, null, ?, ?)`,
      )
      .run(
        next,
        JSON.stringify(clean.dimensions),
        JSON.stringify(clean.mechanics),
        JSON.stringify(clean.avatars),
        text,
        now,
        current.briefs ? JSON.stringify(current.briefs) : null,
        JSON.stringify(sectionVersions),
      );
    return next;
  })();
}

/** Jev cost of one hook score so far (mean of successful hook_score calls), else the PHASE-4 estimate (~4,000 tokens). */
export function hookScoreUnitUsd(sql: Sql): number {
  const avg = sql.prepare("select avg(cost_usd) from ai_calls where purpose = 'hook_score' and error is null").pluck().get() as number | null;
  return avg && avg > 0 ? avg : 0.0002;
}

export type RescorePreview = {
  version: number;
  /** The owner clicked Rescore for the current version (or it is v1). */
  approved: boolean;
  /** Live hooks that have an older score and none for the current version: what Rescore would score. */
  count: number;
  /**
   * What the same click also releases: while scoring is paused, "Rescore and resume scoring" resumes the queue, so the
   * never-scored live hooks (no error, no pending request: requests run even while paused) are scored too. 0 while
   * scoring runs (they are being scored anyway, the click adds nothing).
   */
  waiting: number;
  paused: boolean;
  /** (count + waiting) x the average hook_score cost: what the click spends. */
  usd: number;
};

/** "N hooks will be rescored + M waiting, about $X" for the current version (what the Rescore click releases). */
export function rescorePreview(sql: Sql): RescorePreview {
  const rubric = currentRubric(sql);
  const paused = hooksPaused(sql);
  const count = sql
    .prepare(`select count(*) from hooks h where ${HOOK_LIVE} and ${HOOK_UNSCORED} and not ${HOOK_NEVER_SCORED}`)
    .pluck()
    .get({ version: rubric.version }) as number;
  const waiting = paused ? (sql.prepare(`select count(*) from hooks h where ${HOOK_LIVE} and ${HOOK_BACKLOG}`).pluck().get() as number) : 0;
  return { version: rubric.version, approved: rubric.rescoreAt != null, count, waiting, paused, usd: (count + waiting) * hookScoreUnitUsd(sql) };
}

/** The owner's Rescore click: every live hook without a current version score becomes due (the queue does the rest). */
export function approveRescore(sql: Sql, now = Date.now()): number {
  const v = currentRubric(sql).version;
  sql.prepare("update rubric_versions set rescore_at = ? where version = ? and rescore_at is null").run(now, v);
  return rescorePreview(sql).count;
}

/**
 * One section's "rescore on the current version" (landing page Phase 2 slice 1): live hooks of the section that have an
 * older score and none for the current version, not already requested. Shown only while the section's content changed
 * in the current version (`changed`: its section version IS the current version) and the global Rescore was not
 * clicked, so the owner can rescore Lane A on v3 without the global Rescore (which would rescore every Lane B / Lane C hook).
 */
export type SectionRescorePreview = {
  section: SectionKey;
  /** The lane's display name (Settings > Lanes). */
  name: string;
  version: number;
  changed: boolean;
  approved: boolean;
  count: number;
  usd: number;
};

/** The hooks a section rescore takes (`@section`, `@version` bound by the caller). A function: the fragments below load later. */
const sectionRescoreDue = () =>
  `h.section_id = (select id from sections where key = @section) and ${HOOK_LIVE} and h.score_requested_at is null
   and ${HOOK_UNSCORED} and not ${HOOK_NEVER_SCORED}`;

export function sectionRescorePreview(sql: Sql, section: SectionKey): SectionRescorePreview {
  const rubric = currentRubric(sql);
  const count = sql.prepare(`select count(*) from hooks h where ${sectionRescoreDue()}`).pluck().get({ section, version: rubric.version }) as number;
  return {
    section,
    name: laneNames(sql)[section],
    version: rubric.version,
    changed: rubric.sectionVersions[section] === rubric.version,
    approved: rubric.rescoreAt != null,
    count,
    usd: count * hookScoreUnitUsd(sql),
  };
}

/**
 * Why a section rescore click is refused (the server re-checks; the button is only a hint): the section's content did
 * not change in the current version, the global Rescore was already clicked (it covers every section), or nothing is
 * left to rescore (none with an older score, or all already requested). null = allowed.
 */
export function sectionRescoreRefusal(p: SectionRescorePreview): string | null {
  const name = p.name;
  if (!p.changed) return `${name} did not change in rubric v${p.version}: nothing to rescore.`;
  if (p.approved) return `Rescore was already clicked for v${p.version}: it covers ${name} too.`;
  if (p.count <= 0) return `Nothing to rescore: every ${name} hook has a v${p.version} score or is already queued.`;
  return null;
}

/**
 * The owner's "Rescore Lane A hooks on vN" click: Score again (`requestScore`, runs even while scoring is paused) for
 * exactly the hooks `sectionRescorePreview` counts. Never called by itself; returns how many were requested.
 */
export function requestSectionRescore(sql: Sql, section: SectionKey, now = Date.now()): number {
  const version = currentRubric(sql).version;
  const ids = sql.prepare(`select h.id from hooks h where ${sectionRescoreDue()} order by h.id`).pluck().all({ section, version }) as number[];
  return requestScore(sql, ids, now);
}

export function rubricHistory(sql: Sql): {
  version: number;
  note: string | null;
  createdAt: number;
  current: boolean;
  scored: number;
  rescoreAt: number | null;
  sectionVersions: SectionVersions;
}[] {
  return (
    sql
      .prepare(
        `select v.version, v.note, v.created_at, v.current, v.rescore_at, v.section_versions,
                (select count(*) from hook_scores s where s.rubric_version = v.version) as scored
           from rubric_versions v order by v.version desc`,
      )
      .all() as {
      version: number;
      note: string | null;
      created_at: number;
      current: number;
      scored: number;
      rescore_at: number | null;
      section_versions: string | null;
    }[]
  ).map((r) => ({
    version: r.version,
    note: r.note,
    createdAt: r.created_at,
    current: r.current === 1,
    scored: r.scored,
    rescoreAt: r.rescore_at,
    sectionVersions: parseSectionVersions(r.section_versions, r.version),
  }));
}

// ------------------------------------------------------------------------------------------------ channels

export function channelIds(sql: Sql, ch: HookChannel): { sectionId: number; clientId: number | null } {
  const sectionId = sql.prepare("select id from sections where key = ?").pluck().get(ch.section) as number | undefined;
  if (sectionId == null) throw new Error(`Unknown section ${ch.section}`);
  if (!ch.clientCode) return { sectionId, clientId: null };
  if (ch.section !== "fkbpros") throw new Error("Only Lane B hooks belong to a client");
  const clientId = sql.prepare("select id from clients where code = ? and section_id = ?").pluck().get(ch.clientCode, sectionId) as number | undefined;
  if (clientId == null) throw new Error(`Unknown client ${ch.clientCode}`);
  return { sectionId, clientId };
}

/**
 * Pasted list -> hook lines: one per line, blank lines skipped, surrounding spaces and a leading list marker ("- ",
 * "* ", "• ", "1. ", "1) ") removed; the text is otherwise kept as typed. Duplicates collapse (normHook).
 */
export function parsePasted(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*•]\s+|\d{1,3}[.)]\s+)/, "").trim();
    if (!line) continue;
    const n = normHook(line);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(line.slice(0, HOOK_MAX_CHARS));
  }
  return out;
}

export type AddResult = { added: number; skipped: number; ids: number[] };

/**
 * Insert text hooks into a channel, skipping any whose normalized text the channel already has as a top level hook or a
 * kept variant (archived included, so a re-import never brings an archived hook back). One transaction.
 */
export function addTextHooks(
  sql: Sql,
  ch: HookChannel,
  items: { text: string; source: HookSource; angle?: string | null }[],
  now = Date.now(),
): AddResult {
  const { sectionId, clientId } = channelIds(sql, ch);
  // Top level hooks and kept variants (a kept variant is a normal hook in the channel); archived ones count too.
  const exists = sql.prepare(
    "select 1 from hooks where section_id = ? and client_id is ? and kind = 'text' and (parent_id is null or kept = 1) and norm = ? limit 1",
  );
  const insert = sql.prepare(
    `insert into hooks (section_id, client_id, kind, text, norm, source, angle_slug, created_at)
     values (?, ?, 'text', ?, ?, ?, ?, ?)`,
  );
  const result: AddResult = { added: 0, skipped: 0, ids: [] };
  sql.transaction(() => {
    for (const item of items) {
      const text = item.text.trim().slice(0, HOOK_MAX_CHARS);
      const norm = normHook(text);
      if (!norm || exists.get(sectionId, clientId, norm)) {
        result.skipped++;
        continue;
      }
      const info = insert.run(sectionId, clientId, text, norm, item.source, item.angle ?? null, now);
      result.added++;
      result.ids.push(Number(info.lastInsertRowid));
    }
  })();
  return result;
}

export type ImportResult = AddResult & { found: number; file: string };

/** Import approved copy for one Lane B client (read only, re-runnable, deduped). Throws CopyDocError when missing. */
export function importApprovedCopy(sql: Sql, code: string, dir: string, now = Date.now()): ImportResult {
  const folder = sql.prepare("select folder from clients where code = ?").pluck().get(code) as string | null | undefined;
  const file = copyDocPath(dir, folder ?? null);
  const lines = parseCopyDoc(fs.readFileSync(file, "utf8"));
  const res = addTextHooks(
    sql,
    { section: "fkbpros", clientCode: code },
    lines.map((l) => ({ text: l.text, source: "copy_doc" as const, angle: l.angle })),
    now,
  );
  return { ...res, found: lines.length, file };
}

/** "Score again": the queue runs it next (even while paused) and clears its last error. */
export function requestScore(sql: Sql, hookIds: number[], now = Date.now()): number {
  // Live hooks and undecided variants (never archived / discarded ones).
  const stmt = sql.prepare("update hooks set score_requested_at = ?, score_error = null where id = ? and archived_at is null");
  let n = 0;
  sql.transaction(() => {
    for (const id of hookIds) n += stmt.run(now, id).changes;
  })();
  return n;
}

export function setHookArchived(sql: Sql, hookId: number, archived: boolean, now = Date.now()): boolean {
  return (
    sql
      .prepare(`update hooks set archived_at = ?, score_requested_at = case when ? then null else score_requested_at end where id = ?`)
      .run(archived ? now : null, archived ? 1 : 0, hookId).changes > 0
  );
}

// ------------------------------------------------------------------------------------------------ due + summary

/** No score for the current rubric version (`@version` is bound by the caller). */
export const HOOK_UNSCORED = "not exists (select 1 from hook_scores hs where hs.hook_id = h.id and hs.rubric_version = @version)";
/** No score of any version (a new hook). */
export const HOOK_NEVER_SCORED = "not exists (select 1 from hook_scores hs0 where hs0.hook_id = h.id)";
/** Never-scored live hooks the queue would take once scoring runs (no error, not already requested). */
export const HOOK_BACKLOG = `h.score_error is null and h.score_requested_at is null and ${HOOK_NEVER_SCORED}`;

/** The owner clicked Rescore for the current version (slice 3), or it is v1. */
export const HOOK_RESCORE_OPEN = "exists (select 1 from rubric_versions rvo where rvo.version = @version and rvo.rescore_at is not null)";
/**
 * Due without a request: no error, and unscored for the current version (a hook that has an older score only once
 * Rescore was clicked: saving a version never spends by itself). A video re-described after its score is NOT due by
 * itself: it joins the Hooks tab's "changed since scored" banner and waits for the owner's Score again click.
 */
export const HOOK_DUE = `(h.score_error is null and ${HOOK_UNSCORED} and (${HOOK_NEVER_SCORED} or ${HOOK_RESCORE_OPEN}))`;
/**
 * A video hook whose asset was described again after its latest score (`hs` = the LATEST_SCORE join): new opening,
 * on-screen text or spoken line. Shown in the "changed since scored" banner; never rescored without a click.
 */
export const HOOK_VIDEO_REDESCRIBED = `(h.kind = 'video' and exists (select 1 from assets da where da.id = h.asset_id and da.described_at > hs.scored_at))`;

/**
 * Scoring counts: total / scored = live hooks (scored for the current version); requested, errors and queued also
 * count undecided variants (they are scored on request).
 */
export type HookScoreSummary = {
  version: number;
  paused: boolean;
  total: number;
  scored: number;
  queued: number;
  requested: number;
  errors: number;
};

/** "Retry all errors" on the Jobs page: Score again for every hook whose last scoring failed. */
export function retryHookErrors(sql: Sql, now = Date.now()): number {
  return sql
    .prepare(`update hooks set score_requested_at = ?, score_error = null where score_error is not null and ${notCleared("hook", "hooks.id", "hooks.score_error")} and id in (select h.id from hooks h where ${HOOK_ACTIVE})`)
    .run(now).changes;
}

export type HookErrorRow = { id: number; text: string; kind: "text" | "video"; href: string; error: string; variant: boolean };

/** Hooks whose last scoring failed (Jobs page error rows; per-row Retry = Score again). */
export function hookErrors(sql: Sql, limit = 50): HookErrorRow[] {
  const rows = sql
    .prepare(
      `select h.id, h.text, h.kind, h.parent_id, s.key as section, c.code, h.score_error as error
         from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id
        where ${HOOK_ACTIVE} and h.score_error is not null and ${notCleared("hook", "h.id", "h.score_error")} order by h.id desc limit ?`,
    )
    .all(limit) as { id: number; text: string; kind: "text" | "video"; parent_id: number | null; section: SectionKey; code: string | null; error: string }[];
  return rows.map((r) => {
    const base = hooksPath(r.section, r.code);
    const focus = r.parent_id ?? r.id;
    return { id: r.id, text: r.text, kind: r.kind, error: r.error, variant: r.parent_id != null, href: `${base}?${r.kind === "video" ? "view=video&" : ""}focus=${focus}` };
  });
}

export function hookScoreSummary(sql: Sql, version: number): HookScoreSummary {
  const live = `(h.parent_id is null or h.kept = 1)`;
  const row = sql
    .prepare(
      `select coalesce(sum(${live}), 0) as total,
              coalesce(sum(${live} and not ${HOOK_UNSCORED}), 0) as scored,
              coalesce(sum(h.score_requested_at is not null), 0) as requested,
              coalesce(sum(h.score_error is not null and ${notCleared("hook", "h.id", "h.score_error")}), 0) as errors,
              coalesce(sum(h.score_requested_at is not null or (${live} and ${HOOK_DUE})), 0) as queued
         from hooks h where ${HOOK_ACTIVE}`,
    )
    .get({ version }) as { total: number; scored: number; requested: number; errors: number; queued: number };
  return { version, paused: hooksPaused(sql), ...row };
}

// ------------------------------------------------------------------------------------------------ changed since scored (D5)

type Group = { section: SectionKey; sectionId: number; clientId: number | null };

/**
 * The (section, client) groups a Hooks tab shows: one for Lane A, Lane C and a client channel; shared + every client for All
 * clients (Lane B).
 */
function scopeGroups(sql: Sql, scope: HookScope): Group[] {
  const sectionKey: SectionKey = scope.kind === "rtm" ? "rtm" : scope.kind === "fkb" ? "fkb" : "fkbpros";
  const sectionId = sql.prepare("select id from sections where key = ?").pluck().get(sectionKey) as number | undefined;
  if (sectionId == null) return [];
  if (scope.kind === "rtm" || scope.kind === "fkb") return [{ section: sectionKey, sectionId, clientId: null }];
  if (scope.kind === "client") {
    const clientId = sql.prepare("select id from clients where code = ? and section_id = ?").pluck().get(scope.code, sectionId) as number | undefined;
    return clientId == null ? [] : [{ section: "fkbpros", sectionId, clientId }];
  }
  const clients = sql.prepare("select id from clients where section_id = ? order by sort, id").pluck().all(sectionId) as number[];
  return [{ section: "fkbpros", sectionId, clientId: null }, ...clients.map((id) => ({ section: "fkbpros" as const, sectionId, clientId: id }))];
}

export type ChangedSinceScored = {
  /** Every hook below, once (a hook can have both reasons). */
  count: number;
  ids: number[];
  /** Scored with other notes than the channel has now. */
  notes: number;
  /** Video hooks whose file was described again after their score. */
  described: number;
};

/**
 * Live hooks in this Hooks tab (and kind) whose latest score no longer matches its inputs: made with other notes than the
 * channel has now (brand notes, hint, What works here, Lane A notes, who's who: `channelNotesFp`), or (video) its file was
 * described again after the score (new opening, on-screen text or spoken line). Hooks already waiting for a Score again
 * are not counted. Nothing here rescores; the tab's button requests Score again for exactly these ids.
 */
export function changedSinceScored(sql: Sql, scope: HookScope, kind: "text" | "video" | null = null): ChangedSinceScored {
  // The latest score each hook has (after a new rubric version it may still be an older version's until Rescore).
  const stmt = sql.prepare(
    `select h.id, coalesce(hs.notes_fp, '') <> @fp as notes, ${HOOK_VIDEO_REDESCRIBED} as described
       from hooks h join hook_scores hs on hs.hook_id = h.id and ${LATEST_SCORE}
      where ${HOOK_LIVE} and h.section_id = @section and h.client_id is @client and (@kind is null or h.kind = @kind)
        and h.score_requested_at is null and (coalesce(hs.notes_fp, '') <> @fp or ${HOOK_VIDEO_REDESCRIBED})
      order by h.id`,
  );
  const out: ChangedSinceScored = { count: 0, ids: [], notes: 0, described: 0 };
  for (const g of scopeGroups(sql, scope)) {
    const fp = channelNotesFp(loadChannelNotes(sql, g.section, g.clientId));
    for (const r of stmt.all({ section: g.sectionId, client: g.clientId, kind, fp }) as { id: number; notes: number; described: number }[]) {
      out.ids.push(r.id);
      if (r.notes) out.notes++;
      if (r.described) out.described++;
    }
  }
  out.count = out.ids.length;
  return out;
}

/** "Score again" for every hook `changedSinceScored` lists (the owner's click). Returns how many were queued. */
export function requestChangedRescore(sql: Sql, scope: HookScope, kind: "text" | "video" | null, now = Date.now()): number {
  return requestScore(sql, changedSinceScored(sql, scope, kind).ids, now);
}

// ------------------------------------------------------------------------------------------------ unsure rule (slice 3)

/** Bump when the unsure rule changes: the worker recomputes every stored score's `unsure` once at start. */
export const HOOK_UNSURE_RULE = 2;
const UNSURE_RULE_KEY = "hooks:unsure_rule";

/**
 * Recompute `hook_scores.unsure` from the stored answers (their probabilities) with the current rule and threshold.
 * No Jev calls; idempotent. Runs when `hooks:unsure_rule` is behind HOOK_UNSURE_RULE, or forced: the worker at start
 * (rule bump) and the Settings threshold action (a new classify threshold moves every stored mark). Returns how many
 * rows changed.
 */
export function recomputeHookUnsure(sql: Sql, threshold: number, force = false): number {
  if (!force && getSetting(sql, UNSURE_RULE_KEY) === String(HOOK_UNSURE_RULE)) return 0;
  const rows = sql.prepare("select hook_id, rubric_version, answers, unsure from hook_scores").all() as {
    hook_id: number;
    rubric_version: number;
    answers: string;
    unsure: string;
  }[];
  const upd = sql.prepare("update hook_scores set unsure = ? where hook_id = ? and rubric_version = ?");
  let changed = 0;
  sql.transaction(() => {
    for (const r of rows) {
      let answers: Record<string, StoredAnswer> = {};
      try {
        answers = JSON.parse(r.answers);
      } catch {
        continue;
      }
      const next = JSON.stringify(hookUnsureIds(answers, threshold));
      if (next !== r.unsure) {
        upd.run(next, r.hook_id, r.rubric_version);
        changed++;
      }
    }
    setSetting(sql, UNSURE_RULE_KEY, String(HOOK_UNSURE_RULE));
  })();
  return changed;
}
