/**
 * New PAUSED ad dialog data (Phase 6 slice 3, E1 + E2; server only, read only): the channel (the Lane B clients + Lane C,
 * never Lane A) and its ad account, the media check (a visible video / image of the channel, opened only through
 * originalFileFor), the copy prefill (the hook as headline 1 or primary 1's opening line + the hook's angle block from the
 * approved copy doc / ad map), the concept + ps|obj prefill, the name preview with the next number ("assigned when
 * applied"), the read-only context lines (Testing slots for Lane B, the active ad set for Lane C) and the rule context the
 * dialog checks against. Nothing here writes anything; the order writer is src/lib/meta/orders.ts.
 */
import fs from "node:fs";
import type Database from "better-sqlite3";
import { notMountedMessage, type StudioConfig } from "../config";
import { originalFileFor } from "../originals";
import { clientShortName } from "../media";
import { firstSentence } from "../hooks/text";
import { companyName, FKB_NOTE_KEY, getNoteRow } from "../hooks/notes";
import { laneNames } from "../clients-admin";
import { fill, profile } from "../profile";
import { normHook } from "../hooks/rubric";
import { videoAdLine } from "../hooks/video";
import { adNumber, readCreative } from "./match";
import { metaClientsDir } from "./store";
import { parseFpcName, readClientAdMap, readCopyDocBlocks, type AngleBlock, type ClientAdMap } from "./ad-map";
import { conceptFrom, HEADLINE_FIT, namePreview, type AdCopy, type AdNaming, type AdRuleContext, type PsObj } from "./ad-copy-rules";

type Sql = Database.Database;

/** A Lane B client's landing page (the profile's `adCopy.landing.client`, `{code}` filled; "" = none set). */
export function clientLanding(code: string): string {
  return fill(profile().adCopy.landing.client, { code });
}
/** Lane C's landing page (the profile's `adCopy.landing.company`; "" = none set). */
export function companyLanding(): string {
  return profile().adCopy.landing.company;
}

/** The ad name conventions (the profile's `ads`), as the dialog and the order writer use them. */
export function adNaming(): AdNaming {
  const a = profile().ads;
  return { clientPrefix: a.clientPrefix, companyPrefix: a.companyPrefix, conceptExample: a.conceptExample };
}
/** Meta's video upload breaks above ~100 MB (the sweep's learnings); 22 to 45 MB uploads best. */
export const VIDEO_REFUSE_BYTES = 100 * 1024 * 1024;
export const VIDEO_WARN_BYTES = 45 * 1024 * 1024;
/** Meta's ad image limit. */
export const IMAGE_REFUSE_BYTES = 30 * 1024 * 1024;
export const VIDEO_EXTS = ["mp4", "mov", "m4v"];
export const IMAGE_EXTS = ["jpg", "jpeg", "png"];
/**
 * Lane B Testing seats (display only; Studio never enforces them): 4 seats = 3 video + 1 static, mirroring
 * `_lib/ad_rules.py` (META_ENV_FILE's folder) TESTING_SEATS / TESTING_VIDEO_SEATS / TESTING_STATIC_SEATS. A seat is
 * counted here as an ACTIVE synced Testing ad; the apply skill counts held seats by its own verdicts when it applies.
 */
export const TESTING_SEATS = 4;
export const VIDEO_SEATS = 3;
export const STATIC_SEATS = 1;

export type AdChannel = {
  section: "fkbpros" | "fkb";
  /** The client code, or `fkb`. */
  code: string;
  clientId: number | null;
  sectionId: number;
  label: string;
  actId: string | null;
  accountId: number | null;
  landing: string;
  /** The client's folder under STUDIO_CLIENT_DOCS_DIR (approved copy doc), or null (none; always null for Lane C). */
  folder: string | null;
};

/** The channels a new ad can go to: the visible Lane B clients (sidebar order) and Lane C (while its lane is on). */
export function adChannels(sql: Sql): AdChannel[] {
  const clients = sql
    .prepare(
      `select c.id, c.code, c.name, c.section_id, c.folder, a.act_id, a.id as account_id from clients c join sections s on s.id = c.section_id
         left join ad_accounts a on a.client_id = c.id where s.key = 'fkbpros' and c.hidden_at is null order by c.sort, c.id`,
    )
    .all() as { id: number; code: string; name: string; section_id: number; folder: string | null; act_id: string | null; account_id: number | null }[];
  const fkb = sql
    .prepare(`select s.id as section_id, s.name, a.act_id, a.id as account_id from sections s left join ad_accounts a on a.section_id = s.id and a.client_id is null where s.key = 'fkb' and s.enabled = 1`)
    .get() as { section_id: number; name: string; act_id: string | null; account_id: number | null } | undefined;
  const out: AdChannel[] = clients.map((c) => ({
    section: "fkbpros",
    code: c.code,
    clientId: c.id,
    sectionId: c.section_id,
    label: clientShortName(c.name),
    actId: c.act_id,
    accountId: c.account_id,
    landing: clientLanding(c.code),
    folder: c.folder,
  }));
  if (fkb) out.push({ section: "fkb", code: "fkb", clientId: null, sectionId: fkb.section_id, label: fkb.name, actId: fkb.act_id, accountId: fkb.account_id, landing: companyLanding(), folder: null });
  return out;
}

export function adChannel(sql: Sql, code: string | null | undefined): AdChannel | null {
  if (!code) return null;
  return adChannels(sql).find((c) => c.code === code) ?? null;
}

/** The profile's house rules for a channel's ad copy (server only; carried in the AdRuleContext to the dialog). */
export function adHouseRules(section: "fkbpros" | "fkb", code: string): AdRuleContext["house"] {
  const P = profile();
  return {
    dashes: P.copyRules.dashes.ads,
    banClientNames: P.copyRules.banClientNames[section],
    nameMessage: section === "fkb" ? P.copyRules.messages.adCompanyName : P.copyRules.messages.adClientName,
    bans: [...(P.copyRules.bans[code] ?? [])],
    palette: [...P.adCopy.emojiPalette],
  };
}

/** The rule context for the copy checks (the dialog runs it live; Stage runs it again). */
export function adRuleContext(sql: Sql, cfg: Pick<StudioConfig, "metaEnvFile">, ch: AdChannel): AdRuleContext {
  const allClients = (
    sql.prepare("select c.code, c.name, c.brand_notes from clients c join sections s on s.id = c.section_id where s.key = 'fkbpros' order by c.sort, c.id").all() as {
      code: string;
      name: string;
      brand_notes: string | null;
    }[]
  ).map((c) => ({ code: c.code, name: c.name, brandNotes: c.brand_notes }));
  const house = adHouseRules(ch.section, ch.code);
  if (ch.section === "fkb") {
    return { section: "fkb", code: "fkb", forbiddenTerms: [], client: null, allClients, ownNotes: getNoteRow(sql, FKB_NOTE_KEY)?.body ?? null, house };
  }
  const map = readClientAdMap(metaClientsDir(cfg.metaEnvFile), ch.code);
  return {
    section: "fkbpros",
    code: ch.code,
    forbiddenTerms: map?.forbiddenTerms ?? [],
    client: allClients.find((c) => c.code === ch.code) ?? null,
    allClients,
    ownNotes: null,
    house,
  };
}

// ------------------------------------------------------------------------------------------------ media

export type AdMedia =
  | {
      ok: true;
      assetId: number;
      kind: "video" | "image";
      /** The original's real path (originalFileFor). */
      path: string;
      fileName: string;
      bytes: number;
      fingerprint: string | null;
      durationS: number | null;
      hasThumb: boolean;
      v: string;
      warnings: string[];
    }
  | { ok: false; error: string };

/** A visible video / image of this channel, its original reachable now (drive mounted), within Meta's size limits. */
export function checkAdMedia(sql: Sql, cfg: Pick<StudioConfig, "drivePath" | "fakeUnmounted" | "driveMode">, ch: AdChannel, assetId: number): AdMedia {
  const a = sql
    .prepare(
      `select a.id, a.kind, a.ext, a.filename, a.sha256, a.duration_s, a.thumb_path, s.key as section,
              (select count(*) from asset_clients ac where ac.asset_id = a.id) as ntags,
              (select count(*) from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = a.id and c.code = ?) as mine
         from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
        where a.id = ? and a.missing = 0 and a.ignored = 0 and r.enabled = 1`,
    )
    .get(ch.code, assetId) as
    | { id: number; kind: string; ext: string; filename: string; sha256: string | null; duration_s: number | null; thumb_path: string | null; section: string; ntags: number; mine: number }
    | undefined;
  const where = ch.section === "fkb" ? `${ch.label}'s Library` : `${ch.label}'s Library (or a shared ${laneNames(sql).fkbpros} file)`;
  if (!a) return { ok: false, error: "That file is not in the Library any more." };
  if (a.kind !== "video" && a.kind !== "image") return { ok: false, error: "Pick a video or an image." };
  const inChannel = ch.section === "fkb" ? a.section === "fkb" : a.section === "fkbpros" && (a.mine > 0 || a.ntags === 0);
  if (!inChannel) return { ok: false, error: `Pick a file from ${where}.` };
  const ext = (a.ext || "").toLowerCase().replace(/^\./, "");
  if (a.kind === "video" && !VIDEO_EXTS.includes(ext)) return { ok: false, error: "Meta takes MP4 or MOV videos." };
  if (a.kind === "image" && !IMAGE_EXTS.includes(ext)) return { ok: false, error: "Meta ad images are JPG or PNG." };
  const orig = originalFileFor(a.id, sql, cfg);
  if (!orig.ok) return { ok: false, error: orig.status === 409 ? notMountedMessage(cfg) : "The original file is not available (missing, hidden or outside the roots)." };
  let bytes: number;
  try {
    bytes = fs.statSync(orig.file).size;
  } catch {
    return { ok: false, error: "The original file cannot be read." };
  }
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  const warnings: string[] = [];
  if (a.kind === "video") {
    if (bytes > VIDEO_REFUSE_BYTES) return { ok: false, error: `${mb(bytes)}: Meta upload breaks above ~100 MB, export a smaller file.` };
    if (bytes > VIDEO_WARN_BYTES) warnings.push(`${mb(bytes)}: uploads are most reliable at 22 to 45 MB (an upload-optimized copy is safer).`);
  } else if (bytes > IMAGE_REFUSE_BYTES) {
    return { ok: false, error: `${mb(bytes)}: Meta takes ad images up to 30 MB.` };
  }
  return {
    ok: true,
    assetId: a.id,
    kind: a.kind,
    path: orig.file,
    fileName: orig.filename,
    bytes,
    fingerprint: a.sha256,
    durationS: a.duration_s,
    hasThumb: Boolean(a.thumb_path),
    v: (a.sha256 ?? "").slice(0, 12),
    warnings,
  };
}

// ------------------------------------------------------------------------------------------------ numbers + context

/**
 * The next ad number (display only; the apply skill assigns the real one): Lane B = one past the largest of the ad map's
 * `n`, the account's synced ad numbers and Studio's own staged / applying / applied orders (and any order with an ad
 * id); Lane C = one past the largest "<company prefix> N" (profile ads.companyPrefix) in the account (synced ads and
 * every name in the daily metrics) and Studio's Lane C orders.
 */
export function nextAdNumber(sql: Sql, cfg: Pick<StudioConfig, "metaEnvFile">, ch: AdChannel): number {
  let max = 0;
  const orderNames = sql
    // Staged / applying / applied orders, and any order that got as far as an ad (failed after the ad step).
    .prepare("select name_preview, ad_name from ad_orders where channel_code = ? and (status in ('staged','applying','applied') or ad_id is not null)")
    .all(ch.code) as { name_preview: string; ad_name: string | null }[];
  const names = [...orderNames.flatMap((o) => [o.name_preview, o.ad_name ?? ""])];
  if (ch.accountId != null) {
    names.push(...(sql.prepare("select name from ads where account_id = ?").pluck().all(ch.accountId) as string[]));
    names.push(...(sql.prepare("select distinct ad_name from ad_metrics where account_id = ? and ad_name is not null").pluck().all(ch.accountId) as string[]));
  }
  if (ch.section === "fkb") {
    const re = companyNameRe(adNaming().companyPrefix);
    for (const n of names) {
      const m = re.exec(n.trim());
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }
  const map = readClientAdMap(metaClientsDir(cfg.metaEnvFile), ch.code);
  for (const r of map?.rows ?? []) if (r.n != null) max = Math.max(max, r.n);
  for (const n of names) {
    const x = parseFpcName(n, ch.code)?.n ?? adNumber(n, ch.code);
    if (x != null && x < 1000) max = Math.max(max, x);
  }
  return max + 1;
}

/** `<company prefix> <n>` as a pattern: the prefix's words with any spacing, then the number ("Ad 3", "ad3"). */
export function companyNameRe(prefix: string): RegExp {
  const words = prefix.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${words.join("\\s*")}\\s*(\\d{1,4})\\b`, "i");
}

export type AdContext = { lines: string[]; warnings: string[] };

/** The read-only context lines (synced ads, so as of the last Meta sync). */
export function adContext(sql: Sql, ch: AdChannel): AdContext {
  const lines: string[] = [];
  const warnings: string[] = [];
  if (ch.accountId == null) return { lines: ["No synced ad account for this channel yet."], warnings };
  const acc = sql.prepare("select last_sync_at from ad_accounts where id = ?").get(ch.accountId) as { last_sync_at: number | null } | undefined;
  const asOf = acc?.last_sync_at ? ` (as of the last Meta sync, ${new Date(acc.last_sync_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })})` : "";
  const ads = sql
    .prepare("select name, adset_name, campaign_name, effective_status, creative from ads where account_id = ?")
    .all(ch.accountId) as { name: string; adset_name: string | null; campaign_name: string | null; effective_status: string | null; creative: string | null }[];
  if (ch.section === "fkbpros") {
    const testing = ads.filter((a) => /testing/i.test(a.adset_name ?? ""));
    const active = testing.filter((a) => a.effective_status === "ACTIVE");
    const statics = active.filter((a) => readCreative(a.creative)?.isVideo === false);
    const videos = active.length - statics.length;
    const sets = [...new Set(testing.map((a) => a.adset_name))];
    if (!testing.length) {
      warnings.push("No Testing ad set in the synced ads: the apply skill only builds into the client's Testing set.");
    } else {
      lines.push(
        `Testing ad set${sets.length === 1 ? ` "${sets[0]}"` : "s"}: ${active.length} of ${TESTING_SEATS} seats used (${videos} video of ${VIDEO_SEATS}, ${statics.length} static of ${STATIC_SEATS})${asOf}.`,
      );
      lines.push(
        `A staged order is PAUSED and takes no seat: it goes live only into an open seat, in an apply session (${profile().skills.adApplyClients}).`,
      );
      if (active.length >= TESTING_SEATS) warnings.push("No open Testing seat right now: the order waits until a seat opens.");
    }
    lines.push("Goes into the Testing ad set, never Winners.");
  } else {
    const activeSets = [...new Map(ads.filter((a) => a.effective_status === "ACTIVE").map((a) => [a.adset_name, a.campaign_name])).entries()];
    if (activeSets.length === 1) {
      lines.push(`Active ad set: "${activeSets[0][0]}" (campaign ${activeSets[0][1] ?? "?"})${asOf}. The apply skill resolves it again when it applies.`);
    } else {
      warnings.push(
        `${activeSets.length} active ad sets${activeSets.length ? ` (${activeSets.map((s) => `"${s[0]}"`).join(", ")})` : ""}${asOf}: the apply skill will stop, ${ch.label} needs exactly one active ad set.`,
      );
    }
  }
  return { lines, warnings };
}

// ------------------------------------------------------------------------------------------------ prefill

export type PrefillHook = { id: number; text: string; kind: "text" | "video"; source: string; angle: string | null; section: "fkbpros" | "fkb"; code: string | null };

export type NewAdPrefill = {
  channels: { code: string; label: string; section: "fkbpros" | "fkb" }[];
  /** null = the channel must be chosen (a shared Lane B hook or file, or cmd+K without one). */
  channel: AdChannel | null;
  hook: PrefillHook | null;
  /**
   * The video's own line, when no hook was asked for and the media is a video with words (spoken, else on-screen): it
   * fills the hook's slot. `hookId` = its video hook, or null = made at Stage when this same video is staged.
   */
  videoLine: { assetId: number; hookId: number | null; text: string } | null;
  angle: string | null;
  /** Where the prefilled lines came from: the approved copy doc, the ad map's angle block, or nothing (Draft the rest). */
  copySource: "doc" | "map" | null;
  copy: AdCopy;
  /** The hook did not fit a headline (over 40 characters): it opens primary 1. */
  hookInPrimary: boolean;
  /** Primary indexes / headline indexes the hook filled (shown as "from the hook"). */
  concept: string;
  psObj: PsObj;
  nextN: number;
  namePreview: string;
  /** The ad name conventions (the dialog recomputes the preview with them). */
  naming: AdNaming;
  context: AdContext;
  rules: AdRuleContext | null;
  media: AdMedia | null;
  /** Prefilled media: an asset id (the hook's video, the Winner's file, the Library card). */
  assetId: number | null;
  error: string | null;
};

/** The hook (Lane B or Lane C only) with its angle: its own angle slug, else the angle key of an ad it is on. */
export function prefillHook(sql: Sql, hookId: number): PrefillHook | null {
  const h = sql
    .prepare(
      `select h.id, h.text, h.kind, h.source, h.angle_slug, s.key as section, c.code
         from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id where h.id = ?`,
    )
    .get(hookId) as { id: number; text: string; kind: "text" | "video"; source: string; angle_slug: string | null; section: string; code: string | null } | undefined;
  if (!h || (h.section !== "fkbpros" && h.section !== "fkb")) return null;
  const viaAd = h.angle_slug
    ? null
    : (sql
        .prepare(
          `select ad.angle_key from hook_ads ha join ads ad on ad.meta_ad_id = ha.meta_ad_id
            where ha.hook_id = ? and ad.angle_key is not null and ad.angle_key not like 'universal:%' order by ad.created_time desc limit 1`,
        )
        .pluck()
        .get(h.id) as string | undefined);
  return { id: h.id, text: h.text, kind: h.kind, source: h.source, angle: h.angle_slug ?? viaAd ?? null, section: h.section, code: h.code };
}

/** The angle block: the copy doc's, its missing fields from the ad map's block of the same angle. */
export function angleBlockFor(clientDocsDir: string, map: ClientAdMap | null, folder: string | null, angle: string | null): { block: AngleBlock | null; source: "doc" | "map" | null } {
  if (!angle) return { block: null, source: null };
  const doc = readCopyDocBlocks(clientDocsDir, folder).get(angle) ?? null;
  const fromMap = map?.angles.get(angle) ?? null;
  if (doc) {
    return {
      block: {
        headlines: doc.headlines.length ? doc.headlines : (fromMap?.headlines ?? []),
        primaries: doc.primaries.length ? doc.primaries : (fromMap?.primaries ?? []),
        description: doc.description ?? fromMap?.description ?? null,
        stage: fromMap?.stage ?? null,
      },
      source: "doc",
    };
  }
  return fromMap ? { block: fromMap, source: "map" } : { block: null, source: null };
}

const sameText = (a: string, b: string) => normHook(a) === normHook(b);

/**
 * The prefill rule (E2): a hook of up to 40 characters is headline 1, the block's other headlines follow (3 in all); a
 * longer hook becomes primary 1's opening line (a structured primary's first line is replaced, a classic one's first
 * sentence), the block's headlines stay. The block's primaries fill the rest (2 in all) and its description the one
 * description. Without a block only the hook's slot is filled ("Draft the rest" writes the others).
 */
export function prefillCopy(hookText: string | null, block: AngleBlock | null): { copy: AdCopy; hookInPrimary: boolean } {
  const hook = hookText?.replace(/\s+/g, " ").trim() || null;
  const fits = hook != null && hook.length <= HEADLINE_FIT;
  const blockH = block?.headlines ?? [];
  const blockP = block?.primaries ?? [];
  const headlines: string[] = [];
  const primaries: string[] = [];
  if (hook && fits) headlines.push(hook);
  for (const h of blockH) if (headlines.length < 3 && !headlines.some((x) => sameText(x, h))) headlines.push(h);
  if (hook && !fits) {
    const p1 = blockP[0] ?? null;
    if (!p1) primaries.push(hook);
    else if (p1.includes("\n")) {
      const lines = p1.split("\n");
      const firstText = lines.findIndex((l) => l.trim());
      primaries.push(sameText(lines[firstText] ?? "", hook) ? p1 : [hook, ...lines.slice(firstText + 1)].join("\n"));
    } else {
      const first = firstSentence(p1);
      primaries.push(sameText(first, hook) ? p1 : `${hook} ${p1.slice(first.length).trim()}`.trim());
    }
    for (const p of blockP.slice(1)) if (primaries.length < 2) primaries.push(p);
  } else {
    for (const p of blockP) if (primaries.length < 2) primaries.push(p);
  }
  return { copy: { headlines, primaries, description: block?.description ?? "" }, hookInPrimary: Boolean(hook && !fits) };
}

/** The concept + ps|obj for an angle: the map's newest named ad on it, else its row / block stage, else the angle slug. */
export function conceptFor(map: ClientAdMap | null, code: string, angle: string | null): { concept: string; psObj: PsObj } {
  if (!angle) return { concept: "", psObj: "ps" };
  const rows = (map?.rows ?? []).filter((r) => r.angleKey === angle).sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
  for (const r of rows) {
    const p = r.adName ? parseFpcName(r.adName, code) : null;
    if (p) return { concept: p.concept, psObj: p.stage };
  }
  const row = rows.find((r) => r.concept || r.stage);
  const stage = row?.stage ?? map?.angles.get(angle)?.stage ?? "ps";
  return { concept: row?.concept ? conceptFrom(row.concept) : conceptFrom(angle), psObj: stage };
}

export type PrefillInput = { channel?: string | null; hookId?: number | null; assetId?: number | null; adId?: string | null };

/** Everything the New PAUSED ad dialog opens with. Never throws for a missing piece (the dialog shows `error`). */
export function newAdPrefill(sql: Sql, cfg: StudioConfig, input: PrefillInput): NewAdPrefill {
  const channels = adChannels(sql);
  let error: string | null = null;
  let hook: PrefillHook | null = null;
  if (input.hookId) {
    hook = prefillHook(sql, input.hookId);
    if (!hook) {
      const L = laneNames(sql);
      error = `That hook is not a ${L.fkbpros} or ${L.fkb} hook (${L.rtm} hooks never become Meta ads).`;
    }
  }
  let assetId = input.assetId ?? null;
  let angle = hook?.angle ?? null;
  let adChannelCode: string | null = null;
  if (input.adId) {
    const ad = sql
      .prepare("select ad.matched_asset_id, ad.angle_key, coalesce(c.code, 'fkb') as code from ads ad join ad_accounts a on a.id = ad.account_id left join clients c on c.id = a.client_id where ad.meta_ad_id = ?")
      .get(input.adId) as { matched_asset_id: number | null; angle_key: string | null; code: string } | undefined;
    if (ad) {
      adChannelCode = ad.code;
      assetId ??= ad.matched_asset_id;
      if (!angle && ad.angle_key && !ad.angle_key.startsWith("universal:")) angle = ad.angle_key;
    }
  }
  if (hook?.kind === "video" && assetId == null) {
    assetId = (sql.prepare("select asset_id from hooks where id = ?").pluck().get(hook.id) as number | null) ?? null;
  }
  // The channel: asked for, else the hook's / the ad's, else the file's (Lane C, or exactly one client tag).
  let code = input.channel ?? (hook ? (hook.section === "fkb" ? "fkb" : hook.code) : null) ?? adChannelCode;
  if (!code && assetId) {
    const a = sql
      .prepare(
        `select s.key as section, (select group_concat(c.code) from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = a.id) as codes
           from assets a join sections s on s.id = a.section_id where a.id = ?`,
      )
      .get(assetId) as { section: string; codes: string | null } | undefined;
    if (a?.section === "fkb") code = "fkb";
    else if (a?.section === "fkbpros" && a.codes && !a.codes.includes(",")) code = a.codes;
  }
  const ch = adChannel(sql, code);
  if (hook && ch) {
    const fits = ch.section === "fkb" ? hook.section === "fkb" : hook.section === "fkbpros" && (hook.code == null || hook.code === ch.code);
    if (!fits) error = "That hook belongs to another channel.";
  }
  // A video opened without a hook (Library card, drawer, a Winner's file): its own line fills the hook's slot.
  let videoLine: NewAdPrefill["videoLine"] = null;
  if (!input.hookId && ch && assetId != null) {
    const line = videoAdLine(sql, assetId);
    const h = line?.hookId != null ? prefillHook(sql, line.hookId) : null;
    const fits = !h || (ch.section === "fkb" ? h.section === "fkb" : h.section === "fkbpros" && (h.code == null || h.code === ch.code));
    if (line && fits) {
      videoLine = { assetId, hookId: line.hookId, text: line.text };
      angle ??= h?.angle ?? null;
    }
  }
  // Still no angle: the newest ad of this account that runs this file (its ad map row's angle).
  if (!angle && !hook && ch?.accountId != null && assetId != null) {
    angle =
      (sql
        .prepare(
          `select angle_key from ads where account_id = ? and matched_asset_id = ? and angle_key is not null and angle_key not like 'universal:%'
            order by created_time desc limit 1`,
        )
        .pluck()
        .get(ch.accountId, assetId) as string | undefined) ?? null;
  }
  const map = ch?.section === "fkbpros" ? readClientAdMap(metaClientsDir(cfg.metaEnvFile), ch.code) : null;
  const { block, source } = ch?.section === "fkbpros" ? angleBlockFor(cfg.clientDocsDir, map, ch.folder, angle) : { block: null, source: null };
  const { copy, hookInPrimary } = prefillCopy(hook?.text ?? videoLine?.text ?? null, block);
  const named = ch?.section === "fkbpros" ? conceptFor(map, ch.code, angle) : { concept: "", psObj: "ps" as PsObj };
  const nextN = ch ? nextAdNumber(sql, cfg, ch) : 0;
  return {
    channels: channels.map((c) => ({ code: c.code, label: c.section === "fkb" ? `${c.label} (${companyName()})` : c.label, section: c.section })),
    channel: ch,
    hook,
    videoLine,
    angle,
    copySource: source,
    copy,
    hookInPrimary,
    concept: named.concept,
    psObj: named.psObj,
    nextN,
    namePreview: ch ? namePreview(ch.section, ch.code, named.concept, named.psObj, nextN, adNaming()) : "",
    naming: adNaming(),
    context: ch ? adContext(sql, ch) : { lines: [], warnings: [] },
    rules: ch ? adRuleContext(sql, cfg, ch) : null,
    media: ch && assetId ? checkAdMedia(sql, cfg, ch, assetId) : null,
    assetId,
    error,
  };
}
