/**
 * Moments (Phase 6 B; server only): the `short_moments` job rows, what `claude -p` is told about an episode (its
 * sentences with times from the word-timed transcript since slice 2, the reel cut skill's step 2 rules), how its answer is
 * read, and how the survivors become Idea cards + Lane A text hooks. The worker runs the jobs (src/worker/shorts.ts);
 * nothing here spawns anything.
 *
 * A job row: type `short_moments`, asset_id null, input {episodeId}, result (MomentJobResult), log_path
 * logs/jobs/short-moments-<id>.log. One active job per episode. Cancel while pending; Retry on error / cancelled. A
 * pending job whose episode has no current word transcript is not claimed: it waits ("Waiting for the word-timed
 * transcript"), it never falls back to the SRT cues.
 */
import { MOMENTS_JOB } from "../jobs";
import { AI_TELLS_TOKEN, fill, profile } from "../profile";
import type Database from "better-sqlite3";
import { normHook } from "../hooks/rubric";
import { AI_TELLS } from "../hooks/variant-rules";
import { channelIds } from "../hooks/store";
import { getEpisode, WORDS_CURRENT, type EpisodeRow } from "./episodes";
import { usedReelNumbers } from "./outputs";
import { cleanSpoken, cuesEnd, endsSentence, fmtClock, MOMENT_MAX_S, MOMENT_MIN_S, MOMENT_TARGET_MAX_S, startsSentence, type Cue } from "./srt";
import {
  COLD_BAD_FIRST_WORDS,
  HOOK_WORDS_MAX,
  HOOK_WORDS_MIN,
  MOMENTS_MAX,
  SHORT_LAYOUTS,
  type CheckedMoment,
  type RawMoment,
} from "./rules";

type Sql = Database.Database;

export { MOMENTS_JOB } from "../jobs";

export type MomentJobInput = { episodeId: number };

export type MomentAttempt = {
  returned: number;
  kept: number;
  dropped: { start: number | null; end: number | null; hook: string; rule: string; detail: string }[];
  /** Phase 7 B1: kept moments whose cold open broke a rule (the card survives without one). */
  coldDropped?: { start: number; end: number; hook: string; coldStart: number | null; coldEnd: number | null; rule: string; detail: string }[];
  ms: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export type MomentJobResult = {
  /** MOMENTS_PROMPT_VERSION the job ran with (absent = 1, Phase 6). */
  promptVersion?: number;
  attempts: MomentAttempt[];
  /** Card ids written by this job. */
  survivors: number[];
  note: string | null;
};

export class MomentsError extends Error {}

/**
 * The moments prompt's version (recorded in each job result). 2 = Phase 7 slice 2: self contained claims and lessons
 * (never demo narration), the first line as an opener, a cold open per moment, hook words 2 to 6 with one `*` block.
 * 3 = the cold open must stand on its own with no context and read like a hook (the viewer's problem, money or result),
 * never a payoff that needs the setup, never opening on a connector or filler (the owner, 2026-10-01).
 * 4 = the cold open length stated once (2 to 5 s, never over 6) and the connector list built from COLD_BAD_FIRST_WORDS;
 * gate fixes 2026-10-02.
 */
export const MOMENTS_PROMPT_VERSION = 4;

/** The cold open's banned first words as the prompt lists them ("So, But, And, ..."), from COLD_BAD_FIRST_WORDS. */
const COLD_BAD_FIRST_LIST = COLD_BAD_FIRST_WORDS.map((w) => w[0].toUpperCase() + w.slice(1)).join(", ");

/** System prompt for the moments run (the profile's `moments.system`; the runner's flags are unchanged: src/lib/hooks/claude.ts). */
export function momentsSystemPrompt(): string {
  return profile().moments.system;
}

// ------------------------------------------------------------------------------------------------ jobs

function activeJobFor(sql: Sql, episodeId: number): number | null {
  return (
    (sql
      .prepare(`select id from jobs where type = '${MOMENTS_JOB}' and status in ('pending','running') and json_extract(input, '$.episodeId') = ? limit 1`)
      .pluck()
      .get(episodeId) as number | undefined) ?? null
  );
}

function liveEpisode(sql: Sql, episodeId: number): boolean {
  return Boolean(
    sql
      .prepare(
        `select 1 from episodes e join assets a on a.id = e.master_asset_id
          where e.id = ? and e.gone_at is null and e.cue_count > 0 and a.missing = 0 and a.ignored = 0`,
      )
      .get(episodeId),
  );
}

/** "New short": queue a moments job for a live, prepped episode. Returns the job id. */
export function queueMoments(sql: Sql, episodeId: number, now = Date.now()): number {
  if (!liveEpisode(sql, episodeId)) throw new MomentsError("That episode is not available (no transcript, or its master is gone).");
  return sql.transaction(() => {
    if (activeJobFor(sql, episodeId)) throw new MomentsError("Moments for this episode are already being written.");
    const input: MomentJobInput = { episodeId };
    const info = sql
      .prepare(`insert into jobs (type, asset_id, input, status, priority, attempts, created_at) values ('${MOMENTS_JOB}', null, ?, 'pending', 0, 0, ?)`)
      .run(JSON.stringify(input), now);
    return Number(info.lastInsertRowid);
  })();
}

/** Cancel a moments job that has not started. True when this call cancelled it. */
export function cancelMomentJob(sql: Sql, jobId: number, now = Date.now()): boolean {
  return (
    sql
      .prepare(`update jobs set status = 'cancelled', error = 'Cancelled', finished_at = ? where id = ? and type = '${MOMENTS_JOB}' and status = 'pending'`)
      .run(now, jobId).changes > 0
  );
}

/** Run a failed or cancelled moments job again (one more claude run). Refused while its episode has an active job. */
export function retryMomentJob(sql: Sql, jobId: number): boolean {
  const row = sql.prepare(`select input from jobs where id = ? and type = '${MOMENTS_JOB}' and status in ('error','cancelled')`).get(jobId) as
    | { input: string }
    | undefined;
  if (!row) return false;
  const episodeId = (JSON.parse(row.input) as MomentJobInput).episodeId;
  if (!liveEpisode(sql, episodeId)) throw new MomentsError("That episode is not available any more.");
  if (activeJobFor(sql, episodeId)) throw new MomentsError("Moments for this episode are already being written.");
  return (
    sql
      .prepare(
        `update jobs set status = 'pending', error = null, result = null, started_at = null, finished_at = null, cancel_requested_at = null
          where id = ? and status in ('error','cancelled')`,
      )
      .run(jobId).changes > 0
  );
}

// ------------------------------------------------------------------------------------------------ context + prompt

export type MomentContext = {
  episode: EpisodeRow;
  /** The word-timed transcript's sentences (what moments snap to). */
  sentences: Cue[];
  /** Master duration, else the last cue's end. */
  episodeEnd: number;
  /** Live cards of this episode (kept or undecided), to avoid. */
  taken: { start: number; end: number; hookWords: string }[];
  allClients: { code: string; name: string; brandNotes: string | null }[];
};

export function momentContext(sql: Sql, episodeId: number): MomentContext {
  const episode = getEpisode(sql, episodeId);
  if (!episode || episode.goneAt != null) throw new MomentsError("The episode is gone.");
  if (!episode.cues.length) throw new MomentsError("The episode's transcript has no cues.");
  if (!episode.sentences?.length) throw new MomentsError("Waiting for the word-timed transcript.");
  const taken = (
    sql
      .prepare("select start_s, end_s, hook_words from shorts where episode_id = ? and archived_at is null order by start_s")
      .all(episodeId) as { start_s: number; end_s: number; hook_words: string }[]
  ).map((r) => ({ start: r.start_s, end: r.end_s, hookWords: r.hook_words }));
  const allClients = sql
    .prepare("select c.code, c.name, c.brand_notes as brandNotes from clients c join sections s on s.id = c.section_id where s.key = 'fkbpros' order by c.sort, c.id")
    .all() as { code: string; name: string; brandNotes: string | null }[];
  return {
    episode,
    sentences: episode.sentences,
    episodeEnd: Math.max(episode.durationS ?? 0, cuesEnd(episode.cues), cuesEnd(episode.sentences)),
    taken,
    allClients,
  };
}

const bullet = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

/** One line per sentence of the word-timed transcript: `#12 [83.4-91.2] text` (fillers out). */
export function sentenceLines(sentences: Cue[]): string[] {
  return sentences.map((c, i) => `#${i + 1} [${c.start.toFixed(1)}-${c.end.toFixed(1)}] ${cleanSpoken(c.text) || c.text}`);
}

/** Slice 1's SRT cue lines: `#12 S [83.4-91.2] text E` (S = may start a moment, E = may end one). Kept for reference. */
export function transcriptLines(ep: EpisodeRow): string[] {
  return ep.cues.map((c, i) => {
    const s = startsSentence(ep.cues, i) ? "S " : "";
    const e = endsSentence(c) ? " E" : "";
    return `#${i + 1} ${s}[${c.start.toFixed(1)}-${c.end.toFixed(1)}] ${c.text}${e}`;
  });
}

/**
 * The one prompt `claude -p` gets: the reel cut skill's step 2 rules in Studio's words, the cards to avoid, the copy rules and
 * the sentence list (one sentence per line with its times). `feedback` (the retry) lists what the first answer broke.
 */
export function buildMomentsPrompt(ctx: MomentContext, feedback: string[] = []): string {
  const ep = ctx.episode;
  const P = profile().moments;
  const out: string[] = [];
  out.push(
    P.task,
    "",
    "## Episode",
    `${ep.label}, ${fmtClock(ctx.episodeEnd)} long. ${P.episodeAbout}`,
    "",
    "## What a good moment is",
    bullet([
      `${MOMENT_MIN_S} to ${MOMENT_TARGET_MAX_S} seconds long (never more than ${MOMENT_MAX_S}).`,
      "A self contained claim or lesson: a mistake and its fix, a rule, a number, a result, a strong opinion. It makes sense to someone who never saw the episode and cannot see the screen.",
      "Never demo narration: lines that walk through clicks and tools (\"So now I'm going to go to Claude.\", \"Let me click here.\", \"Okay, so this is the page.\") are not moments, and a moment never starts on one.",
      "Best picks, in this order: a before and after reveal, a strong opinion or one liner, a quick \"here is the mistake\" teardown.",
      "It starts on a complete sentence that works as an opener on its own, and ends on a payoff, never mid thought.",
      "The start sentence is what a viewer hears first, and it is scored as the moment's hook: start on a sentence that grabs attention by itself (a claim, a number, a mistake, a result), never filler like \"Okay.\", \"Yeah.\" or \"All right, guys.\".",
      "No profanity in the first 3 seconds.",
    ]),
    "",
    "## Times (checked in code; a moment that breaks one is thrown away)",
    bullet([
      "`start` = the start time of a sentence in the list below. Copy the number exactly.",
      "`end` = the end time of a sentence in the list below (the last sentence of the moment). Copy the number exactly.",
      `end minus start between ${MOMENT_MIN_S} and ${MOMENT_MAX_S} seconds (aim for ${MOMENT_TARGET_MAX_S} or less).`,
      "No two moments share half or more of their time with each other or with the moments below.",
      "`cold_start` = the start time and `cold_end` = the end time of one sentence, or of two adjacent sentences, between the moment's start and end; 2 to 5 seconds from cold_start to cold_end (never over 6: a longer one is dropped). A cold open that breaks this is dropped (the moment stays without one).",
    ]),
  );
  if (ctx.taken.length) {
    out.push("", "## Moments already on the board for this episode (do not repeat them)", bullet(ctx.taken.map((t) => `${t.start.toFixed(1)} to ${t.end.toFixed(1)} s: ${t.hookWords}`)));
  }
  out.push(
    "",
    "## For each moment",
    bullet([
      "`first_line`: the first sentence spoken at the start, as in the transcript.",
      "`cold_start` and `cold_end`: the moment's COLD OPEN, played first in the reel under the headline before the moment runs from its start. A viewer hears it FIRST, with no context at all, so it must make complete sense on its own and work as a hook by itself: it names the viewer's problem, their money or a result (\"You paid for this lead and lost it to a text.\", \"We pay 450 for every signed job.\"). A punchy payoff that needs the setup to land (\"You are not special.\", \"That's the whole trick.\") is the WRONG pick. Prefer the line that would score best as a hook on its own. It never starts on a connector or a filler (" + COLD_BAD_FIRST_LIST + "). One or two whole adjacent sentences from the list below. Copy the start time of its first sentence and the end time of its last sentence exactly. It is scored as the reel's main hook. Use the first sentence only when it really is the strongest line.",
      `\`hook\`: the reel's opening headline, on screen from the first frame: ${HOOK_WORDS_MIN} to ${HOOK_WORDS_MAX} words, ALL CAPS, plain words a scroller gets at a glance (like "YOU PAID FOR *THIS LEAD*" or "THE 3 P'S OF *AD COPY*"). Mark the part that goes in the orange block with ONE pair of asterisks (at most one block, usually the last two or three words). Not the same words as the first line.`,
      "`why`: one or two short sentences: why this moment works as a Reel.",
      fill(P.layoutLine, { layouts: SHORT_LAYOUTS.join(", ") }),
    ]),
    "",
    "## Copy rules for hook, first_line, why and the cold open (checked in code)",
    bullet(P.copyRules.map((l) => (l === AI_TELLS_TOKEN ? `None of these phrases: ${AI_TELLS.map((t) => `"${t}"`).join(", ")}.` : l))),
  );
  if (feedback.length) out.push("", "## Your last answer broke these rules (fix them this time)", bullet(feedback));
  out.push(
    "",
    "## Output",
    `Reply with one JSON object only, no prose, no code fences: {"moments":[{"start":0.0,"end":0.0,"cold_start":0.0,"cold_end":0.0,"first_line":"...","hook":"... *...*","why":"...","layout":"stack"}]} with 5 to ${MOMENTS_MAX} moments, best first.`,
    "",
    `## Transcript (${ctx.sentences.length} sentences: #number, [start-end] seconds, text)`,
    ...sentenceLines(ctx.sentences),
  );
  return out.join("\n");
}

/** claude's reply text -> raw moments (code fences and stray prose tolerated). Throws MomentsError when there is no list. */
export function parseMoments(text: string): RawMoment[] {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new MomentsError("claude's answer was not JSON.");
  let body: unknown;
  try {
    body = JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new MomentsError("claude's answer was not valid JSON.");
  }
  const list = (body as { moments?: unknown }).moments;
  if (!Array.isArray(list) || !list.length) throw new MomentsError("claude's answer had no moments list.");
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);
  const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  return list.slice(0, 12).map((m) => {
    const o = (m ?? {}) as Record<string, unknown>;
    return {
      start: num(o.start),
      end: num(o.end),
      firstLine: str(o.first_line),
      hook: str(o.hook),
      why: str(o.why),
      layout: str(o.layout).toLowerCase(),
      coldStart: num(o.cold_start),
      coldEnd: num(o.cold_end),
    };
  });
}

// ------------------------------------------------------------------------------------------------ cards + hooks

export type HookLink = { hookId: number; owned: boolean };

/**
 * The Lane A text hook for a first line: an equal hook already in the Lane A channel (a top level hook or a kept variant,
 * archived included: the same dedupe as every other source) is linked as is; else a new `moment` hook is created and
 * requested for scoring (the HookScoreQueue runs requests even while scoring is paused). `except` = a hook to ignore
 * in the lookup (the card's own when its text changes).
 */
export function hookForLine(sql: Sql, text: string, now = Date.now(), except: number | null = null): HookLink {
  const found = findRtmHook(sql, text, except);
  if (found) {
    askScoreIfNever(sql, found, now);
    return { hookId: found, owned: false };
  }
  return { hookId: createMomentHook(sql, text, now), owned: true };
}

/** An equal Lane A text hook (top level or kept variant, archived included; live ones first), ignoring `except`. */
export function findRtmHook(sql: Sql, text: string, except: number | null = null): number | null {
  const { sectionId } = channelIds(sql, { section: "rtm", clientCode: null });
  return (
    (sql
      .prepare(
        `select id from hooks where section_id = ? and client_id is null and kind = 'text' and (parent_id is null or kept = 1)
            and norm = ? and id is not ? order by archived_at is not null, id limit 1`,
      )
      .pluck()
      .get(sectionId, normHook(text), except) as number | undefined) ?? null
  );
}

/** A live linked hook that was never scored is asked for now (an archived one is left alone). */
function askScoreIfNever(sql: Sql, hookId: number, now: number) {
  sql
    .prepare(
      `update hooks set score_requested_at = ?, score_error = null where id = ? and archived_at is null and score_requested_at is null
          and not exists (select 1 from hook_scores hs where hs.hook_id = hooks.id)`,
    )
    .run(now, hookId);
}

/** A new Lane A `moment` text hook, requested for scoring. */
export function createMomentHook(sql: Sql, text: string, now = Date.now()): number {
  const { sectionId } = channelIds(sql, { section: "rtm", clientCode: null });
  const info = sql
    .prepare(`insert into hooks (section_id, client_id, kind, text, norm, source, score_requested_at, created_at) values (?, null, 'text', ?, ?, 'moment', ?, ?)`)
    .run(sectionId, text, normHook(text), now, now);
  return Number(info.lastInsertRowid);
}

/**
 * The card's hook after its line changed (a nudged start for the first line hook, a new cold open for the cold open hook:
 * `column`): an equal Lane A hook is linked (the card's own hook is archived when nothing else uses it); else the card's own
 * hook (when it has one no other card, and not the card's other hook column, shares) takes the new text and is requested
 * for scoring; else a new `moment` hook is made.
 */
export function rehookCard(
  sql: Sql,
  cardId: number,
  hookId: number | null,
  owned: boolean,
  text: string,
  now = Date.now(),
  column: "hook" | "cold" = "hook",
): HookLink {
  const other = column === "hook" ? "cold_hook_id" : "hook_id";
  const shared =
    hookId != null &&
    (sql
      .prepare(
        `select count(*) from shorts where archived_at is null
            and ((id != @card and (hook_id = @hook or cold_hook_id = @hook)) or (id = @card and ${other} = @hook))`,
      )
      .pluck()
      .get({ card: cardId, hook: hookId }) as number) > 0;
  const own = owned && hookId != null && !shared ? hookId : null;
  const equal = findRtmHook(sql, text, own);
  if (equal != null) {
    if (own != null) sql.prepare("update hooks set archived_at = ?, score_requested_at = null where id = ?").run(now, own);
    askScoreIfNever(sql, equal, now);
    return { hookId: equal, owned: false };
  }
  if (own != null) {
    sql.prepare("update hooks set text = ?, norm = ?, archived_at = null, score_requested_at = ?, score_error = null where id = ?").run(text, normHook(text), now, own);
    return { hookId: own, owned: true };
  }
  return { hookId: createMomentHook(sql, text, now), owned: true };
}

/**
 * Next card number of an episode: one past every number ever used, by a card (discarded cards keep theirs) or by a reel
 * file already in the episode's reel folders (slice 2: Ep5 and Ep6 were cut before Studio, as Reels 1 to 3).
 */
export function nextK(sql: Sql, episodeId: number): number {
  const cards = (sql.prepare("select max(k) from shorts where episode_id = ?").pluck().get(episodeId) as number | null) ?? 0;
  const ep = getEpisode(sql, episodeId);
  const reels = ep ? Math.max(0, ...usedReelNumbers(sql, { num: ep.num, reelDirs: ep.reelDirs })) : 0;
  return Math.max(cards, reels) + 1;
}

/** Insert the surviving moments as undecided Idea cards + their hooks (one transaction). Returns the card ids. */
export function insertCards(sql: Sql, episodeId: number, jobId: number, moments: CheckedMoment[], now = Date.now()): number[] {
  const ins = sql.prepare(
    `insert into shorts (episode_id, k, start_s, end_s, first_line, hook_words, why, layout, status, kept, hook_id, hook_owned,
                         cold_start_s, cold_end_s, cold_text, cold_hook_id, cold_hook_owned, job_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'idea', null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return sql.transaction(() => {
    if (!sql.prepare("select 1 from episodes where id = ? and gone_at is null").get(episodeId)) throw new MomentsError("The episode is gone.");
    let k = nextK(sql, episodeId);
    return moments.map((m) => {
      const h = hookForLine(sql, m.firstLine, now);
      // Phase 7 B2: the cold open line is the card's main hook (linked or made the same way as the first line's).
      const c = m.cold ? hookForLine(sql, m.cold.text, now) : null;
      return Number(
        ins.run(
          episodeId,
          k++,
          m.start,
          m.end,
          m.firstLine,
          m.hookWords,
          m.why || null,
          m.layout,
          h.hookId,
          h.owned ? 1 : 0,
          m.cold?.start ?? null,
          m.cold?.end ?? null,
          m.cold?.text ?? null,
          c?.hookId ?? null,
          c?.owned ? 1 : 0,
          jobId,
          now,
          now,
        ).lastInsertRowid,
      );
    });
  })();
}

// ------------------------------------------------------------------------------------------------ Jobs page + board

export type MomentJobView = {
  id: number;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  episodeId: number;
  episode: string;
  /** Pending and its episode has no current word transcript yet (the worker does not claim it until it has one). */
  waitingWords: boolean;
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

/** Moments jobs: active first, then the most recent. `episodeId` narrows to one episode. */
export function momentJobs(sql: Sql, limit = 30, episodeId: number | null = null): MomentJobView[] {
  const rows = sql
    .prepare(
      `select j.id, j.status, j.error, j.input, j.result, j.created_at, j.started_at, j.finished_at, j.log_path, e.num, e.title,
              coalesce(${WORDS_CURRENT}, 0) as words_ok
         from jobs j left join episodes e on e.id = json_extract(j.input, '$.episodeId') left join assets a on a.id = e.master_asset_id
        where j.type = '${MOMENTS_JOB}' and (? is null or json_extract(j.input, '$.episodeId') = ?)
        order by case j.status when 'running' then 0 when 'pending' then 1 else 2 end, coalesce(j.finished_at, j.created_at) desc
        limit ?`,
    )
    .all(episodeId, episodeId, limit) as {
    id: number;
    status: MomentJobView["status"];
    error: string | null;
    input: string | null;
    result: string | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    log_path: string | null;
    num: number | null;
    title: string | null;
    words_ok: number;
  }[];
  return rows.map((r) => {
    let input: Partial<MomentJobInput> = {};
    let result: Partial<MomentJobResult> = {};
    try {
      input = JSON.parse(r.input ?? "{}");
      result = JSON.parse(r.result ?? "{}") ?? {};
    } catch {
      /* keep empty */
    }
    return {
      id: r.id,
      status: r.status,
      episodeId: input.episodeId ?? 0,
      episode: r.num != null ? `Ep${r.num} · ${r.title}` : "(episode gone)",
      waitingWords: r.status === "pending" && !r.words_ok,
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

export type ShortsActivity = {
  active: number;
  lastFinishedAt: number | null;
  /** Last change to any card (the worker's automatic moves included). */
  boardAt: number | null;
  /** Last word transcript start / finish (the New short picker's states). */
  wordsAt: number | null;
};

/** Status line numbers: the board refreshes when any of them changes. */
export function momentsActivity(sql: Sql): ShortsActivity {
  const r = sql
    .prepare(
      `select sum(case when status in ('pending','running') then 1 else 0 end) as active, max(finished_at) as last
         from jobs where type = '${MOMENTS_JOB}'`,
    )
    .get() as { active: number | null; last: number | null };
  const boardAt = sql.prepare("select max(updated_at) from shorts").pluck().get() as number | null;
  const wordsAt = sql.prepare("select max(coalesce(words_running_at, words_at)) from episodes").pluck().get() as number | null;
  return { active: r.active ?? 0, lastFinishedAt: r.last ?? null, boardAt: boardAt ?? null, wordsAt: wordsAt ?? null };
}
