/**
 * Running tab reads (server only, Phase 5 D). Everything comes from the DB the worker's Meta sync filled; nothing here
 * calls Meta or GHL.
 *
 * - Channel header = the widget's numbers (channel_metrics: Meta's campaign-level date presets; Lane C account level) with
 *   GHL leads bucketed the widget's way (src/lib/meta/windows.ts). CPL = spend / leads (null on 0 leads). Lane C counts
 *   Meta's leads until GHL has a Lane C ad lead (leadsSource "meta").
 * - ONE anchor per account (Phase 5 gate fix): the moment of its last good sync (`syncAnchor`). Meta's per-ad windows use
 *   that moment's day in the account's timezone, GHL lead windows the same moment's day in New York, and the header's
 *   channel_metrics were read by that same sync. So the header, the cards and the flags all stop at the same day; when
 *   that day is not today the tab says "Last synced <day>: numbers stop there" (`ChannelBlock.stale`).
 * - Ad cards = daily ad rows summed over the window's dates (account timezone) + the GHL leads credited to that ad in
 *   the window; hook rate = 3 s views / impressions (video ads), hold rate = ThruPlays / 3 s views, frequency = Meta's
 *   own per-window value (unique reach is not additive), days running from the first day with spend.
 * - Scope at read time: ACTIVE, or any other status with delivery in the last 30 days (account-local).
 */
import { orderedAdIds, ordersByAppliedAd, ordersByWinnerAd, type OrderBadge } from "./orders";
import type Database from "better-sqlite3";
import { channelHref, clientShortName, searchParam as param, type SearchParamsInput } from "../media";
import { hooksPath, LATEST_SCORE } from "../hooks/sql";
import { readCreative } from "./match";
import { adFlags, FLAG_IDS, type AdFlag, type FlagId, type FlagThresholds, type Period } from "./flags";
import { flagThresholds } from "./thresholds";
import { laneNames } from "../clients-admin";
import { companyLabel } from "../profile";
import { uiLabels } from "../ui-labels";
import {
  addDays,
  cpl,
  DEFAULT_WINDOW,
  inRange,
  LEADS_TZ,
  leadRange,
  localDate,
  metaRange,
  PAUSED_WINDOW_DAYS,
  ratio,
  RUN_SORTS,
  RUN_STATUSES,
  RUN_WINDOWS,
  daysBetween,
  type RunSort,
  type RunStatus,
  type RunWindow,
} from "./windows";

type Sql = Database.Database;

export type RunningScope = { kind: "client"; code: string } | { kind: "fkbpros" } | { kind: "fkb" };

/**
 * `hook` (Phase 5 slice 2): only the ads that carry this hook (the hook row's "on N ads" link). `flag` (slice 3): only
 * the ads with that flag.
 */
export type RunningFilters = { window: RunWindow; status: RunStatus; sort: RunSort; hook: number | null; flag: FlagId | null };

/**
 * URL keys: `w` (today | 7d | 14d | lifetime, default 7d), `status` (active | paused | all), `sort` (spend | cpl | ctr |
 * hook), `hook` (a hook id: only its ads), `flag` (fatiguing | winner).
 */
export function parseRunningFilters(sp: SearchParamsInput): RunningFilters {
  const w = param(sp, "w");
  const status = param(sp, "status");
  const sort = param(sp, "sort");
  const hook = param(sp, "hook");
  const flag = param(sp, "flag");
  return {
    window: RUN_WINDOWS.includes(w as RunWindow) ? (w as RunWindow) : DEFAULT_WINDOW,
    status: RUN_STATUSES.includes(status as RunStatus) ? (status as RunStatus) : "active",
    sort: RUN_SORTS.includes(sort as RunSort) ? (sort as RunSort) : "spend",
    hook: /^\d{1,9}$/.test(hook ?? "") ? Number(hook) : null,
    flag: FLAG_IDS.includes(flag as FlagId) ? (flag as FlagId) : null,
  };
}

type AccRow = {
  id: number;
  section_key: string;
  client_id: number | null;
  code: string | null;
  client_name: string | null;
  act_id: string;
  timezone: string | null;
  last_sync_at: number | null;
  last_attempt_at: number | null;
  error: string | null;
  leads_source: string | null;
  ghl_synced_at: number | null;
  ghl_error: string | null;
};

export type LeadsSource = "ghl" | "meta";

export type WindowNumbers = {
  delivered: boolean;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  linkClicks: number | null;
  metaLeads: number | null;
  /** GHL leads (Meta leads when the channel has no GHL key yet); null = never pulled. */
  leads: number | null;
  cpl: number | null;
  ctr: number | null;
  cpm: number | null;
  cplc: number | null;
};

export type ChannelBlock = {
  leadsSource: LeadsSource;
  windows: Record<RunWindow, WindowNumbers>;
  /** GHL leads in the window not tied to an ad (client total only). */
  unattributed: Record<RunWindow, number>;
  lastSyncAt: number | null;
  /** The New York day of the oldest account's last good sync when it is not today (numbers stop there), else null. */
  stale: string | null;
  errors: string[];
};

/** A hook an ad carries (hook_ads), with its latest score: shown on the Running card, linking to the hook row. */
export type CardHook = {
  id: number;
  text: string;
  kind: "text" | "video";
  roles: string[];
  overall: number | null;
  pp: { pp_person: number | null; pp_pain: number | null; pp_promise: number | null } | null;
  archived: boolean;
  href: string;
  /** The Hooks tab that holds it (no query). */
  base: string;
};

export type AdCard = {
  id: number;
  metaAdId: string;
  name: string;
  adsetName: string | null;
  campaignName: string | null;
  /** The ad account's section (fkbpros | fkb): Link a file picks from that section's Library. */
  sectionKey: string;
  client: { code: string; short: string } | null;
  /** Hooks this ad carries (headlines, primary first sentences, the matched video's hook). */
  hooks: CardHook[];
  status: string;
  active: boolean;
  isVideo: boolean;
  /** Matched asset poster, else the cached Meta thumbnail, else null (placeholder). */
  thumb: string | null;
  match: { assetId: number; filename: string | null; source: string; detail: string | null; visible: boolean } | null;
  leadsSource: LeadsSource;
  m: {
    spend: number;
    impressions: number;
    clicks: number;
    linkClicks: number;
    video3s: number;
    thruplays: number;
    metaLeads: number;
    leads: number | null;
    cpl: number | null;
    ctr: number | null;
    cpm: number | null;
    cplc: number | null;
    hookRate: number | null;
    holdRate: number | null;
    frequency: number | null;
  };
  daysRunning: number | null;
  firstSpendDate: string | null;
  lastDelivery: string | null;
  /** Code-rule flags (slice 3): never act. */
  flags: AdFlag[];
  /**
   * Winner: the Hooks tab focused on the ad's best-scoring live text hook with the Rewrite dialog open (the owner still
   * confirms there; nothing is queued from here). null when the ad carries no such hook.
   */
  rewriteHref: string | null;
  /** Winner: the hook "New ad" prefills (its best-scoring live text hook), else null (the dialog starts from the file). */
  winnerHookId: number | null;
  /** Phase 6 slice 3: the newest new-ad order started from this card's Winner chip, and the Studio order this ad came from. */
  orderFromWinner: OrderBadge | null;
  studioOrder: OrderBadge | null;
};

export type ClientSummaryRow = {
  code: string;
  label: string;
  href: string;
  comparison: boolean;
  /** Whose leads the row counts (the account's lead source: Lane C is on Meta leads until GHL has a Lane C ad lead). */
  leadsSource: LeadsSource;
  numbers: WindowNumbers;
  active: number;
  lastSyncAt: number | null;
  error: string | null;
  unattributed: number;
  /** Active ads with each flag (the same whatever the window: fatigue reads the last 7 days). */
  flags: Record<FlagId, number>;
};

export type RunningData = {
  scope: RunningScope;
  filters: RunningFilters;
  channel: ChannelBlock;
  cards: AdCard[];
  counts: Record<RunStatus, number>;
  /** Ads with each flag among the ads of the selected status (before the flag filter). */
  flagCounts: Record<FlagId, number>;
  thresholds: FlagThresholds;
  /** All clients (Lane B): one row per client + Lane C as a comparison row (the selected window). */
  clientRows: ClientSummaryRow[] | null;
  accounts: number;
  /** Section of the ads' files (Link a file picks from it). */
  canLink: boolean;
  /** The `hook` filter's hook (a banner above the cards), or null. */
  hook: { id: number; text: string; href: string } | null;
};

const ACC_SQL = `select acc.id, s.key as section_key, acc.client_id, c.code, c.name as client_name, acc.act_id, acc.timezone, acc.last_sync_at,
    acc.last_attempt_at, acc.error, acc.leads_source, acc.ghl_synced_at, acc.ghl_error
  from ad_accounts acc join sections s on s.id = acc.section_id left join clients c on c.id = acc.client_id`;

function accountsFor(sql: Sql, scope: RunningScope): AccRow[] {
  if (scope.kind === "client") return sql.prepare(`${ACC_SQL} where c.code = ? order by acc.sort`).all(scope.code) as AccRow[];
  // A whole lane: its visible clients' accounts only (a hidden client's numbers stay stored, out of the totals).
  return sql.prepare(`${ACC_SQL} where s.key = ? and (acc.client_id is null or c.hidden_at is null) order by acc.sort, acc.id`).all(scope.kind) as AccRow[];
}

const tzOf = (a: AccRow) => a.timezone ?? LEADS_TZ;
/** The one moment an account's numbers are anchored to: its last good sync (never synced: the last lead pull, else now). */
export const syncAnchor = (a: Pick<AccRow, "last_sync_at" | "ghl_synced_at">, now: number) => a.last_sync_at ?? a.ghl_synced_at ?? now;
/** The account's "today" for its Meta numbers: the anchor's day in the account's timezone. */
const todayOf = (a: AccRow, now: number) => localDate(syncAnchor(a, now), tzOf(a));
/** The GHL buckets' day: the same anchor's day in New York (the widget buckets leads in local time). */
const leadDayOf = (a: AccRow, now: number) => localDate(syncAnchor(a, now), LEADS_TZ);
const sourceOf = (a: AccRow): LeadsSource => (a.leads_source === "meta" ? "meta" : "ghl");

type CmRow = {
  account_id: number;
  window: RunWindow;
  date_start: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpm: number | null;
  link_clicks: number | null;
  cost_per_link_click: number | null;
  meta_leads: number | null;
};

type LeadRow = { account_id: number; date_added: number | null; ad_id: string | null };

/** GHL leads of these accounts (tests excluded). */
function leadsOf(sql: Sql, ids: number[]): LeadRow[] {
  if (!ids.length) return [];
  return sql
    .prepare(`select account_id, date_added, ad_id from ghl_leads where test = 0 and account_id in (${ids.map(() => "?").join(",")})`)
    .all(...ids) as LeadRow[];
}

const leadInWindow = (l: LeadRow, w: RunWindow, leadDay: string) =>
  w === "lifetime" || (l.date_added != null && inRange(localDate(l.date_added, LEADS_TZ), leadRange(w, leadDay)));

function emptyNumbers(): WindowNumbers {
  return { delivered: false, spend: null, impressions: null, clicks: null, linkClicks: null, metaLeads: null, leads: null, cpl: null, ctr: null, cpm: null, cplc: null };
}

/** The widget's numbers for a set of accounts (one account = Meta's own CTR / CPM / cost per link click). */
export function channelBlock(sql: Sql, accs: AccRow[], now = Date.now()): ChannelBlock {
  const ids = accs.map((a) => a.id);
  const cms = ids.length
    ? (sql.prepare(`select * from channel_metrics where account_id in (${ids.map(() => "?").join(",")})`).all(...ids) as CmRow[])
    : [];
  const leads = leadsOf(sql, ids);
  const leadsSource: LeadsSource = accs.length && accs.every((a) => sourceOf(a) === "meta") ? "meta" : "ghl";
  const windows = {} as Record<RunWindow, WindowNumbers>;
  const unattributed = {} as Record<RunWindow, number>;
  for (const w of RUN_WINDOWS) {
    const rows = cms.filter((r) => r.window === w);
    const live = rows.filter((r) => r.date_start);
    const n = emptyNumbers();
    if (live.length) {
      const sum = (k: keyof CmRow) => live.reduce((s, r) => s + ((r[k] as number | null) ?? 0), 0);
      n.delivered = true;
      n.spend = sum("spend");
      n.impressions = sum("impressions");
      n.clicks = sum("clicks");
      n.linkClicks = sum("link_clicks");
      n.metaLeads = sum("meta_leads");
      if (live.length === 1) {
        n.ctr = live[0].ctr;
        n.cpm = live[0].cpm;
        n.cplc = live[0].cost_per_link_click;
      } else {
        n.ctr = ratio(n.clicks, n.impressions, 100);
        n.cpm = ratio(n.spend, n.impressions, 1000);
        n.cplc = ratio(n.spend, n.linkClicks);
      }
    } else if (rows.length) {
      n.spend = 0;
      n.metaLeads = 0;
    }
    let total = 0;
    let loose = 0;
    let known = false;
    for (const a of accs) {
      if (sourceOf(a) === "meta") {
        const cm = rows.find((r) => r.account_id === a.id);
        if (cm) {
          known = true;
          total += cm.meta_leads ?? 0;
        }
        continue;
      }
      if (a.ghl_synced_at == null) continue;
      known = true;
      const day = leadDayOf(a, now);
      for (const l of leads) {
        if (l.account_id !== a.id || !leadInWindow(l, w, day)) continue;
        total++;
        if (!l.ad_id) loose++;
      }
    }
    n.leads = known ? total : null;
    n.cpl = cpl(n.spend, n.leads);
    windows[w] = n;
    unattributed[w] = loose;
  }
  const laneC = accs.some((a) => !a.code) ? laneNames(sql).fkb : "";
  const errors = accs.flatMap((a) => [a.error, a.ghl_error].filter((e): e is string => Boolean(e)).map((e) => `${a.code ?? laneC}: ${e}`));
  const syncs = accs.map((a) => a.last_sync_at);
  const lastSyncAt = syncs.length && syncs.every((s) => s != null) ? Math.min(...(syncs as number[])) : null;
  const syncDay = lastSyncAt != null ? localDate(lastSyncAt, LEADS_TZ) : null;
  return {
    leadsSource,
    windows,
    unattributed,
    lastSyncAt,
    stale: syncDay && syncDay !== localDate(now, LEADS_TZ) ? syncDay : null,
    errors,
  };
}

type AdRow = {
  id: number;
  meta_ad_id: string;
  account_id: number;
  name: string;
  adset_name: string | null;
  campaign_name: string | null;
  effective_status: string | null;
  creative: string | null;
  first_spend_date: string | null;
  last_spend_date: string | null;
  thumb_path: string | null;
  matched_asset_id: number | null;
  match_source: string | null;
  match_detail: string | null;
  last_delivery: string | null;
  a_filename: string | null;
  a_thumb: string | null;
  a_sha: string | null;
  a_visible: number | null;
};

type DailyAgg = { spend: number; impressions: number; clicks: number; link_clicks: number; meta_leads: number; video_3s: number; thruplays: number };

/** The Running tab for a channel: header numbers, cards for the window / status / sort, counts, client table. */
export function runningData(sql: Sql, scope: RunningScope, filters: RunningFilters, now = Date.now()): RunningData {
  const accs = accountsFor(sql, scope);
  const byId = new Map(accs.map((a) => [a.id, a]));
  const ids = accs.map((a) => a.id);
  const channel = channelBlock(sql, accs, now);
  const inList = ids.map(() => "?").join(",");
  const ads = ids.length
    ? (sql
        .prepare(
          `select a.id, a.meta_ad_id, a.account_id, a.name, a.adset_name, a.campaign_name, a.effective_status, a.creative, a.first_spend_date,
                  a.last_spend_date, a.thumb_path, a.matched_asset_id, a.match_source, a.match_detail,
                  (select max(m.date) from ad_metrics m where m.meta_ad_id = a.meta_ad_id and m.impressions > 0) as last_delivery,
                  x.filename as a_filename, x.thumb_path as a_thumb, x.sha256 as a_sha,
                  (x.id is not null and x.missing = 0 and x.ignored = 0 and r.enabled = 1) as a_visible
             from ads a left join assets x on x.id = a.matched_asset_id left join roots r on r.id = x.root_id
            where a.account_id in (${inList})`,
        )
        .all(...ids) as AdRow[])
    : [];

  // Scope at read time: ACTIVE, or delivery in the last 30 days, or (gate fix) an ad a Studio order created: a new PAUSED
  // ad that never delivered is listed under Paused / All (never Active unless Meta says ACTIVE) with "Staged in Studio".
  const ordered = orderedAdIds(sql);
  const inScope = (ad: AdRow) => {
    const acc = byId.get(ad.account_id)!;
    const active = ad.effective_status === "ACTIVE";
    const recent = ad.last_delivery != null && ad.last_delivery >= addDays(todayOf(acc, now), -(PAUSED_WINDOW_DAYS - 1));
    return { active, paused: !active && (recent || ordered.has(ad.meta_ad_id)) };
  };
  const statusOk = (s: { active: boolean; paused: boolean }) =>
    (filters.status === "active" && s.active) || (filters.status === "paused" && s.paused) || (filters.status === "all" && (s.active || s.paused));
  const counts: Record<RunStatus, number> = { active: 0, paused: 0, all: 0 };
  const listed: AdRow[] = [];
  const scoped: AdRow[] = [];
  const activeIds = new Set<string>();
  let hookInfo: RunningData["hook"] = null;
  let hookAds: Set<string> | null = null;
  if (filters.hook != null) {
    const h = sql
      .prepare("select h.id, h.text, h.kind, s.key as section, c.code from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id where h.id = ?")
      .get(filters.hook) as { id: number; text: string; kind: string; section: string; code: string | null } | undefined;
    hookAds = new Set(sql.prepare("select meta_ad_id from hook_ads where hook_id = ?").pluck().all(filters.hook) as string[]);
    if (h) hookInfo = { id: h.id, text: h.text, href: `${hooksPath(h.section, h.code)}?${h.kind === "video" ? "view=video&" : ""}focus=${h.id}` };
  }
  for (const ad of ads) {
    const s = inScope(ad);
    if (!s.active && !s.paused) continue;
    scoped.push(ad);
    if (s.active) activeIds.add(ad.meta_ad_id);
    if (hookAds && !hookAds.has(ad.meta_ad_id)) continue;
    if (s.active) counts.active++;
    if (s.paused) counts.paused++;
    counts.all++;
    if (statusOk(s)) listed.push(ad);
  }

  // Daily sums per in-scope ad (account timezone): the window, the flags' last 7 days vs earlier, and 14 days.
  const w = filters.window;
  const zero = (): DailyAgg => ({ spend: 0, impressions: 0, clicks: 0, link_clicks: 0, meta_leads: 0, video_3s: 0, thruplays: 0 });
  const agg = new Map<string, DailyAgg>();
  const recent = new Map<string, Period>();
  const earlier = new Map<string, Period>();
  const d14 = new Map<string, DailyAgg>();
  const addTo = (m: Map<string, DailyAgg>, id: string, r: DailyAgg) => {
    const cur = m.get(id) ?? zero();
    cur.spend += r.spend;
    cur.impressions += r.impressions;
    cur.clicks += r.clicks;
    cur.link_clicks += r.link_clicks;
    cur.meta_leads += r.meta_leads;
    cur.video_3s += r.video_3s;
    cur.thruplays += r.thruplays;
    m.set(id, cur);
  };
  const addPeriod = (m: Map<string, Period>, id: string, r: DailyAgg) => {
    const cur = m.get(id) ?? { impressions: 0, clicks: 0, video3s: 0 };
    cur.impressions += r.impressions;
    cur.clicks += r.clicks;
    cur.video3s += r.video_3s;
    m.set(id, cur);
  };
  if (scoped.length) {
    const rows = sql
      .prepare(
        `select meta_ad_id, date, spend, impressions, clicks, link_clicks, meta_leads, video_3s, thruplays
           from ad_metrics where meta_ad_id in (select value from json_each(?))`,
      )
      .all(JSON.stringify(scoped.map((a) => a.meta_ad_id))) as (DailyAgg & { meta_ad_id: string; date: string })[];
    const accOf = new Map(scoped.map((a) => [a.meta_ad_id, byId.get(a.account_id)!]));
    for (const r of rows) {
      const today = todayOf(accOf.get(r.meta_ad_id)!, now);
      if (inRange(r.date, metaRange(w, today))) addTo(agg, r.meta_ad_id, r);
      const last7 = metaRange("7d", today);
      if (inRange(r.date, last7)) addPeriod(recent, r.meta_ad_id, r);
      else if (last7.from != null && r.date < last7.from) addPeriod(earlier, r.meta_ad_id, r);
      if (inRange(r.date, metaRange("14d", today))) addTo(d14, r.meta_ad_id, r);
    }
  }
  const leadCount = new Map<string, number>();
  const leadCount14 = new Map<string, number>();
  for (const l of leadsOf(sql, ids)) {
    if (!l.ad_id) continue;
    const acc = byId.get(l.account_id)!;
    const day = leadDayOf(acc, now);
    if (leadInWindow(l, w, day)) leadCount.set(l.ad_id, (leadCount.get(l.ad_id) ?? 0) + 1);
    if (leadInWindow(l, "14d", day)) leadCount14.set(l.ad_id, (leadCount14.get(l.ad_id) ?? 0) + 1);
  }
  // Meta's own frequency per window; else impressions / unique reach of the same read. The card shows the selected
  // window's; the fatiguing rule always reads the last 7 days' (so flags never move with the window).
  const freqOf = (win: RunWindow) =>
    new Map(
      (
        sql.prepare("select meta_ad_id, frequency, reach, impressions from ad_windows where window = ?").all(win) as {
          meta_ad_id: string;
          frequency: number | null;
          reach: number | null;
          impressions: number | null;
        }[]
      ).map((r) => [r.meta_ad_id, r.frequency ?? (r.reach && r.impressions != null ? r.impressions / r.reach : null)]),
    );
  const freq = freqOf(w);
  const freq7 = w === "7d" ? freq : freqOf("7d");

  // Flags (code rules, never act): each account's own 14 day CPL is the winner's yardstick.
  const thresholds = flagThresholds(sql);
  const cpl14 = new Map(accs.map((a) => [a.id, channelBlock(sql, [a], now).windows["14d"].cpl]));
  const leadsFor = (ad: AdRow, d: DailyAgg, counts: Map<string, number>) => {
    const acc = byId.get(ad.account_id)!;
    return sourceOf(acc) === "meta" ? d.meta_leads : acc.ghl_synced_at == null ? null : (counts.get(ad.meta_ad_id) ?? 0);
  };
  const flagsOf = new Map<string, AdFlag[]>();
  for (const ad of scoped) {
    const d = d14.get(ad.meta_ad_id) ?? zero();
    flagsOf.set(
      ad.meta_ad_id,
      adFlags(
        {
          isVideo: readCreative(ad.creative)?.isVideo ?? false,
          frequency: freq7.get(ad.meta_ad_id) ?? null,
          recent: recent.get(ad.meta_ad_id) ?? { impressions: 0, clicks: 0, video3s: 0 },
          earlier: earlier.get(ad.meta_ad_id) ?? { impressions: 0, clicks: 0, video3s: 0 },
          spend14: d.spend,
          leads14: leadsFor(ad, d, leadCount14),
          channelCpl14: cpl14.get(ad.account_id) ?? null,
        },
        thresholds,
      ),
    );
  }
  const flagCounts: Record<FlagId, number> = { fatiguing: 0, winner: 0 };
  for (const ad of listed) for (const f of flagsOf.get(ad.meta_ad_id) ?? []) flagCounts[f.id]++;
  const shown = filters.flag ? listed.filter((ad) => (flagsOf.get(ad.meta_ad_id) ?? []).some((f) => f.id === filters.flag)) : listed;

  const hooksByAd = cardHooks(sql, shown.map((a) => a.meta_ad_id));
  const winnerOrders = ordersByWinnerAd(sql, shown.map((a) => a.meta_ad_id), now);
  const appliedOrders = ordersByAppliedAd(sql, shown.map((a) => a.meta_ad_id), now);
  const cards: AdCard[] = shown.map((ad) => {
    const acc = byId.get(ad.account_id)!;
    const creative = readCreative(ad.creative);
    const isVideo = creative?.isVideo ?? false;
    const d = agg.get(ad.meta_ad_id) ?? zero();
    const src = sourceOf(acc);
    const leads = leadsFor(ad, d, leadCount);
    const active = ad.effective_status === "ACTIVE";
    const today = todayOf(acc, now);
    const end = active ? today : (ad.last_spend_date ?? today);
    const visible = Boolean(ad.a_visible);
    const hooks = hooksByAd.get(ad.meta_ad_id) ?? [];
    const flags = flagsOf.get(ad.meta_ad_id) ?? [];
    const best = flags.some((f) => f.id === "winner") ? hooks.find((h) => h.kind === "text" && !h.archived) : undefined;
    return {
      id: ad.id,
      metaAdId: ad.meta_ad_id,
      name: ad.name,
      adsetName: ad.adset_name,
      campaignName: ad.campaign_name,
      sectionKey: acc.section_key,
      client: acc.code ? { code: acc.code, short: clientShortName(acc.client_name ?? acc.code) } : null,
      hooks,
      status: ad.effective_status ?? "UNKNOWN",
      active,
      isVideo,
      thumb:
        ad.matched_asset_id && visible && ad.a_thumb
          ? `/api/media/${ad.matched_asset_id}/thumb?v=${(ad.a_sha ?? "").slice(0, 12)}`
          : ad.thumb_path
            ? `/api/meta/thumb/${ad.id}`
            : null,
      match: ad.matched_asset_id
        ? { assetId: ad.matched_asset_id, filename: ad.a_filename, source: ad.match_source ?? "map", detail: ad.match_detail, visible }
        : null,
      leadsSource: src,
      m: {
        spend: d.spend,
        impressions: d.impressions,
        clicks: d.clicks,
        linkClicks: d.link_clicks,
        video3s: d.video_3s,
        thruplays: d.thruplays,
        metaLeads: d.meta_leads,
        leads,
        cpl: cpl(d.spend, leads),
        ctr: ratio(d.clicks, d.impressions, 100),
        cpm: ratio(d.spend, d.impressions, 1000),
        cplc: ratio(d.spend, d.link_clicks),
        hookRate: isVideo ? ratio(d.video_3s, d.impressions, 100) : null,
        holdRate: isVideo ? ratio(d.thruplays, d.video_3s, 100) : null,
        frequency: freq.get(ad.meta_ad_id) ?? null,
      },
      daysRunning: ad.first_spend_date ? Math.max(1, daysBetween(ad.first_spend_date, end) + 1) : null,
      firstSpendDate: ad.first_spend_date,
      lastDelivery: ad.last_delivery,
      flags,
      rewriteHref: best ? `${best.base}?focus=${best.id}&rewrite=${best.id}` : null,
      winnerHookId: best?.id ?? null,
      orderFromWinner: winnerOrders.get(ad.meta_ad_id) ?? null,
      studioOrder: appliedOrders.get(ad.meta_ad_id) ?? null,
    };
  });
  sortCards(cards, filters.sort);

  let clientRows: ClientSummaryRow[] | null = null;
  if (scope.kind === "fkbpros") {
    const all = [...accs, ...accountsFor(sql, { kind: "fkb" })];
    const activeCount = sql.prepare("select count(*) from ads where account_id = ? and effective_status = 'ACTIVE'");
    // Lane C (the comparison row) is not in this scope's ads: its flags come from its own Running read.
    const fkbFlags = all.some((a) => a.section_key === "fkb") ? runningData(sql, { kind: "fkb" }, { ...filters, status: "active", flag: null, hook: null }, now).flagCounts : null;
    clientRows = all.map((a) => {
      const block = channelBlock(sql, [a], now);
      const comparison = a.section_key === "fkb";
      const flags: Record<FlagId, number> = { fatiguing: 0, winner: 0 };
      if (comparison && fkbFlags) Object.assign(flags, fkbFlags);
      else
        for (const ad of scoped)
          if (ad.account_id === a.id && activeIds.has(ad.meta_ad_id)) for (const f of flagsOf.get(ad.meta_ad_id) ?? []) flags[f.id]++;
      return {
        code: a.code ?? "fkb",
        label: comparison ? companyLabel(uiLabels(sql)) : clientShortName(a.client_name ?? a.code ?? ""),
        href: channelHref(a.section_key, a.code, "running"),
        comparison,
        leadsSource: block.leadsSource,
        numbers: block.windows[w],
        active: activeCount.pluck().get(a.id) as number,
        lastSyncAt: a.last_sync_at,
        error: a.error ?? a.ghl_error,
        unattributed: block.unattributed[w],
        flags,
      };
    });
  }
  return { scope, filters, channel, cards, counts, flagCounts, thresholds, clientRows, accounts: accs.length, canLink: true, hook: hookInfo };
}

/** The hooks each ad carries (roles merged per hook), best score first. */
function cardHooks(sql: Sql, metaAdIds: string[]): Map<string, CardHook[]> {
  const out = new Map<string, CardHook[]>();
  if (!metaAdIds.length) return out;
  const rows = sql
    .prepare(
      `select ha.meta_ad_id, ha.role, h.id, h.text, h.kind, h.archived_at, s.key as section, c.code,
              hs.overall, hs.pp_person, hs.pp_pain, hs.pp_promise, hs.hook_id as scored
         from hook_ads ha join hooks h on h.id = ha.hook_id join sections s on s.id = h.section_id
         left join clients c on c.id = h.client_id
         left join hook_scores hs on hs.hook_id = h.id and ${LATEST_SCORE}
        where ha.meta_ad_id in (select value from json_each(?))`,
    )
    .all(JSON.stringify(metaAdIds)) as {
    meta_ad_id: string;
    role: string;
    id: number;
    text: string;
    kind: "text" | "video";
    archived_at: number | null;
    section: string;
    code: string | null;
    overall: number | null;
    pp_person: number | null;
    pp_pain: number | null;
    pp_promise: number | null;
    scored: number | null;
  }[];
  for (const r of rows) {
    const list = out.get(r.meta_ad_id) ?? [];
    const have = list.find((x) => x.id === r.id);
    if (have) {
      if (!have.roles.includes(r.role)) have.roles.push(r.role);
      continue;
    }
    list.push({
      id: r.id,
      text: r.text,
      kind: r.kind,
      roles: [r.role],
      overall: r.overall,
      pp: r.scored != null ? { pp_person: r.pp_person, pp_pain: r.pp_pain, pp_promise: r.pp_promise } : null,
      archived: r.archived_at != null,
      base: hooksPath(r.section, r.code),
      href: `${hooksPath(r.section, r.code)}?${r.kind === "video" ? "view=video&" : ""}${r.archived_at != null ? "archived=1&" : ""}focus=${r.id}`,
    });
    out.set(r.meta_ad_id, list);
  }
  const ROLE_ORDER: Record<string, number> = { video: 0, headline: 1, primary: 2 };
  for (const list of out.values()) {
    list.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1) || Math.min(...a.roles.map((x) => ROLE_ORDER[x] ?? 3)) - Math.min(...b.roles.map((x) => ROLE_ORDER[x] ?? 3)) || a.id - b.id);
  }
  return out;
}

/** Spend (default, high first), CPL (low first, no leads last), CTR / hook rate (high first, none last). */
export function sortCards(cards: AdCard[], sort: RunSort) {
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : (a - b) * dir);
  cards.sort((a, b) => {
    const primary =
      sort === "cpl"
        ? nullsLast(a.m.cpl, b.m.cpl, 1)
        : sort === "ctr"
          ? nullsLast(a.m.ctr, b.m.ctr, -1)
          : sort === "hook"
            ? nullsLast(a.m.hookRate, b.m.hookRate, -1)
            : b.m.spend - a.m.spend;
    return primary || b.m.spend - a.m.spend || a.name.localeCompare(b.name);
  });
}

/** A Meta thumbnail's cache path (the thumb route). */
export function adThumbPath(sql: Sql, adId: number): string | null {
  return (sql.prepare("select thumb_path from ads where id = ?").pluck().get(adId) as string | null | undefined) ?? null;
}
