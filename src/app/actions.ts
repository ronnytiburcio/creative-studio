"use server";
/**
 * Mutations. Everything is validated with zod; nothing here writes to a root.
 * The worker notices settings changes on its next 5 s tick. Generation is only queued here
 * (job rows); the worker runs it and writes outputs through the write guard. Describe and classify are only requested /
 * paused here (asset + app_settings columns); the worker's queues do the work. Nothing here calls Jev: Review and the
 * drawer only write the owner's answers and corrections, and the hook actions only add rows, archive them, pin them, save
 * notes or request a score (the worker's HookScoreQueue calls Jev; a notes edit never rescores by itself). Nothing here
 * calls Meta or GHL either: the Meta actions only request a sync / pause it (the worker's MetaSyncQueue reads) and set
 * or clear the owner's manual ad -> file links. YouTube (Phase 5 slice 4): Connect only creates a one-time state and returns
 * Google's URL (the code exchange happens in /api/youtube/callback), Disconnect revokes (best effort) and deletes Studio's
 * token file; the other YouTube actions only request / pause a sync or set the owner's Short -> file links. Shorts board
 * (Phase 6): "New short" only inserts a `short_moments` job row (the worker runs `claude -p`); the card actions only edit
 * card rows and, when a first line changes, request a hook score. Slice 2: Approve reads the reel's caption md through
 * the guarded text reader (read only); Cut reel writes ONE new hand-off list through src/lib/shorts/handoff.ts (Studio's
 * own folder, never the drive); Link a file / Send to Shorts only edit card rows. New PAUSED ads (Phase 6 slice 3): "Draft
 * the rest" only inserts an `ad_copy` job row (the worker runs `claude -p`); Stage re-runs every check and writes ONE new
 * order file through src/lib/meta/orders.ts (the two configured `_pending` folders, never anything else under ~/Meta);
 * Cancel rewrites Studio's own still-staged order to `cancelled`. Nothing here calls Meta or GHL.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { ClaudeError, openClaudeLogin } from "@/lib/hooks/claude";
import { disconnect as disconnectYouTube, startConnect, YouTubeAuthError } from "@/lib/youtube/auth";
import { requestYtSync, setReconnectNeeded, setYtPaused } from "@/lib/youtube/store";
import { linkShort, ShortLinkError, unlinkShort } from "@/lib/youtube/match";
import { cancelMomentJob, MomentsError, queueMoments, retryMomentJob } from "@/lib/shorts/moments";
import {
  discardShort,
  keepShort,
  makeExplainer,
  nudgeShort,
  sendHookToShorts,
  setColdOpen,
  setShortHookWords,
  setShortLayout,
  setShortsGate,
  setShortStatus,
  ShortEditError,
  SHORTS_GATE_MAX,
  SHORTS_GATE_MIN,
} from "@/lib/shorts/board";
import { approveShort, linkOutput, ShortOutputError, unlinkOutput } from "@/lib/shorts/outputs";
import { cutReel, HandoffError } from "@/lib/shorts/handoff";
import { HANDOFF_FORMATS } from "@/lib/shorts/handoff-text";
import { SHORT_LAYOUTS, SHORT_STATUS_LABEL, SHORT_STATUSES } from "@/lib/shorts/rules";
import { getConfig, notMountedMessage } from "@/lib/config";
import { driveMounted, isUnder } from "@/lib/fsguard";
import { modelSchema, toolSchema } from "@/lib/gen/catalog";
import { discardGenerated } from "@/lib/gen/details";
import { parseDestKey } from "@/lib/gen/layout";
import { planTool } from "@/lib/gen/tooljobs";
import { TOOL_IDS, toolTitle } from "@/lib/gen/tools";
import { assignRoles, mediaCounts, REF_ROLES, ROLE_LABEL, rolesFor, ruleViolations, type RefKind } from "@/lib/gen/rules";
import { applyBrandGuard, CODEX_MODEL, CODEX_SCHEMA, resolveParams, type GenInput, type ModelSchema } from "@/lib/gen/types";
import { isGenType, requestCancel, retryErrored } from "@/lib/jobs";
import { CLEAR_KINDS, clearErrors } from "@/lib/cleared";
import { originalFileFor } from "@/lib/originals";
import { writeGuardFor } from "@/lib/writeguard";
import {
  requestClassify,
  requestDescribe,
  retryClassifyErrors,
  retryDescribeErrors,
  setClassifyPaused,
  setClassifyThreshold,
  setDescribePaused,
} from "@/lib/ai/state";
import { CATEGORY_IDS, NOUL_IDS, THRESHOLD_MAX, THRESHOLD_MIN, VISUAL_FORMAT_IDS } from "@/lib/ai/classes";
import { MAX_DAILY_CAP_USD, setDailyCapUsd } from "@/lib/ai/jev";
import { confirmReview, decideClients, removeJevClient, setManualClass } from "@/lib/ai/review";
import { CopyDocError } from "@/lib/hooks/copydoc";
import { HOOK_MAX_CHARS, rubricHasFkb } from "@/lib/hooks/rubric";
import {
  addTextHooks,
  approveRescore,
  currentRubric,
  hooksPaused,
  importApprovedCopy,
  parsePasted,
  recomputeHookUnsure,
  requestChangedRescore,
  requestScore,
  requestSectionRescore,
  sectionRescorePreview,
  sectionRescoreRefusal,
  retryHookErrors,
  RubricEditError,
  saveRubricVersion,
  setHookArchived,
  setHooksPaused,
  type HookChannel,
} from "@/lib/hooks/store";
import { addVideoHook } from "@/lib/hooks/video";
import { NOTE_KEYS, NOTE_MAX, saveNote } from "@/lib/hooks/notes";
import { RUBRIC_NOTE_MAX, rubricContentSchema } from "@/lib/hooks/rubric-edit";
import type { RubricContent } from "@/lib/hooks/rubric";
import {
  cancelVariantJob,
  discardVariant,
  keepVariant,
  queueVariants,
  retryVariantJob,
  STEER_MAX,
  VariantError,
} from "@/lib/hooks/variants";
import {
  addWork,
  BRAND_NOTES_MAX,
  ClientTabError,
  editWork,
  HINT_MAX,
  moveWork,
  pinHook,
  removeWork,
  saveBrandNotes,
  saveHint,
  unpinHook,
  WORK_MAX,
} from "@/lib/hooks/client";
import { LinkError, linkAd, metaClientsDir, requestMetaSync, setMetaPaused, unlinkAd } from "@/lib/meta/store";
import { calibrationMinimumsSchema, flagThresholdsSchema } from "@/lib/meta/flags";
import { setCalibrationMinimums, setFlagThresholds } from "@/lib/meta/thresholds";
import { confirmTestOrder, setTestOrder, TestOrderError } from "@/lib/meta/test-order";
import { TEST_ANSWERS, TEST_LABEL } from "@/lib/meta/test-order-rules";
import { AdCopyError, cancelAdCopyJob, queueAdCopy, retryAdCopyJob } from "@/lib/meta/ad-copy-job";
import { cancelOrder, NOTES_MAX, ORDER_SOURCES, OrderError, stageOrder } from "@/lib/meta/orders";
import { HEADLINES_MAX, PRIMARIES_MAX } from "@/lib/meta/ad-copy-rules";
import { addClient, ClientAdminError, editClient, editLane, laneNames, setClientHidden } from "@/lib/clients-admin";

type Result = { ok: true; message?: string } | { ok: false; error: string };

const id = z.number().int().positive();
const code = z.string().regex(/^[a-z0-9]{2,32}$/);

function fail(error: string): Result {
  return { ok: false, error };
}

function done(message?: string): Result {
  revalidatePath("/", "layout");
  return { ok: true, message };
}

// ------------------------------------------------------------------ roots

export async function addRoot(input: { path: string; section: string }): Promise<Result> {
  const parsed = z
    .object({ path: z.string().min(2).max(1000), section: z.enum(["rtm", "fkbpros", "fkb"]) })
    .safeParse(input);
  if (!parsed.success) return fail("Pick a section and enter an absolute folder path.");
  const raw = parsed.data.path.trim().replace(/\/+$/, "");
  if (!path.isAbsolute(raw)) return fail(`Use an absolute path, like ${getConfig().drivePath}/Folder.`);
  let real: string;
  try {
    real = fs.realpathSync(raw);
    if (!fs.statSync(real).isDirectory()) return fail("That path is not a folder.");
  } catch {
    return fail("That folder does not exist (is the drive mounted?).");
  }
  const cfg = getConfig();
  const home = fs.realpathSync(os.homedir());
  if (real === "/") return fail("The whole disk cannot be a root. Pick a media folder.");
  if (real === home) return fail("Your home folder cannot be a root. Pick a media folder inside it.");
  const appDirs = [path.dirname(cfg.dbPath), cfg.cacheDir, cfg.logsDir];
  for (const dir of appDirs) {
    if (isUnder(real, dir)) return fail(`That folder is inside Studio's own data (${dir}).`);
    if (isUnder(dir, real)) return fail(`That folder contains Studio's own data (${dir}). Pick a narrower folder.`);
  }
  const { sqlite } = getDb();
  const roots = sqlite.prepare("select path from roots").all() as { path: string }[];
  for (const root of roots) {
    if (real === root.path) return fail("That folder is already a root.");
    if (isUnder(real, root.path)) return fail(`That folder is already inside the root ${root.path}.`);
    if (isUnder(root.path, real)) return fail(`That folder contains the existing root ${root.path}. Roots cannot overlap.`);
  }
  const section = sqlite.prepare("select id from sections where key = ?").get(parsed.data.section) as { id: number };
  sqlite
    .prepare("insert into roots (path, section_id, enabled, created_at) values (?, ?, 1, ?)")
    .run(real, section.id, Date.now());
  return done("Root added. The worker will scan it within a few seconds.");
}

export async function setRootEnabled(input: { id: number; enabled: boolean }): Promise<Result> {
  const p = z.object({ id, enabled: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid root.");
  getDb().sqlite.prepare("update roots set enabled = ? where id = ?").run(p.data.enabled ? 1 : 0, p.data.id);
  return done();
}

// ---------------------------------------------------------------- ignores

export async function addIgnore(input: { pattern: string }): Promise<Result> {
  const p = z
    .object({ pattern: z.string().trim().min(1).max(200).regex(/^[^\0\n]+$/) })
    .safeParse(input);
  if (!p.success) return fail("Enter a pattern, like build/ or *.tmp");
  try {
    getDb().sqlite.prepare("insert into ignore_patterns (pattern) values (?)").run(p.data.pattern);
  } catch {
    return fail("That pattern already exists.");
  }
  return done();
}

export async function removeIgnore(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid pattern.");
  getDb().sqlite.prepare("delete from ignore_patterns where id = ?").run(p.data.id);
  return done();
}

// ------------------------------------------------- clients + lanes (Creative Studio 1b)
// DB rows only (clients-admin.ts validates every field with zod; the code never changes once a client exists).

function clientAdmin(run: () => void, message: string | (() => string), fallback: string): Result {
  try {
    run();
  } catch (e) {
    return fail(e instanceof ClientAdminError ? e.message : fallback);
  }
  return done(typeof message === "function" ? message() : message);
}

const clientDirs = () => ({ drivePath: getConfig().drivePath, clientDocsDir: getConfig().clientDocsDir });

export async function addClientAction(input: unknown): Promise<Result> {
  return clientAdmin(() => addClient(getDb().sqlite, input, clientDirs()), "Client added.", "Could not add the client.");
}

export async function editClientAction(input: unknown): Promise<Result> {
  return clientAdmin(() => editClient(getDb().sqlite, input, clientDirs()), "Client saved.", "Could not save the client.");
}

export async function setClientHiddenAction(input: unknown): Promise<Result> {
  // Validate first: the message comes from the parsed value, never from the raw input.
  let hidden = false;
  return clientAdmin(
    () => {
      hidden = setClientHidden(getDb().sqlite, input);
    },
    () => (hidden ? "Client hidden. Its files, hooks and numbers stay." : "Client shown again."),
    "Could not change the client.",
  );
}

export async function editLaneAction(input: unknown): Promise<Result> {
  return clientAdmin(() => editLane(getDb().sqlite, input), "Lane saved.", "Could not save the lane.");
}

// -------------------------------------------------------------- tag rules

function knownCodes(): Set<string> {
  return new Set((getDb().sqlite.prepare("select code from clients").all() as { code: string }[]).map((r) => r.code));
}

export async function saveTagRule(input: { id?: number; glob: string; codes: string[] }): Promise<Result> {
  const p = z
    .object({
      id: id.optional(),
      glob: z.string().trim().min(1).max(300).regex(/^[^\0\n]+$/),
      codes: z.array(code).max(20),
    })
    .safeParse(input);
  if (!p.success) return fail("Enter a folder glob, like Client Name - Work Gallery/**");
  const known = knownCodes();
  const codes = [...new Set(p.data.codes)].filter((c) => known.has(c));
  const { sqlite } = getDb();
  if (p.data.id) {
    sqlite
      .prepare("update tag_rules set path_glob = ?, client_codes = ? where id = ?")
      .run(p.data.glob, JSON.stringify(codes), p.data.id);
  } else {
    sqlite
      .prepare("insert into tag_rules (path_glob, client_codes, created_at) values (?, ?, ?)")
      .run(p.data.glob, JSON.stringify(codes), Date.now());
  }
  return done();
}

export async function removeTagRule(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid rule.");
  getDb().sqlite.prepare("delete from tag_rules where id = ?").run(p.data.id);
  return done();
}

// ------------------------------------------------------------ asset tags

export async function setAssetClient(input: { assetId: number; code: string; on: boolean }): Promise<Result> {
  const p = z.object({ assetId: id, code, on: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid tag.");
  const { sqlite } = getDb();
  const client = sqlite.prepare("select id from clients where code = ?").get(p.data.code) as { id: number } | undefined;
  const asset = sqlite
    .prepare("select a.id from assets a join sections s on s.id = a.section_id where a.id = ? and s.key = 'fkbpros'")
    .get(p.data.assetId);
  if (!client || !asset) return fail(`Client tags only apply to ${laneNames(sqlite).fkbpros} assets.`);
  // Any chip edit is the owner's client decision (decideClients): the Jev chips they kept become manual and later classifies
  // never ask about clients again. A Jev tag removed here is also a correction (removeJevClient). Folder tags stay.
  sqlite.transaction(() => {
    if (p.data.on) {
      sqlite
        .prepare(
          `insert into asset_clients (asset_id, client_id, source, created_at) values (?, ?, 'manual', ?)
           on conflict(asset_id, client_id) do update set source = 'manual'`,
        )
        .run(p.data.assetId, client.id, Date.now());
      decideClients(sqlite, p.data.assetId);
    } else if (!removeJevClient(sqlite, p.data.assetId, p.data.code)) {
      sqlite
        .prepare("delete from asset_clients where asset_id = ? and client_id = ? and source = 'manual'")
        .run(p.data.assetId, client.id);
      decideClients(sqlite, p.data.assetId);
    }
  })();
  return done();
}

// ------------------------------------------------------------------- jobs

export async function retryJob(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid job.");
  return retryErrored(getDb().sqlite, p.data.id) ? done("Queued again.") : fail("That job is not in an error state.");
}

export async function retryAllErrors(): Promise<Result> {
  const n = retryErrored(getDb().sqlite);
  return done(`${n} job${n === 1 ? "" : "s"} queued again.`);
}

/**
 * Jobs page Clear: hides one error row (`kind` + `id`) or, with no `id`, every error showing on the page. The error text
 * is read on the server; nothing is retried, cancelled or changed. A new, different error on the same thing shows again.
 */
export async function clearErrorsAction(input: { kind?: string; id?: number }): Promise<Result> {
  const p = z.object({ kind: z.enum(CLEAR_KINDS).optional(), id: z.number().int().min(0).optional() }).safeParse(input);
  if (!p.success || (p.data.id != null && !p.data.kind)) return fail("Invalid error.");
  const n = clearErrors(getDb().sqlite, p.data.kind ? [p.data.kind] : CLEAR_KINDS, p.data.id);
  if (p.data.id != null) return n ? done() : fail("That error is already gone.");
  return done(n ? `${n} error${n === 1 ? "" : "s"} cleared.` : "No errors to clear.");
}

// ----------------------------------------------------------------- finder

export async function revealInFinder(input: { assetId: number }): Promise<Result> {
  const p = z.object({ assetId: id }).safeParse(input);
  if (!p.success) return fail("Invalid asset.");
  const original = originalFileFor(p.data.assetId);
  if (!original.ok) {
    return fail(
      original.status === 409
        ? notMountedMessage(getConfig())
        : original.status === 403
          ? "File is outside the configured roots."
          : "File not found on disk.",
    );
  }
  try {
    await new Promise<void>((resolve, reject) =>
      execFile("/usr/bin/open", ["-R", original.file], (err) => (err ? reject(err) : resolve())),
    );
  } catch {
    return fail("Finder could not open that file.");
  }
  return { ok: true };
}

// ------------------------------------------------------------- claude sign-in (Settings > Claude)

/** Opens a Terminal window on `claude auth login`; the owner finishes the sign-in there (Studio never sees a token). */
export async function openClaudeLoginAction(): Promise<Result> {
  try {
    await openClaudeLogin(getConfig().cacheDir);
  } catch (e) {
    return fail(e instanceof ClaudeError ? e.message : "Terminal could not be opened.");
  }
  return { ok: true, message: "Finish the sign-in in the Terminal window (it opens your browser)." };
}

// ------------------------------------------------------------- generate

const GenForm = z.object({
  engine: z.enum(["higgsfield", "codex"]),
  model: z.string().regex(/^[a-z0-9_]{2,64}$/),
  prompt: z.string().trim().min(1).max(4000),
  brandGuard: z.boolean(),
  params: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.union([z.string().max(500), z.number(), z.boolean()])),
  /** Tray order matters (auto roles); `role` is the owner's pick for that item, validated against the model. */
  references: z.array(z.object({ id, role: z.enum(REF_ROLES).optional() })).max(16),
  versions: z.number().int().min(1).max(4),
  dest: z.string().max(40),
  estimate: z.number().min(0).max(100_000).nullable(),
});

/**
 * Queue a generation run: one gen_image / gen_video job per version. Validation + inserts only; the worker
 * runs it (and spends Higgsfield credits). References are resolved to original paths here through
 * originalFileFor(), never taken from the request; their roles are checked against the model and its rules.
 */
export async function queueGeneration(input: z.input<typeof GenForm>): Promise<Result> {
  const p = GenForm.safeParse(input);
  if (!p.success) return fail("Check the prompt, settings and versions.");
  const f = p.data;
  // Higgsfield spends credits: the confirm must have shown a quote. ChatGPT (Codex) runs are not quoted.
  if (f.engine === "higgsfield" && f.estimate == null) return fail("No cost quote yet. Wait for the credits to show, then confirm.");
  const cfg = getConfig();
  if (!driveMounted(cfg)) return fail(notMountedMessage(cfg));
  const dest = parseDestKey(f.dest);
  if (!dest) return fail("Pick where the results go.");
  if (dest.section === "fkbpros" && dest.client && !knownCodes().has(dest.client)) return fail("Unknown client.");

  let schema: ModelSchema | null;
  if (f.engine === "codex") {
    schema = f.model === CODEX_MODEL ? CODEX_SCHEMA : null;
  } else {
    try {
      schema = await modelSchema(f.model);
    } catch {
      return fail("Higgsfield did not answer. Try again in a moment.");
    }
  }
  if (!schema) return fail("Pick a model from the list.");
  if (schema.type !== "image" && schema.type !== "video") return fail("Only image and video models are supported.");
  const kind = schema.type;
  const resolved = resolveParams(schema, f.params);
  if (!resolved.ok) return fail(resolved.error);

  const { sqlite } = getDb();
  const seen = new Set<number>();
  const refs = f.references.filter((r) => !seen.has(r.id) && seen.add(r.id));
  const rows = refs.map((r) => {
    const row = sqlite.prepare("select kind, filename from assets where id = ?").get(r.id) as { kind: RefKind; filename: string } | undefined;
    return { ...r, kind: row?.kind, filename: row?.filename ?? "a reference" };
  });
  if (rows.some((r) => !r.kind)) return fail("A reference is no longer in the Library. Remove it and try again.");
  const overrides = Object.fromEntries(rows.filter((r) => r.role).map((r) => [r.id, r.role]));
  const assigned = assignRoles(schema, rows.map((r) => ({ id: r.id, kind: r.kind! })), overrides);
  const unplaced = assigned.find((a) => !a.role);
  if (unplaced) {
    const name = rows.find((r) => r.id === unplaced.id)!.filename;
    return fail(`${schema.displayName} can't take ${name} as a reference (${unplaced.kind}).`);
  }
  for (const r of rows) {
    const got = assigned.find((a) => a.id === r.id)!.role!;
    if (!r.role || r.role === got) continue;
    return fail(
      rolesFor(schema, r.kind!).includes(r.role)
        ? `${schema.displayName} takes one ${ROLE_LABEL[r.role].toLowerCase()} only.`
        : `${schema.displayName} has no ${ROLE_LABEL[r.role].toLowerCase()} slot.`,
    );
  }
  const violations = ruleViolations(schema, resolved.effective, mediaCounts(assigned));
  if (violations.length) return fail(violations[0]);

  const references: GenInput["references"] = [];
  for (const a of assigned) {
    const original = originalFileFor(a.id);
    if (!original.ok) return fail("A reference is not available on disk. Remove it and try again.");
    references.push({ assetId: a.id, path: original.file, kind: a.kind === "video" ? "video" : "image", role: a.role! });
  }

  const runId = randomUUID();
  const now = Date.now();
  const type = kind === "video" ? "gen_video" : "gen_image";
  const insert = sqlite.prepare("insert into jobs (type, asset_id, input, status, priority, created_at) values (?, null, ?, 'pending', 0, ?)");
  sqlite.transaction(() => {
    for (let version = 1; version <= f.versions; version++) {
      const job: GenInput = {
        v: 1,
        engine: f.engine,
        kind,
        model: schema.jobType,
        modelLabel: schema.displayName,
        prompt: f.prompt,
        promptSent: applyBrandGuard(f.prompt, f.brandGuard),
        brandGuard: f.brandGuard,
        params: resolved.params,
        effectiveParams: resolved.effective,
        references,
        dest,
        version,
        versions: f.versions,
        runId,
        estimateShown: f.engine === "codex" ? null : f.estimate,
      };
      insert.run(type, JSON.stringify(job), now);
    }
  })();
  const noun = kind === "video" ? "video" : "image";
  return done(`Queued ${f.versions} ${noun}${f.versions === 1 ? "" : "s"}. They land in the Library when ready.`);
}

const ToolForm = z.object({
  assetId: id,
  tool: z.enum(TOOL_IDS),
  /** Credits the confirm showed (display only; the worker quotes again right before it creates the job). */
  estimate: z.number().min(0).max(100_000).nullable(),
});

/**
 * Queue a quick tool (Upscale / Remove background / Reframe 9:16) on one Library image or video: one gen_tool job.
 * The source is resolved through originalFileFor() and the tool's settings checked against the live schema
 * (planTool); the worker runs it and spends the credits.
 */
export async function queueTool(input: z.input<typeof ToolForm>): Promise<Result> {
  const p = ToolForm.safeParse(input);
  if (!p.success) return fail("Invalid quick tool request.");
  // Every quick tool runs on Higgsfield credits: the confirm must have shown a quote.
  if (p.data.estimate == null) return fail("No cost quote yet. Wait for the credits to show, then confirm.");
  const cfg = getConfig();
  if (!driveMounted(cfg)) return fail(notMountedMessage(cfg));
  const { sqlite } = getDb();
  let plan: Awaited<ReturnType<typeof planTool>>;
  try {
    plan = await planTool({ assetId: p.data.assetId, tool: p.data.tool, sqlite, cfg, schemaFor: toolSchema, estimateShown: p.data.estimate });
  } catch {
    return fail("Higgsfield did not answer. Try again in a moment.");
  }
  if (!plan.ok) return fail(plan.error);
  sqlite
    .prepare("insert into jobs (type, asset_id, input, status, priority, created_at) values ('gen_tool', null, ?, 'pending', 0, ?)")
    .run(JSON.stringify(plan.input), Date.now());
  return done(`${toolTitle(plan.spec.tool, plan.spec.detail)} queued. The result lands in the Library when ready.`);
}

/**
 * Cancel a generation. Any engine while it is still pending (nothing started, nothing spent); a running ChatGPT
 * (Codex) job is stopped by the worker. A running Higgsfield job cannot be cancelled: its credits are spent at
 * create and the CLI has no cancel. The pending cancel only wins if the row is still pending at update time.
 */
export async function cancelGeneration(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid job.");
  const { sqlite } = getDb();
  const row = sqlite.prepare("select type, json_extract(input, '$.engine') as engine from jobs where id = ?").get(p.data.id) as
    | { type: string; engine: string | null }
    | undefined;
  if (!row || !isGenType(row.type)) return fail("That job is not a generation.");
  const codex = row.engine === "codex";
  const r = requestCancel(sqlite, p.data.id, { running: codex });
  if (r === "cancelled") return done(codex ? "Cancelled." : "Cancelled before it started. No credits were spent.");
  if (r === "requested") return done("Cancelling. It stops within a few seconds.");
  const status = sqlite.prepare("select status from jobs where id = ?").pluck().get(p.data.id);
  if (!codex && status === "running") return fail("It already started on Higgsfield, so it can't be cancelled: the credits are spent.");
  return fail("That job is not running.");
}

/** Move a generated file and its sidecar to the macOS Trash (write guard, Studio Generated only). */
export async function discardAsset(input: { assetId: number }): Promise<Result> {
  const p = z.object({ assetId: id }).safeParse(input);
  if (!p.success) return fail("Invalid asset.");
  const cfg = getConfig();
  try {
    const r = await discardGenerated(p.data.assetId, getDb().sqlite, cfg, writeGuardFor(cfg));
    if (!r.ok) return fail(r.error);
    if (r.sidecarLeft) return done("Moved to the Trash; the generation details file could not be moved.");
  } catch {
    return fail("Could not move it to the Trash.");
  }
  return done("Moved to the Trash (file + generation details).");
}

// --------------------------------------------------------------- describe

/** "Describe again": the worker describes this asset next (even while the backfill is paused), bypassing the cache. */
export async function describeAgain(input: { assetId: number }): Promise<Result> {
  const p = z.object({ assetId: id }).safeParse(input);
  if (!p.success) return fail("Invalid asset.");
  if (!requestDescribe(getDb().sqlite, p.data.assetId)) return fail("Only images and videos in the Library can be described.");
  return done("Queued. It is described next, usually within a minute.");
}

/** Pause / resume the describe backfill and new files (persisted; the worker checks every few seconds). */
export async function setDescribePausedAction(input: { paused: boolean }): Promise<Result> {
  const p = z.object({ paused: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid request.");
  setDescribePaused(getDb().sqlite, p.data.paused);
  return done(p.data.paused ? "Describe paused. Describe again still works per file." : "Describe resumed.");
}

/** Clear every describe error so those assets go back in the queue. */
export async function retryDescribeErrorsAction(): Promise<Result> {
  const n = retryDescribeErrors(getDb().sqlite);
  return done(n ? `${n} file${n === 1 ? "" : "s"} queued again.` : "No describe errors.");
}

// --------------------------------------------------------------- classify

/** "Classify again": the worker asks Jev about this asset next (even while the backfill is paused). */
export async function classifyAgain(input: { assetId: number }): Promise<Result> {
  const p = z.object({ assetId: id }).safeParse(input);
  if (!p.success) return fail("Invalid file.");
  if (!requestClassify(getDb().sqlite, p.data.assetId)) return fail("Only described images and videos can be classified.");
  return done("Queued. Jev files it next, usually within a few seconds.");
}

/** Pause / resume the classify backfill and new files (persisted, separate from describe). */
export async function setClassifyPausedAction(input: { paused: boolean }): Promise<Result> {
  const p = z.object({ paused: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid value.");
  setClassifyPaused(getDb().sqlite, p.data.paused);
  return done(p.data.paused ? "Classify paused. Classify again still works per file." : "Classify resumed.");
}

export async function retryClassifyErrorsAction(): Promise<Result> {
  const n = retryClassifyErrors(getDb().sqlite);
  return done(n ? `${n} file${n === 1 ? "" : "s"} queued again.` : "No classify errors.");
}

export async function setClassifyThresholdAction(input: { value: number }): Promise<Result> {
  const p = z.object({ value: z.number().min(THRESHOLD_MIN).max(THRESHOLD_MAX) }).safeParse(input);
  if (!p.success) return fail(`Pick a threshold between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}.`);
  const sql = getDb().sqlite;
  const value = Math.round(p.data.value * 100) / 100;
  setClassifyThreshold(sql, value);
  // Hook scores keep their answers; their unsure marks follow the threshold at once (SQL only, no Jev).
  const n = recomputeHookUnsure(sql, value, true);
  return done(`Threshold saved. It applies to the next files Jev classifies${n ? `; unsure marks updated on ${n.toLocaleString()} hook scores` : ""}.`);
}

export async function setJevDailyCapAction(input: { usd: number }): Promise<Result> {
  const p = z.object({ usd: z.number().min(0).max(MAX_DAILY_CAP_USD) }).safeParse(input);
  if (!p.success) return fail(`Pick a daily cap between $0 and $${MAX_DAILY_CAP_USD}.`);
  setDailyCapUsd(getDb().sqlite, Math.round(p.data.usd * 100) / 100);
  return done("Daily Jev cap saved.");
}

/** Drawer category picker: the owner's class (manual, never overwritten); a change is a correction. */
export async function setAssetClassAction(input: { assetId: number; cls: string }): Promise<Result> {
  const p = z.object({ assetId: id, cls: z.enum(CATEGORY_IDS as [string, ...string[]]) }).safeParse(input);
  if (!p.success) return fail("Pick a category.");
  const r = setManualClass(getDb().sqlite, p.data.assetId, p.data.cls as (typeof CATEGORY_IDS)[number]);
  return r.ok ? done() : fail(r.error);
}

const ReviewForm = z.object({
  assetId: id,
  assetClass: z.enum(CATEGORY_IDS as [string, ...string[]]).optional(),
  clients: z.array(code).max(20).optional(),
  nouls: z.partialRecord(z.enum(NOUL_IDS), z.boolean()).optional(),
  energy: z.number().int().min(1).max(5).optional(),
  visualFormat: z.enum(VISUAL_FORMAT_IDS as [string, ...string[]]).optional(),
});

/** Review confirm: writes everything shown, stores corrections for what differs from Jev, clears needs_review. */
export async function confirmReviewAction(input: z.input<typeof ReviewForm>): Promise<Result> {
  const p = ReviewForm.safeParse(input);
  if (!p.success) return fail("Invalid review.");
  const r = confirmReview(getDb().sqlite, p.data as Parameters<typeof confirmReview>[1]);
  if (!r.ok) return fail(r.error);
  return done(r.corrections ? `Saved with ${r.corrections} correction${r.corrections === 1 ? "" : "s"}.` : "Confirmed.");
}

// ------------------------------------------------------------------ hooks (Phase 4)

const HookScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rtm") }),
  z.object({ kind: z.literal("fkbpros") }),
  z.object({ kind: z.literal("client"), code }),
  z.object({ kind: z.literal("fkb") }),
]);
type HookScopeInput = z.input<typeof HookScope>;

/** Lane A -> Lane A; Lane C -> Lane C; All clients (Lane B) -> Lane B shared (no client); a client channel -> that client. */
function channelOf(scope: z.output<typeof HookScope>): HookChannel {
  if (scope.kind === "rtm") return { section: "rtm", clientCode: null };
  if (scope.kind === "fkb") return { section: "fkb", clientCode: null };
  if (scope.kind === "fkbpros") return { section: "fkbpros", clientCode: null };
  return { section: "fkbpros", clientCode: scope.code };
}

function addedMessage(r: { added: number; skipped: number }, what = "hook"): string {
  const added = `${r.added} ${what}${r.added === 1 ? "" : "s"} added`;
  return r.skipped ? `${added}, ${r.skipped} already in this channel.` : `${added}.`;
}

/** Add one text hook (stored as typed; a duplicate in the same channel is skipped). */
export async function addHookAction(input: { scope: HookScopeInput; text: string }): Promise<Result> {
  const p = z.object({ scope: HookScope, text: z.string().trim().min(2).max(HOOK_MAX_CHARS) }).safeParse(input);
  if (!p.success) return fail(`Type a hook (2 to ${HOOK_MAX_CHARS} characters).`);
  let added: number;
  try {
    added = addTextHooks(getDb().sqlite, channelOf(p.data.scope), [{ text: p.data.text, source: "manual" }]).added;
  } catch {
    return fail("Could not add the hook.");
  }
  return added ? done("Hook added.") : fail("This channel already has that hook.");
}

/** Paste a list: one hook per line, blank lines and duplicates skipped. */
export async function pasteHooksAction(input: { scope: HookScopeInput; text: string }): Promise<Result> {
  const p = z.object({ scope: HookScope, text: z.string().max(100_000) }).safeParse(input);
  if (!p.success) return fail("Paste up to 100,000 characters, one hook per line.");
  const lines = parsePasted(p.data.text);
  if (!lines.length) return fail("Nothing to add: paste one hook per line.");
  if (lines.length > 500) return fail("Paste at most 500 hooks at a time.");
  let r: { added: number; skipped: number };
  try {
    r = addTextHooks(getDb().sqlite, channelOf(p.data.scope), lines.map((text) => ({ text, source: "pasted" as const })));
  } catch {
    return fail("Could not add the hooks.");
  }
  return done(addedMessage(r));
}

/** Import approved copy for one Lane B client (read only, re-runnable, deduped). Scoring waits while paused. */
export async function importApprovedCopyAction(input: { code: string }): Promise<Result> {
  const p = z.object({ code }).safeParse(input);
  if (!p.success) return fail("Unknown client.");
  let r: { found: number; added: number; skipped: number };
  try {
    r = importApprovedCopy(getDb().sqlite, p.data.code, getConfig().clientDocsDir);
  } catch (e) {
    return fail(e instanceof CopyDocError ? e.message : "Could not import the approved copy.");
  }
  return done(`Approved copy: ${r.found} lines found. ${addedMessage(r)}`);
}

/** Score again: the worker scores these next (even while scoring is paused). Paid (Jev), inside the daily cap. */
export async function scoreHooksAgainAction(input: { ids: number[] }): Promise<Result> {
  const p = z.object({ ids: z.array(id).min(1).max(50) }).safeParse(input);
  if (!p.success) return fail("Pick up to 50 hooks.");
  const n = requestScore(getDb().sqlite, [...new Set(p.data.ids)]);
  return n ? done(n === 1 ? "Queued for scoring." : `${n} hooks queued for scoring.`) : fail("Nothing to score (archived?).");
}

export async function archiveHookAction(input: { id: number; archived: boolean }): Promise<Result> {
  const p = z.object({ id, archived: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid hook.");
  return setHookArchived(getDb().sqlite, p.data.id, p.data.archived) ? done(p.data.archived ? "Archived." : "Restored.") : fail("Hook not found.");
}

export async function setHooksPausedAction(input: { paused: boolean }): Promise<Result> {
  const p = z.object({ paused: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid value.");
  setHooksPaused(getDb().sqlite, p.data.paused);
  return done(p.data.paused ? "Hook scoring paused. Score again still works." : "Hook scoring resumed.");
}

/**
 * Score again every hook in this Hooks tab (and view) whose score no longer matches its inputs: older notes, or a video
 * described again after its score (the "changed since scored" banner's button). The ids are recomputed here, never
 * taken from the page.
 */
export async function rescoreChangedAction(input: { scope: HookScopeInput; view: "text" | "video" }): Promise<Result> {
  const p = z.object({ scope: HookScope, view: z.enum(["text", "video"]) }).safeParse(input);
  if (!p.success) return fail("Invalid channel.");
  const n = requestChangedRescore(getDb().sqlite, p.data.scope, p.data.view);
  return n ? done(`${n} ${n === 1 ? "hook" : "hooks"} queued for scoring with the current notes and descriptions.`) : fail("Nothing to rescore: every hook here is up to date.");
}

// ------------------------------------------------------------------ video hooks + Client tab (Phase 4 slice 2)

/** "Add as hook" (drawer): the video's hook row (same text + channel rules as the worker's sync). Scoring waits for the queue. */
export async function addVideoHookAction(input: { assetId: number }): Promise<Result> {
  const p = z.object({ assetId: id }).safeParse(input);
  if (!p.success) return fail("Invalid file.");
  const r = addVideoHook(getDb().sqlite, p.data.assetId);
  if (!r.ok) return fail(r.error);
  return done(r.created ? "Added as a video hook." : "This video is already a hook.");
}

function clientTabFail(e: unknown, fallback: string): Result {
  return fail(e instanceof ClientTabError ? e.message : fallback);
}

/** Save a client's brand notes (the "Draft, check me" label goes away). Hooks are not rescored: the tab flags them. */
export async function saveBrandNotesAction(input: { code: string; body: string }): Promise<Result> {
  const p = z.object({ code, body: z.string().max(BRAND_NOTES_MAX) }).safeParse(input);
  if (!p.success) return fail(`Brand notes: up to ${BRAND_NOTES_MAX.toLocaleString()} characters.`);
  try {
    saveBrandNotes(getDb().sqlite, p.data.code, p.data.body);
  } catch (e) {
    return clientTabFail(e, "Could not save the brand notes.");
  }
  return done("Brand notes saved.");
}

/** Save the one-line Jev hint. Classify reads it from its next call; files already classified are not re-filed. */
export async function saveClientHintAction(input: { code: string; hint: string }): Promise<Result> {
  const p = z.object({ code, hint: z.string().max(HINT_MAX) }).safeParse(input);
  if (!p.success) return fail(`The hint is one line, up to ${HINT_MAX} characters.`);
  try {
    saveHint(getDb().sqlite, p.data.code, p.data.hint);
  } catch (e) {
    return clientTabFail(e, "Could not save the hint.");
  }
  return done("Hint saved.");
}

export async function addWorkAction(input: { code: string; body: string }): Promise<Result> {
  const p = z.object({ code, body: z.string().trim().min(2).max(WORK_MAX) }).safeParse(input);
  if (!p.success) return fail(`Type what works (2 to ${WORK_MAX} characters).`);
  try {
    addWork(getDb().sqlite, p.data.code, p.data.body);
  } catch (e) {
    return clientTabFail(e, "Could not add the item.");
  }
  return done();
}

export async function editWorkAction(input: { code: string; id: number; body: string }): Promise<Result> {
  const p = z.object({ code, id, body: z.string().trim().min(2).max(WORK_MAX) }).safeParse(input);
  if (!p.success) return fail(`An item is 2 to ${WORK_MAX} characters.`);
  try {
    editWork(getDb().sqlite, p.data.code, p.data.id, p.data.body);
  } catch (e) {
    return clientTabFail(e, "Could not save the item.");
  }
  return done();
}

export async function removeWorkAction(input: { code: string; id: number }): Promise<Result> {
  const p = z.object({ code, id }).safeParse(input);
  if (!p.success) return fail("Invalid item.");
  try {
    removeWork(getDb().sqlite, p.data.code, p.data.id);
  } catch (e) {
    return clientTabFail(e, "Could not remove the item.");
  }
  return done();
}

export async function moveWorkAction(input: { code: string; id: number; dir: "up" | "down" }): Promise<Result> {
  const p = z.object({ code, id, dir: z.enum(["up", "down"]) }).safeParse(input);
  if (!p.success) return fail("Invalid move.");
  try {
    moveWork(getDb().sqlite, p.data.code, p.data.id, p.data.dir);
  } catch (e) {
    return clientTabFail(e, "Could not move the item.");
  }
  return done();
}

/** Pin a client hook to its client's "What works here" (or unpin it). */
export async function pinHookAction(input: { hookId: number; pinned: boolean }): Promise<Result> {
  const p = z.object({ hookId: id, pinned: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid hook.");
  const sql = getDb().sqlite;
  if (!p.data.pinned) return unpinHook(sql, p.data.hookId) ? done("Unpinned.") : fail("It was not pinned.");
  try {
    pinHook(sql, p.data.hookId);
  } catch (e) {
    return clientTabFail(e, "Could not pin the hook.");
  }
  return done("Pinned to What works here.");
}

// ------------------------------------------------------------------ rewrite variants + rubric editing (Phase 4 slice 3)

/**
 * "Rewrite variants": queue a hook_variants job (the worker runs `claude -p` on the owner's subscription, one at a time).
 * The optional steer is one line. Nothing runs in the web process.
 */
export async function queueVariantsAction(input: { hookId: number; steer?: string }): Promise<Result> {
  const p = z.object({ hookId: id, steer: z.string().max(STEER_MAX * 2).optional() }).safeParse(input);
  if (!p.success) return fail(`The steer is one line, up to ${STEER_MAX} characters.`);
  if ((p.data.steer ?? "").replace(/\s+/g, " ").trim().length > STEER_MAX) return fail(`The steer is one line, up to ${STEER_MAX} characters.`);
  try {
    queueVariants(getDb().sqlite, p.data.hookId, p.data.steer ?? null);
  } catch (e) {
    return fail(e instanceof VariantError ? e.message : "Could not queue the rewrite.");
  }
  return done("Writing 5 variants. They show under the hook when they are scored.");
}

/** Cancel a variants job that has not started. */
export async function cancelVariantJobAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid job.");
  return cancelVariantJob(getDb().sqlite, p.data.id) ? done("Cancelled before it started.") : fail("Only a waiting job can be cancelled.");
}

/** Retry a failed or cancelled variants job (one more claude run). */
export async function retryVariantJobAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid job.");
  try {
    return retryVariantJob(getDb().sqlite, p.data.id) ? done("Queued again.") : fail("That job is not in an error state.");
  } catch (e) {
    return fail(e instanceof VariantError ? e.message : "Could not retry.");
  }
}

/** Keep a variant (a normal hook in its channel from now on) or discard it (archived). */
export async function decideVariantAction(input: { id: number; keep: boolean }): Promise<Result> {
  const p = z.object({ id, keep: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid variant.");
  const sql = getDb().sqlite;
  if (p.data.keep) return keepVariant(sql, p.data.id) ? done("Kept: it is a normal hook in this channel now.") : fail("Already decided.");
  return discardVariant(sql, p.data.id) ? done("Discarded.") : fail("Already decided.");
}

/**
 * Save an edited rubric as a new version (never in place). Nothing is rescored: the Rubric page then shows
 * "N hooks will be rescored, about $X" and waits for the Rescore click. The full checks live in saveRubricVersion.
 */
export async function saveRubricAction(input: { content: RubricContent; note: string }): Promise<Result> {
  const sql = getDb().sqlite;
  // The one rubric schema (rubric-edit.ts), built on the current version's mechanics; saveRubricVersion runs it again.
  const cur = currentRubric(sql);
  const p = z.object({ content: rubricContentSchema(cur.mechanics, rubricHasFkb(cur), laneNames(sql)), note: z.string().max(RUBRIC_NOTE_MAX * 2) }).safeParse(input);
  if (!p.success) return fail(p.error.issues.find((i) => i.code === "custom")?.message ?? "The rubric form is malformed.");
  try {
    const v = saveRubricVersion(sql, p.data.content, p.data.note);
    return done(`Saved as v${v}. Nothing is rescored until you click Rescore.`);
  } catch (e) {
    return fail(e instanceof RubricEditError ? e.message : "Could not save the rubric.");
  }
}

/** The owner's Rescore click for the current version (optionally resuming scoring, which is what runs it). Paid (Jev). */
export async function rescoreAction(input: { resume: boolean }): Promise<Result> {
  const p = z.object({ resume: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid value.");
  const sql = getDb().sqlite;
  const n = approveRescore(sql);
  if (p.data.resume) setHooksPaused(sql, false);
  if (!n) return done("Nothing to rescore.");
  return done(`${n.toLocaleString()} hooks will be rescored ${hooksPaused(sql) ? "when scoring resumes." : "now, inside the daily cap."}`);
}

/**
 * "Rescore <Lane A> hooks on vN" (the Lane A Hooks tab, landing page Phase 2 slice 1): Score again for the Lane A hooks
 * that carry an older score and none for the current version. Lane A only (never Lane B / Lane C: that is the global
 * Rescore). Paid (Jev, inside the daily cap); requests run even while scoring is paused.
 */
export async function rescoreSectionAction(input: { section: "rtm" }): Promise<Result> {
  const p = z.object({ section: z.literal("rtm") }).strict().safeParse(input);
  if (!p.success) return fail("Invalid section.");
  const sql = getDb().sqlite;
  // Re-checked here, never trusted from the page: Lane A changed in the current version, no global Rescore, something left.
  const refused = sectionRescoreRefusal(sectionRescorePreview(sql, p.data.section));
  if (refused) return fail(refused);
  const n = requestSectionRescore(sql, p.data.section);
  return n ? done(`${n.toLocaleString()} ${laneNames(sql).rtm} ${n === 1 ? "hook" : "hooks"} queued for scoring on the current rubric version.`) : fail("Nothing to rescore.");
}

/** Save the Lane A notes or the who's who note (not versioned; the Hooks tabs flag the hooks scored with the old text). */
export async function saveNoteAction(input: { key: string; body: string }): Promise<Result> {
  const p = z.object({ key: z.enum(NOTE_KEYS), body: z.string().max(NOTE_MAX) }).safeParse(input);
  if (!p.success) return fail(`Notes: up to ${NOTE_MAX.toLocaleString()} characters.`);
  saveNote(getDb().sqlite, p.data.key, p.data.body);
  return done("Saved. Hooks scored with the old notes show Notes changed; nothing rescores until you click.");
}

/** Jobs page: Score again every hook whose last scoring failed. */
export async function retryHookErrorsAction(): Promise<Result> {
  const n = retryHookErrors(getDb().sqlite);
  return done(n ? `${n} hook${n === 1 ? "" : "s"} queued for scoring again.` : "No scoring errors.");
}

// ------------------------------------------------------------------ Meta sync + Running tab (Phase 5 slice 1)

/** Refresh: the worker syncs every Meta account (and GHL leads) on its next poll, even while the daily run is paused. */
export async function requestMetaSyncAction(): Promise<Result> {
  requestMetaSync(getDb().sqlite);
  return done("Meta sync queued. The worker starts it within 15 seconds.");
}

export async function setMetaPausedAction(input: { paused: boolean }): Promise<Result> {
  const p = z.object({ paused: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid value.");
  setMetaPaused(getDb().sqlite, p.data.paused);
  return done(p.data.paused ? "Daily Meta sync paused. Refresh still works." : "Daily Meta sync resumed.");
}

/** "Link a file": the owner's own ad -> file link (kept across syncs). The file must be visible and in the ad's section. */
export async function linkAdAction(input: { adId: number; assetId: number }): Promise<Result> {
  const p = z.object({ adId: id, assetId: id }).safeParse(input);
  if (!p.success) return fail("Invalid ad or file.");
  try {
    const r = linkAd(getDb().sqlite, p.data.adId, p.data.assetId);
    return done(`Linked to ${r.filename}.`);
  } catch (e) {
    return fail(e instanceof LinkError ? e.message : "Could not link that file.");
  }
}

/** Unlink a manual link: the ad goes back to the automatic match (the ad map, then the Meta media name). */
export async function unlinkAdAction(input: { adId: number }): Promise<Result> {
  const p = z.object({ adId: id }).safeParse(input);
  if (!p.success) return fail("Invalid ad.");
  try {
    const cfg = getConfig();
    const r = unlinkAd(getDb().sqlite, p.data.adId, metaClientsDir(cfg.metaEnvFile), cfg.universalRegistry);
    return done(r.rematched ? "Unlinked. The automatic match is back." : "Unlinked. No local file matches this ad.");
  } catch (e) {
    return fail(e instanceof LinkError ? e.message : "Could not unlink.");
  }
}

// ------------------------------------------------------------------ Flags, calibration minimums, test order (Phase 5 slice 3)

/** Running flag thresholds (Settings, Meta card). `null` = back to the defaults. Flags never act. */
export async function saveFlagThresholdsAction(input: unknown): Promise<Result> {
  if (input === null) {
    setFlagThresholds(getDb().sqlite, null);
    return done("Flag thresholds reset to the defaults.");
  }
  const p = flagThresholdsSchema.safeParse(input);
  if (!p.success) return fail("Check the numbers: frequency 1 to 20, drops and CPL margin 5 to 90%, 100+ impressions, 1 to 100 leads.");
  setFlagThresholds(getDb().sqlite, p.data);
  return done("Flag thresholds saved.");
}

/** Calibration minimum sample (Settings, Meta card). `null` = back to the defaults. */
export async function saveCalibrationMinimumsAction(input: unknown): Promise<Result> {
  if (input === null) {
    setCalibrationMinimums(getDb().sqlite, null);
    return done("Calibration minimums reset to the defaults.");
  }
  const p = calibrationMinimumsSchema.safeParse(input);
  if (!p.success) return fail("Check the numbers: 100+ impressions, 1 to 100 leads, 10+ views, 3 to 100 hooks and 3 to 1,000 ad groups per cell.");
  setCalibrationMinimums(getDb().sqlite, p.data);
  return done("Calibration minimums saved.");
}

const testBatch = z.object({ code: z.string().regex(/^(?:[a-z0-9]{2,32})$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** Client tab: confirm what Studio suggests a batch of new ads tested. */
export async function confirmTestOrderAction(input: { code: string; date: string }): Promise<Result> {
  const p = testBatch.safeParse(input);
  if (!p.success) return fail("Invalid batch.");
  try {
    const a = confirmTestOrder(getDb().sqlite, p.data.code, p.data.date);
    return done(`Confirmed: ${TEST_LABEL[a]}${a === "none" ? "" : " test"}.`);
  } catch (e) {
    return fail(e instanceof TestOrderError ? e.message : "Could not save that.");
  }
}

/** Client tab: set a batch's variable by hand (offer, hook, format, copy or not a test). */
export async function setTestOrderAction(input: { code: string; date: string; variable: string }): Promise<Result> {
  const p = testBatch.extend({ variable: z.enum(TEST_ANSWERS as [string, ...string[]]) }).safeParse(input);
  if (!p.success) return fail("Pick offer, hook, format, copy or not a test.");
  try {
    setTestOrder(getDb().sqlite, p.data.code, p.data.date, p.data.variable as (typeof TEST_ANSWERS)[number]);
    return done(`Saved: ${TEST_LABEL[p.data.variable as (typeof TEST_ANSWERS)[number]]}${p.data.variable === "none" ? "" : " test"}.`);
  } catch (e) {
    return fail(e instanceof TestOrderError ? e.message : "Could not save that.");
  }
}

// ------------------------------------------------------------------ YouTube Shorts (Phase 5 slice 4)

/**
 * Connect / Reconnect YouTube: a one-time state + PKCE verifier stored server side (10 minutes) and Google's consent URL
 * for the page to open in a new tab. Nothing is sent to Google here; the owner completes the consent themselves.
 */
export async function connectYouTubeAction(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    return { ok: true, url: startConnect(getDb().sqlite, getConfig()).url };
  } catch (e) {
    return { ok: false, error: e instanceof YouTubeAuthError ? e.message : "Could not start the YouTube connection." };
  }
}

/** Disconnect: revoke at Google (best effort) and delete Studio's token file. The skill's upload token is untouched. */
export async function disconnectYouTubeAction(): Promise<Result> {
  const r = await disconnectYouTube(getConfig());
  setReconnectNeeded(getDb().sqlite, false);
  if (!r.hadToken) return done("YouTube was not connected.");
  return done(r.revoked ? "YouTube disconnected and access revoked at Google." : "YouTube disconnected (Google did not confirm the revoke; you can remove Studio's access in your Google account).");
}

export async function requestYouTubeSyncAction(): Promise<Result> {
  requestYtSync(getDb().sqlite);
  return done("YouTube sync queued. The worker starts it within 15 seconds.");
}

export async function setYouTubePausedAction(input: { paused: boolean }): Promise<Result> {
  const p = z.object({ paused: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid value.");
  setYtPaused(getDb().sqlite, p.data.paused);
  return done(p.data.paused ? "Daily YouTube sync paused. Sync now still works." : "Daily YouTube sync resumed.");
}

const videoId = z.string().regex(/^[A-Za-z0-9_-]{6,20}$/);

/** "Link a file" on a Short: the owner's link to a Lane A video (kept across syncs); its video hook is linked (made if described). */
export async function linkShortAction(input: { videoId: string; assetId: number }): Promise<Result> {
  const p = z.object({ videoId, assetId: id }).safeParse(input);
  if (!p.success) return fail("Invalid Short or file.");
  try {
    const r = linkShort(getDb().sqlite, p.data.videoId, p.data.assetId);
    return done(`Linked to ${r.filename}.${r.hookCreated ? " Its video hook was added (it scores on its own)." : ""}`);
  } catch (e) {
    return fail(e instanceof ShortLinkError ? e.message : "Could not link that file.");
  }
}

/** Unlink a manual Short link: back to the automatic title + duration match. */
export async function unlinkShortAction(input: { videoId: string }): Promise<Result> {
  const p = z.object({ videoId }).safeParse(input);
  if (!p.success) return fail("Invalid Short.");
  try {
    const r = unlinkShort(getDb().sqlite, p.data.videoId);
    return done(r.rematched ? "Unlinked. The automatic match found a file." : "Unlinked. No file matches automatically.");
  } catch (e) {
    return fail(e instanceof ShortLinkError ? e.message : "Could not unlink.");
  }
}

// ------------------------------------------------------------------ Shorts board (Phase 6 slice 1)
// Only job rows and card edits: the worker's ShortMomentsQueue runs `claude -p`; Jev only through the HookScoreQueue (a
// card whose first line changes only requests a score). Nothing here reads or writes the drive.

/** "New short": queue a moments job for an episode (one claude run on the subscription, in the worker). */
export async function newShortAction(input: { episodeId: number }): Promise<Result> {
  const p = z.object({ episodeId: id }).safeParse(input);
  if (!p.success) return fail("Invalid episode.");
  try {
    queueMoments(getDb().sqlite, p.data.episodeId);
  } catch (e) {
    return fail(e instanceof MomentsError ? e.message : "Could not queue the moments.");
  }
  return done("Writing moments. They land in Idea in about a minute, then Jev scores their first lines.");
}

/** Cancel a moments job that has not started. */
export async function cancelShortJobAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid job.");
  return cancelMomentJob(getDb().sqlite, p.data.id) ? done("Cancelled before it started.") : fail("Only a waiting job can be cancelled.");
}

/** Retry a failed or cancelled moments job (one more claude run). */
export async function retryShortJobAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid job.");
  try {
    return retryMomentJob(getDb().sqlite, p.data.id) ? done("Queued again.") : fail("That job is not in an error state.");
  } catch (e) {
    return fail(e instanceof MomentsError ? e.message : "Could not retry.");
  }
}

const shortEdit = <T,>(fn: () => T, ok: (r: T) => Result): Result => {
  try {
    return ok(fn());
  } catch (e) {
    return fail(e instanceof ShortEditError ? e.message : "Could not change the card.");
  }
};

/** Keep (stays in its column, marked kept) or Discard (archived with the hook made for it). */
export async function decideShortAction(input: { id: number; keep: boolean }): Promise<Result> {
  const p = z.object({ id, keep: z.boolean() }).safeParse(input);
  if (!p.success) return fail("Invalid card.");
  const sql = getDb().sqlite;
  if (p.data.keep) return keepShort(sql, p.data.id) ? done("Kept.") : fail("Already decided.");
  return discardShort(sql, p.data.id) ? done("Discarded.") : fail("Already discarded.");
}

/** Move a card to any column by hand. */
export async function setShortStatusAction(input: { id: number; status: string }): Promise<Result> {
  const p = z.object({ id, status: z.enum(SHORT_STATUSES) }).safeParse(input);
  if (!p.success) return fail("Invalid card or column.");
  return shortEdit(
    () => setShortStatus(getDb().sqlite, p.data.id, p.data.status),
    (moved) => (moved ? done(`Moved to ${SHORT_STATUS_LABEL[p.data.status]}.`) : done()),
  );
}

/** Start or end one cue earlier / later (re-snapped, 30 to 90 s; a new first line requests a rescore). */
export async function nudgeShortAction(input: { id: number; edge: "start" | "end"; dir: -1 | 1 }): Promise<Result> {
  const p = z.object({ id, edge: z.enum(["start", "end"]), dir: z.union([z.literal(-1), z.literal(1)]) }).safeParse(input);
  if (!p.success) return fail("Invalid nudge.");
  return shortEdit(
    () => nudgeShort(getDb().sqlite, p.data.id, p.data.edge, p.data.dir),
    (r) =>
      done(
        [r.hookChanged ? "New first line: its hook is being scored again." : "", r.coldCleared ? "The cold open fell outside the moment: pick a new one." : ""]
          .filter(Boolean)
          .join(" ") || undefined,
      ),
  );
}

/** The opening headline (2 to 6 caps words, one optional `*...*` orange block, Lane A copy rules). */
export async function setShortHookWordsAction(input: { id: number; words: string }): Promise<Result> {
  const p = z.object({ id, words: z.string().min(1).max(80) }).safeParse(input);
  if (!p.success) return fail("The hook is 2 to 6 words.");
  return shortEdit(
    () => setShortHookWords(getDb().sqlite, p.data.id, p.data.words),
    () => done("Hook saved."),
  );
}

export async function setShortLayoutAction(input: { id: number; layout: string }): Promise<Result> {
  const p = z.object({ id, layout: z.enum(SHORT_LAYOUTS) }).safeParse(input);
  if (!p.success) return fail("Invalid layout.");
  return shortEdit(
    () => setShortLayout(getDb().sqlite, p.data.id, p.data.layout),
    () => done(),
  );
}

// ------------------------------------------------------------------ Shorts board (Phase 7 slice 2)
// Card edits and one setting only: a new cold open only links / makes its hook and requests a score (the worker's
// HookScoreQueue scores it); Make explainer only adds an explainer idea card. Nothing here reads or writes the drive.

/** Set or swap a card's cold open: one or two adjacent sentences of its moment (raw times, re-checked on the server). */
export async function setColdOpenAction(input: { id: number; start: number; end: number }): Promise<Result> {
  const t = z.number().finite().min(0).max(100_000);
  const p = z.object({ id, start: t, end: t }).refine((v) => v.end > v.start).safeParse(input);
  if (!p.success) return fail("Pick one or two sentences of the moment.");
  return shortEdit(
    () => setColdOpen(getDb().sqlite, p.data.id, { start: p.data.start, end: p.data.end }),
    () => done("Cold open set. Jev scores it as the card's main hook."),
  );
}

/** Make explainer: Send to Shorts on an episode card's main hook (an explainer idea card that remembers the moment). */
export async function makeExplainerAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid card.");
  return shortEdit(
    () => makeExplainer(getDb().sqlite, p.data.id),
    (r) => done(r.created ? "Explainer idea added to Idea." : "That hook already has an explainer idea on the board."),
  );
}

/** The Shorts board's hook gate (Settings): undecided Idea cards whose main hook scores under it sit behind Show weaker. */
export async function setShortsGateAction(input: { value: number }): Promise<Result> {
  const p = z.object({ value: z.number().finite().min(SHORTS_GATE_MIN).max(SHORTS_GATE_MAX) }).safeParse(input);
  if (!p.success) return fail(`The gate is ${SHORTS_GATE_MIN} to ${SHORTS_GATE_MAX}.`);
  return shortEdit(
    () => setShortsGate(getDb().sqlite, p.data.value),
    () => done(`Shorts gate saved: ${p.data.value.toFixed(1)}.`),
  );
}

// ------------------------------------------------------------------ Shorts board (Phase 6 slice 2)
// Approve reads the caption through the guarded text reader (.md, read only); Cut reel writes one NEW list in Studio's
// hand-off folder (src/lib/shorts/handoff.ts); nothing here writes to the drive, runs a skill or renders anything.

const outputErr = (e: unknown, fallback: string): Result =>
  fail(e instanceof ShortOutputError || e instanceof ShortEditError || e instanceof HandoffError ? e.message : fallback);

/** Approve (Review -> Ready to post): needs the reel's caption md. */
export async function approveShortAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid card.");
  try {
    const r = approveShort(getDb().sqlite, p.data.id, getConfig());
    return done(r.posted ? "Approved. Its Short is already linked: moved to Posted." : "Approved: ready to post.");
  } catch (e) {
    return outputErr(e, "Could not approve.");
  }
}

/** Link a file: the owner's reel for a card (a Lane A video). Idea / Cutting move to Review. */
export async function linkShortOutputAction(input: { id: number; assetId: number }): Promise<Result> {
  const p = z.object({ id, assetId: id }).safeParse(input);
  if (!p.success) return fail("Invalid card or file.");
  try {
    const r = linkOutput(getDb().sqlite, p.data.id, p.data.assetId, getConfig());
    return done(`Linked ${r.filename}.${r.moved ? " Moved to Review." : ""}`);
  } catch (e) {
    return outputErr(e, "Could not link that file.");
  }
}

/** Unlink the owner's file: back to the automatic match. */
export async function unlinkShortOutputAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid card.");
  try {
    const r = unlinkOutput(getDb().sqlite, p.data.id, getConfig());
    return done(r.rematched ? "Unlinked. The automatic match found the reel file." : "Unlinked. No reel file matches automatically yet.");
  } catch (e) {
    return outputErr(e, "Could not unlink.");
  }
}

/** Send to Shorts (Hooks tab, Lane A hooks only): an explainer idea card on the board. */
export async function sendHookToShortsAction(input: { hookId: number }): Promise<Result> {
  const p = z.object({ hookId: id }).safeParse(input);
  if (!p.success) return fail("Invalid hook.");
  try {
    const r = sendHookToShorts(getDb().sqlite, p.data.hookId);
    return done(r.created ? "Sent to the Shorts board as an explainer idea." : "Already on the Shorts board.");
  } catch (e) {
    return outputErr(e, "Could not send it to Shorts.");
  }
}

/**
 * Cut reel: kept Idea cards of one episode -> a NEW `<prefix>N reels.json` in Studio's hand-off folder + the paste line;
 * the cards move to Cutting. Nothing runs and nothing is rendered: the owner pastes the line into a live session.
 */
export async function cutReelAction(input: {
  episodeId: number;
  cardIds: number[];
  format: string;
}): Promise<{ ok: true; path: string; line: string; message: string } | { ok: false; error: string }> {
  const p = z
    .object({ episodeId: id, cardIds: z.array(id).min(1).max(20), format: z.enum(HANDOFF_FORMATS) })
    .safeParse(input);
  if (!p.success) return { ok: false, error: "Pick an episode, at least one kept idea and a format." };
  try {
    const r = cutReel(getDb().sqlite, getConfig(), p.data);
    return { ok: true, path: r.path, line: r.line, message: `Hand-off written. ${r.cards} card${r.cards === 1 ? "" : "s"} moved to Cutting.` };
  } catch (e) {
    const msg = e instanceof HandoffError ? e.message : "Could not write the hand-off.";
    return { ok: false, error: msg };
  }
}

// ------------------------------------------------------------------ new PAUSED Meta ads (Phase 6 slice 3)

const adCopySchema = z.object({
  headlines: z.array(z.string().max(400)).max(HEADLINES_MAX),
  primaries: z.array(z.string().max(2500)).max(PRIMARIES_MAX),
  description: z.string().max(400),
});

/**
 * "Draft the rest": queue an `ad_copy` job (the worker runs `claude -p` on the owner's subscription, one at a time). The
 * dialog sends what it holds now; the draft only fills the slots still empty when it lands.
 */
export async function queueAdCopyAction(input: {
  channel: string;
  hookId: number | null;
  angleKey: string | null;
  filled: { headlines: string[]; primaries: string[]; description: string };
  p1Opening?: string | null;
}): Promise<{ ok: true; jobId: number } | { ok: false; error: string }> {
  const p = z
    .object({ channel: code, hookId: id.nullable(), angleKey: z.string().max(80).nullable(), filled: adCopySchema, p1Opening: z.string().max(400).nullable().optional() })
    .safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid draft request." };
  try {
    return { ok: true, jobId: queueAdCopy(getDb().sqlite, p.data) };
  } catch (e) {
    return { ok: false, error: e instanceof AdCopyError ? e.message : "Could not queue the draft." };
  }
}

/** Cancel a Draft the rest job that has not started. */
export async function cancelAdCopyJobAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid job.");
  return cancelAdCopyJob(getDb().sqlite, p.data.id) ? done("Cancelled before it started.") : fail("Only a waiting job can be cancelled.");
}

/** Retry a failed or cancelled Draft the rest job (one more claude run). */
export async function retryAdCopyJobAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid job.");
  try {
    return retryAdCopyJob(getDb().sqlite, p.data.id) ? done("Queued again.") : fail("That job is not in an error state.");
  } catch (e) {
    return fail(e instanceof AdCopyError ? e.message : "Could not retry.");
  }
}

/**
 * Stage: every check runs again on the server (channel + account, media via originalFileFor, every copy rule, naming),
 * then ONE new order file is written (status staged, PAUSED, LEARN_MORE). Nothing goes to Meta: an apply skill creates
 * the ad in a live Claude session after the owner's go-ahead.
 */
export async function stageAdAction(input: {
  channel: string;
  assetId: number;
  copy: { headlines: string[]; primaries: string[]; description: string };
  angleKey: string | null;
  concept: string | null;
  psObj: "ps" | "obj" | null;
  hookIds: number[];
  videoHook?: boolean;
  source: { from: string; ref: string | null };
  notes: string | null;
}): Promise<{ ok: true; path: string; name: string; message: string } | { ok: false; error: string }> {
  const p = z
    .object({
      channel: code,
      assetId: id,
      copy: adCopySchema,
      angleKey: z.string().max(80).nullable(),
      concept: z.string().max(60).nullable(),
      psObj: z.enum(["ps", "obj"]).nullable(),
      hookIds: z.array(id).max(20),
      videoHook: z.boolean().optional(),
      source: z.object({ from: z.enum(ORDER_SOURCES), ref: z.string().max(40).nullable() }),
      notes: z.string().max(NOTES_MAX * 2).nullable(),
    })
    .safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid ad. Reopen the dialog." };
  try {
    const r = stageOrder(getDb().sqlite, getConfig(), p.data);
    revalidatePath("/", "layout");
    return { ok: true, path: r.path, name: r.namePreview, message: "Staged as a PAUSED ad. Nothing goes to Meta until you apply it in a Claude session." };
  } catch (e) {
    return { ok: false, error: e instanceof OrderError ? e.message : "Could not stage the ad." };
  }
}

/** Cancel one of Studio's own staged orders (the file becomes `cancelled`, so no apply session can take it). */
export async function cancelAdOrderAction(input: { id: number }): Promise<Result> {
  const p = z.object({ id }).safeParse(input);
  if (!p.success) return fail("Invalid order.");
  try {
    const r = cancelOrder(getDb().sqlite, getConfig(), p.data.id);
    return done(r.note ?? "Order cancelled: no apply session will take it.");
  } catch (e) {
    return fail(e instanceof OrderError ? e.message : "Could not cancel the order.");
  }
}
