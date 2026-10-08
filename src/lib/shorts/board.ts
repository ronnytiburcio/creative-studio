/**
 * The Shorts board (Phase 6 B4 / C1 / C3; server only): the cards per column with their moment hook's latest score, the
 * reel file / caption / posted Short (slice 2), and the owner's card edits (Keep / Discard, move to any column, nudge start /
 * end by one sentence (one cue while an episode has no word transcript), the caps hook words, layout) plus Send to Shorts
 * (an explainer idea from any Lane A hook). Nothing here calls claude or Jev: a first line that changes only requests a
 * score (the worker's HookScoreQueue runs it). The automatic moves live in ./outputs.ts.
 */
import type Database from "better-sqlite3";
import { setHookArchived } from "../hooks/store";
import { LATEST_SCORE, latestScoreFor } from "../hooks/sql";
import { missingPs, type PpId } from "../hooks/rubric";
import { LATEST_YT_METRICS } from "../youtube/sql";
import { getSetting, setSetting } from "../ai/state";
import { episodeLabel, episodeUnits, getEpisode, WORDS_CURRENT } from "./episodes";
import { rehookCard } from "./moments";
import { holdKeyFor, statusIndex } from "./outputs";
import { explainerPasteLine, formatLabel, HANDOFF_FORMATS, pasteLine, type HandoffFormat } from "./handoff-text";
import { handoffNames } from "./naming";
import { channelViewMedian, kitShorts, kitTagOf, type KitTag, type ViewMedian } from "./kit";
import { cuesEnd, cuesOfMoment, MOMENT_MAX_S, MOMENT_MIN_S, padCues, type Cue } from "./srt";
import { laneNames } from "../clients-admin";
import {
  checkColdOpen,
  checkHookWords,
  firstLineAt,
  normalizeHookWords,
  overlayRules,
  SHORT_STATUSES,
  type MomentUnit,
  type ShortLayout,
  type ShortStatus,
} from "./rules";

type Sql = Database.Database;

export class ShortEditError extends Error {}

export type ShortCard = {
  id: number;
  episodeId: number | null;
  k: number | null;
  episode: string | null;
  episodeShort: string | null;
  start: number;
  end: number;
  firstLine: string;
  hookWords: string;
  why: string | null;
  layout: ShortLayout;
  status: ShortStatus;
  kept: boolean | null;
  /** The first line's hook (Phase 6; still scored, shown small once the card has a cold open). */
  hookId: number | null;
  hookOwned: boolean;
  /** Phase 7 B2: the MAIN hook = the cold open's hook when there is one, else the first line's. */
  mainHookId: number | null;
  /** The main hook's row on the Lane A Hooks tab. */
  hookHref: string | null;
  /** The MAIN hook's latest score (null until Jev scored it). Rule B and the gate read this. */
  score: null | { overall: number | null; version: number; pp: Record<PpId, number | null>; missing: PpId[] };
  /** The main hook is waiting for a score (requested, or new). */
  scoring: boolean;
  scoreError: string | null;
  /** Phase 7 B1 / B4: the cold open (padded master seconds + its text), or null ("No cold open yet"). */
  cold: null | { start: number; end: number; text: string; hookId: number | null; owned: boolean };
  /** The first line hook's numbers when the main hook is the cold open's (shown small). */
  line: null | { overall: number | null; version: number | null; scoring: boolean; href: string | null };
  /** Make explainer (C1): the episode card this explainer idea came from (its number and start). */
  source: null | { cardId: number; num: number | null; k: number | null; start: number };
  /** Explainer idea cards (C2): the line to paste into a live explainer reel skill session. */
  explainerLine: string | null;
  master: { assetId: number; hasThumb: boolean; v: string } | null;
  /** No episode: a Lane A hook sent to Shorts (an explainer reel idea, made with the explainer reel skill). */
  explainer: boolean;
  /** What the nudge arrows move by (sentences once the episode has a word transcript). */
  nudgeUnit: MomentUnit;
  /** The reel file (slice 2). `visible` = still in the index and shown. */
  output: null | { assetId: number; filename: string; hasThumb: boolean; hasProxy: boolean; v: string; source: "auto" | "manual"; visible: boolean };
  caption: null | { filename: string; preview: string };
  handoff: null | { path: string; filename: string; format: HandoffFormat; formatLabel: string; line: string; at: number };
  /**
   * Gate fix (UI hint only): an episode card in Cutting with no reel file 10+ minutes after it entered Cutting. A reel cut
   * BEFORE a hand move to Cutting never auto-matches (only files written after `cutting_at` count), so the card offers
   * "Reel already made? Link a file".
   */
  linkHint: boolean;
  /** The posted YouTube Short and its latest lifetime numbers. */
  short: null | { videoId: string; title: string | null; views: number | null; avgViewPct: number | null; snapshot: string | null };
  /** Phase 7 D3: the reel file's kit note (Kit vN / Kit vN · test / Before kit); null without a reel file. */
  kit: KitTag | null;
  createdAt: number;
  updatedAt: number;
};

type CardRow = {
  id: number;
  episode_id: number | null;
  k: number | null;
  num: number | null;
  title: string | null;
  start_s: number;
  end_s: number;
  first_line: string;
  hook_words: string;
  why: string | null;
  layout: ShortLayout;
  status: ShortStatus;
  kept: number | null;
  hook_id: number | null;
  hook_owned: number;
  h_requested: number | null;
  h_error: string | null;
  h_archived: number | null;
  overall: number | null;
  version: number | null;
  pp_person: number | null;
  pp_pain: number | null;
  pp_promise: number | null;
  cold_start_s: number | null;
  cold_end_s: number | null;
  cold_text: string | null;
  cold_hook_id: number | null;
  cold_hook_owned: number;
  c_requested: number | null;
  c_error: string | null;
  c_archived: number | null;
  c_overall: number | null;
  c_version: number | null;
  c_pp_person: number | null;
  c_pp_pain: number | null;
  c_pp_promise: number | null;
  source_card_id: number | null;
  src_num: number | null;
  src_k: number | null;
  src_start: number | null;
  handoff_kit_version: number | null;
  kit_version: number | null;
  kit_change: string | null;
  kit_detail: string | null;
  kit_error: string | null;
  kit_row: number | null;
  master_id: number | null;
  thumb_path: string | null;
  sha256: string | null;
  words_ok: number | null;
  out_id: number | null;
  out_filename: string | null;
  out_thumb: string | null;
  out_proxy: string | null;
  out_sha: string | null;
  out_visible: number | null;
  output_source: string | null;
  caption_path: string | null;
  caption_preview: string | null;
  handoff_path: string | null;
  handoff_format: string | null;
  handoff_at: number | null;
  cutting_at: number | null;
  yt_video_id: string | null;
  yt_title: string | null;
  yt_views: number | null;
  yt_avg_pct: number | null;
  yt_snapshot: string | null;
  created_at: number;
  updated_at: number;
};

const CARD_SQL = `
  select sh.id, sh.episode_id, sh.k, e.num, e.title, sh.start_s, sh.end_s, sh.first_line, sh.hook_words, sh.why, sh.layout, sh.status, sh.kept,
         sh.hook_id, sh.hook_owned, h.score_requested_at as h_requested, h.score_error as h_error, h.archived_at as h_archived,
         hs.overall, hs.rubric_version as version, hs.pp_person, hs.pp_pain, hs.pp_promise,
         sh.cold_start_s, sh.cold_end_s, sh.cold_text, sh.cold_hook_id, sh.cold_hook_owned,
         ch.score_requested_at as c_requested, ch.score_error as c_error, ch.archived_at as c_archived,
         chs.overall as c_overall, chs.rubric_version as c_version, chs.pp_person as c_pp_person, chs.pp_pain as c_pp_pain, chs.pp_promise as c_pp_promise,
         sh.source_card_id, se.num as src_num, src.k as src_k, src.start_s as src_start, sh.handoff_kit_version,
         kn.version as kit_version, kn.test_change as kit_change, kn.test_detail as kit_detail, kn.error as kit_error, kn.asset_id as kit_row,
         a.id as master_id, a.thumb_path, a.sha256, ${WORDS_CURRENT} as words_ok,
         o.id as out_id, o.filename as out_filename, o.thumb_path as out_thumb, o.proxy_path as out_proxy, o.sha256 as out_sha,
         (o.missing = 0 and o.ignored = 0) as out_visible, sh.output_source, sh.caption_path, sh.caption_preview,
         sh.handoff_path, sh.handoff_format, sh.handoff_at, sh.cutting_at,
         sh.yt_video_id, v.title as yt_title, m.views as yt_views, m.avg_view_pct as yt_avg_pct, m.snapshot_date as yt_snapshot,
         sh.created_at, sh.updated_at
    from shorts sh
    left join episodes e on e.id = sh.episode_id
    left join assets a on a.id = e.master_asset_id
    left join assets o on o.id = sh.output_asset_id
    left join yt_videos v on v.video_id = sh.yt_video_id
    left join ${LATEST_YT_METRICS} m on m.video_id = sh.yt_video_id
    left join hooks h on h.id = sh.hook_id
    left join hook_scores hs on hs.hook_id = h.id and ${LATEST_SCORE}
    left join hooks ch on ch.id = sh.cold_hook_id
    left join hook_scores chs on chs.hook_id = ch.id and ${latestScoreFor("chs", "ch")}
    left join shorts src on src.id = sh.source_card_id
    left join episodes se on se.id = src.episode_id
    left join reel_kit_notes kn on kn.asset_id = sh.output_asset_id`;

/** How long a Cutting card waits for its reel before the "Reel already made? Link a file" hint shows. */
export const LINK_HINT_MS = 10 * 60_000;

/**
 * Phase 7 B2, the one "main hook" rule: the cold open's hook when the card has a cold open (both times) and that hook
 * exists, else the first line's hook.
 */
export function mainHookOf(r: { cold_start_s: number | null; cold_end_s: number | null; cold_hook_id: number | null; hook_id: number | null }): {
  hookId: number | null;
  cold: boolean;
} {
  const cold = r.cold_start_s != null && r.cold_end_s != null && r.cold_hook_id != null;
  return { hookId: cold ? r.cold_hook_id : r.hook_id, cold };
}

function toCard(r: CardRow, now: number): ShortCard {
  const pp = { pp_person: r.pp_person, pp_pain: r.pp_pain, pp_promise: r.pp_promise };
  const cpp = { pp_person: r.c_pp_person, pp_pain: r.c_pp_pain, pp_promise: r.c_pp_promise };
  const lineScore = r.version != null ? { overall: r.overall, version: r.version, pp, missing: missingPs(pp) } : null;
  const lineScoring = r.hook_id != null && r.h_archived == null && (r.h_requested != null || (r.version == null && r.h_error == null));
  const hasCold = r.cold_start_s != null && r.cold_end_s != null;
  const main = mainHookOf(r);
  const coldMain = main.cold;
  const mainScore = coldMain ? (r.c_version != null ? { overall: r.c_overall, version: r.c_version, pp: cpp, missing: missingPs(cpp) } : null) : lineScore;
  const mainScoring = coldMain ? r.c_archived == null && (r.c_requested != null || (r.c_version == null && r.c_error == null)) : lineScoring;
  const mainHookId = main.hookId;
  const handoffFormat = (HANDOFF_FORMATS as readonly string[]).includes(r.handoff_format ?? "") ? (r.handoff_format as HandoffFormat) : "v2";
  const explainer = r.episode_id == null;
  return {
    id: r.id,
    episodeId: r.episode_id,
    k: r.k,
    episode: r.num != null ? episodeLabel(r.num, r.title ?? "") : null,
    episodeShort: r.num != null ? `Ep${r.num}` : null,
    start: r.start_s,
    end: r.end_s,
    firstLine: r.first_line,
    hookWords: r.hook_words,
    why: r.why,
    layout: r.layout,
    status: r.status,
    kept: r.kept == null ? null : r.kept === 1,
    hookId: r.hook_id,
    hookOwned: r.hook_owned === 1,
    mainHookId,
    hookHref: mainHookId ? `/rtm/hooks?focus=${mainHookId}` : null,
    score: mainScore,
    scoring: mainScoring,
    scoreError: coldMain ? r.c_error : r.h_error,
    cold: hasCold ? { start: r.cold_start_s as number, end: r.cold_end_s as number, text: r.cold_text ?? "", hookId: r.cold_hook_id, owned: r.cold_hook_owned === 1 } : null,
    line: coldMain
      ? { overall: lineScore?.overall ?? null, version: lineScore?.version ?? null, scoring: lineScoring, href: r.hook_id ? `/rtm/hooks?focus=${r.hook_id}` : null }
      : null,
    source: r.source_card_id != null && r.src_start != null ? { cardId: r.source_card_id, num: r.src_num, k: r.src_k, start: r.src_start } : null,
    explainerLine: explainer
      ? explainerPasteLine(r.first_line, r.source_card_id != null && r.src_num != null && r.src_start != null ? { num: r.src_num, start: r.src_start } : null, handoffNames())
      : null,
    master: r.master_id ? { assetId: r.master_id, hasThumb: Boolean(r.thumb_path), v: (r.sha256 ?? "").slice(0, 12) } : null,
    explainer,
    nudgeUnit: r.words_ok ? "sentence" : "cue",
    output:
      r.out_id != null
        ? {
            assetId: r.out_id,
            filename: r.out_filename ?? "",
            hasThumb: Boolean(r.out_thumb),
            hasProxy: Boolean(r.out_proxy),
            v: (r.out_sha ?? "").slice(0, 12),
            source: r.output_source === "manual" ? "manual" : "auto",
            visible: r.out_visible === 1,
          }
        : null,
    caption: r.caption_path ? { filename: r.caption_path.split("/").pop() ?? r.caption_path, preview: r.caption_preview ?? "" } : null,
    handoff:
      r.handoff_path && r.num != null
        ? {
            path: r.handoff_path,
            filename: r.handoff_path.split("/").pop() ?? r.handoff_path,
            format: handoffFormat,
            formatLabel: formatLabel(handoffFormat, r.handoff_kit_version, handoffNames()),
            line: pasteLine(r.num, r.title ?? "", handoffFormat, r.handoff_path, r.handoff_kit_version, handoffNames()),
            at: r.handoff_at ?? 0,
          }
        : null,
    linkHint: r.status === "cutting" && r.out_id == null && r.episode_id != null && r.cutting_at != null && now - r.cutting_at >= LINK_HINT_MS,
    short: r.yt_video_id ? { videoId: r.yt_video_id, title: r.yt_title, views: r.yt_views, avgViewPct: r.yt_avg_pct, snapshot: r.yt_snapshot } : null,
    kit: r.out_id != null ? kitTagOf(r.kit_row != null ? { version: r.kit_version, test_change: r.kit_change, test_detail: r.kit_detail, error: r.kit_error } : null) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Rule B (the Hooks tab's order): all three P's clear first by overall, then scored missing a P, then unscored. */
export function ruleBKey(c: ShortCard): [number, number] {
  if (!c.score || c.score.overall == null) return [2, 0];
  return [c.score.missing.length ? 1 : 0, -c.score.overall];
}

export type Board = {
  columns: Record<ShortStatus, ShortCard[]>;
  undecided: number;
  /** Phase 7 B3: undecided Idea cards whose main hook scored under the gate (behind "Show weaker (N)"). */
  weaker: ShortCard[];
  gate: number;
  /** Phase 7 D3: the channel's median "% viewed" over its Shorts (Posted cards compare against it). */
  channelMedian: ViewMedian;
};

/** The hook gate (Phase 7 B3): undecided Idea cards whose main hook overall is under it sit behind "Show weaker". */
export const SHORTS_GATE_KEY = "shorts:gate";
export const SHORTS_GATE_DEFAULT = 2.6;
export const SHORTS_GATE_MIN = 1;
export const SHORTS_GATE_MAX = 5;

export function shortsGate(sql: Sql): number {
  const v = Number(getSetting(sql, SHORTS_GATE_KEY));
  return Number.isFinite(v) && v >= SHORTS_GATE_MIN && v <= SHORTS_GATE_MAX ? v : SHORTS_GATE_DEFAULT;
}

export function setShortsGate(sql: Sql, value: number) {
  if (!Number.isFinite(value) || value < SHORTS_GATE_MIN || value > SHORTS_GATE_MAX) throw new ShortEditError(`The gate is ${SHORTS_GATE_MIN} to ${SHORTS_GATE_MAX}.`);
  setSetting(sql, SHORTS_GATE_KEY, String(Math.round(value * 100) / 100));
}

/** Weaker = undecided, in Idea, its main hook scored, overall under the gate (unscored and kept cards are never hidden). */
export function isWeaker(c: ShortCard, gate: number): boolean {
  return c.status === "idea" && c.kept == null && c.score != null && c.score.overall != null && c.score.overall < gate;
}

/** Every live card (not discarded / archived), per column. Idea by rule B (weaker ones apart); the rest by last change. */
export function boardData(sql: Sql, now = Date.now()): Board {
  const rows = (sql.prepare(`${CARD_SQL} where sh.archived_at is null order by sh.updated_at desc, sh.id desc`).all() as CardRow[]).map((r) => toCard(r, now));
  const gate = shortsGate(sql);
  const columns = Object.fromEntries(SHORT_STATUSES.map((s) => [s, [] as ShortCard[]])) as Record<ShortStatus, ShortCard[]>;
  const weaker: ShortCard[] = [];
  for (const c of rows) {
    if (isWeaker(c, gate)) weaker.push(c);
    else (columns[c.status] ?? columns.idea).push(c);
  }
  const byRuleB = (a: ShortCard, b: ShortCard) => {
    const ka = ruleBKey(a);
    const kb = ruleBKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || b.createdAt - a.createdAt || a.id - b.id;
  };
  columns.idea.sort(byRuleB);
  weaker.sort(byRuleB);
  return { columns, undecided: rows.filter((c) => c.kept == null).length, weaker, gate, channelMedian: channelViewMedian(kitShorts(sql)) };
}

export function getCard(sql: Sql, id: number, now = Date.now()): ShortCard | null {
  const r = sql.prepare(`${CARD_SQL} where sh.id = ?`).get(id) as CardRow | undefined;
  return r ? toCard(r, now) : null;
}

function liveCard(sql: Sql, id: number) {
  const r = sql.prepare("select * from shorts where id = ?").get(id) as
    | {
        id: number;
        episode_id: number | null;
        start_s: number;
        end_s: number;
        first_line: string;
        hook_id: number | null;
        hook_owned: number;
        cold_start_s: number | null;
        cold_end_s: number | null;
        cold_text: string | null;
        cold_hook_id: number | null;
        cold_hook_owned: number;
        archived_at: number | null;
        kept: number | null;
        status: ShortStatus;
      }
    | undefined;
  if (!r || r.archived_at != null) throw new ShortEditError("That card is gone (discarded).");
  return r;
}

/** Keep: the card stays in its column, marked kept. */
export function keepShort(sql: Sql, id: number, now = Date.now()): boolean {
  return sql.prepare("update shorts set kept = 1, updated_at = ? where id = ? and archived_at is null and kept is null").run(now, id).changes > 0;
}

/** Archive a hook the card created when no other live card uses it, as either hook (never a hook it only linked to). */
function releaseHook(sql: Sql, cardId: number, hookId: number | null, owned: boolean, now: number) {
  if (!hookId || !owned) return;
  const others = sql
    .prepare("select count(*) from shorts where (hook_id = @h or cold_hook_id = @h) and id != @card and archived_at is null")
    .pluck()
    .get({ h: hookId, card: cardId }) as number;
  if (!others) setHookArchived(sql, hookId, true, now);
}

type HookCols = { hook_id: number | null; hook_owned: number; cold_hook_id: number | null; cold_hook_owned: number };

/**
 * After an edit that may move either hook column (a nudged start, a new cold open; Phase 7 gate fix): every hook the
 * card OWNED before (`before`, either column) is settled against the card as it is now. Still used by one of the card's
 * columns = that column owns it (ownership follows the hook, so a cold open that kept the first line's old hook still
 * owns it for Discard); used by neither = archived through releaseHook (only when no other live card uses it). A hook
 * the card only linked to is never touched.
 */
function settleOwnedHooks(sql: Sql, cardId: number, before: HookCols, now: number) {
  const owned = new Set<number>();
  if (before.hook_owned === 1 && before.hook_id != null) owned.add(before.hook_id);
  if (before.cold_hook_owned === 1 && before.cold_hook_id != null) owned.add(before.cold_hook_id);
  if (!owned.size) return;
  const cur = sql.prepare("select hook_id, hook_owned, cold_hook_id, cold_hook_owned from shorts where id = ?").get(cardId) as HookCols;
  for (const h of owned) {
    const inHook = cur.hook_id === h;
    const inCold = cur.cold_hook_id === h;
    if (!inHook && !inCold) {
      releaseHook(sql, cardId, h, true, now);
    } else if (!(inHook && cur.hook_owned === 1) && !(inCold && cur.cold_hook_owned === 1)) {
      sql.prepare(`update shorts set ${inHook ? "hook_owned" : "cold_hook_owned"} = 1 where id = ?`).run(cardId);
    }
  }
}

/**
 * Discard: the card is archived (its number is never reused) with every hook it owns (the first line's and, Phase 7,
 * the cold open's) when that hook was made for it alone.
 */
export function discardShort(sql: Sql, id: number, now = Date.now()): boolean {
  return sql.transaction(() => {
    const r = sql.prepare("select hook_id, hook_owned, cold_hook_id, cold_hook_owned, archived_at from shorts where id = ?").get(id) as
      | { hook_id: number | null; hook_owned: number; cold_hook_id: number | null; cold_hook_owned: number; archived_at: number | null }
      | undefined;
    if (!r || r.archived_at != null) return false;
    sql.prepare("update shorts set kept = 0, archived_at = ?, updated_at = ? where id = ?").run(now, now, id);
    releaseHook(sql, id, r.hook_id, r.hook_owned === 1, now);
    if (r.cold_hook_id !== r.hook_id) releaseHook(sql, id, r.cold_hook_id, r.cold_hook_owned === 1, now);
    return true;
  })();
}

/**
 * Move a card to any column by hand (any direction). Leaving Idea marks an undecided card kept. A backward move leaves a
 * hold (outputs.ts holdKeyFor): the automatic move out of the new column waits for a different trigger than today's.
 */
export function setShortStatus(sql: Sql, id: number, status: ShortStatus, now = Date.now()): boolean {
  const r = liveCard(sql, id);
  if (r.status === status) return false;
  const hold = statusIndex(status) < statusIndex(r.status) ? holdKeyFor(sql, id, status) : null;
  return (
    sql
      .prepare(
        `update shorts set status = ?, kept = case when ? != 'idea' and kept is null then 1 else kept end, hold_key = ?,
           cutting_at = case when ? = 'cutting' then ? else cutting_at end, updated_at = ? where id = ?`,
      )
      .run(status, status, hold, status, now, now, id).changes > 0
  );
}

/**
 * Send to Shorts (Hooks tab, Lane A hooks only): an explainer idea card from the hook (no episode, no number, kept, the
 * hook linked but not owned, its text as the first line). One live card per hook: a second click returns the first.
 * `sourceCardId` (Make explainer, Phase 7 C1) remembers the episode card it came from (also on an existing card that
 * has no source yet).
 */
export function sendHookToShorts(sql: Sql, hookId: number, now = Date.now(), sourceCardId: number | null = null): { cardId: number; created: boolean } {
  return sql.transaction(() => {
    const h = sql
      .prepare("select h.id, h.text, h.archived_at, s.key as section from hooks h join sections s on s.id = h.section_id where h.id = ?")
      .get(hookId) as { id: number; text: string; archived_at: number | null; section: string } | undefined;
    if (!h) throw new ShortEditError("That hook is gone.");
    if (h.section !== "rtm") throw new ShortEditError(`Send to Shorts is for ${laneNames(sql).rtm} hooks.`);
    if (h.archived_at != null) throw new ShortEditError("Restore the hook first.");
    const existing = sql.prepare("select id from shorts where hook_id = ? and episode_id is null and archived_at is null order by id limit 1").pluck().get(hookId) as
      | number
      | undefined;
    if (existing) {
      if (sourceCardId != null) sql.prepare("update shorts set source_card_id = ?, updated_at = ? where id = ? and source_card_id is null").run(sourceCardId, now, existing);
      return { cardId: existing, created: false };
    }
    const text = h.text.replace(/\s+/g, " ").trim().slice(0, 500);
    const info = sql
      .prepare(
        `insert into shorts (episode_id, k, start_s, end_s, first_line, hook_words, why, layout, status, kept, hook_id, hook_owned, source_card_id, created_at, updated_at)
         values (null, null, 0, 0, ?, '', null, 'stack', 'idea', 1, ?, 0, ?, ?, ?)`,
      )
      .run(text, hookId, sourceCardId, now, now);
    return { cardId: Number(info.lastInsertRowid), created: true };
  })();
}

/** Make explainer (Phase 7 C1): Send to Shorts on an episode card's MAIN hook (the cold open's, else the first line's). */
export function makeExplainer(sql: Sql, cardId: number, now = Date.now()): { cardId: number; created: boolean } {
  const r = sql.prepare("select episode_id, hook_id, cold_hook_id, cold_start_s, cold_end_s, archived_at from shorts where id = ?").get(cardId) as
    | {
        episode_id: number | null;
        hook_id: number | null;
        cold_hook_id: number | null;
        cold_start_s: number | null;
        cold_end_s: number | null;
        archived_at: number | null;
      }
    | undefined;
  if (!r || r.archived_at != null) throw new ShortEditError("That card is gone (discarded).");
  if (r.episode_id == null) throw new ShortEditError("This card already is an explainer idea.");
  const main = mainHookOf(r).hookId;
  if (main == null) throw new ShortEditError("This card has no hook to make an explainer from.");
  return sendHookToShorts(sql, main, now, cardId);
}

export type ColdChoice = { i: number; start: number; end: number; text: string };

/**
 * The cold open picker's choices (Phase 7 B4): the moment's units (sentences once the episode has a word transcript,
 * else its SRT cues) with their raw times, and which of them the current cold open covers.
 */
export function coldOpenChoices(sql: Sql, cardId: number): { unit: MomentUnit; units: ColdChoice[]; selected: number[] } {
  const r = liveCard(sql, cardId);
  if (r.episode_id == null) throw new ShortEditError("An explainer idea has no cold open.");
  const ep = getEpisode(sql, r.episode_id);
  if (!ep) throw new ShortEditError("The episode's transcript is not available.");
  const { unit, units } = episodeUnits(ep);
  const at = cuesOfMoment(units, r.start_s, r.end_s);
  if (!at) throw new ShortEditError("The card's times no longer match the transcript.");
  const list = units.slice(at.startCue, at.endCue + 1).map((u: Cue, j) => ({ i: at.startCue + j, start: u.start, end: u.end, text: u.text }));
  const cold = r.cold_start_s != null && r.cold_end_s != null ? { start: r.cold_start_s, end: r.cold_end_s } : null;
  const selected = cold ? list.filter((u) => u.start >= cold.start - 0.01 && u.end <= cold.end + 0.01).map((u) => u.i) : [];
  return { unit, units: list, selected };
}

/**
 * Set or swap the cold open (Phase 7 B4): one or two adjacent units of the moment, given by their raw start / end times
 * and re-checked here with the B1 rules (checkColdOpen). The new line becomes the card's main hook: an equal Lane A hook is
 * linked, the card's own cold open hook takes the new text, or a new `moment` hook is made (requested for scoring).
 */
export function setColdOpen(sql: Sql, cardId: number, pick: { start: number; end: number }, now = Date.now()): { text: string; start: number; end: number } {
  return sql.transaction(() => {
    const r = liveCard(sql, cardId);
    if (r.episode_id == null) throw new ShortEditError("An explainer idea has no cold open.");
    const ep = getEpisode(sql, r.episode_id);
    if (!ep) throw new ShortEditError("The episode's transcript is not available.");
    const { units } = episodeUnits(ep);
    const at = cuesOfMoment(units, r.start_s, r.end_s);
    if (!at) throw new ShortEditError("The card's times no longer match the transcript.");
    const v = checkColdOpen(pick, { units, episodeEnd: Math.max(ep.durationS ?? 0, cuesEnd(units)), moment: at });
    if (!v.ok) throw new ShortEditError(`${v.detail[0].toUpperCase()}${v.detail.slice(1)}.`);
    const link =
      r.cold_text === v.cold.text && r.cold_hook_id != null
        ? { hookId: r.cold_hook_id, owned: r.cold_hook_owned === 1 }
        : rehookCard(sql, cardId, r.cold_hook_id, r.cold_hook_owned === 1, v.cold.text, now, "cold");
    sql
      .prepare("update shorts set cold_start_s = ?, cold_end_s = ?, cold_text = ?, cold_hook_id = ?, cold_hook_owned = ?, updated_at = ? where id = ?")
      .run(v.cold.start, v.cold.end, v.cold.text, link.hookId, link.owned ? 1 : 0, now, cardId);
    settleOwnedHooks(sql, cardId, r, now);
    return { text: v.cold.text, start: v.cold.start, end: v.cold.end };
  })();
}

export function setShortLayout(sql: Sql, id: number, layout: ShortLayout, now = Date.now()): boolean {
  liveCard(sql, id);
  return sql.prepare("update shorts set layout = ?, updated_at = ? where id = ? and layout != ?").run(layout, now, id, layout).changes > 0;
}

/** The caps hook words (2 to 6 words, one optional `*...*` orange block, Lane A's copy rules). Returns the stored text. */
export function setShortHookWords(sql: Sql, id: number, words: string, now = Date.now()): string {
  liveCard(sql, id);
  const clean = normalizeHookWords(words);
  const clients = sql
    .prepare("select c.code, c.name, c.brand_notes as brandNotes from clients c join sections s on s.id = c.section_id where s.key = 'fkbpros'")
    .all() as { code: string; name: string; brandNotes: string | null }[];
  const problem = checkHookWords(clean, overlayRules(clients));
  if (problem) throw new ShortEditError(problem[0].toUpperCase() + problem.slice(1) + ".");
  sql.prepare("update shorts set hook_words = ?, updated_at = ? where id = ?").run(clean, now, id);
  return clean;
}

export type NudgeResult = { start: number; end: number; firstLine: string; hookChanged: boolean; coldCleared: boolean };

/**
 * Move the start or end by one sentence (one cue while the episode has no word transcript; re-snapped + 0.2 s pad,
 * 30 to 90 s again). A new start cue gives a new first line;
 * the card's hook follows it (its own hook's text changes and is requested for scoring; an equal hook elsewhere in Lane A
 * is linked instead; a hook it only linked to is left alone and a new one is made).
 */
export function nudgeShort(sql: Sql, id: number, edge: "start" | "end", dir: -1 | 1, now = Date.now()): NudgeResult {
  return sql.transaction((): NudgeResult => {
    const r = liveCard(sql, id);
    if (r.episode_id == null) throw new ShortEditError("This card has no episode transcript to nudge on.");
    const ep = getEpisode(sql, r.episode_id);
    if (!ep) throw new ShortEditError("The episode's transcript is not available.");
    // Sentences once the word transcript exists (an old card's cue times map to the nearest sentences), else SRT cues.
    const { unit, units } = episodeUnits(ep);
    if (!units.length) throw new ShortEditError("The episode's transcript is not available.");
    const name = unit === "sentence" ? "sentence" : "cue";
    const at = cuesOfMoment(units, r.start_s, r.end_s);
    if (!at) throw new ShortEditError("The card's times no longer match the transcript.");
    let { startCue, endCue } = at;
    if (edge === "start") startCue += dir;
    else endCue += dir;
    if (startCue < 0 || endCue >= units.length) throw new ShortEditError(edge === "start" ? `Already at the episode's first ${name}.` : `Already at the episode's last ${name}.`);
    if (endCue < startCue) throw new ShortEditError("The start would pass the end.");
    const snap = padCues(units, startCue, endCue, Math.max(ep.durationS ?? 0, cuesEnd(units)));
    if (snap.duration < MOMENT_MIN_S || snap.duration > MOMENT_MAX_S) {
      throw new ShortEditError(`That makes it ${Math.round(snap.duration)} s: a moment is ${MOMENT_MIN_S} to ${MOMENT_MAX_S} s.`);
    }
    const firstLine = edge === "start" ? firstLineAt(units, snap.startCue, snap.endCue, unit) : r.first_line;
    let hookChanged = false;
    let hookId = r.hook_id;
    let owned = r.hook_owned === 1;
    if (edge === "start" && firstLine !== r.first_line) {
      hookChanged = true;
      const link = rehookCard(sql, id, hookId, owned, firstLine, now);
      hookId = link.hookId;
      owned = link.owned;
    }
    sql
      .prepare("update shorts set start_s = ?, end_s = ?, first_line = ?, hook_id = ?, hook_owned = ?, updated_at = ? where id = ?")
      .run(snap.start, snap.end, firstLine, hookId, owned ? 1 : 0, now, id);
    // Phase 7: a cold open the new range no longer holds is cleared (its own hook released); the card shows "No cold open yet".
    let coldCleared = false;
    if (r.cold_start_s != null && r.cold_end_s != null && (r.cold_start_s < snap.start - 0.01 || r.cold_end_s > snap.end + 0.01)) {
      sql.prepare("update shorts set cold_start_s = null, cold_end_s = null, cold_text = null, cold_hook_id = null, cold_hook_owned = 0 where id = ?").run(id);
      coldCleared = true;
    }
    // Gate fix: every hook the card owned before (either column; also the first line hook the cold open was linked to)
    // that the card no longer uses is archived when no other live card uses it, or kept owned by the column still using it.
    settleOwnedHooks(sql, id, r, now);
    return { start: snap.start, end: snap.end, firstLine, hookChanged, coldCleared };
  })();
}
