/**
 * Generation engine contract (safe for client + server: types and pure helpers only).
 * Every engine (Higgsfield, Codex, the smoke-test fake) implements GenAdapter.
 * One jobs row = one engine job = one version; a "run" of N versions is N rows sharing runId.
 */
import type { GenDest } from "./layout";
import type { RefRole } from "./rules";
import type { ToolRequest } from "./tools";

export type GenEngineId = "higgsfield" | "codex" | "fake";

export const ENGINE_LABEL: Record<GenEngineId, string> = { higgsfield: "Higgsfield", codex: "ChatGPT (Codex)", fake: "Fake" };
export type GenKind = "image" | "video" | "tool";
export type ParamValue = string | number | boolean;

/** One parameter from `higgsfield model get <job_type> --json`. */
export type ModelParam = {
  name: string;
  /** e.g. "string", "string|null", "integer", "integer|null", "boolean", "array", "object|null". */
  type: string;
  default: ParamValue | null;
  required: boolean;
  enum?: string[];
};

export type ModelRule = { cel: string; message: string };

export type ModelSchema = {
  jobType: string;
  displayName: string;
  type: string; // image | video | ...
  params: ModelParam[];
  rules: ModelRule[];
  /** Workflows only (`workflow get`): the params `generate cost workflow <name>` accepts. */
  costParams?: string[];
};

export type ModelListItem = { jobType: string; displayName: string; type: string };

/** Params that carry media, not settings. The form renders the reference tray for these instead. */
export const MEDIA_PARAMS = new Set([
  "prompt",
  "image_references",
  "video_references",
  "audio_references",
  "start_image",
  "end_image",
  "medias",
]);

/** Account plumbing the form never offers (Higgsfield folders, draft chaining). */
const HIDDEN_PARAMS = new Set(["folder_id", "draft_job_id"]);

/** Settings the form shows: not media, not prompt, not plumbing, and a scalar type. */
export function formParams(schema: ModelSchema): ModelParam[] {
  return schema.params.filter((p) => !MEDIA_PARAMS.has(p.name) && !HIDDEN_PARAMS.has(p.name) && !/^(array|object)/.test(p.type));
}

/** Largest number of image references a model allows (from its CEL rules), or null when it does not say. */
export function maxImageReferences(schema: ModelSchema): number | null {
  if (!schema.params.some((p) => p.name === "image_references")) return 0;
  for (const r of schema.rules) {
    const m = /size\(params\.image_references\)\s*<=\s*(\d+)/.exec(r.cel);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The request stored in jobs.input. Built and validated by the server action; read by the worker. */
export type GenInput = {
  v: 1;
  engine: GenEngineId;
  kind: GenKind;
  /** Engine model / job type, e.g. gpt_image_2_5. */
  model: string;
  modelLabel: string;
  prompt: string;
  /** Prompt actually sent (brand guard suffix appended when on). */
  promptSent: string;
  brandGuard: boolean;
  /** Params that differ from the model defaults (these are passed as flags). */
  params: Record<string, ParamValue>;
  /** Every scalar param with its effective value (defaults merged), for the sidecar and the Jobs page. */
  effectiveParams: Record<string, ParamValue | null>;
  /**
   * Resolved through originalFileFor() at queue time; re-checked by the worker. `role` is the media param
   * it is sent as (slice 1 rows have none: image_references).
   */
  references: { assetId: number; path: string; kind: "image" | "video"; role?: RefRole }[];
  dest: GenDest;
  version: number;
  versions: number;
  runId: string;
  /** Credits per version the panel showed when the owner confirmed (display only). */
  estimateShown: number | null;
  /**
   * Quick tools (kind "tool"): the tool, its source asset and how it is quoted. The source is also
   * references[0] (same path rules as any reference); prompt and promptSent are empty.
   */
  tool?: ToolRequest;
};

/** jobs.result: progress + outcome, written by the worker. */
export type GenResult = {
  /** Credits quoted by the engine for exactly this job right before it was created. */
  credits?: number | null;
  /** The quote does not know the clip length (video upscale / remove background): credits is a minimum. */
  creditsMinimum?: boolean;
  /** Remote job ids that ended in a failed state (a retry creates a fresh one). */
  failedExternalIds?: string[];
  /** Outputs already moved in (so a resumed job never duplicates them). */
  outputs?: { index: number; path: string; assetId: number | null }[];
  /**
   * Target path chosen for each output BEFORE its sidecar is written and it is moved in. A resume after a crash
   * reuses it: a target that already landed (our sidecar next to it) is only ingested, an orphan sidecar is reused.
   */
  planned?: { index: number; path: string }[];
  /** The create call may have gone through without Studio getting the job id (Retry warns it may double-spend). */
  startUncertain?: boolean;
  remoteStatus?: string;
  /** Codex: why the run ended without an image (last agent message / error event). */
  engineMessage?: string;
};

export type Capabilities = {
  available: boolean;
  reason?: string;
  /** CLI binary found (resolved to an absolute path). */
  installed?: boolean;
  /** Signed in (Higgsfield account / Codex with ChatGPT). */
  signedIn?: boolean;
  credits?: number | null;
  plan?: string | null;
};

export type PollResult =
  | { state: "running"; status: string }
  | { state: "done"; status: string }
  | { state: "failed"; status: string; reason: string };

/** Adapter poll: the engine has no job with this id (Higgsfield `generate get` exits 3 "Job not found"). */
export class JobNotFoundError extends Error {}

/** Adapter start: the create call may have reached the engine without returning an id (timeout, killed, no id). */
export class StartUncertainError extends Error {}

/** A reference ready to send: a local file (original, JPEG conversion or cached transcode) and its role. */
export type PreparedRef = { path: string; role: RefRole; kind: "image" | "video" };

export type AdapterContext = {
  /** Scratch dir under STUDIO_CACHE for this job (downloads, converted references). */
  tmpDir: string;
  /** Append a line to the job's log. */
  log: (line: string) => void;
};

export interface GenAdapter {
  readonly id: GenEngineId;
  /**
   * true: the job lives on the engine's side, so after a worker restart it is re-polled by its id (Higgsfield).
   * false: the job is a local process that died with the worker (Codex): it becomes an error, Retry reruns it.
   */
  readonly resumable: boolean;
  capabilities(): Promise<Capabilities>;
  /** Credits for ONE version of this request, or null when the engine cannot say (or it is not billed per run). */
  estimate(input: GenInput): Promise<number | null>;
  /** Create the job and return its id as soon as the engine confirms it (Higgsfield spends credits here). */
  start(input: GenInput, references: PreparedRef[], ctx: AdapterContext): Promise<string>;
  poll(externalId: string, ctx: AdapterContext): Promise<PollResult>;
  /** Download / pick up the finished job's outputs into ctx.tmpDir. Returns local file paths. */
  collect(externalId: string, ctx: AdapterContext): Promise<string[]>;
  /** Stop a running job and clean up after it. Only engines that can cancel implement it (Codex, fake). */
  cancel?(externalId: string, ctx: AdapterContext): Promise<void>;
}

export const BRAND_GUARD_SUFFIX = "No text, no logos, no faces unless the asset calls for a person.";

export function applyBrandGuard(prompt: string, on: boolean): string {
  const p = prompt.trim();
  if (!on) return p;
  return `${p}${/[.!?]$/.test(p) ? "" : "."} ${BRAND_GUARD_SUFFIX}`;
}

/** Shortlists (the owner, 2026-09-29) and defaults. */
export const IMAGE_SHORTLIST = ["gpt_image_2_5", "nano_banana_pro", "seedream_v5_pro", "flux_kontext"] as const;
export const VIDEO_SHORTLIST = ["kling3_0", "seedance_2_5", "veo3_1", "minimax_h3"] as const;
export const DEFAULT_IMAGE_MODEL = "gpt_image_2_5";
export const DEFAULT_VIDEO_MODEL = "kling3_0";
export const DEFAULT_VERSIONS = 2;

/** Studio defaults layered over the model's own defaults (only applied when the model accepts the value). */
export function studioDefaults(schema: ModelSchema): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const accepts = (name: string, value: string | number) =>
    schema.params.some((p) => p.name === name && (!p.enum || p.enum.includes(String(value))));
  if (accepts("aspect_ratio", "9:16")) out.aspect_ratio = "9:16";
  if (schema.jobType === "gpt_image_2_5") {
    if (accepts("quality", "high")) out.quality = "high";
    if (accepts("resolution", "2k")) out.resolution = "2k";
  }
  if (schema.jobType === "kling3_0") {
    if (accepts("mode", "std")) out.mode = "std";
    if (accepts("duration", 5)) out.duration = 5;
  }
  return out;
}

/** Brand guard default per kind: on for images, off for video (the owner, 2026-09-29). */
export function brandGuardDefault(kind: "image" | "video"): boolean {
  return kind === "image";
}

/**
 * ChatGPT image via the Codex CLI. Codex has no model catalog to read, so its (small) form is defined here:
 * the aspect ratio is passed as an instruction, references as `-i` attachments (at most 4).
 */
export const CODEX_MODEL = "gpt_image";
export const CODEX_SCHEMA: ModelSchema = {
  jobType: CODEX_MODEL,
  displayName: "ChatGPT image",
  type: "image",
  params: [
    { name: "prompt", type: "string", default: null, required: true },
    { name: "aspect_ratio", type: "string", default: "9:16", required: false, enum: ["9:16", "2:3", "4:5", "1:1", "3:2", "16:9"] },
    { name: "image_references", type: "array", default: null, required: false },
  ],
  rules: [{ cel: "size(params.image_references) <= 4", message: "ChatGPT image takes at most 4 references" }],
};

/**
 * Validate form values against a model schema. Returns the flags to pass (values that differ from the
 * model default) and every scalar param's effective value, or an error message. Unknown names are refused.
 */
export function resolveParams(
  schema: ModelSchema,
  raw: Record<string, unknown>,
): { ok: true; params: Record<string, ParamValue>; effective: Record<string, ParamValue | null> } | { ok: false; error: string } {
  const fields = formParams(schema);
  const known = new Set(fields.map((p) => p.name));
  for (const name of Object.keys(raw)) if (!known.has(name)) return { ok: false, error: `Unknown setting: ${name}` };
  const params: Record<string, ParamValue> = {};
  const effective: Record<string, ParamValue | null> = {};
  for (const p of fields) {
    const v = raw[p.name];
    if (v === undefined || v === null || v === "") {
      if (p.required && p.default == null) return { ok: false, error: `${p.name} is required` };
      effective[p.name] = p.default;
      continue;
    }
    let value: ParamValue;
    if (p.enum?.length) {
      if (typeof v !== "string" || !p.enum.includes(v)) return { ok: false, error: `${p.name} must be one of ${p.enum.join(", ")}` };
      value = v;
    } else if (p.type.startsWith("boolean")) {
      if (typeof v !== "boolean") return { ok: false, error: `${p.name} must be on or off` };
      value = v;
    } else if (p.type.startsWith("integer")) {
      if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 100_000) return { ok: false, error: `${p.name} must be a whole number` };
      value = v;
    } else if (p.type.startsWith("number")) {
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `${p.name} must be a number` };
      value = v;
    } else {
      if (typeof v !== "string" || v.length > 500) return { ok: false, error: `${p.name} is not valid` };
      value = v;
    }
    effective[p.name] = value;
    // Enums can be strings over an integer param (veo3_1 duration "4"|"6"|"8", default 8): compare as text.
    if (p.default == null || String(value) !== String(p.default)) params[p.name] = value;
  }
  return { ok: true, params, effective };
}
