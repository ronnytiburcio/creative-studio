/**
 * Meta sync state shared by the app (server actions, status, Settings, Jobs) and the worker (server only). The web
 * process never calls Meta or GHL: it only sets a request / pause in app_settings and edits links; the worker's
 * MetaSyncQueue does every read.
 *
 * Schedule: once a day at 18:00 America/New_York per account (the owner 2026-10-06, was 06:00: the day's numbers are then
 * nearly complete; an account is due when its last successful sync is older than the latest 18:00; a failed account is
 * retried at most hourly), plus "Refresh" (`meta:sync_requested_at`, every
 * account, runs even while paused), minus Pause (`meta:paused`, the daily run waits).
 */
import path from "node:path";
import type Database from "better-sqlite3";
import { numSetting, pausedSetting, requestPending, setPausedSetting, stampRequest } from "../queue-settings";
import { localDayStart, localTimeOn } from "../ai/jev";
import { channelHref } from "../media";
import { accountMapRows, matchAccountAds } from "./match";
import { ACTIVE_ACCOUNT_SQL } from "./sync";
import { linkedByText } from "../profile";

type Sql = Database.Database;

export const META_PAUSED_KEY = "meta:paused";
export const META_REQUEST_KEY = "meta:sync_requested_at";
export const META_RUN_STARTED_KEY = "meta:last_run_started_at";
export const META_RUN_FINISHED_KEY = "meta:last_run_finished_at";

export const SYNC_TZ = "America/New_York";
/** Meta + GHL daily sync hour (New York wall clock). YouTube keeps its own 06:00 (youtube/store.ts YT_SYNC_HOUR). */
export const SYNC_HOUR = 18;
/** A failed account is tried again by the schedule at most this often. */
export const RETRY_MS = 60 * 60_000;

export function metaPaused(sql: Sql): boolean {
  return pausedSetting(sql, META_PAUSED_KEY);
}

export function setMetaPaused(sql: Sql, paused: boolean) {
  setPausedSetting(sql, META_PAUSED_KEY, paused);
}

/** Refresh: the worker syncs every account on its next poll (within ~15 s), even while paused. */
export function requestMetaSync(sql: Sql, now = Date.now()) {
  stampRequest(sql, META_REQUEST_KEY, now);
}

/** A Refresh newer than the last run's start. */
export function metaRequestPending(sql: Sql): boolean {
  return requestPending(sql, META_REQUEST_KEY, META_RUN_STARTED_KEY);
}

/** The latest `hour`:00 America/New_York (wall clock, so DST days too) at or before `now` (default: the Meta sync's 18:00). */
export function lastSlot(now = Date.now(), hour = SYNC_HOUR): number {
  const today = localTimeOn(now, hour, SYNC_TZ);
  return today <= now ? today : localTimeOn(localDayStart(now, SYNC_TZ) - 12 * 3_600_000, hour, SYNC_TZ);
}

/** The next `hour`:00 America/New_York (wall clock) after `now`. */
export function nextSlot(now = Date.now(), hour = SYNC_HOUR): number {
  return lastSlot(lastSlot(now, hour) + 30 * 3_600_000, hour);
}

/** Accounts the daily schedule wants now (ids). */
export function scheduledAccountIds(sql: Sql, now = Date.now()): number[] {
  const slot = lastSlot(now);
  return (
    sql
      .prepare(
        `select acc.id from ad_accounts acc join sections s on s.id = acc.section_id left join clients c on c.id = acc.client_id
          where ${ACTIVE_ACCOUNT_SQL}
            and coalesce(acc.last_sync_at, 0) < @slot
            and (coalesce(acc.last_attempt_at, 0) < @slot or coalesce(acc.last_attempt_at, 0) <= @retry)
          order by acc.sort, acc.id`,
      )
      .all({ slot, retry: now - RETRY_MS }) as { id: number }[]
  ).map((r) => r.id);
}

export type MetaSummary = {
  paused: boolean;
  /** A Refresh is waiting for the worker. */
  requested: boolean;
  lastRunStartedAt: number | null;
  lastRunFinishedAt: number | null;
  /** Oldest last good sync over all accounts (null when any account never synced). */
  oldestSyncAt: number | null;
  newestSyncAt: number | null;
  nextRunAt: number;
  accounts: number;
  errors: number;
  callsToday: number;
};

export function metaSummary(sql: Sql, now = Date.now()): MetaSummary {
  const acc = sql
    .prepare(
      `select count(*) as n, sum(acc.error is not null or acc.ghl_error is not null) as errors,
              min(coalesce(acc.last_sync_at, 0)) as oldest, max(acc.last_sync_at) as newest
         from ad_accounts acc join sections s on s.id = acc.section_id left join clients c on c.id = acc.client_id
        where ${ACTIVE_ACCOUNT_SQL}`,
    )
    .get() as { n: number; errors: number | null; oldest: number | null; newest: number | null };
  const callsToday = sql.prepare("select count(*) from meta_calls where at >= ?").pluck().get(localDayStart(now, SYNC_TZ)) as number;
  const paused = metaPaused(sql);
  return {
    paused,
    requested: metaRequestPending(sql),
    lastRunStartedAt: numSetting(sql, META_RUN_STARTED_KEY),
    lastRunFinishedAt: numSetting(sql, META_RUN_FINISHED_KEY),
    oldestSyncAt: acc.oldest ? acc.oldest : null,
    newestSyncAt: acc.newest ?? null,
    nextRunAt: nextSlot(now),
    accounts: acc.n,
    errors: acc.errors ?? 0,
    callsToday,
  };
}

export type MetaAccountView = {
  id: number;
  code: string;
  label: string;
  sectionKey: string;
  actId: string;
  identity: string;
  timezone: string | null;
  campaignSource: string | null;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  error: string | null;
  leadsSource: string | null;
  ghlSyncedAt: number | null;
  ghlError: string | null;
  ads: number;
  active: number;
  href: string;
};

/** One line per account for Settings and the Jobs page. */
export function metaAccounts(sql: Sql): MetaAccountView[] {
  const rows = sql
    .prepare(
      `select acc.id, coalesce(c.code, s.key) as code, coalesce(c.name, s.name) as label, s.key as section_key, acc.act_id, acc.identity,
              acc.timezone, acc.campaign_source, acc.last_sync_at, acc.last_attempt_at, acc.error, acc.leads_source, acc.ghl_synced_at,
              acc.ghl_error,
              (select count(*) from ads a where a.account_id = acc.id) as ads,
              (select count(*) from ads a where a.account_id = acc.id and a.effective_status = 'ACTIVE') as active
         from ad_accounts acc join sections s on s.id = acc.section_id left join clients c on c.id = acc.client_id
        where ${ACTIVE_ACCOUNT_SQL}
        order by acc.sort, acc.id`,
    )
    .all() as {
    id: number;
    code: string;
    label: string;
    section_key: string;
    act_id: string;
    identity: string;
    timezone: string | null;
    campaign_source: string | null;
    last_sync_at: number | null;
    last_attempt_at: number | null;
    error: string | null;
    leads_source: string | null;
    ghl_synced_at: number | null;
    ghl_error: string | null;
    ads: number;
    active: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label.split(" / ")[0],
    sectionKey: r.section_key,
    actId: r.act_id,
    identity: r.identity,
    timezone: r.timezone,
    campaignSource: r.campaign_source,
    lastSyncAt: r.last_sync_at,
    lastAttemptAt: r.last_attempt_at,
    error: r.error,
    leadsSource: r.leads_source,
    ghlSyncedAt: r.ghl_synced_at,
    ghlError: r.ghl_error,
    ads: r.ads,
    active: r.active,
    href: channelHref(r.section_key, r.code, "running"),
  }));
}

export class LinkError extends Error {}

/**
 * "Link a file": the ad's matched asset set by the owner (match_source manual, never overwritten by a sync). The asset must
 * be visible (present, not hidden, root enabled) and in the ad's section.
 */
export function linkAd(sql: Sql, adId: number, assetId: number): { filename: string } {
  const ad = sql
    .prepare("select a.id, acc.section_id from ads a join ad_accounts acc on acc.id = a.account_id where a.id = ?")
    .get(adId) as { id: number; section_id: number } | undefined;
  if (!ad) throw new LinkError("Ad not found.");
  const asset = sql
    .prepare(
      `select a.id, a.filename, a.section_id from assets a join roots r on r.id = a.root_id
        where a.id = ? and a.missing = 0 and a.ignored = 0 and r.enabled = 1`,
    )
    .get(assetId) as { id: number; filename: string; section_id: number } | undefined;
  if (!asset) throw new LinkError("That file is not in the Library.");
  if (asset.section_id !== ad.section_id) throw new LinkError("Pick a file from this channel's Library.");
  sql.prepare("update ads set matched_asset_id = ?, match_source = 'manual', match_detail = ? where id = ?").run(asset.id, linkedByText(), ad.id);
  return { filename: asset.filename };
}

/**
 * Unlink a manual link: the ad goes back to the automatic matching (the ad map, then the Meta media name) at once.
 * Only manual links can be unlinked.
 */
export function unlinkAd(sql: Sql, adId: number, clientsDir: string, universalFile: string | null = null): { rematched: boolean } {
  const ad = sql
    .prepare(
      `select a.id, a.account_id, a.match_source, acc.identity, acc.client_id, acc.section_id, c.code
         from ads a join ad_accounts acc on acc.id = a.account_id left join clients c on c.id = acc.client_id where a.id = ?`,
    )
    .get(adId) as { id: number; account_id: number; match_source: string | null; identity: string; client_id: number | null; section_id: number; code: string | null } | undefined;
  if (!ad) throw new LinkError("Ad not found.");
  if (ad.match_source !== "manual") throw new LinkError("Only a file you linked can be unlinked.");
  sql.prepare("update ads set matched_asset_id = null, match_source = null, match_detail = null where id = ?").run(ad.id);
  const mapRows = accountMapRows(clientsDir, ad.code, ad.identity, universalFile);
  matchAccountAds(sql, ad.account_id, { mapRows, clientId: ad.client_id, sectionId: ad.section_id, code: ad.code, onlyAdIds: [ad.id] });
  const after = sql.prepare("select matched_asset_id from ads where id = ?").pluck().get(ad.id) as number | null;
  return { rematched: after != null };
}

/** META_ENV_FILE's folder: it holds META_ENV_FILE and one folder per client code (state files, ad maps). */
export function metaClientsDir(metaEnvFile: string): string {
  return path.dirname(metaEnvFile);
}
