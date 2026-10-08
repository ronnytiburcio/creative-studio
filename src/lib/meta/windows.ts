/**
 * Running tab windows, sorts and date math (client safe: no imports).
 *
 * Windows follow the owner's widget (widget_ads_stats.py in META_ENV_FILE's folder) exactly:
 *  - Meta numbers use Meta's own date presets, in the ad account's timezone: today, last_7d / last_14d (the 7 / 14 days
 *    BEFORE today, today excluded) and maximum (lifetime). Per-ad cards sum the daily rows over the same dates.
 *  - GHL leads are bucketed by dateAdded in local time (America/New_York) the widget's way: today, the last 7 days
 *    INCLUDING today (and 14 days including today), lifetime; relative to the moment the numbers were synced.
 * So a 7 day CPL is Meta's last_7d spend over GHL's 7 days incl. today, as on the widget.
 */

export const RUN_WINDOWS = ["today", "7d", "14d", "lifetime"] as const;
export type RunWindow = (typeof RUN_WINDOWS)[number];
export const DEFAULT_WINDOW: RunWindow = "7d";

export const WINDOW_LABEL: Record<RunWindow, string> = { today: "Today", "7d": "7 days", "14d": "14 days", lifetime: "All time" };

/** Meta date_preset per window. */
export const META_PRESET: Record<RunWindow, string> = { today: "today", "7d": "last_7d", "14d": "last_14d", lifetime: "maximum" };

export const RUN_SORTS = ["spend", "cpl", "ctr", "hook"] as const;
export type RunSort = (typeof RUN_SORTS)[number];
export const SORT_LABEL: Record<RunSort, string> = { spend: "Spend", cpl: "CPL", ctr: "CTR", hook: "Hook rate" };

export const RUN_STATUSES = ["active", "paused", "all"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const STATUS_LABEL: Record<RunStatus, string> = { active: "Active", paused: "Paused", all: "All" };

/** Local time zone for GHL buckets (the widget runs on the owner's Mac). */
export const LEADS_TZ = "America/New_York";

/** Paused ads stay in scope while they delivered in the last N days (today included). */
export const PAUSED_WINDOW_DAYS = 30;

/** "YYYY-MM-DD" of `ms` in `timeZone` (falls back to America/New_York for an unknown zone). */
export function localDate(ms: number, timeZone: string): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  try {
    return fmt(timeZone);
  } catch {
    return fmt(LEADS_TZ);
  }
}

/** True when Intl knows the zone. */
export function validTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" plus n days (calendar math on the date itself, no time zone). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** Meta's date range for a window, as account-local dates [from, to] (from null = lifetime). */
export function metaRange(window: RunWindow, today: string): { from: string | null; to: string } {
  switch (window) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -7), to: addDays(today, -1) };
    case "14d":
      return { from: addDays(today, -14), to: addDays(today, -1) };
    default:
      return { from: null, to: today };
  }
}

/** GHL window as NY-local dates [from, to] relative to the sync day (from null = lifetime). */
export function leadRange(window: RunWindow, syncDay: string): { from: string | null; to: string } {
  switch (window) {
    case "today":
      return { from: syncDay, to: syncDay };
    case "7d":
      return { from: addDays(syncDay, -6), to: syncDay };
    case "14d":
      return { from: addDays(syncDay, -13), to: syncDay };
    default:
      return { from: null, to: syncDay };
  }
}

export function inRange(date: string, r: { from: string | null; to: string }): boolean {
  return (r.from == null || date >= r.from) && date <= r.to;
}

// ------------------------------------------------------------------ math (null when the denominator is 0)

export const ratio = (n: number | null | undefined, d: number | null | undefined, scale = 1): number | null =>
  n == null || d == null || !d ? null : (n / d) * scale;

/** Cost per lead: spend / leads; null on 0 leads (the widget shows a dash). */
export const cpl = (spend: number | null | undefined, leads: number | null | undefined) => ratio(spend, leads);

// ------------------------------------------------------------------ formatting

export const fmtUsd = (v: number | null | undefined, digits = 2) =>
  v == null ? "–" : `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const fmtPct = (v: number | null | undefined, digits = 2) => (v == null ? "–" : `${v.toFixed(digits)}%`);
export const fmtInt = (v: number | null | undefined) => (v == null ? "–" : Math.round(v).toLocaleString("en-US"));
export const fmtNum = (v: number | null | undefined, digits = 2) => (v == null ? "–" : v.toFixed(digits));
