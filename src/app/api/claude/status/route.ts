/** GET /api/claude/status: is the claude CLI (hook variants, Shorts moments, ad copy drafts) signed in? Booleans + the auth method word only. */
import { NextResponse } from "next/server";
import { claudeAuthStatus } from "@/lib/hooks/claude";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await claudeAuthStatus(), { headers: { "cache-control": "no-store" } });
}
