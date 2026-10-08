/**
 * The ACTIVE business profile (server only): `profile()` = the loaded Studio config's `profile` (src/lib/config.ts
 * getConfig, read lazily on the first call, so nothing has to import the config first), resolved over the neutral
 * built-ins once per config object. `withProfile` runs a function under another profile (tests and the dump).
 *
 * The schema and `resolveProfile` live in src/lib/profile-schema.ts and the client safe types / helpers in
 * src/lib/profile-shared.ts (client components and client safe modules import ONLY those two, never this file: it
 * reaches the config, which reads files). This module re-exports both for server code, with the active profile as the
 * default argument of `houseRulesFor` / `profileUi`.
 */
import { getConfig } from "./config";
import type { ResolvedProfile } from "./profile-defaults";
import { resolveProfile, type ProfileFile } from "./profile-schema";
import { houseRulesFor as houseRulesOf, profileUi as profileUiOf, GENERIC_BRAND, type BrandUrls, type HouseRules, type LaneKey3, type UiLabels } from "./profile-shared";

export * from "./profile-schema";
export * from "./profile-shared";

// ------------------------------------------------------------------------------------------------ active profile

let cache: { src: ProfileFile | undefined; resolved: ResolvedProfile } | null = null;
let override: ResolvedProfile | null = null;

/** The active, resolved profile (server only). A config error surfaces here as the config's own message. */
export function profile(): ResolvedProfile {
  if (override) return override;
  const src = getConfig().studio.profile;
  if (!cache || cache.src !== src) cache = { src, resolved: resolveProfile(src) };
  return cache.resolved;
}

/** Run `fn` with `file` as the active profile (undefined = the neutral one). Tests and the dump only. */
export async function withProfile<T>(file: ProfileFile | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = override;
  override = resolveProfile(file);
  try {
    return await fn();
  } finally {
    override = prev;
  }
}

// ------------------------------------------------------------------------------------------------ server defaults

/** The house copy rules of a lane (the active profile unless one is given). */
export function houseRulesFor(section: LaneKey3, p: ResolvedProfile = profile()): HouseRules {
  return houseRulesOf(section, p);
}

/** The UI labels (the active profile unless one is given). */
export function profileUi(lane: Record<LaneKey3, string>, p: ResolvedProfile = profile(), brand: BrandUrls = GENERIC_BRAND): UiLabels {
  return profileUiOf(lane, p, brand);
}

/** The match note a hand link stores ("Linked by <owner name>" / "Linked by hand"). */
export function linkedByText(): string {
  const o = profile().owner.name;
  return o ? `Linked by ${o}` : "Linked by hand";
}
