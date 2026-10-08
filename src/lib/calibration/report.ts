/**
 * Calibration report (Phase 5 slice 3, PHASE-5 F; server only, SQL only: no Jev, no network, nothing auto-acts).
 *
 * Unit = a hook with at least one linked Meta ad (`hook_ads`, any role) and a score. Its results = the SUM over its
 * distinct linked ads' daily `ad_metrics`, all history (shared credit, DECISIONS "Phase 5 slice 2 verify": per-asset
 * `title_asset` / `body_asset` rows are not additive): impressions, clicks, 3 s views of the video ads, spend, leads
 * (GHL leads credited to the ad, tests out; Meta leads for an account on Meta leads = Lane C today).
 *
 * Score side per hook: the chosen rubric version's score (default: each hook's LATEST score, `LATEST_SCORE`), per
 * dimension (level 1 to 5), overall, each of the Three P's (P(yes)) and stops the scroll (P(yes)).
 *
 * Views: Overall (every Lane B client + Lane B shared hooks + Lane C, pooled), each channel (client, Lane B shared, Lane C),
 * and Lane A (slice 4): Lane A hooks linked to YouTube Shorts (a Short -> its matched file -> that file's video hook,
 * src/lib/youtube/sql.ts), results = the linked Shorts' latest lifetime views (summed) and views-weighted average %
 * viewed; Lane A is never pooled into Overall (other metrics). Lane A says "Not yet calibrated" until YouTube is connected
 * and a cell has enough hooks with 300+ views.
 *
 * Every cell also counts the DISTINCT ad groups (sets of linked ads; Lane A: sets of Shorts) behind its hooks and needs
 * the minimum on both (slice 4, the slice 3 verify's caveat: 641 hooks sat on only 169 ad groups).
 */
import type Database from "better-sqlite3";
import { LATEST_SCORE, hooksPath } from "../hooks/sql";
import { levelOf, PP_IDS, PP_LABEL, rubricHasFkb, type Dimension, type RubricVersion } from "../hooks/rubric";
import { currentRubric, rubricVersions } from "../hooks/store";
import { clientShortName, searchParam as param, type SearchParamsInput } from "../media";
import { calibrationMinimums } from "../meta/thresholds";
import { LATEST_YT_METRICS, SHORT_HOOK_JOIN } from "../youtube/sql";
import { laneNames } from "../clients-admin";
import {
  biggestMisses,
  CAL_METRICS,
  RTM_CAL_METRICS,
  SECTION_METRICS,
  sumShortResults,
  type ShortResult,
  calCell,
  countsFor,
  fmtMetric,
  metricValue,
  sumHookResults,
  type AdResult,
  type CalCell,
  type CalibrationMinimums,
  type CalMetric,
  type CalPoint,
  type HookResult,
} from "./stats";

type Sql = Database.Database;

export type CalVersion = "latest" | number;

export type CalParams = { version: CalVersion; view: string; missMetric: CalMetric };

type SP = SearchParamsInput;

const ALL_METRICS: readonly CalMetric[] = [...CAL_METRICS, ...RTM_CAL_METRICS];

/** The metrics a view reads: Lane A's (views, average % viewed) or Meta's (CTR, hook rate, CPL). */
export function metricsFor(view: string): readonly CalMetric[] {
  return view === "rtm" ? RTM_CAL_METRICS : CAL_METRICS;
}

/**
 * URL keys on the Rubric page: `cal_v` (latest | a version number), `cal_view` (overall | a client code | shared | fkb |
 * rtm), `cal_m` (ctr | hook | cpl; views | avg_viewed on the Lane A view).
 */
export function parseCalParams(sp: SP): CalParams {
  const v = param(sp, "cal_v");
  const view = param(sp, "cal_view");
  const m = param(sp, "cal_m");
  const viewKey = view && /^[a-z0-9]{2,32}$/.test(view) ? view : "overall";
  const allowed = metricsFor(viewKey);
  return {
    version: v && /^\d{1,4}$/.test(v) ? Number(v) : "latest",
    view: viewKey,
    missMetric: ALL_METRICS.includes(m as CalMetric) && allowed.includes(m as CalMetric) ? (m as CalMetric) : allowed[0],
  };
}

export type CalItem = { id: string; label: string; group: "overall" | "dimension" | "pp" | "stops"; hint: string };

type HookInfo = {
  id: number;
  text: string;
  kind: "text" | "video";
  section: string;
  code: string | null;
  clientName: string | null;
  archived: boolean;
  version: number | null;
  scores: Record<string, number>;
};

type HookRow = {
  id: number;
  text: string;
  kind: "text" | "video";
  section: string;
  code: string | null;
  client_name: string | null;
  archived_at: number | null;
  rubric_version: number | null;
  answers: string | null;
  overall: number | null;
  pp_person: number | null;
  pp_pain: number | null;
  pp_promise: number | null;
  stops_scroll: number | null;
};

type LinkRow = {
  hook_id: number;
  meta_ad_id: string;
  spend: number | null;
  imp: number | null;
  clk: number | null;
  v3: number | null;
  ml: number | null;
  is_video: number | null;
  leads_source: string | null;
  ghl_synced_at: number | null;
  ghl: number;
};

/** Every hook with a linked ad (Lane B / Lane C) or a linked Short (Lane A): its summed results (shared credit). */
export function hookResults(sql: Sql): Map<number, HookResult> {
  const out = metaHookResults(sql);
  for (const [id, r] of shortHookResults(sql)) out.set(id, r);
  return out;
}

/** Lane A hooks linked to Shorts: summed views + views-weighted average % viewed of the linked Shorts' latest snapshot. */
export function shortHookResults(sql: Sql): Map<number, HookResult> {
  const rows = sql
    .prepare(`select sh.hook_id, sh.video_id, m.views, m.avg_view_pct from ${SHORT_HOOK_JOIN} sh left join ${LATEST_YT_METRICS} m on m.video_id = sh.video_id`)
    .all() as { hook_id: number; video_id: string; views: number | null; avg_view_pct: number | null }[];
  const by = new Map<number, ShortResult[]>();
  for (const r of rows) by.set(r.hook_id, [...(by.get(r.hook_id) ?? []), { id: r.video_id, views: r.views, avgViewPct: r.avg_view_pct }]);
  return new Map([...by].map(([id, list]) => [id, sumShortResults(list)]));
}

/** Lane B / Lane C hooks linked to Meta ads: the ads' summed numbers (shared credit). */
export function metaHookResults(sql: Sql): Map<number, HookResult> {
  const rows = sql
    .prepare(
      `with links as (select distinct hook_id, meta_ad_id from hook_ads),
            agg as (select meta_ad_id, sum(spend) as spend, sum(impressions) as imp, sum(clicks) as clk, sum(video_3s) as v3,
                           sum(meta_leads) as ml, min(account_id) as account_id
                      from ad_metrics where meta_ad_id in (select meta_ad_id from links) group by meta_ad_id),
            ghl as (select ad_id, count(*) as n from ghl_leads where test = 0 and ad_id is not null group by ad_id)
       select l.hook_id, l.meta_ad_id, agg.spend, agg.imp, agg.clk, agg.v3, agg.ml,
              json_extract(ad.creative, '$.isVideo') as is_video, acc.leads_source, acc.ghl_synced_at, coalesce(ghl.n, 0) as ghl
         from links l left join agg on agg.meta_ad_id = l.meta_ad_id left join ads ad on ad.meta_ad_id = l.meta_ad_id
         left join ad_accounts acc on acc.id = coalesce(ad.account_id, agg.account_id)
         left join ghl on ghl.ad_id = l.meta_ad_id`,
    )
    .all() as LinkRow[];
  const byHook = new Map<number, AdResult[]>();
  for (const r of rows) {
    const leads = r.leads_source === "meta" ? (r.ml ?? 0) : r.ghl_synced_at != null ? r.ghl : null;
    const list = byHook.get(r.hook_id) ?? [];
    list.push({ id: r.meta_ad_id, impressions: r.imp ?? 0, clicks: r.clk ?? 0, video3s: r.v3 ?? 0, spend: r.spend ?? 0, leads, isVideo: Boolean(r.is_video) });
    byHook.set(r.hook_id, list);
  }
  return new Map([...byHook].map(([id, ads]) => [id, sumHookResults(ads)]));
}

/** Linked, scored hooks (Lane B + Lane C on Meta ads, Lane A on Shorts) with their scores for the chosen version (latest per hook, or exact). */
function scoredHooks(sql: Sql, version: CalVersion, versions: Map<number, RubricVersion>): HookInfo[] {
  const scoreJoin = version === "latest" ? `join hook_scores hs on hs.hook_id = h.id and ${LATEST_SCORE}` : "join hook_scores hs on hs.hook_id = h.id and hs.rubric_version = @version";
  const rows = sql
    .prepare(
      `select h.id, h.text, h.kind, s.key as section, c.code, c.name as client_name, h.archived_at, hs.rubric_version, hs.answers, hs.overall,
              hs.pp_person, hs.pp_pain, hs.pp_promise, hs.stops_scroll
         from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id ${scoreJoin}
        where (h.parent_id is null or h.kept = 1)
          and ((s.key in ('fkbpros', 'fkb') and exists (select 1 from hook_ads ha where ha.hook_id = h.id))
            or (s.key = 'rtm' and h.id in (select hook_id from ${SHORT_HOOK_JOIN})))`,
    )
    .all(version === "latest" ? {} : { version }) as HookRow[];
  return rows.map((r) => {
    const scores: Record<string, number> = {};
    if (r.overall != null) scores.overall = r.overall;
    for (const id of PP_IDS) if (r[id] != null) scores[id] = r[id] as number;
    if (r.stops_scroll != null) scores.stops_scroll = r.stops_scroll;
    let answers: Record<string, { value?: unknown }> = {};
    try {
      answers = JSON.parse(r.answers ?? "{}");
    } catch {
      /* unreadable answers: dimensions skipped */
    }
    const dims = r.rubric_version != null ? (versions.get(r.rubric_version)?.dimensions ?? []) : [];
    for (const d of dims) {
      const v = answers[d.id]?.value;
      if (typeof v === "number" && Number.isFinite(v)) scores[`dim:${d.id}`] = levelOf(v);
    }
    return {
      id: r.id,
      text: r.text,
      kind: r.kind,
      section: r.section,
      code: r.code,
      clientName: r.client_name,
      archived: r.archived_at != null,
      version: r.rubric_version,
      scores,
    };
  });
}

/**
 * The score rows of the report: overall, the dimensions (that score Lane B or Lane C; Lane A's on the Lane A view), the Three
 * P's, stops the scroll.
 */
export function calItems(dimensions: Dimension[], rtm = false): CalItem[] {
  const dims = dimensions.filter((d) => d.appliesTo.sections.some((s) => (rtm ? s === "rtm" : s === "fkbpros" || s === "fkb")));
  return [
    { id: "overall", label: "Overall", group: "overall", hint: "The mean of the dimension levels (1 to 5)" },
    ...dims.map((d): CalItem => ({
      id: `dim:${d.id}`,
      label: d.label,
      group: "dimension",
      hint: `Level 1 to 5${d.appliesTo.kinds.length === 1 ? ` (${d.appliesTo.kinds[0]} hooks only)` : ""}`,
    })),
    ...PP_IDS.map((id): CalItem => ({ id, label: `${PP_LABEL[id]} clear`, group: "pp", hint: "Jev's P(yes), 0 to 1" })),
    { id: "stops_scroll", label: "Stops the scroll", group: "stops", hint: "Jev's P(yes), 0 to 1" },
  ];
}

export type CalChannel = { key: string; label: string; section: "fkbpros" | "fkb" | "rtm" | "all" };

/** The view keys: overall, each client (sidebar order), Lane B shared (only when it has linked hooks), Lane C, Lane A. */
export function calChannels(sql: Sql, hasShared: boolean): CalChannel[] {
  const clients = sql.prepare("select code, name from clients order by sort, name").all() as { code: string; name: string }[];
  const L = laneNames(sql);
  return [
    { key: "overall", label: `Overall (all ${L.fkbpros} + ${L.fkb})`, section: "all" },
    ...clients.map((c): CalChannel => ({ key: c.code, label: clientShortName(c.name), section: "fkbpros" })),
    ...(hasShared ? [{ key: "shared", label: `${L.fkbpros} shared`, section: "fkbpros" } as CalChannel] : []),
    { key: "fkb", label: L.fkb, section: "fkb" },
    { key: "rtm", label: `${L.rtm} (YouTube Shorts)`, section: "rtm" },
  ];
}

const inView = (h: HookInfo, key: string) =>
  key === "overall" ? h.section !== "rtm" : key === "rtm" ? h.section === "rtm" : key === "fkb" ? h.section === "fkb" : key === "shared" ? h.section === "fkbpros" && h.code == null : h.section === "fkbpros" && h.code === key;

export type CalViewData = {
  key: string;
  label: string;
  /** The metrics of this view (Meta's three, or Lane A's views + average % viewed). */
  metrics: readonly CalMetric[];
  /** "ad groups" (Meta) or "Shorts" (Lane A): the independent unit named in every cell. */
  unit: string;
  /** Linked, scored hooks in the view. */
  linked: number;
  /** Hooks that pass each metric's minimum sample (this view's metrics only). */
  counted: Partial<Record<CalMetric, number>>;
  /** Distinct ad groups behind those hooks, per metric. */
  countedGroups: Partial<Record<CalMetric, number>>;
  /** "Meta leads" when the view's CPL leans on an account that counts Meta leads (Lane C today). */
  metaLeads: boolean;
  rows: { item: CalItem; cells: Partial<Record<CalMetric, CalCell>> }[];
};

export type MissRow = {
  hookId: number;
  text: string;
  channel: string;
  href: string;
  score: number;
  value: number;
  valueText: string;
  ads: number;
  impressions: number;
  leads: number | null;
};

export type CalReport = {
  minimums: CalibrationMinimums;
  params: CalParams;
  /** Selector options: "Latest score per hook" + each version with a score on a linked hook. */
  versionOptions: { value: string; label: string }[];
  /** Versions the selection draws from (latest: every version some hook's latest score used). */
  includedVersions: number[];
  /** One line on how comparable the included versions are. */
  versionNote: string;
  channels: CalChannel[];
  view: CalViewData;
  /** Every Lane B / Lane C channel (Meta metrics) on the overall score; Lane A is `rtm` (its own metrics). */
  byChannel: (CalViewData & { notYet: string | null })[];
  /** Lane A's row: its overall-score cells, and why it is not calibrated yet (null = it is). */
  rtm: { label: string; note: string | null; view: CalViewData; connected: boolean };
  misses: { metric: CalMetric; high: MissRow[]; low: MissRow[] };
};

function viewData(key: string, label: string, hooks: HookInfo[], results: Map<number, HookResult>, items: CalItem[], min: CalibrationMinimums, metaLeadsCodes: Set<string>): CalViewData {
  const mine = hooks.filter((h) => inView(h, key) && results.has(h.id));
  const metrics = metricsFor(key);
  const unit = key === "rtm" ? SECTION_METRICS.rtm.unit : SECTION_METRICS.fkbpros.unit;
  const counted: Partial<Record<CalMetric, number>> = {};
  const countedGroups: Partial<Record<CalMetric, number>> = {};
  for (const m of metrics) {
    const use = mine.filter((h) => countsFor(results.get(h.id)!, m, min));
    counted[m] = use.length;
    countedGroups[m] = new Set(use.map((h) => results.get(h.id)!.groupKey || `hook:${h.id}`)).size;
  }
  const rows = items.map((item) => {
    const points: CalPoint[] = mine.filter((h) => h.scores[item.id] != null).map((h) => ({ hookId: h.id, score: h.scores[item.id], result: results.get(h.id)! }));
    return { item, cells: Object.fromEntries(metrics.map((m) => [m, calCell(points, m, min)])) as Partial<Record<CalMetric, CalCell>> };
  });
  const metaLeads = mine.some((h) => metaLeadsCodes.has(h.section === "fkb" ? "fkb" : (h.code ?? "")));
  return { key, label, metrics, unit, linked: mine.length, counted, countedGroups, metaLeads, rows };
}

/** Are the dimension definitions identical across these versions (question + levels + applies to)? */
function sameDimensions(versions: RubricVersion[]): boolean {
  if (versions.length < 2) return true;
  const sig = (v: RubricVersion) => JSON.stringify(v.dimensions.map((d) => [d.id, d.question, d.levels]));
  return versions.every((v) => sig(v) === sig(versions[0]));
}

/** The whole report for the Rubric page. `youtubeConnected` = Studio's YouTube token exists (Lane A's "not yet" wording). */
export function calibrationReport(sql: Sql, params: CalParams, youtubeConnected = false): CalReport {
  const min = calibrationMinimums(sql);
  const versions = rubricVersions(sql);
  const current = currentRubric(sql);
  const results = hookResults(sql);
  const version: CalVersion = params.version !== "latest" && versions.has(params.version) ? params.version : "latest";
  const hooks = scoredHooks(sql, version, versions);
  const linkedVersions = (
    sql
      .prepare("select distinct hs.rubric_version from hook_scores hs where exists (select 1 from hook_ads ha where ha.hook_id = hs.hook_id) order by 1")
      .pluck()
      .all() as number[]
  ).filter((v) => versions.has(v));
  const includedVersions = [...new Set(hooks.map((h) => h.version).filter((v): v is number => v != null))].sort((a, b) => a - b);
  const included = includedVersions.map((v) => versions.get(v)!).filter(Boolean);
  const L = laneNames(sql);
  // A version that added Lane C (seed step 8): it scores Lane C and the version before it did not.
  const laneCAdded = (v: RubricVersion) => {
    const prev = versions.get(v.version - 1);
    return rubricHasFkb(v) && prev != null && !rubricHasFkb(prev);
  };
  const rubricForItems = version === "latest" ? current : versions.get(version)!;
  const items = calItems(rubricForItems.dimensions);
  const rtmItems = calItems(rubricForItems.dimensions, true);
  const hasShared = hooks.some((h) => h.section === "fkbpros" && h.code == null);
  const channels = calChannels(sql, hasShared);
  const viewKey = channels.some((c) => c.key === params.view) ? params.view : "overall";
  const metaLeadsCodes = new Set(
    (sql.prepare("select coalesce(c.code, 'fkb') from ad_accounts acc left join clients c on c.id = acc.client_id where acc.leads_source = 'meta'").pluck().all() as string[]),
  );

  let versionNote: string;
  if (version !== "latest") versionNote = `Only scores made with rubric v${version}.`;
  else if (!includedVersions.length) versionNote = "No linked hook has a score yet.";
  else {
    const list = includedVersions.map((v) => `v${v}`).join(" and ");
    versionNote =
      includedVersions.length === 1
        ? `Each hook's latest score: all of them on ${list}.`
        : sameDimensions(included)
          ? `Each hook's latest score, from ${list}. Every dimension asks the same question with the same 5 levels in each${
              included.some(laneCAdded) ? ` (${included.filter(laneCAdded).map((v) => `v${v.version}`).join(", ")} = the version before + ${L.fkb})` : ""
            }, so they compare like with like.`
          : `Each hook's latest score, from ${list}. Their dimension wording differs: pick one exact version to compare like with like.`;
  }

  const view = viewData(viewKey, channels.find((c) => c.key === viewKey)!.label, hooks, results, viewKey === "rtm" ? rtmItems : items, min, metaLeadsCodes);
  const overallItem = items.filter((i) => i.id === "overall");
  const byChannel = channels
    .filter((c) => c.key !== "rtm")
    .map((c) => ({ ...viewData(c.key, c.label, hooks, results, overallItem, min, metaLeadsCodes), notYet: null }));
  const rtmView = viewData("rtm", `${L.rtm} (YouTube Shorts)`, hooks, results, overallItem, min, metaLeadsCodes);
  const rtmCells = Object.values(rtmView.rows[0]?.cells ?? {});
  const rtmNote = !youtubeConnected
    ? `Not yet calibrated: connect YouTube in Settings (${L.rtm} calibrates on its Shorts' views and average % viewed).`
    : rtmCells.some((c) => c?.enough)
      ? null
      : `Not yet calibrated: ${rtmView.counted.views ?? 0} of ${min.hooks} hooks have ${min.views.toLocaleString("en-US")}+ views on their Shorts (on ${rtmView.countedGroups.views ?? 0} of ${min.groups} Shorts).`;

  // Biggest misses (overall score) for the view and the chosen metric.
  const mine = hooks.filter((h) => inView(h, viewKey) && results.has(h.id) && h.scores.overall != null);
  const points: CalPoint[] = mine.map((h) => ({ hookId: h.id, score: h.scores.overall, result: results.get(h.id)! }));
  const byId = new Map(mine.map((h) => [h.id, h]));
  const toRow = (m: { hookId: number; score: number; value: number; result: HookResult }): MissRow => {
    const h = byId.get(m.hookId)!;
    const q = [h.kind === "video" ? "view=video" : null, h.archived ? "archived=1" : null, `focus=${h.id}`].filter(Boolean).join("&");
    return {
      hookId: h.id,
      text: h.text,
      channel: h.section === "rtm" ? L.rtm : h.section === "fkb" ? L.fkb : h.code ? clientShortName(h.clientName ?? h.code) : `${L.fkbpros} shared`,
      href: `${hooksPath(h.section, h.code)}?${q}`,
      score: m.score,
      value: m.value,
      valueText: fmtMetric(params.missMetric, metricValue(m.result, params.missMetric)),
      ads: m.result.ads,
      impressions: m.result.impressions,
      leads: m.result.leads,
    };
  };
  const mm = biggestMisses(points, params.missMetric, min);

  return {
    minimums: min,
    params: { ...params, version, view: viewKey },
    versionOptions: [
      { value: "latest", label: "Latest score per hook" },
      ...linkedVersions.map((v) => ({ value: String(v), label: `Rubric v${v} only${v === current.version ? " (current)" : ""}` })),
    ],
    includedVersions,
    versionNote,
    channels,
    view,
    byChannel,
    rtm: { label: L.rtm, note: rtmNote, view: rtmView, connected: youtubeConnected },
    misses: { metric: params.missMetric, high: mm.high.map(toRow), low: mm.low.map(toRow) },
  };
}

/**
 * One line under a Hooks tab's count: whether this channel has enough Meta results for the Calibration report (CTR,
 * the metric with the most data), and where the report is.
 */
export function calibrationLine(sql: Sql, scope: { kind: "rtm" } | { kind: "fkbpros" } | { kind: "client"; code: string } | { kind: "fkb" }): { text: string; href: string } {
  const min = calibrationMinimums(sql);
  if (scope.kind === "rtm") {
    const results = shortHookResults(sql);
    const hooks = scoredHooks(sql, "latest", rubricVersions(sql)).filter((h) => h.section === "rtm");
    const n = hooks.filter((h) => results.has(h.id) && countsFor(results.get(h.id)!, "views", min)).length;
    const href = "/rubric?cal_view=rtm#calibration";
    const linked = hooks.filter((h) => results.has(h.id)).length;
    if (!linked) return { text: "scores are not yet calibrated: no hook is linked to a YouTube Short yet (Shorts tab)", href };
    return n >= min.hooks
      ? { text: `calibration: ${n} hooks here have ${min.views.toLocaleString("en-US")}+ views on their Shorts for the report`, href }
      : { text: `calibration: not enough Shorts results here yet (${n} of ${min.hooks} hooks with ${min.views.toLocaleString("en-US")}+ views)`, href };
  }
  const key = scope.kind === "client" ? scope.code : scope.kind === "fkb" ? "fkb" : "overall";
  const results = hookResults(sql);
  const hooks = scoredHooks(sql, "latest", rubricVersions(sql)).filter((h) => (scope.kind === "fkbpros" ? h.section === "fkbpros" : inView(h, key)));
  const n = hooks.filter((h) => results.has(h.id) && countsFor(results.get(h.id)!, "ctr", min)).length;
  const href = `/rubric?cal_view=${key}#calibration`;
  return n >= min.hooks
    ? { text: `calibration: ${n} hooks here have enough Meta results (${min.impressions.toLocaleString("en-US")}+ impressions) for the report`, href }
    : { text: `calibration: not enough Meta results here yet (${n} of ${min.hooks} hooks with ${min.impressions.toLocaleString("en-US")}+ impressions)`, href };
}
