/**
 * Smoke helper (Creative Studio slice 1c): give a fresh temp DB a rubric HISTORY shaped like the original install's (v1,
 * v2, v3, as the pre-1c seed wrote them), in place of the ONE starter version a fresh seed writes now. Slice 1d: read from
 * scripts/fixtures/legacy-rubric.json, the same rows with every name and trade word swapped for the made-up stand-ins of
 * scripts/fixtures/studio.config.json (made by private/make-fixtures.ts), so the smoke runs without private/. The older checks were written against that history (v1 = 12 + 3 avatars, v2 = + Lane C, v3 =
 * the Lane A context, section versions rtm 3 / fkbpros 2 / fkb 2), so they keep testing exactly what runs on that DB.
 * Hook scores already written against the starter keep their version number (call this right after the DB is opened).
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

type Row = {
  version: number;
  dimensions: string;
  mechanics: string;
  avatars: string;
  note: string | null;
  current: number;
  rescore_clicked: number;
  briefs: string | null;
  section_versions: string | null;
};

export function legacyRubricRows(): Row[] {
  const file = path.join(process.cwd(), "scripts", "fixtures", "legacy-rubric.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Row[];
}

/** The legacy v1 content (the 6 dimensions, 9 mechanics + none, 12 + 3 avatars), parsed. */
export function legacyV1() {
  const r = legacyRubricRows().find((x) => x.version === 1)!;
  return { dimensions: JSON.parse(r.dimensions), mechanics: JSON.parse(r.mechanics), avatars: JSON.parse(r.avatars) };
}

/** Replace the DB's rubric rows with the original install's v1 / v2 / v3 (timestamps: now; v1's rescore clicked). */
export function applyLegacyRubric(sqlite: Database.Database, upTo = 3, now = Date.now()): void {
  const rows = legacyRubricRows().filter((r) => r.version <= upTo);
  sqlite.transaction(() => {
    sqlite.prepare("delete from rubric_versions").run();
    const ins = sqlite.prepare(
      `insert into rubric_versions (version, dimensions, mechanics, avatars, note, current, created_at, rescore_at, briefs, section_versions)
       values (@version, @dimensions, @mechanics, @avatars, @note, @current, @now, @rescore, @briefs, @section_versions)`,
    );
    for (const r of rows) ins.run({ ...r, current: r.version === upTo ? 1 : 0, now, rescore: r.rescore_clicked ? now : null });
  })();
}

/**
 * The texts the pre-1c `src/lib/hooks/seed-data.ts` exported, read from the active (fixture) profile's `seed` now: the
 * older checks compare seeded rows with them. WHOS_WHO is the full who's who draft (with its Lane C partner line).
 */
export async function seedTexts() {
  const P = (await import("../src/lib/profile")).profile().seed;
  return { CLIENT_BRAND_NOTES: P.brandNotes, RTM_NOTES: P.rtmNotes, WHOS_WHO: P.whosWho, FKB_BRAND_NOTES: P.companyNotes, FKB_HINT: P.companyHint };
}
