/**
 * GET /api/ads/media?channel=<code|fkb>&asset=<id>
 * The New PAUSED ad dialog's media check (Phase 6 slice 3): a visible video / image of the channel, its original reached
 * only through originalFileFor (drive mounted), size (videos over 100 MB refused, over 45 MB warned). Read only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { adChannel, checkAdMedia } from "@/lib/meta/new-ad";

export const dynamic = "force-dynamic";

const Query = z.object({ channel: z.string().regex(/^[a-z0-9]{2,32}$/), asset: z.coerce.number().int().positive() });

export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const sql = getDb().sqlite;
  const ch = adChannel(sql, parsed.data.channel);
  if (!ch) return NextResponse.json({ error: "unknown channel" }, { status: 400 });
  return NextResponse.json(checkAdMedia(sql, getConfig(), ch, parsed.data.asset), { headers: { "cache-control": "no-store" } });
}
