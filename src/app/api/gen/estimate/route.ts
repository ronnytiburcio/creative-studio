/**
 * GET /api/gen/estimate?model=<job_type>&p=<json params>&n=<versions>&refs=<role,role,...>
 * Credits per version and for the run. `refs` lists the reference slots in use (start_image, image_references, ...):
 * they are quoted with placeholder ids (never uploaded) because some rules and prices depend on them.
 */
import { NextResponse } from "next/server";
import { estimateErrorResponse } from "../cli-error";
import { z } from "zod";
import { modelSchema, quoteCredits } from "@/lib/gen/catalog";
import { REF_ROLES, mediaCounts, ruleViolations, type RefRole } from "@/lib/gen/rules";
import { resolveParams } from "@/lib/gen/types";

export const dynamic = "force-dynamic";

const Query = z.object({
  model: z.string().regex(/^[a-z0-9_]{2,64}$/),
  p: z.string().max(4000).default("{}"),
  n: z.coerce.number().int().min(1).max(4).default(1),
  refs: z
    .string()
    .max(600)
    .default("")
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.enum(REF_ROLES)).max(32)),
});

export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  let raw: unknown;
  try {
    raw = JSON.parse(parsed.data.p);
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const schema = await modelSchema(parsed.data.model);
    if (!schema) return NextResponse.json({ error: "unknown model" }, { status: 404 });
    const resolved = resolveParams(schema, raw as Record<string, unknown>);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    const counts = mediaCounts(parsed.data.refs.map((role: RefRole) => ({ role })));
    const violations = ruleViolations(schema, resolved.effective, counts);
    if (violations.length) return NextResponse.json({ error: violations[0] }, { status: 400 });
    const perVersion = await quoteCredits(parsed.data.model, resolved.params, counts);
    return NextResponse.json(
      { perVersion, total: Math.round(perVersion * parsed.data.n * 100) / 100, versions: parsed.data.n },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return estimateErrorResponse(e);
  }
}
