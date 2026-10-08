/**
 * Test order rules (Phase 5 slice 3, PHASE-5 G; client safe: no imports). The order the owner tests in is
 * offer -> hook -> format -> copy (then offer again). A batch = the ads a channel's campaign(s) got on the same
 * America/New_York day. Each new ad is compared with the ads that ran BEFORE the batch:
 *   - a CTA type or landing link none of them used                      = offer
 *   - an angle none of them used                                        = hook
 *   - the same angle, but a file (video or static) none of them used    = format
 *     (the file = the matched local file when both ads have one, else Meta's own media: video ids / image hashes; when
 *     neither side is known the reason says "file unknown" instead of assuming the same file)
 *   - the same angle and the same file, but text none of them used      = copy
 *   - nothing new (a copy of an ad already running, e.g. a migration)   = none (not a test)
 * An ad's variable is the highest of its parts in that order; a batch whose ads changed more than one variable is
 * "mixed" and suggests the highest (offer > hook > format > copy), naming the parts.
 * The angle is the ad map's `angle_key` (a universal ad's registry id; a relaunched copy with the same name takes its
 * original's). Two ads that both have one compare by it; otherwise (Lane C has no ad map) the ads' opening lines (the first
 * primary's hook line, else the first headline) stand in for it.
 */

export const TEST_VARIABLES = ["offer", "hook", "format", "copy"] as const;
export type TestVariable = (typeof TEST_VARIABLES)[number];
/** What the owner can set: a variable or "none" (not a test). */
export type TestAnswer = TestVariable | "none";
export const TEST_ANSWERS: TestAnswer[] = [...TEST_VARIABLES, "none"];
export const TEST_LABEL: Record<TestAnswer, string> = { offer: "offer", hook: "hook", format: "format", copy: "copy", none: "not a test" };

/** The next variable to test after this one (the order cycles; nothing tested yet = offer). */
export function nextInOrder(v: TestVariable | null): TestVariable {
  if (v == null) return "offer";
  return TEST_VARIABLES[(TEST_VARIABLES.indexOf(v) + 1) % TEST_VARIABLES.length];
}

/** Highest first (offer > hook > format > copy). */
export function byOrder(a: TestVariable, b: TestVariable): number {
  return TEST_VARIABLES.indexOf(a) - TEST_VARIABLES.indexOf(b);
}

/** What the rules compare per ad (built from the `ads` row by the server side). */
export type AdFeatures = {
  id: string;
  name: string;
  /** Angle key ("layout-lover", "universal:fkb_sizzle_02"); null = unknown (compare the opening lines). */
  angle: string | null;
  /** The normalized opening line (null = no copy). */
  line: string | null;
  /** How to name the angle in a reason ("layout-lover", "the opening \"Big results start here\""). */
  angleLabel: string;
  /** The matched local file ("asset:<id>"); null = no local file. */
  asset: string | null;
  /** Meta's own media identity: the creative's video ids / image hashes (sorted); null = none on the creative. */
  metaMedia: string | null;
  isVideo: boolean;
  /** Normalized headlines + primaries (a copy of the same text compares equal). */
  texts: string;
  ctas: string[];
  /** Landing link (host + path, lowercased, no query); null = none on the creative. */
  link: string | null;
};

export type AdVerdict = {
  id: string;
  name: string;
  variable: TestAnswer;
  parts: TestVariable[];
  why: string;
  /** What changed per variable (the batch reason groups them). */
  notes?: Partial<Record<TestVariable, string>>;
};

/** Same angle: both angle keys when both ads have one, else the opening lines. */
export function sameAngle(a: Pick<AdFeatures, "angle" | "line">, b: Pick<AdFeatures, "angle" | "line">): boolean {
  if (a.angle && b.angle) return a.angle === b.angle;
  return a.line != null && a.line === b.line;
}

/**
 * How two ads' files compare: by the matched local file when both have one, else by Meta's own media (video ids /
 * image hashes) when both have it, else unknown. A video and a static are always different files.
 */
export function fileRelation(a: Pick<AdFeatures, "asset" | "metaMedia" | "isVideo">, b: Pick<AdFeatures, "asset" | "metaMedia" | "isVideo">): "same" | "different" | "unknown" {
  if (a.isVideo !== b.isVideo) return "different";
  if (a.asset && b.asset) return a.asset === b.asset ? "same" : "different";
  if (a.metaMedia && b.metaMedia) return a.metaMedia === b.metaMedia ? "same" : "different";
  return "unknown";
}

/** One new ad against the ads that ran before its batch. */
export function classifyAd(ad: AdFeatures, prior: AdFeatures[]): AdVerdict {
  const parts: TestVariable[] = [];
  const notes: Partial<Record<TestVariable, string>> = {};
  const note = (v: TestVariable, text: string) => {
    parts.push(v);
    notes[v] = text;
  };
  const priorCtas = new Set(prior.flatMap((p) => p.ctas));
  const priorLinks = new Set(prior.map((p) => p.link).filter((l): l is string => Boolean(l)));
  const newCta = priorCtas.size > 0 ? ad.ctas.find((c) => !priorCtas.has(c)) : undefined;
  const newLink = priorLinks.size > 0 && ad.link && !priorLinks.has(ad.link) ? ad.link : null;
  if (newCta || newLink) note("offer", newCta ? `new button ${newCta.replace(/_/g, " ").toLowerCase()}` : `new landing page ${newLink}`);
  const same = prior.filter((p) => sameAngle(p, ad));
  const kind = ad.isVideo ? "video" : "static";
  if (!same.length) note("hook", `new angle ${ad.angleLabel}`);
  else {
    const rel = same.map((p) => ({ p, r: fileRelation(p, ad) }));
    const sameFile = rel.filter((x) => x.r === "same").map((x) => x.p);
    if (sameFile.length) {
      if (!sameFile.some((p) => p.texts === ad.texts)) note("copy", `new text on the same ${kind} (${ad.angleLabel})`);
    } else if (rel.every((x) => x.r === "different")) {
      note("format", `new ${kind} for ${ad.angleLabel}`);
    } else if (rel.some((x) => x.r === "unknown" && x.p.texts === ad.texts)) {
      // Neither side's file is known and nothing else changed: never assume the same file (that would read "not a test").
      note("format", `file unknown: same angle and text as an earlier ${kind} (${ad.angleLabel}), so the file is the likely change`);
    } else {
      note("copy", `new text, file unknown (${ad.angleLabel})`);
    }
  }
  parts.sort(byOrder);
  const why = parts.map((v) => notes[v]).join("; ");
  return { id: ad.id, name: ad.name, variable: parts[0] ?? "none", parts, why: why || "repeats an ad already running", notes };
}

export type BatchSuggestion = {
  suggested: TestAnswer;
  /** Every variable the batch changed, highest first; more than one = mixed. */
  parts: TestVariable[];
  mixed: boolean;
  first: boolean;
  detail: AdVerdict[];
  reason: string;
};

/** A batch of new ads against the ads that ran before it. */
export function classifyBatch(batch: AdFeatures[], prior: AdFeatures[]): BatchSuggestion {
  if (!prior.length) {
    return {
      suggested: "none",
      parts: [],
      mixed: false,
      first: true,
      detail: batch.map((a) => ({ id: a.id, name: a.name, variable: "none", parts: [], why: "first ads on the account" })),
      reason: "The first ads on this account: nothing earlier to compare with.",
    };
  }
  const detail = batch.map((a) => classifyAd(a, prior));
  const parts = [...new Set(detail.flatMap((d) => d.parts))].sort(byOrder);
  const repeats = detail.filter((d) => d.variable === "none").length;
  const reasons: string[] = [];
  for (const v of parts) {
    const ads = detail.filter((d) => d.parts.includes(v));
    const bits = [...new Set(ads.map((d) => d.notes?.[v] ?? d.why))];
    reasons.push(`${TEST_LABEL[v]}: ${bits.slice(0, 3).join("; ")}${bits.length > 3 ? ` and ${bits.length - 3} more` : ""}`);
  }
  if (repeats) reasons.push(`${repeats} ${repeats === 1 ? "ad repeats an ad" : "ads repeat ads"} already running`);
  return {
    suggested: parts[0] ?? "none",
    parts,
    mixed: parts.length > 1,
    first: false,
    detail,
    reason: parts.length ? `${cap(reasons.join(" · "))}.` : `Not a test: ${repeats === 1 ? "the new ad repeats an ad" : repeats === 2 ? "both new ads repeat ads" : `all ${repeats} new ads repeat ads`} already running (same angle, file and text).`,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The effective answer of a stored batch: the owner's, else the suggestion. */
export function effectiveAnswer(row: { variable: string | null; suggested: string }): TestAnswer {
  const v = (row.variable ?? row.suggested) as TestAnswer;
  return TEST_ANSWERS.includes(v) ? v : "none";
}
