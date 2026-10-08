/**
 * Generation details for the drawer (server only) and Discard.
 *
 * The sidecar is found from the ASSET, never from a request path: originalFileFor(assetId) (root enabled, not
 * missing, drive mounted, realpath inside an enabled root) -> "<stem>.gen.json" next to it -> resolveInside()
 * the enabled roots again -> size-capped read -> zod. When the drive is unplugged the same details come from the
 * finished job row that produced the asset (jobs.input), so the drawer still shows them.
 *
 * Discard: only for generated assets inside Studio Generated. The file and its sidecar go to the macOS Trash
 * through the write guard, then the row is marked missing (hidden at once; manual tags kept, and a file put
 * back from the Trash is picked up again by the next scan).
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { notMountedMessage, type StudioConfig } from "../config";
import { isUnder, resolveInside } from "../fsguard";
import { markMissing } from "../jobs";
import { originalFileFor } from "../originals";
import type { WriteGuard } from "../writeguard";
import { destKey, parseDestKey } from "./layout";
import { sidecarPathFor } from "./output";
import { isProofPath, REF_ROLES, type RefRole } from "./rules";
import { TOOL_IDS, type ToolId } from "./tools";
import { ENGINE_LABEL, type GenEngineId, type GenInput, type GenResult, type ParamValue } from "./types";

const MAX_SIDECAR_BYTES = 256 * 1024;

const Scalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const SidecarSchema = z.object({
  engine: z.string().max(40),
  model: z.string().max(80),
  modelLabel: z.string().max(200).optional(),
  jobType: z.string().max(40).optional(),
  tool: z.string().max(80).nullable().optional(),
  toolDetail: z.string().max(80).optional(),
  source: z.object({ assetId: z.number().int().positive(), path: z.string().max(2000).optional(), filename: z.string().max(500).optional() }).optional(),
  prompt: z.string().max(8000),
  promptSent: z.string().max(9000).optional(),
  brandGuard: z.boolean().optional(),
  params: z.record(z.string().max(64), Scalar).optional(),
  references: z
    .array(z.object({ assetId: z.number().int().positive(), path: z.string().max(2000).optional(), role: z.string().max(40).optional() }))
    .max(64)
    .optional(),
  credits: z.number().nullable().optional(),
  creditsMinimum: z.boolean().optional(),
  externalJobId: z.string().max(200).optional(),
  studioJobId: z.number().int().optional(),
  destination: z.string().max(60).optional(),
  createdAt: z.string().max(60).optional(),
});

export type GenerationRef = {
  id: number;
  role: RefRole;
  filename: string;
  kind: "image" | "video" | "audio";
  hasThumb: boolean;
  v: string;
  proof: boolean;
  /** Still usable as a reference now (for Remix). */
  available: boolean;
};

export type GenerationDetails = {
  source: "sidecar" | "job";
  engine: string;
  engineLabel: string;
  model: string;
  modelLabel: string;
  jobType: string | null;
  /** Quick tool outputs: the tool, its settings summary and the source asset. */
  tool: ToolId | null;
  toolDetail: string | null;
  toolSource: (Omit<GenerationRef, "role"> & { durationS: number | null }) | null;
  prompt: string;
  promptSent: string | null;
  brandGuard: boolean;
  params: Record<string, ParamValue | null>;
  credits: number | null;
  /** The quote did not know the clip length (video upscale / remove background): credits is a minimum. */
  creditsMinimum: boolean;
  /** "credits" (Higgsfield) or "chatgpt" (included in the ChatGPT plan). */
  billing: "credits" | "chatgpt";
  createdAt: string | null;
  /** Destination key ("rtm" | "fkbpros" | "fkbpros:<code>") the run was saved to. */
  destination: string | null;
  studioJobId: number | null;
  references: GenerationRef[];
};

type Sql = Database.Database;
type Cfg = Pick<StudioConfig, "drivePath" | "fakeUnmounted" | "driveMode">;

function enabledRoots(sqlite: Sql): string[] {
  return (sqlite.prepare("select path from roots where enabled = 1").all() as { path: string }[]).map((r) => r.path);
}

function readSidecar(assetId: number, sqlite: Sql, cfg: Cfg): z.infer<typeof SidecarSchema> | null {
  const original = originalFileFor(assetId, sqlite, cfg);
  if (!original.ok) return null;
  // Next to the asset's stored (lexical) path, which lives under its root; resolveInside checks both the
  // lexical and the real path against the enabled roots, so a symlinked sidecar cannot point elsewhere.
  const stored = sqlite.prepare("select path from assets where id = ?").pluck().get(assetId) as string | undefined;
  if (!stored) return null;
  const sidecar = resolveInside(sidecarPathFor(stored), enabledRoots(sqlite));
  if (!sidecar) return null;
  try {
    const st = fs.statSync(sidecar);
    if (!st.isFile() || st.size > MAX_SIDECAR_BYTES) return null;
    const parsed = SidecarSchema.safeParse(JSON.parse(fs.readFileSync(sidecar, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function fromJob(assetId: number, sqlite: Sql): z.infer<typeof SidecarSchema> | null {
  const row = sqlite
    .prepare(
      `select j.id, j.type, j.input, j.result, j.finished_at from jobs j
        where j.type like 'gen_%' and j.result is not null
          and exists (select 1 from json_each(j.result, '$.outputs') o where json_extract(o.value, '$.assetId') = ?)
        order by j.id desc limit 1`,
    )
    .get(assetId) as { id: number; type: string; input: string | null; result: string | null; finished_at: number | null } | undefined;
  if (!row) return null;
  try {
    const input = JSON.parse(row.input ?? "{}") as Partial<GenInput>;
    const result = JSON.parse(row.result ?? "{}") as GenResult;
    const parsed = SidecarSchema.safeParse({
      engine: input.engine,
      model: input.model,
      modelLabel: input.modelLabel,
      jobType: row.type,
      tool: input.tool?.id ?? null,
      toolDetail: input.tool?.detail,
      source: input.tool?.source,
      prompt: input.prompt,
      promptSent: input.promptSent,
      brandGuard: input.brandGuard,
      params: input.effectiveParams,
      references: (input.references ?? []).map((r) => ({ assetId: r.assetId, path: r.path, role: r.role ?? "image_references" })),
      credits: result.credits ?? null,
      creditsMinimum: result.creditsMinimum,
      studioJobId: row.id,
      destination: input.dest ? destKey(input.dest) : undefined,
      createdAt: row.finished_at ? new Date(row.finished_at).toISOString() : undefined,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Details for a generated asset, or null when it is not one (or nothing can be read). */
export function generationDetails(assetId: number, sqlite: Sql, cfg: Cfg): GenerationDetails | null {
  let source: GenerationDetails["source"] = "sidecar";
  let d = readSidecar(assetId, sqlite, cfg);
  if (!d) {
    d = fromJob(assetId, sqlite);
    source = "job";
  }
  if (!d) return null;

  const byId = sqlite.prepare(
    `select a.id, a.filename, a.kind, a.thumb_path, a.sha256, a.path, a.duration_s from assets a where a.id = ?`,
  );
  type AssetRow = {
    id: number;
    filename: string;
    kind: "image" | "video" | "audio";
    thumb_path: string | null;
    sha256: string | null;
    path: string;
    duration_s: number | null;
  };
  const refOf = (assetId: number, storedPath?: string) => {
    const row = byId.get(assetId) as AssetRow | undefined;
    return {
      id: assetId,
      filename: row?.filename ?? (storedPath ? path.basename(storedPath) : `asset ${assetId}`),
      kind: row?.kind ?? ("image" as const),
      hasThumb: Boolean(row?.thumb_path),
      v: (row?.sha256 ?? "").slice(0, 12),
      proof: row ? isProofPath(row.path) : false,
      available: Boolean(row) && originalFileFor(assetId, sqlite, cfg).ok,
      durationS: row?.duration_s ?? null,
    };
  };
  const refs: GenerationRef[] = (d.references ?? []).slice(0, 32).map((r) => {
    const { id, filename, kind, hasThumb, v, proof, available } = refOf(r.assetId, r.path);
    const role = (REF_ROLES as readonly string[]).includes(r.role ?? "") ? (r.role as RefRole) : "image_references";
    return { id, role, filename, kind, hasThumb, v, proof, available };
  });
  const tool = d.tool && (TOOL_IDS as readonly string[]).includes(d.tool) ? (d.tool as ToolId) : null;
  const engine = d.engine;
  return {
    source,
    engine,
    engineLabel: ENGINE_LABEL[engine as GenEngineId] ?? engine,
    model: d.model,
    modelLabel: d.modelLabel ?? d.model,
    jobType: d.jobType ?? null,
    tool,
    toolDetail: tool ? (d.toolDetail ?? null) : null,
    toolSource: tool && d.source ? refOf(d.source.assetId, d.source.path) : null,
    prompt: d.prompt,
    promptSent: d.promptSent ?? null,
    brandGuard: d.brandGuard ?? false,
    params: (d.params ?? {}) as Record<string, ParamValue | null>,
    credits: d.credits ?? null,
    creditsMinimum: d.creditsMinimum === true,
    billing: engine === "codex" ? "chatgpt" : "credits",
    createdAt: d.createdAt ?? null,
    destination: d.destination && parseDestKey(d.destination) ? d.destination : null,
    studioJobId: d.studioJobId ?? null,
    references: refs,
  };
}

/** A generated asset that lives inside Studio Generated (`base`, the write guard's folder): the only files Discard may touch. */
export function discardable(asset: { path: string; generated: number | boolean }, base: string): boolean {
  return Boolean(asset.generated) && isUnder(asset.path, base) && path.resolve(asset.path) !== path.resolve(base);
}

/** `sidecarLeft`: the file went to the Trash (row hidden) but its sidecar could not be moved. */
export type DiscardResult = { ok: true; trashed: string[]; sidecarLeft?: boolean } | { ok: false; error: string };

/**
 * Trash a generated file + its sidecar through the write guard. The row is hidden (missing = 1) as soon as the
 * file itself is in the Trash, so a sidecar that cannot be moved never leaves a card pointing at nothing.
 */
export async function discardGenerated(assetId: number, sqlite: Sql, cfg: Cfg, guard: WriteGuard): Promise<DiscardResult> {
  const a = sqlite.prepare("select id, path, generated, missing from assets where id = ?").get(assetId) as
    | { id: number; path: string; generated: number; missing: number }
    | undefined;
  if (!a || a.missing) return { ok: false, error: "That file is no longer in the Library." };
  if (!discardable(a, guard.base)) return { ok: false, error: "Only files Studio generated (in Studio Generated) can be discarded." };
  if (!guard.isDriveMounted()) return { ok: false, error: notMountedMessage(cfg) };
  const original = originalFileFor(assetId, sqlite, cfg);
  if (!original.ok) return { ok: false, error: "The file is not available on disk." };
  const trashed: string[] = [];
  // The stored (lexical) path is what the guard checks; originalFileFor above proved it resolves inside a root.
  await guard.trash(a.path);
  trashed.push(a.path);
  markMissing(sqlite, [a.id]);
  const sidecar = sidecarPathFor(a.path);
  if (fs.existsSync(sidecar)) {
    try {
      await guard.trash(sidecar);
      trashed.push(sidecar);
    } catch {
      return { ok: true, trashed, sidecarLeft: true };
    }
  }
  return { ok: true, trashed };
}
