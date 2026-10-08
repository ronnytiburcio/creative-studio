/**
 * Read SQL for the Hooks tab and the Rubric page (server only, parameterized). The Hooks tab shows one channel:
 * Lane A, All clients (Lane B: every client's hooks + shared), one Lane B client (its own hooks) or Lane C. Filters live in the URL.
 * Each row carries its linked Meta ads' numbers (src/lib/meta/hooks.ts hookAdStats).
 */
import { clampPage, pageOfIndex, parsePage } from "../paging";
import { ordersByHook, type OrderBadge } from "../meta/orders";
import { getDb } from "../db";
import { clientShortName, searchParam as param, type SearchParamsInput } from "../media";
import type { StoredAnswer } from "../ai/classes";
import { likeEscape } from "../queries";
import { currentRubric, HOOK_VISIBLE, hookScopeSql, LATEST_SCORE, rubricVersions, type HookScope } from "./store";
import { pinnedHookIds } from "./client";
import { activeVariantJobs } from "./variants";
import { videoLines } from "./video";
import { HOOK_METRICS_JOIN, hookAdStats, type HookAdStats } from "../meta/hooks";
import { hookShortStats, type HookShortStats } from "../youtube/store";
import {
  dimensionsFor,
  HOOK_SOURCES,
  HOOKS_PAGE,
  levelOf,
  missingPs,
  PP_CLEAR,
  SCORE_BAND_IDS,
  SCORE_BANDS,
  type HookSource,
  type PpId,
  type RubricVersion,
  type ScoreBand,
  type SectionKey,
} from "./rubric";

export type { HookScope };
/** spend / ctr (Phase 5 slice 2): by the linked ads' summed numbers (hooks on no ad last). */
export type HookSort = "rule" | "score" | "newest" | "style" | "avatar" | "spend" | "ctr";
export const HOOK_SORTS: HookSort[] = ["rule", "score", "newest", "style", "avatar", "spend", "ctr"];

export type HookFilters = {
  view: "text" | "video";
  sort: HookSort;
  style: string | null;
  avatar: string | null;
  source: HookSource | null;
  band: ScoreBand | null;
  /** Only hooks with all three P's clear. */
  pp: boolean;
  /** Plain text filter (`hq`, not `q`: the top bar's search owns `q`). */
  hq: string;
  archived: boolean;
  /** Only hooks with variants waiting for Keep / Discard (`undecided=1`). */
  undecided: boolean;
  /** Highlight + scroll to this row (the drawer's "Hook" link). */
  focus: number | null;
  /**
   * `page` (1-based, HOOKS_PAGE rows a page); null = not in the URL: the page holding `focus`, else page 1. listHooks
   * clamps it to the last page.
   */
  page: number | null;
};

export { HOOKS_PAGE };

type SP = SearchParamsInput;

export function parseHookFilters(sp: SP): HookFilters {
  const sort = param(sp, "sort");
  const source = param(sp, "source");
  const band = param(sp, "band");
  const style = param(sp, "style");
  const avatar = param(sp, "avatar");
  return {
    view: param(sp, "view") === "video" ? "video" : "text",
    sort: HOOK_SORTS.includes(sort as HookSort) ? (sort as HookSort) : "rule",
    style: style && /^[a-z_]{2,40}$/.test(style) ? style : null,
    avatar: avatar && /^[a-z0-9_]{2,60}$/.test(avatar) ? avatar : null,
    source: HOOK_SOURCES.includes(source as HookSource) ? (source as HookSource) : null,
    band: SCORE_BAND_IDS.includes(band as ScoreBand) ? (band as ScoreBand) : null,
    pp: param(sp, "pp") === "1",
    hq: (param(sp, "hq") ?? "").slice(0, 200).trim(),
    archived: param(sp, "archived") === "1",
    undecided: param(sp, "undecided") === "1",
    focus: /^\d{1,9}$/.test(param(sp, "focus") ?? "") ? Number(param(sp, "focus")) : null,
    page: param(sp, "page") == null ? null : parsePage(param(sp, "page")),
  };
}

type Where = { sql: string; params: unknown[] };

/**
 * The channel (section + client) and the kind, top level hooks only (variants arrive in slice 3). A video hook whose
 * file is missing, ignored or in a disabled root is hidden (never deleted).
 */
function scopeWhere(scope: HookScope, kind: "text" | "video"): Where {
  const ch = hookScopeSql(scope);
  return { sql: ["h.kind = ?", "(h.parent_id is null or h.kept = 1)", HOOK_VISIBLE, ch.sql].join(" and "), params: [kind, ...ch.params] };
}

/** The hook has variants waiting for the owner's Keep / Discard (undecided, not archived). */
const HAS_UNDECIDED = `exists (select 1 from hooks uv where uv.parent_id = h.id and uv.kept is null and uv.archived_at is null)`;

const PP_ALL_CLEAR = `(hs.pp_person >= ${PP_CLEAR} and hs.pp_pain >= ${PP_CLEAR} and hs.pp_promise >= ${PP_CLEAR})`;

function filterWhere(f: HookFilters, skip?: keyof HookFilters): Where {
  const parts: string[] = [f.archived ? "h.archived_at is not null" : "h.archived_at is null"];
  const params: unknown[] = [];
  if (f.style && skip !== "style") {
    parts.push("hs.style = ?");
    params.push(f.style);
  }
  if (f.avatar && skip !== "avatar") {
    parts.push("hs.avatar = ?");
    params.push(f.avatar);
  }
  if (f.source && skip !== "source") {
    parts.push("h.source = ?");
    params.push(f.source);
  }
  if (f.band && skip !== "band") {
    if (f.band === "unscored") parts.push("hs.hook_id is null");
    else {
      parts.push("hs.overall >= ? and hs.overall < ?");
      params.push(SCORE_BANDS[f.band].min, SCORE_BANDS[f.band].max);
    }
  }
  if (f.pp && skip !== "pp") parts.push(PP_ALL_CLEAR);
  if (f.undecided && skip !== "undecided") parts.push(HAS_UNDECIDED);
  if (f.hq) {
    for (const term of f.hq.split(/\s+/).filter(Boolean).slice(0, 8)) {
      // Video hooks also match their file name, spoken opening and description (on-screen text lives there).
      parts.push(
        `(h.text like ? escape '\\' or coalesce(h.angle_slug, '') like ? escape '\\' or (h.asset_id is not null and exists (
           select 1 from assets fa where fa.id = h.asset_id and (fa.filename like ? escape '\\' or coalesce(fa.spoken_open, '') like ? escape '\\'
             or coalesce(fa.description, '') like ? escape '\\'))))`,
      );
      const like = `%${likeEscape(term)}%`;
      params.push(like, like, like, like, like);
    }
  }
  return { sql: parts.join(" and "), params };
}

/**
 * Each hook with its LATEST score (the newest rubric version it was scored with): after a new rubric version the old
 * score shows (labelled with its version) until the current version's lands.
 */
const FROM = `from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id
  left join hook_scores hs on hs.hook_id = h.id and ${LATEST_SCORE}
  left join assets a on a.id = h.asset_id`;

const ORDER: Record<HookSort, string> = {
  // Rule B: scored with all three P's clear first (by overall), then scored missing a P (by overall), then unscored.
  rule: `(hs.hook_id is null), (case when ${PP_ALL_CLEAR} then 0 else 1 end), hs.overall desc, h.created_at desc, h.id desc`,
  score: "(hs.overall is null), hs.overall desc, h.created_at desc, h.id desc",
  newest: "h.created_at desc, h.id desc",
  style: "(hs.style is null), hs.style, hs.overall desc, h.id desc",
  avatar: "(hs.avatar is null), hs.avatar, hs.overall desc, h.id desc",
  spend: "(hm.spend is null), hm.spend desc, hs.overall desc, h.id desc",
  ctr: "(coalesce(hm.imp, 0) = 0), (hm.clk * 1.0 / hm.imp) desc, hm.spend desc, h.id desc",
};
/** Sorts that need the linked ads' sums joined (`hm`). */
const METRIC_SORTS: HookSort[] = ["spend", "ctr"];

export type DimView = { id: string; short: string; label: string; level: number | null; confidence: number | null; unsure: boolean };

/** A video hook's file (poster, hover preview, drawer) and the lines its hook came from. */
export type HookVideo = {
  assetId: number;
  filename: string;
  /** Cache-busting version (same as the Library card's `v`). */
  v: string;
  hasThumb: boolean;
  hasSheet: boolean;
  hasProxy: boolean;
  durationS: number | null;
  landscape: boolean;
  /** The whole spoken opening (first 15 s); null = no speech or not checked. */
  spoken: string | null;
  onScreen: string | null;
  /** The description's opening line (what the first 3 seconds show). */
  opening: string | null;
};

export type HookRow = {
  id: number;
  kind: "text" | "video";
  text: string;
  source: HookSource;
  /** Variants: the parent hook, the mechanic claude wrote it on, kept (true) or undecided (null). */
  parentId: number | null;
  variantMechanic: string | null;
  kept: boolean | null;
  /** Top level rows: undecided + kept variants, ranked (sort rule B); undecided = how many wait for Keep / Discard. */
  variants: HookRow[];
  undecided: number;
  /** A "Rewrite variants" job waiting or running for this hook. */
  variantJob: { id: number; status: "pending" | "running" } | null;
  angleSlug: string | null;
  clientCode: string | null;
  clientShort: string | null;
  /** The hook's section (rtm | fkbpros | fkb). */
  section: SectionKey;
  /** Has a What works here to pin to: a client's own hook, or a Lane C hook. */
  pinnable: boolean;
  /** The Meta ads carrying this hook, summed (Phase 5 slice 2); null = on no ad. */
  ads: HookAdStats | null;
  /** Lane A: the YouTube Shorts carrying this hook (through its file), latest lifetime numbers (Phase 5 slice 4); null = none. */
  shorts: HookShortStats | null;
  /** The newest new-PAUSED-ad order whose copy came from this hook (Phase 6 slice 3); null = none. */
  adOrder: OrderBadge | null;
  createdAt: number;
  archived: boolean;
  scoreRequested: boolean;
  scoreError: string | null;
  /** Pinned to its client's "What works here". */
  pinned: boolean;
  video: HookVideo | null;
  score: null | {
    overall: number | null;
    dims: DimView[];
    pp: Record<PpId, number | null>;
    missing: PpId[];
    style: string | null;
    avatar: string | null;
    stopsScroll: number | null;
    /** Question ids that were unsure (dimension ids, pp_*, style, avatar, stops_scroll). */
    unsure: string[];
    scoredAt: number;
    /** The rubric version of this score; stale = older than the current version (a Rescore has not reached it yet). */
    version: number;
    stale: boolean;
  };
};

type Row = {
  id: number;
  text: string;
  source: HookSource;
  angle_slug: string | null;
  code: string | null;
  cname: string | null;
  created_at: number;
  archived_at: number | null;
  score_requested_at: number | null;
  score_error: string | null;
  section: SectionKey;
  kind: "text" | "video";
  parent_id: number | null;
  variant_mechanic: string | null;
  kept: number | null;
  hs_hook: number | null;
  hs_version: number | null;
  answers: string | null;
  unsure: string | null;
  overall: number | null;
  pp_person: number | null;
  pp_pain: number | null;
  pp_promise: number | null;
  style: string | null;
  avatar: string | null;
  stops_scroll: number | null;
  scored_at: number | null;
  asset_id: number | null;
  a_filename: string | null;
  a_sha: string | null;
  a_thumb: string | null;
  a_sheet: string | null;
  a_proxy: string | null;
  a_duration: number | null;
  a_width: number | null;
  a_height: number | null;
  a_description: string | null;
  a_spoken: string | null;
};

function toVideo(r: Row): HookVideo | null {
  if (r.kind !== "video" || r.asset_id == null || r.a_filename == null) return null;
  const lines = videoLines(r.a_description, r.a_spoken);
  return {
    assetId: r.asset_id,
    filename: r.a_filename,
    v: (r.a_sha ?? "").slice(0, 12),
    hasThumb: Boolean(r.a_thumb),
    hasSheet: Boolean(r.a_sheet),
    hasProxy: Boolean(r.a_proxy),
    durationS: r.a_duration,
    landscape: !!r.a_width && !!r.a_height && r.a_width > r.a_height * 1.15,
    spoken: lines.spoken,
    onScreen: lines.onScreen,
    opening: lines.opening,
  };
}

function toRow(r: Row, versions: Map<number, RubricVersion>, current: RubricVersion, pinned: Set<number>): HookRow {
  let score: HookRow["score"] = null;
  if (r.hs_hook != null) {
    const version = r.hs_version ?? current.version;
    const rubric = versions.get(version) ?? current;
    let answers: Record<string, StoredAnswer> = {};
    let unsure: string[] = [];
    try {
      answers = JSON.parse(r.answers ?? "{}");
      unsure = JSON.parse(r.unsure ?? "[]");
    } catch {
      /* keep empty */
    }
    const dims = dimensionsFor(rubric, r.section, r.kind).map((d) => {
      const a = answers[d.id];
      return {
        id: d.id,
        short: d.short,
        label: d.label,
        level: a && typeof a.value === "number" ? levelOf(a.value) : null,
        confidence: a?.confidence ?? null,
        unsure: unsure.includes(d.id),
      };
    });
    const pp = { pp_person: r.pp_person, pp_pain: r.pp_pain, pp_promise: r.pp_promise };
    score = {
      overall: r.overall,
      dims,
      pp,
      missing: missingPs(pp),
      style: r.style,
      avatar: r.avatar,
      stopsScroll: r.stops_scroll,
      unsure,
      scoredAt: r.scored_at ?? 0,
      version,
      stale: version < current.version,
    };
  }
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    source: r.source,
    parentId: r.parent_id,
    variantMechanic: r.variant_mechanic,
    kept: r.kept == null ? null : r.kept === 1,
    variants: [],
    undecided: 0,
    variantJob: null,
    angleSlug: r.angle_slug,
    clientCode: r.code,
    clientShort: r.cname ? clientShortName(r.cname) : null,
    section: r.section,
    pinnable: r.code != null || r.section === "fkb",
    ads: null,
    shorts: null,
    adOrder: null,
    createdAt: r.created_at,
    archived: r.archived_at != null,
    scoreRequested: r.score_requested_at != null,
    scoreError: r.score_error,
    pinned: pinned.has(r.id),
    video: toVideo(r),
    score,
  };
}

const SELECT = `select h.id, h.text, h.source, h.angle_slug, c.code, c.name as cname, h.created_at, h.archived_at, h.score_requested_at,
              h.score_error, s.key as section, h.kind, h.parent_id, h.variant_mechanic, h.kept, hs.hook_id as hs_hook,
              hs.rubric_version as hs_version, hs.answers, hs.unsure, hs.overall, hs.pp_person,
              hs.pp_pain, hs.pp_promise, hs.style, hs.avatar, hs.stops_scroll, hs.scored_at, h.asset_id, a.filename as a_filename,
              a.sha256 as a_sha, a.thumb_path as a_thumb, a.sheet_path as a_sheet, a.proxy_path as a_proxy, a.duration_s as a_duration,
              a.width as a_width, a.height as a_height, a.description as a_description, a.spoken_open as a_spoken`;

export function listHooks(scope: HookScope, f: HookFilters): { rows: HookRow[]; total: number; page: number; rubric: RubricVersion } {
  const sql = getDb().sqlite;
  const rubric = currentRubric(sql);
  const versions = rubricVersions(sql);
  const s = scopeWhere(scope, f.view);
  const w = filterWhere(f);
  const where = `${s.sql} and ${w.sql}`;
  const params = [...s.params, ...w.params];
  const total = sql.prepare(`select count(*) ${FROM} where ${where}`).pluck().get(...params) as number;
  const from = METRIC_SORTS.includes(f.sort) ? `${FROM} ${HOOK_METRICS_JOIN}` : FROM;
  // The page: from the URL, else the one holding the focused hook (a variant's parent row), else the first.
  let want = f.page ?? 1;
  if (f.page == null && f.focus != null) {
    const order = sql.prepare(`select h.id ${from} where ${where} order by ${ORDER[f.sort]}`).pluck().all(...params) as number[];
    const parent = sql.prepare("select parent_id from hooks where id = ?").pluck().get(f.focus) as number | null | undefined;
    const at = order.indexOf(f.focus) >= 0 ? order.indexOf(f.focus) : parent != null ? order.indexOf(parent) : -1;
    if (at >= 0) want = pageOfIndex(at, HOOKS_PAGE);
  }
  const page = clampPage(want, total, HOOKS_PAGE);
  const rows = sql
    .prepare(`${SELECT} ${from} where ${where} order by ${ORDER[f.sort]} limit ? offset ?`)
    .all(...params, HOOKS_PAGE, (page - 1) * HOOKS_PAGE) as Row[];
  const ids = rows.map((r) => r.id);
  // Variants of the rows shown (undecided + kept; discarded ones are archived), ranked by rule B.
  const children = ids.length
    ? (sql
        .prepare(
          `${SELECT} ${FROM} where h.parent_id in (select value from json_each(?)) and h.archived_at is null
            order by ${ORDER.rule}`,
        )
        .all(JSON.stringify(ids)) as Row[])
    : [];
  const pinned = pinnedHookIds(sql, [...ids, ...children.map((c) => c.id)]);
  const jobs = activeVariantJobs(sql, ids);
  const adStats = hookAdStats(sql, [...ids, ...children.map((c) => c.id)]);
  const shortStats = hookShortStats(sql, ids);
  const orders = ordersByHook(sql, [...ids, ...children.map((c) => c.id)]);
  const byParent = new Map<number, HookRow[]>();
  for (const c of children) {
    const row = toRow(c, versions, rubric, pinned);
    row.ads = adStats.get(c.id) ?? null;
    row.adOrder = orders.get(c.id) ?? null;
    byParent.set(c.parent_id!, [...(byParent.get(c.parent_id!) ?? []), row]);
  }
  return {
    rows: rows.map((r) => {
      const row = toRow(r, versions, rubric, pinned);
      row.ads = adStats.get(r.id) ?? null;
      row.shorts = shortStats.get(r.id) ?? null;
      row.adOrder = orders.get(r.id) ?? null;
      row.variants = byParent.get(r.id) ?? [];
      row.undecided = row.variants.filter((v) => v.kept == null).length;
      row.variantJob = jobs.get(r.id) ?? null;
      return row;
    }),
    total,
    page,
    rubric,
  };
}

export type HookFacets = {
  all: number;
  archived: number;
  scored: number;
  styles: Record<string, number>;
  avatars: Record<string, number>;
  sources: Record<string, number>;
  bands: Record<string, number>;
  ppClear: number;
  /** Hooks with variants waiting for Keep / Discard. */
  undecided: number;
  /** The same per view (no other filter), so the Text / Video switch can point at the view that has them. */
  undecidedByView: Record<"text" | "video", number>;
};

/** Counts for the filter menus (each facet ignores its own filter; archived rows only in `archived`). */
export function hookFacets(scope: HookScope, f: HookFilters): HookFacets {
  const sql = getDb().sqlite;
  const s = scopeWhere(scope, f.view);
  const count = (extra: string, skip?: keyof HookFilters, params: unknown[] = []) => {
    const w = filterWhere(f, skip);
    return sql.prepare(`select count(*) ${FROM} where ${s.sql} and ${w.sql} ${extra}`).pluck().get(...s.params, ...w.params, ...params) as number;
  };
  const group = (col: string, skip: keyof HookFilters) => {
    const w = filterWhere(f, skip);
    const rows = sql
      .prepare(`select ${col} as k, count(*) as n ${FROM} where ${s.sql} and ${w.sql} group by ${col}`)
      .all(...s.params, ...w.params) as { k: string | null; n: number }[];
    return Object.fromEntries(rows.filter((r) => r.k != null).map((r) => [r.k as string, r.n]));
  };
  const bandCounts: Record<string, number> = {};
  for (const b of SCORE_BAND_IDS) {
    bandCounts[b] =
      b === "unscored"
        ? count("and hs.hook_id is null", "band")
        : count("and hs.overall >= ? and hs.overall < ?", "band", [SCORE_BANDS[b].min, SCORE_BANDS[b].max]);
  }
  const base = scopeWhere(scope, f.view);
  const plain = (archived: boolean) =>
    sql
      .prepare(`select count(*) ${FROM} where ${base.sql} and h.archived_at is ${archived ? "not " : ""}null`)
      .pluck()
      .get(...base.params) as number;
  return {
    all: plain(false),
    archived: plain(true),
    scored: sql
      .prepare(`select count(*) ${FROM} where ${base.sql} and h.archived_at is null and hs.hook_id is not null
                 and hs.rubric_version = (select version from rubric_versions where current = 1)`)
      .pluck()
      .get(...base.params) as number,
    styles: group("hs.style", "style"),
    avatars: group("hs.avatar", "avatar"),
    sources: group("h.source", "source"),
    bands: bandCounts,
    ppClear: count(`and ${PP_ALL_CLEAR}`, "pp"),
    undecided: count(`and ${HAS_UNDECIDED}`, "undecided"),
    undecidedByView: {
      text: undecidedIn(scope, "text"),
      video: undecidedIn(scope, "video"),
    },
  };
}

/** Live hooks of a view in this channel with variants waiting for Keep / Discard. */
function undecidedIn(scope: HookScope, kind: "text" | "video"): number {
  const s = scopeWhere(scope, kind);
  return getDb()
    .sqlite.prepare(`select count(*) ${FROM} where ${s.sql} and h.archived_at is null and ${HAS_UNDECIDED}`)
    .pluck()
    .get(...s.params) as number;
}
