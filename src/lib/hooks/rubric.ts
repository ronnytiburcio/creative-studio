/**
 * Hook rubric (client safe: no node imports). Types for a rubric version (stored as JSON in `rubric_versions`) and the
 * pure helpers both the worker and the UI use (which dimensions apply to a
 * hook, the overall score, the Three P's rule, score bands).
 *
 * A rubric version is data, not code: dimensions (5 described levels each, Jev `score`), the 9 copy mechanics + none
 * (Jev `choice` "style") and the avatars per section (Jev `choice` "avatar"); a fresh DB starts from the business
 * profile's `rubric` (src/lib/profile.ts). Changing any of it saves a NEW version
 * (slice 3); every hook without a score for the current version is then due again, and old scores stay.
 * Lane A notes and the who's who note are NOT part of a version (see src/lib/hooks/notes.ts); since v3 the section briefs
 * are (`rubric_versions.briefs`, read through `briefOf`), and each version stores its per section EFFECTIVE version
 * (`sectionContent` / `computeSectionVersions` below).
 *
 * Level wording follows TypeSafe's jev-1.13 guidance: literal, concrete, one line each, low to high, aligned with the
 * question; arithmetic (the overall mean, the Three P's rule) stays in code.
 */

import { LIST_PAGE_SIZE } from "../paging";

export type HookKind = "text" | "video";
/** rtm = Lane A (the owner's own content brand), fkbpros = the Lane B client ads, fkb = Lane C (Phase 5, one channel). */
export type SectionKey = "rtm" | "fkbpros" | "fkb";
export const SECTION_KEYS: SectionKey[] = ["rtm", "fkbpros", "fkb"];

export type Dimension = {
  id: string;
  label: string;
  /** Short label for the row bars. */
  short: string;
  /** The question Jev reads (literal, names the state keys it should look at). */
  question: string;
  appliesTo: { kinds: HookKind[]; sections: SectionKey[] };
  /** Exactly 5, low (1) to high (5). */
  levels: string[];
};

export type Mechanic = { id: string; label: string; definition: string };

export type Avatar = {
  slug: string;
  label: string;
  /** The section the avatar belongs to (where the Rubric page lists it). */
  section: SectionKey;
  /**
   * Every section the avatar is offered in, when more than its own (rubric v2: the 10 Lane B avatars that are not
   * universal only are offered on Lane C hooks too, with the same slug so calibration can pool them). Absent = [section].
   */
  sections?: SectionKey[];
  /** Lane B problem/solution (ps) or objection (obj); Lane A avatars have none. */
  stage: "ps" | "obj" | null;
  person: string;
  pain: string;
  promise: string;
  /** Lane B brand promise, offered only on shared (no client) hooks. */
  universalOnly: boolean;
};

export type RubricContent = {
  dimensions: Dimension[];
  mechanics: Mechanic[];
  avatars: Avatar[];
};

/**
 * The section briefs a version carries (`channel.brief`, landing page Phase 2 slice 1, migration 0023). A missing key
 * (or null for the whole column, every version before v3) = the legacy fixed text (`LEGACY_SECTION_BRIEF`, notes.ts).
 * Read them only through `briefOf` (notes.ts).
 */
export type RubricBriefs = Partial<Record<SectionKey, string>>;

/**
 * The EFFECTIVE version per section: the version whose content that section still has (`computeSectionVersions`). The
 * copy gate reports it and copy_score.py caches by it, so a version that only changes Lane A (v3) keeps Lane B and Lane C
 * on 2. Studio's own hook scores keep the global version (`hook_scores.rubric_version`).
 */
export type SectionVersions = Record<SectionKey, number>;

export type RubricVersion = RubricContent & {
  version: number;
  note: string | null;
  createdAt: number;
  rescoreAt: number | null;
  /** null = every brief is the legacy text (versions before v3). */
  briefs: RubricBriefs | null;
  sectionVersions: SectionVersions;
};

export const NONE_MECHANIC = "none";
export const NONE_AVATAR = "none";

/** The Three P's rule (A6): a P is clear when P(yes) >= 0.5. */
export const PP_CLEAR = 0.5;
export const PP_IDS = ["pp_person", "pp_pain", "pp_promise"] as const;
export type PpId = (typeof PP_IDS)[number];
export const PP_LABEL: Record<PpId, string> = { pp_person: "Person", pp_pain: "Pain", pp_promise: "Promise" };

/** Question ids besides the dimensions. */
export const HOOK_QUESTION_LABEL: Record<string, string> = {
  style: "Copy mechanic",
  avatar: "Avatar",
  stops_scroll: "Stops the scroll",
  pp_person: "Person clear",
  pp_pain: "Pain clear",
  pp_promise: "Promise clear",
};

// ------------------------------------------------------------------------------------------------ content

/*
 * The rubric CONTENT is data (rubric_versions rows). Creative Studio slice 1c: a fresh DB is seeded with ONE version, the
 * business profile's `rubric` (or the neutral starter in src/lib/profile-defaults.ts); the original install keeps the v1,
 * v2 and v3 rows its DB already holds. Nothing here carries business wording.
 */

// ------------------------------------------------------------------------------------------------ helpers

/** Dimensions that apply to a hook of this section + kind, in rubric order. */
export function dimensionsFor(rubric: Pick<RubricContent, "dimensions">, section: SectionKey, kind: HookKind): Dimension[] {
  return rubric.dimensions.filter((d) => d.appliesTo.sections.includes(section) && d.appliesTo.kinds.includes(kind));
}

/** The sections an avatar is offered in (its own section unless `sections` says more). */
export function avatarSections(a: Pick<Avatar, "section" | "sections">): SectionKey[] {
  return a.sections?.length ? a.sections : [a.section];
}

/**
 * Avatars a hook may be matched to: the ones offered in its section; Lane B universal-only avatars only on shared hooks
 * (no client). Lane A hooks get the Lane A avatars; Lane C hooks (v2) the Lane B avatars marked for Lane C (never
 * universal only).
 */
export function avatarsFor(rubric: Pick<RubricContent, "avatars">, section: SectionKey, shared: boolean): Avatar[] {
  return rubric.avatars.filter((a) => avatarSections(a).includes(section) && (!a.universalOnly || (shared && section === "fkbpros")));
}

/**
 * Rubric v2 content (Phase 5, DECISIONS "Phase 5 grilling"): the given version with Lane C added. Lane C gets exactly the
 * Lane B dimensions (Offer clarity included; Visual stop power on video) and the Lane B avatars that are not universal
 * only (same slugs). Nothing else changes. Idempotent.
 */
export function withFkb(r: RubricContent): RubricContent {
  const add = (xs: SectionKey[]): SectionKey[] => (xs.includes("fkbpros") && !xs.includes("fkb") ? [...xs, "fkb"] : xs);
  return {
    dimensions: r.dimensions.map((d) => ({ ...d, appliesTo: { ...d.appliesTo, sections: add(d.appliesTo.sections) } })),
    mechanics: r.mechanics.map((m) => ({ ...m })),
    avatars: r.avatars.map((a) => (a.section === "fkbpros" && !a.universalOnly ? { ...a, sections: add(avatarSections(a)) } : { ...a })),
  };
}

/** Does this rubric score Lane C hooks (v2 and later)? */
export function rubricHasFkb(r: Pick<RubricContent, "dimensions">): boolean {
  return r.dimensions.some((d) => d.appliesTo.sections.includes("fkb"));
}

/** The note of the version seed step 8 adds on a DB whose rubric does not score Lane C yet (an upgrade path only). */
export const LANE_C_ADDED_NOTE =
  "Lane C added: its hooks get the Lane B dimensions and the Lane B avatars that are not universal only. Nothing else changed; older scores stay until Rescore.";

/**
 * The given version with one lane's avatars replaced by `avatars` (appended after the others, every other lane's avatar
 * untouched and in place). Dimensions and mechanics are unchanged, so the other lanes' content (and section versions)
 * stay exactly what they were. Idempotent. Seed step 11 uses it with the profile's Lane A avatars.
 */
export function withLaneAvatars(r: RubricContent, lane: SectionKey, avatars: Avatar[]): RubricContent {
  return {
    dimensions: r.dimensions.map((d) => ({ ...d, appliesTo: { kinds: [...d.appliesTo.kinds], sections: [...d.appliesTo.sections] }, levels: [...d.levels] })),
    mechanics: r.mechanics.map((m) => ({ ...m })),
    avatars: [...r.avatars.filter((a) => a.section !== lane).map((a) => ({ ...a })), ...avatars.filter((a) => a.section === lane).map((a) => ({ ...a }))],
  };
}

// ------------------------------------------------------------------------------------------ section versions

/**
 * Everything one section's scoring reads from a rubric version, as canonical JSON (fixed key order, so a version saved
 * by the editor and one written by the seed compare equal when their content is): the dimensions that apply to the
 * section (id, label, question, kinds, levels; `short` is display only), the avatars offered in it (shared = true for
 * Lane B, so the universal only ones count; without `sections`, which only says where else an avatar is offered),
 * the copy mechanics and the section's brief (resolved by the caller: `briefOf`, notes.ts).
 */
export function sectionContent(r: RubricContent, section: SectionKey, brief: string): string {
  return JSON.stringify({
    dimensions: r.dimensions
      .filter((d) => d.appliesTo.sections.includes(section))
      .map((d) => ({ id: d.id, label: d.label, question: d.question, kinds: (["text", "video"] as const).filter((k) => d.appliesTo.kinds.includes(k)), levels: d.levels })),
    avatars: avatarsFor(r, section, section === "fkbpros").map((a) => ({
      slug: a.slug,
      label: a.label,
      section: a.section,
      stage: a.stage,
      person: a.person,
      pain: a.pain,
      promise: a.promise,
      universalOnly: a.universalOnly,
    })),
    mechanics: r.mechanics.map((m) => ({ id: m.id, label: m.label, definition: m.definition })),
    brief,
  });
}

/** Every section at one version (a row with no `section_versions`: versions saved before migration 0023). */
export function uniformSectionVersions(version: number): SectionVersions {
  return Object.fromEntries(SECTION_KEYS.map((s) => [s, version])) as SectionVersions;
}

/**
 * `rubric_versions.section_versions` JSON -> one number per section. A missing, malformed or non positive entry (or a
 * null column: rows saved before migration 0023) = the row's own version for that section.
 */
export function parseSectionVersions(raw: string | null, version: number): SectionVersions {
  const out = uniformSectionVersions(version);
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const s of SECTION_KEYS) {
        const n = (v as Record<string, unknown>)[s];
        if (Number.isInteger(n) && (n as number) > 0) out[s] = n as number;
      }
    }
  } catch {
    /* keep the row's own version */
  }
  return out;
}

/**
 * `rubric_versions.briefs` JSON -> RubricBriefs: only known sections with a non empty string. Anything else (null,
 * malformed JSON, a wrong shape, no usable entry) = null, i.e. every section reads the legacy brief (`briefOf`).
 */
export function parseBriefs(raw: string | null): RubricBriefs | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: RubricBriefs = {};
    for (const s of SECTION_KEYS) {
      const b = (v as Record<string, unknown>)[s];
      if (typeof b === "string" && b.trim()) out[s] = b;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * The section versions of a NEW rubric version: a section whose content (`sectionContent`, with its resolved brief) is
 * equal to the previous version's keeps the previous section version; any change takes `nextVersion`. Computed once,
 * when the version is saved (`saveRubricVersion`, seed step 11), and stored.
 */
export function computeSectionVersions(
  prev: { content: RubricContent; briefs: Record<SectionKey, string>; sectionVersions: SectionVersions },
  next: { content: RubricContent; briefs: Record<SectionKey, string> },
  nextVersion: number,
): SectionVersions {
  return Object.fromEntries(
    SECTION_KEYS.map((s) => [
      s,
      sectionContent(prev.content, s, prev.briefs[s]) === sectionContent(next.content, s, next.briefs[s]) ? prev.sectionVersions[s] : nextVersion,
    ]),
  ) as SectionVersions;
}

/** "<Lane A> v3 · <Lane B> v2 · <Lane C> v2" (the Rubric page; `names` = the lane display names). */
export function sectionVersionsLabel(v: SectionVersions, names: Record<SectionKey, string>): string {
  return SECTION_KEYS.map((s) => `${names[s]} v${v[s]}`).join(" · ");
}

/** Jev's 0-based score (can land between levels) -> 1..5 level, one decimal (same mapping as classify's energy). */
export function levelOf(score: number): number {
  return Math.round((score + 1) * 10) / 10;
}

/** Overall = mean of the applicable dimension levels (1..5), unrounded; null when none answered. */
export function overallOf(levels: (number | null | undefined)[]): number | null {
  const xs = levels.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** The P's that are not clear (P < 0.5), in Person, Pain, Promise order. */
export function missingPs(p: Partial<Record<PpId, number | null>>): PpId[] {
  return PP_IDS.filter((id) => !(typeof p[id] === "number" && (p[id] as number) >= PP_CLEAR));
}

/** "Missing: Pain" / "Missing: Person, Promise" (empty when all three are clear). */
export function missingLabel(missing: PpId[]): string {
  return missing.length ? `Missing: ${missing.map((id) => PP_LABEL[id]).join(", ")}` : "";
}

export const SCORE_BANDS = {
  high: { label: "3.5 to 5 (strong)", min: 3.5, max: 99 },
  mid: { label: "2.5 to 3.4", min: 2.5, max: 3.5 },
  low: { label: "1 to 2.4 (weak)", min: 0, max: 2.5 },
} as const;
export type ScoreBand = keyof typeof SCORE_BANDS | "unscored";
export const SCORE_BAND_IDS: ScoreBand[] = ["high", "mid", "low", "unscored"];

/** The band of an overall score (a non-finite or missing score = "unscored"). */
export function bandOf(overall: number | null): ScoreBand {
  if (typeof overall !== "number" || !Number.isFinite(overall)) return "unscored";
  for (const [band, b] of Object.entries(SCORE_BANDS)) if (overall >= b.min && overall < b.max) return band as ScoreBand;
  return "low";
}

export const HOOK_SOURCES = ["manual", "pasted", "copy_doc", "asset", "variant", "meta", "moment"] as const;
export type HookSource = (typeof HOOK_SOURCES)[number];
export const HOOK_SOURCE_LABEL: Record<HookSource, string> = {
  manual: "Added",
  pasted: "Pasted",
  copy_doc: "Approved copy",
  asset: "Video",
  variant: "Variant",
  meta: "From Meta",
  /** Phase 6: the first line of a Shorts board moment (a Lane A episode). */
  moment: "From an episode",
};

/** Normalized text for dedupe within a channel: case, punctuation, emoji and spacing do not matter. */
export function normHook(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}'$%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const HOOK_MAX_CHARS = 500;

/** Rows per page on the Hooks tab (page links, server rendered via `?page=`; the shared list page size since 2026-10-06). */
export const HOOKS_PAGE = LIST_PAGE_SIZE;
