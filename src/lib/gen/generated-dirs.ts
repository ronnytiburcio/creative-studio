/**
 * Studio Generated folders on the media drive (server only): the lane folder names come from the active business profile
 * (`profile.generated`), so everything built from them lives here, apart from the client safe layout
 * (src/lib/gen/layout.ts: destinations, labels, the base folder).
 */
import { profile } from "../profile";
import { generatedBase, SHARED_DIRNAME, type GenDest } from "./layout";

/** The lane folders under Studio Generated (the profile's `generated`; server only). */
export function sectionDirs(): { rtm: string; fkbpros: string; fkb: string } {
  return profile().generated;
}

/** Path segments below "<drive>/Studio Generated" (server only). */
export function destSegments(d: GenDest): string[] {
  const dir = sectionDirs();
  if (d.section === "rtm") return [dir.rtm];
  if (d.section === "fkb") return [dir.fkb];
  return [dir.fkbpros, d.client ?? SHARED_DIRNAME];
}

/** Lane C's generated folder, a root in section fkb (seed v8; server only). */
export function generatedFkbRoot(drivePath: string) {
  return { path: `${generatedBase(drivePath)}/${sectionDirs().fkb}`, section: "fkb" as const };
}

/** Root paths seeded for Lane A and B (seed v4; Lane C's is generatedFkbRoot, seed v8; server only). */
export function generatedRoots(drivePath: string) {
  const base = generatedBase(drivePath);
  return [
    { path: `${base}/${sectionDirs().rtm}`, section: "rtm" as const },
    { path: `${base}/${sectionDirs().fkbpros}`, section: "fkbpros" as const },
  ];
}

/** Absolute tag rule glob for a client's generated folder (server only). */
export function generatedClientGlob(drivePath: string, code: string): string {
  return `${generatedBase(drivePath)}/${sectionDirs().fkbpros}/${code}/**`;
}
