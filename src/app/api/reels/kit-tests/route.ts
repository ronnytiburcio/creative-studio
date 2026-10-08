/**
 * GET /api/reels/kit-tests
 * The kit test summary the reel skills read at the start of a session (Phase 7 D3, the reel kit's tests.md): per kit
 * version the median "% viewed" of its no-test reels + how many there are, and each test reel's numbers with the winner
 * flag (the owner's A7 rule). Read only, terse JSON, no paths beyond file names, no secrets. Takes no query parameters.
 * Works for a plain `curl -s http://127.0.0.1:4747/api/reels/kit-tests` (a GET passes src/proxy.ts without an Origin).
 * Studio never writes the kit: a winner is only a flag for the next reel session to ask the owner about.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { channelViewMedian, kitName, kitShorts, kitTests } from "@/lib/shorts/kit";

export const dynamic = "force-dynamic";

const Query = z.object({}).strict();

export async function GET(req: Request) {
  const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return NextResponse.json({ error: "this route takes no parameters" }, { status: 400, headers: { "cache-control": "no-store" } });
  try {
    const shorts = kitShorts(getDb().sqlite);
    const summary = kitTests(shorts);
    const channel = channelViewMedian(shorts);
    return NextResponse.json(
      {
        kit: kitName(),
        channelMedian: channel.median,
        channelCount: channel.count,
        versions: summary.versions,
        tests: summary.tests.map((t) => ({
          videoId: t.videoId,
          title: t.title,
          fileName: t.fileName,
          version: t.version,
          change: t.change,
          detail: t.detail,
          views: t.views,
          avgViewPct: t.avgViewPct,
          daysUp: t.daysUp,
          beatBy: t.beatBy,
          winner: t.winner,
          note: t.note,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "not available" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
