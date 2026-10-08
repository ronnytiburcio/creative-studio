/**
 * Studio Generated layout on the media drive (client safe; the lane folder names and the paths built from them are
 * server only: src/lib/gen/generated-dirs.ts):
 *   <drive>/Studio Generated/<Lane A folder>/
 *   <drive>/Studio Generated/<Lane B folder>/<client code>/
 *   <drive>/Studio Generated/<Lane B folder>/_shared/
 *   <drive>/Studio Generated/<Lane C folder>/            (Phase 5 slice 2, seed v8)
 * The lane folder names come from the business profile (`profile.generated`, Creative Studio slice 1c). The lane folders
 * are roots (seed v4, Lane C seed v8); client folders map to clients by absolute tag rules. Folders are created on first
 * use by the write guard only.
 */
import { companyLabel, type UiLabels } from "../profile-shared";

export const GENERATED_DIRNAME = "Studio Generated";
export const SHARED_DIRNAME = "_shared";

/** Where an output goes. `client: null` = the clients lane, shared. */
export type GenDest = { section: "rtm" } | { section: "fkbpros"; client: string | null } | { section: "fkb" };

/** Destination as a compact string (URL/form friendly): "rtm" | "fkb" | "fkbpros" | "fkbpros:<code>". */
export function destKey(d: GenDest): string {
  return d.section === "rtm" ? "rtm" : d.section === "fkb" ? "fkb" : d.client ? `fkbpros:${d.client}` : "fkbpros";
}

export function parseDestKey(key: string): GenDest | null {
  if (key === "rtm") return { section: "rtm" };
  if (key === "fkb") return { section: "fkb" };
  if (key === "fkbpros") return { section: "fkbpros", client: null };
  const m = /^fkbpros:([a-z0-9]{2,32})$/.exec(key);
  return m ? { section: "fkbpros", client: m[1] } : null;
}

/** The destination labels: Lane A's name, "<Lane C> (<full name>)", "All <Lane B> (shared)" (from UiLabels). */
export type DestLabels = { rtm: string; fkb: string; shared: string };

export function destLabelsOf(L: Pick<UiLabels, "lane" | "laneFull">): DestLabels {
  return { rtm: L.lane.rtm, fkb: companyLabel(L), shared: `All ${L.lane.fkbpros} (shared)` };
}

/** Human label for a destination: Lane A's name, Lane C's, the client's short name, or "All <Lane B> (shared)". */
export function destLabel(d: GenDest, clients: readonly { code: string; short: string }[], labels: DestLabels): string {
  if (d.section === "rtm") return labels.rtm;
  if (d.section === "fkb") return labels.fkb;
  if (!d.client) return labels.shared;
  return clients.find((c) => c.code === d.client)?.short ?? d.client;
}

export function generatedBase(drivePath: string): string {
  return `${drivePath.replace(/\/+$/, "")}/${GENERATED_DIRNAME}`;
}
