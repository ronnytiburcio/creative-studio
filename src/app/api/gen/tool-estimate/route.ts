/**
 * GET /api/gen/tool-estimate?asset=<id>&tool=upscale|remove_bg|reframe_916
 * The quick-tool confirm: what will run on which source, where it lands, and Higgsfield's quote for it.
 * `exact: false` = Higgsfield quotes this tool without the clip length (video upscale / remove background),
 * so the credits are a minimum. Free CLI reads only (schema + `generate cost`); nothing is uploaded or created.
 */
import { NextResponse } from "next/server";
import { estimateErrorResponse } from "../cli-error";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { quoteTool, toolSchema } from "@/lib/gen/catalog";
import { destKey, destLabel, destLabelsOf } from "@/lib/gen/layout";
import { uiLabels } from "@/lib/ui-labels";
import { firstRealRunOf, planTool } from "@/lib/gen/tooljobs";
import { TOOL_IDS, toolTitle } from "@/lib/gen/tools";
import { listClients } from "@/lib/queries";

export const dynamic = "force-dynamic";

const Query = z.object({ asset: z.coerce.number().int().positive(), tool: z.enum(TOOL_IDS) });

export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const plan = await planTool({
      assetId: parsed.data.asset,
      tool: parsed.data.tool,
      sqlite: getDb().sqlite,
      cfg: getConfig(),
      schemaFor: toolSchema,
    });
    if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });
    const credits = await quoteTool(plan.input);
    const dest = plan.input.dest;
    const media = plan.sourceKind;
    return NextResponse.json(
      {
        credits,
        exact: plan.spec.exactQuote,
        title: toolTitle(plan.spec.tool, plan.spec.detail),
        detail: plan.spec.detail,
        modelLabel: plan.schema.displayName,
        jobType: plan.schema.jobType,
        workflow: plan.spec.workflow,
        dest: destKey(dest),
        destLabel: destLabel(dest, listClients(), destLabelsOf(uiLabels())),
        firstRun: firstRealRunOf(getDb().sqlite, plan.spec.tool, media),
        source: { id: parsed.data.asset, filename: plan.input.tool!.source.filename, kind: plan.sourceKind, durationS: plan.durationS },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return estimateErrorResponse(e);
  }
}
