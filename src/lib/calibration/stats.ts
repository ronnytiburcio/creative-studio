/**
 * Calibration math (Phase 5 slices 3 + 4, PHASE-5 F / I3; client safe: no imports). Pure functions shared by the report
 * (src/lib/calibration/report.ts), the Rubric page and the smoke test.
 *
 * - A hook's results = the SUM over its linked ads (shared credit: an ad counts in full for every hook it carries),
 *   all history: impressions, clicks (Meta's all clicks, the Running tab's CTR), 3 second views, spend, leads.
 *   CTR = clicks / impressions, hook rate = 3 s views / impressions of the VIDEO ads only, CPL = spend / leads, all
 *   from the sums (never an average of ratios). Lane A (slice 4): the SUM of its linked Shorts' views and their
 *   views-weighted average % viewed.
 * - Minimum sample: a hook counts for CTR when its ads had >= 1,000 impressions (hook rate: >= 1,000 video
 *   impressions), for CPL when they had >= 3 leads, for views / average % viewed when its Shorts had >= 300 views; a
 *   cell needs >= 8 counted hooks AND >= 8 distinct ad groups (all editable in Settings).
 * - Ad groups (slice 4, the slice 3 verify's caveat): hooks carried by the same ads share identical results, so the
 *   independent sample is the number of DISTINCT sets of linked ads (Lane A: distinct sets of Shorts) behind the counted
 *   hooks, not the number of hooks. Every cell shows both; with fewer than ~30 groups a rho between -0.2 and +0.2 is
 *   mostly noise (the cell is muted).
 * - Statistic: Spearman rank correlation (average ranks for ties). CPL is "lower is better", so its correlation is
 *   computed against the NEGATED CPL: + always means "higher score, better result" on every metric.
 */

export const CAL_METRICS = ["ctr", "hook", "cpl"] as const;
/** Lane A's metrics (YouTube Shorts, slice 4). */
export const RTM_CAL_METRICS = ["views", "avg_viewed"] as const;
export type MetaCalMetric = (typeof CAL_METRICS)[number];
export type CalMetric = MetaCalMetric | (typeof RTM_CAL_METRICS)[number];
export const CAL_METRIC_LABEL: Record<CalMetric, string> = { ctr: "CTR", hook: "Hook rate", cpl: "CPL", views: "Views", avg_viewed: "Avg % viewed" };
/** What "better" means per metric (the legend / tooltips). */
export const CAL_METRIC_BETTER: Record<CalMetric, string> = {
  ctr: "higher CTR",
  hook: "higher hook rate",
  cpl: "lower CPL",
  views: "more views",
  avg_viewed: "a higher average % viewed",
};

/** Muted cells: |rho| under this with fewer than NOISE_GROUPS groups is mostly noise. */
export const NOISE_RHO = 0.2;
export const NOISE_GROUPS = 30;

/** A section's metric set (Lane A calibrates on YouTube Shorts, slice 4) and the name of its independent unit. */
export const SECTION_METRICS = {
  fkbpros: { metrics: CAL_METRICS, unit: "ad groups" },
  fkb: { metrics: CAL_METRICS, unit: "ad groups" },
  rtm: { metrics: RTM_CAL_METRICS, unit: "Shorts" },
} as const;

export type CalibrationMinimums = {
  /** A hook counts for CTR / hook rate when its linked ads had at least this many impressions. */
  impressions: number;
  /** A hook counts for CPL when its linked ads had at least this many leads. */
  leads: number;
  /** A cell needs at least this many counted hooks. */
  hooks: number;
  /** ... on at least this many distinct ad groups (distinct sets of linked ads / Shorts). */
  groups: number;
  /** Lane A: a hook counts for views / average % viewed when its Shorts had at least this many views. */
  views: number;
};
export const DEFAULT_CAL_MINIMUMS: CalibrationMinimums = { impressions: 1000, leads: 3, hooks: 8, groups: 8, views: 300 };

/** One linked ad's all-time numbers (the input of a hook's sums). */
export type AdResult = {
  /** The Meta ad id (the hook's ad group = the sorted set of these). */
  id?: string;
  impressions: number;
  clicks: number;
  video3s: number;
  spend: number;
  /** Leads credited to the ad (GHL, or Meta leads for an account on Meta leads); null = not known (never pulled). */
  leads: number | null;
  isVideo: boolean;
};

export type HookResult = {
  ads: number;
  impressions: number;
  clicks: number;
  /** Impressions of the linked video ads only (hook rate's denominator and its minimum sample). */
  videoImpressions: number;
  video3s: number;
  spend: number;
  /** null when no linked ad's leads are known. */
  leads: number | null;
  hasVideo: boolean;
  ctr: number | null;
  hookRate: number | null;
  cpl: number | null;
  /** The distinct set of linked ads / Shorts (sorted ids joined); "" = unknown (the hook is its own group). */
  groupKey: string;
  /** Lane A (Shorts): summed views and the views-weighted average % viewed; null for Meta hooks. */
  views: number | null;
  avgViewed: number | null;
};

/** Sum a hook's linked ads (each ad once). Ratios from the sums; null on a zero denominator. */
export function sumHookResults(ads: AdResult[]): HookResult {
  let impressions = 0,
    clicks = 0,
    videoImpressions = 0,
    video3s = 0,
    spend = 0,
    leads = 0,
    known = false,
    hasVideo = false;
  for (const a of ads) {
    impressions += a.impressions;
    clicks += a.clicks;
    spend += a.spend;
    if (a.isVideo) {
      hasVideo = true;
      videoImpressions += a.impressions;
      video3s += a.video3s;
    }
    if (a.leads != null) {
      known = true;
      leads += a.leads;
    }
  }
  return {
    ads: ads.length,
    impressions,
    clicks,
    videoImpressions,
    video3s,
    spend,
    leads: known ? leads : null,
    hasVideo,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    hookRate: videoImpressions > 0 ? (video3s / videoImpressions) * 100 : null,
    cpl: known && leads > 0 ? spend / leads : null,
    groupKey: groupKeyOf(ads.map((a) => a.id)),
    views: null,
    avgViewed: null,
  };
}

/** The ad group key: sorted distinct ids ("" when any id is missing). */
export function groupKeyOf(ids: (string | undefined)[]): string {
  if (!ids.length || ids.some((x) => !x)) return "";
  return [...new Set(ids as string[])].sort().join(",");
}

/** One linked Short's latest lifetime numbers. */
export type ShortResult = { id: string; views: number | null; avgViewPct: number | null };

/** Sum a Lane A hook's linked Shorts: views, views-weighted average % viewed (null when no Short has views). */
export function sumShortResults(shorts: ShortResult[]): HookResult {
  let views = 0,
    weighted = 0,
    weight = 0,
    known = false;
  for (const x of shorts) {
    if (x.views != null) {
      known = true;
      views += x.views;
    }
    if (x.avgViewPct != null && (x.views ?? 0) > 0) {
      weighted += x.avgViewPct * (x.views ?? 0);
      weight += x.views ?? 0;
    }
  }
  return {
    ads: shorts.length,
    impressions: 0,
    clicks: 0,
    videoImpressions: 0,
    video3s: 0,
    spend: 0,
    leads: null,
    hasVideo: true,
    ctr: null,
    hookRate: null,
    cpl: null,
    groupKey: groupKeyOf(shorts.map((x) => x.id)),
    views: known ? views : null,
    avgViewed: weight > 0 ? weighted / weight : null,
  };
}

/** Does this hook count for the metric (minimum sample)? */
export function countsFor(r: HookResult, metric: CalMetric, min: CalibrationMinimums): boolean {
  if (metric === "ctr") return r.impressions >= min.impressions && r.ctr != null;
  if (metric === "hook") return r.hasVideo && r.videoImpressions >= min.impressions && r.hookRate != null;
  if (metric === "cpl") return r.leads != null && r.leads >= min.leads && r.cpl != null;
  if (metric === "views") return r.views != null && r.views >= min.views;
  return r.views != null && r.views >= min.views && r.avgViewed != null;
}

/** The metric's value (CTR %, hook rate %, CPL $, views, average % viewed). */
export function metricValue(r: HookResult, metric: CalMetric): number | null {
  switch (metric) {
    case "ctr":
      return r.ctr;
    case "hook":
      return r.hookRate;
    case "cpl":
      return r.cpl;
    case "views":
      return r.views;
    default:
      return r.avgViewed;
  }
}

/** The metric oriented so that higher = better (CPL negated). */
export function goodness(r: HookResult, metric: CalMetric): number | null {
  const v = metricValue(r, metric);
  return v == null ? null : metric === "cpl" ? -v : v;
}

/** 1-based ranks, ties get the average of the ranks they span. */
export function ranks(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avg = (k + j) / 2 + 1;
    for (let t = k; t <= j; t++) out[idx[t].i] = avg;
    k = j + 1;
  }
  return out;
}

/** Pearson correlation; null when n < 2 or either side has no spread. */
export function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, r));
}

/** Spearman rank correlation = Pearson on the (tie-averaged) ranks; null when n < 2 or a side is all ties. */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  return pearson(ranks(x), ranks(y));
}

export type CalPoint = { hookId: number; score: number; result: HookResult };

export type CalCell = {
  /** Counted hooks with this score (n of the correlation). */
  n: number;
  /** Distinct ad groups (sets of linked ads / Shorts) behind the counted hooks: the independent sample. */
  groups: number;
  /** Spearman rho (+ = higher score, better result); null when not enough hooks / groups or no spread. */
  rho: number | null;
  enough: boolean;
  /** Minimum hooks. */
  need: number;
  /** Minimum ad groups. */
  needGroups: number;
};

/** Distinct groups among these points (a point without a group key is its own group). */
export function distinctGroups(points: CalPoint[]): number {
  return new Set(points.map((p) => p.result.groupKey || `hook:${p.hookId}`)).size;
}

/** One cell: the counted hooks' scores vs their results for one metric; needs the hook AND the group minimum. */
export function calCell(points: CalPoint[], metric: CalMetric, min: CalibrationMinimums): CalCell {
  const use = points.filter((p) => Number.isFinite(p.score) && countsFor(p.result, metric, min));
  const groups = distinctGroups(use);
  const enough = use.length >= min.hooks && groups >= min.groups;
  const rho = enough ? spearman(use.map((p) => p.score), use.map((p) => goodness(p.result, metric) as number)) : null;
  return { n: use.length, groups, rho, enough, need: min.hooks, needGroups: min.groups };
}

/**
 * Plain-language cell text: "+0.14 · 336 hooks on 104 ad groups", "No spread · 9 hooks on 9 ad groups",
 * "Not enough data yet (5 of 8)" (hooks short) or "Not enough data yet (12 hooks on 5 of 8 ad groups)" (groups short).
 */
export function cellText(c: CalCell, unit = "ad groups"): string {
  if (c.n < c.need) return `Not enough data yet (${c.n} of ${c.need})`;
  if (!c.enough) return `Not enough data yet (${c.n} hooks on ${c.groups} of ${c.needGroups} ${unit})`;
  if (c.rho == null) return `No spread · ${c.n} hooks on ${c.groups} ${unit}`;
  return `${fmtRho(c.rho)} · ${c.n} hooks on ${c.groups} ${unit}`;
}

/** A cell that is mostly noise: |rho| under 0.2 with fewer than 30 groups. */
export function isNoise(c: CalCell): boolean {
  return c.enough && c.rho != null && Math.abs(c.rho) < NOISE_RHO && c.groups < NOISE_GROUPS;
}

export function fmtRho(r: number): string {
  const v = Math.round(r * 100) / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
}

/** Strength words for a rho (the cell colour and its tooltip). */
export function strengthOf(rho: number | null): "none" | "weak" | "moderate" | "strong" {
  if (rho == null) return "none";
  const a = Math.abs(rho);
  return a >= 0.5 ? "strong" : a >= 0.3 ? "moderate" : a >= 0.1 ? "weak" : "none";
}

export type Miss = { hookId: number; score: number; value: number; gap: number; result: HookResult };

/**
 * Biggest misses among the counted hooks for one metric: each hook's score rank and result rank (0 = worst, 1 = best,
 * ties averaged); "high" = the hooks whose score rank is furthest ABOVE their result rank (a high score, a poor result),
 * "low" = furthest BELOW (a low score, a strong result). Only positive gaps, biggest first, k each.
 */
export function biggestMisses(points: CalPoint[], metric: CalMetric, min: CalibrationMinimums, k = 5): { high: Miss[]; low: Miss[] } {
  const use = points.filter((p) => Number.isFinite(p.score) && countsFor(p.result, metric, min));
  if (use.length < 2) return { high: [], low: [] };
  const n = use.length;
  const sr = ranks(use.map((p) => p.score));
  const rr = ranks(use.map((p) => goodness(p.result, metric) as number));
  const pct = (r: number) => (r - 1) / (n - 1);
  const rows = use.map((p, i) => ({
    hookId: p.hookId,
    score: p.score,
    value: metricValue(p.result, metric) as number,
    gap: pct(sr[i]) - pct(rr[i]),
    result: p.result,
  }));
  const high = rows
    .filter((r) => r.gap > 0)
    .sort((a, b) => b.gap - a.gap || b.score - a.score || a.hookId - b.hookId)
    .slice(0, k);
  const low = rows
    .filter((r) => r.gap < 0)
    .sort((a, b) => a.gap - b.gap || a.score - b.score || a.hookId - b.hookId)
    .slice(0, k)
    .map((r) => ({ ...r, gap: -r.gap }));
  return { high, low };
}

/** A metric value for a cell / miss row: "1.84%", "22.1%", "$141", "12,400", "63.5%". */
export function fmtMetric(metric: CalMetric, v: number | null): string {
  if (v == null) return "–";
  if (metric === "cpl") return `$${Math.round(v).toLocaleString("en-US")}`;
  if (metric === "views") return Math.round(v).toLocaleString("en-US");
  return `${v.toFixed(metric === "ctr" ? 2 : 1)}%`;
}
