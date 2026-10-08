/** Shared by the estimate routes (not a route itself: only route.ts files are routable). */
import { NextResponse } from "next/server";
import { cliRefusal } from "@/lib/gen/higgsfield";

/**
 * The CLI refuses invalid combinations (exit 3/4) with a one-line reason: pass that line on (400), nothing else.
 * Anything else is a terse 502.
 */
export function estimateErrorResponse(e: unknown) {
  const line = cliRefusal(e);
  return NextResponse.json({ error: line ?? "cost estimate unavailable" }, { status: line ? 400 : 502 });
}
