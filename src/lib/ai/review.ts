/**
 * The owner's answers (server only): the Review confirm, the drawer's category picker and client chips. Every value that
 * differs from Jev's goes into ai_corrections (recent ones become examples in later classify calls). Nothing here
 * calls Jev.
 *
 * - Category: any class the owner sets or confirms becomes class_source = 'manual' (a later classify never overwrites it);
 *   a correction is stored only when it differs from Jev's class.
 * - Clients: the tags the owner set or confirmed become source = 'manual'; folder rows are fixed and never touched; Jev
 *   rows they left out are removed. Shared = no rows. Either way it is their decision (assets.clients_decided_at): later
 *   classifies never ask the client questions again nor apply Jev rows, like a folder / manual tag. A drawer chip edit
 *   (add, or remove a Jev or manual chip) decides too: the Jev rows they kept become manual (decideClients).
 * - Yes/no answers, energy and visual format are stored with source OWNER_SOURCE (kept by later classifies).
 * - Confirm clears needs_review and the unsure list.
 */
import type Database from "better-sqlite3";
import {
  CLIENT_YES,
  UNIVERSAL_ID,
  answerUnsure,
  appliesTo,
  clientQuestionId,
  isCategory,
  needsReview,
  type CategoryId,
  type NoulId,
  type StoredAnswer,
  type VisualFormatId,
  OWNER_SOURCE,
} from "./classes";
import { classifyThreshold } from "./state";
import { laneNames } from "../clients-admin";

type Sql = Database.Database;

export type ReviewInput = {
  assetId: number;
  assetClass?: CategoryId;
  /** Final client codes (Lane B only); [] = shared. Folder tags are fixed and may be listed or not. */
  clients?: string[];
  nouls?: Partial<Record<NoulId, boolean>>;
  /** 1..5. */
  energy?: number;
  visualFormat?: VisualFormatId;
};

type AssetRow = { id: number; kind: string; section: string; asset_class: string | null; class_source: string | null; energy: number | null };

function loadAsset(sql: Sql, assetId: number): AssetRow | undefined {
  return sql
    .prepare(
      `select a.id, a.kind, s.key as section, a.asset_class, a.class_source, a.energy
         from assets a join sections s on s.id = a.section_id where a.id = ? and a.missing = 0 and a.ignored = 0`,
    )
    .get(assetId) as AssetRow | undefined;
}

function loadClassification(sql: Sql, assetId: number): { answers: Record<string, StoredAnswer>; unsure: string[] } | null {
  const row = sql.prepare("select answers, unsure from classifications where asset_id = ?").get(assetId) as { answers: string; unsure: string } | undefined;
  if (!row) return null;
  try {
    return { answers: JSON.parse(row.answers), unsure: JSON.parse(row.unsure) };
  } catch {
    return null;
  }
}

function saveClassification(sql: Sql, assetId: number, answers: Record<string, StoredAnswer>, unsure: string[], now: number) {
  sql
    .prepare(
      `insert into classifications (asset_id, model, version, answers, unsure, call_id, created_at) values (?, ?, 0, ?, ?, null, ?)
       on conflict (asset_id) do update set answers = excluded.answers, unsure = excluded.unsure`,
    )
    .run(assetId, OWNER_SOURCE, JSON.stringify(answers), JSON.stringify(unsure), now);
}

// ai_corrections' answer column keeps its original (stored) name; schema.ts maps it to `ownerAnswer`.
function addCorrection(sql: Sql, assetId: number, question: string, jev: unknown, owner: unknown, now: number) {
  sql
    .prepare("insert into ai_corrections (asset_id, question, jev_answer, ronny_answer, created_at) values (?, ?, ?, ?, ?)")
    .run(assetId, question, jev === undefined ? null : JSON.stringify(jev), JSON.stringify(owner), now);
}

/** Jev's own class for this asset (from its last answer), or null. */
function jevClassOf(answers: Record<string, StoredAnswer> | undefined, asset: AssetRow): string | null {
  const a = answers?.asset_class;
  if (a?.source !== OWNER_SOURCE && typeof a?.value === "string") return a.value;
  return asset.class_source === "jev" ? asset.asset_class : null;
}

/** Re-flag class-dependent answers for a class (drop or restore) and recompute which of them are unsure. */
function reapplyClass(answers: Record<string, StoredAnswer>, unsure: string[], cls: string | null, kind: string, threshold: number): string[] {
  const out = unsure.filter((id) => !(id === "visual_format" || id.startsWith("pp_")));
  for (const id of ["visual_format", "pp_person", "pp_pain", "pp_promise"]) {
    const a = answers[id];
    if (!a) continue;
    const applies = appliesTo(id, cls, kind);
    answers[id] = applies ? { ...a, dropped: undefined } : { ...a, dropped: true };
    if (applies && answerUnsure(a, threshold)) out.push(id);
  }
  return out;
}

/** Clients Jev proposed (>= 0.75), [] when it said universal, null when the client questions were not asked. */
function jevClients(answers: Record<string, StoredAnswer> | undefined, codes: string[]): string[] | null {
  if (!answers?.[UNIVERSAL_ID]) return null;
  return codes.filter((c) => Number(answers[clientQuestionId(c)]?.value ?? 0) >= CLIENT_YES);
}

/**
 * The owner's client decision stands for this asset: the Jev rows still on it become theirs (manual) and clients_decided_at
 * is set, so a later classify neither asks the client questions nor applies Jev rows. No rows left = shared.
 */
export function decideClients(sql: Sql, assetId: number, now = Date.now()) {
  sql.prepare("update asset_clients set source = 'manual' where asset_id = ? and source = 'jev'").run(assetId);
  sql.prepare("update assets set clients_decided_at = ? where id = ?").run(now, assetId);
}

function setClients(sql: Sql, asset: AssetRow, finalCodes: string[], jevAnswer: string[] | null, now: number) {
  const rows = sql
    .prepare("select c.code, ac.source from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ?")
    .all(asset.id) as { code: string; source: string }[];
  const folder = new Set(rows.filter((r) => r.source === "folder").map((r) => r.code));
  const want = new Set(finalCodes.filter((c) => !folder.has(c)));
  const before = rows.filter((r) => r.source !== "folder").map((r) => r.code).sort();
  sql.prepare("delete from asset_clients where asset_id = ? and source in ('jev', 'manual')").run(asset.id);
  const add = sql.prepare(
    `insert into asset_clients (asset_id, client_id, source, created_at) select ?, id, 'manual', ? from clients where code = ?
     on conflict (asset_id, client_id) do nothing`,
  );
  for (const code of want) add.run(asset.id, now, code);
  decideClients(sql, asset.id, now);
  const after = [...want].sort();
  const jev = (jevAnswer ?? before).slice().sort();
  if (jev.join(",") !== after.join(",")) addCorrection(sql, asset.id, "clients", jev, after, now);
}

/** Review confirm: write everything shown, store corrections, clear needs_review. */
export function confirmReview(sql: Sql, input: ReviewInput, now = Date.now()): { ok: true; corrections: number } | { ok: false; error: string } {
  const asset = loadAsset(sql, input.assetId);
  if (!asset) return { ok: false, error: "This file is no longer in the Library." };
  const codes = sql.prepare("select code from clients order by sort").pluck().all() as string[];
  if (input.clients && asset.section !== "fkbpros") return { ok: false, error: `Client tags only apply to ${laneNames(sql).fkbpros} files.` };
  if (input.clients?.some((c) => !codes.includes(c))) return { ok: false, error: "Unknown client." };
  const threshold = classifyThreshold(sql);
  const before = (sql.prepare("select count(*) from ai_corrections where asset_id = ?").pluck().get(asset.id) as number) ?? 0;

  sql.transaction(() => {
    const cls = loadClassification(sql, asset.id);
    const answers: Record<string, StoredAnswer> = cls?.answers ?? {};
    const kind = asset.kind;

    // Category: set or confirmed by the owner = manual.
    let finalClass = asset.asset_class;
    if (input.assetClass && isCategory(input.assetClass)) {
      const jevClass = jevClassOf(answers, asset);
      if (jevClass !== input.assetClass) addCorrection(sql, asset.id, "asset_class", jevClass, input.assetClass, now);
      const prev = answers.asset_class;
      answers.asset_class = { type: "choice", value: input.assetClass, probabilities: prev?.probabilities ?? {}, confidence: prev?.confidence ?? null, source: OWNER_SOURCE };
      finalClass = input.assetClass;
      sql.prepare("update assets set asset_class = ?, class_source = 'manual', class_confidence = null where id = ?").run(input.assetClass, asset.id);
    }
    reapplyClass(answers, [], finalClass, kind, threshold);

    if (input.clients && asset.section === "fkbpros") setClients(sql, asset, input.clients, jevClients(cls?.answers, codes), now);

    for (const [id, yes] of Object.entries(input.nouls ?? {}) as [NoulId, boolean][]) {
      if (typeof yes !== "boolean" || !appliesTo(id, finalClass, kind)) continue;
      const prev = answers[id];
      if (prev && prev.source !== OWNER_SOURCE && Number(prev.value) >= 0.5 !== yes) addCorrection(sql, asset.id, id, prev.value, yes, now);
      answers[id] = { type: "noul", value: yes ? 1 : 0, probabilities: prev?.probabilities ?? {}, confidence: null, source: OWNER_SOURCE };
    }

    if (input.energy != null && Number.isInteger(input.energy) && input.energy >= 1 && input.energy <= 5) {
      const prev = answers.energy;
      const jevEnergy = prev && prev.source !== OWNER_SOURCE ? Number(prev.value) + 1 : null;
      if (jevEnergy != null && Math.round(jevEnergy) !== input.energy) addCorrection(sql, asset.id, "energy", Math.round(jevEnergy * 10) / 10, input.energy, now);
      answers.energy = { type: "score", value: input.energy - 1, probabilities: prev?.probabilities ?? {}, confidence: prev?.confidence ?? null, source: OWNER_SOURCE };
      sql.prepare("update assets set energy = ? where id = ?").run(input.energy, asset.id);
    }

    if (input.visualFormat && appliesTo("visual_format", finalClass, kind)) {
      const prev = answers.visual_format;
      if (prev && prev.source !== OWNER_SOURCE && prev.value !== input.visualFormat) addCorrection(sql, asset.id, "visual_format", prev.value, input.visualFormat, now);
      answers.visual_format = { type: "choice", value: input.visualFormat, probabilities: prev?.probabilities ?? {}, confidence: prev?.confidence ?? null, source: OWNER_SOURCE };
    }

    saveClassification(sql, asset.id, answers, [], now);
    sql.prepare("update assets set needs_review = 0 where id = ?").run(asset.id);
  })();
  const after = sql.prepare("select count(*) from ai_corrections where asset_id = ?").pluck().get(asset.id) as number;
  return { ok: true, corrections: after - before };
}

/**
 * Drawer category picker: the owner's class (manual), a correction when it differs from Jev's, class-dependent answers
 * re-flagged for the new class; the category is no longer unsure (needs_review stays only if something else is).
 */
export function setManualClass(sql: Sql, assetId: number, cls: CategoryId, now = Date.now()): { ok: true } | { ok: false; error: string } {
  const asset = loadAsset(sql, assetId);
  if (!asset || (asset.kind !== "image" && asset.kind !== "video")) return { ok: false, error: "Only images and videos have a category." };
  sql.transaction(() => {
    const c = loadClassification(sql, assetId);
    const answers = c?.answers ?? {};
    const jevClass = jevClassOf(answers, asset);
    const current = asset.asset_class;
    if (current !== cls && jevClass !== cls) addCorrection(sql, assetId, "asset_class", jevClass, cls, now);
    const prev = answers.asset_class;
    answers.asset_class = { type: "choice", value: cls, probabilities: prev?.probabilities ?? {}, confidence: prev?.confidence ?? null, source: OWNER_SOURCE };
    const unsure = reapplyClass(answers, (c?.unsure ?? []).filter((id) => id !== "asset_class"), cls, asset.kind, classifyThreshold(sql));
    if (c) saveClassification(sql, assetId, answers, unsure, now);
    sql
      .prepare("update assets set asset_class = ?, class_source = 'manual', class_confidence = null, needs_review = ? where id = ?")
      .run(cls, c && needsReview(unsure) ? 1 : 0, assetId);
  })();
  return { ok: true };
}

/**
 * Drawer: the owner removed a client chip Jev had applied. Removing it is a correction of Jev's client answer, and the
 * set they left is their decision (decideClients: the other Jev chips become manual; none left = shared).
 */
export function removeJevClient(sql: Sql, assetId: number, code: string, now = Date.now()): boolean {
  const client = sql.prepare("select id from clients where code = ?").get(code) as { id: number } | undefined;
  if (!client) return false;
  return sql.transaction(() => {
    const jevRows = sql
      .prepare("select c.code from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ? and ac.source = 'jev' order by c.sort")
      .pluck()
      .all(assetId) as string[];
    if (!jevRows.includes(code)) return false;
    sql.prepare("delete from asset_clients where asset_id = ? and client_id = ? and source = 'jev'").run(assetId, client.id);
    decideClients(sql, assetId, now);
    const remaining = sql
      .prepare("select c.code from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ? and ac.source != 'folder' order by c.sort")
      .pluck()
      .all(assetId) as string[];
    addCorrection(sql, assetId, "clients", jevRows, remaining, now);
    return true;
  })();
}
