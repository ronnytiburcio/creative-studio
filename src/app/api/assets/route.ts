/** GET /api/assets?scope=rtm|fkbpros|fkb|client|all&client=<code>&<filters incl. source, cls, review, energy>&offset=&limit= */
import { NextResponse } from "next/server";
import { z } from "zod";
import { listAssets, PAGE_SIZE, parseFilters } from "@/lib/queries";
import { clientRequired, LibraryQuery, scopeOf } from "../library-query";

export const dynamic = "force-dynamic";

const Query = LibraryQuery.extend({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(PAGE_SIZE),
}).refine(clientRequired, { message: "client required" });

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse(Object.fromEntries(sp));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const q = parsed.data;
  const data = listAssets(scopeOf(q), { ...parseFilters(sp), meaning: false }, q.offset, q.limit);
  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}
