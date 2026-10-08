/**
 * GET /api/shorts/<card id>/sentences
 * The cold open picker (Phase 7 B4): the card's moment as sentences (cue units for an episode without a word transcript)
 * with their raw times, and which of them the current cold open covers. Read only (the DB's stored transcript; never the
 * drive). The pick itself goes through setColdOpenAction, which checks it again.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { coldOpenChoices, ShortEditError } from "@/lib/shorts/board";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().regex(/^\d{1,12}$/).transform(Number) });

export async function GET(_req: Request, ctx: RouteContext<"/api/shorts/[id]/sentences">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    return NextResponse.json(coldOpenChoices(getDb().sqlite, parsed.data.id), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof ShortEditError ? e.message : "not available" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
}
