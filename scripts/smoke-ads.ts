/**
 * Phase 6 slice 3 smoke checks (called by scripts/smoke.ts after smoke-shorts2.ts): new PAUSED Meta ads staged as order
 * files. The copy rules (every dash form, URL, emoji per field, "$", forbidden terms whole word, per-client bans, names,
 * SGD's lines, AI tells, counts, duplicates), the prefill from a fixture copy doc + ad map (headline vs primary 1, FORMAT
 * v3 primaries replacing Part C, angle lookup incl. a Meta hook through its ad's angle_key, the map fallback, concept and
 * ps|obj, the next number), the `ad_copy` job against a STUB claude (good, bad JSON, dashed lines dropped + one retry,
 * Cancel / Retry / recover, typed slots never overwritten), the order writer (only its two folders, name pattern, wx never
 * overwrites, refused folders: symlink / on the drive / inside a git tree, 64 KB, 0600, cancel only its own staged order
 * through temp + rename), the read-back (applied / failed / missing, junk refused, size cap), the media rules (100 MB
 * refused, 45 MB warned, drive unplugged) and that nothing in the path calls the network (fetch is a trap here).
 * A FRESH temp DB, temp folders and fixtures: never the real ~/Meta, never the real claude, no Jev.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { StudioConfig } from "../src/lib/config";
import { applyLegacyRubric } from "./smoke-legacy-rubric";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const NOW = Date.UTC(2026, 9, 1, 16, 0, 0);
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const COPY_DOC = `# HARBOR — Meta ad copy

# Part C — Angle blocks
## Angle \`coop-condo\` — ad 04 (pool \`all\`)
Headlines (H1 first):
- H1: Co-op Deck? They Handle the Board.
- H2: Board Approvals Are Their Problem
- H3: NYC Building Rules, Handled
Primaries:
- P1: Old Part C primary one, replaced by FORMAT v3.
- P2: Old Part C primary two, replaced by FORMAT v3.
Description: NYC co-op and condo experts.

## Angle \`fifteen-working-days\` — ad 01
- H1: A New Deck in Fifteen Working Days
- H2: Fifteen Working Days. In Writing.
- H3: Your Deck, Back on Schedule
- P1: Most deck renovations drag on for months. A matched local team finishes in fifteen working days. Tap below.
- P2: How long should a deck renovation take? Fifteen working days. Tap below.
Description: Free in-home consultation.

# FORMAT v3 PRIMARIES (approved)
## coop-condo
**P1 (structured):**
🛁 Free deck renovation consultation for Centerville and Northfield householders.

Dreading the board approval before your deck even starts?

✅ Board approvals and building rules, handled *(added 9/14, approved)*

👇 Tap below, get matched with a vetted local pro today.

**P2 (classic):**
Board approvals, building rules, insurance paperwork: handled every week. Free consultation. Tap below.

## Static slot 2026-09-27 (APPROVED)
### Angle \`static_coopboard\`: Co-op board, 4 things
**On image:** header text, not copy
**H1:** Co-op Deck? 4 Things the Board Wants
**H2:** Board Paperwork, Handled for You
**H3:** Centerville and Northfield Deck Renovation
**P1 (structured):**
📍 Centerville and Northfield co-op owners: deck renovation

Did your co-op board just hand you an alteration agreement?

👇 Tap Learn More to get matched, free

**P2 (structured):**
📍 Centerville and Northfield co-op and condo owners: deck renovation

✅ Free consultation, no pressure

👇 Tap Learn More to get matched, free

**D1:** Co-op paperwork, handled.

\`\`\`
- H1: inside a code fence, ignored
\`\`\`
`;

const HARBOR_NOTES = [
  "Sells deck renovations only.",
  "Claims not allowed: any price or product name, financing or monthly payments, one day completion.",
  "Never name The Harbor House, HHS, Hanna, Hana or Hoshi.",
  "Never say woman owned.",
].join("\n");

export async function runAdsSmoke({ cfg, tmp, ok }: Ctx) {
  const { openDb } = await import("../src/lib/db");
  const rules = await import("../src/lib/meta/ad-copy-rules");
  const adMap = await import("../src/lib/meta/ad-map");
  const newAd = await import("../src/lib/meta/new-ad");
  const orders = await import("../src/lib/meta/orders");
  const job = await import("../src/lib/meta/ad-copy-job");
  const { AdQueue, AD_INTERRUPTED } = await import("../src/worker/ads");
  const { pendingDirProblem, gitTreeOf } = await import("../src/lib/config");
  const claudeLib = await import("../src/lib/hooks/claude");

  // Nothing here may touch the network: Meta, GHL, Google, Jev, anything.
  const realFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error("network refused in the ads smoke");
  }) as typeof fetch;

  const db = openDb(path.join(tmp, "ads.db"), { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  applyLegacyRubric(db.sqlite); // the original install's rubric history (v1 / v2 / v3), slice 1c
  const s = db.sqlite;
  const base = path.join(tmp, "ads");
  const clientsDir = path.join(base, "meta-clients"); // stands in for META_ENV_FILE's folder
  const fpcDir = path.join(base, "fpc-clients"); // stands in for STUDIO_CLIENT_DOCS_DIR
  fs.mkdirSync(path.join(clientsDir, "harbor"), { recursive: true });
  fs.mkdirSync(path.join(fpcDir, "Hana"), { recursive: true });
  fs.mkdirSync(path.join(base, "meta"), { recursive: true });
  const docFile = path.join(fpcDir, "Hana", "HARBOR-ad-copy-final.md");
  fs.writeFileSync(docFile, COPY_DOC);
  const mapFile = path.join(clientsDir, "harbor", "video_script_map.json");
  fs.writeFileSync(
    mapFile,
    JSON.stringify({
      schema: 2,
      client: "harbor",
      landing_url: "https://www.sgdpros.example/harbor/",
      forbidden_terms: ["Harbor House", "Hana", "$"],
      angles: {
        "coop-condo-2": {
          headlines: ["Board Approval, Handled", "Deck Renovation, Board Ready", "Centerville and Northfield Deck Pros"],
          primaries: ["📍 Centerville and Northfield householders: deck renovation\n\n👇 Tap below", "Alteration agreements handled. Tap below."],
          description: "Board ready. Free consultation.",
        },
        "coop-condo": { headlines: ["Map headline"], primaries: ["Map primary"], description: null },
        "fifteen-working-days": { headlines: [], primaries: [], description: "Map description" },
      },
      ads: [
        { n: "11", ad_name: "SGC-harbor-coopboard_4things-obj-11", angle_key: "static_coopboard", stage: "obj" },
        { n: "12", ad_name: "SGC-harbor-coopboard_paperwork-obj-12", angle_key: "coop-condo-2", avatar_concept: "coopboard_paperwork", stage: "obj" },
        { n: "06", angle_key: "fifteen-working-days" },
      ],
    }),
  );
  const docSha = sha(docFile);
  const mapSha = sha(mapFile);
  const pendFpc = path.join(base, "meta-clients-pending");
  const pendFkb = path.join(base, "meta", "_pending");
  const tcfg: StudioConfig = { ...cfg, metaEnvFile: path.join(clientsDir, "agency.env"), clientDocsDir: fpcDir, pendingDirs: { fkbpros: pendFpc, fkb: pendFkb } };

  // ---------------------------------------------------------------- the copy rules (pure)
  const taraCtx = {
    section: "fkbpros" as const,
    code: "harbor",
    forbiddenTerms: ["Harbor House", "Hana"],
    client: { code: "harbor", name: "Hana / HHS Deck Systems", brandNotes: HARBOR_NOTES },
    allClients: [{ code: "harbor", name: "Hana / HHS Deck Systems", brandNotes: HARBOR_NOTES }],
    ownNotes: null,
    house: newAd.adHouseRules("fkbpros", "harbor"),
  };
  const R = rules.compileAdRules(taraCtx);
  const H = (t: string) => rules.checkAdLine(t, "headline", R).problems;
  const P = (t: string) => rules.checkAdLine(t, "primary", R).problems;
  const D = (t: string) => rules.checkAdLine(t, "description", R).problems;
  assert.match(H("Board Paperwork — Handled")[0], /dash "—"/, "em dash");
  assert.match(H("Board Paperwork – Handled")[0], /dash "–"/, "en dash");
  assert.match(H("Board Paperwork - Handled")[0], /hyphen used as punctuation/, '" - "');
  assert.match(H("Board Paperwork--Handled")[0], /hyphen used as punctuation/, '"--"');
  assert.match(P("Line one\n- a dash bullet")[0], /starting with "- "/, "a line-leading hyphen bullet");
  assert.deepEqual(H("Co-op Deck, Walk-in Shower"), [], "compounds are fine (check_text bans only spaced hyphens)");
  assert.match(P("See https://www.sgdpros.example now")[0], /URL/, "a URL in a primary");
  assert.match(P("Visit www.example.com")[0], /URL/, "www. in a primary");
  assert.deepEqual(H("Visit www.example.com"), [], "check_text bans URLs in primaries only");
  assert.match(H("🛁 Deck Day")[0], /emoji/, "no emoji in a headline");
  assert.match(D("Free consult ✅")[0], /emoji/, "no emoji in the description");
  assert.deepEqual(P("🛁 Centerville householders: deck renovation\n\n✅ Handled\n\n⭐ Rated\n\n📍 Northfield\n\n📅 Days\n\n👇 Tap\n\n🏠 Home"), [], "the whole palette in a primary");
  assert.match(P("Great deck 🔥")[0], /not in the palette/, "an off-palette emoji in a primary");
  assert.match(P("✔ Checked")[0], /not in the palette/, "✔ is not ✅");
  assert.match(H("Decks by Hana")[0], /Forbidden term "Hana"/, "the map's forbidden term, whole word");
  assert.match(H("decks by HANA today")[0], /Forbidden term "Hana"/, "case-insensitive");
  assert.deepEqual(H("Tarantula Proof Decks").filter((p) => p.includes("Forbidden")), [], "whole word only");
  assert.ok(H("The Harbor House Deck").some((p) => /Names the installer/.test(p)), "connector voice: never the installer's name");
  assert.match(P("Decks from $9,000 installed.")[0], /price/, "harbor: no price");
  assert.ok(P("Easy financing available.").some((p) => /Financing/.test(p)), "harbor: no financing");
  assert.ok(P("Only $99 per month.").some((p) => /Financing/.test(p)), "monthly payments");
  assert.ok(P("We are woman owned.").some((p) => /never to say "woman owned"/.test(p)), "the notes' Never say line");
  assert.ok(H("Unlock Your Dream Deck").some((p) => /AI tell "unlock"/.test(p)), "AI tells");
  assert.ok(H("x".repeat(256)).some((p) => /at most 255/.test(p)), "headline hard max");
  assert.ok(rules.checkAdLine("A".repeat(41), "headline", R).warnings.some((w) => /40 or fewer/.test(w)), "headline warn over 40");
  assert.ok(rules.checkAdLine("D".repeat(31), "description", R).warnings.some((w) => /30 or fewer/.test(w)), "description warn over 30");
  assert.ok(rules.checkAdLine(`${"F".repeat(126)}\n\nsecond`, "primary", R).warnings.some((w) => /fold/.test(w)), "fold warning on a structured primary");
  // Per-client bans from the brief's list, without any notes: fairway price, delta financing.
  const bare = (code: string) =>
    rules.compileAdRules({ section: "fkbpros", code, forbiddenTerms: [], client: { code, name: code, brandNotes: null }, allClients: [], ownNotes: null, house: newAd.adHouseRules("fkbpros", code) });
  assert.ok(rules.checkAdLine("Gardens from $20,000", "primary", bare("fairway")).problems.some((p) => /price/.test(p)), "fairway: no price");
  assert.deepEqual(rules.checkAdLine("Easy financing", "primary", bare("fairway")).problems, [], "fairway: financing is not banned by the list");
  assert.ok(rules.checkAdLine("Easy financing", "primary", bare("delta")).problems.some((p) => /Financing/.test(p)), "delta: no financing");
  // "$" in both headlines and primaries (creative.py's price token rule) for a client without a price ban.
  const dom = bare("acme");
  const set = (h: string[], p: string[], d: string) => rules.checkAdCopy(rules.cleanAdCopy({ headlines: h, primaries: p, description: d }), dom);
  assert.ok(set(["Save $500 Today", "Two", "Three"], ["From $500 off.\n\nTap", "Plain"], "Desc").set.some((x) => /"\$"/.test(x)), '"$" in headlines AND primaries');
  assert.ok(set(["Save $500 Today", "Two", "Three"], ["Plain one", "Plain two"], "Desc").ok, '"$" in one field only passes');
  // Counts, duplicates, the description.
  assert.ok(set(["One", "Two"], ["P1", "P2"], "Desc").set.some((x) => /3 to 5 headlines/.test(x)), "2 headlines refused");
  assert.ok(set(["1", "2", "3", "4", "5", "6"], ["P1", "P2"], "Desc").set.some((x) => /3 to 5 headlines/.test(x)), "6 headlines refused");
  assert.ok(set(["One", "Two", "Three"], ["P1"], "Desc").set.some((x) => /2 to 3 primaries/.test(x)), "1 primary refused");
  assert.ok(set(["One", "Two", "Three"], ["P1", "P2", "P3", "P4"], "Desc").set.some((x) => /2 to 3 primaries/.test(x)), "4 primaries refused");
  assert.ok(set(["One", "Two", "Three"], ["P1", "P2"], "").description.problems.includes("Empty"), "exactly one description");
  assert.ok(set(["One", "Two", "one"], ["P1", "P2"], "Desc").headlines[2].problems.some((p) => /Same as headline 1/.test(p)), "duplicate headline");
  // SGD: its notes' claims (financing, dollar prices), never an SGD Pros client's name; its own name is fine.
  const fkbR = rules.compileAdRules({
    section: "fkb",
    code: "fkb",
    forbiddenTerms: [],
    client: null,
    allClients: [{ code: "harbor", name: "Hana / HHS Deck Systems", brandNotes: HARBOR_NOTES }],
    ownNotes: "Claims not allowed: 10+ years (use 8+), dollar prices or price ranges, financing or payment plans.\nNever say hundreds of gardens.",
    house: newAd.adHouseRules("fkb", "fkb"),
  });
  assert.ok(rules.checkAdLine("Gardens from $30,000", "primary", fkbR).problems.some((p) => /price/.test(p)), "SGD: no dollar price");
  assert.ok(rules.checkAdLine("Payment plans available", "primary", fkbR).problems.some((p) => /Financing/.test(p)), "SGD: no financing");
  assert.ok(rules.checkAdLine("We did hundreds of gardens", "primary", fkbR).problems.some((p) => /never to say/.test(p)), "SGD: its Never say line");
  assert.ok(rules.checkAdLine("As seen with Hana", "headline", fkbR).problems.some((p) => /Names an SGD Pros client/.test(p)), "SGD never names a client");
  assert.deepEqual(rules.checkAdLine("Summit Gardens and Decks, 8+ Years", "headline", fkbR).problems, [], "SGD's own name is fine");
  assert.equal(rules.wholeWordRe("$").test("only $5"), false, "Python \\b semantics: a non-word term needs a word character beside it");
  assert.deepEqual(rules.cleanAdCopy({ headlines: [" One \n"], primaries: ["a  \r\nb\r\n\r\n"], description: "x\ny" }), { headlines: ["One"], primaries: ["a\nb"], description: "x y" });
  // Gate fixes (rules v2): the concept slug never carries "-" (the ad name is hyphen-delimited); SGD's fixed bans are
  // financing only (a price ban comes from its notes, as above).
  assert.equal(rules.AD_RULES_VERSION, 2, "rules v2 (the apply scripts mirror it)");
  assert.match(String(rules.conceptProblem("dated-doors", newAd.adNaming())), /Lowercase letters, digits and _ only/, "a concept with - refused");
  assert.equal(rules.conceptProblem("dated__doors", newAd.adNaming()) != null && rules.conceptProblem("dated_doors", newAd.adNaming()) == null, true, "single _ only");
  // Slice 1c: the fixed bans moved from code into the business profile (copyRules.bans); the original install keeps them.
  assert.deepEqual(newAd.adHouseRules("fkb", "fkb").bans, ["financing"], "SGD: financing is the fixed ban");
  const fkbBare = rules.compileAdRules({ section: "fkb", code: "fkb", forbiddenTerms: [], client: null, allClients: [], ownNotes: "Never say hundreds of gardens.", house: newAd.adHouseRules("fkb", "fkb") });
  assert.deepEqual(rules.checkAdLine("Gardens from 30 thousand dollars", "primary", fkbBare).problems, [], "SGD without a price line in its notes: no price ban");
  assert.ok(rules.checkAdLine("Easy financing", "primary", fkbBare).problems.some((p) => /Financing/.test(p)), "SGD: financing still banned");
  ok("ad copy rules v2 (gate fix): concept slug letters, digits and single _ only (no -), SGD's fixed ban financing only (price only from its notes' Claims line)");
  ok("ad copy rules (mirroring creative.py check_text): em / en dash, \" - \", \"--\", line-leading \"- \", URL in primaries, emoji by field + the palette, \"$\" (per-client price bans, both-fields rule), the map's forbidden terms whole word, connector voice names, financing, Never say lines, SGD's own lines, AI tells, 255 / 40 / 30 / fold, counts 3..5 / 2..3 / 1, duplicates");

  // ---------------------------------------------------------------- fixtures in the DB
  const sec = (k: string) => s.prepare("select id from sections where key = ?").pluck().get(k) as number;
  const FKBP = sec("fkbpros");
  const SGD = sec("fkb");
  const NSM = sec("rtm");
  const cid = (code: string) => s.prepare("select id from clients where code = ?").pluck().get(code) as number;
  const HARBOR = cid("harbor");
  s.prepare("update clients set brand_notes = ? where id = ?").run(HARBOR_NOTES, HARBOR);
  s.prepare("insert into notes (key, body, saved_at, updated_at) values ('fkb', ?, 1, 1) on conflict(key) do update set body = excluded.body").run(
    "Claims not allowed: dollar prices or price ranges, financing or payment plans.",
  );
  const accHarbor = s.prepare("select id from ad_accounts where client_id = ?").pluck().get(HARBOR) as number;
  const accFkb = s.prepare("select id from ad_accounts where client_id is null").pluck().get() as number;
  assert.ok(accHarbor && accFkb, "seed v7 ad accounts");
  const insAd = s.prepare(
    `insert into ads (meta_ad_id, account_id, name, adset_name, campaign_name, effective_status, created_time, creative, angle_key, first_seen_at, last_synced_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  );
  const vid = JSON.stringify({ isVideo: true, headlines: ["Old"], primaries: ["Old primary"], descriptions: [], ctas: [], videoIds: ["v"], imageHashes: [], id: null, link: null });
  const img = JSON.stringify({ isVideo: false, headlines: ["Static"], primaries: ["Static primary"], descriptions: [], ctas: [], videoIds: [], imageHashes: ["h"], id: null, link: null });
  insAd.run("900001", accHarbor, "SGC-harbor-coopboard_paperwork-obj-14", "SGC-HarborHouse-Testing", "SGC", "ACTIVE", 1, vid, "static_coopboard");
  insAd.run("900002", accHarbor, "SGC-harbor-coopboard_4things-obj-11", "SGC-HarborHouse-Testing", "SGC", "ACTIVE", 1, img, "static_coopboard");
  insAd.run("900003", accHarbor, "SGC-HarborHouse-ManhattanBronx-Deck-Ad-04", "SGC-HarborHouse-Winners", "SGC", "ACTIVE", 1, vid, "coop-condo");
  insAd.run("900004", accHarbor, "SGC-HarborHouse-ManhattanBronx-Deck-Ad-03", "SGC-HarborHouse-Testing", "SGC", "PAUSED", 1, vid, null);
  insAd.run("900101", accFkb, "Mo Ad 12", "9.29.26 NEW Combo Set", "7.6.26 K&B ABO", "ACTIVE", 1, vid, null);
  insAd.run("900102", accFkb, "Mo Ad 5 - Copy", "9.10.26 Ry Set 2", "7.6.26 K&B ABO", "ADSET_PAUSED", 1, vid, null);
  s.prepare("insert into ad_metrics (meta_ad_id, date, account_id, ad_name, synced_at) values ('900199', '2026-09-01', ?, 'MO Ad 13 - NT', 1)").run(accFkb);

  const rootDir = path.join(base, "root");
  fs.mkdirSync(rootDir, { recursive: true });
  const driveDir = path.join(cfg.drivePath, "ads-on-drive");
  fs.mkdirSync(driveDir, { recursive: true });
  const root = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(rootDir, FKBP).lastInsertRowid);
  const fkbRoot = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(path.join(rootDir, "fkb"), SGD).lastInsertRowid);
  const driveRoot = Number(s.prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, 1)").run(driveDir, FKBP).lastInsertRowid);
  fs.mkdirSync(path.join(rootDir, "fkb"), { recursive: true });
  const file = (dir: string, name: string, size: number) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, "x");
    fs.truncateSync(f, size); // sparse: the size counts, nothing is written
    return f;
  };
  const insAsset = s.prepare(
    `insert into assets (section_id, root_id, path, rel_path, filename, ext, kind, bytes, mtime, indexed_at, derive_status, sha256, thumb_path)
     values (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'done', ?, 'x/thumb.webp')`,
  );
  const asset = (section: number, rootId: number, dir: string, name: string, kind: string, size: number, tag: number | null) => {
    const f = file(dir, name, size);
    const id = Number(insAsset.run(section, rootId, f, name, name, path.extname(name).slice(1), kind, size, `fp-${name}`).lastInsertRowid);
    if (tag) s.prepare("insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'folder', 1)").run(id, tag);
    return id;
  };
  const MB = 1024 * 1024;
  const clip = asset(FKBP, root, rootDir, "harbor-clip.mp4", "video", 30 * MB, HARBOR);
  const big = asset(FKBP, root, rootDir, "harbor-big.mov", "video", 101 * MB, HARBOR);
  const mid = asset(FKBP, root, rootDir, "harbor-mid.mp4", "video", 46 * MB, HARBOR);
  const still = asset(FKBP, root, rootDir, "harbor-still.png", "image", 2 * MB, HARBOR);
  const webp = asset(FKBP, root, rootDir, "harbor-still.webp", "image", 2 * MB, HARBOR);
  const shared = asset(FKBP, root, rootDir, "shared-clip.mp4", "video", 20 * MB, null);
  const domOnly = asset(FKBP, root, rootDir, "dom-clip.mp4", "video", 20 * MB, cid("acme"));
  const onDrive = asset(FKBP, driveRoot, driveDir, "drive-clip.mp4", "video", 20 * MB, HARBOR);
  const fkbClip = asset(SGD, fkbRoot, path.join(rootDir, "fkb"), "Ad13.mov", "video", 25 * MB, null);

  const insHook = s.prepare("insert into hooks (section_id, client_id, kind, text, norm, source, angle_slug, created_at) values (?, ?, 'text', ?, ?, ?, ?, 1)");
  const hook = (section: number, client: number | null, text: string, source: string, angle: string | null) =>
    Number(insHook.run(section, client, text, text.toLowerCase(), source, angle).lastInsertRowid);
  const hShort = hook(FKBP, HARBOR, "Co-op Board? We Handle It", "copy_doc", "coop-condo");
  const hLong = hook(FKBP, HARBOR, "Tired of deck renovations that drag on for months and months?", "copy_doc", "fifteen-working-days");
  const hMeta = hook(FKBP, HARBOR, "Board Paperwork, Handled", "meta", null);
  s.prepare("insert into hook_ads (hook_id, meta_ad_id, role, created_at) values (?, '900001', 'headline', 1)").run(hMeta);
  const hMapOnly = hook(FKBP, HARBOR, "Board Approval, Handled Fast", "variant", "coop-condo-2");
  const hNone = hook(FKBP, HARBOR, "Your Deck, Finally", "manual", null);
  const hShared = hook(FKBP, null, "A Vetted Local Deck Pro", "manual", null);
  const hRtm = hook(NSM, null, "Your ads are probably not the problem", "manual", null);
  const hFkb = hook(SGD, null, "Dream Gardens Start Here", "meta", null);

  // ---------------------------------------------------------------- copy doc blocks + prefill
  const blocks = adMap.readCopyDocBlocks(fpcDir, "Hana"); // the client's folder (clients.folder, Creative Studio 1b)
  assert.deepEqual([...blocks.keys()].sort(), ["coop-condo", "fifteen-working-days", "static_coopboard"], "angle blocks (Part C, FORMAT v3, static slot); a code fence is ignored");
  const coop = blocks.get("coop-condo")!;
  assert.deepEqual(coop.headlines, ["Co-op Deck? They Handle the Board.", "Board Approvals Are Their Problem", "NYC Building Rules, Handled"]);
  assert.equal(coop.primaries.length, 2);
  assert.equal(
    coop.primaries[0],
    "🛁 Free deck renovation consultation for Centerville and Northfield householders.\n\nDreading the board approval before your deck even starts?\n\n✅ Board approvals and building rules, handled\n\n👇 Tap below, get matched with a vetted local pro today.",
    "FORMAT v3 replaced Part C's primaries; emoji, double spacing kept, the *(note)* dropped",
  );
  assert.equal(coop.description, "NYC co-op and condo experts.", "Part C's description kept (v3 carries none)");
  assert.deepEqual(blocks.get("static_coopboard")!.headlines.length, 3);
  assert.equal(blocks.get("static_coopboard")!.description, "Co-op paperwork, handled.", "**D1:** in a static block");

  const pre = (q: Parameters<typeof newAd.newAdPrefill>[2]) => newAd.newAdPrefill(s, tcfg, q);
  const p1 = pre({ hookId: hShort });
  assert.equal(p1.channel?.code, "harbor", "the hook's client is the channel");
  assert.equal(p1.copySource, "doc");
  assert.deepEqual(p1.copy.headlines, ["Co-op Board? We Handle It", "Co-op Deck? They Handle the Board.", "Board Approvals Are Their Problem"], "a short hook = headline 1, the block's follow (3 in all)");
  assert.equal(p1.copy.primaries[0], coop.primaries[0], "primaries from the block");
  assert.equal(p1.copy.description, "NYC co-op and condo experts.");
  assert.equal(p1.hookInPrimary, false);
  const p2 = pre({ hookId: hLong });
  assert.equal(p2.hookInPrimary, true, "over 40 characters: primary 1's opening line");
  assert.deepEqual(p2.copy.headlines, ["A New Deck in Fifteen Working Days", "Fifteen Working Days. In Writing.", "Your Deck, Back on Schedule"]);
  assert.equal(p2.copy.primaries[0], "Tired of deck renovations that drag on for months and months? A matched local team finishes in fifteen working days. Tap below.", "a classic primary: the hook replaces its first sentence");
  assert.equal(p2.copy.description, "Free in-home consultation.");
  assert.deepEqual(newAd.prefillCopy("Tired of deck renovations that drag on for months and months?", coop).copy.primaries[0].split("\n\n")[0], "Tired of deck renovations that drag on for months and months?", "a structured primary: the hook replaces its first line");
  assert.equal(newAd.prefillCopy("Tired of deck renovations that drag on for months and months?", coop).copy.primaries[0].split("\n\n")[1], "Dreading the board approval before your deck even starts?");
  const p3 = pre({ hookId: hMeta });
  assert.equal(p3.angle, "static_coopboard", "a Meta hook without an angle slug takes its ad's angle_key");
  assert.equal(p3.copySource, "doc");
  assert.deepEqual([p3.concept, p3.psObj], ["coopboard_4things", "obj"], "concept + ps|obj from the map's newest named ad on the angle");
  const p4 = pre({ hookId: hMapOnly });
  assert.equal(p4.copySource, "map", "an angle only the ad map has: its block");
  assert.equal(p4.copy.description, "Board ready. Free consultation.");
  assert.deepEqual([p4.concept, p4.psObj], ["coopboard_paperwork", "obj"]);
  const p5 = pre({ hookId: hNone });
  assert.deepEqual([p5.copySource, p5.copy.headlines, p5.copy.primaries, p5.copy.description, p5.concept], [null, ["Your Deck, Finally"], [], "", ""], "no angle: only the hook's slot (Draft the rest)");
  assert.equal(pre({ hookId: hShared }).channel, null, "a shared SGD Pros hook: pick the client");
  assert.equal(pre({ hookId: hShared, channel: "harbor" }).channel?.code, "harbor");
  assert.match(pre({ hookId: hRtm }).error ?? "", /NSM hooks never/, "NSM hooks never become ads");
  assert.match(pre({ hookId: hShort, channel: "acme" }).error ?? "", /another channel/);
  const pF = pre({ hookId: hFkb });
  assert.deepEqual([pF.channel?.code, pF.copySource, pF.copy.headlines, pF.channel?.landing], ["fkb", null, ["Dream Gardens Start Here"], "https://summitgardens.example/"], "SGD: no copy doc, its landing");
  assert.equal(pre({ adId: "900003" }).channel?.code, "harbor", "a Winner card's ad: its channel");
  assert.equal(pre({ adId: "900003", hookId: hShort }).angle, "coop-condo");
  assert.equal(pre({ assetId: clip }).channel?.code, "harbor", "a file tagged to one client: that client");
  assert.equal(pre({ assetId: shared }).channel, null, "a shared file: pick");
  assert.equal(pre({ assetId: fkbClip }).channel?.code, "fkb");
  // Next number + name preview.
  assert.equal(p1.nextN, 15, "SGC: one past the map's n (12) and the synced ad numbers (14)");
  assert.equal(p3.namePreview, "SGC-harbor-coopboard_4things-obj-15");
  assert.equal(pF.nextN, 14, "SGD: one past every Mo Ad number (12 synced, 13 in the daily metrics)");
  assert.equal(pF.namePreview, "Mo Ad 14");
  // Context lines.
  assert.match(p1.context.lines[0], /"SGC-HarborHouse-Testing": 2 of 4 seats used \(1 video of 3, 1 static of 1\)/, "Testing seats from the synced ads (a PAUSED ad takes none)");
  assert.match(p1.context.lines[1], /PAUSED and takes no seat: it goes live only into an open seat, in an apply session \(sgc-sweep-apply, studio order mode\)/, "the open seat line names the profile's apply skill");
  assert.ok(!p1.context.warnings.some((w) => /No open Testing seat/.test(w)), "2 of 4: a seat is open");
  assert.match(pF.context.lines[0], /Active ad set: "9.29.26 NEW Combo Set" \(campaign 7.6.26 K&B ABO\)/, "SGD: the one active ad set");
  s.prepare("update ads set effective_status = 'ACTIVE', adset_name = 'Other Set' where meta_ad_id = '900102'").run();
  assert.match(newAd.adContext(s, newAd.adChannel(s, "fkb")!).warnings[0], /the apply skill will stop, SGD needs exactly one active ad set/, "SGD: two active ad sets = a warning");
  s.prepare("update ads set effective_status = 'ADSET_PAUSED', adset_name = '9.10.26 Ry Set 2' where meta_ad_id = '900102'").run();
  assert.deepEqual([sha(docFile), sha(mapFile)], [docSha, mapSha], "the copy doc and the ad map are never written");
  ok("prefill: copy doc angle blocks (FORMAT v3 primaries replace Part C, static slot, notes stripped) + the ad map's block as the fallback, hook = headline 1 up to 40 characters else primary 1's opening line, a Meta hook's angle through its ad, concept + ps|obj from the map, next number SGC (map n, synced names) / SGD (Mo Ad N), Testing seats (4 = 3 video + 1 static, the open seat line) and SGD's one active ad set; NSM and other channels' hooks refused; neither file written");

  // ---------------------------------------------------------------- media rules
  const ch = newAd.adChannel(s, "harbor")!;
  const m = (id: number, channel = ch) => newAd.checkAdMedia(s, tcfg, channel, id);
  const okClip = m(clip);
  assert.ok(okClip.ok && okClip.path === fs.realpathSync(path.join(rootDir, "harbor-clip.mp4")) && okClip.bytes === 30 * MB && okClip.fingerprint === "fp-harbor-clip.mp4", "the original's real path (originalFileFor), size, fingerprint");
  assert.ok(okClip.ok && okClip.warnings.length === 0);
  const bigR = m(big);
  assert.ok(!bigR.ok && /Meta upload breaks above ~100 MB, export a smaller file/.test(bigR.error), "over 100 MB refused");
  const midR = m(mid);
  assert.ok(midR.ok && /22 to 45 MB/.test(midR.warnings[0]), "over 45 MB warned");
  assert.ok(m(still).ok, "a PNG");
  assert.ok(!(m(webp) as { ok: false; error: string }).ok && /JPG or PNG/.test((m(webp) as { error: string }).error), "WEBP refused");
  assert.ok(m(shared).ok, "a shared SGD Pros file is in every client's channel");
  assert.ok(!m(domOnly).ok, "another client's file refused");
  const driveR = m(onDrive);
  assert.ok(!driveR.ok && /is not mounted/.test(driveR.error), "the drive unplugged: the standard message");
  assert.ok(!m(fkbClip).ok && m(fkbClip, newAd.adChannel(s, "fkb")!).ok, "SGD files only in SGD");
  s.prepare("update assets set missing = 1 where id = ?").run(mid);
  assert.ok(!m(mid).ok, "a missing file refused");
  s.prepare("update assets set missing = 0 where id = ?").run(mid);
  ok("media: a visible video / image of the channel (a client's own or a shared file; SGD's for SGD) through originalFileFor (real path), over 100 MB refused with the export line, over 45 MB warned, MP4 / MOV / JPG / PNG only, the drive unplugged = the standard message");

  // ---------------------------------------------------------------- the order writer
  assert.equal(pendingDirProblem("relative/_pending", cfg.drivePath), "must be an absolute path.");
  assert.match(pendingDirProblem(path.join(cfg.drivePath, "_pending"), cfg.drivePath) ?? "", /media drive/, "never on the drive");
  assert.match(pendingDirProblem(path.join(process.cwd(), "tmp-pending"), cfg.drivePath) ?? "", /git working tree/, "never inside the repo");
  assert.equal(gitTreeOf(pendFpc), null);
  assert.equal(pendingDirProblem("/", cfg.drivePath), "must not be /.");
  const body = { kind: "studio_ad", schema: 1, status: "staged", studio_order_id: "abc123def456" };
  assert.throws(() => orders.writeOrderFile(tcfg, "fkbpros", "PENDING-2026-10-01.json", body), /Not an order file name/, "only STUDIO-<date>-<code>-<id>.json");
  assert.throws(() => orders.writeOrderFile(tcfg, "fkbpros", "STUDIO-2026-10-01-harbor-abc12.json", body), /Not an order file name/, "short id at least 6");
  assert.throws(() => orders.writeOrderFile(tcfg, "fkbpros", "../STUDIO-2026-10-01-harbor-abc123.json", body), /Not an order file name/);
  assert.throws(() => orders.writeOrderFile(tcfg, "fkbpros", "STUDIO-2026-10-01-harbor-abc123.json", { pad: "x".repeat(70_000) }), /64 KB/, "64 KB cap");
  assert.ok(orders.ORDER_NAME.test("STUDIO-2026-10-01-harbor2-abc123.json"), "a client code with digits names an order file");
  const w1 = orders.writeOrderFile(tcfg, "fkbpros", "STUDIO-2026-10-01-harbor-abc123.json", body);
  assert.equal(w1, path.join(fs.realpathSync(pendFpc), "STUDIO-2026-10-01-harbor-abc123.json"));
  assert.equal(fs.statSync(w1).mode & 0o777, 0o600, "0600");
  assert.equal(fs.statSync(pendFpc).mode & 0o777, 0o700, "the folder created 0700");
  fs.writeFileSync(w1, JSON.stringify({ ...body, status: "applied" }));
  assert.throws(() => orders.writeOrderFile(tcfg, "fkbpros", "STUDIO-2026-10-01-harbor-abc123.json", body), /never overwritten/, "wx: an existing file is never overwritten");
  assert.equal(JSON.parse(fs.readFileSync(w1, "utf8")).status, "applied", "the existing file untouched");
  const linkTarget = path.join(base, "elsewhere");
  fs.mkdirSync(linkTarget);
  const linkCfg = { ...tcfg, pendingDirs: { fkbpros: path.join(base, "linked-pending"), fkb: pendFkb } };
  fs.symlinkSync(linkTarget, linkCfg.pendingDirs.fkbpros);
  assert.throws(() => orders.writeOrderFile(linkCfg, "fkbpros", "STUDIO-2026-10-01-harbor-abc124.json", body), /not a plain folder/, "a symlinked folder refused");
  assert.deepEqual(fs.readdirSync(linkTarget), [], "nothing written through the symlink");
  const driveCfg = { ...tcfg, pendingDirs: { fkbpros: path.join(cfg.drivePath, "_pending"), fkb: pendFkb } };
  assert.throws(() => orders.writeOrderFile(driveCfg, "fkbpros", "STUDIO-2026-10-01-harbor-abc125.json", body), /media drive/, "a folder on the drive refused");
  const noParent = { ...tcfg, pendingDirs: { fkbpros: pendFpc, fkb: path.join(base, "no-such-parent", "_pending") } };
  assert.throws(() => orders.writeOrderFile(noParent, "fkb", "STUDIO-2026-10-01-fkb-abc126.json", body), /parent folder must exist/, "only the folder itself is created");
  fs.rmSync(w1);
  ok("order writer: the two configured folders only (absolute, never /, never on the drive, never in a git tree, never a symlink; the folder itself created 0700, never its parents), STUDIO-<date>-<code>-<id>.json only, JSON <= 64 KB, wx + 0600, an existing file never overwritten");

  // ---------------------------------------------------------------- Stage end to end
  const goodCopy = {
    headlines: ["Co-op Board? We Handle It", "Board Approvals, Handled", "Centerville and Northfield Deck Pros"],
    primaries: [
      "🛁 Centerville and Northfield householders: a free deck renovation consultation.\n\nDreading the co-op board?\n\n✅ Board paperwork handled\n\n👇 Tap below to get matched.",
      "Board approvals and building rules handled every week. Free consultation. Tap below.",
    ],
    description: "Board ready. Free consultation.",
  };
  const stage = (over: Partial<Parameters<typeof orders.stageOrder>[2]> = {}) =>
    orders.stageOrder(
      s,
      tcfg,
      {
        channel: "harbor",
        assetId: clip,
        copy: goodCopy,
        angleKey: "coop-condo",
        concept: "coopboard_handled",
        psObj: "obj",
        hookIds: [hShort],
        source: { from: "hook", ref: String(hShort) },
        notes: "First Studio order",
        ...over,
      },
      NOW,
    );
  assert.throws(() => stage({ copy: { ...goodCopy, headlines: ["Co-op Board — We Handle It", "Two", "Three"] } }), /fails a check: Headline 1: A dash/, "a failing check blocks Stage");
  assert.throws(() => stage({ assetId: big }), /100 MB/, "the media rule blocks Stage");
  assert.throws(() => stage({ concept: "Coop Board" }), /Lowercase/, "the concept slug");
  assert.throws(() => stage({ psObj: null }), /ps or obj/);
  assert.throws(() => stage({ hookIds: [hRtm] }), /another channel/, "a hook of another channel");
  assert.throws(() => stage({ channel: "rtm" }), /Pick a client or SGD/, "never NSM");
  assert.equal(s.prepare("select count(*) from ad_orders").pluck().get(), 0, "no row for a refused Stage");
  assert.equal(fs.readdirSync(pendFpc).length, 0, "and no file");
  const st = stage();
  const order = JSON.parse(fs.readFileSync(st.path, "utf8"));
  assert.match(path.basename(st.path), /^STUDIO-2026-10-01-harbor-[a-f0-9]{12}\.json$/, "STUDIO-<New York day>-<code>-<id>.json");
  assert.deepEqual(Object.keys(order), [
    "kind", "schema", "status", "studio_order_id", "created_at", "channel", "act", "media", "angle_key", "concept", "ps_obj", "name_preview",
    "headlines", "primaries", "description", "cta", "landing", "hook_ids", "source", "checks", "notes",
  ], "the documented order shape");
  assert.deepEqual(
    [order.kind, order.schema, order.status, order.channel, order.act, order.cta, order.landing, order.concept, order.ps_obj, order.name_preview, order.hook_ids, order.source, order.checks],
    ["studio_ad", 1, "staged", { section: "fkbpros", code: "harbor" }, "act_100000000000008", "LEARN_MORE", "https://www.sgdpros.example/harbor/", "coopboard_handled", "obj", "SGC-harbor-coopboard_handled-obj-15", [hShort], { from: "hook", ref: String(hShort) }, { passed: true, rules_version: rules.AD_RULES_VERSION }],
  );
  assert.deepEqual(order.media, { kind: "video", path: fs.realpathSync(path.join(rootDir, "harbor-clip.mp4")), file_name: "harbor-clip.mp4", bytes: 30 * MB, fingerprint: "fp-harbor-clip.mp4" });
  assert.equal(order.created_at, new Date(NOW).toISOString());
  const row = s.prepare("select * from ad_orders where id = ?").get(st.id) as Record<string, unknown>;
  assert.deepEqual([row.status, row.studio_order_id, row.file_path, row.channel_code, row.name_preview, JSON.parse(row.body as string).studio_order_id], ["staged", order.studio_order_id, st.path, "harbor", "SGC-harbor-coopboard_handled-obj-15", order.studio_order_id]);
  assert.equal(newAd.nextAdNumber(s, tcfg, ch), 16, "a staged order counts for the next number");
  const stF = orders.stageOrder(
    s,
    tcfg,
    {
      channel: "fkb",
      assetId: fkbClip,
      copy: {
        headlines: ["Dream Gardens Start Here", "One Team, Design to Build", "Your Garden, Done Right"],
        primaries: ["🏠 Eastby County householders: a free garden walkthrough.\n\n✅ One team from design through construction\n\n👇 Tap below to book it.", "One team, one plan, no juggling installers. Book a free walkthrough."],
        description: "Free walkthrough.",
      },
      angleKey: null,
      concept: "ignored",
      psObj: "ps",
      hookIds: [hFkb],
      source: { from: "winner", ref: "900101" },
      notes: null,
    },
    NOW,
  );
  const fo = JSON.parse(fs.readFileSync(stF.path, "utf8"));
  assert.equal(path.dirname(stF.path), fs.realpathSync(pendFkb), "SGD orders go to the SGD folder (created 0700)");
  assert.deepEqual([fo.channel, fo.act, fo.concept, fo.ps_obj, fo.name_preview, fo.landing], [{ section: "fkb", code: "fkb" }, "act_100000000000009", null, null, "Mo Ad 14", "https://summitgardens.example/"]);
  assert.equal(fs.statSync(pendFkb).mode & 0o777, 0o700);
  ok("Stage: every check again on the server (copy, media, concept, ps|obj, hooks of the channel, never NSM), then ONE new order file in the channel's folder + its ad_orders row (none when refused); the order shape exactly as documented (kind, schema 1, staged, act, media real path / bytes / fingerprint, LEARN_MORE, landing, name preview, checks)");

  // ---------------------------------------------------------------- read-back + cancel
  const sync = () => orders.syncOrders(s, tcfg, NOW + 1000);
  const rowOf = (id: number) => s.prepare("select status, ad_id, ad_name, applied_at, error, read_error from ad_orders where id = ?").get(id) as Record<string, unknown>;
  const applyCols = (id: number) => s.prepare("select creative_id, failed_step from ad_orders where id = ?").get(id) as Record<string, unknown>;
  assert.deepEqual(sync(), { read: 2, changed: 0 });
  // The skill applies the SGC order: it writes status + ids into the file.
  // Gate fixes: the apply skill first claims the order (`applying` + the step in progress), then writes applied + the ids.
  fs.writeFileSync(st.path, JSON.stringify({ ...order, status: "applying", apply_step: "creative", apply_started_at: new Date(NOW).toISOString(), video_id: "1700000000000001", error: null }));
  sync();
  assert.deepEqual([rowOf(st.id).status, applyCols(st.id).failed_step], ["applying", null], "a claimed (in progress) order reads applying");
  assert.equal(orders.adOrders(s, 40, NOW + 1000).find((o) => o.id === st.id)?.applyStep, "creative");
  fs.writeFileSync(st.path, JSON.stringify({ ...order, status: "applied", ad_id: "120251804631930999", ad_name: "SGC-harbor-coopboard_handled-obj-15", creative_id: "2383839309021999", applied_at: "2026-10-02T14:00:00Z", error: null }));
  assert.equal(sync().changed, 1);
  assert.deepEqual(applyCols(st.id), { creative_id: "2383839309021999", failed_step: null }, "applied: the creative id read back, the failed step cleared");
  assert.deepEqual(rowOf(st.id), { status: "applied", ad_id: "120251804631930999", ad_name: "SGC-harbor-coopboard_handled-obj-15", applied_at: "2026-10-02T14:00:00Z", error: null, read_error: null });
  assert.throws(() => orders.cancelOrder(s, tcfg, st.id), /only a staged order/, "an applied order cannot be cancelled");
  insAd.run("120251804631930999", accHarbor, "SGC-harbor-coopboard_handled-obj-15", "SGC-HarborHouse-Testing", "SGC", "PAUSED", 2, vid, null);
  const view = orders.adOrders(s).find((o) => o.id === st.id)!;
  assert.ok(view.inRunning && view.named && view.name === "SGC-harbor-coopboard_handled-obj-15", "In Running once the synced ads have it");
  assert.equal(orders.ordersByHook(s, [hShort]).get(hShort)?.status, "applied", "the hook row's order line");
  assert.equal(orders.ordersByAppliedAd(s, ["120251804631930999"]).get("120251804631930999")?.id, st.id);
  assert.equal(orders.ordersByWinnerAd(s, ["900101"]).get("900101")?.id, stF.id, "the Winner card's order");
  // Junk and oversize files are refused (status kept, read_error set); a vanished file is `missing`.
  const st2 = stage({ assetId: still, hookIds: [], source: { from: "library", ref: String(still) } });
  fs.writeFileSync(st2.path, "not json");
  sync();
  assert.deepEqual([rowOf(st2.id).status, rowOf(st2.id).read_error], ["staged", "The order file is not JSON."]);
  fs.writeFileSync(st2.path, JSON.stringify({ kind: "studio_ad", schema: 2, status: "applied" }));
  sync();
  assert.match(String(rowOf(st2.id).read_error), /shape is not one Studio wrote/, "zod refuses a shape Studio never wrote");
  fs.writeFileSync(st2.path, JSON.stringify({ ...order, studio_order_id: "ffffffffffff", status: "failed" }));
  sync();
  assert.deepEqual([rowOf(st2.id).status, rowOf(st2.id).read_error], ["staged", "The file's studio_order_id does not match this order."]);
  fs.writeFileSync(st2.path, JSON.stringify({ pad: "y".repeat(70_000) }));
  sync();
  assert.match(String(rowOf(st2.id).read_error), /64 KB/, "size cap on read");
  const o2 = JSON.parse((s.prepare("select body from ad_orders where id = ?").pluck().get(st2.id) as string));
  fs.writeFileSync(st2.path, JSON.stringify({ ...o2, status: "failed", error: "Meta said 1359188: no payment method" }));
  sync();
  assert.deepEqual([rowOf(st2.id).status, rowOf(st2.id).error, rowOf(st2.id).read_error], ["failed", "Meta said 1359188: no payment method", null], "failed + the skill's error");
  fs.rmSync(st2.path);
  sync();
  assert.equal(rowOf(st2.id).status, "missing", "a vanished file = missing");
  // Cancel: only Studio's own still-staged order, through temp + rename (the rest of the JSON kept).
  const st3 = stage({ assetId: shared, hookIds: [], source: { from: "library", ref: String(shared) } });
  const ino = fs.statSync(st3.path).ino;
  const id3 = JSON.parse(fs.readFileSync(st3.path, "utf8")).studio_order_id as string;
  assert.throws(() => orders.cancelOrderFile(tcfg, st3.path, "000000000000"), /not this Studio order/, "another order id refused");
  assert.throws(() => orders.cancelOrderFile(tcfg, path.join(base, "elsewhere", path.basename(st3.path)), id3), /configured folders/, "a file outside the folders refused");
  orders.cancelOrder(s, tcfg, st3.id, NOW + 5000);
  const c3 = JSON.parse(fs.readFileSync(st3.path, "utf8"));
  assert.deepEqual([c3.status, c3.cancelled_at, c3.headlines, rowOf(st3.id).status], ["cancelled", new Date(NOW + 5000).toISOString(), goodCopy.headlines, "cancelled"]);
  assert.notEqual(fs.statSync(st3.path).ino, ino, "rewritten by rename (a new inode), not in place");
  assert.equal(fs.statSync(st3.path).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(fs.realpathSync(pendFpc)).filter((f) => f.startsWith(".")), [], "no temp file left");
  assert.throws(() => orders.cancelOrder(s, tcfg, st3.id), /only a staged order/, "cancelled once");
  assert.equal(newAd.nextAdNumber(s, tcfg, ch), 16, "the applied order (15) counts; a missing or cancelled one does not");
  ok("read-back (worker, every 60 s): applied / failed (+ the skill's error, slice 4: its creative id and the step a failed / in-progress apply stopped at) / missing mirrored from the file, junk / a foreign shape / another id / over 64 KB refused (status kept, read_error shown), In Running once synced, hook row + Winner + applied-ad lookups; Cancel only Studio's own still-staged order (temp file + rename, JSON kept, 0600), never an applied one");

  // ---------------------------------------------------------------- gate fixes: applying, the lock, PAUSED ads in Running
  assert.ok((orders.ORDER_STATUSES as readonly string[]).includes("applying") && !orders.FINAL_STATUSES.includes("applying"), "applying is a status, never final");
  const st4 = stage({ assetId: mid, hookIds: [], source: { from: "library", ref: String(mid) }, concept: "coopboard_applying" });
  const o4 = JSON.parse(fs.readFileSync(st4.path, "utf8"));
  const before4 = newAd.nextAdNumber(s, tcfg, ch);
  fs.writeFileSync(st4.path, JSON.stringify({ ...o4, status: "applying", apply_step: "upload", apply_started_at: new Date(NOW).toISOString(), error: null }));
  sync();
  const ov4 = () => orders.adOrders(s, 40, NOW + 60_000).find((o) => o.id === st4.id)!;
  assert.deepEqual([ov4().status, ov4().applyStep, ov4().stalled], ["applying", "upload", false], "applying + its step, not stalled yet");
  assert.equal(orders.applyingText(ov4().applyStep, ov4().stalled), "being applied in a Claude session, step upload");
  const late = orders.adOrders(s, 40, NOW + 31 * 60_000).find((o) => o.id === st4.id)!;
  assert.ok(late.stalled && late.status === "applying", "30 minutes later: may have stopped (still applying, never failed by Studio)");
  assert.match(orders.applyingText(late.applyStep, late.stalled), /may have stopped at step upload/);
  assert.throws(() => orders.cancelOrder(s, tcfg, st4.id), /being applied/, "Cancel refused while applying (row)");
  s.prepare("update ad_orders set status = 'staged' where id = ?").run(st4.id); // a stale row: the file still says applying
  assert.throws(() => orders.cancelOrder(s, tcfg, st4.id), /being applied/, "Cancel refused while the FILE says applying");
  assert.equal(rowOf(st4.id).status, "applying", "and the row shows the file's status again");
  assert.equal(newAd.nextAdNumber(s, tcfg, ch), before4, "an applying order still counts for the next number");
  fs.writeFileSync(st4.path, JSON.stringify({ ...o4, status: "failed", failed_step: "creative", ad_name: "SGC-harbor-coopboard_applying-obj-25", error: "creative: refused" }));
  sync();
  assert.equal(newAd.nextAdNumber(s, tcfg, ch), before4 - 1, "a failed order with NO ad id does not count");
  fs.writeFileSync(st4.path, JSON.stringify({ ...o4, status: "failed", failed_step: "verify", ad_id: "120251804631930444", ad_name: "SGC-harbor-coopboard_applying-obj-19", error: "verify: name" }));
  sync();
  assert.equal(newAd.nextAdNumber(s, tcfg, ch), 20, "a failed order WITH an ad id counts (the ad exists)");
  ok("applying (gate fix): read back with its step, neutral \"being applied in a Claude session, step X\", \"may have stopped at step X\" after 30 minutes (never turned failed), not final, Cancel refused while applying (row or file), counted for the next ad number (and a failed order with an ad id)");

  // The order lock (shared with the apply scripts): a fresh lock refuses Cancel, a stale one (> 2 min) is broken with a note.
  const st5 = stage({ assetId: still, hookIds: [], source: { from: "library", ref: String(still) }, concept: "coopboard_lock" });
  const { orderLockPath, LOCK_STALE_MS } = await import("../src/lib/privatefile");
  const lock5 = orderLockPath(st5.path);
  assert.equal(path.basename(lock5), `.${path.basename(st5.path)}.lock`);
  fs.writeFileSync(lock5, "{}");
  assert.throws(() => orders.cancelOrder(s, tcfg, st5.id), /being applied, try again/, "Cancel while an apply script holds the lock");
  assert.equal(JSON.parse(fs.readFileSync(st5.path, "utf8")).status, "staged", "nothing changed");
  assert.equal(rowOf(st5.id).status, "staged");
  const old = (Date.now() - LOCK_STALE_MS - 10_000) / 1000;
  fs.utimesSync(lock5, old, old);
  const rc5 = orders.cancelOrder(s, tcfg, st5.id, NOW + 7000);
  assert.match(String(rc5.note), /stale lock/, "a stale lock is broken, with a note");
  assert.equal(JSON.parse(fs.readFileSync(st5.path, "utf8")).status, "cancelled");
  assert.equal(fs.existsSync(lock5), false, "the lock is removed after");
  ok("order lock (gate fix): `.<order>.lock` next to the order, O_EXCL 0600; Cancel re-reads under it, refuses with \"the order is being applied, try again\" while it is held, breaks one older than 2 minutes with a note and removes its own");

  // A never-delivered PAUSED ad an applied order created: kept in scope by the Meta sync (row, creative, map match) and
  // listed under Paused with "Staged in Studio"; a never-delivered PAUSED ad without an order is still skipped.
  {
    const { MetaGraph } = await import("../src/lib/meta/graph");
    const { GhlClient } = await import("../src/lib/meta/ghl");
    const { syncAccount, listAccounts } = await import("../src/lib/meta/sync");
    const { runningData } = await import("../src/lib/meta/running");
    const syncClients = path.join(base, "sync-clients");
    fs.mkdirSync(path.join(syncClients, "harbor"), { recursive: true });
    const envF = path.join(syncClients, "agency.env");
    fs.writeFileSync(envF, "META_ACCESS_TOKEN=fake-token-for-the-ads-smoke\nMETA_GRAPH_VERSION=v21.0\n");
    fs.writeFileSync(path.join(syncClients, "harbor", "state.json"), JSON.stringify({ campaign_id: "880001" }));
    const clipPath = s.prepare("select path from assets where id = ?").pluck().get(clip) as string;
    const NEW_AD = "120251804631931111";
    const OTHER = "120251804631932222";
    fs.writeFileSync(
      path.join(syncClients, "harbor", "video_script_map.json"),
      JSON.stringify({ schema: 2, ads: [{ n: "17", ad_name: "SGC-harbor-coopboard_new-obj-17", ad_id: NEW_AD, video: clipPath, status: "paused", source: "studio" }] }),
    );
    const st6 = stage({ hookIds: [], source: { from: "library", ref: String(clip) }, concept: "coopboard_new" });
    const o6 = JSON.parse(fs.readFileSync(st6.path, "utf8"));
    fs.writeFileSync(st6.path, JSON.stringify({ ...o6, status: "applied", ad_id: NEW_AD, ad_name: "SGC-harbor-coopboard_new-obj-17", creative_id: "2383839309021777", applied_at: "2026-10-02T15:00:00Z", error: null }));
    sync();
    const act = s.prepare("select act_id from ad_accounts where id = ?").pluck().get(accHarbor) as string;
    const creative = (id: string) => ({ id, thumbnail_url: "https://scontent.xx.fbcdn.net/x.jpg", video_id: `v${id}`, asset_feed_spec: { titles: [{ text: "Head" }], bodies: [{ text: "Body." }], descriptions: [{ text: "D" }], call_to_action_types: ["LEARN_MORE"] } });
    const metaAds = [
      { id: NEW_AD, name: "SGC-harbor-coopboard_new-obj-17", effective_status: "PAUSED", configured_status: "PAUSED", created_time: "2026-10-02T15:00:00+0000", adset: { id: "ts1", name: "SGC-HarborHouse-Testing" }, campaign_id: "880001", creative: creative("c17") },
      { id: OTHER, name: "SGC-harbor-someone_else-ps-18", effective_status: "PAUSED", configured_status: "PAUSED", created_time: "2026-10-02T15:00:00+0000", adset: { id: "ts1", name: "SGC-HarborHouse-Testing" }, campaign_id: "880001", creative: creative("c18") },
    ];
    const methods: string[] = [];
    const transport = async (req: { method: string; url: string; headers: Record<string, string> }) => {
      methods.push(req.method);
      const u = new URL(req.url);
      const p = u.pathname.replace(/^\/v\d+\.\d+\/?/, "");
      const q = Object.fromEntries(u.searchParams);
      const json = (status: number, b: unknown) => ({ status, body: JSON.stringify(b), header: () => null });
      if (p === act) return json(200, { id: act, timezone_name: "America/New_York" });
      if (p === "880001") return json(200, { id: "880001", name: "SGC-HarborHouse", effective_status: "ACTIVE", start_time: "2026-09-25T12:00:00+0000" });
      if (p === "880001/ads") return json(200, { data: metaAds });
      if (p === "880001/insights") return json(200, { data: [] });
      if (p === "" && q.ids) return json(200, Object.fromEntries(q.ids.split(",").map((id) => [id, { id, title: `untitled ${id}` }])));
      return json(404, { error: { message: `unknown ${p}`, code: 803 } });
    };
    const graph = new MetaGraph({ identity: "fpc", envFile: envF, transport, sleep: async () => {} });
    const ghl = new GhlClient({ identity: "fpc", envFile: envF }); // no GHL key: GHL skipped, never called
    const accRow = listAccounts(s).find((a) => a.id === accHarbor)!;
    const res = await syncAccount(s, accRow, {
      graph: () => graph,
      ghl: () => ghl,
      fetchThumb: async () => ({ status: 200, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]) }),
      cacheDir: path.join(base, "sync-cache"),
      clientsDir: syncClients,
      universalRegistry: null,
      now: () => Date.UTC(2026, 9, 2, 16, 0, 0),
      log: () => {},
      isStopped: () => false,
    });
    assert.equal(res.ok, true, `sync ok (${res.error ?? ""})`);
    assert.ok(methods.length && methods.every((m) => m === "GET"), "GET only");
    const adRow = s.prepare("select effective_status, matched_asset_id, match_source, creative from ads where meta_ad_id = ?").get(NEW_AD) as Record<string, unknown> | undefined;
    assert.ok(adRow, "the ordered PAUSED ad with no delivery is upserted");
    assert.deepEqual([adRow!.effective_status, adRow!.matched_asset_id, adRow!.match_source], ["PAUSED", clip, "map"], "matched to its file by the map row (ad id)");
    assert.ok(String(adRow!.creative).includes("LEARN_MORE"), "its creative read");
    assert.equal(s.prepare("select count(*) from ads where meta_ad_id = ?").pluck().get(OTHER), 0, "a never-delivered PAUSED ad without an order is still skipped");
    const scope = { kind: "client" as const, code: "harbor" };
    const filt = (status: "active" | "paused" | "all") => ({ window: "7d" as const, status, sort: "spend" as const, hook: null, flag: null });
    const at = Date.UTC(2026, 9, 2, 16, 0, 0);
    const paused = runningData(s, scope, filt("paused"), at).cards.find((c) => c.metaAdId === NEW_AD);
    assert.ok(paused, "listed under Paused");
    assert.equal(paused!.studioOrder?.id, st6.id, "with the Staged in Studio note");
    assert.ok(runningData(s, scope, filt("all"), at).cards.some((c) => c.metaAdId === NEW_AD), "and under All");
    assert.ok(!runningData(s, scope, filt("active"), at).cards.some((c) => c.metaAdId === NEW_AD), "never under Active while PAUSED");
  }
  ok("PAUSED ads from Studio orders (gate fix): the Meta sync keeps an ad an order created in scope with no delivery (row upserted, creative read, matched by the client's map row) and the Running tab lists it under Paused / All with \"Staged in Studio\" (never Active while PAUSED); a never-delivered PAUSED ad without an order is still skipped");

  // ---------------------------------------------------------------- the ad_copy job (stub claude)
  const stubDir = path.join(base, "claude-stub");
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, "claude");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
D='${stubDir}'
N=$(cat "$D/count" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "$D/count"
printf '%s\\n' "$@" > "$D/args-$N.txt"
/usr/bin/env > "$D/env-$N.txt"
MODE=$(head -n 1 "$D/queue"); tail -n +2 "$D/queue" > "$D/queue.next"; mv "$D/queue.next" "$D/queue"
case "$MODE" in
  badjson) echo "I could not do that." ;;
  *) cat "$D/$MODE.json" ;;
esac
`,
  );
  fs.chmodSync(stub, 0o755);
  const savedBin = process.env.CLAUDE_BIN;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_BIN = stub;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-claude";
  const answer = (o: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      is_error: false,
      result: JSON.stringify(o),
      usage: { input_tokens: 3, output_tokens: 700 },
      modelUsage: { "claude-opus-5": { outputTokens: 700 } },
    });
  const v4 = (place: string) => `🛁 ${place} householders: a free deck renovation consultation.\n✅ Board paperwork handled\n👇 Tap below to get matched.`;
  fs.writeFileSync(
    path.join(stubDir, "good.json"),
    answer({
      headlines: ["Board Ready Decks", "Your Co-op, Handled", "A Deck Pro Who Knows Boards", "Fourth Headline"],
      primaries: [v4("Centerville"), v4("Northfield"), v4("Riverby")],
      descriptions: ["Board ready. Free consult.", "Second description"],
      concept: "coopboard_ready",
      ps_obj: "ps",
    }),
  );
  fs.writeFileSync(
    path.join(stubDir, "dashed.json"),
    answer({
      headlines: ["Board Ready — Decks", "Unlock Your Co-op Deck", "Hana Handles the Board", "A Deck Pro Who Knows Boards"],
      primaries: ["One line primary without the v4 shape.", v4("Harlow").replace("👇", "🔥")],
      descriptions: ["Free consult ✅"],
      concept: "Bad Concept",
      ps_obj: "maybe",
    }),
  );
  fs.writeFileSync(
    path.join(stubDir, "fix.json"),
    answer({ headlines: ["Board Paperwork, Gone", "Your Co-op Deck Pro"], primaries: [v4("Weston Heights"), v4("Harlow")], descriptions: ["Board ready."], concept: "coopboard_fix", ps_obj: "obj" }),
  );
  const queueStub = (...modes: string[]) => fs.writeFileSync(path.join(stubDir, "queue"), modes.join("\n") + "\n");
  const stubCalls = () => Number(fs.readFileSync(path.join(stubDir, "count"), "utf8").trim() || 0);
  const quiet = () => {};
  const q = new AdQueue(s, { cfg: tcfg, cacheDir: cfg.cacheDir, logsDir: path.join(base, "logs"), log: quiet, isStopped: () => false, timeoutMs: 15_000 });
  const jobOf = (jid: number) => s.prepare("select status, error, result, log_path from jobs where id = ?").get(jid) as { status: string; error: string | null; result: string | null; log_path: string };

  // Alex typed headline 1 and primary 2; the draft brings exactly the rest and never touches those.
  const typed = { headlines: ["Co-op Board? We Handle It", "", ""], primaries: ["", "Board approvals handled every week. Tap below."], description: "" };
  assert.deepEqual(job.needed(typed), { headlines: 2, primaries: 1, description: true, p1: false });
  assert.throws(() => job.queueAdCopy(s, { channel: "harbor", hookId: hShort, angleKey: null, filled: { headlines: ["a", "b", "c"], primaries: ["p", "q"], description: "d" } }), /Every slot already has text/);
  assert.throws(() => job.queueAdCopy(s, { channel: "harbor", hookId: hRtm, angleKey: null, filled: typed }), /another channel/, "never an NSM hook");
  queueStub("good");
  const j1 = job.queueAdCopy(s, { channel: "harbor", hookId: hShort, angleKey: null, filled: typed }, NOW);
  assert.equal(job.queueAdCopy(s, { channel: "harbor", hookId: hShort, angleKey: null, filled: typed }, NOW), j1, "one active job per channel + hook");
  assert.deepEqual(await q.drain(), { done: 1, error: 0, interrupted: 0 });
  const r1 = JSON.parse(jobOf(j1).result!) as import("../src/lib/meta/ad-copy-job").AdCopyJobResult;
  assert.deepEqual(r1.draft!.headlines, ["Board Ready Decks", "Your Co-op, Handled"], "only as many as needed, in order");
  assert.equal(r1.draft!.primaries.length, 1);
  assert.equal(r1.draft!.primaries[0], "🛁 Centerville householders: a free deck renovation consultation.\n\n✅ Board paperwork handled\n\n👇 Tap below to get matched.", "FORMAT v4: double spaced");
  assert.deepEqual([r1.draft!.description, r1.draft!.concept, r1.draft!.psObj], ["Board ready. Free consult.", "coopboard_ready", "ps"]);
  const filled = rules.fillEmptySlots({ ...typed, headlines: ["Co-op Board? We Handle It", "Typed while drafting", ""] }, r1.draft!);
  assert.deepEqual(filled.headlines, ["Co-op Board? We Handle It", "Typed while drafting", "Board Ready Decks", "Your Co-op, Handled"].slice(0, 3), "typed slots are never overwritten; empty ones fill");
  assert.equal(filled.primaries[1], typed.primaries[1], "the typed primary kept");
  assert.equal(filled.primaries[0], r1.draft!.primaries[0]);
  assert.equal(rules.fillEmptySlots({ ...typed, description: "Mine" }, r1.draft!).description, "Mine");
  const args1 = fs.readFileSync(path.join(stubDir, "args-1.txt"), "utf8");
  for (const flag of ["-p", "--tools", "--strict-mcp-config", "--safe-mode", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(args1.split("\n").includes(flag), `claude ran with ${flag}`);
  assert.ok(!args1.includes("--dangerously-skip-permissions"));
  assert.ok(args1.includes("FORMAT v4") && args1.includes("Co-op Board? We Handle It") && args1.includes("Never these words") && args1.includes('"Hana"'), "the prompt: FORMAT v4, the hook, the map's forbidden terms");
  assert.ok(args1.includes("Headline: Co-op Board? We Handle It") && args1.includes("Board approvals handled every week."), "the typed lines ride along as already written");
  assert.ok(!fs.readFileSync(path.join(stubDir, "env-1.txt"), "utf8").includes("ANTHROPIC"), "no API key reaches claude");
  assert.equal(claudeLib.resolveClaude()?.cmd, fs.realpathSync(stub));
  // Dashed / off-palette / one-line / forbidden lines dropped -> one retry, survivors of both kept.
  queueStub("dashed", "fix");
  const j2 = job.queueAdCopy(s, { channel: "harbor", hookId: hShort, angleKey: "coop-condo", filled: { headlines: [""], primaries: [""], description: "" } }, NOW);
  await q.drain();
  const r2 = JSON.parse(jobOf(j2).result!) as import("../src/lib/meta/ad-copy-job").AdCopyJobResult;
  assert.equal(r2.attempts.length, 2, "one retry");
  const reasons = r2.attempts[0].dropped.map((d) => `${d.field}:${d.reason}`);
  assert.ok(reasons.some((x) => /headline:A dash/.test(x)) && reasons.some((x) => /AI tell/.test(x)) && reasons.some((x) => /Forbidden term "Hana"/.test(x)), "dash, AI tell and forbidden term dropped");
  assert.ok(reasons.some((x) => /primary:Not FORMAT v4/.test(x)) && reasons.some((x) => /not in the palette/.test(x)) && reasons.some((x) => /description:An emoji/.test(x)));
  assert.deepEqual(r2.draft!.headlines, ["A Deck Pro Who Knows Boards", "Board Paperwork, Gone", "Your Co-op Deck Pro"], "survivors of both attempts");
  assert.deepEqual([r2.draft!.primaries.length, r2.draft!.description, r2.draft!.concept, r2.draft!.psObj], [2, "Board ready.", "coopboard_fix", "obj"], "a bad concept / ps_obj ignored, the retry's taken");
  assert.equal(r2.note, null);
  assert.match(fs.readFileSync(path.join(stubDir, "args-3.txt"), "utf8"), /Your last answer broke these rules/, "the retry is told what broke");
  // Bad JSON = error; Retry; Cancel while pending; recover a running job.
  fs.writeFileSync(path.join(stubDir, "prose.json"), JSON.stringify({ type: "result", is_error: false, result: "I could not do that.", usage: {}, modelUsage: {} }));
  queueStub("badjson", "prose");
  const j3 = job.queueAdCopy(s, { channel: "fkb", hookId: hFkb, angleKey: null, filled: typed }, NOW);
  await q.drain();
  assert.deepEqual([jobOf(j3).status, jobOf(j3).error], ["error", "claude printed no JSON result"], "CLI output that is not JSON");
  assert.equal(job.retryAdCopyJob(s, j3), true);
  await q.drain();
  assert.deepEqual([jobOf(j3).status, jobOf(j3).error], ["error", "claude's answer was not JSON."], "an answer that is not JSON");
  assert.match(fs.readFileSync(jobOf(j3).log_path, "utf8"), /error: claude's answer was not JSON/, "logs/jobs/ad-copy-<id>.log");
  assert.equal(job.retryAdCopyJob(s, j3), true);
  queueStub("good");
  await q.drain();
  const r3 = JSON.parse(jobOf(j3).result!) as import("../src/lib/meta/ad-copy-job").AdCopyJobResult;
  assert.equal(jobOf(j3).status, "done");
  assert.deepEqual([r3.draft!.concept, r3.draft!.psObj], [null, null], "SGD: no concept / ps|obj");
  assert.match(fs.readFileSync(path.join(stubDir, `args-${stubCalls()}.txt`), "utf8"), /SGD speaks as itself/, "SGD's prompt");
  const j4 = job.queueAdCopy(s, { channel: "harbor", hookId: null, angleKey: null, filled: typed }, NOW);
  assert.equal(job.cancelAdCopyJob(s, j4), true);
  assert.equal(jobOf(j4).status, "cancelled");
  const callsBefore = stubCalls();
  await q.drain();
  assert.equal(stubCalls(), callsBefore, "a cancelled job never runs");
  assert.equal(job.retryAdCopyJob(s, j4), true);
  s.prepare("update jobs set status = 'running' where id = ?").run(j4);
  assert.equal(q.recover(), 1);
  assert.deepEqual([jobOf(j4).status, jobOf(j4).error], ["error", AD_INTERRUPTED], "a restart turns running into Interrupted (Retry runs it again)");
  // A hook longer than a headline sits alone in primary 1: the draft completes primary 1 after it (the hook line forced
  // in first), writes the other primary, and the dialog swaps primary 1 only while it still reads exactly the hook.
  const opening = "Lakeside householders: your 1980s cabinet doors come off, your garden boxes stay put";
  const p1Typed = { headlines: ["", "", ""], primaries: [opening, ""], description: "Doors off, boxes stay." };
  assert.deepEqual(job.needed(p1Typed, opening), { headlines: 3, primaries: 1, description: false, p1: true });
  assert.equal(job.needed({ ...p1Typed, primaries: [`${opening}\n\nmore`, ""] }, opening).p1, false, "an edited primary 1 is Alex's");
  queueStub("good");
  const j5 = job.queueAdCopy(s, { channel: "harbor", hookId: hShort, angleKey: null, filled: p1Typed, p1Opening: opening }, NOW);
  await q.drain();
  const r5 = JSON.parse(jobOf(j5).result!) as import("../src/lib/meta/ad-copy-job").AdCopyJobResult;
  assert.equal(r5.draft!.p1, `${opening}\n\n🛁 Centerville householders: a free deck renovation consultation.\n\n✅ Board paperwork handled\n\n👇 Tap below to get matched.`, "primary 1 = the hook line + the drafted body");
  assert.equal(r5.draft!.primaries.length, 1, "plus one more primary (2 in all)");
  assert.match(fs.readFileSync(path.join(stubDir, `args-${stubCalls()}.txt`), "utf8"), /must open with this exact line, the hook/);
  const f5 = rules.fillEmptySlots(p1Typed, r5.draft!, opening);
  assert.deepEqual([f5.primaries[0], f5.primaries[1], f5.description], [r5.draft!.p1, r5.draft!.primaries[0], "Doors off, boxes stay."]);
  assert.equal(rules.fillEmptySlots({ ...p1Typed, primaries: ["Alex rewrote it", ""] }, r5.draft!, opening).primaries[0], "Alex rewrote it", "an edited primary 1 is never replaced");
  assert.equal(job.adCopyJobs(s).length, 5);
  assert.equal(job.adCopyJob(s, j1)?.draft?.headlines.length, 2);
  if (savedBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = savedBin;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  ok("ad_copy job (stub claude via CLAUDE_BIN, the hardened runner: no tools, no API key): exactly the empty slots drafted, FORMAT v4 double spacing, dashed / AI tell / forbidden / off-palette / one-line lines dropped with reasons, one retry told what broke (survivors of both kept), bad JSON = error + Retry, Cancel while pending, recover running -> Interrupted, typed slots never overwritten (fillEmptySlots), SGD without concept, a long hook's primary 1 completed after it (only while untouched)");

  // ---------------------------------------------------------------- post Phase 6: frame grabs hidden, a video's own line
  const { THUMBNAIL_FRAMES_IGNORE } = await import("../src/lib/db/seed");
  const { buildIgnoreMatcher } = await import("../src/lib/patterns");
  assert.ok(s.prepare("select 1 from ignore_patterns where pattern = ?").get(THUMBNAIL_FRAMES_IGNORE), "seed v9 / v10: the frame grab ignore pattern");
  const ign = buildIgnoreMatcher([THUMBNAIL_FRAMES_IGNORE]);
  assert.deepEqual(
    [
      ign("renders/Adam (Acme Restoration NJ)/thumbnails", true),
      ign("renders/Adam (Acme Restoration NJ)/thumbnails/acme_19_hero.png"),
      ign("renders/SGD Pros (Universal)/thumbnails/SGD_concept_07_oldtub_kinetictype_frame0.png"),
      ign("renders/Coral Renovation/launch-2026-09/thumbnails/delta_01_hero.png"),
      ign("renders/Adam (Acme Restoration NJ)/SGD_ad_acme_19.mp4"),
      ign("renders/Hana (The Harbor House)/v2-2026-08-25/tara_01.mp4"),
      ign("Ep1/thumbnails/a.png"),
    ],
    [true, true, true, true, false, false, false],
    "renders/<client>/[<batch>/]thumbnails/ hidden (folder + files); the videos and any thumbnails/ folder outside renders/ kept",
  );
  // A DB that got v9's narrower pattern (the live one, for a few minutes) gets the wide one in v10; nothing else is touched.
  const { seed } = await import("../src/lib/db/seed");
  s.prepare("delete from ignore_patterns where pattern = ?").run(THUMBNAIL_FRAMES_IGNORE);
  s.prepare("insert into ignore_patterns (pattern) values ('renders/*/thumbnails/**'), ('renders/*/thumbnails/keep-me.png')").run();
  s.prepare("update app_settings set value = '9' where key = 'seed_version'").run();
  seed(s, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  assert.deepEqual(
    s.prepare("select pattern from ignore_patterns where pattern like 'renders/%thumbnails%' order by pattern").pluck().all(),
    [THUMBNAIL_FRAMES_IGNORE, "renders/*/thumbnails/keep-me.png"],
    "v10 swaps v9's exact pattern for renders/**/thumbnails/**, any other pattern kept",
  );
  s.prepare("delete from ignore_patterns where pattern = 'renders/*/thumbnails/keep-me.png'").run();
  const grab = asset(FKBP, root, rootDir, "harbor-hero.png", "image", 1 * MB, HARBOR);
  assert.ok(m(grab).ok);
  s.prepare("update assets set ignored = 1 where id = ?").run(grab);
  assert.ok(!m(grab).ok, "a hidden frame grab is never ad media");
  ok("frame grabs (seed v9 + v10, Alex 2026-10-01): `renders/**/thumbnails/**` hides the frame grabs next to each SGD Pros render (Library, coverage, ad media) without touching the drive; the videos and other thumbnails/ folders stay");

  const describe = s.prepare("update assets set description = ?, spoken_open = ? where id = ?");
  const LINE = "If you live in Centerville and your co-op board scares you, read this.";
  const spoken = asset(FKBP, root, rootDir, "harbor-spoken.mp4", "video", 20 * MB, HARBOR);
  describe.run("First 3 seconds: A woman in a deck.\nText: none", `${LINE} We handle the paperwork.`, spoken);
  const captioned = asset(FKBP, root, rootDir, "harbor-captioned.mp4", "video", 20 * MB, HARBOR);
  describe.run('First 3 seconds: A tiled shower.\nText: "Co-op Board? Handled."', "", captioned);
  const broll = asset(FKBP, root, rootDir, "harbor-broll.mp4", "video", 20 * MB, HARBOR);
  describe.run("First 3 seconds: A slow pan over a white vanity.\nText: none", "", broll);
  const videoHooks = (a: number) => s.prepare("select id, text, source, client_id, archived_at from hooks where asset_id = ? and kind = 'video'").all(a) as {
    id: number;
    text: string;
    source: string;
    client_id: number | null;
    archived_at: number | null;
  }[];
  const vs = pre({ assetId: spoken });
  assert.deepEqual([vs.channel?.code, vs.hook, vs.videoLine, vs.hookInPrimary], ["harbor", null, { assetId: spoken, hookId: null, text: LINE }, true], "a spoken video: its first sentence, no hook yet");
  assert.deepEqual([vs.copy.primaries, vs.copySource], [[LINE], null], "over 40 characters: primary 1 (no angle known yet)");
  insAd.run("900005", accHarbor, "SGC-HarborHouse-ManhattanBronx-Deck-Ad-05", "SGC-HarborHouse-Winners", "SGC", "PAUSED", 2, vid, "coop-condo");
  s.prepare("update ads set matched_asset_id = ? where meta_ad_id = '900005'").run(spoken);
  const vs2 = pre({ assetId: spoken, channel: "harbor" });
  assert.deepEqual([vs2.angle, vs2.copySource, vs2.copy.headlines], ["coop-condo", "doc", coop.headlines], "the angle of the ad that runs this file: its block");
  assert.deepEqual(vs2.copy.primaries[0].split("\n\n").slice(0, 2), [LINE, "Dreading the board approval before your deck even starts?"], "the line replaces the structured primary's first line");
  const vc = pre({ assetId: captioned });
  assert.deepEqual([vc.videoLine?.text, vc.copy.headlines[0], vc.hookInPrimary], ["Co-op Board? Handled.", "Co-op Board? Handled.", false], "no speech: the on-screen text, headline 1 when it fits");
  const vb = pre({ assetId: broll });
  assert.deepEqual([vb.videoLine, vb.copy.headlines, vb.copy.primaries], [null, [], []], "no words in the video: nothing prefilled (never the description's opening line)");
  assert.equal(pre({ assetId: spoken, hookId: hShort }).videoLine, null, "a hook asked for wins");
  assert.equal(pre({ assetId: still }).videoLine, null, "images have none");
  assert.deepEqual([videoHooks(spoken), videoHooks(captioned), videoHooks(broll)], [[], [], []], "opening the dialog writes nothing");

  const before = s.prepare("select count(*) from hooks").pluck().get() as number;
  assert.throws(
    () => orders.stageOrder(s, linkCfg, { channel: "harbor", assetId: spoken, copy: goodCopy, angleKey: null, concept: "coopboard_line", psObj: "obj", hookIds: [], videoHook: true, source: { from: "library", ref: String(spoken) }, notes: null }, NOW),
    /not a plain folder/,
  );
  assert.equal(s.prepare("select count(*) from hooks").pluck().get(), before, "a failed Stage leaves no new hook (same transaction)");
  const sv = stage({ assetId: spoken, hookIds: [], videoHook: true, source: { from: "library", ref: String(spoken) } });
  const made = videoHooks(spoken);
  assert.deepEqual(made.map((h) => [h.text, h.source, h.client_id]), [[LINE, "asset", HARBOR]], "Stage makes the video's hook (source asset, the file's client)");
  assert.deepEqual([JSON.parse(fs.readFileSync(sv.path, "utf8")).hook_ids, JSON.parse(s.prepare("select hook_ids from ad_orders where id = ?").pluck().get(sv.id) as string)], [[made[0].id], [made[0].id]], "the order file and row carry it");
  assert.equal(pre({ assetId: spoken }).videoLine?.hookId, made[0].id, "next time the existing hook is used");
  s.prepare("update hooks set archived_at = 5 where id = ?").run(made[0].id);
  const sv2 = stage({ assetId: spoken, hookIds: [], videoHook: true, source: { from: "library", ref: String(spoken) } });
  assert.deepEqual([JSON.parse(fs.readFileSync(sv2.path, "utf8")).hook_ids, videoHooks(spoken).length, videoHooks(spoken)[0].archived_at], [[made[0].id], 1, 5], "an archived hook is linked as is, never restored or duplicated");
  const sb = stage({ assetId: broll, hookIds: [], videoHook: true, source: { from: "library", ref: String(broll) } });
  assert.deepEqual([JSON.parse(fs.readFileSync(sb.path, "utf8")).hook_ids, videoHooks(broll)], [[], []], "a video with no words gets no hook");
  const si = stage({ assetId: still, hookIds: [], videoHook: true, source: { from: "library", ref: String(still) } });
  assert.deepEqual(JSON.parse(fs.readFileSync(si.path, "utf8")).hook_ids, [], "an image: no video hook");
  const sh = stage({ assetId: captioned, hookIds: [hShort], videoHook: true });
  assert.deepEqual([JSON.parse(fs.readFileSync(sh.path, "utf8")).hook_ids, videoHooks(captioned)], [[hShort], []], "a hook already given: no video hook made");
  ok("New ad from a video (Alex 2026-10-01): with no hook asked for, the video's own line (spoken first sentence, else on-screen text; never the description) fills headline 1 or primary 1's opening line, the angle comes from an ad that runs the file; opening writes nothing; Stage links the video's hook, making it (source asset) in the order's transaction when it has none, an archived one linked as is; no words / an image / a given hook = none");

  // ---------------------------------------------------------------- nothing called the network
  assert.deepEqual(fetchCalls, [], "no fetch anywhere in prefill, Stage, Cancel, read-back or the job");
  assert.deepEqual([sha(docFile), sha(mapFile)], [docSha, mapSha]);
  assert.deepEqual(
    fs.readdirSync(fs.realpathSync(pendFpc)).sort(),
    (s.prepare("select file_path from ad_orders where channel_code = 'harbor' and status != 'missing'").pluck().all() as string[]).map((f) => path.basename(f)).sort(),
    "only Studio's own order files in the folder (the missing one stays gone)",
  );
  globalThis.fetch = realFetch;
  db.sqlite.close();
  ok("no network call anywhere in the new-ad path (fetch trapped: Meta / GHL never called), the copy doc and the ad map byte for byte unchanged, only Studio's own files in the order folders");
}
