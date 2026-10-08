"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { FileImage, FileVideo, Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { linkAdAction } from "@/app/actions";
import type { AssetCard } from "@/lib/queries";
import type { AdCard } from "@/lib/meta/running";
import { cn } from "@/lib/utils";
import { useLabels } from "@/components/shell/labels-provider";

/**
 * "Link a file" for a Meta ad: a picker over the ad's channel Library (its client's files plus shared ones), searched by
 * file name (and what the file shows). Picking one sets the owner's manual link (never overwritten by a sync).
 */
export function LinkFileDialog({ ad, onClose, onLinked }: { ad: AdCard; onClose: () => void; onLinked: () => void }) {
  const L = useLabels();
  const scope = ad.client ? `scope=client&client=${encodeURIComponent(ad.client.code)}` : ad.sectionKey === "fkb" ? "scope=fkb" : "scope=fkbpros";
  return (
    <FilePickerDialog
      scopeQuery={scope}
      kind={ad.isVideo ? "video" : "image"}
      subtitle={`${ad.name} · ${ad.client ? `${ad.client.short}'s Library (and shared files)` : `${ad.sectionKey === "fkb" ? L.lane.fkb : L.lane.fkbpros} Library`} · ${ad.isVideo ? "videos" : "images"}`}
      onClose={onClose}
      onPick={async (asset) => {
        const r = await linkAdAction({ adId: ad.id, assetId: asset.id });
        if (!r.ok) toast.error(r.error);
        else {
          if (r.message) toast.success(r.message);
          onLinked();
        }
      }}
    />
  );
}

/**
 * The shared file picker (Meta ads, YouTube Shorts in Phase 5 slice 4): the channel's Library through /api/assets
 * (`scopeQuery` + kind), searched by file name and description; `onPick` runs the owner's link action.
 */
export function FilePickerDialog({
  scopeQuery,
  kind,
  title = "Link a file",
  subtitle,
  onClose,
  onPick,
}: {
  scopeQuery: string;
  kind: "video" | "image";
  title?: string;
  subtitle: string;
  onClose: () => void;
  onPick: (asset: AssetCard) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<AssetCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/assets?${scopeQuery}&kind=${kind}&limit=48${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`, { signal: ctrl.signal, cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setItems((await r.json()).items);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, scopeQuery, kind]);

  const pick = (asset: AssetCard) => start(() => onPick(asset));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-hidden sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-all">{subtitle}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by file name" className="h-9 pl-8" aria-label="Search files" />
        </div>
        <div className="scrollbar-thin -mx-1 max-h-[56vh] overflow-y-auto px-1">
          {error ? (
            <p className="py-6 text-center text-[13px] text-brand-text">{error}</p>
          ) : items == null ? (
            <p className="flex items-center justify-center gap-2 py-6 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">No files match.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {items.map((a) => {
                const Icon = a.kind === "video" ? FileVideo : FileImage;
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={pending}
                    onClick={() => pick(a)}
                    className={cn(
                      "group flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/30",
                      pending && "opacity-60",
                    )}
                  >
                    <div className="aspect-[4/5] w-full bg-muted">
                      {a.hasThumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/media/${a.id}/thumb?v=${a.v}`} alt="" loading="lazy" className="size-full object-cover" />
                      ) : (
                        <div className="grid size-full place-items-center">
                          <Icon className="size-5 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <div className="truncate text-[12px] font-medium" title={a.filename}>
                        {a.filename}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{a.relDir || a.rootLabel}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
