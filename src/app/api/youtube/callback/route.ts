/**
 * GET /api/youtube/callback?state=&code= (or &error=): the end of "Connect YouTube" (Phase 5 slice 4, PHASE-5 I1).
 *
 * Google sends the owner's browser back to the loopback redirect `http://127.0.0.1:<port>/` (the documented form for Desktop
 * clients); the home page hands `state` + `code` / `error` straight here. This is a top-level GET navigation that
 * started on accounts.google.com, which src/proxy.ts allows (a plain GET page navigation); anything else cross-site is
 * refused there, and non-local hosts always are.
 *
 * The state must be one this server issued, unused and under 10 minutes old (single use: it is deleted on the first
 * try, good or bad). Then the code is exchanged at oauth2.googleapis.com: THE ONE network call the web process makes
 * for YouTube (with Disconnect's best-effort revoke). The token goes only into its 0600 file (src/lib/youtube/auth.ts);
 * the response is a redirect to Settings with a fixed result word, never anything from Google.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { consumeState, exchangeCode } from "@/lib/youtube/auth";
import { requestYtSync, setReconnectNeeded } from "@/lib/youtube/store";

export const dynamic = "force-dynamic";

/** The shape of a state this server issued (base64url, see startConnect). */
const STATE_RE = /^[A-Za-z0-9_-]{20,200}$/;

const Query = z.union([
  z.object({ state: z.string().regex(STATE_RE), code: z.string().min(4).max(2048).regex(/^[\x21-\x7e]+$/) }),
  z.object({ state: z.string().max(200).optional(), error: z.string().max(100) }),
]);

function back(req: Request, result: "connected" | "denied" | "expired" | "failed" | "scopes") {
  return NextResponse.redirect(new URL(`/settings?youtube=${result}#youtube`, req.url), { status: 303, headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({ state: sp.get("state") ?? undefined, code: sp.get("code") ?? undefined, error: sp.get("error") ?? undefined });
  if (!parsed.success) return back(req, "failed");
  const sql = getDb().sqlite;
  const q = parsed.data;
  if ("error" in q) {
    // The owner cancelled (access_denied) or Google refused: burn the state if there is one.
    if (q.state && STATE_RE.test(q.state)) consumeState(sql, q.state);
    return back(req, q.error === "access_denied" ? "denied" : "failed");
  }
  const verifier = consumeState(sql, q.state);
  if (!verifier) return back(req, "expired");
  const insCall = sql.prepare("insert into yt_calls (at, kind, path, status, ms, error) values (?, ?, ?, ?, ?, ?)");
  const r = await exchangeCode(getConfig(), q.code, verifier, undefined, Date.now(), (c) => insCall.run(Date.now(), c.kind, c.path, c.status, c.ms, c.error));
  if (!r.ok) return back(req, r.reason);
  setReconnectNeeded(sql, false);
  requestYtSync(sql);
  return back(req, "connected");
}
