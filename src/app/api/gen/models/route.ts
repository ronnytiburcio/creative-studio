/** GET /api/gen/models?kind=image|video[&refresh=1]: Higgsfield models (shortlist + all), cached daily. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { models } from "@/lib/gen/catalog";

export const dynamic = "force-dynamic";

const Query = z.object({ kind: z.enum(["image", "video"]).default("image"), refresh: z.enum(["1"]).optional() });

export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    return NextResponse.json(await models(parsed.data.kind, parsed.data.refresh === "1"), { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Higgsfield model list unavailable" }, { status: 502 });
  }
}
