/**
 * Copy rules for rewritten hook variants (Phase 4 E4), checked in code (client safe: no node imports). `claude -p` is
 * told the same rules in its prompt; this module is the gate. A variant that breaks any rule is dropped (the job log
 * says which rule).
 *
 *   The HOUSE rules per lane come from the business profile (`profile.copyRules`, Creative Studio slice 1c;
 *   `houseRulesFor`, carried in the context so the browser checks the same rules): the dash policy (none = no dash or
 *   hyphen at all; punctuation = no em / en dash and no hyphen used as punctuation, a compound like "walk-in" or
 *   "10-year" is fine; allowed = not checked), US state names, and whether client names are refused (Lane B: the
 *   client's own on its hooks, every client's on shared hooks; Lane A also the client codes; Lane C every client's).
 *   The NOTES rules always apply: a client hook never uses a "Never name ..." / "Never speak as ..." item of its own
 *   client's notes, and client (and Lane C) hooks refuse the literal claims their notes forbid where code can see them
 *   (a "$" price when the notes say no price, financing words, licensed / insured / bonded, warranty, star ratings, a
 *   founding year, and the words after a "Never say ..." line).
 *   Always: none of AI_TELLS, 3 to 200 characters, not the parent's text or any live hook's in the channel (normalized),
 *     and (checked by the worker after these) a copy mechanic no kept variant of the batch already uses.
 */
import { normHook, type SectionKey } from "./rubric";
import { fill, type DashPolicy, type HouseRules } from "../profile-shared";

/** Phrases that read as machine written (one list, used by the prompt and the check). Matched case-insensitively. */
export const AI_TELLS: readonly string[] = [
  "delve",
  "leverage",
  "it's not just",
  "not just about",
  "game changer",
  "game-changer",
  "unlock",
  "elevate",
  "in today's",
  "seamless",
  "unleash",
  "supercharge",
  "look no further",
  "dive into",
  "navigate the",
  "embark",
  "tapestry",
  "realm",
  "revolutionize",
  "cutting edge",
  "cutting-edge",
  "state of the art",
  "next level",
];

export const US_STATES: readonly string[] = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
  "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
  "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming",
];

export const VARIANT_MIN_CHARS = 3;
export const VARIANT_MAX_CHARS = 200;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole word / phrase, case-insensitive; apostrophes typed either way. */
function phraseRe(phrase: string): RegExp {
  const body = esc(phrase.toLowerCase()).replace(/'/g, "['’]").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}
/** Word start only (stems: "unlock" also catches "unlocks", "elevate" catches "elevated"). */
function stemRe(stem: string): RegExp {
  const body = esc(stem.toLowerCase()).replace(/'/g, "['’]").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}`, "iu");
}

const TELL_RES = AI_TELLS.map((t) => ({ t, re: /\s|'|-/.test(t) ? phraseRe(t) : stemRe(t) }));
const STATE_RES = US_STATES.map((st) => ({ st, re: phraseRe(st) }));

/** The first AI tell in `text`, or null (the same matching checkVariant uses; Phase 6 moments reuse it). */
export function aiTellIn(text: string): string | null {
  return TELL_RES.find(({ re }) => re.test(text))?.t ?? null;
}

/** Words a "Never name them" style sentence can end on that are not names. */
const NOT_A_NAME = new Set(["them", "they", "him", "her", "it", "us", "anyone", "anybody", "clients", "the client", "names"]);

/** Items of a "Never name A, B, C or D, and never ..." / "Never say X or Y." sentence. */
function listAfter(line: string, lead: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(lead.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    let rest = line.slice(m.index + m[0].length);
    rest = rest.split(/[.;:]\s|[.;:]$|,?\s+and never\b|,?\s+or use\b|\s+in any\b|\s+as the speaker\b/i)[0];
    for (const part of rest.split(/,\s*|\s+or\s+|\s+and\s+/i)) {
      const item = part.replace(/^(as|the|their|his|her)\s+/i, "").replace(/^(the)\s+/i, "").replace(/[."']+$/g, "").trim();
      if (item.length >= 2 && item.length <= 60 && !NOT_A_NAME.has(item.toLowerCase())) out.push(item);
    }
  }
  return out;
}

/**
 * Names a client's copy must never use: its row's name parts (people + company; `rowNames` false = only the notes) and
 * every "Never name ..." / "Never speak as ..." item of its brand notes.
 */
export function clientBannedNames(client: { code: string; name: string; brandNotes: string | null }, rowNames = true): string[] {
  const names = new Set<string>();
  if (rowNames) {
    for (const part of client.name.split(" / ")) {
      const clean = part.replace(/\s*\([^)]*\)/g, "").trim();
      if (!clean) continue;
      names.add(clean);
      // "Ann and Bo" -> each person.
      for (const p of clean.split(/\s+and\s+|\s*&\s*/i)) if (p.trim() && p.trim() !== clean) names.add(p.trim());
    }
  }
  for (const line of (client.brandNotes ?? "").split(/\r?\n/)) {
    for (const n of listAfter(line, /\bnever name\s+/)) names.add(n);
    for (const n of listAfter(line, /\bnever speak as\s+/)) names.add(n);
  }
  return [...names];
}

/** Literal phrases a client's notes say never to use ("Never say our work, our crews or recent project."). */
export function clientBannedPhrases(brandNotes: string | null): string[] {
  const out = new Set<string>();
  for (const line of (brandNotes ?? "").split(/\r?\n/)) for (const p of listAfter(line, /\bnever say\s+/)) out.add(p);
  return [...out];
}

export type ClaimBan = { id: string; label: string; re: RegExp };

/**
 * Checkable claims a client's "Claims not allowed:" lines forbid. Modest and literal: only words code can see.
 * A claim the notes allow elsewhere is only banned when the "not allowed" line names it.
 */
export function clientClaimBans(brandNotes: string | null): ClaimBan[] {
  const lines = (brandNotes ?? "").split(/\r?\n/).filter((l) => /^\s*claims not allowed\s*:/i.test(l));
  const text = lines.join(" ").toLowerCase();
  const bans: ClaimBan[] = [];
  if (!text) return bans;
  if (/\bany price\b/.test(text)) bans.push({ id: "price", label: "a price (the notes allow no price)", re: /\$\s?\d|\$|\b\d[\d,]*\s*(dollars|bucks)\b/i });
  if (/financ|monthly payment|payment plan/.test(text)) {
    bans.push({
      id: "financing",
      label: "financing or monthly payments",
      re: /\bfinanc(e|ed|ing)\b|\d\s*(\/|a|per)\s*mo(nth)?\b|\bper month\b|\bmonthly payments?\b|\bpayment plans?\b/i,
    });
  }
  if (/\blicensed\b/.test(text)) bans.push({ id: "licensed", label: "licensed", re: /\blicensed\b/i });
  if (/\binsured\b/.test(text)) bans.push({ id: "insured", label: "insured", re: /\binsured\b/i });
  if (/\bbonded\b/.test(text)) bans.push({ id: "bonded", label: "bonded", re: /\bbonded\b/i });
  if (/warrant/.test(text)) bans.push({ id: "warranty", label: "a warranty", re: /\bwarrant(y|ies|ied)\b/i });
  if (/star rating/.test(text)) bans.push({ id: "stars", label: "a star rating", re: /\b\d(\.\d)?\s*(\+\s*)?stars?\b|\bstar ratings?\b|\bfive stars?\b/i });
  if (/founding year|years in business/.test(text)) {
    bans.push({ id: "years", label: "a founding year or years in business", re: /\bsince (19|20)\d{2}\b|\bfounded in\b|\byears in business\b/i });
  }
  return bans;
}

/** Everything the check needs about the channel (built by the worker from the DB; built by hand in the smoke test). */
export type VariantRuleContext = {
  section: SectionKey;
  /** Lane B client hooks: that client; null = Lane A or Lane B shared. */
  client: { code: string; name: string; brandNotes: string | null } | null;
  /** Every Lane B client (shared Lane B hooks and Lane A hooks ban all their names; Lane A also bans their codes). */
  allClients: { code: string; name: string; brandNotes: string | null }[];
  /** normHook of the parent and of every live hook (and undecided variant) in the channel. */
  existingNorms: Set<string>;
  /** Lane C hooks (Phase 5 slice 2): Lane C's own brand notes, for its "Never say" / "Claims not allowed" lines. */
  ownNotes?: string | null;
  /** The lane's house rules (server code: `houseRulesFor(section)` from src/lib/profile.ts; the browser gets them as data). */
  house: HouseRules;
};

export type CompiledRules = {
  section: SectionKey;
  house: HouseRules;
  names: { name: string; re: RegExp }[];
  phrases: { phrase: string; re: RegExp }[];
  claims: ClaimBan[];
  existing: Set<string>;
};

export function compileVariantRules(ctx: VariantRuleContext): CompiledRules {
  const house = ctx.house;
  const nameSet = new Set<string>();
  if (ctx.client) for (const n of clientBannedNames(ctx.client, house.banClientNames)) nameSet.add(n);
  else if (house.banClientNames) for (const c of ctx.allClients) for (const n of clientBannedNames(c)) nameSet.add(n);
  if (house.banClientCodes) for (const c of ctx.allClients) nameSet.add(c.code);
  // Longest first so the log names the fullest match ("Acme Home Services" before "Acme").
  const names = [...nameSet].sort((a, b) => b.length - a.length).map((name) => ({ name, re: phraseRe(name) }));
  // Lane C speaks as itself (its own name is fine) but never names a Lane B client; its own notes carry its claim limits.
  const notes = ctx.client ? ctx.client.brandNotes : ctx.section === "fkb" ? (ctx.ownNotes ?? null) : null;
  const phrases = notes != null ? clientBannedPhrases(notes).map((phrase) => ({ phrase, re: phraseRe(phrase) })) : [];
  const claims = notes != null ? clientClaimBans(notes) : [];
  return { section: ctx.section, house, names, phrases, claims, existing: ctx.existingNorms };
}

const DASHES = /[‒–—―−⸺⸻﹘﹣－]/;
const HYPHENS = /[-‐‑]/g;
const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;

/**
 * Dash problems under a dash policy, or null. `punctuation`: a hyphen joining two word characters (letter-letter,
 * digit-letter, letter-digit) is a compound and allowed ("walk-in", "10-year"); a hyphen with a space or punctuation
 * beside it, "--", or one between two digits (a range) is punctuation. `none`: no hyphen at all (`noHyphen` = the
 * message for a compound, {text}). `allowed`: never a problem.
 */
export function dashProblem(text: string, policy: DashPolicy, noHyphen = 'hyphenated compound "{text}"'): string | null {
  if (policy === "allowed") return null;
  const d = text.match(DASHES);
  if (d) return `dash "${d[0]}"`;
  for (const m of text.matchAll(HYPHENS)) {
    const i = m.index ?? 0;
    const prev = text[i - 1] ?? "";
    const next = text[i + 1] ?? "";
    const compound =
      (LETTER.test(prev) && LETTER.test(next)) || (DIGIT.test(prev) && LETTER.test(next)) || (LETTER.test(prev) && DIGIT.test(next));
    if (policy === "none") return compound ? fill(noHyphen, { text: text.slice(Math.max(0, i - 12), i + 12).trim() }) : "hyphen used as punctuation";
    if (!compound) return "hyphen used as punctuation";
  }
  return null;
}

export type VariantVerdict = { ok: true } | { ok: false; rule: string; detail: string };

/** E2: every kept variant uses a different copy mechanic; a repeat is dropped (rule `mechanic`) by the worker. */
export const MECHANIC_CLASH = "same copy mechanic as another variant";

/** Check one variant against the compiled rules. Adds its norm to `accepted` when it passes (dedupe within a batch). */
export function checkVariant(text: string, rules: CompiledRules, accepted: Set<string> = new Set()): VariantVerdict {
  const t = text.trim();
  const fail = (rule: string, detail: string): VariantVerdict => ({ ok: false, rule, detail });
  if (t.length < VARIANT_MIN_CHARS || t.length > VARIANT_MAX_CHARS) return fail("length", `${t.length} characters (${VARIANT_MIN_CHARS} to ${VARIANT_MAX_CHARS})`);
  const dash = dashProblem(t, rules.house.dashes, rules.house.noHyphenMessage);
  if (dash) return fail("dash", dash);
  for (const { t: tell, re } of TELL_RES) if (re.test(t)) return fail("ai_tell", `AI tell "${tell}"`);
  for (const { name, re } of rules.names) {
    if (re.test(t)) {
      return fail("name", fill(rules.house.nameMessage, { name }));
    }
  }
  if (rules.house.stateNames) for (const { st, re } of STATE_RES) if (re.test(t)) return fail("state", `US state name "${st}"`);
  for (const { phrase, re } of rules.phrases) if (re.test(t)) return fail("claim", `the notes say never to say "${phrase}"`);
  for (const c of rules.claims) if (c.re.test(t)) return fail("claim", `claim the notes do not allow: ${c.label}`);
  const n = normHook(t);
  if (!n) return fail("length", "no words");
  if (rules.existing.has(n)) return fail("duplicate", "same as the original or a hook already in this channel");
  if (accepted.has(n)) return fail("duplicate", "same as another variant in this batch");
  accepted.add(n);
  return { ok: true };
}
