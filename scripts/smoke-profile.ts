/**
 * Creative Studio slice 1c smoke checks (called by scripts/smoke.ts): the business profile.
 *
 *  1. BYTE IDENTITY (only when private/ is present: it needs the original install's config and snapshot): the model-facing dump (scripts/profile-snapshot.ts: classify state + questions, describe prompts,
 *     hook state + questions on rubric v1 / v2 / v3, notes fingerprints, copy gate + page scorer requests, context_fp and
 *     versions, the moments / variants / ad copy prompts, copy rule verdicts, ad names, the campaign pick, the seeded
 *     notes and current rubric) rebuilt with the private profile is deep equal to `private/profile-snapshot.json`, which
 *     the same script wrote against the pre-refactor code (ced48b2). The one intended difference: a fresh DB now holds
 *     ONE rubric version (the profile's starter = v3's content), not the v1 / v2 / v3 history (`seedRubricRows`).
 *  2. NEUTRAL: the same dump on a made-up config with NO profile (neutral fixture words) carries none of the original
 *     install's business words in any string or state key the models read (the denylist check needs private/; the
 *     house rule checks always run).
 *  3. The profile schema: strict, terse path errors, merge rules, the rubric starter validated, fill / houseRulesFor.
 * FRESH temp DBs, FakeJev, a stub Graph: never the live DB, Jev, claude or the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { StudioConfig } from "../src/lib/config";
import type { StudioFile } from "../src/lib/studio-config";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

/** private/ (the original install's own data): present in this repo, absent in an exported copy. */
export const PRIVATE_DIR = path.join(process.cwd(), "private");
export const hasPrivate = () => fs.existsSync(path.join(PRIVATE_DIR, "studio.config.json"));

/**
 * Words the neutral built-ins must never carry: the original install's clients (names, people, codes), its people, its
 * businesses and its trade = the leak gate's own denylist (private/leak-denylist.txt, read by scripts/leak-grep.sh: one
 * regex per line, case-insensitive unless prefixed `c:`). Null when private/ is absent.
 */
export function privateDenylist(): RegExp[] | null {
  const file = path.join(PRIVATE_DIR, "leak-denylist.txt");
  if (!fs.existsSync(file)) return null;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() && !/^\s*#/.test(l))
    .map((l) => (l.startsWith("c:") ? new RegExp(l.slice(2)) : new RegExp(l, "i")));
}

/** A made-up Studio: two clients, no profile. */
export const NEUTRAL_STUDIO: StudioFile = {
  clients: [
    { code: "acme", name: "Acme Dental / Ann Lee", metaAdAccount: "act_111", hint: "Acme Dental: a family dental practice in Springfield.", folder: "Acme", campaigns: "state_json", leads: "ghl" },
    { code: "northwind", name: "Northwind Bikes", metaAdAccount: "act_222", hint: "Northwind Bikes: bike repairs and rentals by the lake." },
  ],
};

/** Every string (and every object key inside a model request: `state`, `questions`) of a dump, with its path. */
function strings(v: unknown, at: string, out: { at: string; text: string }[], keysToo = false): void {
  if (typeof v === "string") out.push({ at, text: v });
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${at}[${i}]`, out, keysToo));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const inModel = keysToo || k === "state" || k === "questions";
      if (keysToo) out.push({ at: `${at}{key}`, text: k });
      strings(x, `${at}.${k}`, out, inModel);
    }
  }
}

/**
 * Internal identifiers that keep their names by design (decision 2: the lane keys `rtm` / `fkbpros` / `fkb` stay, as do
 * the note keys built on them): a string that IS one of these is a key, not wording.
 */
const INTERNAL_IDS = /^(rtm|fkbpros|fkb|fkb_hint|whos_who|rubric:[a-z0-9_]+)$/;

/** Denylist hits in a dump (paths + the word). */
export function denylistHits(dump: unknown, deny: RegExp[]): { at: string; word: string; text: string }[] {
  const all: { at: string; text: string }[] = [];
  strings(dump, "", all);
  const hits: { at: string; word: string; text: string }[] = [];
  for (const s of all) {
    if (INTERNAL_IDS.test(s.text)) continue;
    for (const re of deny) {
      const m = re.exec(s.text);
      if (m) {
        hits.push({ at: s.at, word: m[0], text: s.text.slice(Math.max(0, m.index - 60), m.index + 60) });
        break;
      }
    }
  }
  return hits;
}

export async function runProfileSmoke({ cfg, tmp, ok }: Ctx) {
  const snap = await import("./profile-snapshot");
  const prof = await import("../src/lib/profile");
  const { parseStudioText, StudioConfigError } = await import("../src/lib/studio-config");

  // ---------------------------------------------------------------- 1. byte identity with the private profile
  if (!hasPrivate() || !fs.existsSync(snap.SNAPSHOT_FILE)) {
    ok("BYTE IDENTITY: skipped (private): the original install's profile and snapshot are not in this copy");
  } else {
    const { readStudioFile } = await import("../src/lib/config");
    const privStudio = readStudioFile(path.join(PRIVATE_DIR, "studio.config.json"));
    const saved = JSON.parse(fs.readFileSync(snap.SNAPSHOT_FILE, "utf8")) as { legacyRubric: Parameters<typeof snap.buildProfileDump>[0]["legacyRubric"]; dump: Record<string, unknown> };
    assert.ok(privStudio.profile, "the private config has a profile");
    const dump = JSON.parse(
      JSON.stringify(await snap.buildProfileDump({ studio: privStudio, tmp, legacyRubric: saved.legacyRubric, withProfile: prof.withProfile })),
    ) as Record<string, unknown>;
    const { seedRubricRows: rowsNow, ...now } = dump;
    const { seedRubricRows: rowsThen, ...then } = saved.dump;
    for (const key of Object.keys(then)) assert.deepEqual(now[key], then[key], `byte identity: ${key}`);
    assert.deepEqual(Object.keys(now).sort(), Object.keys(then).sort(), "the same dump sections");
    // The one intended difference: ONE starter version (v3's content, briefs and note) instead of the v1 / v2 / v3 history.
    const rows = rowsNow as { version: number; note: string; current: number; briefs: string | null }[];
    const v3 = (rowsThen as { version: number; note: string; briefs: string | null }[]).find((r) => r.version === 3)!;
    assert.deepEqual(
      rows.map((r) => [r.version, r.current, r.note, r.briefs]),
      [[1, 1, v3.note, v3.briefs]],
      "a fresh DB holds one current version: the profile's starter (v3's note and briefs)",
    );
    const counted = Object.keys(then).length;
    ok(
      `BYTE IDENTITY: ${counted} dump sections built with the private profile equal the pre-refactor snapshot (classify, describe, hooks on v1 / v2 / v3, notes fingerprints, copy gate, page scorer, moments / variants / ad copy prompts, copy rules, ad names, campaign pick, seeded notes + current rubric); a fresh DB holds one starter version`,
    );
  }

  // ---------------------------------------------------------------- 2. neutral: no business word reaches a model
  const neutralDump = await snap.buildProfileDump({ studio: NEUTRAL_STUDIO, tmp, legacyRubric: null, withProfile: prof.withProfile, fixtures: "neutral" });
  const deny = privateDenylist();
  if (deny) {
    const hits = denylistHits(neutralDump, deny);
    assert.deepEqual(hits, [], `no business word in the neutral dump:\n${hits.slice(0, 12).map((h) => `${h.at}: "${h.word}" in ...${h.text}...`).join("\n")}`);
    // The neutral built-ins themselves (every text a fresh Studio could send), not only what the fixtures reach.
    const builtIns = denylistHits(prof.NEUTRAL_PROFILE, deny);
    assert.deepEqual(builtIns, [], `no business word in NEUTRAL_PROFILE:\n${builtIns.map((h) => `${h.at}: ${h.word}`).join("\n")}`);
  } else {
    ok("NEUTRAL denylist check: skipped (private): the denylist names the original install's clients and is not in this copy");
  }
  // The neutral starter rubric passes the Rubric page's own checks (every lane and kind covered, mechanics, avatars).
  const { rubricContentSchema } = await import("../src/lib/hooks/rubric-edit");
  const starter = prof.NEUTRAL_PROFILE.rubric;
  const sv = rubricContentSchema(starter.mechanics, true).safeParse({ dimensions: starter.dimensions, mechanics: starter.mechanics, avatars: starter.avatars });
  assert.ok(sv.success, `the neutral starter rubric is valid: ${sv.success ? "" : sv.error.issues[0]?.message}`);
  // No house rule a stranger did not ask for: dashes allowed, US states allowed, client names not banned.
  const n = prof.resolveProfile(undefined);
  assert.deepEqual(Object.values(n.copyRules.dashes), ["allowed", "allowed", "allowed", "allowed", "allowed"]);
  assert.ok(!Object.values(n.copyRules.stateNames).some(Boolean) && !Object.values(n.copyRules.banClientNames).some(Boolean));
  const nd = neutralDump as { variantRules: Record<string, { verdicts: { ok: boolean; rule?: string }[] }> };
  assert.ok(
    Object.values(nd.variantRules).every((v) => v.verdicts.every((x) => x.ok || !["dash", "state", "name"].includes(x.rule ?? ""))),
    "the neutral profile refuses no dash, no state name and no client name",
  );
  ok("NEUTRAL: the same dump on a made-up config with no profile (and the neutral built-ins themselves) carries none of the original install's clients, people, businesses or trade words; the starter rubric passes the Rubric page checks; no dash / state / client name house rule");

  // ---------------------------------------------------------------- 3. the schema
  const parse = (profile: unknown) => parseStudioText(JSON.stringify({ profile }));
  assert.equal(parse({}).profile && Object.keys(parse({}).profile!).length, 0);
  const err = (profile: unknown) => {
    try {
      parse(profile);
      return null;
    } catch (e) {
      assert.ok(e instanceof StudioConfigError);
      return (e as Error).message;
    }
  };
  assert.equal(err({ clasify: {} }), 'profile: unknown key "clasify"', "strict: a typo is refused");
  assert.equal(err({ classify: { sections: { rtm: "two\nlines" } } }), "profile.classify.sections.rtm: one line");
  assert.equal(err({ copyRules: { dashes: { rtm: "some" } } }), "profile.copyRules.dashes.rtm: none | punctuation | allowed");
  assert.match(String(err({ rubric: { dimensions: [], mechanics: [], avatars: [] } })), /^profile\.rubric/, "the starter rubric is validated like a Rubric page save");
  const secret = "SECRET-VALUE-123";
  assert.ok(!String(err({ ads: { clientPrefix: secret + "!" } })).includes(secret), "errors never echo a value");
  const merged = prof.resolveProfile({ classify: { sections: { rtm: "Mine" } }, adCopy: { formatLines: ["one"] } });
  assert.equal(merged.classify.sections.rtm, "Mine");
  assert.equal(merged.classify.sections.fkb, prof.NEUTRAL_PROFILE.classify.sections.fkb, "objects merge key by key");
  assert.deepEqual(merged.adCopy.formatLines, ["one"], "lists replace whole");
  assert.equal(prof.fill("a {name} b {other}", { name: "X" }), "a X b {other}");
  assert.equal(await prof.withProfile(undefined, async () => prof.profile().owner.name), null, "withProfile: the neutral profile");
  assert.equal(prof.profile().owner.name, cfg.studio.profile?.owner?.name, "back to the config's profile");
  // Lane C's ad name pattern for a two-letter prefix: spacing and case free, the number right after it.
  const { companyNameRe } = await import("../src/lib/meta/new-ad");
  for (const [name, want] of [["MO Ad 12", 12], ["moad3", 3], ["Mo  Ad 7 copy", 7], ["Ad 4", null], ["Mo Ad x", null]] as const) {
    assert.equal(companyNameRe("Mo Ad").exec(name)?.[1] ? Number(companyNameRe("Mo Ad").exec(name)![1]) : null, /^mo\s*ad\s*(\d{1,4})\b/i.exec(name) ? Number(/^mo\s*ad\s*(\d{1,4})\b/i.exec(name)![1]) : null);
    assert.equal(companyNameRe("Mo Ad").exec(name) ? Number(companyNameRe("Mo Ad").exec(name)![1]) : null, want);
  }
  // The example profile at the repo root parses and names every top level key.
  const example = JSON.parse(fs.readFileSync(path.join(process.cwd(), "studio.config.example.json"), "utf8")) as { profile: Record<string, unknown> };
  parseStudioText(JSON.stringify(example));
  assert.deepEqual(Object.keys(example.profile).sort(), Object.keys(prof.NEUTRAL_PROFILE).sort(), "the example shows every profile key");
  ok("profile schema: strict (a typo refused), one-line texts, dash policies, the starter rubric validated, terse path errors that never echo a value; objects merge, lists replace; fill; withProfile; Lane C's ad name pattern; the example config parses and shows every key");
}
