/**
 * Video hooks (Phase 4 B4, slice 2; server only). One hook row per video (partial unique index
 * `hooks_video_asset_uniq`), created by the worker's sync for:
 *   - every visible video Jev found hookable (classify answer `hookable` >= 0.75, the owner's answer included), and
 *   - every visible video in a Lane B `Intro/` folder (the setter's filmed openings),
 *   - never a video in an `Outro/` or `Outtro/` folder (closing lines are not hooks).
 * Any other video gets one from the drawer's "Add as hook". Text = the first sentence of the spoken opening (the slice 1
 * short-first-sentence rule; a whisper run-on is cut at its first clause break, see spokenHookLine), else the on-screen
 * text from the description's `Text:` line, else (no words at all) the description's opening line. Channel = the asset's channel: Lane A -> Lane A; Lane B with exactly one client tag -> that
 * client, else Lane B shared.
 *
 * The sync keeps rows in step with the asset (text refreshed after a re-describe, channel following the client tags)
 * and never deletes a row: missing / ignored / disabled-root assets only hide their hook (see HOOK_LIVE in store.ts).
 * Everything here is parameterized SQL on the app DB; nothing touches the drive.
 */
import type Database from "better-sqlite3";
import { firstSentence } from "./text";
import { HOOK_MAX_CHARS, normHook, type SectionKey } from "./rubric";
import { hooksPath } from "./sql";

type Sql = Database.Database;

/** Jev's hookable answer at or above this creates a video hook. */
export const HOOKABLE_MIN = 0.75;

export type VideoTextSource = "spoken" | "on_screen" | "opening";

const segments = (relPath: string) => relPath.split("/").slice(0, -1);

/** In an `Outro/` or `Outtro/` folder (any depth, any case). */
export function isOutroPath(relPath: string): boolean {
  return segments(relPath).some((s) => /^out+ro$/i.test(s.trim()));
}

/** In an `Intro/` folder (any depth, any case). */
export function isIntroPath(relPath: string): boolean {
  return segments(relPath).some((s) => /^intro$/i.test(s.trim()));
}

/** A labelled line of a Phase 3 description ("First 3 seconds: ...", "Text: ..."), or null. */
export function descriptionLine(description: string | null | undefined, labels: string[]): { label: string; value: string } | null {
  for (const line of (description ?? "").split(/\r?\n/)) {
    const m = /^([A-Za-z0-9 ]+):\s*(.*)$/.exec(line.trim());
    if (m && labels.includes(m[1].toLowerCase()) && m[2].trim()) return { label: m[1].toLowerCase(), value: m[2].trim() };
  }
  return null;
}

const PLACEHOLDER = /^\[(?:small\s+)?(?:logo|text)[^\]]*\]$/i;

/** The `Text:` line's pieces ("a" | "b"), quotes and "[small logo]" placeholders removed; [] for "none". */
export function onScreenPieces(textLine: string | null | undefined): string[] {
  const line = (textLine ?? "").trim();
  if (!line || /^(?:none|no (?:readable )?text)\b/i.test(line)) return [];
  return line
    .split(/\s*\|\s*/)
    .map((p) => p.trim().replace(/^["“”']+|["“”']+$/g, "").trim())
    .filter((p) => p && !PLACEHOLDER.test(p) && !/^none$/i.test(p));
}

export type VideoLines = {
  /** The description's opening line ("First 3 seconds", or "Early frame" when the poster stood in). */
  opening: string | null;
  earlyFrame: boolean;
  /** The whole on-screen text line (null when it says none). */
  onScreen: string | null;
  spoken: string | null;
};

export function videoLines(description: string | null | undefined, spokenOpen: string | null | undefined): VideoLines {
  const opening = descriptionLine(description, ["first 3 seconds", "early frame"]);
  const text = descriptionLine(description, ["text"]);
  const pieces = onScreenPieces(text?.value);
  return {
    opening: opening?.value ?? null,
    earlyFrame: opening?.label === "early frame",
    onScreen: pieces.length ? pieces.join(" | ") : null,
    spoken: spokenOpen?.trim() || null,
  };
}

/** A spoken first "sentence" longer than this is a whisper run-on (no full stop heard), not one line. */
export const RUNON_WORDS = 25;
const STARTERS = /^(?:someone|so|and|but|now|then|this|that|here|there|if|when|we|you|they|it|the|a|most|every|what|why|how|watch|look|see|imagine|today)$/i;

/**
 * The spoken hook line: the first sentence (slice 1's rule: a first sentence under 4 words takes the next one too).
 * whisper sometimes runs a whole 15 s opening into one "sentence"; past RUNON_WORDS words it is cut at the first clause
 * break after 5 words (a comma, or a capitalised sentence starter like "Someone" / "So"), else after 20 words with "…".
 */
export function spokenHookLine(spoken: string): string {
  const first = firstSentence(spoken.replace(/\s+/g, " ").trim());
  const words = first.split(" ");
  if (words.length <= RUNON_WORDS) return first;
  for (let i = 4; i < words.length - 1; i++) {
    if (words[i].endsWith(",")) return words.slice(0, i + 1).join(" ").replace(/,$/, "");
    if (i >= 5 && /^[A-Z]/.test(words[i + 1]) && STARTERS.test(words[i + 1])) return words.slice(0, i + 1).join(" ");
  }
  return `${words.slice(0, 20).join(" ")}…`;
}

/** The hook line of a video (see the file comment), or null while it has no description and no speech. */
export function videoHookText(lines: VideoLines): { text: string; from: VideoTextSource } | null {
  const cap = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, HOOK_MAX_CHARS);
  if (lines.spoken) {
    const t = cap(spokenHookLine(lines.spoken));
    if (normHook(t)) return { text: t, from: "spoken" };
  }
  if (lines.onScreen) {
    // The first pieces are the earliest captions / overlays; join the next ones while the line is under 4 words.
    const pieces = lines.onScreen.split(" | ");
    let t = "";
    for (const p of pieces.slice(0, 3)) {
      t = t ? `${t} ${p}` : p;
      if (t.split(/\s+/).length >= 4) break;
    }
    t = cap(t);
    if (normHook(t)) return { text: t, from: "on_screen" };
  }
  if (lines.opening) {
    const t = cap(lines.opening);
    if (normHook(t)) return { text: t, from: "opening" };
  }
  return null;
}

type AssetRow = {
  id: number;
  rel_path: string;
  section_key: SectionKey;
  section_id: number;
  description: string | null;
  spoken_open: string | null;
};

/** The asset's hooks channel: Lane A, or Lane B with exactly one client tag -> that client, else shared (null). */
export function assetChannel(sql: Sql, assetId: number, sectionKey: SectionKey): number | null {
  if (sectionKey !== "fkbpros") return null;
  const ids = sql.prepare("select client_id from asset_clients where asset_id = ?").pluck().all(assetId) as number[];
  return ids.length === 1 ? ids[0] : null;
}

const ASSET_COLS = "a.id, a.rel_path, s.key as section_key, a.section_id, a.description, a.spoken_open";
const VISIBLE_VIDEO = "a.kind = 'video' and a.missing = 0 and a.ignored = 0 and r.enabled = 1";

/** Does this video qualify for an automatic hook? (Path rules in code; hookable read by the caller's SQL.) */
export function autoHookPath(relPath: string, sectionKey: SectionKey, hookable: number | null): boolean {
  if (isOutroPath(relPath)) return false;
  if (sectionKey === "fkbpros" && isIntroPath(relPath)) return true;
  return hookable != null && hookable >= HOOKABLE_MIN;
}

export type SyncResult = { created: number; refreshed: number; moved: number };

/**
 * Create the missing automatic video hooks and keep every video hook in step with its asset (text, channel).
 * Idempotent: one row per asset; running it twice changes nothing. Never deletes a row.
 */
export function syncVideoHooks(sql: Sql, now = Date.now()): SyncResult {
  const res: SyncResult = { created: 0, refreshed: 0, moved: 0 };
  const candidates = sql
    .prepare(
      `select ${ASSET_COLS}, json_extract(c.answers, '$.hookable.value') as hookable
         from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
         left join classifications c on c.asset_id = a.id
        where ${VISIBLE_VIDEO}
          and not exists (select 1 from hooks h where h.asset_id = a.id and h.kind = 'video' and h.parent_id is null)
          and (json_extract(c.answers, '$.hookable.value') >= @min or (s.key = 'fkbpros' and lower(a.rel_path) like '%intro/%'))`,
    )
    .all({ min: HOOKABLE_MIN }) as (AssetRow & { hookable: number | null })[];
  const insert = sql.prepare(
    `insert or ignore into hooks (section_id, client_id, kind, text, norm, asset_id, source, created_at)
     values (?, ?, 'video', ?, ?, ?, 'asset', ?)`,
  );
  const existing = sql
    .prepare(
      `select h.id as hook_id, h.text, h.section_id as h_section, h.client_id as h_client, ${ASSET_COLS}
         from hooks h join assets a on a.id = h.asset_id join sections s on s.id = a.section_id
        where h.kind = 'video' and h.parent_id is null`,
    )
    .all() as (AssetRow & { hook_id: number; text: string; h_section: number; h_client: number | null })[];
  const update = sql.prepare("update hooks set text = ?, norm = ? where id = ?");
  const move = sql.prepare("update hooks set section_id = ?, client_id = ? where id = ?");
  sql.transaction(() => {
    for (const a of candidates) {
      if (!autoHookPath(a.rel_path, a.section_key, a.hookable)) continue;
      const t = videoHookText(videoLines(a.description, a.spoken_open));
      if (!t) continue; // not described yet: the next sync picks it up
      const info = insert.run(a.section_id, assetChannel(sql, a.id, a.section_key), t.text, normHook(t.text), a.id, now);
      res.created += info.changes;
    }
    for (const h of existing) {
      const t = videoHookText(videoLines(h.description, h.spoken_open));
      if (t && t.text !== h.text) {
        update.run(t.text, normHook(t.text), h.hook_id);
        res.refreshed++;
      }
      const client = assetChannel(sql, h.id, h.section_key);
      if (h.h_section !== h.section_id || h.h_client !== client) {
        move.run(h.section_id, client, h.hook_id);
        res.moved++;
      }
    }
  })();
  return res;
}

export type AddVideoHookResult = { ok: true; id: number; created: boolean } | { ok: false; error: string };

/**
 * "Add as hook" (drawer): the video's hook row, created now (source `asset`, same text + channel rules as the sync).
 * A video that already has one keeps it (an archived one is restored). Refused for anything but a visible, described
 * video.
 */
export function addVideoHook(sql: Sql, assetId: number, now = Date.now()): AddVideoHookResult {
  const a = sql
    .prepare(`select ${ASSET_COLS} from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id where a.id = ? and ${VISIBLE_VIDEO}`)
    .get(assetId) as AssetRow | undefined;
  if (!a) return { ok: false, error: "Only a video in the Library can be a hook." };
  const have = sql
    .prepare("select id, archived_at from hooks where asset_id = ? and kind = 'video' and parent_id is null")
    .get(assetId) as { id: number; archived_at: number | null } | undefined;
  if (have) {
    if (have.archived_at != null) sql.prepare("update hooks set archived_at = null where id = ?").run(have.id);
    return { ok: true, id: have.id, created: false };
  }
  const t = videoHookText(videoLines(a.description, a.spoken_open));
  if (!t) return { ok: false, error: "Describe it first: the hook line comes from its spoken opening or on-screen text." };
  const info = sql
    .prepare(
      `insert or ignore into hooks (section_id, client_id, kind, text, norm, asset_id, source, created_at)
       values (?, ?, 'video', ?, ?, ?, 'asset', ?)`,
    )
    .run(a.section_id, assetChannel(sql, a.id, a.section_key), t.text, normHook(t.text), a.id, now);
  const id = info.changes
    ? Number(info.lastInsertRowid)
    : (sql.prepare("select id from hooks where asset_id = ? and kind = 'video' and parent_id is null").pluck().get(assetId) as number);
  return { ok: true, id, created: info.changes > 0 };
}

/**
 * The file's video hook exists (any state) or is created now through addVideoHook (a described, visible video; source
 * asset). Returns true when one was created. Never restores an archived hook (addVideoHook alone would). Used where a
 * sync links a file to something with results: YouTube Shorts (Lane A) and Meta ads (role video).
 */
export function ensureVideoHook(sql: Sql, assetId: number, now = Date.now()): boolean {
  const have = sql.prepare("select id from hooks where asset_id = ? and kind = 'video' and parent_id is null").get(assetId);
  if (have) return false;
  const described = sql.prepare("select 1 from assets where id = ? and description is not null and description <> ''").get(assetId);
  if (!described) return false;
  const r = addVideoHook(sql, assetId, now);
  return r.ok && r.created;
}

/** The drawer's view of a video's hook (null = none yet). */
export type AssetHook = {
  id: number;
  archived: boolean;
  overall: number | null;
  /** The Hooks tab (Video view) of the hook's channel, with this row focused. */
  href: string;
};

export function assetHook(sql: Sql, assetId: number): AssetHook | null {
  const r = sql
    .prepare(
      `select h.id, h.archived_at, s.key as section, c.code,
              (select hs.overall from hook_scores hs where hs.hook_id = h.id
                  order by hs.rubric_version desc limit 1) as overall
         from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id
        where h.asset_id = ? and h.kind = 'video' and h.parent_id is null`,
    )
    .get(assetId) as { id: number; archived_at: number | null; section: SectionKey; code: string | null; overall: number | null } | undefined;
  if (!r) return null;
  const base = hooksPath(r.section, r.code);
  return {
    id: r.id,
    archived: r.archived_at != null,
    overall: r.overall,
    href: `${base}?view=video${r.archived_at != null ? "&archived=1" : ""}&focus=${r.id}`,
  };
}

/**
 * A video's own line for a new Meta ad (New ad from a video's Library card / drawer / a Winner's file, no hook asked for;
 * DECISIONS "New ad from a video uses its own line"): the line its video hook has or would get, only when it comes from
 * words in the video (spoken, else on-screen text; finished ads burn the spoken line in as captions). A video with no
 * words (the hook would be the description's opening line) has none. `hookId` = its existing video hook (any state; an
 * archived one is used as is, never restored), else null (adVideoHook makes it at Stage). Read only.
 */
export function videoAdLine(sql: Sql, assetId: number): { hookId: number | null; text: string } | null {
  const a = sql
    .prepare(`select ${ASSET_COLS} from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id where a.id = ? and ${VISIBLE_VIDEO}`)
    .get(assetId) as AssetRow | undefined;
  if (!a) return null;
  const t = videoHookText(videoLines(a.description, a.spoken_open));
  if (!t || t.from === "opening") return null;
  const have = sql.prepare("select id, text from hooks where asset_id = ? and kind = 'video' and parent_id is null").get(assetId) as
    | { id: number; text: string }
    | undefined;
  return have ? { hookId: have.id, text: have.text } : { hookId: null, text: t.text };
}

/**
 * Stage of a new ad from a video's own line: the video's hook id, created now (addVideoHook: source asset, the usual text
 * and channel rules, scored by the HookScoreQueue like any new hook) when it has none. Null when the video has no words.
 */
export function adVideoHook(sql: Sql, assetId: number, now = Date.now()): number | null {
  const line = videoAdLine(sql, assetId);
  if (!line) return null;
  if (line.hookId != null) return line.hookId;
  const r = addVideoHook(sql, assetId, now);
  return r.ok ? r.id : null;
}
