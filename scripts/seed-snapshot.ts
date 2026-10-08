/**
 * The seeded rows a config-driven fresh install must reproduce (Creative Studio slice 1b): sections, clients, ad accounts,
 * roots, tag rules, ignores, notes and the seed markers, without ids or timestamps, with the temp drive / client folders
 * replaced by `<DRIVE>` / `<DOCS>` (the client docs folder) so a snapshot taken on one temp tree compares with another. Sorted, so row order (ids)
 * never matters. Used by scripts/smoke-config.ts and to take the pre-1b snapshot (`private/seed-snapshot.json`).
 */
import type Database from "better-sqlite3";

export type SeedSnapshot = Record<string, unknown[]>;

export function seedRowsSnapshot(sqlite: Database.Database, dirs: { drive: string; fpc: string }): SeedSnapshot {
  const norm = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    let s = v;
    for (const [from, to] of [[dirs.fpc, "<DOCS>"], [dirs.drive, "<DRIVE>"]] as const) s = s.split(from).join(to);
    return s;
  };
  const rows = (q: string) =>
    (sqlite.prepare(q).all() as Record<string, unknown>[])
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, norm(v)])))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    sections: rows("select key, name, color, sort from sections"),
    clients: rows(
      "select c.code, c.name, c.meta_ad_account_id, c.sort, c.classify_hint, c.brand_notes, s.key as lane from clients c join sections s on s.id = c.section_id",
    ),
    ad_accounts: rows(
      `select s.key as lane, c.code, a.act_id, a.identity, a.sort from ad_accounts a join sections s on s.id = a.section_id
         left join clients c on c.id = a.client_id`,
    ),
    roots: rows("select r.path, s.key as lane, r.enabled from roots r join sections s on s.id = r.section_id"),
    tag_rules: rows("select path_glob, client_codes from tag_rules"),
    ignores: rows("select pattern from ignore_patterns"),
    notes: rows("select key, body, saved_at is null as draft from notes"),
    settings: rows(
      "select key from app_settings where key not like 'config:%'",
    ),
  };
}
