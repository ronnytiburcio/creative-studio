/** GET /api/gen/models/<job_type>[?refresh=1]: the model's parameter schema (drives the Generate form). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { modelSchema } from "@/lib/gen/catalog";

export const dynamic = "force-dynamic";

const Params = z.object({ jobType: z.string().regex(/^[a-z0-9_]{2,64}$/) });

export async function GET(req: Request, ctx: RouteContext<"/api/gen/models/[jobType]">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const schema = await modelSchema(parsed.data.jobType, new URL(req.url).searchParams.get("refresh") === "1");
    if (!schema) return NextResponse.json({ error: "unknown model" }, { status: 404 });
    return NextResponse.json(schema, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Higgsfield model schema unavailable" }, { status: 502 });
  }
}
