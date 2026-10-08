/**
 * The Client tab (Phase 4 G1, slice 2; server only): brand notes, the one-line Jev hint, the read-only ad account +
 * folder rules, and "What works here" (the owner's free-text items and pinned hooks, ordered). Every Lane B client has
 * one, and Lane C (Phase 5 slice 2, channel code `fkb`: a section with no clients row) has one too: its notes and hint live
 * in `notes` (keys fkb / fkb_hint), its What works here rows have client_id null and section_id = the fkb section.
 *
 * Every write here only changes notes: nothing is rescored or re-filed. Hook scoring reads the new notes on its next
 * call and the Hooks tab shows "Notes changed since these were scored" for the hooks scored with the old ones. Classify
 * reads a client's hint on its next call only (files already classified are not re-filed). All SQL is parameterized.
 */
import type Database from "better-sqlite3";
import { clientShortName } from "../media";
import { companyName, FKB_HINT_KEY, FKB_NOTE_KEY, getNoteRow, noteLines, type WorksOwner } from "./notes";
import { HOOK_LIVE, hooksPath } from "./sql";
import { channelIds } from "./store";
import { laneNames } from "../clients-admin";

type Sql = Database.Database;

export const BRAND_NOTES_MAX = 4_000;
export const HINT_MAX = 300;
export const WORK_MAX = 300;
export const WORKS_MAX_ITEMS = 40;

export class ClientTabError extends Error {}

/** The Client tab's channel code for Lane C (no client has it: client codes are the Lane B client codes). */
export const FKB_CODE = "fkb";

/** The owner of a Client tab's What works here: a Lane B client by code, or Lane C (`fkb`). */
export function worksOwner(sql: Sql, code: string): WorksOwner {
  try {
    if (code === FKB_CODE) return { sectionId: channelIds(sql, { section: "fkb", clientCode: null }).sectionId, clientId: null };
    const ids = channelIds(sql, { section: "fkbpros", clientCode: code });
    return { sectionId: ids.sectionId, clientId: ids.clientId };
  } catch {
    throw new ClientTabError("Unknown client.");
  }
}

const OWNER = "w.section_id = ? and w.client_id is ?";
const ownerArgs = (o: WorksOwner) => [o.sectionId, o.clientId] as const;

function upsertNote(sql: Sql, key: string, body: string | null, savedAt: number | null, now: number) {
  sql
    .prepare(
      `insert into notes (key, body, saved_at, updated_at) values (?, ?, ?, ?)
       on conflict(key) do update set body = excluded.body, saved_at = coalesce(excluded.saved_at, notes.saved_at), updated_at = excluded.updated_at`,
    )
    .run(key, body ?? "", savedAt, now);
}

/** Save the owner's brand notes: the "Draft, check me" label goes away for good. Blank lines are kept as typed. */
export function saveBrandNotes(sql: Sql, code: string, body: string, now = Date.now()): void {
  const text = body.replace(/\r\n/g, "\n").trim().slice(0, BRAND_NOTES_MAX);
  const o = worksOwner(sql, code);
  if (o.clientId == null) return upsertNote(sql, FKB_NOTE_KEY, text, now, now);
  sql.prepare("update clients set brand_notes = ?, brand_notes_saved_at = ? where id = ?").run(text || null, now, o.clientId);
}

/** Save the one-line Jev hint (line breaks become spaces). Files already classified are not re-filed. */
export function saveHint(sql: Sql, code: string, hint: string, now = Date.now()): void {
  const text = hint.replace(/\s+/g, " ").trim().slice(0, HINT_MAX);
  const o = worksOwner(sql, code);
  if (o.clientId == null) return upsertNote(sql, FKB_HINT_KEY, text, now, now);
  sql.prepare("update clients set classify_hint = ? where id = ?").run(text || null, o.clientId);
}

export type WorkItem = {
  id: number;
  /** Free text (null for a pinned hook). */
  body: string | null;
  hook: null | {
    id: number;
    text: string;
    kind: "text" | "video";
    archived: boolean;
    overall: number | null;
    /**
     * Where the pin stands: `live` = rides along in this client's scoring; `archived` (archived or a discarded variant),
     * `hidden` (its video is missing, ignored or in a disabled root) and `moved` (it now belongs to another channel) are
     * left out of the state and the fingerprint until the hook is back (see worksLines).
     */
    state: "live" | "archived" | "hidden" | "moved";
    /** The Hooks tab that has the row now (another channel when moved). */
    href: string;
  };
};

export function listWorks(sql: Sql, code: string): WorkItem[] {
  const rows = sql
    .prepare(
      `select w.id, w.body, h.id as hook_id, h.text, h.kind, h.archived_at,
              (h.archived_at is null and (h.parent_id is null or h.kept = 1)) as active, (${HOOK_LIVE}) as live,
              (h.client_id is w.client_id and h.section_id = w.section_id) as here, s.key as section, hc.code as hook_code,
              (select hs.overall from hook_scores hs where hs.hook_id = h.id
                  order by hs.rubric_version desc limit 1) as overall
         from client_works w left join hooks h on h.id = w.hook_id
         left join sections s on s.id = h.section_id left join clients hc on hc.id = h.client_id
        where ${OWNER} order by w.sort, w.id`,
    )
    .all(...ownerArgs(worksOwner(sql, code))) as {
    id: number;
    body: string | null;
    hook_id: number | null;
    text: string | null;
    kind: "text" | "video" | null;
    archived_at: number | null;
    active: number | null;
    live: number | null;
    here: number | null;
    section: "rtm" | "fkbpros" | "fkb" | null;
    hook_code: string | null;
    overall: number | null;
  }[];
  return rows.map((r) => {
    if (r.hook_id == null) return { id: r.id, body: r.body, hook: null };
    const kind = r.kind ?? "text";
    const state: NonNullable<WorkItem["hook"]>["state"] = !r.active ? "archived" : !r.here ? "moved" : !r.live ? "hidden" : "live";
    const base = hooksPath(r.section, r.hook_code);
    const href = `${base}?${kind === "video" ? "view=video&" : ""}${r.archived_at != null ? "archived=1&" : ""}focus=${r.hook_id}`;
    return {
      id: r.id,
      body: null,
      hook: { id: r.hook_id, text: r.text ?? "", kind, archived: r.archived_at != null, overall: r.overall, state, href },
    };
  });
}

function nextSort(sql: Sql, o: WorksOwner): number {
  return ((sql.prepare(`select max(sort) from client_works w where ${OWNER}`).pluck().get(...ownerArgs(o)) as number | null) ?? 0) + 1;
}

function guardCount(sql: Sql, o: WorksOwner) {
  const n = sql.prepare(`select count(*) from client_works w where ${OWNER}`).pluck().get(...ownerArgs(o)) as number;
  if (n >= WORKS_MAX_ITEMS) throw new ClientTabError(`At most ${WORKS_MAX_ITEMS} items. Remove one first.`);
}

const cleanWork = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, WORK_MAX);

/** Add a free-text item at the end. */
export function addWork(sql: Sql, code: string, body: string, now = Date.now()): number {
  const o = worksOwner(sql, code);
  const text = cleanWork(body);
  if (!text) throw new ClientTabError("Type what works first.");
  guardCount(sql, o);
  const info = sql
    .prepare("insert into client_works (client_id, section_id, body, sort, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
    .run(o.clientId, o.sectionId, text, nextSort(sql, o), now, now);
  return Number(info.lastInsertRowid);
}

/** Edit a free-text item (a pinned hook's text is the hook's own; it cannot be edited here). */
export function editWork(sql: Sql, code: string, workId: number, body: string, now = Date.now()): void {
  const text = cleanWork(body);
  if (!text) throw new ClientTabError("An item cannot be empty. Remove it instead.");
  const n = sql
    .prepare(`update client_works as w set body = ?, updated_at = ? where w.id = ? and ${OWNER} and w.hook_id is null`)
    .run(text, now, workId, ...ownerArgs(worksOwner(sql, code))).changes;
  if (!n) throw new ClientTabError("Item not found.");
}

export function removeWork(sql: Sql, code: string, workId: number): void {
  const n = sql.prepare(`delete from client_works as w where w.id = ? and ${OWNER}`).run(workId, ...ownerArgs(worksOwner(sql, code))).changes;
  if (!n) throw new ClientTabError("Item not found.");
}

/** Move an item one place up or down (swaps sort values with its neighbour). */
export function moveWork(sql: Sql, code: string, workId: number, dir: "up" | "down", now = Date.now()): void {
  const rows = sql
    .prepare(`select w.id, w.sort from client_works w where ${OWNER} order by w.sort, w.id`)
    .all(...ownerArgs(worksOwner(sql, code))) as { id: number; sort: number }[];
  const i = rows.findIndex((r) => r.id === workId);
  if (i < 0) throw new ClientTabError("Item not found.");
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= rows.length) return;
  // Renumber in the new order (sorts may have ties from older rows).
  const order = rows.map((r) => r.id);
  [order[i], order[j]] = [order[j], order[i]];
  const set = sql.prepare("update client_works set sort = ?, updated_at = ? where id = ?");
  sql.transaction(() => order.forEach((wid, k) => set.run(k + 1, now, wid)))();
}

/**
 * Pin a hook to its channel's "What works here": a Lane B client's own hook, or a Lane C hook. Pinning twice is a no-op.
 * Returns the channel code the hook was pinned to (a client code, or `fkb`).
 */
export function pinHook(sql: Sql, hookId: number, now = Date.now()): string {
  const h = sql
    .prepare("select h.section_id, h.client_id, c.code, s.key as section from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id where h.id = ?")
    .get(hookId) as { section_id: number; client_id: number | null; code: string | null; section: string } | undefined;
  const o: WorksOwner | null = !h ? null : h.client_id != null ? { sectionId: h.section_id, clientId: h.client_id } : h.section === "fkb" ? { sectionId: h.section_id, clientId: null } : null;
  if (!h || !o) {
    const L = laneNames(sql);
    throw new ClientTabError(`Only a client's own hooks and ${L.fkb}'s hooks can be pinned (shared and ${L.rtm} hooks have no Client tab).`);
  }
  const have = sql.prepare(`select 1 from client_works w where ${OWNER} and w.hook_id = ?`).get(...ownerArgs(o), hookId);
  if (!have) {
    guardCount(sql, o);
    sql
      .prepare("insert into client_works (client_id, section_id, hook_id, sort, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
      .run(o.clientId, o.sectionId, hookId, nextSort(sql, o), now, now);
  }
  return h.code ?? FKB_CODE;
}

/** Unpin a hook from every client list that has it (its own client's and a stale pin left behind after a move). */
export function unpinHook(sql: Sql, hookId: number): number {
  return sql.prepare("delete from client_works where hook_id = ?").run(hookId).changes;
}

/**
 * Hook ids pinned to their own channel's list (the Hooks tab marks them "Pinned"). A pin left behind in another client's
 * list after the hook moved does not count: the row can be pinned again in its new channel.
 */
export function pinnedHookIds(sql: Sql, hookIds: number[]): Set<number> {
  if (!hookIds.length) return new Set();
  const rows = sql
    .prepare(
      `select distinct w.hook_id from client_works w join hooks h on h.id = w.hook_id and h.client_id is w.client_id and h.section_id = w.section_id
        where w.hook_id in (select value from json_each(?))`,
    )
    .pluck()
    .all(JSON.stringify(hookIds)) as number[];
  return new Set(rows);
}

export type ClientTabData = {
  /** A Lane B client, or Lane C itself (Phase 5 slice 2: no clients row; notes in `notes`, no folder rules). */
  kind: "client" | "fkb";
  code: string;
  name: string;
  short: string;
  brandNotes: string;
  brandNotesSavedAt: number | null;
  brandNoteLines: number;
  hint: string;
  metaAdAccountId: string | null;
  /** Folder rules that tag this client (read only here; edited in Settings). Lane C has none (it has no clients). */
  rules: { id: number; glob: string; codes: string[] }[];
  /** Lane C: its Library roots (read only here; added in Settings). */
  roots: { id: number; path: string; enabled: boolean }[];
  /** Lane C: where its CPL leads come from now (`meta` until a GHL contact carries source fkb-fb-ad). */
  leadsSource: "ghl" | "meta" | null;
  works: WorkItem[];
};

function tagRulesFor(sql: Sql, code: string) {
  return (sql.prepare("select id, path_glob, client_codes from tag_rules order by id").all() as { id: number; path_glob: string; client_codes: string }[])
    .map((r) => {
      let codes: string[] = [];
      try {
        codes = JSON.parse(r.client_codes);
      } catch {
        /* ignore */
      }
      return { id: r.id, glob: r.path_glob, codes };
    })
    .filter((r) => r.codes.includes(code));
}

export function clientTabData(sql: Sql, code: string): ClientTabData {
  const o = worksOwner(sql, code);
  if (o.clientId == null) {
    const notes = getNoteRow(sql, FKB_NOTE_KEY);
    const acc = sql
      .prepare("select act_id, leads_source from ad_accounts where section_id = ? and client_id is null order by sort, id limit 1")
      .get(o.sectionId) as { act_id: string; leads_source: string | null } | undefined;
    const roots = (sql.prepare("select id, path, enabled from roots where section_id = ? order by path").all(o.sectionId) as { id: number; path: string; enabled: number }[]).map(
      (r) => ({ id: r.id, path: r.path, enabled: r.enabled === 1 }),
    );
    return {
      kind: "fkb",
      code: FKB_CODE,
      name: companyName(),
      short: laneNames(sql).fkb,
      brandNotes: notes?.body ?? "",
      brandNotesSavedAt: notes?.savedAt ?? null,
      brandNoteLines: noteLines(notes?.body).length,
      hint: getNoteRow(sql, FKB_HINT_KEY)?.body ?? "",
      metaAdAccountId: acc?.act_id ?? null,
      rules: [],
      roots,
      leadsSource: acc?.leads_source === "ghl" ? "ghl" : acc?.leads_source === "meta" ? "meta" : null,
      works: listWorks(sql, code),
    };
  }
  const c = sql
    .prepare("select code, name, brand_notes, brand_notes_saved_at, classify_hint, meta_ad_account_id from clients where id = ?")
    .get(o.clientId) as {
    code: string;
    name: string;
    brand_notes: string | null;
    brand_notes_saved_at: number | null;
    classify_hint: string | null;
    meta_ad_account_id: string | null;
  };
  return {
    kind: "client",
    code: c.code,
    name: c.name,
    short: clientShortName(c.name),
    brandNotes: c.brand_notes ?? "",
    brandNotesSavedAt: c.brand_notes_saved_at,
    brandNoteLines: noteLines(c.brand_notes).length,
    hint: c.classify_hint ?? "",
    metaAdAccountId: c.meta_ad_account_id,
    rules: tagRulesFor(sql, code),
    roots: [],
    leadsSource: null,
    works: listWorks(sql, code),
  };
}
