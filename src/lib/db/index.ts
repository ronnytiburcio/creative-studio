import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { seed } from "./seed";
import { ensureAppDirs, getConfig, REPO_DIR } from "../config";

export type Db = {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
};

export const MIGRATIONS_DIR = path.join(REPO_DIR, "drizzle");

/**
 * Open a DB file, apply WAL + pragmas, run migrations and the one-time seed. `setup: false` (CLI tools against the live
 * DB, e.g. scripts/score-copy.ts) opens an EXISTING file with the same pragmas and runs neither migrations nor the seed:
 * the app and the worker own those (check `pendingMigrations` first). `readonly: true` (implies setup false; e.g.
 * `scripts/score-page.ts --resolve`) opens an EXISTING file read only: no journal mode change, every write throws.
 */
export function openDb(
  file: string,
  opts: { migrationsDir?: string; drivePath?: string; clientDocsDir?: string; setup?: boolean; readonly?: boolean } = {},
): Db {
  const readonly = opts.readonly ?? false;
  const setup = !readonly && (opts.setup ?? true);
  const sqlite = new Database(file, readonly ? { readonly: true, fileMustExist: true } : setup ? {} : { fileMustExist: true });
  if (!readonly) sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  const orm = drizzle(sqlite, { schema });
  if (!setup) return { sqlite, orm };
  migrate(orm, { migrationsFolder: opts.migrationsDir ?? MIGRATIONS_DIR });
  seed(sqlite, { drivePath: opts.drivePath ?? getConfig().drivePath, clientDocsDir: opts.clientDocsDir ?? getConfig().clientDocsDir });
  return { sqlite, orm };
}

/**
 * The repo's migrations (drizzle/meta/_journal.json) that this DB has not applied, by tag. Same rule as drizzle's
 * migrator: a journal entry is applied when `__drizzle_migrations` holds a row with its `when` as created_at. Read only.
 */
export function pendingMigrations(sqlite: Database.Database, migrationsDir = MIGRATIONS_DIR): string[] {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const hasTable = sqlite.prepare("select 1 from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get();
  const applied = new Set(
    hasTable ? (sqlite.prepare("select created_at from __drizzle_migrations").pluck().all() as (number | string)[]).map(Number) : [],
  );
  return journal.entries.filter((e) => !applied.has(Number(e.when))).map((e) => e.tag);
}

const g = globalThis as unknown as { __rtmStudioDb?: Db };

/** Process-wide singleton (survives Next dev HMR). */
export function getDb(): Db {
  if (!g.__rtmStudioDb) {
    const cfg = getConfig();
    ensureAppDirs(cfg);
    g.__rtmStudioDb = openDb(cfg.dbPath);
  }
  return g.__rtmStudioDb;
}

export { schema };
