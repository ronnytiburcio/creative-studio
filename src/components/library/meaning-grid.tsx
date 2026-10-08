"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Info, Loader2, SearchX } from "lucide-react";
import type { AssetCard as Card } from "@/lib/queries";
import { AssetGrid } from "./asset-grid";

type Ranked = Card & { match: number };

type MeaningResponse =
  | {
      ok: true;
      query: string;
      strong: Ranked[];
      weak: Ranked[];
      candidates: number;
      textMatches: number;
      undescribed: number;
      cached: boolean;
    }
  | { ok: false; reason: string; message: string };

type State = { key: string; data: MeaningResponse | null };

/**
 * Library results for the "Meaning" switch: asks /api/search/meaning (local prefilter + Jev rerank), shows strong
 * matches best first with their match %, the rest behind "Show weaker matches (N)", and a note for files that are not
 * described yet. Any refusal (no key, Jev down, daily cap, rate limit) shows its message over the plain results.
 */
export function MeaningGrid({
  apiQuery,
  query,
  fallback,
  pageSize,
  clients,
  adChannel,
}: {
  /** Scope + filters + q, as /api/assets takes them. */
  apiQuery: string;
  query: string;
  /** Plain search results for the same text (shown when meaning search is refused): one page of them (`?page=`). */
  fallback: { items: Card[]; total: number; page: number };
  pageSize: number;
  clients: { code: string; short: string }[];
  /** A client channel's code or `fkb`: "New PAUSED ad" on cards and the drawer. */
  adChannel?: string | null;
}) {
  const [state, setState] = useState<State>({ key: "", data: null });
  // Keyed by apiQuery in LibraryView: a new search remounts with fresh state.
  const [showWeak, setShowWeak] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/search/meaning?${apiQuery}`, { cache: "no-store", signal: ctrl.signal })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as MeaningResponse | null;
        setState({ key: apiQuery, data: body ?? { ok: false, reason: "error", message: "Search by meaning failed. Plain search still works." } });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) {
          setState({ key: apiQuery, data: { ok: false, reason: "error", message: "Search by meaning failed. Plain search still works." } });
        }
      });
    return () => ctrl.abort();
  }, [apiQuery]);

  const data = state.key === apiQuery ? state.data : null;
  const matches = useMemo(
    () => (data?.ok ? new Map([...data.strong, ...data.weak].map((c) => [c.id, c.match])) : undefined),
    [data],
  );

  if (!data) return <MeaningLoading query={query} />;

  if (!data.ok) {
    return (
      <>
        <div className="px-6 pt-3">
          <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[12.5px]">
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">{data.message}</span>{" "}
              <span className="text-muted-foreground">Showing plain search results for “{query}”.</span>
            </span>
          </div>
        </div>
        <AssetGrid
          initial={fallback.items}
          total={fallback.total}
          page={fallback.page}
          pageSize={pageSize}
          clients={clients}
          adChannel={adChannel}
        />
      </>
    );
  }

  const items = showWeak ? [...data.strong, ...data.weak] : data.strong;
  const weakToggle =
    data.weak.length > 0 ? (
      <div className="mt-6 flex justify-center">
        <button
          type="button"
          onClick={() => setShowWeak((v) => !v)}
          aria-expanded={showWeak}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
        >
          {showWeak ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {showWeak ? "Hide weaker matches" : `Show weaker matches (${data.weak.length.toLocaleString()})`}
        </button>
      </div>
    ) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-6 pt-3 text-[12.5px] text-muted-foreground">
        <span className="tabular">
          <span className="font-medium text-foreground">{data.strong.length.toLocaleString()}</span>{" "}
          {data.strong.length === 1 ? "match" : "matches"} by meaning
        </span>
        <span aria-hidden>·</span>
        <span className="tabular">
          Jev ranked {data.candidates.toLocaleString()} {data.candidates === 1 ? "file" : "files"}
          {data.candidates > 0 && data.textMatches < data.candidates ? ` (${data.textMatches.toLocaleString()} matched the words)` : ""}
        </span>
        {data.undescribed > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular">{data.undescribed.toLocaleString()} not described yet, left out</span>
          </>
        )}
      </div>
      <AssetGrid
        key={showWeak ? "all" : "strong"}
        initial={items}
        total={items.length}
        clientPaging
        pageSize={pageSize}
        clients={clients}
        adChannel={adChannel}
        matches={matches}
        footer={weakToggle}
        empty={
          <div className="mt-10 flex flex-col items-center gap-2 text-center text-muted-foreground">
            <SearchX className="size-8" />
            <div className="text-[15px] font-medium text-foreground">No strong matches for “{query}”</div>
            <div className="max-w-[420px] text-[13px]">
              {data.candidates === 0
                ? "Nothing in this channel and these filters is described yet."
                : "Jev did not find a file that clearly matches. Try other words, clear a filter, or look through the weaker matches."}
            </div>
          </div>
        }
      />
    </>
  );
}

function MeaningLoading({ query }: { query: string }) {
  return (
    <div className="px-6 pt-3 pb-16" aria-busy="true">
      <div role="status" className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>
          Searching by meaning for <span className="font-medium text-foreground">“{query}”</span>…
        </span>
      </div>
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-[12px] border border-border bg-card">
            <div className="flex items-center gap-2.5 px-3 pt-2.5">
              <div className="size-7 rounded-lg bg-muted" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
              </div>
            </div>
            <div className="mx-3 mt-2 mb-2 h-2.5 w-2/3 animate-pulse rounded bg-muted" />
            <div className="aspect-[4/5] animate-pulse bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
