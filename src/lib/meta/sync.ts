/**
 * One Meta + GHL sync of one ad account (worker only, Phase 5 A). Called by the worker's MetaSyncQueue; every Meta read
 * goes through MetaGraph (GET only), every lead read through GhlClient (the contacts search only). Nothing is ever
 * written to Meta or GHL.
 *
 * Steps (each account on its own; a failure is recorded on the account and the next account still runs):
 *  1. The account's timezone (Meta days are account-local).
 *  2. Campaigns, per the account's owner (a client, or Lane C's own account) `campaign_mode` (Creative Studio 1b):
 *     `all` = every campaign in the account (the default; channel numbers at account level), `one` = the configured
 *     campaign id, `state_json` = the widget's find_campaign_id (state.json / build_state.json `campaign_id`, else the
 *     first campaign whose name matches the profile's `ads.campaignWord` or the code, else the only campaign). Clients synced before 1b are
 *     `state_json`, Lane C's account `all`, so their numbers are unchanged.
 *  3. Ads of those campaigns (name, statuses, ad set, created time, creative with every headline / primary /
 *     description / CTA, video ids / image hashes, a 480 px thumbnail URL).
 *  4. Daily ad-level insights (time_increment=1): the first sync backfills from each campaign's start (31 day chunks;
 *     no Meta start_time = the earliest created_time of the campaign's ads, else 89 days back), later syncs re-read from
 *     the earlier of (today - 2) and the day before the campaign's last completed read (`meta_campaigns.synced_through`),
 *     capped at the start, so days missed while the worker was down / paused / failing are filled. Upserted, never deleted.
 *  5. Scope: ACTIVE ads, or any other status with delivery in the last 30 days; those rows (and rows already stored)
 *     are upserted. First / last day with spend recomputed.
 *  6. Per-ad unique reach per window (frequency), 7. the channel's widget numbers per window (campaign level; Lane C
 *     account level), replaced only when all four windows read fine.
 *  8. Leads per `leads_mode`: `meta` = Meta's lead actions (no GHL read), `ghl` = GHL contacts whose source is the
 *     owner's `ghl_source` (default `<code>-fb-ad`; GHL location = the lane's `ghl_location_id`, else the env file's),
 *     mirrored (no contact details) ONLY when GHL's list was read to its end (a partial read upserts and keeps every
 *     stored lead, with a note), each attributed to the ad its utm_content names (first touch, else last touch); `auto`
 *     = Meta leads until GHL has one such contact, then GHL (leadsSourceFor; Lane C's rule).
 *  9. Matching (src/lib/meta/match.ts), the Meta media names of still unmatched ads (read once), and a cached Meta
 *     thumbnail (downloaded once) for ads with no local file.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { MetaGraph, MetaGraphError, type MetaIdentity } from "./graph";
import { GHL_MISSING, GhlClient, type GhlLead } from "./ghl";
import { accountMapRows, matchAccountAds, normAdName, parseCreative, readCreative, stripCopy, type MatchStats } from "./match";
import { cacheThumb, httpThumbFetch, type ThumbFetch } from "./thumbs";
import { addDays, localDate, META_PRESET, PAUSED_WINDOW_DAYS, RUN_WINDOWS, validTimeZone, type RunWindow } from "./windows";
import { CAMPAIGN_ID_RE, CAMPAIGN_MODES, LEADS_MODES, type CampaignMode, type LeadsMode } from "../studio-config";
import { profile } from "../profile";

type Sql = Database.Database;

export type SyncDeps = {
  graph: (identity: MetaIdentity) => MetaGraph;
  ghl: (identity: MetaIdentity) => GhlClient;
  fetchThumb?: ThumbFetch;
  cacheDir: string;
  /** META_ENV_FILE's folder (state.json / build_state.json / video_script_map.json per client code; read only). */
  clientsDir: string;
  /** The universal registry (META_UNIVERSAL_REGISTRY: universal ads' renders; read only, skipped when unreadable). */
  universalRegistry?: string | null;
  now: () => number;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
};

export type AccountRow = {
  id: number;
  section_id: number;
  section_key: string;
  client_id: number | null;
  /** Client code, or the lane key ("fkb") for Lane C's own account. */
  code: string;
  label: string;
  act_id: string;
  identity: MetaIdentity;
  timezone: string | null;
  last_sync_at: number | null;
  last_attempt_at: number | null;
  error: string | null;
  /** The owner's sync options (the client's columns, or the lane's for an account without a client). */
  campaign_mode: CampaignMode;
  campaign_id: string | null;
  leads_mode: LeadsMode;
  /** The GHL contact source (`<code>-fb-ad` when not set). */
  ghl_source: string;
  /** The lane's GHL location (null = GHL_LOCATION_ID in the env file). */
  ghl_location_id: string | null;
};

/**
 * Accounts the Meta sync reads: those of visible clients in enabled lanes (Creative Studio 1b: a hidden client or a
 * switched-off lane is skipped; its rows stay). Shared by the worker, metaSummary / metaAccounts and the schedule.
 */
export const ACTIVE_ACCOUNT_SQL = "s.enabled = 1 and (acc.client_id is null or c.hidden_at is null)";

export function listAccounts(sql: Sql): AccountRow[] {
  const rows = sql
    .prepare(
      `select acc.id, acc.section_id, s.key as section_key, acc.client_id, coalesce(c.code, s.key) as code,
              coalesce(c.name, s.name) as label, acc.act_id, acc.identity, acc.timezone, acc.last_sync_at, acc.last_attempt_at, acc.error,
              case when acc.client_id is null then s.campaign_mode else c.campaign_mode end as campaign_mode,
              case when acc.client_id is null then s.campaign_id else c.campaign_id end as campaign_id,
              case when acc.client_id is null then s.leads_mode else c.leads_mode end as leads_mode,
              case when acc.client_id is null then s.ghl_source else c.ghl_source end as ghl_source,
              s.ghl_location_id
         from ad_accounts acc join sections s on s.id = acc.section_id left join clients c on c.id = acc.client_id
        where ${ACTIVE_ACCOUNT_SQL}
        order by acc.sort, acc.id`,
    )
    .all() as (Omit<AccountRow, "ghl_source"> & { ghl_source: string | null })[];
  return rows.map((r) => ({
    ...r,
    campaign_mode: (CAMPAIGN_MODES as readonly string[]).includes(r.campaign_mode) ? r.campaign_mode : "all",
    leads_mode: (LEADS_MODES as readonly string[]).includes(r.leads_mode) ? r.leads_mode : "meta",
    ghl_source: r.ghl_source || defaultGhlSource(r.code),
  }));
}

/** The GHL source a client (or lane) uses when none is set. */
export function defaultGhlSource(code: string): string {
  return `${code}-fb-ad`;
}

export type SyncResult = {
  ok: boolean;
  error?: string;
  campaigns: number;
  ads: number;
  inScope: number;
  metricRows: number;
  leads: number | null;
  attributed: number | null;
  /** false = GHL's list was not read to its end: stored leads were kept (upsert only). null = no GHL read. */
  leadsComplete: boolean | null;
  /** Stored leads not in this read: removed (complete read) or kept by the partial-read guard. */
  leadsRemoved: number;
  leadsKept: number;
  match: MatchStats | null;
  thumbs: number;
};

const AD_FIELDS =
  "id,name,effective_status,configured_status,created_time,adset{id,name},campaign_id," +
  "creative.thumbnail_width(480).thumbnail_height(480){id,thumbnail_url,video_id,image_hash,object_story_spec,asset_feed_spec,title,body,call_to_action_type}";
const DAILY_FIELDS =
  "ad_id,ad_name,date_start,spend,impressions,reach,frequency,clicks,ctr,cpm,inline_link_clicks,cost_per_inline_link_click,actions,video_thruplay_watched_actions";
const CHANNEL_FIELDS = "spend,impressions,reach,clicks,ctr,cpm,inline_link_clicks,cost_per_inline_link_click,actions,date_start,date_stop";
const BACKFILL_CHUNK_DAYS = 31;
const REFRESH_DAYS = 3;

type Campaign = { id: string; name: string; effective_status?: string; start_time?: string };

type MetaAd = {
  id: string;
  name?: string;
  effective_status?: string;
  configured_status?: string;
  created_time?: string;
  adset?: { id?: string; name?: string };
  campaign_id?: string;
  creative?: Record<string, unknown> & { thumbnail_url?: string };
};

type Action = { action_type?: string; value?: string };
type InsightRow = Record<string, unknown> & { actions?: Action[]; video_thruplay_watched_actions?: Action[] };

/** Meta time stamps ("2026-07-13T17:29:12+0000") -> epoch ms. */
export function metaTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(t) ? t : null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const actionValue = (list: Action[] | undefined, type: string): number | null => {
  const hit = (list ?? []).find((a) => a.action_type === type);
  return hit ? num(hit.value) : null;
};

/** Website leads the widget's way: the pixel lead action, else the aggregate "lead". */
export function metaLeadsOf(actions: Action[] | undefined): number {
  for (const key of ["offsite_conversion.fb_pixel_lead", "lead"]) {
    const v = actionValue(actions, key);
    if (v != null) return Math.trunc(v);
  }
  return 0;
}

export type DailyRow = {
  adId: string;
  adName: string | null;
  date: string;
  spend: number;
  impressions: number;
  reach: number | null;
  frequency: number | null;
  clicks: number;
  ctr: number | null;
  cpm: number | null;
  linkClicks: number;
  costPerLinkClick: number | null;
  metaLeads: number;
  video3s: number;
  thruplays: number;
};

/** One daily ad-level insights row. 3 s views = action video_view; ThruPlays = video_thruplay_watched_actions. */
export function parseDaily(r: InsightRow): DailyRow | null {
  const adId = typeof r.ad_id === "string" ? r.ad_id : null;
  const date = typeof r.date_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date_start) ? r.date_start : null;
  if (!adId || !date) return null;
  return {
    adId,
    adName: typeof r.ad_name === "string" ? r.ad_name : null,
    date,
    spend: num(r.spend) ?? 0,
    impressions: Math.trunc(num(r.impressions) ?? 0),
    reach: num(r.reach),
    frequency: num(r.frequency),
    clicks: Math.trunc(num(r.clicks) ?? 0),
    ctr: num(r.ctr),
    cpm: num(r.cpm),
    linkClicks: Math.trunc(num(r.inline_link_clicks) ?? 0),
    costPerLinkClick: num(r.cost_per_inline_link_click),
    metaLeads: metaLeadsOf(r.actions),
    video3s: Math.trunc(actionValue(r.actions, "video_view") ?? 0),
    thruplays: Math.trunc(actionValue(r.video_thruplay_watched_actions, "video_view") ?? num(r.video_thruplay_watched_actions?.[0]?.value) ?? 0),
  };
}

export type ChannelWindow = {
  dateStart: string | null;
  dateStop: string | null;
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  ctr: number | null;
  cpm: number | null;
  linkClicks: number | null;
  costPerLinkClick: number | null;
  metaLeads: number | null;
};

const EMPTY_WINDOW: ChannelWindow = {
  dateStart: null,
  dateStop: null,
  spend: null,
  impressions: null,
  reach: null,
  clicks: null,
  ctr: null,
  cpm: null,
  linkClicks: null,
  costPerLinkClick: null,
  metaLeads: null,
};

/** The widget's pick_metrics (first row; no row = no delivery in the window). */
export function pickChannel(rows: InsightRow[]): ChannelWindow {
  const r = rows[0];
  if (!r) return { ...EMPTY_WINDOW };
  return {
    dateStart: typeof r.date_start === "string" ? r.date_start : null,
    dateStop: typeof r.date_stop === "string" ? r.date_stop : null,
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: num(r.reach),
    clicks: num(r.clicks),
    ctr: num(r.ctr),
    cpm: num(r.cpm),
    linkClicks: num(r.inline_link_clicks),
    costPerLinkClick: num(r.cost_per_inline_link_click),
    metaLeads: metaLeadsOf(r.actions),
  };
}

/** Several campaigns of one channel: additive numbers summed, ratios recomputed (one campaign = Meta's own values). */
export function sumChannel(parts: ChannelWindow[]): ChannelWindow {
  const live = parts.filter((p) => p.dateStart);
  if (live.length <= 1) return live[0] ?? { ...EMPTY_WINDOW };
  const add = (k: keyof ChannelWindow) => live.reduce((s, p) => s + ((p[k] as number | null) ?? 0), 0);
  const spend = add("spend");
  const impressions = add("impressions");
  const clicks = add("clicks");
  const linkClicks = add("linkClicks");
  return {
    dateStart: live.map((p) => p.dateStart!).sort()[0],
    dateStop: live.map((p) => p.dateStop ?? "").sort().at(-1) || null,
    spend,
    impressions,
    reach: add("reach"),
    clicks,
    ctr: impressions ? (clicks / impressions) * 100 : null,
    cpm: impressions ? (spend / impressions) * 1000 : null,
    linkClicks,
    costPerLinkClick: linkClicks ? spend / linkClicks : null,
    metaLeads: add("metaLeads"),
  };
}

const CAMPAIGN_FIELDS = "id,name,effective_status,start_time";

/** The campaigns an account's sync reads (its owner's campaign_mode) and how they were found (ad_accounts.campaign_source). */
export async function findCampaigns(graph: MetaGraph, acc: AccountRow, clientsDir: string): Promise<{ campaigns: Campaign[]; source: string }> {
  if (acc.campaign_mode === "one") {
    if (!acc.campaign_id || !CAMPAIGN_ID_RE.test(acc.campaign_id)) throw new MetaGraphError("no campaign id set for this account");
    // The id is typed in Settings: read its account too and refuse a campaign of another account (its numbers would be
    // stored under this one). Graph returns account_id without the act_ prefix.
    const c = await graph.get<Campaign & { account_id?: string }>(acc.campaign_id, { fields: `${CAMPAIGN_FIELDS},account_id` });
    if (`act_${String(c.account_id ?? "")}` !== acc.act_id) throw new MetaGraphError("the campaign id belongs to another ad account");
    return { campaigns: [c], source: "id" };
  }
  if (acc.campaign_mode === "state_json") return findClientCampaigns(graph, acc, clientsDir);
  return { campaigns: await graph.getAll<Campaign>(`${acc.act_id}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 100 }), source: "account" };
}

/** The widget's find_campaign_id: state files first, then the name scan, then the only campaign. */
async function findClientCampaigns(graph: MetaGraph, acc: AccountRow, clientsDir: string): Promise<{ campaigns: Campaign[]; source: string }> {
  for (const stateName of ["state.json", "build_state.json"]) {
    const file = path.join(clientsDir, acc.code, stateName);
    let cid: string | null = null;
    try {
      const v = (JSON.parse(fs.readFileSync(file, "utf8")) as { campaign_id?: unknown }).campaign_id;
      cid = typeof v === "string" || typeof v === "number" ? String(v).trim() || null : null;
    } catch {
      cid = null;
    }
    if (cid && /^\d{1,30}$/.test(cid)) {
      const c = await graph.get<Campaign>(cid, { fields: CAMPAIGN_FIELDS });
      return { campaigns: [c], source: stateName };
    }
  }
  const list = await graph.getAll<Campaign>(`${acc.act_id}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 50 }, 1);
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = profile().ads.campaignWord;
  const re = new RegExp(`${word ? `\\b${esc(word)}\\b|` : ""}${esc(acc.code)}`, "i");
  const hit = list.find((c) => re.test(c.name ?? ""));
  if (hit) return { campaigns: [hit], source: "name" };
  if (list.length === 1) return { campaigns: list, source: "only" };
  throw new MetaGraphError(`could not identify ${word ? `${word} ` : "the "}campaign in account`);
}

function upsertDaily(sql: Sql, accountId: number, rows: DailyRow[], now: number) {
  const stmt = sql.prepare(
    `insert into ad_metrics (meta_ad_id, date, account_id, ad_name, spend, impressions, reach, frequency, clicks, ctr, cpm, link_clicks,
       cost_per_link_click, meta_leads, video_3s, thruplays, synced_at)
     values (@adId, @date, @account, @adName, @spend, @impressions, @reach, @frequency, @clicks, @ctr, @cpm, @linkClicks,
       @costPerLinkClick, @metaLeads, @video3s, @thruplays, @now)
     on conflict (meta_ad_id, date) do update set account_id = excluded.account_id, ad_name = excluded.ad_name, spend = excluded.spend,
       impressions = excluded.impressions, reach = excluded.reach, frequency = excluded.frequency, clicks = excluded.clicks,
       ctr = excluded.ctr, cpm = excluded.cpm, link_clicks = excluded.link_clicks, cost_per_link_click = excluded.cost_per_link_click,
       meta_leads = excluded.meta_leads, video_3s = excluded.video_3s, thruplays = excluded.thruplays, synced_at = excluded.synced_at`,
  );
  sql.transaction(() => {
    for (const r of rows) stmt.run({ ...r, account: accountId, now });
  })();
}

/**
 * The first day of a campaign's backfill: Meta's start_time day, else the earliest created_time of the campaign's ads,
 * else 89 days back (the last resort).
 */
export function backfillStart(startDate: string | null, firstAdDay: string | null, today: string): string {
  return startDate ?? firstAdDay ?? addDays(today, -89);
}

/**
 * Where a later sync starts re-reading a backfilled campaign: the earlier of (today - 2) and the day before its last
 * completed read (that day may have been read part way), never before the campaign's start.
 */
export function refreshFrom(today: string, through: string | null, start: string): string {
  const refresh = addDays(today, -(REFRESH_DAYS - 1));
  const from = through && addDays(through, -1) < refresh ? addDays(through, -1) : refresh;
  return from < start ? start : from;
}

/** A campaign backfilled before `synced_through` existed: read through the later of the account's last good sync day and the backfill day. */
function inferredThrough(lastSyncAt: number | null, backfilledAt: number, tz: string): string {
  const days = [localDate(backfilledAt, tz), ...(lastSyncAt ? [localDate(lastSyncAt, tz)] : [])].sort();
  return days[days.length - 1];
}

/** Split [from, to] into chunks of at most `days` days. */
export function chunkRange(from: string, to: string, days = BACKFILL_CHUNK_DAYS): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = [];
  let since = from;
  while (since <= to) {
    const until = addDays(since, days - 1) < to ? addDays(since, days - 1) : to;
    out.push({ since, until });
    since = addDays(until, 1);
  }
  return out;
}

// ------------------------------------------------------------------ GHL lead credit

type NamedAd = { metaAdId: string; name: string; createdTime: number | null };

/**
 * Pick the ad a lead's utm_content names. Name tiers: exact, then case / spacing, then without Meta's "Copy" suffix.
 * Several ads can share a name (the 2026-09-21 migration left a paused original + an active copy per name): the one with
 * spend on the lead's day (most spend), else the newest created before the lead, else the newest.
 */
export function pickAdForName(
  utm: string | null,
  ads: NamedAd[],
  leadMs: number | null,
  spendOn: (adId: string, ms: number) => number,
): string | null {
  if (!utm) return null;
  const tiers: ((a: NamedAd) => boolean)[] = [
    (a) => a.name === utm,
    (a) => normAdName(a.name) === normAdName(utm),
    (a) => stripCopy(normAdName(a.name)) === stripCopy(normAdName(utm)),
  ];
  for (const tier of tiers) {
    const hits = ads.filter(tier);
    if (!hits.length) continue;
    if (hits.length === 1) return hits[0].metaAdId;
    if (leadMs != null) {
      const spent = hits.map((a) => ({ a, s: spendOn(a.metaAdId, leadMs) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
      if (spent.length) return spent[0].a.metaAdId;
      const before = hits.filter((a) => a.createdTime != null && a.createdTime <= leadMs).sort((x, y) => y.createdTime! - x.createdTime!);
      if (before.length) return before[0].metaAdId;
    }
    return [...hits].sort((x, y) => (y.createdTime ?? 0) - (x.createdTime ?? 0))[0].metaAdId;
  }
  return null;
}

/** Credit each lead to an ad: first-touch utm_content, else last-touch. */
export function attributeLeads(
  leads: GhlLead[],
  ads: NamedAd[],
  spendOn: (adId: string, ms: number) => number,
): Map<string, { adId: string | null; via: "first" | "last" | null }> {
  const out = new Map<string, { adId: string | null; via: "first" | "last" | null }>();
  for (const lead of leads) {
    const first = pickAdForName(lead.first.utmContent, ads, lead.dateAdded, spendOn);
    if (first) {
      out.set(lead.contactId, { adId: first, via: "first" });
      continue;
    }
    const last = pickAdForName(lead.last.utmContent, ads, lead.dateAdded, spendOn);
    out.set(lead.contactId, { adId: last, via: last ? "last" : null });
  }
  return out;
}

function namedAds(sql: Sql, accountId: number): NamedAd[] {
  const rows = sql
    .prepare(
      `select meta_ad_id, name, created_time from ads where account_id = @a
       union all
       select m.meta_ad_id, max(m.ad_name), null from ad_metrics m
        where m.account_id = @a and m.ad_name is not null and m.meta_ad_id not in (select meta_ad_id from ads where account_id = @a)
        group by m.meta_ad_id`,
    )
    .all({ a: accountId }) as { meta_ad_id: string; name: string; created_time: number | null }[];
  return rows.map((r) => ({ metaAdId: r.meta_ad_id, name: r.name, createdTime: r.created_time }));
}

/**
 * Store a client's leads with their ad credit. A COMPLETE read mirrors GHL (contacts no longer returned are dropped, e.g.
 * a deleted test); a partial read (GHL stopped early, see GhlClient.searchLeads) only upserts, so leads it did not return
 * stay stored.
 */
export function storeLeads(
  sql: Sql,
  acc: Pick<AccountRow, "id">,
  leads: GhlLead[],
  tz: string,
  now: number,
  complete: boolean,
): { attributed: number; removed: number; kept: number } {
  const ads = namedAds(sql, acc.id);
  const spendStmt = sql.prepare("select spend from ad_metrics where meta_ad_id = ? and date = ?");
  const spendOn = (adId: string, ms: number) => (spendStmt.pluck().get(adId, localDate(ms, tz)) as number | undefined) ?? 0;
  const credit = attributeLeads(leads, ads, spendOn);
  const upsert = sql.prepare(
    `insert into ghl_leads (contact_id, account_id, date_added, first_utm_content, first_medium_id, last_utm_content, last_medium_id, test, ad_id, attributed_via, synced_at)
     values (@id, @account, @dateAdded, @fu, @fm, @lu, @lm, @test, @adId, @via, @now)
     on conflict (contact_id) do update set account_id = excluded.account_id, date_added = excluded.date_added,
       first_utm_content = excluded.first_utm_content, first_medium_id = excluded.first_medium_id, last_utm_content = excluded.last_utm_content,
       last_medium_id = excluded.last_medium_id, test = excluded.test, ad_id = excluded.ad_id, attributed_via = excluded.attributed_via,
       synced_at = excluded.synced_at`,
  );
  let attributed = 0;
  let removed = 0;
  let kept = 0;
  sql.transaction(() => {
    const ids = JSON.stringify(leads.map((l) => l.contactId));
    if (complete) removed = sql.prepare("delete from ghl_leads where account_id = ? and contact_id not in (select value from json_each(?))").run(acc.id, ids).changes;
    else kept = sql.prepare("select count(*) from ghl_leads where account_id = ? and contact_id not in (select value from json_each(?))").pluck().get(acc.id, ids) as number;
    for (const l of leads) {
      const c = credit.get(l.contactId) ?? { adId: null, via: null };
      if (c.adId && !l.test) attributed++;
      upsert.run({
        id: l.contactId,
        account: acc.id,
        dateAdded: l.dateAdded,
        fu: l.first.utmContent,
        fm: l.first.mediumId,
        lu: l.last.utmContent,
        lm: l.last.mediumId,
        test: l.test ? 1 : 0,
        adId: c.adId,
        via: c.via,
        now,
      });
    }
  })();
  return { attributed, removed, kept };
}

/**
 * Which leads an account counts (Creative Studio 1b, per its owner's `leads_mode`): `meta` = Meta's lead actions, `ghl` =
 * GHL contacts, `auto` = Lane C's rule from Phase 5 slice 2: its GHL leads land in a sub-account the key reaches but carry
 * no ad source at first, so it counts Meta leads while no non-test contact carries its source, and the first one switches
 * it to GHL leads (per-ad credit by utm_content like the clients), with no setting to change.
 */
export const AUTO_LEADS_RULE = "Meta leads until a GHL contact carries its source, then GHL leads";

export function leadsSourceFor(mode: LeadsMode, ghlLeads: number): "ghl" | "meta" {
  if (mode === "meta") return "meta";
  return mode === "auto" && ghlLeads === 0 ? "meta" : "ghl";
}

// ------------------------------------------------------------------ the account sync

/** Sync one account. Never throws: failures come back as { ok: false, error } (terse, scrubbed). */
export async function syncAccount(sql: Sql, acc: AccountRow, deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = {
    ok: false,
    campaigns: 0,
    ads: 0,
    inScope: 0,
    metricRows: 0,
    leads: null,
    attributed: null,
    leadsComplete: null,
    leadsRemoved: 0,
    leadsKept: 0,
    match: null,
    thumbs: 0,
  };
  const now = deps.now();
  sql.prepare("update ad_accounts set last_attempt_at = ? where id = ?").run(now, acc.id);
  const graph = deps.graph(acc.identity);
  try {
    // 1. timezone
    const info = await graph.get<{ timezone_name?: string }>(acc.act_id, { fields: "timezone_name" });
    const tz = validTimeZone(info.timezone_name) ? info.timezone_name : (acc.timezone ?? "America/New_York");
    sql.prepare("update ad_accounts set timezone = ? where id = ?").run(tz, acc.id);
    const today = localDate(now, tz);

    // 2. campaigns
    const found = await findCampaigns(graph, acc, deps.clientsDir);
    const accountLevel = acc.campaign_mode === "all";
    sql.prepare("update ad_accounts set campaign_source = ? where id = ?").run(found.source, acc.id);
    const upCampaign = sql.prepare(
      `insert into meta_campaigns (id, account_id, name, effective_status, start_date, synced_at) values (?, ?, ?, ?, ?, ?)
       on conflict (id) do update set account_id = excluded.account_id, name = excluded.name, effective_status = excluded.effective_status,
         start_date = coalesce(excluded.start_date, meta_campaigns.start_date), synced_at = excluded.synced_at`,
    );
    for (const c of found.campaigns) {
      const start = metaTime(c.start_time);
      upCampaign.run(c.id, acc.id, c.name ?? c.id, c.effective_status ?? null, start ? localDate(start, tz) : null, now);
    }
    result.campaigns = found.campaigns.length;

    // 3. ads
    const metaAds: MetaAd[] = [];
    for (const c of found.campaigns) {
      if (deps.isStopped()) throw new MetaGraphError("Stopped.");
      metaAds.push(...(await graph.getAll<MetaAd>(`${c.id}/ads`, { fields: AD_FIELDS, limit: 100 })));
    }
    result.ads = metaAds.length;
    const campaignName = new Map(found.campaigns.map((c) => [c.id, c.name]));

    // 4. daily insights (backfill on the first sync of a campaign, then refresh from the last completed read)
    const campRows = sql.prepare("select id, start_date, backfilled_at, synced_through from meta_campaigns where id = ?");
    const storedFirstAd = sql.prepare("select min(created_time) from ads where campaign_id = ?").pluck();
    for (const c of found.campaigns) {
      const row = campRows.get(c.id) as { start_date: string | null; backfilled_at: number | null; synced_through: string | null };
      const created = [...metaAds.filter((a) => a.campaign_id === c.id).map((a) => metaTime(a.created_time)), storedFirstAd.get(c.id) as number | null]
        .filter((t): t is number => t != null);
      const firstAdDay = created.length ? localDate(Math.min(...created), tz) : null;
      const start = backfillStart(row.start_date, firstAdDay, today);
      const from = row.backfilled_at
        ? refreshFrom(today, row.synced_through ?? inferredThrough(acc.last_sync_at, row.backfilled_at, tz), start)
        : start;
      for (const chunk of chunkRange(from > today ? today : from, today)) {
        if (deps.isStopped()) throw new MetaGraphError("Stopped.");
        const rows = await graph.getAll<InsightRow>(
          `${c.id}/insights`,
          { level: "ad", time_increment: 1, time_range: JSON.stringify(chunk), fields: DAILY_FIELDS, limit: 500 },
          100,
        );
        const parsed = rows.map(parseDaily).filter((r): r is DailyRow => r !== null);
        upsertDaily(sql, acc.id, parsed, now);
        result.metricRows += parsed.length;
      }
      sql.prepare("update meta_campaigns set backfilled_at = coalesce(backfilled_at, ?), synced_through = ? where id = ?").run(now, today, c.id);
    }

    // 5. scope + ads rows
    const cutoff = addDays(today, -(PAUSED_WINDOW_DAYS - 1));
    const delivered = new Set(
      (
        sql
          .prepare("select distinct meta_ad_id from ad_metrics where account_id = ? and date >= ? and impressions > 0")
          .all(acc.id, cutoff) as { meta_ad_id: string }[]
      ).map((r) => r.meta_ad_id),
    );
    const known = new Set((sql.prepare("select meta_ad_id from ads where account_id = ?").all(acc.id) as { meta_ad_id: string }[]).map((r) => r.meta_ad_id));
    // Gate fix: an ad a Studio order created (applied, or applying / failed after the ad step) is always in scope, so a
    // new PAUSED ad that never delivered still gets its row, creative, media name and match (orders written by the apply
    // skills; Studio only reads them back into ad_orders).
    const ordered = new Set(sql.prepare("select ad_id from ad_orders where ad_id is not null").pluck().all() as string[]);
    const scopeOf = (ad: MetaAd) => ad.effective_status === "ACTIVE" || delivered.has(ad.id) || ordered.has(ad.id);
    const thumbUrl = new Map<string, string>();
    const upAd = sql.prepare(
      `insert into ads (meta_ad_id, account_id, campaign_id, campaign_name, adset_id, adset_name, name, effective_status, configured_status,
         created_time, creative, first_seen_at, last_synced_at)
       values (@id, @account, @campaign, @campaignName, @adset, @adsetName, @name, @eff, @conf, @created, @creative, @now, @now)
       on conflict (meta_ad_id) do update set account_id = excluded.account_id, campaign_id = excluded.campaign_id,
         campaign_name = excluded.campaign_name, adset_id = excluded.adset_id, adset_name = excluded.adset_name, name = excluded.name,
         effective_status = excluded.effective_status, configured_status = excluded.configured_status, created_time = excluded.created_time,
         creative = excluded.creative, last_synced_at = excluded.last_synced_at`,
    );
    sql.transaction(() => {
      for (const ad of metaAds) {
        const inScope = scopeOf(ad);
        if (inScope) result.inScope++;
        if (!inScope && !known.has(ad.id)) continue;
        if (ad.creative?.thumbnail_url) thumbUrl.set(ad.id, ad.creative.thumbnail_url);
        upAd.run({
          id: ad.id,
          account: acc.id,
          campaign: ad.campaign_id ?? null,
          campaignName: (ad.campaign_id && campaignName.get(ad.campaign_id)) ?? null,
          adset: ad.adset?.id ?? null,
          adsetName: ad.adset?.name ?? null,
          name: ad.name ?? ad.id,
          eff: ad.effective_status ?? null,
          conf: ad.configured_status ?? null,
          created: metaTime(ad.created_time),
          creative: JSON.stringify(parseCreative(ad.creative)),
          now,
        });
      }
      sql
        .prepare(
          `update ads set first_spend_date = (select min(m.date) from ad_metrics m where m.meta_ad_id = ads.meta_ad_id and m.spend > 0),
             last_spend_date = (select max(m.date) from ad_metrics m where m.meta_ad_id = ads.meta_ad_id and m.spend > 0)
           where account_id = ?`,
        )
        .run(acc.id);
    })();

    // 6. per-ad reach per window (frequency), campaigns with ads in scope only
    const scopedCampaigns = found.campaigns.filter((c) => metaAds.some((a) => a.campaign_id === c.id && scopeOf(a)));
    const delWindow = sql.prepare("delete from ad_windows where window = ? and meta_ad_id in (select value from json_each(?))");
    const insWindow = sql.prepare(
      `insert into ad_windows (meta_ad_id, window, reach, impressions, frequency, synced_at) values (?, ?, ?, ?, ?, ?)
       on conflict (meta_ad_id, window) do update set reach = excluded.reach, impressions = excluded.impressions,
         frequency = excluded.frequency, synced_at = excluded.synced_at`,
    );
    for (const c of scopedCampaigns) {
      const adIds = JSON.stringify(metaAds.filter((a) => a.campaign_id === c.id).map((a) => a.id));
      for (const w of RUN_WINDOWS) {
        if (deps.isStopped()) throw new MetaGraphError("Stopped.");
        const rows = await graph.getAll<InsightRow>(`${c.id}/insights`, {
          level: "ad",
          date_preset: META_PRESET[w],
          fields: "ad_id,reach,impressions,frequency",
          limit: 500,
        });
        sql.transaction(() => {
          delWindow.run(w, adIds);
          for (const r of rows) {
            if (typeof r.ad_id !== "string") continue;
            insWindow.run(r.ad_id, w, num(r.reach), num(r.impressions), num(r.frequency), now);
          }
        })();
      }
    }

    // 7. channel numbers (every campaign = the whole account; else the widget's campaign-level pull)
    const windows = {} as Record<RunWindow, ChannelWindow>;
    for (const w of RUN_WINDOWS) {
      if (deps.isStopped()) throw new MetaGraphError("Stopped.");
      if (accountLevel) {
        windows[w] = pickChannel(await graph.getAll<InsightRow>(`${acc.act_id}/insights`, { level: "account", date_preset: META_PRESET[w], fields: CHANNEL_FIELDS }, 1));
      } else {
        const parts: ChannelWindow[] = [];
        for (const c of found.campaigns) {
          parts.push(pickChannel(await graph.getAll<InsightRow>(`${c.id}/insights`, { date_preset: META_PRESET[w], fields: CHANNEL_FIELDS }, 1)));
        }
        windows[w] = sumChannel(parts);
      }
    }
    const upChannel = sql.prepare(
      `insert into channel_metrics (account_id, window, date_start, date_stop, spend, impressions, reach, clicks, ctr, cpm, link_clicks,
         cost_per_link_click, meta_leads, synced_at)
       values (@account, @window, @dateStart, @dateStop, @spend, @impressions, @reach, @clicks, @ctr, @cpm, @linkClicks, @costPerLinkClick, @metaLeads, @now)
       on conflict (account_id, window) do update set date_start = excluded.date_start, date_stop = excluded.date_stop, spend = excluded.spend,
         impressions = excluded.impressions, reach = excluded.reach, clicks = excluded.clicks, ctr = excluded.ctr, cpm = excluded.cpm,
         link_clicks = excluded.link_clicks, cost_per_link_click = excluded.cost_per_link_click, meta_leads = excluded.meta_leads,
         synced_at = excluded.synced_at`,
    );
    sql.transaction(() => {
      for (const w of RUN_WINDOWS) upChannel.run({ account: acc.id, window: w, ...windows[w], now });
    })();

    // 8. Leads per the owner's leads_mode: `meta` reads no GHL at all; `ghl` / `auto` run the widget's GHL query with the
    //    owner's source (and the lane's location); `auto` counts Meta leads until GHL has one (non-test) such contact.
    const ghl = acc.leads_mode === "meta" ? null : deps.ghl(acc.identity);
    if (!ghl) {
      sql.prepare("update ad_accounts set leads_source = 'meta', ghl_error = null where id = ?").run(acc.id);
    } else if (!ghl.configured(acc.ghl_location_id)) {
      if (acc.leads_mode === "auto") {
        sql.prepare("update ad_accounts set leads_source = 'meta', ghl_error = null where id = ?").run(acc.id);
      } else {
        sql.prepare("update ad_accounts set leads_source = 'ghl', ghl_error = ? where id = ?").run(GHL_MISSING, acc.id);
      }
    } else {
      try {
        const { leads, complete } = await ghl.searchLeads(acc.ghl_source, acc.ghl_location_id);
        const stored = storeLeads(sql, acc, leads, tz, now, complete);
        const real = leads.filter((l) => !l.test).length;
        result.leads = real;
        result.attributed = stored.attributed;
        result.leadsComplete = complete;
        result.leadsRemoved = stored.removed;
        result.leadsKept = stored.kept;
        const source = leadsSourceFor(acc.leads_mode, real);
        // A partial read is recorded as a terse note on the account (shown with its errors); the stored leads stay.
        const note = complete ? null : `GHL returned a partial list (${leads.length} contacts): nothing removed, ${stored.kept} stored leads kept.`;
        if (note) deps.log(`meta: ${acc.code}: ${note}`);
        sql.prepare("update ad_accounts set leads_source = ?, ghl_synced_at = ?, ghl_error = ? where id = ?").run(source, now, note, acc.id);
      } catch (e) {
        // A GHL failure never drops the Meta numbers; the last good leads stay (`auto` keeps the source it had).
        const message = ((e as Error).message || "GHL failed").slice(0, 300);
        deps.log(`meta: ${acc.code}: GHL: ${message}`);
        if (acc.leads_mode === "auto") {
          sql.prepare("update ad_accounts set leads_source = coalesce(leads_source, 'meta'), ghl_error = ? where id = ?").run(message, acc.id);
        } else {
          sql.prepare("update ad_accounts set leads_source = 'ghl', ghl_error = ? where id = ?").run(message, acc.id);
        }
      }
    }

    // 9. matching, media names of unmatched ads, cached thumbnails
    const ctx = {
      mapRows: accountMapRows(deps.clientsDir, acc.code, acc.identity, deps.universalRegistry ?? null),
      clientId: acc.client_id,
      sectionId: acc.section_id,
      code: acc.identity === "fpc" ? acc.code : null,
    };
    result.match = matchAccountAds(sql, acc.id, ctx);
    if (await fetchMediaNames(sql, acc, graph, now, deps)) result.match = matchAccountAds(sql, acc.id, ctx);
    result.thumbs = await fetchThumbs(sql, acc, thumbUrl, deps);

    sql.prepare("update ad_accounts set last_sync_at = ?, error = null where id = ?").run(deps.now(), acc.id);
    result.ok = true;
    return result;
  } catch (e) {
    const message = ((e as Error).message || "Meta sync failed").slice(0, 300);
    sql.prepare("update ad_accounts set error = ? where id = ?").run(message, acc.id);
    result.error = message;
    if (e instanceof Error && e.name === "MetaThrottledError") throw e; // the queue waits
    return result;
  }
}

const MEDIA_RETRY_MS = 7 * 86_400_000;

/**
 * Matching step 2's input: the Meta video title / image name of each unmatched ad in the account, read once (a failed or
 * empty read is retried after 7 days). Returns true when a new name arrived.
 */
async function fetchMediaNames(sql: Sql, acc: AccountRow, graph: MetaGraph, now: number, deps: SyncDeps): Promise<boolean> {
  const rows = sql
    .prepare(
      `select id, creative from ads where account_id = ? and matched_asset_id is null
         and (media_name_at is null or (media_name is null and media_name_at < ?))`,
    )
    .all(acc.id, now - MEDIA_RETRY_MS) as { id: number; creative: string | null }[];
  if (!rows.length) return false;
  const byVideo = new Map<string, number[]>();
  const byHash = new Map<string, number[]>();
  for (const r of rows) {
    const c = readCreative(r.creative);
    const v = c?.videoIds[0];
    const h = c?.imageHashes[0];
    if (v) byVideo.set(v, [...(byVideo.get(v) ?? []), r.id]);
    else if (h) byHash.set(h, [...(byHash.get(h) ?? []), r.id]);
  }
  const names = new Map<number, string>();
  try {
    const ids = [...byVideo.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      if (deps.isStopped()) return false;
      const body = await graph.get<Record<string, { title?: string }>>("", { ids: ids.slice(i, i + 50).join(","), fields: "title" });
      for (const [vid, v] of Object.entries(body)) {
        const t = typeof v?.title === "string" ? v.title.trim() : "";
        if (t) for (const adId of byVideo.get(vid) ?? []) names.set(adId, t.slice(0, 300));
      }
    }
    if (byHash.size) {
      const imgs = await graph.getAll<{ hash?: string; name?: string }>(`${acc.act_id}/adimages`, {
        hashes: JSON.stringify([...byHash.keys()]),
        fields: "hash,name",
      });
      for (const img of imgs) {
        const n = typeof img.name === "string" ? img.name.trim() : "";
        if (img.hash && n) for (const adId of byHash.get(img.hash) ?? []) names.set(adId, n.slice(0, 300));
      }
    }
  } catch (e) {
    if (e instanceof Error && e.name === "MetaThrottledError") throw e;
    deps.log(`meta: ${acc.code}: media names: ${(e as Error).message}`);
  }
  const set = sql.prepare("update ads set media_name = coalesce(?, media_name), media_name_at = ? where id = ?");
  sql.transaction(() => {
    for (const r of rows) set.run(names.get(r.id) ?? null, now, r.id);
  })();
  return names.size > 0;
}

/** Download the Meta thumbnail once for each unmatched ad in scope (its URL comes from this sync's ads read). */
async function fetchThumbs(sql: Sql, acc: AccountRow, urls: Map<string, string>, deps: SyncDeps): Promise<number> {
  const rows = sql
    .prepare("select id, meta_ad_id from ads where account_id = ? and matched_asset_id is null and thumb_path is null")
    .all(acc.id) as { id: number; meta_ad_id: string }[];
  let n = 0;
  for (const r of rows) {
    if (deps.isStopped()) break;
    const url = urls.get(r.meta_ad_id);
    if (!url) continue;
    try {
      const rel = await cacheThumb(deps.cacheDir, r.meta_ad_id, url, deps.fetchThumb ?? httpThumbFetch);
      sql.prepare("update ads set thumb_path = ?, thumb_error = null where id = ?").run(rel, r.id);
      n++;
    } catch (e) {
      sql.prepare("update ads set thumb_error = ? where id = ?").run(((e as Error).message || "thumbnail failed").slice(0, 200), r.id);
    }
  }
  return n;
}
