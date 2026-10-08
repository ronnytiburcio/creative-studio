import { NextResponse } from "next/server";
import { getStatus } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getStatus(), { headers: { "cache-control": "no-store" } });
}
