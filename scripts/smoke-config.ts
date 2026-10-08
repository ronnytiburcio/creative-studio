/**
 * Creative Studio slice 1b smoke checks (called by scripts/smoke.ts after the slice 1a checks): the Studio config file
 * (STUDIO_CONFIG), the seed-once config pass, migration 0024's backfill, Settings > Clients / Lanes (the lib functions and
 * the server actions), hidden clients / switched-off lanes leaving the sidebar, scopes, Review, coverage and the Meta
 * sync, and the per-client sync options on stub Graph / GHL transports. Made-up clients only (acme, northwind, globex);
 * the one check against the original install's seed reads `private/studio.config.json` + `private/seed-snapshot.json`
 * (skipped when `private/` is absent, e.g. in an exported copy). Temp folders and stub transports only: never the live
 * DB, the real env files, Meta or GHL.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { StudioConfig } from "../src/lib/config";
import type { StudioFile } from "../src/lib/studio-config";
import { seedRowsSnapshot } from "./seed-snapshot";

type Ctx = { cfg: StudioConfig; tmp: string; ok: (msg: string) => void };

const LANE_B_TOKEN = "EAAtestCONFIGtoken";
const LANE_TOKEN = "EAAtestLANEtoken";
const GHL_KEY = "pit-test-config-key";

export async function runConfigSmoke({ cfg, tmp, ok }: Ctx) {
  const config = await import("../src/lib/config");
  const { loadConfig } = config;
  const sc = await import("../src/lib/studio-config");
  const { parseStudioText, StudioConfigError } = sc;
  const { seed, seedFromConfig } = await import("../src/lib/db/seed");
  const { MIGRATIONS_DIR, getDb } = await import("../src/lib/db");
  const admin = await import("../src/lib/clients-admin");
  const { addClient, editClient, setClientHidden, editLane, adminClients, adminLanes, ClientAdminError } = admin;
  const { listAccounts, syncAccount } = await import("../src/lib/meta/sync");
  const { scheduledAccountIds, metaSummary, metaAccounts } = await import("../src/lib/meta/store");
  const { MetaGraph } = await import("../src/lib/meta/graph");
  const { GhlClient, GHL_SEARCH_URL } = await import("../src/lib/meta/ghl");
  const { adChannels } = await import("../src/lib/meta/new-ad");
  const { allCoverage } = await import("../src/lib/hooks/coverage");
  const queries = await import("../src/lib/queries");
  const actions = await import("../src/app/actions");

  const base = path.join(tmp, "studio-config");
  fs.mkdirSync(base);
  const write = (name: string, body: unknown) => {
    const f = path.join(base, name);
    fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    return f;
  };

  // ---------------------------------------------------------------- the config file
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  const envFor = (file: string) => ({ STUDIO_ENV_FILE: path.join(base, "none.env"), STUDIO_CONFIG: file });
  const SAMPLE: StudioFile = {
    app: { name: "Acme Studio" },
    lanes: {
      rtm: { name: "Acme Media", color: "#112233", enabled: false },
      fkbpros: { name: "Accounts", color: "#445566", ghlLocation: "LOC9" },
      fkb: { name: "Acme Co", enabled: true, metaAdAccount: "act_904", campaigns: "all", leads: "auto", ghlSource: "co-fb-ad" },
    },
    clients: [
      { code: "acme", name: "Acme / Roadrunner Supply", metaAdAccount: "act_901", hint: "A made up supply store.", folder: "Acme" },
      { code: "northwind", name: "Northwind Traders", metaAdAccount: "act_902", campaigns: { id: "555" }, leads: "ghl", ghlSource: "nw-custom" },
      { code: "globex", name: "Globex", metaAdAccount: "act_903", campaigns: "state_json", leads: "ghl" },
    ],
    roots: [
      { path: "Acme Media", lane: "rtm" },
      { path: path.join(base, "elsewhere"), lane: "fkb" },
    ],
    tagRules: [{ glob: "Acme Gallery/**", clients: ["acme", "northwind"] }],
    profile: { owner: { name: "Ann" } }, // slice 1c: the real (strict) profile schema; scripts/smoke-profile.ts tests it
  };
  const sampleFile = write("sample.json", SAMPLE);
  const loaded = loadConfig({ env: envFor(sampleFile), home, repoDir: base });
  assert.equal(loaded.studioConfigFile, sampleFile);
  assert.equal(loaded.studio.clients?.length, 3);
  assert.equal(loaded.appName, "Acme Studio", "app.name overrides the identity's name");
  const missing = loadConfig({ env: envFor(path.join(base, "nope.json")), home, repoDir: base });
  assert.deepEqual(missing.studio, {}, "a missing file = an empty Studio");
  assert.equal(missing.appName, "Creative Studio");
  assert.equal(loadConfig({ env: { STUDIO_ENV_FILE: path.join(base, "none.env") }, home, repoDir: base }).studioConfigFile, path.join(home, ".studio", "studio.config.json"), "default <settings dir>/studio.config.json");
  const SECRET = "act_SEKRET";
  const bad = (body: unknown, expect: RegExp) => {
    const f = write("bad.json", body);
    assert.throws(
      () => loadConfig({ env: envFor(f), home, repoDir: base }),
      (e: Error) => expect.test(e.message) && !e.message.includes("SEKRET") && !e.message.includes("Roadrunner") && /STUDIO_CONFIG/.test(e.message),
      `refused: ${expect}`,
    );
  };
  bad({ clients: [{ code: "acme", name: "Acme" }, { code: "northwind", name: "N", metaAdAccount: SECRET }] }, /clients\.1\.metaAdAccount: must look like act_/);
  bad({ client: [] }, /\(top level\): unknown key "client"/);
  bad('{ "clients": [ { "code": "acme", "name": "Roadrunner" ', /is not valid JSON/);
  bad({ lanes: { fkbpros: { enabled: false } } }, /lanes\.fkbpros\.enabled: the clients lane cannot be switched off/);
  bad({ clients: [{ code: "acme", name: "A" }, { code: "acme", name: "Roadrunner" }] }, /clients\.1\.code: duplicate client code/);
  bad({ clients: [{ code: "all", name: "A" }] }, /clients\.0\.code: is a reserved word/);
  bad({ clients: [{ code: "acme", name: "A" }], tagRules: [{ glob: "x/**", clients: ["nobody"] }] }, /tagRules\.0\.clients\.0: not a client in this file/);
  bad({ lanes: { fkb: { campaigns: "some" } } }, /lanes\.fkb\.campaigns/);
  bad([1, 2], /\(top level\)/);
  assert.throws(() => parseStudioText("{}x"), StudioConfigError);
  const priv = path.join(process.cwd(), "private", "studio.config.json");
  if (fs.existsSync(priv)) parseStudioText(fs.readFileSync(priv, "utf8"));
  ok("Studio config: zod at load (app.name override, missing file = empty Studio, default path under the settings dir), a bad field fails fast naming its path and rule (never the value), unknown keys refused (strict), a profile accepted, the private config parses");

  // ---------------------------------------------------------------- fresh DBs: empty Studio, the sample config
  const freshDb = (name: string, migrationsFolder = MIGRATIONS_DIR) => {
    const db = new Database(path.join(base, name));
    db.pragma("foreign_keys = ON");
    migrate(drizzle(db), { migrationsFolder });
    return db;
  };
  const drive = path.join(base, "drive");
  const fpc = path.join(base, "fpc-clients");
  fs.mkdirSync(path.join(fpc, "Acme", "Static Ads"), { recursive: true });
  const dirs = { drivePath: drive, clientDocsDir: fpc };

  const empty = freshDb("empty.db");
  seed(empty, { ...dirs, studio: {} });
  assert.deepEqual(empty.prepare("select key, name, enabled from sections order by sort").raw().all(), [
    ["rtm", "Brand", 1],
    ["fkbpros", "Clients", 1],
    ["fkb", "Company", 1],
  ]);
  assert.equal(empty.prepare("select count(*) from clients").pluck().get(), 0);
  assert.equal(empty.prepare("select count(*) from ad_accounts").pluck().get(), 0);
  assert.equal(empty.prepare("select count(*) from tag_rules").pluck().get(), 0, "no business tag rules from code");
  assert.deepEqual(
    (empty.prepare("select path from roots order by path").pluck().all() as string[]).map((p) => path.relative(drive, p)),
    ["Studio Generated/NSM", "Studio Generated/SGD", "Studio Generated/SGD Pros"],
    "only the generic Studio Generated roots",
  );
  assert.ok(empty.prepare("select 1 from ignore_patterns where pattern = 'check/'").get(), "generic ignores stay");
  ok("an empty Studio: three lanes on with neutral names (Brand / Clients / Company), no clients, accounts or tag rules, only the Studio Generated roots and the generic ignores");

  const s1 = freshDb("sample.db");
  seed(s1, { ...dirs, studio: SAMPLE });
  const lanes1 = s1.prepare("select key, name, color, enabled, campaign_mode, leads_mode, ghl_source, ghl_location_id from sections order by sort").raw().all();
  assert.deepEqual(lanes1, [
    ["rtm", "Acme Media", "#112233", 0, "all", "meta", null, null],
    ["fkbpros", "Accounts", "#445566", 1, "all", "meta", null, "LOC9"],
    ["fkb", "Acme Co", "#FFB27A", 1, "all", "auto", "co-fb-ad", null],
  ]);
  const clientRows = () =>
    s1.prepare("select code, name, meta_ad_account_id, classify_hint, folder, campaign_mode, campaign_id, leads_mode, ghl_source, sort, hidden_at from clients order by sort").raw().all();
  assert.deepEqual(clientRows(), [
    ["acme", "Acme / Roadrunner Supply", "act_901", "A made up supply store.", "Acme", "all", null, "meta", null, 0, null],
    ["northwind", "Northwind Traders", "act_902", null, null, "one", "555", "ghl", "nw-custom", 1, null],
    ["globex", "Globex", "act_903", null, null, "state_json", null, "ghl", null, 2, null],
  ]);
  assert.deepEqual(
    s1.prepare("select coalesce(c.code, '-'), a.act_id, a.identity from ad_accounts a left join clients c on c.id = a.client_id order by a.sort, a.id").raw().all(),
    [["acme", "act_901", "fpc"], ["northwind", "act_902", "fpc"], ["globex", "act_903", "fpc"], ["-", "act_904", "fkb"]],
  );
  const realStatic = fs.realpathSync(path.join(fpc, "Acme", "Static Ads"));
  const ruleSet = () => new Set((s1.prepare("select path_glob || ' > ' || client_codes from tag_rules").pluck().all() as string[]));
  for (const want of [
    `Acme Gallery/** > ["acme","northwind"]`,
    `${drive}/Studio Generated/SGD Pros/acme/** > ["acme"]`,
    `${drive}/Studio Generated/SGD Pros/globex/** > ["globex"]`,
    `${realStatic}/** > ["acme"]`,
  ]) assert.ok(ruleSet().has(want), want);
  const rootSet = () => new Set(s1.prepare("select r.path || ' > ' || s.key from roots r join sections s on s.id = r.section_id").pluck().all() as string[]);
  for (const want of [`${drive}/Acme Media > rtm`, `${path.join(base, "elsewhere")} > fkb`, `${realStatic} > fkbpros`]) assert.ok(rootSet().has(want), want);
  ok("a fresh DB seeded from a config: lanes (names, colors, on / off, Lane C's options + GHL location), clients with every option (defaults all + Meta), one ad account per client + Lane C's, Studio Generated + Static Ads rules and roots, config roots (relative = under the drive) and tag rules");

  // ---------------------------------------------------------------- seed-once
  const snap = () => seedRowsSnapshot(s1, { drive, fpc: fs.realpathSync(fpc) });
  const before = snap();
  seed(s1, { ...dirs, studio: SAMPLE });
  assert.deepEqual(snap(), before, "a second open changes nothing");
  s1.prepare("update clients set name = 'Acme (renamed in Settings)' where code = 'acme'").run();
  s1.prepare("update sections set name = 'Renamed lane' where key = 'fkbpros'").run();
  const lessOne: StudioFile = { ...SAMPLE, clients: SAMPLE.clients!.filter((c) => c.code !== "globex") };
  seed(s1, { ...dirs, studio: lessOne });
  assert.equal(s1.prepare("select name from clients where code = 'acme'").pluck().get(), "Acme (renamed in Settings)", "an app edit is never overwritten");
  assert.equal(s1.prepare("select name from sections where key = 'fkbpros'").pluck().get(), "Renamed lane");
  assert.ok(s1.prepare("select 1 from clients where code = 'globex'").get(), "a client removed from the file is not deleted");
  s1.prepare("delete from tag_rules where path_glob = 'Acme Gallery/**'").run();
  s1.prepare("delete from roots where path = ?").run(path.join(drive, "Acme Media"));
  seed(s1, { ...dirs, studio: SAMPLE });
  assert.ok(!s1.prepare("select 1 from tag_rules where path_glob = 'Acme Gallery/**'").get(), "a seeded rule removed in Settings never comes back");
  assert.ok(!s1.prepare("select 1 from roots where path = ?").get(path.join(drive, "Acme Media")), "a seeded root removed in Settings never comes back");
  fs.mkdirSync(path.join(fpc, "Initech", "Static Ads"), { recursive: true });
  const plusOne: StudioFile = { ...SAMPLE, clients: [...SAMPLE.clients!, { code: "initech", name: "Initech", metaAdAccount: "act_905", folder: "Initech" }], roots: [...SAMPLE.roots!, { path: "New Folder", lane: "fkbpros" }] };
  seed(s1, { ...dirs, studio: plusOne });
  assert.deepEqual(s1.prepare("select campaign_mode, leads_mode, sort from clients where code = 'initech'").raw().get(), ["all", "meta", 3], "a client added to the file later is inserted (defaults all + Meta)");
  assert.ok(s1.prepare("select 1 from ad_accounts where act_id = 'act_905'").get());
  assert.ok(ruleSet().has(`${drive}/Studio Generated/SGD Pros/initech/** > ["initech"]`));
  assert.ok(rootSet().has(`${fs.realpathSync(path.join(fpc, "Initech", "Static Ads"))} > fkbpros`));
  assert.ok(rootSet().has(`${drive}/New Folder > fkbpros`), "a root added to the file later is inserted");
  ok("seed-once: idempotent, never updates a lane or client edited in the app, never deletes a client dropped from the file, never brings back a root / rule removed in Settings, inserts what is added to the file later (provisioned like Settings > Add)");

  // ---------------------------------------------------------------- a pre-1b DB adopts the config
  // A DB seeded by the old constant seed: no config markers, no `folder` values. Simulated by stripping both. It first
  // starts WITHOUT a config file (an empty pass must not end the adopt window), then with one.
  s1.prepare("delete from app_settings where key like 'config:%'").run();
  s1.prepare("update clients set folder = null").run();
  s1.prepare("delete from roots where path = ?").run(path.join(base, "elsewhere"));
  const rulesBefore = s1.prepare("select count(*) from tag_rules").pluck().get();
  seed(s1, { ...dirs, studio: {} });
  assert.ok(!s1.prepare("select 1 from app_settings where key = 'config:seeded_at'").get(), "an empty pass keeps a pre-1b DB adopting");
  seed(s1, { ...dirs, studio: SAMPLE });
  assert.ok(!s1.prepare("select 1 from roots where path = ?").get(path.join(base, "elsewhere")), "adopting: a root the old seed made (and the user removed) is not re-added");
  assert.ok(!s1.prepare("select 1 from tag_rules where path_glob = 'Acme Gallery/**'").get(), "adopting: rules are marked, not inserted");
  assert.equal(s1.prepare("select count(*) from tag_rules").pluck().get(), rulesBefore);
  assert.equal(s1.prepare("select folder from clients where code = 'acme'").pluck().get(), "Acme", "adopting: the new folder column is filled once from the file");
  s1.prepare("update clients set folder = null where code = 'acme'").run();
  seed(s1, { ...dirs, studio: SAMPLE });
  assert.equal(s1.prepare("select folder from clients where code = 'acme'").pluck().get(), null, "a folder cleared later in Settings stays cleared");
  assert.ok(s1.prepare("select 1 from app_settings where key = 'config:seeded_at'").get());
  ok("a DB seeded before 1b adopts the config: its roots and tag rules are only marked (never re-inserted), also after a start without a config file, each existing client's empty folder is filled once, later clears stay");
  s1.close();

  // ---------------------------------------------------------------- the original install's seed, from its config
  const privSnap = path.join(process.cwd(), "private", "seed-snapshot.json");
  if (fs.existsSync(priv) && fs.existsSync(privSnap)) {
    const studio = parseStudioText(fs.readFileSync(priv, "utf8"));
    const want = (JSON.parse(fs.readFileSync(privSnap, "utf8")) as { rows: unknown }).rows;
    const pDrive = path.join(base, "p-drive");
    const pFpc = path.join(base, "p-fpc");
    for (const c of studio.clients ?? []) if (c.folder) fs.mkdirSync(path.join(pFpc, c.folder, "Static Ads"), { recursive: true });
    const p = freshDb("private.db");
    // The seed reads the ACTIVE profile (brand notes, starter rubric): run it under the private config's own profile.
    const { withProfile } = await import("../src/lib/profile");
    await withProfile(studio.profile, async () => seed(p, { drivePath: pDrive, clientDocsDir: pFpc, studio }));
    assert.deepEqual(seedRowsSnapshot(p, { drive: pDrive, fpc: fs.realpathSync(pFpc) }), want, "the config seed = the pre-1b constant seed, row for row");
    p.close();
    ok("a fresh DB seeded from private/studio.config.json reproduces the pre-1b constant seed (0881749) row for row: sections, clients, ad accounts, roots, tag rules, ignores, notes, settings");
  } else {
    ok("the original install's seed comparison: skipped (private)");
  }

  // ---------------------------------------------------------------- migration 0024 backfill
  const oldDir = path.join(base, "migrations-0023");
  fs.cpSync(MIGRATIONS_DIR, oldDir, { recursive: true });
  const journalFile = path.join(oldDir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === "0024_clients_lanes");
  assert.ok(at > 0);
  for (const e of journal.entries.splice(at)) fs.rmSync(path.join(oldDir, `${e.tag}.sql`));
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  const m = freshDb("pre0024.db", oldDir);
  assert.ok(!(m.prepare("select name from pragma_table_info('clients')").pluck().all() as string[]).includes("campaign_mode"));
  const insS = m.prepare("insert into sections (key, name, sort) values (?, ?, ?)");
  insS.run("rtm", "A", 0);
  insS.run("fkbpros", "B", 1);
  insS.run("fkb", "C", 2);
  const fk = m.prepare("select id from sections where key = 'fkbpros'").pluck().get() as number;
  m.prepare("insert into clients (section_id, code, name, meta_ad_account_id, sort) values (?, 'acme', 'Acme', 'act_1', 0), (?, 'northwind', 'Northwind', 'act_2', 1)").run(fk, fk);
  migrate(drizzle(m), { migrationsFolder: MIGRATIONS_DIR });
  assert.deepEqual(m.prepare("select code, campaign_mode, campaign_id, leads_mode, ghl_source, hidden_at, folder from clients order by sort").raw().all(), [
    ["acme", "state_json", null, "ghl", "acme-fb-ad", null, null],
    ["northwind", "state_json", null, "ghl", "northwind-fb-ad", null, null],
  ]);
  assert.deepEqual(m.prepare("select key, enabled, campaign_mode, leads_mode, ghl_source, ghl_location_id from sections order by sort").raw().all(), [
    ["rtm", 1, "all", "meta", null, null],
    ["fkbpros", 1, "all", "meta", null, null],
    ["fkb", 1, "all", "auto", "fkb-fb-ad", null],
  ]);
  m.prepare("insert into clients (section_id, code, name, sort) values (?, 'globex', 'Globex', 2)").run(fk);
  assert.deepEqual(m.prepare("select campaign_mode, leads_mode, ghl_source from clients where code = 'globex'").raw().get(), ["all", "meta", null], "a new client defaults to every campaign + Meta leads");
  m.close();
  ok("migration 0024 on a DB migrated to 0023: every existing client keeps the old rule (state_json + GHL + <code>-fb-ad), Lane C's account keeps its own (every campaign, Meta then GHL with <lane>-fb-ad), lanes on, nothing hidden; new clients default to every campaign + Meta leads");

  // ---------------------------------------------------------------- Settings > Clients / Lanes (lib functions)
  const a = freshDb("admin.db");
  seed(a, { ...dirs, studio: {} });
  const refused = (fn: () => unknown, msg: RegExp) => assert.throws(fn, (e: Error) => e instanceof ClientAdminError && msg.test(e.message), String(msg));
  const good = { code: "acme", name: "Acme", metaAdAccount: "act_701", hint: "", folder: "Acme", campaignMode: "all", campaignId: "", leadsMode: "meta", ghlSource: "" };
  refused(() => addClient(a, { ...good, code: "Acme!" }, dirs), /^Code: /);
  refused(() => addClient(a, { ...good, code: "all" }, dirs), /^Code: is a reserved word/);
  refused(() => addClient(a, { ...good, metaAdAccount: "123" }, dirs), /^Meta ad account: /);
  refused(() => addClient(a, { ...good, campaignMode: "one" }, dirs), /One campaign needs its campaign id/);
  refused(() => addClient(a, { ...good, leadsMode: "phone" }, dirs), /^Leads: /);
  refused(() => addClient(a, { ...good, folder: "../up" }, dirs), /^Folder: /);
  refused(() => addClient(a, { ...good, extra: 1 }, dirs), /unknown field/);
  refused(() => addClient(a, { ...good, name: "" }, dirs), /Enter a name/);
  const acmeId = addClient(a, good, dirs);
  assert.ok(acmeId > 0);
  assert.deepEqual(a.prepare("select campaign_mode, leads_mode, ghl_source, folder, classify_hint from clients where code = 'acme'").raw().get(), ["all", "meta", null, "Acme", null]);
  assert.ok(a.prepare("select 1 from ad_accounts where act_id = 'act_701' and identity = 'fpc'").get(), "Add makes the account row");
  assert.ok(a.prepare("select 1 from tag_rules where path_glob = ?").get(`${drive}/Studio Generated/SGD Pros/acme/**`), "and the Studio Generated rule");
  assert.ok(a.prepare("select 1 from roots where path = ?").get(realStatic), "and the Static Ads root (the folder exists)");
  refused(() => addClient(a, good, dirs), /already exists/);
  refused(() => addClient(a, { ...good, code: "northwind" }, dirs), /already belongs to another client/);
  addClient(a, { ...good, code: "northwind", name: "Northwind", metaAdAccount: "", folder: "" }, dirs);
  // Edit: the code is the key and never changes.
  refused(() => editClient(a, { ...good, newCode: "acme2" }, dirs), /unknown field/);
  refused(() => editClient(a, { ...good, code: "nobody" }, dirs), /does not exist/);
  editClient(a, { ...good, name: "Acme Renamed", metaAdAccount: "act_702", campaignMode: "one", campaignId: "777", leadsMode: "ghl", ghlSource: "acme-src", sort: 5 }, dirs);
  assert.deepEqual(a.prepare("select name, meta_ad_account_id, campaign_mode, campaign_id, leads_mode, ghl_source, sort from clients where code = 'acme'").raw().get(), ["Acme Renamed", "act_702", "one", "777", "ghl", "acme-src", 5]);
  assert.equal(a.prepare("select act_id from ad_accounts where client_id = ?").pluck().get(acmeId), "act_702", "an unsynced account's id may change");
  assert.equal(a.prepare("select sort from ad_accounts where client_id = ?").pluck().get(acmeId), 5, "a new sort moves the account row too");
  a.prepare("update ad_accounts set last_attempt_at = 1 where client_id = ?").run(acmeId);
  refused(() => editClient(a, { ...good, metaAdAccount: "act_703" }, dirs), /already has synced numbers/);
  assert.equal(adminClients(a).find((c) => c.code === "acme")?.accountLocked, true);
  editClient(a, { ...good, code: "northwind", name: "Northwind", metaAdAccount: "act_710", folder: "" }, dirs);
  assert.ok(a.prepare("select 1 from ad_accounts where act_id = 'act_710'").get(), "a client that gets an account later gets its row");
  editClient(a, { ...good, code: "northwind", name: "Northwind", metaAdAccount: "", folder: "" }, dirs);
  assert.ok(!a.prepare("select 1 from ad_accounts where act_id = 'act_710'").get(), "an unsynced account can be cleared");
  refused(() => setClientHidden(a, { code: "northwind", hidden: "yes" }), /^Hidden: /);
  assert.equal(setClientHidden(a, { code: "northwind", hidden: true }), true, "the validated value comes back");
  assert.ok(a.prepare("select hidden_at from clients where code = 'northwind'").pluck().get());
  refused(() => setClientHidden(a, { code: "nobody", hidden: true }), /does not exist/);
  setClientHidden(a, { code: "northwind", hidden: false });
  assert.equal(a.prepare("select hidden_at from clients where code = 'northwind'").pluck().get(), null);
  // Lanes.
  refused(() => editLane(a, { key: "fkbpros", name: "Clients", color: "#000000", enabled: false }), /cannot be switched off/);
  refused(() => editLane(a, { key: "rtm", name: "Brand", color: "red", enabled: true }), /^Color: /);
  refused(() => editLane(a, { key: "rtm", name: "x".repeat(41), color: "#000000", enabled: true }), /at most 40/);
  refused(() => editLane(a, { key: "nope", name: "A", color: "#000000", enabled: true }), /^Lane: /);
  editLane(a, { key: "fkb", name: "Our Company", color: "#abcdef", enabled: false });
  assert.deepEqual(adminLanes(a).map((l) => [l.key, l.name, l.enabled, l.canDisable]), [
    ["rtm", "Brand", true, true],
    ["fkbpros", "Clients", true, false],
    ["fkb", "Our Company", false, true],
  ]);
  a.close();
  ok("Settings > Clients / Lanes (lib): zod refusals with terse field messages (code format + reserved words, act id, one campaign needs its id, leads, folder, unknown fields), Add provisions the account row + Studio Generated rule + Static Ads root, duplicate codes / accounts refused, the code never changes, an account id changes (or clears) only while unsynced, Hide / Unhide keep the row; lanes: rename, recolor, Lane C off, Lane B never off");

  // ---------------------------------------------------------------- the server actions + hidden / off effects (live smoke DB)
  const live = getDb().sqlite;
  const r1 = await actions.addClientAction({ ...good, code: "BAD!" });
  assert.equal(r1.ok, false);
  assert.match((r1 as { error: string }).error, /^Code: /);
  // Successful actions call revalidatePath (needs a Next request); the smoke runs their lib functions for those.
  addClient(live, { ...good, code: "acmesmoke", name: "Acme Smoke", metaAdAccount: "act_100000000000099", folder: "" }, { drivePath: cfg.drivePath, clientDocsDir: cfg.clientDocsDir });
  assert.equal((await actions.setClientHiddenAction({ code: "BAD!", hidden: true })).ok, false);
  assert.equal((await actions.editLaneAction({ key: "fkbpros", name: "X", color: "#000000", enabled: false })).ok, false);
  assert.equal((await actions.editClientAction({ ...good, code: "acmesmoke", name: "Acme Smoke 2", metaAdAccount: "act_100000000000099", folder: "", code2: "x" })).ok, false, "a second code field is refused");
  const accId = live.prepare("select acc.id from ad_accounts acc join clients c on c.id = acc.client_id where c.code = 'acmesmoke'").pluck().get() as number;
  const inSync = () => listAccounts(live).some((x) => x.id === accId);
  assert.ok(inSync() && scheduledAccountIds(live, Date.now()).includes(accId) && metaAccounts(live).some((x) => x.code === "acmesmoke"));
  const nAccounts = metaSummary(live).accounts;
  assert.ok(queries.listClients().some((c) => c.code === "acmesmoke") && queries.sidebarData().clients.some((c) => c.code === "acmesmoke"));
  setClientHidden(live, { code: "acmesmoke", hidden: true });
  assert.ok(!queries.listClients().some((c) => c.code === "acmesmoke"), "hidden: not listed");
  assert.ok(queries.listClients({ includeHidden: true }).some((c) => c.code === "acmesmoke"), "the row stays");
  assert.ok(!queries.sidebarData().clients.some((c) => c.code === "acmesmoke"), "hidden: out of the sidebar (and so cmd+K)");
  assert.equal(queries.getClient("acmesmoke"), undefined, "hidden: its channel routes 404");
  assert.ok(!inSync() && !scheduledAccountIds(live, Date.now()).includes(accId) && !metaAccounts(live).some((x) => x.code === "acmesmoke"), "hidden: out of the Meta sync");
  assert.equal(metaSummary(live).accounts, nAccounts - 1);
  assert.ok(!adChannels(live).some((c) => c.code === "acmesmoke"), "hidden: no new ads");
  assert.ok(!allCoverage(live).some((c) => c.key === "acmesmoke"), "hidden: out of coverage");
  assert.deepEqual(queries.parseReviewScope("acmesmoke", queries.listClients().map((c) => c.code)), { kind: "all" }, "hidden: Review ?in= falls back");
  assert.ok(live.prepare("select 1 from ad_accounts where id = ?").get(accId), "the account row stays");
  setClientHidden(live, { code: "acmesmoke", hidden: false });
  assert.ok(inSync() && queries.getClient("acmesmoke"));
  // Lanes off: Lane A and C leave the sidebar, Review, coverage, the home page and the sync; rows stay.
  const rtmName = live.prepare("select name from sections where key = 'rtm'").pluck().get() as string;
  const rtmColor = live.prepare("select color from sections where key = 'rtm'").pluck().get() as string;
  const fkbName = live.prepare("select name from sections where key = 'fkb'").pluck().get() as string;
  const fkbColor = live.prepare("select color from sections where key = 'fkb'").pluck().get() as string;
  const laneAcc = live.prepare("select acc.id from ad_accounts acc join sections s on s.id = acc.section_id where s.key = 'fkb' and acc.client_id is null").pluck().get() as number;
  editLane(live, { key: "rtm", name: rtmName, color: rtmColor, enabled: false });
  editLane(live, { key: "fkb", name: fkbName, color: fkbColor, enabled: false });
  assert.deepEqual(queries.sidebarData().sections.map((x) => x.key), ["fkbpros"]);
  assert.equal(queries.laneHome(), "/fkbpros/all/library");
  assert.deepEqual(queries.parseReviewScope("rtm", []), { kind: "all" });
  assert.equal(queries.reviewCounts().rtm, 0, "a switched-off lane's files leave Review");
  assert.deepEqual(allCoverage(live).map((c) => c.key).filter((k) => k === "rtm" || k === "fkb"), []);
  assert.ok(!listAccounts(live).some((x) => x.id === laneAcc) && !adChannels(live).some((c) => c.code === "fkb"), "Lane C off: out of the sync and New ad");
  assert.equal(live.prepare("select count(*) from sections").pluck().get(), 3, "rows stay");
  editLane(live, { key: "rtm", name: rtmName, color: rtmColor, enabled: true });
  editLane(live, { key: "fkb", name: fkbName, color: fkbColor, enabled: true });
  assert.equal(queries.laneHome(), "/rtm/library");
  setClientHidden(live, { code: "acmesmoke", hidden: true }); // leave it out of every later count
  ok("server actions (zod via clients-admin, terse errors): a hidden client leaves the sidebar, cmd+K, channel routes, Review ?in=, coverage, New ad and the Meta sync (list, schedule, summary, Settings lines) and comes back on Unhide; Lane A / C off leave the sidebar, home, Review, coverage, New ad and the sync; every row stays");

  // ---------------------------------------------------------------- per-client sync options on stub transports
  const sdb = freshDb("sync.db");
  const metaDir = path.join(base, "meta-clients");
  fs.mkdirSync(path.join(metaDir, "globex"), { recursive: true });
  fs.writeFileSync(path.join(metaDir, "globex", "state.json"), JSON.stringify({ campaign_id: "777" }));
  const fpcEnv = path.join(metaDir, "agency.env");
  fs.writeFileSync(fpcEnv, `META_ACCESS_TOKEN=${LANE_B_TOKEN}\nGHL_API_KEY=${GHL_KEY}\nGHL_LOCATION_ID=LOCENV\n`);
  const laneEnv = path.join(base, "lane.env");
  fs.writeFileSync(laneEnv, `META_ACCESS_TOKEN=${LANE_TOKEN}\n`);
  seed(sdb, { ...dirs, studio: { ...SAMPLE, lanes: { ...SAMPLE.lanes, fkb: { ...SAMPLE.lanes!.fkb, ghlLocation: "LOCLANE" } } } });
  const graphReqs: string[] = [];
  const stubGraph = async (req: { method: string; url: string }) => {
    const u = new URL(req.url);
    const p = u.pathname.replace(/^\/v\d+\.\d+\/?/, "");
    const q = Object.fromEntries(u.searchParams);
    graphReqs.push(`${p}${q.level ? `?level=${q.level}` : ""}`);
    const json = (body: unknown) => ({ status: 200, body: JSON.stringify(body), header: () => null });
    if (/^act_\d+$/.test(p)) return json({ timezone_name: "America/New_York", id: p });
    if (/^act_\d+\/campaigns$/.test(p)) {
      const n = p.slice(4, 7);
      return json({ data: [{ id: `${n}1`, name: "Spring", effective_status: "ACTIVE" }, { id: `${n}2`, name: "Fall", effective_status: "PAUSED" }] });
    }
    if (/^\d+$/.test(p)) {
      // A campaign read by id: account_id (no act_ prefix) only when asked for; 556 sits in another account.
      const asked = (q.fields ?? "").split(",").includes("account_id");
      return json({ id: p, name: `Campaign ${p}`, effective_status: "ACTIVE", ...(asked ? { account_id: p === "556" ? "999" : "902" } : {}) });
    }
    if (/^\d+\/ads$/.test(p)) return json({ data: [] });
    if (/insights$/.test(p)) return json({ data: q.level === "account" ? [{ spend: "5", impressions: "100", clicks: "1", actions: [{ action_type: "lead", value: "2" }], date_start: "2026-10-01", date_stop: "2026-10-07" }] : [] });
    return { status: 404, body: JSON.stringify({ error: { message: "unknown", code: 803 } }), header: () => null };
  };
  const ghlReqs: { value: string; location: string }[] = [];
  const stubGhl = async (req: { method: string; url: string; body: string }) => {
    assert.equal(req.url, GHL_SEARCH_URL);
    const b = JSON.parse(req.body) as { locationId: string; filters: { value: string }[] };
    ghlReqs.push({ value: b.filters[0].value, location: b.locationId });
    return { status: 200, body: JSON.stringify({ contacts: [], total: 0 }) };
  };
  const deps = {
    graph: (identity: "fpc" | "fkb") => new MetaGraph({ identity, envFile: identity === "fkb" ? laneEnv : fpcEnv, transport: stubGraph, sleep: async () => {}, retryDelays: [1] }),
    ghl: (identity: "fpc" | "fkb") => new GhlClient({ identity, envFile: fpcEnv, transport: stubGhl, sleep: async () => {} }),
    cacheDir: path.join(base, "cache"),
    clientsDir: metaDir,
    now: () => Date.parse("2026-10-07T20:00:00Z"),
    log: () => {},
    isStopped: () => false,
  };
  const accounts = listAccounts(sdb);
  assert.deepEqual(accounts.map((x) => [x.code, x.campaign_mode, x.campaign_id, x.leads_mode, x.ghl_source, x.ghl_location_id]), [
    ["acme", "all", null, "meta", "acme-fb-ad", "LOC9"],
    ["northwind", "one", "555", "ghl", "nw-custom", "LOC9"],
    ["globex", "state_json", null, "ghl", "globex-fb-ad", "LOC9"],
    ["fkb", "all", null, "auto", "co-fb-ad", "LOCLANE"],
  ]);
  const run = async (code: string) => {
    graphReqs.length = 0;
    ghlReqs.length = 0;
    const r = await syncAccount(sdb, accounts.find((x) => x.code === code)!, deps);
    assert.ok(r.ok, `${code}: ${r.error}`);
    return sdb.prepare("select campaign_source, leads_source, ghl_error from ad_accounts where act_id = ?").raw().get(accounts.find((x) => x.code === code)!.act_id);
  };
  assert.deepEqual(await run("acme"), ["account", "meta", null]);
  assert.ok(graphReqs.includes("act_901/campaigns") && graphReqs.includes("act_901/insights?level=account"), "all = every campaign + account-level numbers");
  assert.equal(ghlReqs.length, 0, "Meta leads: no GHL read at all");
  assert.equal(sdb.prepare("select count(*) from meta_campaigns where account_id = (select id from ad_accounts where act_id = 'act_901')").pluck().get(), 2);
  assert.deepEqual(await run("northwind"), ["id", "ghl", null]);
  assert.ok(graphReqs.includes("555") && !graphReqs.some((g) => g.endsWith("/campaigns")) && !graphReqs.some((g) => g.includes("level=account")), "one = that campaign, campaign-level numbers");
  assert.deepEqual(ghlReqs, [{ value: "nw-custom", location: "LOC9" }], "GHL with the custom source and the lane's location");
  assert.deepEqual(await run("globex"), ["state.json", "ghl", null]);
  assert.ok(graphReqs.includes("777"), "state_json = the campaign id in its state.json");
  assert.deepEqual(ghlReqs, [{ value: "globex-fb-ad", location: "LOC9" }], "default source <code>-fb-ad");
  assert.deepEqual(await run("fkb"), ["account", "meta", null], "auto with no GHL contact = Meta leads");
  assert.deepEqual(ghlReqs, [{ value: "co-fb-ad", location: "LOCLANE" }]);
  // GHL key missing: `ghl` = an error on the account, `auto` = Meta leads quietly, `meta` never asks.
  fs.writeFileSync(fpcEnv, `META_ACCESS_TOKEN=${LANE_B_TOKEN}\n`);
  sdb.prepare("update sections set ghl_location_id = null").run();
  const accounts2 = listAccounts(sdb);
  const ghlMissing = async (code: string) => {
    await syncAccount(sdb, accounts2.find((x) => x.code === code)!, deps);
    return sdb.prepare("select leads_source, ghl_error is not null from ad_accounts where act_id = ?").raw().get(accounts2.find((x) => x.code === code)!.act_id);
  };
  assert.deepEqual(await ghlMissing("northwind"), ["ghl", 1]);
  assert.deepEqual(await ghlMissing("fkb"), ["meta", 0]);
  assert.deepEqual(await ghlMissing("acme"), ["meta", 0]);
  // `one` with a campaign of ANOTHER account: refused before anything is stored under this one.
  sdb.prepare("update clients set campaign_id = '556' where code = 'northwind'").run();
  const campaignsBefore = sdb.prepare("select count(*) from meta_campaigns").pluck().get();
  const other = await syncAccount(sdb, listAccounts(sdb).find((x) => x.code === "northwind")!, deps);
  assert.equal(other.ok, false);
  assert.match(other.error!, /the campaign id belongs to another ad account/);
  assert.equal(sdb.prepare("select count(*) from meta_campaigns").pluck().get(), campaignsBefore, "nothing stored for the foreign campaign");
  assert.ok(!sdb.prepare("select 1 from meta_campaigns where id = '556'").get());
  // A campaign id missing for `one` fails that account only, tersely.
  sdb.prepare("update clients set campaign_id = null where code = 'northwind'").run();
  const r = await syncAccount(sdb, listAccounts(sdb).find((x) => x.code === "northwind")!, deps);
  assert.equal(r.ok, false);
  assert.match(r.error!, /no campaign id set/);
  // seedFromConfig is exported for the worker-free paths too (the same pass seed() runs first).
  seedFromConfig(sdb, SAMPLE, dirs);
  sdb.close();
  ok("per-client sync options (stub Graph + GHL): all = every campaign + account-level numbers, one = that campaign id, state_json = the id in state.json; Meta leads never read GHL; GHL leads with the custom or default <code>-fb-ad source and the lane's GHL location (else the env file's); auto = Meta until a GHL contact carries the source; GHL key missing = an error only in ghl mode; a missing campaign id or a campaign of another ad account fails that account tersely (nothing stored)");
}
