/**
 * Meta copy becomes hooks (Phase 5 slice 2, PHASE-5 C; server only, SQL only, no network). Run by the worker after each
 * account's Meta sync (and once over every account when the queue starts); never by the web process.
 *
 * For every synced ad (the `ads` rows of an account):
 *  - candidates = every headline, and the first sentence of every primary (descriptions are not hooks). A primary's
 *    first sentence follows the copy doc import's rule: the first paragraph with its bullet lines (✅ and friends) and
 *    URL lines dropped, emoji stripped, then `firstSentence` (a sentence under 4 words takes the next one too).
 *  - a candidate whose normHook equals a text hook in the ad's channel (top level or kept variant, archived included:
 *    the same dedupe as addTextHooks) LINKS to it; new text becomes a `source = meta` hook in the channel (the account's
 *    client for the Lane B accounts, universal ads included; Lane C's channel for Lane C), `angle_slug` from the ad map's
 *    `angle_key` when known. Links live in `hook_ads` (hook, Meta ad id, role headline | primary | video).
 *  - the ad's matched file's video hook links with role `video`; a described, visible matched video with no video hook
 *    gets one first through addVideoHook (`ensureVideoHook`; an archived one is linked as is, never restored). Those
 *    new video hooks score on the current rubric like any other.
 *  - (slice 3) the ad's angle is stored on the ad (`ads.angle_key`: the map row's angle_key, else a universal ad's
 *    `universal:<registry id>`) for the test order rules.
 * Idempotent (insert or ignore on the link's key); never deletes a hook or a link, so an ad that stops running keeps its
 * links (history). New `meta` hooks are scored by the existing HookScoreQueue on the current rubric.
 *
 * Numbers beside a hook (`hookAdStats`): the SUM over its linked ads, all time: spend, impressions, clicks (CTR = clicks /
 * impressions from the sums), 3 second views / impressions of the video ads (hook rate), leads (GHL leads credited to
 * the ad; Meta leads for an account that counts Meta leads, Lane C today) and CPL = spend / leads. Shared credit: an ad's
 * numbers count in full for every hook it carries.
 */
import type Database from "better-sqlite3";
import { firstSentence } from "../hooks/text";
import { channelHref } from "../media";
import { HOOK_MAX_CHARS, normHook } from "../hooks/rubric";
import { ensureVideoHook } from "../hooks/video";
import { accountMapRows, mapRowFor, readCreative, type AdCreative, type MapRow } from "./match";

type Sql = Database.Database;

export type HookAdRole = "headline" | "primary" | "video";
export type CopyCandidate = { text: string; role: Exclude<HookAdRole, "video"> };

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;
/** A bullet line of a structured (v3) primary: ✅ / ✔ / ☑ / • / · / "- " / "* " first. */
const BULLET = /^(?:[✅✔☑✓•·▪●]|[-*]\s)/u;
const URL_LINE = /^(?:https?:\/\/|www\.)\S+$/i;

/** Emoji out, spacing collapsed. */
export function stripEmoji(s: string): string {
  return s.replace(EMOJI, " ").replace(/\s+/g, " ").trim();
}

/**
 * The hook line of one primary text: the first paragraph (up to a blank line) without its bullet or URL lines, emoji
 * stripped, lines joined, then its first sentence. null when nothing is left.
 */
export function primaryHookLine(primary: string): string | null {
  const lines = primary.replace(/\r\n?/g, "\n").split("\n");
  const para: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (para.length) break;
      continue;
    }
    if (BULLET.test(line) || URL_LINE.test(line)) continue;
    const clean = stripEmoji(line);
    if (clean) para.push(clean);
  }
  if (!para.length) return null;
  const text = firstSentence(para.join(" ")).trim().slice(0, HOOK_MAX_CHARS);
  return normHook(text) ? text : null;
}

/** Every hook candidate of a creative: its headlines, then each primary's first sentence (deduped by normHook). */
export function metaCopyCandidates(creative: Pick<AdCreative, "headlines" | "primaries"> | null): CopyCandidate[] {
  if (!creative) return [];
  const out: CopyCandidate[] = [];
  const seen = new Set<string>();
  const push = (text: string | null, role: CopyCandidate["role"]) => {
    if (!text) return;
    const t = text.slice(0, HOOK_MAX_CHARS);
    const n = normHook(t);
    if (!n || seen.has(`${role}|${n}`)) return;
    seen.add(`${role}|${n}`);
    out.push({ text: t, role });
  };
  for (const h of creative.headlines ?? []) push(stripEmoji(h), "headline");
  for (const p of creative.primaries ?? []) push(primaryHookLine(p), "primary");
  return out;
}

export type MetaHookStats = {
  ads: number;
  candidates: number;
  /** New `meta` hooks made. */
  created: number;
  /** Hooks that existed before this run (copy doc, pasted, video...) and got their first link from it. */
  linkedExisting: number;
  /** hook_ads rows inserted (all roles). */
  newLinks: number;
  videoLinks: number;
  /** Video hooks made for matched ad videos that had none (Phase 5 gate fix). */
  videoHooksCreated: number;
  /** Per channel key (client code or "fkb"): created / linked to an existing hook. */
  perChannel: Record<string, { created: number; linkedExisting: number }>;
};

type AccountInfo = { id: number; section_id: number; client_id: number | null; code: string; identity: string };

/**
 * Link every ad of these accounts (all accounts when omitted) to its hooks, making `meta` hooks for new text. SQL only;
 * `clientsDir` / `universalRegistry` give the ad maps for `angle_slug` (read only; missing files = no angle).
 */
export function syncMetaHooks(
  sql: Sql,
  opts: { accountIds?: number[]; clientsDir?: string | null; universalRegistry?: string | null; now?: number } = {},
): MetaHookStats {
  const now = opts.now ?? Date.now();
  const stats: MetaHookStats = { ads: 0, candidates: 0, created: 0, linkedExisting: 0, newLinks: 0, videoLinks: 0, videoHooksCreated: 0, perChannel: {} };
  const accounts = (
    sql
      .prepare(
        `select acc.id, acc.section_id, acc.client_id, coalesce(c.code, s.key) as code, acc.identity
           from ad_accounts acc join sections s on s.id = acc.section_id left join clients c on c.id = acc.client_id order by acc.sort, acc.id`,
      )
      .all() as AccountInfo[]
  ).filter((a) => !opts.accountIds || opts.accountIds.includes(a.id));
  const find = sql.prepare(
    `select id, source from hooks where section_id = ? and client_id is ? and kind = 'text' and (parent_id is null or kept = 1) and norm = ?
      order by (parent_id is null) desc, id limit 1`,
  );
  const insert = sql.prepare(
    `insert into hooks (section_id, client_id, kind, text, norm, source, angle_slug, created_at) values (?, ?, 'text', ?, ?, 'meta', ?, ?)`,
  );
  const fillAngle = sql.prepare("update hooks set angle_slug = ? where id = ? and source = 'meta' and angle_slug is null");
  const hadLinks = sql.prepare("select 1 from hook_ads where hook_id = ? limit 1");
  const link = sql.prepare("insert or ignore into hook_ads (hook_id, meta_ad_id, role, created_at) values (?, ?, ?, ?)");
  const videoHook = sql.prepare("select id from hooks where asset_id = ? and kind = 'video' and parent_id is null limit 1");
  const setAdAngle = sql.prepare("update ads set angle_key = @angle where meta_ad_id = @id and angle_key is not @angle");

  for (const acc of accounts) {
    const channel = stats.perChannel[acc.code] ?? { created: 0, linkedExisting: 0 };
    stats.perChannel[acc.code] = channel;
    let mapRows: MapRow[] = [];
    if (opts.clientsDir) mapRows = accountMapRows(opts.clientsDir, acc.code, acc.identity, opts.universalRegistry ?? null);
    const ads = sql
      .prepare("select meta_ad_id, name, creative, matched_asset_id from ads where account_id = ? order by id")
      .all(acc.id) as { meta_ad_id: string; name: string; creative: string | null; matched_asset_id: number | null }[];
    sql.transaction(() => {
      for (const ad of ads) {
        stats.ads++;
        const creative = readCreative(ad.creative);
        const mapRow = mapRows.length ? (mapRowFor(mapRows, { metaAdId: ad.meta_ad_id, name: ad.name, creative }, acc.code)?.row ?? null) : null;
        const angle = mapRow?.angleKey ?? null;
        // Slice 3 (test order): the ad's angle, a universal ad's registry id when the map row has no angle.
        setAdAngle.run({ angle: angle ?? (mapRow?.universalId ? `universal:${mapRow.universalId.toLowerCase()}` : null), id: ad.meta_ad_id });
        for (const c of metaCopyCandidates(creative)) {
          stats.candidates++;
          const norm = normHook(c.text);
          const hit = find.get(acc.section_id, acc.client_id, norm) as { id: number; source: string } | undefined;
          let hookId: number;
          if (hit) {
            hookId = hit.id;
            if (angle) fillAngle.run(angle, hookId);
            if (hit.source !== "meta" && !hadLinks.get(hookId)) {
              stats.linkedExisting++;
              channel.linkedExisting++;
            }
          } else {
            hookId = Number(insert.run(acc.section_id, acc.client_id, c.text, norm, angle, now).lastInsertRowid);
            stats.created++;
            channel.created++;
          }
          stats.newLinks += link.run(hookId, ad.meta_ad_id, c.role, now).changes;
        }
        if (ad.matched_asset_id) {
          if (ensureVideoHook(sql, ad.matched_asset_id, now)) stats.videoHooksCreated++;
          const v = videoHook.get(ad.matched_asset_id) as { id: number } | undefined;
          if (v) {
            const n = link.run(v.id, ad.meta_ad_id, "video", now).changes;
            stats.newLinks += n;
            stats.videoLinks += n;
          }
        }
      }
    })();
  }
  return stats;
}

// ------------------------------------------------------------------ numbers beside a hook

export type HookAdStats = {
  /** Distinct ads carrying the hook (any role), and how many are ACTIVE now. */
  ads: number;
  active: number;
  roles: HookAdRole[];
  spend: number;
  impressions: number;
  clicks: number;
  /** clicks / impressions x 100 from the sums (never an average of CTRs); null on 0 impressions. */
  ctr: number | null;
  /** Video ads only: 3 second views / impressions x 100; null when no linked video ad delivered. */
  hookRate: number | null;
  /** GHL leads credited to the ads (Meta leads for accounts that count Meta leads); null = never pulled. */
  leads: number | null;
  leadsSource: "ghl" | "meta" | "mixed";
  /** spend / leads; null on 0 leads. */
  cpl: number | null;
  /** The Running tab filtered to these ads (the channel that holds them). */
  runningHref: string;
};

type LinkRow = {
  hook_id: number;
  meta_ad_id: string;
  role: HookAdRole;
  spend: number | null;
  imp: number | null;
  clk: number | null;
  v3: number | null;
  ml: number | null;
  status: string | null;
  is_video: number | null;
  leads_source: string | null;
  ghl_synced_at: number | null;
  ghl: number;
  section: string | null;
  code: string | null;
};

/** The numbers beside each hook (only hooks with at least one linked ad appear in the map). */
export function hookAdStats(sql: Sql, hookIds: number[]): Map<number, HookAdStats> {
  const out = new Map<number, HookAdStats>();
  if (!hookIds.length) return out;
  const rows = sql
    .prepare(
      `with links as (select hook_id, meta_ad_id, role from hook_ads where hook_id in (select value from json_each(@ids))),
            agg as (select meta_ad_id, sum(spend) as spend, sum(impressions) as imp, sum(clicks) as clk, sum(video_3s) as v3,
                           sum(meta_leads) as ml, min(account_id) as account_id
                      from ad_metrics where meta_ad_id in (select meta_ad_id from links) group by meta_ad_id)
       select l.hook_id, l.meta_ad_id, l.role, agg.spend, agg.imp, agg.clk, agg.v3, agg.ml, ad.effective_status as status,
              json_extract(ad.creative, '$.isVideo') as is_video, acc.leads_source, acc.ghl_synced_at,
              (select count(*) from ghl_leads g where g.ad_id = l.meta_ad_id and g.test = 0) as ghl, s.key as section, c.code
         from links l left join agg on agg.meta_ad_id = l.meta_ad_id left join ads ad on ad.meta_ad_id = l.meta_ad_id
         left join ad_accounts acc on acc.id = coalesce(ad.account_id, agg.account_id)
         left join sections s on s.id = acc.section_id left join clients c on c.id = acc.client_id`,
    )
    .all({ ids: JSON.stringify(hookIds) }) as LinkRow[];
  const byHook = new Map<number, LinkRow[]>();
  for (const r of rows) byHook.set(r.hook_id, [...(byHook.get(r.hook_id) ?? []), r]);
  for (const [hookId, list] of byHook) {
    const ads = new Map<string, LinkRow>();
    const roles = new Set<HookAdRole>();
    for (const r of list) {
      roles.add(r.role);
      if (!ads.has(r.meta_ad_id)) ads.set(r.meta_ad_id, r);
    }
    let spend = 0,
      impressions = 0,
      clicks = 0,
      vImp = 0,
      v3 = 0,
      leads = 0,
      known = false,
      active = 0;
    const sources = new Set<string>();
    const channels = new Set<string>();
    for (const a of ads.values()) {
      spend += a.spend ?? 0;
      impressions += a.imp ?? 0;
      clicks += a.clk ?? 0;
      if (a.is_video) {
        vImp += a.imp ?? 0;
        v3 += a.v3 ?? 0;
      }
      if (a.status === "ACTIVE") active++;
      if (a.leads_source === "meta") {
        sources.add("meta");
        leads += a.ml ?? 0;
        known = true;
      } else if (a.ghl_synced_at != null) {
        sources.add("ghl");
        leads += a.ghl;
        known = true;
      }
      if (a.section) channels.add(a.section === "fkb" ? "fkb" : (a.code ?? "all"));
    }
    const only = channels.size === 1 ? [...channels][0] : null;
    const base = only === "fkb" ? channelHref("fkb", null, "running") : channelHref("fkbpros", only, "running");
    out.set(hookId, {
      ads: ads.size,
      active,
      roles: [...roles],
      spend,
      impressions,
      clicks,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      hookRate: vImp > 0 ? (v3 / vImp) * 100 : null,
      leads: known ? leads : null,
      leadsSource: sources.size > 1 ? "mixed" : sources.has("ghl") ? "ghl" : "meta",
      cpl: known && leads > 0 ? spend / leads : null,
      runningHref: `${base}?hook=${hookId}&status=all&w=lifetime`,
    });
  }
  return out;
}

/** SQL for sorting hooks by their ads' numbers (joined as `hm`: spend, imp, clk summed over distinct linked ads). */
export const HOOK_METRICS_JOIN = `left join (select ha.hook_id, sum(m.spend) as spend, sum(m.impressions) as imp, sum(m.clicks) as clk
    from (select distinct hook_id, meta_ad_id from hook_ads) ha join ad_metrics m on m.meta_ad_id = ha.meta_ad_id group by ha.hook_id) hm
  on hm.hook_id = h.id`;
