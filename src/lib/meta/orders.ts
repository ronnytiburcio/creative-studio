/**
 * New PAUSED Meta ad orders (Phase 6 slice 3, E4 + E5; server only). Studio never writes to Meta: Stage writes ONE new
 * order file that an apply skill picks up in a live Claude session after the owner's go-ahead (the Lane B apply skill's
 * studio order mode for the Lane B clients, the Lane C apply skill for Lane C). The skill creates the ad PAUSED and writes
 * the outcome back into the same file (`status` applied | failed, `ad_id`, `ad_name`, `creative_id`, `applied_at`,
 * `error`, `failed_step`); the worker reads it back.
 *
 * THE writer (a hard rule in CLAUDE.md): only the two configured folders (`META_PENDING_DIR` for Lane B and
 * `META_FKB_PENDING_DIR` for Lane C, created 0700 when missing), each checked every time (absolute, not on the drive by
 * lexical or real path, not inside a git working tree, not a symlink, a
 * plain folder), file names `STUDIO-<yyyy-mm-dd>-<code>-<shortid>.json` only, JSON only, 64 KB cap, created with
 * O_CREAT | O_EXCL | O_NOFOLLOW (`wx`) 0600: an existing file is NEVER overwritten. The one other write it allows:
 * Studio rewriting its OWN order to `status: "cancelled"` while the file still says `staged` and carries the
 * `studio_order_id` of Studio's `ad_orders` row (a temp file in the same folder, then rename over it), holding the order
 * lock (`.<name>.lock`, src/lib/privatefile.ts withOrderLock) that the apply scripts also take around their claim and every
 * status write, so a cancel can never race an apply. It never reads a Meta / GHL token, never calls Meta or GHL, never
 * touches any other file under ~/Meta.
 *
 * Statuses (the file is the truth; the worker mirrors it): staged (Studio wrote it) -> applying (an apply script claimed
 * it: `apply_step`, `apply_started_at`) -> applied (`ad_id`, ...) | failed (`failed_step`, `error`); cancelled (Studio,
 * only from staged); missing (the file is gone). failed -> applying only on the scripts' explicit `--retry-failed`, never
 * when the failed order already has an `ad_id`.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { IDENTITY, pendingDirProblem, type StudioConfig } from "../config";
import { OrderLockedError, withOrderLock, writeNewPrivateFile } from "../privatefile";
import { clientShortName, channelHref } from "../media";
import { hooksPath } from "../hooks/sql";
import { adVideoHook } from "../hooks/video";
import { AD_RULES_VERSION, checkAdCopy, cleanAdCopy, compileAdRules, conceptProblem, namePreview, type AdCopy, type PsObj } from "./ad-copy-rules";
import { adChannel, adNaming, adRuleContext, checkAdMedia, nextAdNumber, type AdChannel } from "./new-ad";
import { laneNames } from "../clients-admin";

type Sql = Database.Database;

export class OrderError extends Error {}

export const ORDER_MAX_BYTES = 64 * 1024;
export const ORDER_NAME = /^STUDIO-\d{4}-\d{2}-\d{2}-[a-z0-9]+-[a-z0-9]{6,}\.json$/;
export const ORDER_STATUSES = ["staged", "applying", "applied", "failed", "cancelled", "missing"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** The file is done changing: nothing to read back any more. */
export const FINAL_STATUSES: readonly OrderStatus[] = ["applied", "cancelled"];
export const ORDER_SOURCES = ["hook", "winner", "library"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];
export const NOTES_MAX = 500;
/** An order still `applying` this long after its apply started "may have stopped" (shown, never turned into failed). */
export const APPLY_STALL_MS = 30 * 60_000;

type PendingCfg = Pick<StudioConfig, "drivePath" | "pendingDirs">;

/** The order folder for a section, checked (created 0700 when missing and `create`). Returns its real path. Throws OrderError. */
export function pendingDir(cfg: PendingCfg, section: "fkbpros" | "fkb", create = false): string {
  const dir = cfg.pendingDirs[section];
  const bad = pendingDirProblem(dir, cfg.drivePath);
  if (bad) throw new OrderError(`The order folder ${bad}`);
  if (!fs.existsSync(dir)) {
    if (!create) throw new OrderError("The order folder does not exist.");
    try {
      fs.mkdirSync(dir, { mode: 0o700 }); // the folder itself only: its parent (~/Meta) must already exist
    } catch {
      throw new OrderError("Could not create the order folder (its parent folder must exist).");
    }
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OrderError("The order folder is not a plain folder.");
  const real = fs.realpathSync(dir);
  const again = pendingDirProblem(real, cfg.drivePath);
  if (again) throw new OrderError(`The order folder ${again}`);
  return real;
}

/** The configured folder a stored order path belongs to, or null (exact folder only, never a subfolder). */
function folderOf(cfg: PendingCfg, filePath: string): { section: "fkbpros" | "fkb"; real: string } | null {
  if (!path.isAbsolute(filePath) || filePath.includes("\0") || !ORDER_NAME.test(path.basename(filePath))) return null;
  for (const section of ["fkbpros", "fkb"] as const) {
    let real: string;
    try {
      real = pendingDir(cfg, section);
    } catch {
      continue;
    }
    const dir = path.dirname(path.resolve(filePath));
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      realDir = dir;
    }
    if (realDir === real || path.resolve(cfg.pendingDirs[section]) === dir) return { section, real };
  }
  return null;
}

/**
 * Write a NEW order file (see the module comment). Returns its absolute path. Throws OrderError: a bad name, a body that
 * is not a JSON object or is over 64 KB, a refused folder, or a file of that name already there (never overwritten).
 */
export function writeOrderFile(cfg: PendingCfg, section: "fkbpros" | "fkb", name: string, body: Record<string, unknown>): string {
  if (!ORDER_NAME.test(name) || name.includes("/") || name.includes("\0")) throw new OrderError("Not an order file name.");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OrderError("An order is a JSON object.");
  const text = `${JSON.stringify(body, null, 2)}\n`;
  if (Buffer.byteLength(text) > ORDER_MAX_BYTES) throw new OrderError("The order is larger than 64 KB.");
  JSON.parse(text); // JSON only
  const real = pendingDir(cfg, section, true);
  const target = path.join(real, name);
  try {
    writeNewPrivateFile(target, text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new OrderError("An order file with that name already exists (never overwritten).");
    throw new OrderError("Could not create the order file.");
  }
  return target;
}

/** Read an order file Studio wrote (guarded: one of the two folders, the name pattern, no symlink, a regular file <= 64 KB). */
function readRaw(cfg: PendingCfg, filePath: string): { ok: true; text: string } | { ok: false; missing: boolean; error: string } {
  const at = folderOf(cfg, filePath);
  if (!at) return { ok: false, missing: false, error: "Not an order file in the configured folders." };
  const target = path.join(at.real, path.basename(filePath));
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, missing: true, error: "The order file is gone." };
    return { ok: false, missing: false, error: code === "ELOOP" ? "The order file is a symlink." : "The order file cannot be read." };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, missing: false, error: "The order file is not a regular file." };
    if (st.size > ORDER_MAX_BYTES) return { ok: false, missing: false, error: "The order file is larger than 64 KB." };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (!n) break;
      off += n;
    }
    return { ok: true, text: buf.subarray(0, off).toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

/** What Studio reads back from a file (the apply skill's fields); anything else in the file is ignored. */
export const orderReadSchema = z
  .object({
    kind: z.literal("studio_ad"),
    schema: z.literal(1),
    status: z.enum(["staged", "applying", "applied", "failed", "cancelled"]),
    studio_order_id: z.string().regex(/^[a-z0-9]{6,40}$/),
    ad_id: z.union([z.string().regex(/^\d{5,30}$/), z.null()]).optional(),
    ad_name: z.union([z.string().max(300), z.null()]).optional(),
    applied_at: z.union([z.string().max(64), z.null()]).optional(),
    error: z.union([z.string(), z.null()]).optional(),
    /** Phase 6 slice 4: the apply skills also write the creative id and, on a failure, the step it stopped at. */
    creative_id: z.union([z.string().regex(/^\d{5,30}$/), z.null()]).optional(),
    failed_step: z.union([z.string().max(40), z.null()]).optional(),
    /** Gate fixes: an `applying` order's current step and when the apply started (ISO). */
    apply_step: z.union([z.string().max(40), z.null()]).optional(),
    apply_started_at: z.union([z.string().max(64), z.null()]).optional(),
  })
  .passthrough();
export type OrderRead = z.infer<typeof orderReadSchema>;

export type OrderReadResult = { ok: true; order: OrderRead } | { ok: false; missing: boolean; error: string };

/** Read back one order file (guarded, size capped, zod). Never throws. */
export function readOrderFile(cfg: PendingCfg, filePath: string): OrderReadResult {
  const raw = readRaw(cfg, filePath);
  if (!raw.ok) return raw;
  let json: unknown;
  try {
    json = JSON.parse(raw.text);
  } catch {
    return { ok: false, missing: false, error: "The order file is not JSON." };
  }
  const p = orderReadSchema.safeParse(json);
  if (!p.success) return { ok: false, missing: false, error: "The order file's shape is not one Studio wrote (kind / schema / status / ids)." };
  return { ok: true, order: p.data };
}

/**
 * Cancel Studio's own order: only while the FILE says `staged` and carries this `studio_order_id`; the whole JSON is kept
 * with `status: "cancelled"` + `cancelled_at`, written to a temp file in the same folder and renamed over the order. The
 * read-check-write runs holding the order lock (the apply scripts take the same one around their claim): a fresh lock =
 * "the order is being applied, try again"; a lock older than 2 minutes is broken and the result says so.
 * Throws OrderError (and changes nothing) otherwise.
 */
export function cancelOrderFile(cfg: PendingCfg, filePath: string, studioOrderId: string, now = new Date()): { brokeStaleLock: boolean } {
  const at = folderOf(cfg, filePath);
  if (!at) throw new OrderError("Not an order file in the configured folders.");
  const target = path.join(at.real, path.basename(filePath));
  try {
    const r = withOrderLock(target, `${IDENTITY.slug} cancel`, () => {
      const raw = readRaw(cfg, filePath);
      if (!raw.ok) throw new OrderError(raw.missing ? "The order file is gone." : raw.error);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw.text);
      } catch {
        throw new OrderError("The order file is not JSON.");
      }
      const p = orderReadSchema.safeParse(json);
      if (!p.success || p.data.studio_order_id !== studioOrderId) throw new OrderError("That file is not this Studio order.");
      if (p.data.status === "applying") throw new OrderError("The order is being applied in a Claude session: it cannot be cancelled now.");
      if (p.data.status !== "staged") throw new OrderError(`The order is ${p.data.status} already: only a staged order can be cancelled.`);
      const text = `${JSON.stringify({ ...json, status: "cancelled", cancelled_at: now.toISOString() }, null, 2)}\n`;
      if (Buffer.byteLength(text) > ORDER_MAX_BYTES) throw new OrderError("The order is larger than 64 KB.");
      const tmp = path.join(at.real, `.${path.basename(filePath)}.${randomBytes(4).toString("hex")}.tmp`);
      try {
        writeNewPrivateFile(tmp, text);
        const st = fs.lstatSync(target);
        if (st.isSymbolicLink() || !st.isFile()) throw new OrderError("The order file is not a regular file.");
        fs.renameSync(tmp, target);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e instanceof OrderError ? e : new OrderError("Could not cancel the order file.");
      }
    });
    return { brokeStaleLock: r.brokeStale };
  } catch (e) {
    if (e instanceof OrderLockedError) throw new OrderError("The order is being applied, try again.");
    throw e instanceof OrderError ? e : new OrderError("Could not cancel the order file.");
  }
}

// ------------------------------------------------------------------------------------------------ Stage

export type StageInput = {
  channel: string;
  assetId: number;
  copy: AdCopy;
  angleKey: string | null;
  concept: string | null;
  psObj: PsObj | null;
  hookIds: number[];
  /**
   * The copy was prefilled from the media video's own line (NewAdPrefill.videoLine): with no other hook, the order links
   * that video's hook, made now when it has none (adVideoHook, in the same transaction as the row).
   */
  videoHook?: boolean;
  source: { from: OrderSource; ref: string | null };
  notes: string | null;
};

/** The order's day (America/New_York) for the file name. */
function nyDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** The order body exactly as written (documented in DECISIONS "Phase 6 slice 3 build choices"; the apply skills read it). */
export type StudioAdOrder = {
  kind: "studio_ad";
  schema: 1;
  status: "staged";
  studio_order_id: string;
  created_at: string;
  channel: { section: "fkbpros" | "fkb"; code: string };
  act: string;
  media: { kind: "video" | "image"; path: string; file_name: string; bytes: number; fingerprint: string | null };
  angle_key: string | null;
  concept: string | null;
  ps_obj: PsObj | null;
  name_preview: string;
  headlines: string[];
  primaries: string[];
  description: string;
  cta: "LEARN_MORE";
  landing: string;
  hook_ids: number[];
  source: { from: OrderSource; ref: string | null };
  checks: { passed: true; rules_version: number };
  notes: string | null;
};

export type StageResult = { id: number; path: string; studioOrderId: string; namePreview: string; channel: AdChannel };

/**
 * Stage: re-check everything on the server (channel + ad account, media through originalFileFor, every copy rule, the
 * naming fields, the hooks), then write ONE new order file and Studio's `ad_orders` row (the row is inserted in the same
 * transaction, so a failed write leaves no row). Throws OrderError with a terse reason.
 */
export function stageOrder(sql: Sql, cfg: StudioConfig, input: StageInput, now = Date.now()): StageResult {
  const ch = adChannel(sql, input.channel);
  if (!ch) throw new OrderError(`Pick a client or ${laneNames(sql).fkb}.`);
  if (!ch.actId) throw new OrderError("No Meta ad account is known for this channel.");
  if (!ch.landing) throw new OrderError("No landing page is set for this channel (the profile's adCopy.landing).");
  const media = checkAdMedia(sql, cfg, ch, input.assetId);
  if (!media.ok) throw new OrderError(media.error);
  const copy = cleanAdCopy(input.copy);
  const rules = compileAdRules(adRuleContext(sql, cfg, ch));
  const checked = checkAdCopy(copy, rules);
  if (!checked.ok) throw new OrderError(`The copy fails a check: ${checked.all[0]}${checked.all.length > 1 ? ` (+${checked.all.length - 1} more)` : ""}`);
  let concept: string | null = null;
  let psObj: PsObj | null = null;
  if (ch.section === "fkbpros") {
    concept = (input.concept ?? "").trim();
    const bad = conceptProblem(concept, adNaming());
    if (bad) throw new OrderError(bad);
    if (input.psObj !== "ps" && input.psObj !== "obj") throw new OrderError("Pick ps or obj.");
    psObj = input.psObj;
  }
  const hookIds = [...new Set(input.hookIds)];
  if (hookIds.length > 20) throw new OrderError("Too many hooks.");
  const hookFits = (hid: number): boolean | null => {
    const h = sql.prepare("select s.key as section, c.code from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id where h.id = ?").get(hid) as
      | { section: string; code: string | null }
      | undefined;
    if (!h) return null;
    return ch.section === "fkb" ? h.section === "fkb" : h.section === "fkbpros" && (h.code == null || h.code === ch.code);
  };
  for (const hid of hookIds) {
    const fits = hookFits(hid);
    if (fits == null) throw new OrderError("A hook is gone. Reopen the dialog.");
    if (!fits) throw new OrderError("A hook belongs to another channel.");
  }
  const angle = input.angleKey && /^[A-Za-z0-9:_-]{1,80}$/.test(input.angleKey) ? input.angleKey : null;
  const notes = input.notes?.replace(/\r\n?/g, "\n").trim().slice(0, NOTES_MAX) || null;
  const n = nextAdNumber(sql, cfg, ch);
  const preview = namePreview(ch.section, ch.code, concept ?? "", psObj ?? "ps", n, adNaming());
  const studioOrderId = randomBytes(6).toString("hex");
  const name = `STUDIO-${nyDay(now)}-${ch.code}-${studioOrderId}.json`;
  if (!ORDER_NAME.test(name)) throw new OrderError("This channel's code cannot name an order file.");
  const body: StudioAdOrder = {
    kind: "studio_ad",
    schema: 1,
    status: "staged",
    studio_order_id: studioOrderId,
    created_at: new Date(now).toISOString(),
    channel: { section: ch.section, code: ch.code },
    act: ch.actId,
    media: { kind: media.kind, path: media.path, file_name: media.fileName, bytes: media.bytes, fingerprint: media.fingerprint },
    angle_key: angle,
    concept,
    ps_obj: psObj,
    name_preview: preview,
    headlines: copy.headlines,
    primaries: copy.primaries,
    description: copy.description,
    cta: "LEARN_MORE",
    landing: ch.landing,
    hook_ids: hookIds,
    source: { from: input.source.from, ref: input.source.ref ? String(input.source.ref).slice(0, 40) : null },
    checks: { passed: true, rules_version: AD_RULES_VERSION },
    notes,
  };
  return sql.transaction(() => {
    if (input.videoHook && !hookIds.length && media.kind === "video") {
      const vid = adVideoHook(sql, input.assetId, now);
      if (vid != null && hookFits(vid)) hookIds.push(vid);
    }
    body.hook_ids = hookIds;
    const info = sql
      .prepare(
        `insert into ad_orders (studio_order_id, file_path, section_id, client_id, channel_code, act_id, media_asset_id, media_kind, hook_ids,
           source_from, source_ref, name_preview, status, body, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)`,
      )
      .run(
        studioOrderId,
        path.join(pendingDir(cfg, ch.section, true), name),
        ch.sectionId,
        ch.clientId,
        ch.code,
        ch.actId,
        input.assetId,
        media.kind,
        JSON.stringify(hookIds),
        body.source.from,
        body.source.ref,
        preview,
        JSON.stringify(body),
        now,
      );
    const file = writeOrderFile(cfg, ch.section, name, body as unknown as Record<string, unknown>);
    return { id: Number(info.lastInsertRowid), path: file, studioOrderId, namePreview: preview, channel: ch };
  })();
}

/**
 * Cancel one of Studio's staged orders (file first, then the row). Throws OrderError. Returns a note when a stale lock
 * (an apply run that died holding it more than 2 minutes ago) had to be broken.
 */
export function cancelOrder(sql: Sql, cfg: PendingCfg, id: number, now = Date.now()): { note: string | null } {
  const row = sql.prepare("select file_path, studio_order_id, status from ad_orders where id = ?").get(id) as
    | { file_path: string; studio_order_id: string; status: OrderStatus }
    | undefined;
  if (!row) throw new OrderError("That order is gone.");
  if (row.status === "applying") throw new OrderError("The order is being applied in a Claude session: it cannot be cancelled now.");
  if (row.status !== "staged") throw new OrderError(`The order is ${row.status}: only a staged order can be cancelled.`);
  let r: { brokeStaleLock: boolean };
  try {
    r = cancelOrderFile(cfg, row.file_path, row.studio_order_id, new Date(now));
  } catch (e) {
    syncOneOrder(sql, cfg, id, now); // show what the file says now
    throw e;
  }
  sql.prepare("update ad_orders set status = 'cancelled', cancelled_at = ?, status_read_at = ?, read_error = null where id = ?").run(now, now, id);
  return { note: r.brokeStaleLock ? "Cancelled. A stale lock from an apply run that stopped more than 2 minutes ago was cleared." : null };
}

// ------------------------------------------------------------------------------------------------ read-back (worker)

function syncOneOrder(sql: Sql, cfg: PendingCfg, id: number, now: number): OrderStatus | null {
  const row = sql.prepare("select file_path, studio_order_id, status from ad_orders where id = ?").get(id) as
    | { file_path: string; studio_order_id: string; status: OrderStatus }
    | undefined;
  if (!row) return null;
  const r = readOrderFile(cfg, row.file_path);
  if (!r.ok) {
    if (r.missing) {
      sql.prepare("update ad_orders set status = 'missing', status_read_at = ?, read_error = null where id = ?").run(now, id);
      return "missing";
    }
    sql.prepare("update ad_orders set status_read_at = ?, read_error = ? where id = ?").run(now, r.error, id);
    return row.status;
  }
  if (r.order.studio_order_id !== row.studio_order_id) {
    sql.prepare("update ad_orders set status_read_at = ?, read_error = ? where id = ?").run(now, "The file's studio_order_id does not match this order.", id);
    return row.status;
  }
  const o = r.order;
  sql
    .prepare(
      `update ad_orders set status = ?, ad_id = ?, ad_name = ?, applied_at = ?, error = ?, creative_id = ?, failed_step = ?,
         apply_step = ?, apply_started_at = ?, status_read_at = ?, read_error = null,
         cancelled_at = case when ? = 'cancelled' then coalesce(cancelled_at, ?) else cancelled_at end
        where id = ?`,
    )
    .run(
      o.status,
      o.ad_id ?? null,
      o.ad_name ?? null,
      o.applied_at ?? null,
      o.error ? String(o.error).slice(0, 500) : null,
      o.creative_id ?? null,
      o.status === "failed" ? (o.failed_step ?? null) : null,
      o.status === "applying" ? (o.apply_step ?? null) : null,
      o.status === "applying" || o.status === "failed" ? (o.apply_started_at ?? null) : null,
      now,
      o.status,
      now,
      id,
    );
  return o.status;
}

/** Read back every order whose file may still change (staged / applying / failed / missing). Worker only, every 60 s. */
export function syncOrders(sql: Sql, cfg: PendingCfg, now = Date.now()): { read: number; changed: number } {
  const rows = sql
    .prepare(`select id, status from ad_orders where status not in (${FINAL_STATUSES.map((s) => `'${s}'`).join(",")}) order by id`)
    .all() as { id: number; status: OrderStatus }[];
  let changed = 0;
  for (const r of rows) {
    const after = syncOneOrder(sql, cfg, r.id, now);
    if (after && after !== r.status) changed++;
  }
  return { read: rows.length, changed };
}

// ------------------------------------------------------------------------------------------------ views

export type AdOrderView = {
  id: number;
  status: OrderStatus;
  channel: string;
  channelCode: string;
  section: "fkbpros" | "fkb";
  name: string;
  /** The real ad name once applied, else the preview ("number assigned when applied"). */
  named: boolean;
  filePath: string;
  fileName: string;
  mediaName: string | null;
  hookText: string | null;
  hookHref: string | null;
  adId: string | null;
  /** The new ad's creative id (written back by the apply skill). */
  creativeId: string | null;
  /** The apply step a failed order stopped at. */
  failedStep: string | null;
  /** The step an `applying` order is at, when its apply started, and whether that was over 30 minutes ago. */
  applyStep: string | null;
  applyStartedAt: string | null;
  stalled: boolean;
  /** The applied ad is in Studio's synced ads (the Running tab shows it). */
  inRunning: string | null;
  error: string | null;
  readError: string | null;
  createdAt: number;
  statusReadAt: number | null;
  source: OrderSource;
};

const ORDER_COLS = `o.id, o.status, o.channel_code, o.file_path, o.name_preview, o.ad_name, o.ad_id, o.creative_id, o.failed_step, o.apply_step, o.apply_started_at, o.error, o.read_error, o.created_at,
  o.status_read_at, o.source_from, o.hook_ids, s.key as section, c.name as cname, a.filename as media_name,
  (select ad.id from ads ad where ad.meta_ad_id = o.ad_id) as running_ad`;

type OrderRow = {
  id: number;
  status: OrderStatus;
  channel_code: string;
  file_path: string;
  name_preview: string;
  ad_name: string | null;
  ad_id: string | null;
  creative_id: string | null;
  failed_step: string | null;
  apply_step: string | null;
  apply_started_at: string | null;
  error: string | null;
  read_error: string | null;
  created_at: number;
  status_read_at: number | null;
  source_from: OrderSource;
  hook_ids: string;
  section: "fkbpros" | "fkb";
  cname: string | null;
  media_name: string | null;
  running_ad: number | null;
};

/** An `applying` order whose apply started more than 30 minutes ago "may have stopped" (still not failed). */
export function applyStalled(status: OrderStatus, startedAt: string | null, now = Date.now()): boolean {
  if (status !== "applying" || !startedAt) return false;
  const t = Date.parse(startedAt);
  return Number.isFinite(t) && now - t > APPLY_STALL_MS;
}

function toView(sql: Sql, r: OrderRow, now: number): AdOrderView {
  let hookIds: number[] = [];
  try {
    hookIds = JSON.parse(r.hook_ids);
  } catch {
    /* none */
  }
  const h = hookIds.length
    ? (sql.prepare("select h.id, h.text, h.kind, s.key as section, c.code from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id where h.id = ?").get(hookIds[0]) as
        | { id: number; text: string; kind: string; section: string; code: string | null }
        | undefined)
    : undefined;
  return {
    id: r.id,
    status: r.status,
    channel: r.section === "fkb" ? laneNames(sql).fkb : r.cname ? clientShortName(r.cname) : r.channel_code,
    channelCode: r.channel_code,
    section: r.section,
    name: r.ad_name ?? r.name_preview,
    named: Boolean(r.ad_name),
    filePath: r.file_path,
    fileName: path.basename(r.file_path),
    mediaName: r.media_name,
    hookText: h?.text ?? null,
    hookHref: h ? `${hooksPath(h.section, h.code)}?${h.kind === "video" ? "view=video&" : ""}focus=${h.id}` : null,
    adId: r.ad_id,
    creativeId: r.creative_id,
    failedStep: r.failed_step,
    applyStep: r.apply_step,
    applyStartedAt: r.apply_started_at,
    stalled: applyStalled(r.status, r.apply_started_at, now),
    inRunning: r.running_ad != null ? `${channelHref(r.section, r.section === "fkb" ? null : r.channel_code, "running")}?status=all&w=lifetime` : null,
    error: r.error,
    readError: r.read_error,
    createdAt: r.created_at,
    statusReadAt: r.status_read_at,
    source: r.source_from,
  };
}

/** Ad orders for the Jobs page: staged / applying first, then newest. */
export function adOrders(sql: Sql, limit = 40, now = Date.now()): AdOrderView[] {
  const rows = sql
    .prepare(
      `select ${ORDER_COLS} from ad_orders o join sections s on s.id = o.section_id left join clients c on c.id = o.client_id
        left join assets a on a.id = o.media_asset_id
        order by case o.status when 'applying' then 0 when 'staged' then 0 else 1 end, o.created_at desc limit ?`,
    )
    .all(limit) as OrderRow[];
  return rows.map((r) => toView(sql, r, now));
}

export type OrderBadge = {
  id: number;
  status: OrderStatus;
  name: string;
  named: boolean;
  inRunning: boolean;
  /** `applying`: the step it is at, and whether it started over 30 minutes ago ("may have stopped"). */
  applyStep: string | null;
  stalled: boolean;
};

type BadgeRow = { id: number; status: OrderStatus; name_preview: string; ad_name: string | null; apply_step: string | null; apply_started_at: string | null };

function badge(r: BadgeRow, inRunning: boolean, now: number): OrderBadge {
  return {
    id: r.id,
    status: r.status,
    name: r.ad_name ?? r.name_preview,
    named: Boolean(r.ad_name),
    inRunning,
    applyStep: r.status === "applying" ? r.apply_step : null,
    stalled: applyStalled(r.status, r.apply_started_at, now),
  };
}

/** The newest order per hook (any of its hook ids), for the hook row's "Staged as a PAUSED ad" line. */
export function ordersByHook(sql: Sql, hookIds: number[], now = Date.now()): Map<number, OrderBadge> {
  const out = new Map<number, OrderBadge>();
  if (!hookIds.length) return out;
  const rows = sql
    .prepare(
      `select o.id, o.status, o.name_preview, o.ad_name, o.apply_step, o.apply_started_at, j.value as hook_id, (select 1 from ads ad where ad.meta_ad_id = o.ad_id) as running
         from ad_orders o, json_each(o.hook_ids) j
        where j.value in (select value from json_each(?)) order by o.created_at desc`,
    )
    .all(JSON.stringify(hookIds)) as (BadgeRow & { hook_id: number; running: number | null })[];
  for (const r of rows) {
    if (out.has(r.hook_id)) continue;
    out.set(r.hook_id, badge(r, Boolean(r.running), now));
  }
  return out;
}

/** The newest order started from each Running ad (a Winner chip's "New ad"), by Meta ad id. */
export function ordersByWinnerAd(sql: Sql, metaAdIds: string[], now = Date.now()): Map<string, OrderBadge> {
  const out = new Map<string, OrderBadge>();
  if (!metaAdIds.length) return out;
  const rows = sql
    .prepare(
      `select o.id, o.status, o.name_preview, o.ad_name, o.apply_step, o.apply_started_at, o.source_ref, (select 1 from ads ad where ad.meta_ad_id = o.ad_id) as running
         from ad_orders o where o.source_from = 'winner' and o.source_ref in (select value from json_each(?)) order by o.created_at desc`,
    )
    .all(JSON.stringify(metaAdIds)) as (BadgeRow & { source_ref: string; running: number | null })[];
  for (const r of rows) {
    if (out.has(r.source_ref)) continue;
    out.set(r.source_ref, badge(r, Boolean(r.running), now));
  }
  return out;
}

/** Studio's applied orders by the Meta ad id they created (a Running card of such an ad says "Staged in Studio"). */
export function ordersByAppliedAd(sql: Sql, metaAdIds: string[], now = Date.now()): Map<string, OrderBadge> {
  const out = new Map<string, OrderBadge>();
  if (!metaAdIds.length) return out;
  const rows = sql
    .prepare(
      `select o.id, o.status, o.name_preview, o.ad_name, o.apply_step, o.apply_started_at, o.ad_id from ad_orders o
        where o.ad_id in (select value from json_each(?)) order by o.created_at desc`,
    )
    .all(JSON.stringify(metaAdIds)) as (BadgeRow & { ad_id: string })[];
  for (const r of rows) if (!out.has(r.ad_id)) out.set(r.ad_id, badge(r, true, now));
  return out;
}

/** Meta ad ids Studio's orders created (any status with an `ad_id`: applied, or applying / failed after the ad step). */
export function orderedAdIds(sql: Sql): Set<string> {
  return new Set(sql.prepare("select ad_id from ad_orders where ad_id is not null").pluck().all() as string[]);
}

/** "being applied in a Claude session, step X" (+ "may have stopped at step X" after 30 minutes). */
export function applyingText(step: string | null, stalled: boolean): string {
  if (stalled) return `may have stopped at step ${step ?? "?"} (still applying after 30 minutes: check the Claude session)`;
  return `being applied in a Claude session${step ? `, step ${step}` : ""}`;
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  staged: "staged, waiting for an apply session",
  applying: "being applied in a Claude session",
  applied: "applied (PAUSED on Meta)",
  failed: "failed in the apply session",
  cancelled: "cancelled",
  missing: "order file missing",
};

