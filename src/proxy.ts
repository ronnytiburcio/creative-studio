/**
 * Localhost guard (defence in depth; the server also binds 127.0.0.1 only).
 *  - Host must be a local name (blocks DNS rebinding).
 *  - Writes (anything but GET/HEAD, incl. server actions) need an Origin whose host
 *    equals the request Host. Missing or "null" Origin is rejected.
 *  - Sec-Fetch-Site, when the browser sends it, must be same-origin or none. The only
 *    exception is a plain GET page navigation (a link or bookmark to the app).
 */
import { NextResponse, type NextRequest } from "next/server";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

function forbidden(reason: string) {
  return new NextResponse(`forbidden (${reason})`, { status: 403, headers: { "cache-control": "no-store" } });
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const hostname = hostnameOf(host);
  if (!hostname || !LOCAL_HOSTNAMES.has(hostname)) return forbidden("host");

  const isRead = req.method === "GET" || req.method === "HEAD";
  if (!isRead) {
    const origin = req.headers.get("origin");
    if (!origin || origin === "null") return forbidden("origin");
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return forbidden("origin");
    }
    if (originUrl.host !== host || !LOCAL_HOSTNAMES.has(originUrl.hostname)) return forbidden("origin");
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    const isPageNavigation =
      isRead && req.headers.get("sec-fetch-mode") === "navigate" && req.headers.get("sec-fetch-dest") === "document";
    if (!isPageNavigation) return forbidden("fetch-site");
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico|brand/).*)",
};
