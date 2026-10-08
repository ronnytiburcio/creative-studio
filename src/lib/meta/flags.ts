/**
 * Running tab flags (Phase 5 slice 3, PHASE-5 E; client safe: zod only). Code rules, free, computed at read time from the
 * daily rows the Meta sync stored. Flags never act: no pausing, no jobs, no variants queued.
 *
 * - Fatiguing: the LAST 7 DAYS' frequency > 3 (Meta's own last_7d value from `ad_windows`, else those 7 days'
 *   impressions / reach), OR the last 7 days' CTR or hook rate down >= 25% from the ad's own earlier average (every day
 *   before those 7), with >= 3,000 impressions on each side. "Last 7 days" = Meta's last_7d (the 7 days before the
 *   account's sync day, as the Running tab's 7 day window). Whatever window the tab shows, the flags and their counts
 *   are the same (Phase 5 gate fix); the card still shows the selected window's frequency as a number.
 * - Winner worth new variants: the ad's 14 day CPL >= 20% better (lower) than its channel's 14 day CPL, with >= 3
 *   leads in those 14 days (GHL-attributed; Meta leads for an account on Meta leads, Lane C today).
 */
import { z } from "zod";

export type FlagThresholds = {
  /** Fatiguing when frequency is above this. */
  frequency: number;
  /** Fatiguing when the last 7 days' CTR or hook rate is down at least this many percent. */
  dropPct: number;
  /** ... with at least this many impressions in each period. */
  minImpressions: number;
  /** Winner when the 14 day CPL is at least this many percent better than the channel's. */
  winnerPct: number;
  /** ... with at least this many leads in the 14 days. */
  winnerLeads: number;
};

export const DEFAULT_FLAG_THRESHOLDS: FlagThresholds = { frequency: 3, dropPct: 25, minImpressions: 3000, winnerPct: 20, winnerLeads: 3 };

export const flagThresholdsSchema = z
  .object({
    frequency: z.number().min(1).max(20),
    dropPct: z.number().min(5).max(90),
    minImpressions: z.number().int().min(100).max(1_000_000),
    winnerPct: z.number().min(5).max(90),
    winnerLeads: z.number().int().min(1).max(100),
  })
  .strict();

export const calibrationMinimumsSchema = z
  .object({
    impressions: z.number().int().min(100).max(1_000_000),
    leads: z.number().int().min(1).max(100),
    hooks: z.number().int().min(3).max(100),
    // Phase 5 slice 4: absent in values saved before it = the defaults.
    groups: z.number().int().min(3).max(1000).default(8),
    views: z.number().int().min(10).max(10_000_000).default(300),
  })
  .strict();

export const FLAG_IDS = ["fatiguing", "winner"] as const;
export type FlagId = (typeof FLAG_IDS)[number];
export const FLAG_LABEL: Record<FlagId, string> = { fatiguing: "Fatiguing", winner: "Winner" };

export type Period = { impressions: number; clicks: number; video3s: number };

export type FlagInput = {
  isVideo: boolean;
  /** The last 7 days' frequency (null = unknown). */
  frequency: number | null;
  /** The last 7 days (Meta's last_7d) and every day before them. */
  recent: Period;
  earlier: Period;
  /** The ad's 14 day spend and leads (null leads = not known). */
  spend14: number;
  leads14: number | null;
  /** The channel's 14 day CPL (null = no leads / not known). */
  channelCpl14: number | null;
};

export type AdFlag = {
  id: FlagId;
  /** Plain reasons for the chip ("CTR 1.9% → 1.3%", "frequency 3.4", "CPL $98 vs channel $141"). */
  reasons: string[];
};

const pct = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)}%`;
const usd0 = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/** The flags of one ad (empty = none). */
export function adFlags(x: FlagInput, t: FlagThresholds): AdFlag[] {
  const out: AdFlag[] = [];
  const fatigue: string[] = [];
  const bothSides = x.recent.impressions >= t.minImpressions && x.earlier.impressions >= t.minImpressions;
  if (bothSides) {
    const drop = (now: number, before: number) => before > 0 && now <= before * (1 - t.dropPct / 100);
    const ctrNow = (x.recent.clicks / x.recent.impressions) * 100;
    const ctrBefore = (x.earlier.clicks / x.earlier.impressions) * 100;
    if (drop(ctrNow, ctrBefore)) fatigue.push(`CTR ${pct(ctrBefore)} → ${pct(ctrNow)}`);
    if (x.isVideo) {
      const hrNow = (x.recent.video3s / x.recent.impressions) * 100;
      const hrBefore = (x.earlier.video3s / x.earlier.impressions) * 100;
      if (drop(hrNow, hrBefore)) fatigue.push(`hook rate ${pct(hrBefore)} → ${pct(hrNow)}`);
    }
  }
  if (x.frequency != null && x.frequency > t.frequency) {
    // One decimal, unless that would read as the threshold itself (3.04 -> "3.04", never "3.0").
    const f1 = x.frequency.toFixed(1);
    fatigue.push(`frequency ${Number(f1) > t.frequency ? f1 : x.frequency.toFixed(2)}`);
  }
  if (fatigue.length) out.push({ id: "fatiguing", reasons: fatigue });

  if (x.leads14 != null && x.leads14 >= t.winnerLeads && x.channelCpl14 != null && x.channelCpl14 > 0) {
    const cpl = x.spend14 / x.leads14;
    if (cpl <= x.channelCpl14 * (1 - t.winnerPct / 100)) out.push({ id: "winner", reasons: [`CPL ${usd0(cpl)} vs channel ${usd0(x.channelCpl14)}`] });
  }
  return out;
}
