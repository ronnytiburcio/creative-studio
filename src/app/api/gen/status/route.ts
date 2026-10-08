/** GET /api/gen/status[?refresh=1]: engine availability. Higgsfield: signed in + credit balance; Codex: signed in with ChatGPT. Never the account email. */
import { NextResponse } from "next/server";
import { codexStatus, higgsfieldStatus } from "@/lib/gen/catalog";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const [higgsfield, codex] = await Promise.all([higgsfieldStatus(refresh), codexStatus(refresh)]);
  return NextResponse.json({ higgsfield, codex }, { headers: { "cache-control": "no-store" } });
}
