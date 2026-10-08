/**
 * Meta ad -> creative parsing and ad -> local file matching (server only, Phase 5 B1).
 *
 * Matching order (a `manual` link is never touched):
 *  1. the client's `video_script_map.json` (`<code>/` in META_ENV_FILE's folder, read only): the row with this ad id, else this
 *     creative id, else one of this ad's video ids, else this ad name (normalized), else this ad's number ("...-Ad-06",
 *     "<client prefix>-<code>-...-11", profile ads.clientPrefix = the row whose `n` is 6 / 11; older maps carry no
 *     ids); a universal ad ("...-Universal-<id>") uses the universal registry (META_UNIVERSAL_REGISTRY) instead. -> its `video` /
 *     `image` file -> a visible asset (an absolute path matches that exact file; otherwise the file name, preferring an
 *     asset tagged to the ad's client, then the channel's section, then a path ending in the map's relative path).
 *  2. the Meta video title / image name (read once by the sync) against file names (with or without the extension; an
 *     image name Meta suffixed like "<prefix>-<file>.png_105" matches the file it ends with).
 *  3. "Link a file" on the card (match_source manual).
 * No Jev, no description comparison.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { profile } from "../profile";

type Sql = Database.Database;

/** What Studio keeps of an ad's creative (ads.creative JSON). */
export type AdCreative = {
  id: string | null;
  headlines: string[];
  primaries: string[];
  descriptions: string[];
  ctas: string[];
  videoIds: string[];
  /** Image hashes of the ad's media (not a video's thumbnail image). */
  imageHashes: string[];
  isVideo: boolean;
  link: string | null;
};

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const push = (list: string[], v: unknown) => {
  const t = s(v);
  if (t && !list.includes(t)) list.push(t);
};

/** Meta's creative object (with object_story_spec / asset_feed_spec) -> AdCreative. */
export function parseCreative(raw: unknown): AdCreative {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: AdCreative = { id: s(c.id), headlines: [], primaries: [], descriptions: [], ctas: [], videoIds: [], imageHashes: [], isVideo: false, link: null };
  const afs = (c.asset_feed_spec ?? null) as Record<string, unknown> | null;
  const oss = (c.object_story_spec ?? null) as Record<string, unknown> | null;
  const texts = (list: unknown, key = "text") => (Array.isArray(list) ? list.map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>)[key] : null)) : []);
  if (afs) {
    for (const t of texts(afs.titles)) push(out.headlines, t);
    for (const t of texts(afs.bodies)) push(out.primaries, t);
    for (const t of texts(afs.descriptions)) push(out.descriptions, t);
    if (Array.isArray(afs.call_to_action_types)) for (const t of afs.call_to_action_types) push(out.ctas, t);
    for (const v of texts(afs.videos, "video_id")) push(out.videoIds, v);
    for (const h of texts(afs.images, "hash")) push(out.imageHashes, h);
    const links = texts(afs.link_urls, "website_url");
    out.link = s(links[0]) ?? null;
  }
  if (oss) {
    const video = (oss.video_data ?? null) as Record<string, unknown> | null;
    const link = (oss.link_data ?? null) as Record<string, unknown> | null;
    const photo = (oss.photo_data ?? null) as Record<string, unknown> | null;
    if (video) {
      push(out.headlines, video.title);
      push(out.primaries, video.message);
      push(out.descriptions, video.link_description);
      const cta = (video.call_to_action ?? null) as Record<string, unknown> | null;
      push(out.ctas, cta?.type);
      push(out.videoIds, video.video_id);
      out.link ??= s((cta?.value as Record<string, unknown> | undefined)?.link);
    }
    if (link) {
      push(out.headlines, link.name);
      push(out.primaries, link.message);
      push(out.descriptions, link.description);
      const cta = (link.call_to_action ?? null) as Record<string, unknown> | null;
      push(out.ctas, cta?.type);
      push(out.imageHashes, link.image_hash);
      out.link ??= s(link.link);
    }
    if (photo) {
      push(out.primaries, photo.caption);
      push(out.imageHashes, photo.image_hash);
    }
  }
  push(out.headlines, c.title);
  push(out.primaries, c.body);
  push(out.ctas, c.call_to_action_type);
  push(out.videoIds, c.video_id);
  if (!out.videoIds.length) push(out.imageHashes, c.image_hash);
  out.isVideo = out.videoIds.length > 0;
  return out;
}

export function readCreative(json: string | null): AdCreative | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as AdCreative;
  } catch {
    return null;
  }
}

/** Ad name key: NFKC, lower case, spacing collapsed. */
export function normAdName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Meta's duplicate suffixes dropped ("Ad-05-Copy", "Ad 05 - Copy 2"): the last-chance name key. */
export function stripCopy(key: string): string {
  let k = key;
  for (let i = 0; i < 3; i++) k = k.replace(/[\s_-]*(?:-\s*)?copy(?:\s*\d+)?$/i, "").trim();
  return k;
}

// ------------------------------------------------------------------ video_script_map.json

export type MapRow = {
  adId: string | null;
  creativeId: string | null;
  videoId: string | null;
  adName: string | null;
  /** The map's ad number (`n`, else `ad`), for maps whose rows carry no ids or names. */
  n: number | null;
  file: string | null;
  /** Universal registry rows: the registry id ("sizzle_01"). */
  universalId?: string | null;
  /** Universal registry rows: the registry's file name (shown in the match detail). */
  registry?: string | null;
  /** The copy doc angle slug (`angle_key`), when the map gives one: Meta hooks take it as their `angle_slug`. */
  angleKey?: string | null;
};

/** The client's ad -> file map (schema 2 `ads` list), or [] when missing / unreadable. Read only. */
export function loadScriptMap(clientsDir: string, code: string): MapRow[] {
  if (!/^[a-z0-9]{2,32}$/.test(code)) return [];
  const file = path.join(clientsDir, code, "video_script_map.json");
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = (data as { ads?: unknown }).ads;
  if (!Array.isArray(list)) return [];
  const idStr = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() || null : null);
  return list
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => ({
      adId: idStr(r.ad_id),
      creativeId: idStr(r.creative_id),
      videoId: idStr(r.video_id),
      adName: s(r.ad_name),
      n: numOf(r.n) ?? numOf(r.ad),
      file: s(r.video) ?? s(r.image),
      angleKey: s(r.angle_key),
    }));
}

const numOf = (v: unknown): number | null => {
  const t = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^\d{1,3}$/.test(t) ? Number(t) : null;
};

/**
 * The universal ads registry (META_UNIVERSAL_REGISTRY, default `<drive>/shared-ads.json`; read only): id -> render,
 * as map rows. The file paths are relative to the registry's folder (so they match by file name). [] when missing (drive
 * unplugged, or an install without one).
 */
export function loadUniversalRegistry(file: string | null): MapRow[] {
  if (!file) return [];
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = (data as { ads?: unknown }).ads;
  if (!Array.isArray(list)) return [];
  return list
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => ({ adId: null, creativeId: null, videoId: null, adName: null, n: null, file: s(r.video) ?? s(r.image), universalId: s(r.id), registry: path.basename(file) }))
    .filter((r) => r.universalId && r.file);
}

/** An ad name's number for the map's `n`: "...-Ad-06", "...-Ad-13-P", or "<prefix>-<code>-...-11". Universal ads have none. */
export function adNumber(name: string, code: string | null): number | null {
  if (/universal/i.test(name)) return null;
  const a = /(?:^|[-_ ])Ad[-_ ]?(\d{1,3})(?:-[A-Za-z]{1,3})?$/i.exec(name);
  if (a) return Number(a[1]);
  const prefix = profile().ads.clientPrefix.toLowerCase();
  if (code && name.toLowerCase().startsWith(`${prefix ? `${prefix}-` : ""}${code.toLowerCase()}-`)) {
    const b = /-(\d{1,3})$/.exec(name);
    if (b) return Number(b[1]);
  }
  return null;
}

/** The map row for an ad: ad id, else creative id, else a video id, else the ad name, else the universal id, else the ad number. */
export function mapRowFor(
  rows: MapRow[],
  ad: { metaAdId: string; name: string; creative: AdCreative | null },
  code: string | null = null,
): { row: MapRow; by: string } | null {
  const byId = rows.find((r) => r.adId === ad.metaAdId);
  if (byId) return { row: byId, by: "ad id" };
  const cid = ad.creative?.id;
  const byCreative = cid ? rows.find((r) => r.creativeId === cid) : undefined;
  if (byCreative) return { row: byCreative, by: "creative id" };
  const vids = ad.creative?.videoIds ?? [];
  const byVideo = rows.find((r) => r.videoId && vids.includes(r.videoId));
  if (byVideo) return { row: byVideo, by: "video id" };
  const key = normAdName(ad.name);
  const byName = rows.find((r) => r.adName && normAdName(r.adName) === key) ?? rows.find((r) => r.adName && stripCopy(normAdName(r.adName)) === stripCopy(key));
  if (byName) return { row: byName, by: "ad name" };
  const uni = /universal[-_ ]+(.+)$/i.exec(stripCopy(ad.name.trim()));
  if (uni) {
    const id = uni[1].toLowerCase();
    const hit = rows.find((r) => r.universalId && r.universalId.toLowerCase() === id);
    return hit ? { row: hit, by: "universal registry" } : null;
  }
  const n = adNumber(ad.name, code);
  const byNumber = n != null ? rows.find((r) => r.n === n && r.file && !r.adId && !r.adName) : undefined;
  return byNumber ? { row: byNumber, by: "ad number" } : null;
}

// ------------------------------------------------------------------ assets

const VISIBLE_ASSET = "a.missing = 0 and a.ignored = 0 and r.enabled = 1";

/** The asset for a map file (absolute = exact path; else the file name, best candidate first). */
export function assetForFile(sql: Sql, file: string, prefs: { clientId: number | null; sectionId: number }): number | null {
  if (path.isAbsolute(file)) {
    const exact = sql
      .prepare(`select a.id from assets a join roots r on r.id = a.root_id where a.path = ? and ${VISIBLE_ASSET}`)
      .pluck()
      .get(path.normalize(file)) as number | undefined;
    if (exact) return exact;
  }
  const base = path.basename(file);
  const rel = file.includes("/") && !path.isAbsolute(file) ? `%/${file.replace(/[\\%_]/g, (m) => "\\" + m)}` : null;
  return (
    (sql
      .prepare(
        `select a.id from assets a join roots r on r.id = a.root_id
          where lower(a.filename) = lower(@base) and ${VISIBLE_ASSET}
          order by exists (select 1 from asset_clients ac where ac.asset_id = a.id and ac.client_id = @client) desc,
                   (a.section_id = @section) desc,
                   (@rel is not null and a.path like @rel escape '\\') desc,
                   a.id
          limit 1`,
      )
      .pluck()
      .get({ base, client: prefs.clientId ?? -1, section: prefs.sectionId, rel }) as number | undefined) ?? null
  );
}

/**
 * A media name with its spacing dropped and the profile's `ads.mediaPrefix` removed (a filmer's initials in front of the
 * media name: "<prefix> Ad 2.mov" is the file "Ad2.mov"). Compared, case-insensitively, with a file name with its spacing
 * dropped, in the ad's own section only. null when too short to be safe.
 */
export function compactMediaName(name: string): string | null {
  const mp = profile().ads.mediaPrefix;
  const rest = (mp ? new RegExp(`^${mp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.+)$`, "i").exec(name.trim())?.[1] : null) ?? name;
  const c = rest.toLowerCase().replace(/\s+/g, "");
  return c.length >= 6 && /\.[a-z0-9]{2,5}$/.test(c) ? c : null;
}

/**
 * The asset for a Meta media name (video title / image name): the file name, its stem when the name has no extension,
 * the same name with spacing / Lane C's filmer prefix (profile ads.companyPrefix) dropped in the ad's own section
 * (compactMediaName), or (8+ character file names) the file name the media name ends with after a separator ("<client prefix>-acme-18-x.png_105").
 */
export function assetForMediaName(sql: Sql, name: string, prefs: { clientId: number | null; sectionId: number }): number | null {
  const base = path.basename(name.trim()).replace(/(\.[a-z0-9]{2,5})_\d+$/i, "$1");
  if (!base || base.length > 300) return null;
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(base);
  const compact = compactMediaName(base);
  return (
    (sql
      .prepare(
        `select a.id from assets a join roots r on r.id = a.root_id
          where ${VISIBLE_ASSET} and (lower(a.filename) = lower(@base)
            or (@noext = 1 and lower(a.filename) like lower(@stem) escape '\\')
            or (@compact is not null and a.section_id = @section and replace(lower(a.filename), ' ', '') = @compact)
            or (@ext = 1 and length(a.filename) >= 8 and length(a.filename) < length(@base)
                and substr(lower(@base), -length(a.filename)) = lower(a.filename)
                and substr(@base, length(@base) - length(a.filename), 1) in ('-', '_', ' ')))
          order by lower(a.filename) = lower(@base) desc,
                   (@compact is not null and replace(lower(a.filename), ' ', '') = @compact) desc,
                   exists (select 1 from asset_clients ac where ac.asset_id = a.id and ac.client_id = @client) desc,
                   (a.section_id = @section) desc, length(a.filename) desc, a.id
          limit 1`,
      )
      .pluck()
      .get({
        base,
        noext: hasExt ? 0 : 1,
        ext: hasExt ? 1 : 0,
        stem: `${base.replace(/[\\%_]/g, (m) => "\\" + m)}.%`,
        compact,
        client: prefs.clientId ?? -1,
        section: prefs.sectionId,
      }) as number | undefined) ?? null
  );
}

/** Every map row an account's ads match against: the client's ad map + the universal registry (Lane C: none). */
export function accountMapRows(clientsDir: string, code: string | null, identity: string, universalFile: string | null): MapRow[] {
  if (identity !== "fpc" || !code) return [];
  return [...loadScriptMap(clientsDir, code), ...loadUniversalRegistry(universalFile)];
}


export type MatchStats = { map: number; name: number; manual: number; none: number };

/**
 * Re-match every ad of an account (manual links kept). `onlyAdIds` limits it to some ads (Unlink). Returns the counts
 * by source after the pass.
 */
export function matchAccountAds(
  sql: Sql,
  accountId: number,
  ctx: { mapRows: MapRow[]; clientId: number | null; sectionId: number; code?: string | null; onlyAdIds?: number[] },
): MatchStats {
  const ads = sql
    .prepare("select id, meta_ad_id, name, creative, media_name, matched_asset_id, match_source from ads where account_id = ?")
    .all(accountId) as {
    id: number;
    meta_ad_id: string;
    name: string;
    creative: string | null;
    media_name: string | null;
    matched_asset_id: number | null;
    match_source: string | null;
  }[];
  const set = sql.prepare("update ads set matched_asset_id = ?, match_source = ?, match_detail = ? where id = ?");
  const stats: MatchStats = { map: 0, name: 0, manual: 0, none: 0 };
  const prefs = { clientId: ctx.clientId, sectionId: ctx.sectionId };
  sql.transaction(() => {
    for (const ad of ads) {
      if (ad.match_source === "manual" && ad.matched_asset_id) {
        stats.manual++;
        continue;
      }
      if (ctx.onlyAdIds && !ctx.onlyAdIds.includes(ad.id)) {
        if (ad.match_source === "map" || ad.match_source === "name") stats[ad.match_source]++;
        else stats.none++;
        continue;
      }
      let assetId: number | null = null;
      let source: "map" | "name" | null = null;
      let detail: string | null = null;
      const hit = mapRowFor(ctx.mapRows, { metaAdId: ad.meta_ad_id, name: ad.name, creative: readCreative(ad.creative) }, ctx.code ?? null);
      if (hit?.row.file) {
        assetId = assetForFile(sql, hit.row.file, prefs);
        if (assetId) {
          source = "map";
          detail = `${hit.row.universalId ? (hit.row.registry ?? "universal registry") : "video_script_map.json"} (${hit.by}): ${path.basename(hit.row.file)}`;
        }
      }
      if (!assetId && ad.media_name) {
        assetId = assetForMediaName(sql, ad.media_name, prefs);
        if (assetId) {
          source = "name";
          detail = `Meta media name: ${path.basename(ad.media_name)}`;
        }
      }
      if (assetId !== ad.matched_asset_id || source !== ad.match_source) set.run(assetId, source, detail, ad.id);
      stats[source ?? "none"]++;
    }
  })();
  return stats;
}
