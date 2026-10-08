/**
 * Folder tag rules -> asset_clients(source = folder). Removing a rule removes only folder rows. Adding a folder row
 * deletes the asset's jev rows first: folder always wins, and Jev is only asked about assets with no folder / manual
 * tag, so its old guesses must not sit next to a folder tag (a jev row for the same client simply becomes the folder
 * row). Manual rows are never touched; a manual row for the same client stays manual.
 */
import type Database from "better-sqlite3";
import { buildTagMatcher, type TagMatcher, type TagRule } from "../lib/patterns";

export class Tagger {
  private match: TagMatcher = () => [];
  private clientIdByCode = new Map<string, number>();
  private readonly currentStmt: Database.Statement;
  private readonly removeStmt: Database.Statement;
  private readonly addStmt: Database.Statement;
  private readonly dropJevStmt: Database.Statement;

  constructor(private readonly sql: Database.Database) {
    this.currentStmt = sql.prepare("select client_id from asset_clients where asset_id = ? and source = 'folder'");
    this.removeStmt = sql.prepare("delete from asset_clients where asset_id = ? and client_id = ? and source = 'folder'");
    this.addStmt = sql.prepare(
      `insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'folder', ?)
       on conflict (asset_id, client_id) do nothing`,
    );
    this.dropJevStmt = sql.prepare("delete from asset_clients where asset_id = ? and source = 'jev'");
  }

  load(rules: TagRule[], clients: { id: number; code: string }[]) {
    this.match = buildTagMatcher(rules);
    this.clientIdByCode = new Map(clients.map((client) => [client.code, client.id]));
  }

  /** Make the asset's folder rows equal to what the rules say for its path. Writes only on a difference. */
  apply(assetId: number, relPath: string, absPath: string) {
    const wanted = new Set(
      this.match(relPath, absPath)
        .map((code) => this.clientIdByCode.get(code))
        .filter((id): id is number => typeof id === "number"),
    );
    const current = new Set((this.currentStmt.all(assetId) as { client_id: number }[]).map((row) => row.client_id));
    const toRemove = [...current].filter((clientId) => !wanted.has(clientId));
    const toAdd = [...wanted].filter((clientId) => !current.has(clientId));
    if (toRemove.length === 0 && toAdd.length === 0) return;
    const now = Date.now();
    this.sql.transaction(() => {
      for (const clientId of toRemove) this.removeStmt.run(assetId, clientId);
      if (toAdd.length) this.dropJevStmt.run(assetId);
      for (const clientId of toAdd) this.addStmt.run(assetId, clientId, now);
    })();
  }

  /** Re-run the rules over every indexed asset. Returns how many were checked. */
  applyAll(): number {
    const rows = this.sql.prepare("select id, rel_path, path from assets").all() as {
      id: number;
      rel_path: string;
      path: string;
    }[];
    for (const row of rows) this.apply(row.id, row.rel_path, row.path);
    return rows.length;
  }
}
