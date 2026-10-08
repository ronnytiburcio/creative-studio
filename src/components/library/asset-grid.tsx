"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SearchX } from "lucide-react";
import type { AssetCard as Card } from "@/lib/queries";
import { AssetCard } from "./asset-card";
import { AssetDrawer } from "./asset-drawer";
import { toolsBlocked, useGenerate } from "@/components/generate/generate-provider";
import { useStatus } from "@/components/shell/status-provider";
import { useNewAd } from "@/components/ads/new-ad-provider";
import { Pager } from "@/components/shell/pager";
import { clampPage } from "@/lib/paging";

/**
 * Paged grid (2026-10-06: page links instead of the endless scroll). Server paging: `initial` is this page's cards, the
 * server rendered `page` of `total`, and the page links change `?page=`. Client paging (`clientPaging`, search by meaning:
 * the whole ranked list is in memory): `initial` is every card and the grid pages through it itself.
 */
export function AssetGrid({
  initial,
  total,
  page = 1,
  pageSize,
  clientPaging = false,
  clients,
  matches,
  empty,
  footer,
  adChannel,
}: {
  initial: Card[];
  total: number;
  /** Server paging: the page `initial` is (1-based). */
  page?: number;
  pageSize: number;
  /** `initial` holds the whole list: page through it here (no URL change). */
  clientPaging?: boolean;
  clients: { code: string; short: string }[];
  /** Search by meaning: Jev's P(match) per asset id (shown on the cards). */
  matches?: Map<number, number>;
  /** Replaces the default "Nothing here yet" state. */
  empty?: React.ReactNode;
  /** Rendered under the grid (e.g. "Show weaker matches"). */
  footer?: React.ReactNode;
  /** A client channel's code or `fkb` (Phase 6 slice 3): cards and the drawer offer "New PAUSED ad" for videos / images. */
  adChannel?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const gen = useGenerate();
  const newAd = useNewAd();
  const openNewAd = useCallback((x: Card) => adChannel && newAd.open({ assetId: x.id, channel: adChannel }), [adChannel, newAd]);
  const { gen: genStatus, drive } = useStatus();
  // Discarded here: gone at once (the next refresh drops them on the server too).
  const [discarded, setDiscarded] = useState<Set<number>>(() => new Set());
  const [clientPage, setClientPage] = useState(1);
  // A generation finished somewhere: refresh so its output shows up here within seconds.
  const lastGenDone = useRef(genStatus.lastDoneAt);
  useEffect(() => {
    if (genStatus.lastDoneAt === lastGenDone.current) return;
    lastGenDone.current = genStatus.lastDoneAt;
    router.refresh();
  }, [genStatus.lastDoneAt, router]);
  const listed = discarded.size ? initial.filter((i) => !discarded.has(i.id)) : initial;
  const count = clientPaging ? listed.length : total;
  const current = clientPaging ? clampPage(clientPage, count, pageSize) : page;
  const items = clientPaging ? listed.slice((current - 1) * pageSize, current * pageSize) : listed;
  const selectedId = Number(sp.get("asset")) || null;
  const pageHref = useCallback(
    (n: number) => {
      const next = new URLSearchParams(sp.toString());
      if (n > 1) next.set("page", String(n));
      else next.delete("page");
      next.delete("asset");
      return `${pathname}${next.size ? `?${next}` : ""}`;
    },
    [pathname, sp],
  );

  const setAsset = useCallback(
    (id: number | null) => {
      const next = new URLSearchParams(sp.toString());
      if (id) next.set("asset", String(id));
      else next.delete("asset");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
    },
    [router, pathname, sp],
  );

  const { open: pickMode, addRef, hasRef, openPanel, openTool, refreshHiggsfield, higgsfield } = gen;
  const blockedTools = toolsBlocked(drive, higgsfield);
  const pickRef = useCallback(
    (a: Card) => {
      if (a.kind === "audio") {
        toast.error("Audio can't be used as a reference.");
        return;
      }
      if (pickMode) addRef(a);
      else openPanel({ refs: [a] });
    },
    [pickMode, addRef, openPanel],
  );
  const onOpen = useCallback((a: Card) => (pickMode ? pickRef(a) : setAsset(a.id)), [pickMode, pickRef, setAsset]);

  return (
    <div className="px-6 pt-3 pb-16">
      {items.length === 0 && empty ? (
        empty
      ) : items.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 text-center text-muted-foreground">
          <SearchX className="size-8" />
          <div className="text-[15px] font-medium text-foreground">Nothing here yet</div>
          <div className="max-w-[380px] text-[13px]">
            No files match these filters. Clear a filter, or check Settings if a root is disabled or the worker is still indexing.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
          {items.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              selected={a.id === selectedId}
              onOpen={onOpen}
              pickMode={pickMode}
              inTray={hasRef(a.id)}
              onUseRef={pickRef}
              toolsBlocked={blockedTools}
              onTool={openTool}
              onToolsMenu={refreshHiggsfield}
              match={matches?.get(a.id)}
              onNewAd={adChannel && !pickMode ? openNewAd : undefined}
            />
          ))}
        </div>
      )}
      <Pager
        className="mt-6"
        page={current}
        total={count}
        pageSize={pageSize}
        hrefFor={clientPaging ? undefined : pageHref}
        onPage={clientPaging ? setClientPage : undefined}
      />
      {footer}
      <AssetDrawer
        assetId={selectedId}
        onClose={() => setAsset(null)}
        clients={clients}
        onOpenAsset={setAsset}
        onDiscarded={(id) => setDiscarded((prev) => new Set(prev).add(id))}
        adChannel={adChannel ?? null}
      />
    </div>
  );
}
