/**
 * The business profile's client safe half: types, constants and pure helpers that UI code and client safe modules may
 * import (no node imports, no state). The active profile (`profile()`, server only) lives in src/lib/profile.ts, the
 * schema in src/lib/profile-schema.ts. Helpers that need a profile take it as an argument here; the server module
 * re-exports them with the active profile as the default.
 */
import type { DashPolicy, ResolvedProfile } from "./profile-defaults";

export { AI_TELLS_TOKEN, DASH_POLICIES, NEUTRAL_PROFILE, type DashPolicy, type ResolvedProfile } from "./profile-defaults";

/** `{key}` placeholders filled (unknown keys left as they are). */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-z_]+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

export type LaneKey3 = "rtm" | "fkbpros" | "fkb";

/** The house copy rules one lane's hooks are checked against (built on the server, carried to the browser as data). */
export type HouseRules = {
  dashes: DashPolicy;
  stateNames: boolean;
  banClientNames: boolean;
  /** Lane A also refuses the client codes. */
  banClientCodes: boolean;
  /** The "names a client" message for this lane ({name}). */
  nameMessage: string;
  noHyphenMessage: string;
};

export function houseRulesFor(section: LaneKey3, p: ResolvedProfile): HouseRules {
  const r = p.copyRules;
  return {
    dashes: r.dashes[section],
    stateNames: r.stateNames[section],
    banClientNames: r.banClientNames[section],
    banClientCodes: section === "rtm" && r.banClientNames.rtm,
    nameMessage: section === "rtm" ? r.messages.rtmName : section === "fkb" ? r.messages.companyName : r.messages.clientName,
    noHyphenMessage: r.messages.noHyphen,
  };
}

/**
 * The labels UI code needs: the lane display names (Settings > Lanes, from the DB) plus the profile's display texts.
 * Server code builds it with `uiLabels()` (src/lib/ui-labels.ts); client components read it from `useLabels()` (the app
 * layout passes it down). Never the whole profile or a path.
 */
export type UiLabels = {
  /** Lane display names (sections.name). */
  lane: Record<LaneKey3, string>;
  owner: string | null;
  ownerDisplay: string | null;
  laneFull: Record<LaneKey3, string>;
  laneSub: Record<LaneKey3, string | null>;
  laneAbout: Record<LaneKey3, string | null>;
  /** The letter mark (the lane name's first letter when the profile has none). */
  laneMark: Record<LaneKey3, string>;
  campaignWord: string | null;
  categories: Record<string, string>;
  visualFormats: Record<string, string>;
  /** Outside skill names + Lane A episode naming (help text, paste lines, the Cut reel dialog). */
  skills: ResolvedProfile["skills"];
  episodes: ResolvedProfile["episodes"];
  /** The brand mark URLs (the install's own marks when STUDIO_BRAND_DIR has them, else the built-in generic ones). */
  brand: BrandUrls;
};

/** Files a brand folder may hold (STUDIO_BRAND_DIR) and the URL each one is served at. */
export const BRAND_FILES = ["mark-ink.svg", "mark-sand.svg", "wordmark-ink.svg", "wordmark-paper.svg"] as const;
export type BrandFile = (typeof BRAND_FILES)[number];
export type BrandUrls = Record<"markInk" | "markSand" | "wordmarkInk" | "wordmarkPaper", string>;

/** The built-in generic marks (public/brand). */
export const GENERIC_BRAND: BrandUrls = {
  markInk: "/brand/mark-ink.svg",
  markSand: "/brand/mark-sand.svg",
  wordmarkInk: "/brand/wordmark-ink.svg",
  wordmarkPaper: "/brand/wordmark-paper.svg",
};

export function profileUi(lane: Record<LaneKey3, string>, p: ResolvedProfile, brand: BrandUrls = GENERIC_BRAND): UiLabels {
  return {
    lane: { ...lane },
    owner: p.owner.name,
    ownerDisplay: p.owner.display,
    laneFull: { rtm: p.lanes.rtm.fullName, fkbpros: p.lanes.fkbpros.fullName, fkb: p.lanes.fkb.fullName },
    laneSub: { rtm: p.lanes.rtm.sub, fkbpros: p.lanes.fkbpros.sub, fkb: p.lanes.fkb.sub },
    laneAbout: { rtm: p.lanes.rtm.about, fkbpros: p.lanes.fkbpros.about, fkb: p.lanes.fkb.about },
    laneMark: {
      rtm: p.lanes.rtm.mark ?? (lane.rtm[0] ?? "A").toUpperCase(),
      fkbpros: p.lanes.fkbpros.mark ?? (lane.fkbpros[0] ?? "B").toUpperCase(),
      fkb: p.lanes.fkb.mark ?? (lane.fkb[0] ?? "C").toUpperCase(),
    },
    campaignWord: p.ads.campaignWord,
    categories: { ...p.classify.categories },
    visualFormats: { ...p.classify.visualFormats },
    skills: { ...p.skills },
    episodes: { ...p.episodes },
    brand: { ...brand },
  };
}

/** "<Lane C> (<its full name>)", or just the lane name when they are the same. */
export function companyLabel(L: Pick<UiLabels, "lane" | "laneFull">): string {
  return L.lane.fkb === L.laneFull.fkb ? L.lane.fkb : `${L.lane.fkb} (${L.laneFull.fkb})`;
}


/** "set by <owner name>" / "set by you". */
export function setByText(owner: string | null): string {
  return owner ? `set by ${owner}` : "set by you";
}
