/**
 * GET /api/search/meaning?q=<2..200 chars>&scope=rtm|fkbpros|fkb|client|all&client=<code>&<Library filters>
 *
 * Search by meaning: the ONE route handler allowed to make a paid call (Jev, DECISIONS "Phase 3 grilling"). Local
 * prefilter + one Jev noul per candidate (src/lib/ai/search.ts), cached 10 minutes, rate limited, inside the daily
 * cap, logged in ai_calls with purpose `search`. Refusals are terse `{ ok: false, reason, message }`; the Library then
 * shows the plain results. The Jev key never leaves the adapter.
 *
 * Paid, so only the app itself may call it: src/proxy.ts lets a cross-site top-level GET navigation through (links and
 * bookmarks to pages), which would let any web page open this URL and spend. Here the request must say
 * `Sec-Fetch-Site: same-origin`, or send no Sec-Fetch-Site at all and not be a navigation (non-browser clients on this
 * Mac; browsers always send the header). Anything else is a terse 403 before any work.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfig, readTypesafeKey } from "@/lib/config";
import { getDb } from "@/lib/db";
import { cardsByIds, parseFilters } from "@/lib/queries";
import { HttpJevTransport, Jev } from "@/lib/ai/jev";
import {
  MEANING_MAX_QUERY,
  MEANING_MESSAGES,
  MEANING_MIN_QUERY,
  MEANING_STRONG,
  MeaningCache,
  meaningSearch,
  RateLimiter,
  type MeaningDeps,
  type MeaningFailure,
  type MeaningOutcome,
} from "@/lib/ai/search";
import { clientRequired, LibraryQuery, scopeOf } from "../../library-query";

export const dynamic = "force-dynamic";

const Query = LibraryQuery.extend({ q: z.string().trim().min(MEANING_MIN_QUERY).max(MEANING_MAX_QUERY) }).refine(clientRequired, {
  message: "client required",
});

const STATUS: Record<MeaningFailure, number> = { rate: 429, cap: 503, nokey: 503, auth: 503, unavailable: 503, error: 502 };

/** One cache, rate limiter and adapter per server process (kept on globalThis so dev reloads do not reset them). */
type Shared = Pick<MeaningDeps, "cache" | "limiter" | "inflight" | "jev">;
const g = globalThis as { __rtmMeaningSearch?: Shared };

function deps(): MeaningDeps {
  if (!g.__rtmMeaningSearch) {
    const cfg = getConfig();
    g.__rtmMeaningSearch = {
      cache: new MeaningCache(),
      limiter: new RateLimiter(),
      inflight: new Map<string, Promise<MeaningOutcome>>(),
      jev: new Jev(getDb().sqlite, new HttpJevTransport(() => readTypesafeKey(cfg)), cfg.jevModel),
    };
  }
  return { sql: getDb().sqlite, ...g.__rtmMeaningSearch };
}

const noStore = { "cache-control": "no-store" };

/** The app's own fetch (same-origin), or a header-less non-navigation request; never another site or the address bar. */
function fromTheApp(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  return headers.get("sec-fetch-mode") !== "navigate";
}

export async function GET(req: Request) {
  if (!fromTheApp(req.headers)) return new NextResponse("forbidden", { status: 403, headers: noStore });
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse(Object.fromEntries(sp));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "bad", message: `Type ${MEANING_MIN_QUERY} to ${MEANING_MAX_QUERY} characters to search by meaning.` },
      { status: 400, headers: noStore },
    );
  }
  let out: MeaningOutcome;
  try {
    out = await meaningSearch(deps(), { query: parsed.data.q, scope: scopeOf(parsed.data), filters: { ...parseFilters(sp), meaning: true } });
  } catch {
    out = { ok: false, reason: "error", message: MEANING_MESSAGES.error };
  }
  if (!out.ok) {
    const headers: Record<string, string> = { ...noStore };
    if (out.retryAfterS) headers["retry-after"] = String(out.retryAfterS);
    return NextResponse.json({ ok: false, reason: out.reason, message: out.message }, { status: STATUS[out.reason], headers });
  }
  const p = new Map(out.ranking.map((r) => [r.id, r.p]));
  const cards = cardsByIds(out.ranking.map((r) => r.id)).map((c) => ({ ...c, match: p.get(c.id) ?? 0 }));
  return NextResponse.json(
    {
      ok: true,
      query: parsed.data.q,
      strong: cards.filter((c) => c.match >= MEANING_STRONG),
      weak: cards.filter((c) => c.match < MEANING_STRONG),
      candidates: out.candidates,
      textMatches: out.textMatches,
      undescribed: out.undescribed,
      cached: out.cached,
      requests: out.requests,
      inputTokens: out.inputTokens,
      ms: out.ms,
    },
    { headers: noStore },
  );
}
