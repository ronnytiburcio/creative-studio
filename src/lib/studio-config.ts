/**
 * The Studio config file (Creative Studio slice 1b): `STUDIO_CONFIG`, default `<settings dir>/studio.config.json`.
 * Parsed with zod once at startup by loadConfig() (fail fast: a terse error naming the bad field; values from the file are
 * never echoed). A missing file = an empty Studio: the three lanes on with neutral names, no clients.
 *
 * What it does: SEEDS lanes, clients, extra roots and tag rules ONCE (src/lib/db/seed.ts seedFromConfig: a lane or client
 * is inserted when its key is missing, never updated; after that Settings > Lanes / Clients own them). `app.name` is read
 * live (it overrides the install identity's display name).
 *
 * Shape (every key optional):
 *   app       { name }                                     display name ("Creative Studio" by default)
 *   lanes     { rtm, fkbpros, fkb }                        the three lanes (internal keys; URLs never change)
 *     rtm       { name, color, enabled }                   Lane A: your own content brand
 *     fkbpros   { name, color, ghlLocation }               Lane B: clients (always on)
 *     fkb       { name, color, enabled, metaAdAccount,     Lane C: one standalone company with its own ad account
 *                 campaigns, leads, ghlSource, ghlLocation }
 *   clients   [{ code, name, lane?, metaAdAccount?, hint?, folder?, campaigns?, leads?, ghlSource? }]   Lane B clients
 *   roots     [{ path, lane }]                             extra media folders (absolute, or relative to STUDIO_DRIVE)
 *   tagRules  [{ glob, clients }]                          folder rules: files under the glob are tagged to those clients
 *   profile   { ... }                                      the business profile (slice 1c): every business text, house
 *                                                          copy rule and naming convention; src/lib/profile-schema.ts
 *   env       { <KEY>: value }                             per install defaults for the env keys in CONFIG_ENV_KEYS
 *                                                          (slice 1d): the layer between the env file and the neutral
 *                                                          defaults (process env > env file > this > built in). A value
 *                                                          starting with `./` is relative to this file's folder.
 *
 *   campaigns: "all" (every campaign in the account, the default) | "state_json" (the account's `state.json` /
 *              `build_state.json` campaign_id in the Meta clients folder, else the name scan, else the only campaign) |
 *              { "id": "<campaign id>" } (that one campaign)
 *   leads:     "meta" (Meta's lead actions, the default; no GHL read) | "ghl" (GHL contacts whose source is ghlSource) |
 *              "auto" (Meta leads until a GHL contact carries ghlSource, then GHL leads)
 *   ghlSource: the GHL contact source value; default `<code>-fb-ad` (`<lane key>-fb-ad` for Lane C)
 *   folder:    a folder under STUDIO_CLIENT_DOCS_DIR holding the client's approved copy doc and `Static Ads/`
 *
 * Unknown keys are REFUSED (strict): a typo such as `client` for `clients` would otherwise load silently as an empty
 * Studio (the profile is strict too).
 *
 * Client safe (no fs): config.ts readStudioFile reads the file and hands the text to parseStudioText.
 */
import { z } from "zod";
import { ONE_LINE_RE, profileSchema } from "./profile-schema";

export { ONE_LINE_RE };

export const LANE_KEYS = ["rtm", "fkbpros", "fkb"] as const;
export type LaneKey = (typeof LANE_KEYS)[number];

/** Neutral built-in lane names and colors (a fresh install with no config). */
export const NEUTRAL_LANES: Record<LaneKey, { name: string; color: string; sort: number }> = {
  rtm: { name: "Brand", color: "#FF6B1A", sort: 0 },
  fkbpros: { name: "Clients", color: "#C24E0A", sort: 1 },
  fkb: { name: "Company", color: "#FFB27A", sort: 2 },
};

/**
 * The env keys a Studio config may give defaults for (`env`). Never STUDIO_CONFIG (it names this file), the test switch
 * STUDIO_FAKE_UNMOUNTED or a secret (secrets live only in env files).
 */
export const CONFIG_ENV_KEYS = [
  "STUDIO_DB",
  "STUDIO_CACHE",
  "STUDIO_LOGS",
  "STUDIO_PORT",
  "STUDIO_DRIVE",
  "STUDIO_DRIVE_MODE",
  "META_ENV_FILE",
  "META_FKB_ENV_FILE",
  "META_UNIVERSAL_REGISTRY",
  "STUDIO_BRAND_DIR",
  "STUDIO_VISION_MODEL",
  "STUDIO_OLLAMA_URL",
  "STUDIO_WHISPER_BIN",
  "STUDIO_WHISPER_MODEL",
  "STUDIO_JEV_MODEL",
  "STUDIO_CLIENT_DOCS_DIR",
  "YOUTUBE_CLIENT_SECRET_FILE",
  "YOUTUBE_TOKEN_FILE",
  "STUDIO_HANDOFFS",
  "STUDIO_REEL_KIT_DIR",
  "META_PENDING_DIR",
  "META_FKB_PENDING_DIR",
] as const;

export const CAMPAIGN_MODES = ["all", "one", "state_json"] as const;
export type CampaignMode = (typeof CAMPAIGN_MODES)[number];
export const LEADS_MODES = ["meta", "ghl", "auto"] as const;
export type LeadsMode = (typeof LEADS_MODES)[number];

/** Client codes: lowercase letters and digits (they appear in URLs, tag rules and file names). */
export const CLIENT_CODE_RE = /^[a-z0-9]{2,32}$/;
/** Codes a client can never take: route segments and the lane / copy gate channel codes. */
export const RESERVED_CODES = new Set(["all", "shared", ...LANE_KEYS]);
export const ACT_ID_RE = /^act_\d{1,30}$/;
export const CAMPAIGN_ID_RE = /^\d{1,30}$/;
export const GHL_SOURCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const GHL_LOCATION_RE = /^[A-Za-z0-9]{1,64}$/;
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** A folder NAME under STUDIO_CLIENT_DOCS_DIR (one segment: no slash, no `..`). */
export const FOLDER_NAME_RE = /^(?!\.{1,2}$)[^/\0\n]{1,120}$/;

const line = (max: number) => z.string().trim().min(1, "must not be empty").max(max, `at most ${max} characters`).regex(ONE_LINE_RE, "one line");

export const clientCode = z
  .string()
  .regex(CLIENT_CODE_RE, "2 to 32 lowercase letters or digits")
  .refine((c) => !RESERVED_CODES.has(c), "is a reserved word");
export const actId = z.string().regex(ACT_ID_RE, "must look like act_ followed by digits");
export const campaignsSchema = z.union(
  [z.enum(["all", "state_json"]), z.object({ id: z.string().regex(CAMPAIGN_ID_RE, "a numeric campaign id") }).strict()],
  { message: `"all", "state_json" or { "id": "<campaign id>" }` },
);
export const leadsSchema = z.enum(LEADS_MODES, { message: `one of ${LEADS_MODES.join(" | ")}` });
export const ghlSourceSchema = z.string().regex(GHL_SOURCE_RE, "letters, digits, dot, dash or underscore (up to 64)");
export const ghlLocationSchema = z.string().regex(GHL_LOCATION_RE, "letters and digits (a GHL location id)");
export const colorSchema = z.string().regex(HEX_COLOR_RE, "a hex color like #FF6B1A");
export const folderSchema = z.string().regex(FOLDER_NAME_RE, "one folder name (no slashes)");

const laneBase = { name: line(40).optional(), color: colorSchema.optional() };

const clientSchema = z
  .object({
    code: clientCode,
    name: line(80),
    lane: z.literal("fkbpros", { message: "clients belong to the fkbpros lane" }).optional(),
    metaAdAccount: actId.optional(),
    hint: line(300).optional(),
    folder: folderSchema.optional(),
    campaigns: campaignsSchema.optional(),
    leads: leadsSchema.optional(),
    ghlSource: ghlSourceSchema.optional(),
  })
  .strict();

export const studioFileSchema = z
  .object({
    app: z.object({ name: line(60).optional() }).strict().optional(),
    lanes: z
      .object({
        rtm: z.object({ ...laneBase, enabled: z.boolean().optional() }).strict().optional(),
        fkbpros: z
          .object({
            ...laneBase,
            enabled: z.literal(true, { message: "the clients lane cannot be switched off" }).optional(),
            ghlLocation: ghlLocationSchema.optional(),
          })
          .strict()
          .optional(),
        fkb: z
          .object({
            ...laneBase,
            enabled: z.boolean().optional(),
            metaAdAccount: actId.optional(),
            campaigns: campaignsSchema.optional(),
            leads: leadsSchema.optional(),
            ghlSource: ghlSourceSchema.optional(),
            ghlLocation: ghlLocationSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    clients: z.array(clientSchema).max(500).optional(),
    roots: z
      .array(z.object({ path: z.string().min(1).max(1000).regex(/^[^\0\n]+$/, "one line"), lane: z.enum(LANE_KEYS) }).strict())
      .max(200)
      .optional(),
    tagRules: z
      .array(
        z
          .object({ glob: z.string().trim().min(1).max(300).regex(/^[^\0\n]+$/, "one line"), clients: z.array(clientCode).min(1).max(20) })
          .strict(),
      )
      .max(1000)
      .optional(),
    /** Slice 1c: the business profile (src/lib/profile-schema.ts documents every key). */
    profile: profileSchema.optional(),
    /** Slice 1d: per install defaults for env keys (CONFIG_ENV_KEYS only; values are checked by config.ts like any value). */
    env: z.partialRecord(z.enum(CONFIG_ENV_KEYS), z.string().max(1000).regex(/^[^\0\n\r]*$/, "one line")).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const codes = new Map<string, number>();
    const acts = new Map<string, string>();
    (v.clients ?? []).forEach((c, i) => {
      if (codes.has(c.code)) ctx.addIssue({ code: "custom", path: ["clients", i, "code"], message: "duplicate client code" });
      codes.set(c.code, i);
      if (c.metaAdAccount) {
        if (acts.has(c.metaAdAccount)) ctx.addIssue({ code: "custom", path: ["clients", i, "metaAdAccount"], message: "ad account used twice" });
        acts.set(c.metaAdAccount, `clients.${i}`);
      }
    });
    const laneAct = v.lanes?.fkb?.metaAdAccount;
    if (laneAct && acts.has(laneAct)) ctx.addIssue({ code: "custom", path: ["lanes", "fkb", "metaAdAccount"], message: "ad account used twice" });
    (v.tagRules ?? []).forEach((r, i) =>
      r.clients.forEach((c, j) => {
        if (!codes.has(c)) ctx.addIssue({ code: "custom", path: ["tagRules", i, "clients", j], message: "not a client in this file" });
      }),
    );
  });

export type StudioFile = z.infer<typeof studioFileSchema>;
export type StudioClientConfig = NonNullable<StudioFile["clients"]>[number];

export const EMPTY_STUDIO: StudioFile = {};

/** Map the config's `campaigns` value onto the DB columns. */
export function campaignColumns(c: StudioClientConfig["campaigns"] | undefined): { mode: CampaignMode; id: string | null } {
  if (!c || c === "all") return { mode: "all", id: null };
  if (c === "state_json") return { mode: "state_json", id: null };
  return { mode: "one", id: c.id };
}

export class StudioConfigError extends Error {}

/**
 * Parse + validate the config text. Throws StudioConfigError naming the field path and the rule only (never a value from
 * the file; a JSON syntax error is reported without the parser's text, which can quote the file).
 */
export function parseStudioText(text: string): StudioFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StudioConfigError("is not valid JSON");
  }
  const parsed = studioFileSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    const where = i.path.length ? i.path.join(".") : "(top level)";
    const msg = i.code === "unrecognized_keys" ? `unknown key ${i.keys.map((k) => `"${k}"`).join(", ")}` : i.message;
    throw new StudioConfigError(`${where}: ${msg}`);
  }
  return parsed.data;
}
