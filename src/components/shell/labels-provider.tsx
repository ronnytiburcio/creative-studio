"use client";

import { createContext, useContext } from "react";
import { NEUTRAL_LANES } from "@/lib/studio-config";
import { GENERIC_BRAND, NEUTRAL_PROFILE, type UiLabels } from "@/lib/profile-shared";

/** The neutral labels (only seen if a component renders outside the app layout). */
const FALLBACK: UiLabels = {
  lane: { rtm: NEUTRAL_LANES.rtm.name, fkbpros: NEUTRAL_LANES.fkbpros.name, fkb: NEUTRAL_LANES.fkb.name },
  owner: null,
  ownerDisplay: null,
  laneFull: { rtm: NEUTRAL_LANES.rtm.name, fkbpros: NEUTRAL_LANES.fkbpros.name, fkb: NEUTRAL_LANES.fkb.name },
  laneSub: { rtm: null, fkbpros: null, fkb: null },
  laneAbout: { rtm: null, fkbpros: null, fkb: null },
  laneMark: { rtm: "B", fkbpros: "C", fkb: "C" },
  campaignWord: null,
  categories: {},
  visualFormats: {},
  skills: NEUTRAL_PROFILE.skills,
  episodes: NEUTRAL_PROFILE.episodes,
  brand: GENERIC_BRAND,
};

const Ctx = createContext<UiLabels>(FALLBACK);

/** Lane names + the profile's display texts for client components (built on the server by uiLabels()). */
export function LabelsProvider({ labels, children }: { labels: UiLabels; children: React.ReactNode }) {
  return <Ctx.Provider value={labels}>{children}</Ctx.Provider>;
}

export function useLabels(): UiLabels {
  return useContext(Ctx);
}
