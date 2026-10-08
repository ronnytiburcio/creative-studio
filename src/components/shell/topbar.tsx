"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { HardDrive, Loader2, Search, TriangleAlert, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/media";
import { driveWords } from "@/lib/drive-mode";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { useStatus } from "./status-provider";
import { isLibraryPath, openPalette } from "./command-palette";
import { setMeaningPref, useMeaningPref } from "./meaning-pref";

export function SearchBox() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const urlQ = sp.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const [prevUrlQ, setPrevUrlQ] = useState(urlQ);
  if (urlQ !== prevUrlQ) {
    setPrevUrlQ(urlQ);
    setQ(urlQ);
  }
  // The switch shows what the current search uses (the URL); with no search showing, the remembered default.
  const remembered = useMeaningPref();
  const meaning = urlQ ? sp.get("mode") === "meaning" : remembered;
  const onLibrary = isLibraryPath(pathname);

  const go = (value: string, byMeaning: boolean) => {
    const v = value.trim();
    if (onLibrary) {
      const next = new URLSearchParams(sp.toString());
      if (v) next.set("q", v);
      else next.delete("q");
      if (v && byMeaning) next.set("mode", "meaning");
      else next.delete("mode");
      next.delete("asset");
      next.delete("page");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
    } else if (v) {
      router.push(`/search?q=${encodeURIComponent(v)}${byMeaning ? "&mode=meaning" : ""}`);
    }
  };

  const toggle = (on: boolean) => {
    setMeaningPref(on);
    // A search is showing: run it again the other way.
    if (urlQ && onLibrary) go(urlQ, on);
  };

  return (
    <div className="flex min-w-0 items-center gap-3">
      <form
        role="search"
        className="relative w-[520px] max-w-full min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          go(q, meaning);
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (e.target.value === "" && urlQ) go("", meaning);
          }}
          placeholder={
            meaning
              ? "Describe what you're looking for, then press Enter…"
              : onLibrary
                ? "Search this channel by name, folder or what it shows…"
                : "Search all media by name, folder or what it shows…"
          }
          className="h-9 w-full rounded-[10px] border border-input/80 bg-card pr-14 pl-9 text-[13.5px] shadow-[0_1px_1px_rgba(18,21,26,0.03)] transition-colors outline-none placeholder:text-muted-foreground/80 hover:border-foreground/25 focus:border-brand focus:ring-3 focus:ring-brand/15"
          aria-label={meaning ? "Search media by meaning" : "Search media"}
        />
        <button
          type="button"
          onClick={openPalette}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Open command palette"
        >
          ⌘K
        </button>
      </form>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <Switch
              id="meaning-switch"
              checked={meaning}
              onCheckedChange={toggle}
              className="data-[state=checked]:bg-brand"
            />
            <label htmlFor="meaning-switch" className={cn("cursor-pointer text-[13px] select-none", meaning ? "font-medium" : "text-muted-foreground")}>
              Meaning
            </label>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[300px]">
          On: search by meaning. Jev ranks the described files in this channel and its filters by what they show and say. Off: instant search
          by name, folder and description.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function ago(s: number | null) {
  if (s == null) return "never";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function StatusPills() {
  const { drive, worker } = useStatus();
  const busy = worker.alive && worker.pending + worker.running > 0;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href="/jobs"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            {!worker.alive ? (
              <>
                <TriangleAlert className="size-3.5 text-brand-text" />
                <span className="text-brand-text">Worker offline</span>
              </>
            ) : busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                <span className="tabular">{(worker.pending + worker.running).toLocaleString()} queued</span>
              </>
            ) : (
              <>
                <Cpu className="size-3.5" />
                <span>Up to date</span>
              </>
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[360px]">
          <div className="space-y-0.5 text-[12px]">
            <div>Heartbeat {ago(worker.ageS)}</div>
            <div className="tabular">
              {worker.pending} pending · {worker.running} running · {worker.error} errors
            </div>
            {worker.currentFile && <div className="truncate opacity-80">{worker.currentFile}</div>}
            {worker.cacheBytes != null && <div>Cache {formatBytes(worker.cacheBytes)}</div>}
          </div>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium",
              drive.mounted
                ? "border-border bg-card text-foreground"
                : "border-brand/40 bg-brand/10 text-brand-text",
            )}
          >
            <HardDrive className="size-3.5" />
            <span>{drive.label}</span>
            <span
              className={cn("ml-0.5 inline-block size-1.5 rounded-full", drive.mounted ? "bg-foreground/60" : "bg-brand")}
              aria-hidden
            />
            <span className="sr-only">{drive.mounted ? driveWords(drive.mode).up : driveWords(drive.mode).down}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {drive.mounted ? `${drive.path} is ${driveWords(drive.mode).up}` : `${drive.path} is ${driveWords(drive.mode).down}. Browsing from cache.`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function DriveBanner() {
  const { drive } = useStatus();
  if (drive.mounted) return null;
  const words = driveWords(drive.mode);
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 border-b border-brand/25 bg-peach/25 px-5 py-2 text-[13px] text-foreground dark:bg-brand/10"
    >
      <HardDrive className="size-4 text-brand-text" />
      <span className="font-medium">{drive.label} is {words.down}. Browsing from cache.</span>
      <span className="text-muted-foreground">
        Thumbnails and previews still work. Reveal in Finder, originals and Generate come back {words.back}.
      </span>
    </div>
  );
}
