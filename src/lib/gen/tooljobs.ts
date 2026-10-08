/**
 * Quick-tool job planning (server only): turns "run <tool> on asset N" into a validated GenInput.
 * Used by the tool estimate route (to quote) and by the queueTool server action (to insert the gen_tool row),
 * and by the smoke test with stub schemas. Nothing is spent or written here.
 *
 * The source is resolved through originalFileFor() (never a request path) and becomes references[0], so the
 * worker applies the usual reference rules (HEIC/GIF -> JPEG; video: original when H.264 MP4/MOV under 200 MB,
 * else the cached 1080p H.264 transcode). The tool's settings are checked against the live schema: every name
 * must exist, enum values must be allowed, the model's rules must pass with the one source in its slot.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { notMountedMessage, type StudioConfig } from "../config";
import { originalFileFor } from "../originals";
import { mediaCounts, ruleViolations } from "./rules";
import { toolDest, toolSpec, untestedTool, type ToolId, type ToolSpec } from "./tools";
import { resolveParams, type GenEngineId, type GenInput, type ModelSchema, type ParamValue } from "./types";

type Sql = Database.Database;

export type ToolPlan =
  | { ok: true; input: GenInput; spec: ToolSpec; schema: ModelSchema; sourceKind: "image" | "video"; durationS: number | null }
  | { ok: false; error: string };

/**
 * True while an untested tool (video upscale / remove background / reframe) has no `done` job of that tool + media
 * yet: the confirm and the Jobs page show a "First real run" note. Derived from the jobs table (no column).
 */
export function firstRealRunOf(sqlite: Sql, tool: string, media: string): boolean {
  if (!untestedTool(tool, media)) return false;
  return !sqlite
    .prepare(
      `select 1 from jobs where type = 'gen_tool' and status = 'done'
          and json_extract(input, '$.tool.id') = ? and json_extract(input, '$.tool.media') = ? limit 1`,
    )
    .get(tool, media);
}

export async function planTool(args: {
  assetId: number;
  tool: ToolId;
  sqlite: Sql;
  cfg: Pick<StudioConfig, "drivePath" | "fakeUnmounted" | "driveMode">;
  /** Loads the model / workflow schema (the catalog in the app, stubs in the smoke test). */
  schemaFor: (spec: ToolSpec) => Promise<ModelSchema | null>;
  engine?: GenEngineId;
  estimateShown?: number | null;
}): Promise<ToolPlan> {
  const { sqlite } = args;
  const a = sqlite
    .prepare(
      `select a.id, a.filename, a.kind, a.duration_s, a.missing, a.ignored, s.key as section_key
         from assets a join sections s on s.id = a.section_id where a.id = ?`,
    )
    .get(args.assetId) as
    | { id: number; filename: string; kind: string; duration_s: number | null; missing: number; ignored: number; section_key: string }
    | undefined;
  if (!a || a.missing || a.ignored) return { ok: false, error: "That file is no longer in the Library." };
  if (a.kind !== "image" && a.kind !== "video") return { ok: false, error: "Quick tools work on images and videos only." };
  const media = a.kind;

  const spec = toolSpec(args.tool, media, a.duration_s);
  if ("error" in spec) return { ok: false, error: spec.error };

  const original = originalFileFor(a.id, sqlite, args.cfg);
  if (!original.ok) {
    return { ok: false, error: original.status === 409 ? notMountedMessage(args.cfg) : "The file is not available on disk." };
  }

  const schema = await args.schemaFor(spec);
  if (!schema) return { ok: false, error: "Higgsfield does not offer this tool right now." };
  if (!schema.params.some((p) => p.name === spec.role)) return { ok: false, error: `${schema.displayName} takes no ${media} input.` };
  const resolved = resolveParams(schema, spec.params);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const violations = ruleViolations(schema, resolved.effective, mediaCounts([{ role: spec.role }]));
  if (violations.length) return { ok: false, error: violations[0] };

  // The reframe workflow is quoted from its cost params only (duration + resolution); models from their flags.
  const quoteParams: Record<string, ParamValue> = spec.workflow
    ? Object.fromEntries(
        (schema.costParams ?? []).flatMap((name) => {
          const v = resolved.effective[name];
          return v == null ? [] : [[name, v]];
        }),
      )
    : resolved.params;

  const codes = (
    sqlite
      .prepare("select c.code from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = ? order by c.code")
      .all(a.id) as { code: string }[]
  ).map((r) => r.code);

  const input: GenInput = {
    v: 1,
    engine: args.engine ?? "higgsfield",
    kind: "tool",
    model: schema.jobType,
    modelLabel: schema.displayName,
    prompt: "",
    promptSent: "",
    brandGuard: false,
    params: resolved.params,
    effectiveParams: resolved.effective,
    references: [{ assetId: a.id, path: original.file, kind: media, role: spec.role }],
    dest: toolDest(a.section_key, codes),
    version: 1,
    versions: 1,
    runId: randomUUID(),
    estimateShown: args.estimateShown ?? null,
    tool: {
      id: spec.tool,
      media,
      workflow: spec.workflow,
      exactQuote: spec.exactQuote,
      detail: spec.detail,
      quoteParams,
      source: { assetId: a.id, path: original.file, filename: a.filename },
    },
  };
  return { ok: true, input, spec, schema, sourceKind: media, durationS: a.duration_s };
}
