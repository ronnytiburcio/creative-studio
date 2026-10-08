/**
 * Lifetime Shorts numbers from the YouTube Analytics API (worker only, Phase 5 slice 4, PHASE-5 I2).
 *
 * One report per batch of Shorts: `ids=channel==MINE`, `dimensions=video`, `filters=video==<id,id,...>` (the API takes
 * a comma list for the video filter), `sort=-views`, `maxResults` = the batch size (<= 200; batches of 50), from the
 * channel's start (or the oldest Short's publish day) to yesterday (Pacific time, YouTube's reporting day).
 *
 * Defensive by design (the real channel is only read after the owner connects):
 *  - Metrics asked: views, averageViewPercentage, averageViewDuration, likes, subscribersGained (core) + engagedViews,
 *    shares, comments (optional). A 400 that names a metric drops that metric and asks again; a 400 that names none
 *    retries with the core metrics only, then probes each optional metric alone once. Refused metrics are remembered
 *    (app_settings `youtube:metrics_failed`) and stay null on the rows; `youtube:metrics_ok` keeps the working list.
 *  - If the batched video report itself is refused, it falls back to one small report per Short (no dimension,
 *    `filters=video==<id>`) and remembers that (`youtube:analytics_mode` = single).
 *  - "Viewed vs swiped away" (YouTube Studio's Shorts feed metric) is NOT in the public Analytics API's metric list
 *    (checked 2026-09-30: no Shorts-specific, swipe or "stayed to watch" metric exists); engagedViews is the closest.
 */
import type { YouTubeApi } from "./api";
import { YouTubeApiError } from "./api";

export const CORE_METRICS = ["views", "averageViewPercentage", "averageViewDuration", "likes", "subscribersGained"] as const;
export const OPTIONAL_METRICS = ["engagedViews", "shares", "comments"] as const;
export const ALL_METRICS = [...CORE_METRICS, ...OPTIONAL_METRICS] as const;
export type YtMetric = (typeof ALL_METRICS)[number];

export const BATCH = 50;

export type ShortNumbers = Partial<Record<YtMetric, number>>;

export type AnalyticsResult = {
  rows: Map<string, ShortNumbers>;
  /** The metrics every row was asked for. */
  metrics: YtMetric[];
  /** Metrics the API refused this run (null on the rows). */
  failed: YtMetric[];
  mode: "batch" | "single";
};

type Report = { columnHeaders?: { name?: string }[]; rows?: unknown[][] };

const namedMetric = (msg: string, list: YtMetric[]): YtMetric | null => list.find((m) => msg.includes(m)) ?? null;
const isQueryError = (e: unknown) => e instanceof YouTubeApiError && e.status === 400;

function toNumbers(headers: string[], row: unknown[]): { id: string | null; nums: ShortNumbers } {
  const nums: ShortNumbers = {};
  let id: string | null = null;
  headers.forEach((h, i) => {
    if (h === "video") id = typeof row[i] === "string" ? (row[i] as string) : null;
    else if ((ALL_METRICS as readonly string[]).includes(h) && typeof row[i] === "number" && Number.isFinite(row[i])) nums[h as YtMetric] = row[i] as number;
  });
  return { id, nums };
}

async function report(api: YouTubeApi, ids: string[], metrics: YtMetric[], mode: "batch" | "single", startDate: string, endDate: string): Promise<Map<string, ShortNumbers>> {
  const out = new Map<string, ShortNumbers>();
  if (mode === "batch") {
    const b = await api.get<Report>("analytics", "reports", {
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: metrics.join(","),
      dimensions: "video",
      filters: `video==${ids.join(",")}`,
      sort: `-${metrics.includes("views") ? "views" : metrics[0]}`,
      maxResults: Math.min(200, Math.max(1, ids.length)),
    });
    const headers = (b.columnHeaders ?? []).map((h) => h.name ?? "");
    for (const r of b.rows ?? []) {
      const { id, nums } = toNumbers(headers, r);
      if (id) out.set(id, nums);
    }
  } else {
    for (const id of ids) {
      const b = await api.get<Report>("analytics", "reports", { ids: "channel==MINE", startDate, endDate, metrics: metrics.join(","), filters: `video==${id}` });
      const headers = (b.columnHeaders ?? []).map((h) => h.name ?? "");
      const r = b.rows?.[0];
      out.set(id, r ? toNumbers(headers, r).nums : {});
    }
  }
  // A Short with no row had no views in the range: zeros for the asked metrics, not unknown.
  for (const id of ids) if (!out.has(id)) out.set(id, Object.fromEntries(metrics.map((m) => [m, 0])) as ShortNumbers);
  return out;
}

/**
 * Lifetime numbers for these Shorts. `known` = the remembered metric list / mode from earlier runs (so a refused metric
 * is not asked every day). Throws only on non-query errors (auth, quota, network) or when even the core query fails.
 */
export async function shortsAnalytics(
  api: YouTubeApi,
  ids: string[],
  range: { startDate: string; endDate: string },
  known: { metrics?: YtMetric[] | null; mode?: "batch" | "single" | null } = {},
): Promise<AnalyticsResult> {
  let metrics: YtMetric[] = known.metrics?.length ? [...known.metrics] : [...ALL_METRICS];
  let mode: "batch" | "single" = known.mode ?? "batch";
  const failed = new Set<YtMetric>();
  const rows = new Map<string, ShortNumbers>();
  if (!ids.length) return { rows, metrics, failed: [], mode };

  /** Settle the metric list and the mode on the first batch. */
  const first = ids.slice(0, BATCH);
  let firstRows: Map<string, ShortNumbers> | null = null;
  for (let tries = 0; tries < ALL_METRICS.length + 3 && !firstRows; tries++) {
    try {
      firstRows = await report(api, first, metrics, mode, range.startDate, range.endDate);
    } catch (e) {
      if (!isQueryError(e)) throw e;
      const msg = (e as YouTubeApiError).detail ?? "";
      const named = namedMetric(msg, metrics);
      if (named && !(CORE_METRICS as readonly string[]).includes(named)) {
        metrics = metrics.filter((m) => m !== named);
        failed.add(named);
        continue;
      }
      const optional = metrics.filter((m) => (OPTIONAL_METRICS as readonly string[]).includes(m));
      if (optional.length) {
        // Unnamed refusal: the core metrics alone, then each optional metric probed once below.
        optional.forEach((m) => failed.add(m));
        metrics = metrics.filter((m) => !optional.includes(m));
        continue;
      }
      if (named) {
        // A core metric refused by name: drop it too (its column stays empty).
        metrics = metrics.filter((m) => m !== named);
        failed.add(named);
        if (metrics.length) continue;
      }
      if (mode === "batch") {
        mode = "single";
        continue;
      }
      throw e;
    }
  }
  if (!firstRows) throw new YouTubeApiError("YouTube Analytics refused every query shape.", 400);

  // Probe optional metrics that were dropped without being named (one small query each).
  for (const m of [...failed].filter((x) => (OPTIONAL_METRICS as readonly string[]).includes(x))) {
    try {
      const probe = await report(api, first.slice(0, 1), ["views", m], mode, range.startDate, range.endDate);
      if (probe) {
        failed.delete(m);
        metrics.push(m);
        const again = await report(api, first, ["views", m], mode, range.startDate, range.endDate);
        for (const [id, n] of again) firstRows.set(id, { ...firstRows.get(id), [m]: n[m] });
      }
    } catch (e) {
      if (!isQueryError(e)) throw e;
    }
  }
  for (const [id, n] of firstRows) rows.set(id, n);
  for (let i = BATCH; i < ids.length; i += BATCH) {
    const part = await report(api, ids.slice(i, i + BATCH), metrics, mode, range.startDate, range.endDate);
    for (const [id, n] of part) rows.set(id, n);
  }
  return { rows, metrics, failed: [...failed], mode };
}
