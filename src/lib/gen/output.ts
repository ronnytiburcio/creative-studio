/**
 * Output naming + sidecars for generated files (server only).
 * File:    <yyyy-mm-dd>_<engine>_<model>_<slug>_<n>.<ext>   (collision-safe: "-2", "-3", ... appended to the stem)
 *          quick tools: <yyyy-mm-dd>_<engine>_<tool>_<source-stem>_<n>.<ext>
 * Sidecar: <same stem>.gen.json next to it. Sidecars are not media, so the scanner never indexes them.
 */
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config";
import { destKey } from "./layout";
import type { GenInput } from "./types";

export const SIDECAR_SUFFIX = ".gen.json";

export function sidecarPathFor(file: string): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), path.basename(file, ext) + SIDECAR_SUFFIX);
}

export function slugify(text: string, maxLen = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let cut = slug;
  if (slug.length > maxLen) {
    cut = slug.slice(0, maxLen);
    const lastDash = cut.lastIndexOf("-");
    if (lastDash > 10) cut = cut.slice(0, lastDash); // drop the partial last word
  }
  return cut.replace(/-+$/g, "") || "untitled";
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function outputStem(input: Pick<GenInput, "engine" | "model" | "prompt" | "version" | "tool">, now = Date.now()): string {
  if (input.tool) {
    const source = path.basename(input.tool.source.filename, path.extname(input.tool.source.filename));
    return `${localDate(now)}_${input.engine}_${input.tool.id}_${slugify(source, 60)}_${input.version}`;
  }
  const model = input.model.replace(/[^a-z0-9_]+/gi, "").toLowerCase() || "model";
  return `${localDate(now)}_${input.engine}_${model}_${slugify(input.prompt)}_${input.version}`;
}

/** First "<stem>[-k].<ext>" in dir where neither the file nor its sidecar exists. */
export function freeOutputPath(dir: string, stem: string, ext: string): string {
  for (let k = 1; k < 1000; k++) {
    const name = k === 1 ? stem : `${stem}-${k}`;
    const file = path.join(dir, `${name}.${ext}`);
    if (!fs.existsSync(file) && !fs.existsSync(sidecarPathFor(file))) return file;
  }
  throw new Error("no free output name");
}

export type Sidecar = {
  sidecarVersion: 1;
  /** The app display name at write time (informational, never read back). */
  app: string;
  file: string;
  engine: string;
  model: string;
  modelLabel: string;
  jobType: string;
  /** Quick tools: tool id, its settings summary and the source asset (null / absent for generations). */
  tool: string | null;
  toolDetail?: string;
  source?: { assetId: number; path: string; filename: string };
  prompt: string;
  promptSent: string;
  brandGuard: boolean;
  params: Record<string, unknown>;
  /** role = the media param it was sent as (start_image, end_image, image_references, video_references). */
  references: { assetId: number; path: string; kind?: string; role?: string }[];
  credits: number | null;
  /** true: Higgsfield's quote did not know the clip length, so `credits` is a minimum. */
  creditsMinimum?: boolean;
  externalJobId: string;
  studioJobId: number;
  runId: string;
  versionIndex: number;
  versionsInRun: number;
  destination: string;
  createdAt: string;
};

export function buildSidecar(args: {
  file: string;
  input: GenInput;
  jobType: string;
  credits: number | null;
  creditsMinimum?: boolean;
  externalId: string;
  jobId: number;
}): Sidecar {
  const { input } = args;
  return {
    sidecarVersion: 1,
    app: getConfig().appName,
    file: path.basename(args.file),
    engine: input.engine,
    model: input.model,
    modelLabel: input.modelLabel,
    jobType: args.jobType,
    tool: input.tool?.id ?? null,
    ...(input.tool ? { toolDetail: input.tool.detail, source: input.tool.source } : {}),
    prompt: input.prompt,
    promptSent: input.promptSent,
    brandGuard: input.brandGuard,
    params: input.effectiveParams,
    references: input.references.map((r) => ({ assetId: r.assetId, path: r.path, kind: r.kind, role: r.role ?? "image_references" })),
    credits: args.credits,
    ...(args.creditsMinimum ? { creditsMinimum: true } : {}),
    externalJobId: args.externalId,
    studioJobId: args.jobId,
    runId: input.runId,
    versionIndex: input.version,
    versionsInRun: input.versions,
    destination: destKey(input.dest),
    createdAt: new Date().toISOString(),
  };
}
