/**
 * Copy checks for a new PAUSED Meta ad (Phase 6 slice 3, E3), client safe (no node imports): the dialog runs them live
 * and the Stage action runs them again on the server before any order file is written. A failing line blocks Stage.
 *
 * Mirrors `_lib/creative.py` (META_ENV_FILE's folder) `check_text` + `_check_copy` + `_check_counts` (the builder the apply skills
 * run) wherever it applies, and is stricter where the house rules are. The house rules come from the business profile
 * (Creative Studio slice 1c) and travel in the AdRuleContext (the server builds it, the dialog checks the same data):
 *   every line   not empty; the dash policy (`copyRules.dashes.ads`: punctuation = no em / en dash nor any other unicode
 *                dash, no " - " or "--", no line starting with "- " (a hyphen bullet); none = no hyphen at all; allowed =
 *                not checked); none of the ad map's `forbidden_terms` (whole word, case-insensitive, Python `\b`
 *                semantics); no AI tell; client names when the lane bans them (`copyRules.banClientNames`: Lane B the
 *                client row's name parts, Lane C every client's) and always the client notes' "Never name" items; none
 *                of the notes' "Never say" phrases or "Claims not allowed" claims; the channel's fixed bans
 *                (`copyRules.bans[code]`: price / financing; a notes' "Claims not allowed" price or financing line adds
 *                the same ban).
 *   headline     no emoji; at most 255 characters (warn over 40).
 *   primary      no URL ("http", "www."); emoji only from the palette (`adCopy.emojiPalette`; creative.py only warns on
 *                an off-palette emoji: Studio refuses it); at most 2,000 characters (a Studio cap; warn when a structured
 *                primary's first line runs past the 125 character "See more" fold).
 *   description  no emoji (warn over 30).
 *   the set      3 to 5 headlines, 2 to 3 primaries, exactly 1 description; no duplicate headline / primary; a "$" may
 *                not sit in both the headlines and the primaries (creative.py's price token rule).
 */
import { aiTellIn, compileVariantRules, type ClaimBan } from "../hooks/variant-rules";
import { fill, type DashPolicy } from "../profile-shared";

/**
 * Bumped whenever a rule here changes (recorded in each order as `checks.rules_version`; the apply scripts refuse an order
 * whose version is not the one they mirror, so the two rule sets cannot drift silently). v2 (gate fixes, 2026-10-01): the
 * concept slug allows letters, digits and single `_` only (no `-`), Lane C's fixed price ban removed (notes-based only).
 */
export const AD_RULES_VERSION = 2;

export const HEADLINE_WARN = 40;
export const HEADLINE_MAX = 255;
export const DESC_WARN = 30;
export const FOLD_WARN = 125;
export const PRIMARY_MAX = 2000;
export const DESCRIPTION_MAX = 255;
export const HEADLINES_MIN = 3;
export const HEADLINES_MAX = 5;
export const PRIMARIES_MIN = 2;
export const PRIMARIES_MAX = 3;
/** A hook this long or shorter becomes headline 1; a longer one opens primary 1 (E2). */
export const HEADLINE_FIT = 40;

export type CopyBan = "price" | "financing";

const PRICE_RE = /\$|\b\d[\d,]*\s*(dollars|bucks)\b/i;
const FINANCING_RE = /\bfinanc(e|ed|es|ing)\b|\d\s*(\/|a|per)\s*mo(nth)?\b|\bper month\b|\bmonthly payments?\b|\bpayment plans?\b|\bno money down\b|\b0% apr\b/i;
const DASHES = /[‒–—―−⸺⸻﹘﹣－]/;
const URL_RE = /(https?:\/\/|www\.)/i;
const BULLET_RE = /^[ \t]*- /m;
// creative.py's _EMOJI_RE: [\U0001F300-\U0001FAFF☀-➿⬀-⯿️] (variation selectors dropped).
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;

export type AdCopy = { headlines: string[]; primaries: string[]; description: string };

/** Everything the checks need about the channel, serializable (the server builds it; the dialog gets the same object). */
export type AdRuleContext = {
  section: "fkbpros" | "fkb";
  /** The client code, or `fkb`. */
  code: string;
  /** The ad map's `forbidden_terms` (Lane B clients; [] for Lane C or when the map has none). */
  forbiddenTerms: string[];
  /** Lane B: the client (its name parts and notes' Never lines are banned). */
  client: { code: string; name: string; brandNotes: string | null } | null;
  /** Every Lane B client (Lane C never names one). */
  allClients: { code: string; name: string; brandNotes: string | null }[];
  /** Lane C: its own brand notes ("Never say" / "Claims not allowed" lines). */
  ownNotes: string | null;
  /** House rules from the business profile (src/lib/meta/new-ad.ts adRuleContext fills them on the server). */
  house: {
    /** The ad dash policy (`copyRules.dashes.ads`). */
    dashes: DashPolicy;
    /** Refuse client names (`copyRules.banClientNames` of the lane). */
    banClientNames: boolean;
    /** "Names the client ("{name}")" style message. */
    nameMessage: string;
    /** The channel's fixed bans (`copyRules.bans[code]`). */
    bans: CopyBan[];
    /** The primary emoji palette (`adCopy.emojiPalette`). */
    palette: string[];
  };
};

type Matcher = { label: string; re: RegExp };

export type CompiledAdRules = {
  section: "fkbpros" | "fkb";
  dashes: DashPolicy;
  nameMessage: string;
  palette: string[];
  names: Matcher[];
  phrases: Matcher[];
  claims: ClaimBan[];
  forbidden: Matcher[];
  bans: Set<CopyBan>;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD = /[\p{L}\p{N}_]/u;

/** Python's `\b + re.escape(term) + \b` with re.IGNORECASE on a str (Unicode word characters). */
export function wholeWordRe(term: string): RegExp {
  const t = term.trim();
  const first = t[0] ?? "";
  const last = t[t.length - 1] ?? "";
  const pre = WORD.test(first) ? "(?<![\\p{L}\\p{N}_])" : "(?<=[\\p{L}\\p{N}_])";
  const post = WORD.test(last) ? "(?![\\p{L}\\p{N}_])" : "(?=[\\p{L}\\p{N}_])";
  return new RegExp(`${pre}${esc(t)}${post}`, "iu");
}

export function compileAdRules(ctx: AdRuleContext): CompiledAdRules {
  const v = compileVariantRules({
    section: ctx.section,
    client: ctx.section === "fkbpros" ? ctx.client : null,
    allClients: ctx.allClients,
    existingNorms: new Set(),
    ownNotes: ctx.ownNotes,
    house: {
      dashes: ctx.house.dashes,
      stateNames: false,
      banClientNames: ctx.house.banClientNames,
      banClientCodes: false,
      nameMessage: ctx.house.nameMessage,
      noHyphenMessage: "",
    },
  });
  const bans = new Set<CopyBan>(ctx.house.bans);
  // The notes' own claim lines: a "price" / "financing" claim becomes the ban (one message, not two).
  const claims: ClaimBan[] = [];
  for (const c of v.claims) {
    if (c.id === "price") bans.add("price");
    else if (c.id === "financing") bans.add("financing");
    else claims.push(c);
  }
  const notes = ctx.section === "fkb" ? (ctx.ownNotes ?? "") : (ctx.client?.brandNotes ?? "");
  for (const line of notes.split(/\r?\n/)) {
    if (!/^\s*claims not allowed\s*:/i.test(line)) continue;
    if (/dollar prices?|price ranges?|\bprices?\b/i.test(line)) bans.add("price");
    if (/financ|payment plan|monthly payment/i.test(line)) bans.add("financing");
  }
  return {
    section: ctx.section,
    dashes: ctx.house.dashes,
    nameMessage: ctx.house.nameMessage,
    palette: [...ctx.house.palette],
    names: v.names.map((n) => ({ label: n.name, re: n.re })),
    phrases: v.phrases.map((p) => ({ label: p.phrase, re: p.re })),
    claims,
    forbidden: ctx.forbiddenTerms.filter((t) => t.trim()).map((t) => ({ label: t.trim(), re: wholeWordRe(t) })),
    bans,
  };
}

export type LineKind = "headline" | "primary" | "description";
export type LineCheck = { problems: string[]; warnings: string[] };

/** The emoji in a line (variation selectors dropped), as creative.py's `_emojis_in`. */
export function emojisIn(s: string): string[] {
  return [...s.matchAll(EMOJI_RE)].map((m) => m[0]);
}

/** One line (a primary may hold several lines) against every rule for its field. */
export function checkAdLine(text: string, kind: LineKind, rules: CompiledAdRules): LineCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const s = text;
  if (!s.trim()) return { problems: ["Empty"], warnings };
  if (rules.dashes !== "allowed") {
    const d = s.match(DASHES);
    if (d) problems.push(`A dash "${d[0]}": use a comma, a period or a colon`);
    if (s.includes(" - ") || s.includes("--")) problems.push('A hyphen used as punctuation (" - " or "--")');
    if (BULLET_RE.test(s)) problems.push('A line starting with "- " (a dash bullet): use the ✅ palette');
    if (rules.dashes === "none" && /[-‐‑]/.test(s) && !problems.some((p) => p.startsWith("A hyphen"))) problems.push("A hyphen: this channel allows none");
  }
  for (const f of rules.forbidden) if (f.re.test(s)) problems.push(`Forbidden term "${f.label}" (the client's ad map)`);
  if (kind === "primary" && URL_RE.test(s)) problems.push("A URL: the button and the display link carry the click");
  const emojis = emojisIn(s);
  if (kind === "primary") {
    const off = [...new Set(emojis.filter((e) => !rules.palette.includes(e)))];
    if (off.length) problems.push(`Emoji ${off.join(" ")} is not in the palette ${rules.palette.join(" ")}`);
    const first = s.split("\n", 1)[0];
    if (s.includes("\n") && first.length > FOLD_WARN) warnings.push(`First line is ${first.length} characters: it lands past the "See more" fold (${FOLD_WARN})`);
    if (s.length > PRIMARY_MAX) problems.push(`${s.length} characters (at most ${PRIMARY_MAX})`);
  } else if (emojis.length) {
    problems.push(`An emoji in a ${kind} (emoji go in primaries only)`);
  }
  if (kind === "headline") {
    if (s.includes("\n")) problems.push("A headline is one line");
    if (s.length > HEADLINE_MAX) problems.push(`${s.length} characters (at most ${HEADLINE_MAX})`);
    else if (s.length > HEADLINE_WARN) warnings.push(`${s.length} characters: headlines read best at ${HEADLINE_WARN} or fewer`);
  }
  if (kind === "description") {
    if (s.includes("\n")) problems.push("The description is one line");
    if (s.length > DESCRIPTION_MAX) problems.push(`${s.length} characters (at most ${DESCRIPTION_MAX})`);
    else if (s.length > DESC_WARN) warnings.push(`${s.length} characters: descriptions read best at ${DESC_WARN} or fewer`);
  }
  for (const n of rules.names) {
    if (n.re.test(s)) problems.push(fill(rules.nameMessage, { name: n.label }));
  }
  for (const p of rules.phrases) if (p.re.test(s)) problems.push(`The notes say never to say "${p.label}"`);
  for (const c of rules.claims) if (c.re.test(s)) problems.push(`A claim the notes do not allow: ${c.label}`);
  if (rules.bans.has("price") && PRICE_RE.test(s)) problems.push("A price: not allowed for this channel");
  if (rules.bans.has("financing") && FINANCING_RE.test(s)) problems.push("Financing or monthly payments: not allowed for this channel");
  const tell = aiTellIn(s);
  if (tell) problems.push(`AI tell "${tell}"`);
  return { problems, warnings };
}

/** Line endings normalized (CRLF / CR -> LF), trailing spaces per line and outer blank lines removed. */
export function cleanCopyText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/^\s*\n+/, "")
    .replace(/\n+\s*$/, "")
    .trim();
}

export function cleanAdCopy(c: AdCopy): AdCopy {
  return {
    headlines: c.headlines.map((h) => cleanCopyText(h).replace(/\s*\n\s*/g, " ")),
    primaries: c.primaries.map(cleanCopyText),
    description: cleanCopyText(c.description).replace(/\s*\n\s*/g, " "),
  };
}

export type AdCopyCheck = {
  ok: boolean;
  headlines: LineCheck[];
  primaries: LineCheck[];
  description: LineCheck;
  /** Problems with the set itself (counts, the "$" rule). */
  set: string[];
  /** Every problem, flattened with its field ("Headline 2: ..."), for the server's refusal and logs. */
  all: string[];
};

/** The whole copy (already cleaned with cleanAdCopy) against every rule. Empty slots are dropped before counting. */
export function checkAdCopy(copy: AdCopy, rules: CompiledAdRules): AdCopyCheck {
  const headlines = copy.headlines.map((h) => checkAdLine(h, "headline", rules));
  const primaries = copy.primaries.map((p) => checkAdLine(p, "primary", rules));
  const description = checkAdLine(copy.description, "description", rules);
  const dupes = (list: string[], checks: LineCheck[], word: string) => {
    const seen = new Map<string, number>();
    list.forEach((t, i) => {
      const k = t.trim().toLowerCase().replace(/\s+/g, " ");
      if (!k) return;
      const at = seen.get(k);
      if (at != null) checks[i].problems.push(`Same as ${word} ${at + 1}`);
      else seen.set(k, i);
    });
  };
  dupes(copy.headlines, headlines, "headline");
  dupes(copy.primaries, primaries, "primary");
  const set: string[] = [];
  const nH = copy.headlines.filter((h) => h.trim()).length;
  const nP = copy.primaries.filter((p) => p.trim()).length;
  if (nH < HEADLINES_MIN || nH > HEADLINES_MAX) set.push(`${HEADLINES_MIN} to ${HEADLINES_MAX} headlines (now ${nH})`);
  if (nP < PRIMARIES_MIN || nP > PRIMARIES_MAX) set.push(`${PRIMARIES_MIN} to ${PRIMARIES_MAX} primaries (now ${nP})`);
  if (copy.headlines.length !== nH) set.push("Remove the empty headline slots");
  if (copy.primaries.length !== nP) set.push("Remove the empty primary slots");
  if (!rules.bans.has("price") && copy.headlines.some((h) => h.includes("$")) && copy.primaries.some((p) => p.includes("$"))) {
    set.push('A "$" may appear in the headlines or the primaries, not both');
  }
  const all = [
    ...set,
    ...headlines.flatMap((c, i) => c.problems.map((p) => `Headline ${i + 1}: ${p}`)),
    ...primaries.flatMap((c, i) => c.problems.map((p) => `Primary ${i + 1}: ${p}`)),
    ...description.problems.map((p) => `Description: ${p}`),
  ];
  return { ok: all.length === 0, headlines, primaries, description, set, all };
}

/**
 * "Draft the rest" landing in the dialog: the drafted lines go into the slots that are empty NOW (what the owner typed since
 * the click is never overwritten), then new slots are added only up to 3 headlines / 2 primaries; the description only
 * when it is still empty.
 */
export function fillEmptySlots(
  copy: AdCopy,
  d: { headlines: string[]; primaries: string[]; description: string | null; p1?: string | null },
  p1Opening: string | null = null,
): AdCopy {
  const fill = (list: string[], add: string[], min: number) => {
    const out = [...list];
    const queue = [...add];
    for (let i = 0; i < out.length && queue.length; i++) if (!out[i].trim()) out[i] = queue.shift()!;
    while (queue.length && out.filter((x) => x.trim()).length < min) out.push(queue.shift()!);
    return out;
  };
  // Primary 1 completed after the hook: only while it still reads exactly the hook line (else it is the owner's text now).
  const primaries = [...copy.primaries];
  if (d.p1 && p1Opening && (primaries[0] ?? "").trim() === p1Opening.trim()) primaries[0] = d.p1;
  return {
    headlines: fill(copy.headlines, d.headlines, HEADLINES_MIN),
    primaries: fill(primaries, d.primaries, PRIMARIES_MIN),
    description: copy.description.trim() ? copy.description : (d.description ?? copy.description),
  };
}

// ------------------------------------------------------------------------------------------------ naming

export type PsObj = "ps" | "obj";
export const PS_OBJ_LABEL: Record<PsObj, string> = {
  ps: "ps: problem / solution (the top of funnel default)",
  obj: "obj: objection (answers a doubt that stops the click)",
};
/**
 * The ad name conventions (the business profile's `ads`; Creative Studio slice 1c). Lane B: `<prefix>-<code>-<concept>-
 * <ps|obj>-<nn>` (no prefix: `<code>-...`); Lane C: `<companyPrefix> <n>`. Built on the server (`adNaming()` in
 * new-ad.ts) and handed to the dialog with the prefill.
 */
export type AdNaming = { clientPrefix: string; companyPrefix: string; conceptExample: string };

/**
 * The `<concept>` slot of the Lane B ad name: the avatar + concept slug (lowercase letters, digits, single `_` between
 * words). Never `-`: the ad name is hyphen-delimited (GHL's utm_content and the number parse read it).
 */
export const CONCEPT_RE = /^[a-z0-9](?:[a-z0-9_]{0,46}[a-z0-9])?$/;

export function conceptProblem(concept: string, naming: Pick<AdNaming, "clientPrefix" | "conceptExample">): string | null {
  if (!concept) return `A concept is needed for the ${naming.clientPrefix ? `${naming.clientPrefix} ` : ""}ad name`;
  if (!CONCEPT_RE.test(concept) || concept.includes("__")) {
    return `Lowercase letters, digits and _ only (2 to 48 characters), like ${naming.conceptExample}`;
  }
  return null;
}

/** A concept slug from an angle key or free text: lowercase, "static_" dropped, runs of other characters -> "_". */
export function conceptFrom(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/^static[_-]/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/g, "");
}

export function namePreview(section: "fkbpros" | "fkb", code: string, concept: string, psObj: PsObj, n: number, naming: Pick<AdNaming, "clientPrefix" | "companyPrefix">): string {
  const nn = String(n).padStart(2, "0");
  if (section === "fkb") return `${naming.companyPrefix} ${n}`;
  return `${naming.clientPrefix ? `${naming.clientPrefix}-` : ""}${code}-${concept || "<concept>"}-${psObj}-${nn}`;
}
