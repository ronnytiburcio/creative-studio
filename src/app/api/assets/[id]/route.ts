import { NextResponse } from "next/server";
import { z } from "zod";
import { getAsset } from "@/lib/queries";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().regex(/^\d{1,12}$/).transform(Number) });

export async function GET(_req: Request, ctx: RouteContext<"/api/assets/[id]">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const asset = getAsset(parsed.data.id);
  if (!asset) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(asset, { headers: { "cache-control": "no-store" } });
}
