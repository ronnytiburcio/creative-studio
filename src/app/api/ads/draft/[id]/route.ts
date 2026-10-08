/**
 * GET /api/ads/draft/<job id>
 * A "Draft the rest" (`ad_copy`) job: status, the draft once done, note / error. The dialog polls it and fills only the
 * slots that are still empty. Read only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adCopyJob } from "@/lib/meta/ad-copy-job";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().regex(/^\d{1,12}$/).transform(Number) });

export async function GET(_req: Request, ctx: RouteContext<"/api/ads/draft/[id]">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const job = adCopyJob(getDb().sqlite, parsed.data.id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { logPath: _logPath, ...view } = job;
  void _logPath;
  return NextResponse.json(view, { headers: { "cache-control": "no-store" } });
}
