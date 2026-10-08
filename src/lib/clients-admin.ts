/**
 * Settings > Clients and Settings > Lanes (Creative Studio slice 1b), plus the per-client provisioning the config seed
 * shares (server only; DB rows only, never a file write).
 *
 * - A client is added once (code, name, Lane B, Meta ad account, hint, folder, campaigns, leads, GHL source) and edited
 *   later; its CODE never changes (URLs, tag rules, hooks, order files and GHL sources key on it). Hide / Unhide sets
 *   `clients.hidden_at`: a hidden client leaves the sidebar, scopes, cmd+K, coverage, Review and the Meta sync, and every
 *   row it owns stays. Nothing here deletes a client.
 * - The ad account: a client's account row (`ad_accounts`, identity `fpc`) is made when it gets one. Changing or clearing
 *   it is allowed only while that row has never been synced (no attempt, no campaigns): an account with numbers keeps
 *   them, so a client that moved to another account is added again as a new client (a new code; the old one can be hidden).
 * - A lane can be renamed and recolored; Lane A (`rtm`) and Lane C (`fkb`) can be switched off, Lane B (`fkbpros`) never.
 *
 * Every input goes through the zod schemas below (the server actions call these functions; the smoke calls them too).
 * Errors are ClientAdminError with a terse message (never a stack, a path or a SQL error).
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { generatedClientGlob } from "./gen/generated-dirs";
import { isUnder } from "./fsguard";
import {
  ACT_ID_RE,
  actId,
  CAMPAIGN_ID_RE,
  CAMPAIGN_MODES,
  clientCode,
  colorSchema,
  folderSchema,
  ghlSourceSchema,
  LANE_KEYS,
  LEADS_MODES,
  NEUTRAL_LANES,
  ONE_LINE_RE,
  type CampaignMode,
  type LaneKey,
  type LeadsMode,
} from "./studio-config";

type Sql = Database.Database;

export class ClientAdminError extends Error {}

/** The folder inside each client folder that holds its Testing statics (a read-only root when it exists). */
export const STATIC_ADS_DIR = "Static Ads";

export type ProvisionDirs = { drivePath: string; clientDocsDir: string };

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `at most ${max} characters`)
    .regex(ONE_LINE_RE, "one line")
    .transform((v) => v || null);

/** Fields Add and Edit share. Empty strings = not set. */
const clientFields = {
  name: z.string().trim().min(1, "Enter a name.").max(80, "Names are at most 80 characters.").regex(ONE_LINE_RE, "One line."),
  metaAdAccount: z.union([z.literal(""), actId]).transform((v) => v || null),
  hint: optionalText(300),
  folder: z.union([z.literal(""), folderSchema]).transform((v) => v || null),
  campaignMode: z.enum(CAMPAIGN_MODES),
  campaignId: z
    .string()
    .trim()
    .refine((v) => v === "" || CAMPAIGN_ID_RE.test(v), "A campaign id is digits only.")
    .transform((v) => v || null),
  leadsMode: z.enum(LEADS_MODES),
  ghlSource: z.union([z.literal(""), ghlSourceSchema]).transform((v) => v || null),
  sort: z.number().int().min(0).max(10_000).optional(),
};

const needsCampaignId = (v: { campaignMode: CampaignMode; campaignId: string | null }) => v.campaignMode !== "one" || v.campaignId != null;

/** Add and Edit share it: Edit keys by the (immutable) code; any other key, e.g. a new code, is refused (strict). */
export const clientSchema = z
  .object({ code: clientCode, ...clientFields })
  .strict()
  .refine(needsCampaignId, { message: "One campaign needs its campaign id.", path: ["campaignId"] });

export type ClientInput = z.input<typeof clientSchema>;

export const laneEditSchema = z
  .object({
    key: z.enum(LANE_KEYS),
    name: z.string().trim().min(1, "Enter a name.").max(40, "Lane names are at most 40 characters.").regex(ONE_LINE_RE, "One line."),
    color: colorSchema,
    enabled: z.boolean(),
  })
  .strict()
  .refine((v) => v.key !== "fkbpros" || v.enabled, { message: "The clients lane cannot be switched off.", path: ["enabled"] });

export type LaneInput = z.input<typeof laneEditSchema>;

const FIELD_LABEL: Record<string, string> = {
  code: "Code",
  name: "Name",
  metaAdAccount: "Meta ad account",
  hint: "Hint",
  folder: "Folder",
  campaignMode: "Campaigns",
  campaignId: "Campaign id",
  leadsMode: "Leads",
  ghlSource: "GHL source",
  sort: "Sort",
  key: "Lane",
  color: "Color",
  enabled: "On / off",
  hidden: "Hidden",
};

/** zod parse, or a terse ClientAdminError naming the field (never the value). */
function parseOr<T>(schema: z.ZodType<T>, input: unknown, fallback: string): T {
  const p = schema.safeParse(input);
  if (p.success) return p.data;
  const i = p.error.issues[0];
  if (!i) throw new ClientAdminError(fallback);
  if (i.code === "unrecognized_keys") throw new ClientAdminError(`${fallback} (unknown field)`);
  if (/^[A-Z].*\.$/.test(i.message)) throw new ClientAdminError(i.message);
  const label = FIELD_LABEL[String(i.path[0] ?? "")];
  throw new ClientAdminError(label ? `${label}: ${i.message.replace(/\.$/, "")}.` : fallback);
}

function sectionId(sql: Sql, key: LaneKey): number {
  const row = sql.prepare("select id from sections where key = ?").get(key) as { id: number } | undefined;
  if (!row) throw new ClientAdminError("That lane does not exist.");
  return row.id;
}

/**
 * Make what a new client needs beyond its row: its ad account row (when it has an account), the absolute tag rule for its
 * Studio Generated folder, and its `<folder>/Static Ads` folder as a read-only root + tag rule (when that folder exists
 * and overlaps no root). Only inserts what is missing; never touches a file.
 */
export function provisionClient(
  sql: Sql,
  clientId: number,
  dirs: ProvisionDirs,
  parts: { account?: boolean; generatedRule?: boolean; staticRoot?: boolean },
  now = Date.now(),
): void {
  const c = sql.prepare("select id, section_id, code, meta_ad_account_id as act, folder, sort from clients where id = ?").get(clientId) as
    | { id: number; section_id: number; code: string; act: string | null; folder: string | null; sort: number }
    | undefined;
  if (!c) return;
  if (parts.account && c.act && ACT_ID_RE.test(c.act)) {
    const has = sql.prepare("select 1 from ad_accounts where client_id = ?").get(c.id);
    if (!has) {
      sql
        .prepare("insert or ignore into ad_accounts (section_id, client_id, act_id, identity, sort) values (?, ?, ?, 'fpc', ?)")
        .run(c.section_id, c.id, c.act, c.sort);
    }
  }
  const hasRule = sql.prepare("select 1 from tag_rules where path_glob = ?");
  const insRule = sql.prepare("insert into tag_rules (path_glob, client_codes, created_at) values (?, ?, ?)");
  if (parts.generatedRule) {
    const glob = generatedClientGlob(dirs.drivePath, c.code);
    if (!hasRule.get(glob)) insRule.run(glob, JSON.stringify([c.code]), now);
  }
  if (parts.staticRoot && c.folder) {
    const real = staticAdsDir(dirs.clientDocsDir, c.folder);
    if (real) {
      const roots = sql.prepare("select path from roots").pluck().all() as string[];
      const overlaps = roots.some((r) => r !== real && (isUnder(real, r) || isUnder(r, real)));
      if (!overlaps) {
        sql.prepare("insert or ignore into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)").run(real, c.section_id, now);
        const glob = `${real}/**`;
        if (!hasRule.get(glob)) insRule.run(glob, JSON.stringify([c.code]), now);
      }
    }
  }
}

/** The real path of `<clientDocsDir>/<folder>/Static Ads` when it is a directory, else null. */
export function staticAdsDir(clientDocsDir: string, folder: string): string | null {
  if (!folderSchema.safeParse(folder).success) return null;
  const dir = path.join(clientDocsDir, folder, STATIC_ADS_DIR);
  try {
    return fs.statSync(dir).isDirectory() ? fs.realpathSync(dir) : null;
  } catch {
    return null;
  }
}

/** True when the account row has never been read (no attempt, no campaigns): its act id may still change. */
function accountUnsynced(sql: Sql, accountId: number): boolean {
  const a = sql.prepare("select last_attempt_at, last_sync_at from ad_accounts where id = ?").get(accountId) as
    | { last_attempt_at: number | null; last_sync_at: number | null }
    | undefined;
  if (!a) return true;
  if (a.last_attempt_at != null || a.last_sync_at != null) return false;
  return !sql.prepare("select 1 from meta_campaigns where account_id = ? limit 1").get(accountId);
}

function actTaken(sql: Sql, act: string, exceptClientId: number | null): boolean {
  const row = sql.prepare("select client_id from ad_accounts where act_id = ?").get(act) as { client_id: number | null } | undefined;
  if (row && row.client_id !== exceptClientId) return true;
  const other = sql.prepare("select id from clients where meta_ad_account_id = ?").get(act) as { id: number } | undefined;
  return Boolean(other && other.id !== exceptClientId);
}

/** Add a Lane B client and provision it (account row, Studio Generated rule, Static Ads root). Returns its id. */
export function addClient(sql: Sql, input: unknown, dirs: ProvisionDirs, now = Date.now()): number {
  const v = parseOr(clientSchema, input, "Check the client's fields.");
  return sql.transaction(() => {
    if (sql.prepare("select 1 from clients where code = ?").get(v.code)) throw new ClientAdminError("A client with that code already exists.");
    if (v.metaAdAccount && actTaken(sql, v.metaAdAccount, null)) throw new ClientAdminError("That ad account already belongs to another client.");
    const sid = sectionId(sql, "fkbpros");
    const sort = v.sort ?? (((sql.prepare("select max(sort) from clients").pluck().get() as number | null) ?? -1) + 1);
    const info = sql
      .prepare(
        `insert into clients (section_id, code, name, meta_ad_account_id, classify_hint, folder, campaign_mode, campaign_id, leads_mode, ghl_source, sort)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sid, v.code, v.name, v.metaAdAccount, v.hint, v.folder, v.campaignMode, v.campaignMode === "one" ? v.campaignId : null, v.leadsMode, v.ghlSource, sort);
    const id = Number(info.lastInsertRowid);
    provisionClient(sql, id, dirs, { account: true, generatedRule: true, staticRoot: true }, now);
    return id;
  })();
}

/** Edit a client (its code is the key and never changes). */
export function editClient(sql: Sql, input: unknown, dirs: ProvisionDirs, now = Date.now()): void {
  const v = parseOr(clientSchema, input, "Check the client's fields.");
  sql.transaction(() => {
    const c = sql.prepare("select id, meta_ad_account_id as act, folder, sort from clients where code = ?").get(v.code) as
      | { id: number; act: string | null; folder: string | null; sort: number }
      | undefined;
    if (!c) throw new ClientAdminError("That client does not exist.");
    const account = sql.prepare("select id, act_id from ad_accounts where client_id = ?").get(c.id) as { id: number; act_id: string } | undefined;
    if (v.metaAdAccount !== c.act) {
      if (v.metaAdAccount && actTaken(sql, v.metaAdAccount, c.id)) throw new ClientAdminError("That ad account already belongs to another client.");
      if (account && !accountUnsynced(sql, account.id)) {
        throw new ClientAdminError("This client's ad account already has synced numbers, so it cannot change. Add the new account as a new client (with a new code).");
      }
      if (account) {
        if (v.metaAdAccount) sql.prepare("update ad_accounts set act_id = ? where id = ?").run(v.metaAdAccount, account.id);
        else sql.prepare("delete from ad_accounts where id = ?").run(account.id);
      }
    }
    const sort = v.sort ?? c.sort;
    sql
      .prepare(
        `update clients set name = ?, meta_ad_account_id = ?, classify_hint = ?, folder = ?, campaign_mode = ?, campaign_id = ?, leads_mode = ?,
           ghl_source = ?, sort = ? where id = ?`,
      )
      .run(v.name, v.metaAdAccount, v.hint, v.folder, v.campaignMode, v.campaignMode === "one" ? v.campaignId : null, v.leadsMode, v.ghlSource, sort, c.id);
    // The account row follows the client's place in the order (Settings > Clients, the Meta card and Jobs list by it).
    if (sort !== c.sort) sql.prepare("update ad_accounts set sort = ? where client_id = ?").run(sort, c.id);
    // A new account gets its row; a new folder gets its Static Ads root (rules / roots already there are left alone).
    provisionClient(sql, c.id, dirs, { account: v.metaAdAccount != null && !account, staticRoot: v.folder !== c.folder }, now);
  })();
}

export const clientHiddenSchema = z.object({ code: clientCode, hidden: z.boolean() }).strict();

/** Hide (never delete) or unhide a client. Returns the validated `hidden` (the action words its message from it). */
export function setClientHidden(sql: Sql, input: unknown, now = Date.now()): boolean {
  const v = parseOr(clientHiddenSchema, input, "Invalid client.");
  const r = sql.prepare("update clients set hidden_at = ? where code = ?").run(v.hidden ? now : null, v.code);
  if (!r.changes) throw new ClientAdminError("That client does not exist.");
  return v.hidden;
}

/** Rename / recolor a lane, switch Lane A or C on or off (Lane B is always on). */
export function editLane(sql: Sql, input: unknown): void {
  const v = parseOr(laneEditSchema, input, "Check the lane's fields.");
  const r = sql.prepare("update sections set name = ?, color = ?, enabled = ? where key = ?").run(v.name, v.color, v.enabled ? 1 : 0, v.key);
  if (!r.changes) throw new ClientAdminError("That lane does not exist.");
}

export type AdminClientRow = {
  code: string;
  name: string;
  lane: string;
  metaAdAccount: string | null;
  /** The account row has synced numbers (its act id can no longer change). */
  accountLocked: boolean;
  hint: string | null;
  folder: string | null;
  campaignMode: CampaignMode;
  campaignId: string | null;
  leadsMode: LeadsMode;
  ghlSource: string | null;
  sort: number;
  hidden: boolean;
};

/** Every client (hidden ones included) for Settings > Clients, in sidebar order. */
export function adminClients(sql: Sql): AdminClientRow[] {
  const rows = sql
    .prepare(
      `select c.code, c.name, s.name as lane, c.meta_ad_account_id, c.classify_hint, c.folder, c.campaign_mode, c.campaign_id, c.leads_mode,
              c.ghl_source, c.sort, c.hidden_at, a.id as account_id
         from clients c join sections s on s.id = c.section_id left join ad_accounts a on a.client_id = c.id
        order by c.sort, c.name`,
    )
    .all() as {
    code: string;
    name: string;
    lane: string;
    meta_ad_account_id: string | null;
    classify_hint: string | null;
    folder: string | null;
    campaign_mode: string;
    campaign_id: string | null;
    leads_mode: string;
    ghl_source: string | null;
    sort: number;
    hidden_at: number | null;
    account_id: number | null;
  }[];
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    lane: r.lane,
    metaAdAccount: r.meta_ad_account_id,
    accountLocked: r.account_id != null && !accountUnsynced(sql, r.account_id),
    hint: r.classify_hint,
    folder: r.folder,
    campaignMode: (CAMPAIGN_MODES as readonly string[]).includes(r.campaign_mode) ? (r.campaign_mode as CampaignMode) : "all",
    campaignId: r.campaign_id,
    leadsMode: (LEADS_MODES as readonly string[]).includes(r.leads_mode) ? (r.leads_mode as LeadsMode) : "meta",
    ghlSource: r.ghl_source,
    sort: r.sort,
    hidden: r.hidden_at != null,
  }));
}

export type AdminLaneRow = { key: LaneKey; name: string; color: string | null; enabled: boolean; canDisable: boolean };

export function adminLanes(sql: Sql): AdminLaneRow[] {
  const rows = sql.prepare("select key, name, color, enabled from sections order by sort, id").all() as {
    key: string;
    name: string;
    color: string | null;
    enabled: number;
  }[];
  return rows
    .filter((r): r is typeof r & { key: LaneKey } => (LANE_KEYS as readonly string[]).includes(r.key))
    .map((r) => ({ key: r.key, name: r.name, color: r.color, enabled: Boolean(r.enabled), canDisable: r.key !== "fkbpros" }));
}

/** Every lane's display name (Settings > Lanes; the neutral built-in for a missing row), for server side messages. */
export function laneNames(sql: Sql): Record<LaneKey, string> {
  const rows = sql.prepare("select key, name from sections").all() as { key: string; name: string }[];
  const out = Object.fromEntries(LANE_KEYS.map((k) => [k, NEUTRAL_LANES[k].name])) as Record<LaneKey, string>;
  for (const r of rows) if ((LANE_KEYS as readonly string[]).includes(r.key) && r.name) out[r.key as LaneKey] = r.name;
  return out;
}

/** Enabled lane keys (the sidebar, routes, cmd+K, coverage, Review and the Meta sync read this). */
export function enabledLanes(sql: Sql): Set<LaneKey> {
  return new Set(
    (sql.prepare("select key from sections where enabled = 1").pluck().all() as string[]).filter((k): k is LaneKey =>
      (LANE_KEYS as readonly string[]).includes(k),
    ),
  );
}
