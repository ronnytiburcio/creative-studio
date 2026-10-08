/**
 * Notes outside the rubric version (server only): Lane A notes and the who's who note (`notes` table), the Lane B client
 * brand notes (clients.brand_notes + brand_notes_saved_at), Lane C's own brand notes + hint (`notes` keys fkb / fkb_hint,
 * Phase 5 slice 2) and the section briefs (versioned with the rubric since v3: `briefOf`). They ride along in the hook
 * scoring state (and the who's who note in search by meaning); their edits never rescore by themselves, they only
 * change the notes fingerprint stored on each score (slice 2's "notes changed" flag).
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { SECTION_KEYS, type RubricBriefs, type SectionKey } from "./rubric";
import { HOOK_LIVE } from "./sql";
import { profile } from "../profile";

type Sql = Database.Database;

export const NOTE_KEYS = ["rtm", "whos_who"] as const;
export type NoteKey = (typeof NOTE_KEYS)[number];
/** The Rubric page's note titles ("<Lane A> notes", "Who's who"). */
export function noteLabel(key: NoteKey, laneA: string): string {
  return key === "rtm" ? `${laneA} notes` : "Who's who";
}

/**
 * Lane C (Phase 5 slice 2) has no clients row, so its brand notes and its one-line hint live in `notes` too (seed v8 drafts,
 * saved_at null = "Draft, check me"), edited on Lane C's Client tab (not the Rubric page's two editors).
 */
export const FKB_NOTE_KEY = "fkb";
export const FKB_HINT_KEY = "fkb_hint";
/** Lane C's name as the hook state and the Client tab say it (it speaks as itself): the profile's lane full name. */
export function companyName(): string {
  return profile().lanes.fkb.fullName;
}

/**
 * The section brief a rubric version WITHOUT its own `briefs` was scored with (every version before the briefs column):
 * the business profile's `hooks.legacyBriefs` (Creative Studio slice 1c; an install keeps its texts there byte for byte,
 * and they are never edited: a new brief goes into a NEW rubric version's `briefs`). Read through `briefOf` only.
 */
export function legacyBrief(section: SectionKey): string {
  return profile().hooks.legacyBriefs[section];
}

/**
 * The brief Jev reads as `channel.brief` for a section under a rubric version: the version's own (`briefs`, since v3),
 * else the legacy text. Every reader (hook state, variants, ad copy drafts, the Rubric page) goes through here.
 */
export function briefOf(rubric: { briefs?: RubricBriefs | null }, section: SectionKey): string {
  return rubric.briefs?.[section] ?? legacyBrief(section);
}

/** Every section's resolved brief (what `computeSectionVersions` compares). */
export function briefsOf(rubric: { briefs?: RubricBriefs | null }): Record<SectionKey, string> {
  return Object.fromEntries(SECTION_KEYS.map((s) => [s, briefOf(rubric, s)])) as Record<SectionKey, string>;
}

export type Note = { key: NoteKey; body: string; savedAt: number | null; updatedAt: number };

export function getNote(sql: Sql, key: NoteKey): Note | null {
  const row = sql.prepare("select key, body, saved_at, updated_at from notes where key = ?").get(key) as
    | { key: NoteKey; body: string; saved_at: number | null; updated_at: number }
    | undefined;
  return row ? { key: row.key, body: row.body, savedAt: row.saved_at, updatedAt: row.updated_at } : null;
}

/** A note row by any key (Lane C's notes and hint use keys outside NOTE_KEYS). */
export function getNoteRow(sql: Sql, key: string): { body: string; savedAt: number | null } | null {
  const row = sql.prepare("select body, saved_at from notes where key = ?").get(key) as { body: string; saved_at: number | null } | undefined;
  return row ? { body: row.body, savedAt: row.saved_at } : null;
}

/** The who's who text ("" when missing). */
export function whosWho(sql: Sql): string {
  return getNote(sql, "whos_who")?.body.trim() ?? "";
}

/** Note text as a list of lines (blank lines dropped): how the state carries it. */
export function noteLines(body: string | null | undefined): string[] {
  return (body ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export type ClientNotes = { code: string; name: string; hint: string | null; brandNotes: string | null; savedAt: number | null };

export function clientNotes(sql: Sql, clientId: number): ClientNotes | null {
  const row = sql.prepare("select code, name, classify_hint, brand_notes, brand_notes_saved_at from clients where id = ?").get(clientId) as
    | { code: string; name: string; classify_hint: string | null; brand_notes: string | null; brand_notes_saved_at: number | null }
    | undefined;
  return row ? { code: row.code, name: row.name, hint: row.classify_hint, brandNotes: row.brand_notes, savedAt: row.brand_notes_saved_at } : null;
}

export function allClientNotes(sql: Sql): ClientNotes[] {
  return (
    sql.prepare("select c.code, c.name, c.classify_hint, c.brand_notes, c.brand_notes_saved_at from clients c order by c.sort, c.name").all() as {
      code: string;
      name: string;
      classify_hint: string | null;
      brand_notes: string | null;
      brand_notes_saved_at: number | null;
    }[]
  ).map((r) => ({ code: r.code, name: r.name, hint: r.classify_hint, brandNotes: r.brand_notes, savedAt: r.brand_notes_saved_at }));
}

/** Short stable fingerprint of the notes a score's state carried (order-sensitive JSON, sha1, 16 hex). */
export function notesFingerprint(parts: unknown): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * The notes one channel's hooks are scored with (slice 2): the client (name, hint, brand notes) for a Lane B client
 * hook, the Lane A notes for a Lane A hook, the who's who note for every hook, and the client's "What works here" lines.
 * A HookInput carries exactly these fields, so the worker's state and the Hooks tab's "notes changed" check read one
 * definition (`channelNoteParts` / `channelNotesFp`).
 */
export type ChannelNotes = {
  section: SectionKey;
  client: { code: string; name: string; hint: string | null; brandNotes: string | null } | null;
  rtmNotes: string | null;
  /** Lane C hooks (section fkb): Lane C's own brand notes and one-line hint (notes keys `fkb` / `fkb_hint`). */
  fkb?: { brandNotes: string | null; hint: string | null } | null;
  whosWho: string;
  /** "What works here" lines (client and Lane C hooks only; pinned hooks as "Pinned hook: <text>"). */
  works?: string[];
};

/**
 * The note lines the state carries for a channel (blank lines dropped). Lane A and Lane B read exactly what they read
 * before Lane C existed (their fingerprints do not move); Lane C reads its own notes, hint and What works here.
 */
export function channelNoteParts(n: ChannelNotes): { notes: string[]; hint: string | null; whos: string[]; works: string[] } {
  const own = n.section === "fkb" ? (n.fkb ?? null) : null;
  return {
    notes: n.section === "rtm" ? noteLines(n.rtmNotes) : n.section === "fkb" ? noteLines(own?.brandNotes) : noteLines(n.client?.brandNotes),
    hint: n.section === "fkb" ? (own?.hint?.trim() || null) : (n.client?.hint?.trim() ?? null),
    whos: noteLines(n.whosWho),
    works: n.client || n.section === "fkb" ? (n.works ?? []).map((l) => l.trim()).filter(Boolean) : [],
  };
}

/**
 * Fingerprint of exactly what the state carries. `works` joins only when the channel has items, so every score from
 * slice 1 (no "What works here" yet) keeps matching until something actually changes.
 */
export function channelNotesFp(n: ChannelNotes): string {
  const p = channelNoteParts(n);
  return notesFingerprint(p.works.length ? { notes: p.notes, hint: p.hint, whos: p.whos, works: p.works } : { notes: p.notes, hint: p.hint, whos: p.whos });
}

/** Pinned hook lines are prefixed so Jev can tell them from the owner's own notes. */
export const PINNED_PREFIX = "Pinned hook: ";

/**
 * Who owns a "What works here" list: a Lane B client (clientId), or Lane C (the fkb section, client null). A row's owner
 * is (section_id, client_id); section_id is set on every row since migration 0011.
 */
export type WorksOwner = { sectionId: number; clientId: number | null };

/**
 * A channel's "What works here" lines, in order (free text as written; pinned hooks with their current text). A pinned
 * hook rides along only while it is live (not archived or discarded, its video visible) AND still this channel's: a pin
 * whose hook was archived or moved to another channel is left out of the state and the fingerprint (the Client tab shows
 * it as "no longer in this channel" with Unpin). Restoring the hook, or it moving back, brings the line back.
 */
export function worksLines(sql: Sql, owner: WorksOwner): string[] {
  return (
    sql
      .prepare(
        `select w.body, h.text as hook_text from client_works w
           left join hooks h on h.id = w.hook_id and h.client_id is w.client_id and h.section_id = w.section_id and ${HOOK_LIVE}
          where w.section_id = ? and w.client_id is ? order by w.sort, w.id`,
      )
      .all(owner.sectionId, owner.clientId) as { body: string | null; hook_text: string | null }[]
  )
    .map((r) => (r.hook_text != null ? `${PINNED_PREFIX}${r.hook_text}` : (r.body ?? "")))
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Load a channel's notes from the DB (client null = Lane A, Lane B shared or Lane C). */
export function loadChannelNotes(sql: Sql, section: SectionKey, clientId: number | null): ChannelNotes {
  const client = clientId
    ? (sql.prepare("select code, name, classify_hint, brand_notes, section_id from clients where id = ?").get(clientId) as
        | { code: string; name: string; classify_hint: string | null; brand_notes: string | null; section_id: number }
        | undefined)
    : undefined;
  const out: ChannelNotes = {
    section,
    client: client ? { code: client.code, name: client.name, hint: client.classify_hint, brandNotes: client.brand_notes } : null,
    rtmNotes: section === "rtm" ? (getNote(sql, "rtm")?.body ?? null) : null,
    whosWho: whosWho(sql),
    works: client && clientId ? worksLines(sql, { sectionId: client.section_id, clientId }) : [],
  };
  if (section === "fkb") {
    const sectionId = sql.prepare("select id from sections where key = 'fkb'").pluck().get() as number | undefined;
    out.fkb = { brandNotes: getNoteRow(sql, FKB_NOTE_KEY)?.body ?? null, hint: getNoteRow(sql, FKB_HINT_KEY)?.body ?? null };
    out.works = sectionId != null ? worksLines(sql, { sectionId, clientId: null }) : [];
  }
  return out;
}

export const NOTE_MAX = 4_000;

/**
 * Save the owner's Lane A notes or who's who note (Rubric page, slice 3). Not versioned: the "Draft, check me" label goes away
 * and the hooks scored with the old text show "Notes changed" (the fingerprint moves). Nothing rescores by itself.
 */
export function saveNote(sql: Sql, key: NoteKey, body: string, now = Date.now()): void {
  const text = body.replace(/\r\n/g, "\n").trim().slice(0, NOTE_MAX);
  sql
    .prepare(
      `insert into notes (key, body, saved_at, updated_at) values (?, ?, ?, ?)
       on conflict(key) do update set body = excluded.body, saved_at = excluded.saved_at, updated_at = excluded.updated_at`,
    )
    .run(key, text, now, now);
}
