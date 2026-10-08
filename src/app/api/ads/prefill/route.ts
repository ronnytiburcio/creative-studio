/**
 * GET /api/ads/prefill?channel=<code|fkb>&hook=<id>&asset=<id>&ad=<meta ad id>
 * What the New PAUSED ad dialog opens with (Phase 6 slice 3): channel + ad account, copy prefilled from the hook and its
 * angle block (approved copy doc / ad map, read only), concept + ps|obj, the name preview, the context lines, the copy
 * rule context and the media check. Read only: nothing is written, nothing is called.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { newAdPrefill } from "@/lib/meta/new-ad";

export const dynamic = "force-dynamic";

const Query = z.object({
  channel: z.string().regex(/^[a-z0-9]{2,32}$/).optional(),
  hook: z.coerce.number().int().positive().optional(),
  asset: z.coerce.number().int().positive().optional(),
  ad: z.string().regex(/^\d{5,30}$/).optional(),
});

export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const q = parsed.data;
    const data = newAdPrefill(getDb().sqlite, getConfig(), { channel: q.channel ?? null, hookId: q.hook ?? null, assetId: q.asset ?? null, adId: q.ad ?? null });
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load the ad data." }, { status: 500 });
  }
}
