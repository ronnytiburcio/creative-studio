"use client";

import { memo, useEffect, useRef, useState } from "react";
import { AudioLines, Check, FileAudio, FileImage, FileVideo, Folder, ImageOff, ImagePlus, Loader2, Sparkles, SquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes, formatDate, formatDuration } from "@/lib/media";
import type { AssetCard as Card } from "@/lib/queries";
import { QuickToolsMenu } from "@/components/generate/quick-tools";
import type { ToolSource } from "@/components/generate/generate-provider";
import type { ToolId } from "@/lib/gen/tools";

export const KIND_ICON = { video: FileVideo, image: FileImage, audio: FileAudio } as const;

export function mediaUrl(a: Pick<Card, "id" | "v">, variant: "thumb" | "sheet" | "proxy" | "original") {
  return `/api/media/${a.id}/${variant}${a.v && variant !== "original" ? `?v=${a.v}` : ""}`;
}

function isLandscape(a: Card) {
  return !!a.width && !!a.height && a.width > a.height * 1.15;
}

export function ClientChips({ asset, max = 3 }: { asset: Card; max?: number }) {
  if (asset.sectionKey !== "fkbpros") return null;
  if (asset.clients.length === 0) {
    return (
      <span className="inline-flex h-5 items-center rounded-md border border-dashed border-foreground/20 px-1.5 text-[11px] text-muted-foreground">
        Shared
      </span>
    );
  }
  const shown = asset.clients.slice(0, max);
  const more = asset.clients.length - shown.length;
  return (
    <>
      {shown.map((c) => (
        <span
          key={c.code}
          className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-[11px] font-medium text-foreground/80"
          title={c.source === "jev" ? `${c.short} (tagged by Jev)` : `${c.short} (${c.source})`}
        >
          {c.short}
          {c.source === "jev" && <JevMark />}
        </span>
      ))}
      {more > 0 && <span className="text-[11px] text-muted-foreground">+{more}</span>}
    </>
  );
}

/** Small marker on client chips Jev applied (not a folder rule or the owner). */
export function JevMark({ className }: { className?: string }) {
  return (
    <span className={cn("text-[9.5px] font-semibold tracking-wide text-brand-text uppercase", className)} aria-label="tagged by Jev">
      Jev
    </span>
  );
}

/** Permanent "made by Studio" marker (cards + drawer, every channel). */
export function GeneratedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md bg-ink/80 px-1.5 text-[11px] font-medium text-paper",
        className,
      )}
      title="Made in Studio (AI generated)"
    >
      <Sparkles className="size-3 text-brand" />
      Generated
    </span>
  );
}

function AssetCardInner({
  asset,
  selected,
  onOpen,
  inTray,
  pickMode,
  onUseRef,
  toolsBlocked,
  onTool,
  onToolsMenu,
  match,
  onNewAd,
}: {
  asset: Card;
  selected?: boolean;
  onOpen: (asset: Card) => void;
  /** Already in the Generate panel's reference tray. */
  inTray?: boolean;
  /** Generate panel is open: a click adds the card as a reference instead of opening the drawer. */
  pickMode?: boolean;
  onUseRef?: (asset: Card) => void;
  /** Why quick tools are off (drive, Higgsfield), or null. */
  toolsBlocked?: string | null;
  onTool?: (asset: ToolSource, tool: ToolId) => void;
  /** Quick tools menu opened (refresh the Higgsfield status). */
  onToolsMenu?: () => void;
  /** Search by meaning: Jev's P(match), shown as a small percentage. */
  match?: number | null;
  /** A client channel or Lane C (Phase 6 slice 3): "New ad" on videos / images opens the New PAUSED ad dialog. */
  onNewAd?: (asset: Card) => void;
}) {
  const [hover, setHover] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const Icon = KIND_ICON[asset.kind];
  const landscape = isLandscape(asset);
  const canPreview = asset.kind === "video" && (asset.hasProxy || asset.hasSheet);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const onEnter = () => {
    if (!canPreview) return;
    timer.current = setTimeout(() => setHover(true), 250);
  };
  const onLeave = () => {
    if (timer.current) clearTimeout(timer.current);
    setHover(false);
  };

  const crumb = [asset.rootLabel, asset.relDir].filter(Boolean).join(" / ");

  // One interactive element per control, never nested: the card itself is a plain container whose click opens
  // the drawer (or adds a reference); the filename is the card's keyboard control (its Enter/Space click bubbles
  // up to the same handler); quick tools and "Use as reference" are sibling buttons that stop their clicks.
  return (
    <article
      className={cn(
        "group flex cursor-pointer flex-col overflow-hidden rounded-[12px] border border-border bg-card transition-[box-shadow,border-color] duration-150 [content-visibility:auto] [contain-intrinsic-size:auto_380px]",
        "hover:border-brand/70 hover:shadow-[var(--shadow-card-hover)] hover:ring-1 hover:ring-brand/70",
        "has-[[data-card-main]:focus-visible]:border-brand has-[[data-card-main]:focus-visible]:ring-2 has-[[data-card-main]:focus-visible]:ring-brand/60",
        (selected || inTray) && "border-brand ring-1 ring-brand",
        pickMode && "cursor-copy",
      )}
      onClick={() => onOpen(asset)}
    >
      <header className="flex items-center gap-2.5 px-3 pt-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            data-card-main
            className={cn("block max-w-full truncate text-left text-[13px] leading-snug font-medium outline-none", pickMode ? "cursor-copy" : "cursor-pointer")}
            title={asset.filename}
            aria-label={pickMode ? `Use ${asset.filename} as a reference` : `Open ${asset.filename}`}
          >
            {asset.filename}
          </button>
          <div className="truncate text-[11.5px] text-muted-foreground tabular">
            {formatDate(asset.mtime)} · {formatBytes(asset.bytes)}
          </div>
        </div>
        {match != null && (
          <span
            className="shrink-0 self-start rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular"
            title="How well Jev thinks this matches the search"
          >
            {Math.round(match * 100)}%<span className="sr-only"> match</span>
          </span>
        )}
      </header>
      <div className="flex items-center gap-1 px-3 pt-1.5 pb-2 text-[11.5px] text-muted-foreground" title={crumb}>
        <Folder className="size-3 shrink-0" />
        <span className="truncate">{crumb}</span>
      </div>

      <div
        className={cn("relative aspect-[4/5] overflow-hidden bg-muted", landscape && asset.kind === "video" && "bg-ink")}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        {asset.kind === "audio" ? (
          <div className="grid h-full place-items-center bg-gradient-to-b from-muted to-secondary">
            <AudioLines className="size-10 text-muted-foreground/70" />
          </div>
        ) : asset.hasThumb && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl(asset, "thumb")}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setImgFailed(true)}
            className={cn("h-full w-full", landscape ? "object-contain" : "object-cover")}
          />
        ) : (
          <div className="grid h-full place-items-center text-muted-foreground">
            {asset.deriveStatus === "error" || imgFailed ? (
              <div className="flex flex-col items-center gap-1.5 text-[11.5px]">
                <ImageOff className="size-6" />
                No preview
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-[11.5px]">
                <Loader2 className="size-5 animate-spin" />
                Making preview…
              </div>
            )}
          </div>
        )}

        {hover && asset.hasProxy && (
          <video
            src={mediaUrl(asset, "proxy")}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            className={cn("absolute inset-0 h-full w-full bg-ink", landscape ? "object-contain" : "object-cover")}
          />
        )}
        {hover && !asset.hasProxy && asset.hasSheet && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl(asset, "sheet")} alt="" className="absolute inset-0 h-full w-full bg-ink object-contain" />
        )}

        <div className="pointer-events-none absolute top-2 left-2 flex gap-1">
          {asset.generated && <GeneratedBadge />}
          {asset.needsReview && (
            <span className="inline-flex h-5 items-center gap-1 rounded-md bg-ink/80 px-1.5 text-[11px] font-medium text-paper" title="A Jev answer waits in Review">
              <span className="size-1.5 rounded-full bg-brand" aria-hidden />
              Review
            </span>
          )}
        </div>
        {asset.kind !== "audio" && (onTool || onUseRef || onNewAd) && (
          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            {onNewAd && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewAd(asset);
                }}
                className="flex h-7 items-center gap-1 rounded-md bg-ink/80 px-2 text-[11.5px] font-medium text-paper opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                title="New PAUSED Meta ad with this file (staged as an order file)"
                aria-label={`New PAUSED ad with ${asset.filename}`}
              >
                <SquarePlus className="size-3.5" /> New ad
              </button>
            )}
            {onTool && (
              <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
                <QuickToolsMenu asset={asset} blocked={toolsBlocked ?? null} onTool={onTool} onMenuOpen={onToolsMenu} />
              </div>
            )}
            {onUseRef && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onUseRef(asset);
                }}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium transition-opacity focus-visible:opacity-100",
                  inTray ? "bg-brand text-ink opacity-100" : "bg-ink/80 text-paper opacity-0 group-hover:opacity-100",
                )}
                title={inTray ? "In the reference tray" : "Use as reference"}
                aria-label={inTray ? `${asset.filename} is a reference` : `Use ${asset.filename} as a reference`}
              >
                {inTray ? <Check className="size-3.5" /> : <ImagePlus className="size-3.5" />}
                {inTray ? "Reference" : "Use as reference"}
              </button>
            )}
          </div>
        )}

        <div className="pointer-events-none absolute top-2 right-2 flex gap-1">
          {asset.durationS != null && asset.kind !== "image" && (
            <span className="rounded-md bg-ink/80 px-1.5 py-0.5 text-[11px] font-medium text-paper tabular">
              {formatDuration(asset.durationS)}
            </span>
          )}
          {asset.orientation && asset.kind !== "audio" && (
            <span className="rounded-md bg-ink/80 px-1.5 py-0.5 text-[11px] font-medium text-paper tabular">
              {asset.orientation === "other" ? "Other" : asset.orientation}
            </span>
          )}
        </div>
        {asset.kind === "video" && !asset.hasProxy && asset.hasThumb && (
          <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-ink/70 px-1.5 py-0.5 text-[10.5px] text-paper/90 opacity-0 transition-opacity group-hover:opacity-100">
            Proxy pending · showing contact sheet
          </span>
        )}
      </div>

      {asset.sectionKey === "fkbpros" && (
        <footer className="flex h-9 items-center gap-1 overflow-hidden px-3">
          <ClientChips asset={asset} />
        </footer>
      )}
    </article>
  );
}

export const AssetCard = memo(AssetCardInner);
