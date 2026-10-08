/**
 * Higgsfield adapter: the `higgsfield` CLI (same account + credit pool as the MCP), argument arrays only.
 * Verified CLI behaviour (1.1.23, see docs/DECISIONS.md "Phase 2 slice 1 build choices"):
 *  - `model list --image --json`     -> [{display_name, job_type, type}]
 *  - `model get <jt> --json`         -> {display_name, job_type, type, params:[{name,type,default,required,enum?}], rules:[{cel,message}]}
 *  - `generate cost <jt> ... --json` -> {credits}
 *  - `generate create <jt> ... --json` (no --wait) -> ["<job uuid>"]: returns at once with the id (queued)
 *  - `generate get <id> --json`      -> {id, job_type, status, result_url, min_result_url, params, created_at, ...}
 *  - `account status --json`         -> {credits, email, subscription_plan_type} (email is never surfaced)
 *  - params are passed as `--<name> <value>` (booleans as "true"/"false"); media as `--start-image <path>`,
 *    `--end-image <path>`, repeated `--image-references <path>` / `--video-references <path>` (paths auto-upload).
 *  - statuses seen: queued -> in_progress -> completed; failed, nsfw are terminal failures.
 *  - rules (CEL) are checked by the CLI before anything is spent: violations exit 4 with the rule's message.
 *  - `generate cost` does not resolve media ids, so quotes pass a placeholder UUID per reference slot
 *    (the count matters for some rules, the file never does for the price).
 *  - Quick tools: tool models take no `--prompt` (exit 4 "Unknown params: prompt"). `workflow get <name> --json` is
 *    shaped like `model get` plus `cost_params`; `generate cost workflow reframe` accepts only --duration and
 *    --resolution (no media flags); the job is created with `generate workflow <name> ...`. `upload create` is free,
 *    but quoting with a real upload id gives the same price as a placeholder, so Studio never uploads to quote.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { MAY_EXIST_ON_ENGINE } from "../jobs";
import { lastLine, resolveHiggsfield, runCli, type CliResult } from "./cli";
import type { MediaCounts, RefRole } from "./rules";
import {
  JobNotFoundError,
  StartUncertainError,
  type AdapterContext,
  type Capabilities,
  type GenAdapter,
  type GenInput,
  type ModelListItem,
  type ModelParam,
  type ModelSchema,
  type ParamValue,
  type PollResult,
  type PreparedRef,
} from "./types";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DONE = new Set(["completed", "succeeded", "success", "done"]);
const FAILED = new Set(["failed", "nsfw", "canceled", "cancelled", "error", "rejected"]);
export const MAX_DOWNLOAD = 2 * 1024 * 1024 * 1024;
/** `generate create` also uploads local media flags: 10 min, 30 min when a video reference goes up. */
const CREATE_TIMEOUT_MS = 10 * 60_000;
const CREATE_TIMEOUT_VIDEO_MS = 30 * 60_000;

export class HiggsfieldError extends Error {
  constructor(
    message: string,
    /** CLI exit code, when the CLI ran and exited non-zero. */
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

/** `generate get <unknown id>` (verified, CLI 1.1.23): exit 3, stderr "Error: Job not found". */
export function isJobNotFound(e: unknown): boolean {
  return e instanceof HiggsfieldError && e.exitCode === 3 && /not found/i.test(e.message);
}

/** The one-line reason the CLI gave for refusing a request ("error: ..."), or undefined for anything else. */
export function cliRefusal(e: unknown): string | undefined {
  return e instanceof HiggsfieldError ? /^error:\s*(.{1,200})/i.exec(e.message)?.[1] : undefined;
}

async function hf(args: string[], timeoutMs = 60_000): Promise<unknown> {
  const bin = resolveHiggsfield();
  if (!bin) throw new HiggsfieldError("higgsfield CLI not found (~/.local/bin/higgsfield)");
  const r = await runCli(bin.cmd, [...bin.prefix, ...args, "--json"], { timeoutMs });
  if (r.code !== 0) throw new HiggsfieldError(lastLine(r), r.code);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new HiggsfieldError(`unexpected output from higgsfield ${args[0]} ${args[1] ?? ""}`.trim());
  }
}

/** `--name value` pairs for params that differ from the model defaults. */
export function paramFlags(params: Record<string, ParamValue>): string[] {
  return Object.entries(params).flatMap(([name, value]) => [`--${name}`, String(value)]);
}

export const ROLE_FLAG: Record<RefRole | "audio_references", string> = {
  start_image: "--start-image",
  end_image: "--end-image",
  image_references: "--image-references",
  video_references: "--video-references",
  audio_references: "--audio-references",
};

/** Placeholder media id for cost quotes (never uploaded, never created). */
const QUOTE_MEDIA_ID = "00000000-0000-4000-8000-000000000000";

/** Media flags for a quote: one placeholder per used slot. */
export function quoteMediaFlags(counts: Partial<MediaCounts>): string[] {
  return (Object.keys(ROLE_FLAG) as (keyof MediaCounts)[]).flatMap((role) =>
    Array.from({ length: counts[role] ?? 0 }, () => [ROLE_FLAG[role], QUOTE_MEDIA_ID]).flat(),
  );
}

/** Slot counts for a queued request (slice 1 rows without a role were image references). */
export function inputCounts(input: Pick<GenInput, "references">): Partial<MediaCounts> {
  const counts: Partial<MediaCounts> = {};
  for (const r of input.references) {
    const role = r.role ?? "image_references";
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

/**
 * `generate cost` arguments. `prompt: false` for tool models (they refuse --prompt); `workflow: true` quotes
 * `generate cost workflow <name>` from params only (the reframe cost takes no media flags).
 */
export function costArgs(
  model: string,
  params: Record<string, ParamValue>,
  counts: Partial<MediaCounts> = {},
  opts: { prompt?: boolean; workflow?: boolean } = {},
): string[] {
  return opts.workflow
    ? ["generate", "cost", "workflow", model, ...paramFlags(params)]
    : ["generate", "cost", model, ...(opts.prompt === false ? [] : ["--prompt", "estimate"]), ...paramFlags(params), ...quoteMediaFlags(counts)];
}

/**
 * `generate create|workflow` arguments (without the binary). Quick tools send no prompt; the video reframe is a
 * workflow (`generate workflow reframe`), every other job a model (`generate create <job_type>`).
 */
export function createArgs(input: GenInput, references: PreparedRef[]): string[] {
  return [
    "generate",
    input.tool?.workflow ? "workflow" : "create",
    input.model,
    ...(input.tool ? [] : ["--prompt", input.promptSent]),
    ...paramFlags(input.params),
    ...references.flatMap((r) => [ROLE_FLAG[r.role], r.path]),
    "--json",
  ];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function toParam(raw: unknown): ModelParam | null {
  const p = asRecord(raw);
  if (typeof p.name !== "string" || !/^[a-z0-9_]{1,64}$/.test(p.name)) return null;
  const def = p.default;
  return {
    name: p.name,
    type: typeof p.type === "string" ? p.type : "string",
    default: typeof def === "string" || typeof def === "number" || typeof def === "boolean" ? def : null,
    required: p.required === true,
    enum: Array.isArray(p.enum) ? p.enum.filter((e): e is string => typeof e === "string") : undefined,
  };
}

export function parseModelSchema(raw: unknown): ModelSchema {
  const d = asRecord(raw);
  if (typeof d.job_type !== "string") throw new HiggsfieldError("model schema without job_type");
  const costParams = Array.isArray(d.cost_params)
    ? d.cost_params.map(toParam).filter((p): p is ModelParam => p !== null).map((p) => p.name)
    : undefined;
  return {
    ...(costParams ? { costParams } : {}),
    jobType: d.job_type,
    displayName: typeof d.display_name === "string" ? d.display_name : d.job_type,
    type: typeof d.type === "string" ? d.type : "image",
    params: (Array.isArray(d.params) ? d.params : []).map(toParam).filter((p): p is ModelParam => p !== null),
    rules: (Array.isArray(d.rules) ? d.rules : [])
      .map(asRecord)
      .filter((r) => typeof r.cel === "string")
      .map((r) => ({ cel: String(r.cel), message: typeof r.message === "string" ? r.message : "" })),
  };
}

export function parseModelList(raw: unknown): ModelListItem[] {
  return (Array.isArray(raw) ? raw : [])
    .map(asRecord)
    .filter((m) => typeof m.job_type === "string")
    .map((m) => ({
      jobType: String(m.job_type),
      displayName: typeof m.display_name === "string" ? m.display_name : String(m.job_type),
      type: typeof m.type === "string" ? m.type : "",
    }));
}

/**
 * Pull the job id out of `generate create --json`. 1.1.23 prints an array of id strings (["<uuid>"]);
 * object shapes ({id} / {job_id} / {job_ids} / {jobs}) are accepted too in case a later CLI changes it.
 */
export function parseCreateOutput(stdout: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return UUID.exec(stdout)?.[0] ?? null;
  }
  const first = Array.isArray(data) ? data[0] : data;
  if (typeof first === "string") return UUID.exec(first)?.[0] ?? null;
  const d = asRecord(first);
  const candidates: unknown[] = [
    d.id,
    d.job_id,
    Array.isArray(d.job_ids) ? d.job_ids[0] : undefined,
    Array.isArray(d.jobs) ? asRecord(d.jobs[0]).id : undefined,
    asRecord(d.job).id,
    asRecord(d.data).id,
  ];
  for (const c of candidates) if (typeof c === "string" && UUID.test(c)) return UUID.exec(c)![0];
  return UUID.exec(stdout)?.[0] ?? null;
}

/** Result URLs from a finished job (single result_url today; result_urls/results handled if they appear). */
export function resultUrls(job: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (Array.isArray(job.result_urls)) urls.push(...job.result_urls.filter((u): u is string => typeof u === "string"));
  if (Array.isArray(job.results)) {
    for (const r of job.results) {
      const url = asRecord(r).url;
      if (typeof url === "string") urls.push(url);
    }
  }
  if (!urls.length && typeof job.result_url === "string") urls.push(job.result_url);
  return [...new Set(urls)].filter((u) => /^https:\/\//.test(u));
}

const HEIC_BRANDS = new Set(["heic", "heix"]);

/**
 * What a downloaded result really is, from its bytes (never the URL or Content-Type): an ISO-BMFF `ftyp` box
 * is a video (brand "qt  " -> mov, else mp4; HEIC brands -> heic image, other HEIF/AVIF brands refused), anything
 * else must decode as png / jpeg / webp / gif (sharp). null = not media Studio can index.
 */
export async function sniffMedia(file: string): Promise<{ kind: "image" | "video"; ext: string } | null> {
  const head = Buffer.alloc(12);
  let n = 0;
  const fd = fs.openSync(file, "r");
  try {
    n = fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (n === 12 && head.toString("latin1", 4, 8) === "ftyp") {
    const brand = head.toString("latin1", 8, 12);
    if (HEIC_BRANDS.has(brand)) return { kind: "image", ext: "heic" };
    if (/^(avif|avis|mif1|msf1|hevc|hevx)$/.test(brand)) return null;
    return { kind: "video", ext: brand === "qt  " ? "mov" : "mp4" };
  }
  try {
    const format = (await sharp(file).metadata()).format;
    const ext = format === "jpeg" ? "jpg" : format;
    return ext === "png" || ext === "jpg" || ext === "webp" || ext === "gif" ? { kind: "image", ext } : null;
  } catch {
    return null;
  }
}

/** Stream `source` into a NEW file, counting bytes; over `maxBytes` the copy is aborted and the file removed. */
export async function saveCapped(source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream, file: string, maxBytes = MAX_DOWNLOAD): Promise<number> {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new HiggsfieldError(maxBytes === MAX_DOWNLOAD ? "result is larger than 2 GB" : `result is larger than ${maxBytes} bytes`));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, fs.createWriteStream(file, { flags: "wx" }));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  return bytes;
}

/** Name a finished download by what it really is (`<index>.<ext>`), or remove it and refuse non-media. */
export async function finishDownload(tmpFile: string, dir: string, index: number): Promise<string> {
  const media = await sniffMedia(tmpFile);
  if (!media) {
    fs.rmSync(tmpFile, { force: true });
    throw new HiggsfieldError("the result is not an image or a video");
  }
  const file = path.join(dir, `${index}.${media.ext}`);
  fs.renameSync(tmpFile, file);
  return file;
}

/** Download one https URL into dir (size-capped while streaming), then name it by its sniffed type. */
export async function download(url: string, dir: string, index: number, opts: { maxBytes?: number } = {}): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new HiggsfieldError("refusing a non-https result URL");
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD;
  const res = await fetch(u, { signal: AbortSignal.timeout(15 * 60_000), redirect: "follow" });
  if (!res.ok || !res.body) throw new HiggsfieldError(`download failed (HTTP ${res.status})`);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new HiggsfieldError("result is larger than 2 GB");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${index}.download`);
  fs.rmSync(tmp, { force: true });
  await saveCapped(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), tmp, maxBytes);
  return finishDownload(tmp, dir, index);
}

export const higgsfieldCatalog = {
  async listModels(kind: "image" | "video"): Promise<ModelListItem[]> {
    return parseModelList(await hf(["model", "list", `--${kind}`]));
  },
  async getModel(jobType: string): Promise<ModelSchema> {
    return parseModelSchema(await hf(["model", "get", jobType]));
  },
  async getWorkflow(name: string): Promise<ModelSchema> {
    return parseModelSchema(await hf(["workflow", "get", name]));
  },
  /**
   * Credits for one job with these params and reference slots (the prompt text and the files do not change the price).
   * `prompt: false` for tool models (they refuse --prompt); `workflow: true` quotes `generate cost workflow <name>`
   * (params only, no media flags).
   */
  async cost(
    model: string,
    params: Record<string, ParamValue>,
    counts: Partial<MediaCounts> = {},
    opts: { prompt?: boolean; workflow?: boolean } = {},
  ): Promise<number> {
    const d = asRecord(await hf(costArgs(model, params, counts, opts)));
    if (typeof d.credits !== "number") throw new HiggsfieldError("cost response without credits");
    return d.credits;
  },
};

export class HiggsfieldAdapter implements GenAdapter {
  readonly id = "higgsfield" as const;
  readonly resumable = true;

  async capabilities(): Promise<Capabilities> {
    if (!resolveHiggsfield()) return { available: false, installed: false, signedIn: false, reason: "Higgsfield CLI not installed" };
    try {
      const d = asRecord(await hf(["account", "status"], 20_000));
      return {
        available: true,
        installed: true,
        signedIn: true,
        credits: typeof d.credits === "number" ? d.credits : null,
        plan: typeof d.subscription_plan_type === "string" ? d.subscription_plan_type : null,
      };
    } catch (e) {
      const msg = (e as Error).message;
      const signedOut = /auth|login|token|unauthor/i.test(msg);
      return { available: false, installed: true, signedIn: signedOut ? false : undefined, reason: signedOut ? "Higgsfield CLI is not signed in" : msg };
    }
  }

  estimate(input: GenInput): Promise<number | null> {
    if (input.tool) {
      return higgsfieldCatalog.cost(input.model, input.tool.quoteParams, input.tool.workflow ? {} : inputCounts(input), {
        prompt: false,
        workflow: input.tool.workflow,
      });
    }
    return higgsfieldCatalog.cost(input.model, input.params, inputCounts(input));
  }

  /**
   * Create the job. Refusals the CLI makes before anything exists (exit 3 usage / 4 rules) are plain errors; a
   * create that timed out, was killed, failed otherwise or printed no id MAY have gone through on Higgsfield,
   * so it becomes a StartUncertainError (the job says so, and Retry warns that it spends credits again).
   */
  async start(input: GenInput, references: PreparedRef[], ctx: AdapterContext): Promise<string> {
    const bin = resolveHiggsfield();
    if (!bin) throw new HiggsfieldError("higgsfield CLI not found");
    const args = createArgs(input, references);
    const media = references.map((r) => `${ROLE_FLAG[r.role]} ${path.basename(r.path)}`).join(" ");
    ctx.log(`higgsfield generate ${args[1]} ${input.model} ${paramFlags(input.params).join(" ")}${media ? ` ${media}` : ""}`);
    const timeoutMs = references.some((r) => r.kind === "video") ? CREATE_TIMEOUT_VIDEO_MS : CREATE_TIMEOUT_MS;
    let r: CliResult;
    try {
      r = await runCli(bin.cmd, [...bin.prefix, ...args], { timeoutMs });
    } catch (e) {
      const msg = (e as Error).message;
      ctx.log(`create failed: ${msg}`);
      if (/timed out/i.test(msg)) {
        throw new StartUncertainError(`Higgsfield did not answer within ${timeoutMs / 60_000} min. ${MAY_EXIST_ON_ENGINE}`);
      }
      throw new HiggsfieldError("could not run the higgsfield CLI"); // spawn failed: nothing reached Higgsfield
    }
    ctx.log(`create exit ${r.code}: ${r.stdout.trim().slice(0, 2000)}${r.stderr.trim() ? ` | stderr: ${r.stderr.trim().slice(-500)}` : ""}`);
    if (r.code === 3 || r.code === 4) throw new HiggsfieldError(lastLine(r), r.code);
    if (r.code !== 0) throw new StartUncertainError(`${lastLine(r).replace(/\.$/, "")}. ${MAY_EXIST_ON_ENGINE}`);
    const id = parseCreateOutput(r.stdout);
    if (!id) throw new StartUncertainError(`Create returned no job id. ${MAY_EXIST_ON_ENGINE}`);
    return id;
  }

  /** Not found (exit 3) is reported as JobNotFoundError: the worker turns repeated ones into a remote failure. */
  async poll(externalId: string): Promise<PollResult> {
    let job: Record<string, unknown>;
    try {
      job = asRecord(await hf(["generate", "get", externalId], 60_000));
    } catch (e) {
      if (isJobNotFound(e)) throw new JobNotFoundError("Higgsfield has no job with this id (Job not found)");
      throw e;
    }
    const status = typeof job.status === "string" ? job.status.toLowerCase() : "unknown";
    if (DONE.has(status)) return { state: "done", status };
    if (FAILED.has(status)) {
      return { state: "failed", status, reason: status === "nsfw" ? "Higgsfield flagged the result (nsfw)" : `Higgsfield job ${status}` };
    }
    return { state: "running", status };
  }

  async collect(externalId: string, ctx: AdapterContext): Promise<string[]> {
    const job = asRecord(await hf(["generate", "get", externalId], 60_000));
    const urls = resultUrls(job);
    if (!urls.length) throw new HiggsfieldError("finished job has no result URL");
    const files: string[] = [];
    for (const [i, url] of urls.entries()) {
      ctx.log(`download ${i + 1}/${urls.length}: ${new URL(url).pathname.split("/").pop()}`);
      files.push(await download(url, ctx.tmpDir, i + 1));
    }
    return files;
  }
}
