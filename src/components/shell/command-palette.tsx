"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ClipboardPaste,
  Clapperboard,
  FileImage,
  FilePen,
  Gauge,
  House,
  FileVideo,
  FileAudio,
  Film,
  Flame,
  ImageIcon,
  ListOrdered,
  TrendingDown,
  Inbox,
  Layers,
  ListChecks,
  Megaphone,
  SquarePlus,
  RefreshCw,
  Pause,
  Play,
  Kanban,
  Plus,
  PlugZap,
  Scissors,
  Settings,
  Sparkles,
  Type,
  User,
} from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { AssetCard } from "@/lib/queries";
import { formatDuration, libraryPathFor } from "@/lib/media";
import { TOOL_IDS } from "@/lib/gen/tools";
import { needsDriveText, toolsBlocked, toolUnavailable, useGenerate } from "@/components/generate/generate-provider";
import { TOOL_ICON, toolMenuLabel } from "@/components/generate/quick-tools";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import { useNewAd } from "@/components/ads/new-ad-provider";
import { useLabels } from "./labels-provider";
import { companyLabel } from "@/lib/profile-shared";
import {
  requestMetaSyncAction,
  requestYouTubeSyncAction,
  setClassifyPausedAction,
  setDescribePausedAction,
  setHooksPausedAction,
  setMetaPausedAction,
} from "@/app/actions";

const EVENT = "rtm:open-palette";

/** Pages that show a Library (the search box filters them in place). */
export function isLibraryPath(p: string) {
  return /^\/(rtm|fkb|fkbpros\/[a-z0-9]+)\/library$/.test(p) || p === "/search";
}

/** Search by meaning from anywhere: the current Library (channel + filters) when one is open, else all channels. */
function meaningHref(text: string) {
  const url = new URL(window.location.href);
  const onLibrary = isLibraryPath(url.pathname);
  const next = onLibrary ? new URLSearchParams(url.search) : new URLSearchParams();
  next.set("q", text);
  next.set("mode", "meaning");
  next.delete("asset");
  return `${onLibrary ? url.pathname : "/search"}?${next}`;
}

/** The channel base of the page open now ("/rtm", "/fkb", "/fkbpros/all", "/fkbpros/<code>"), or null outside a channel. */
function channelBase(p: string): string | null {
  const m = p.match(/^\/(rtm|fkb|fkbpros\/[a-z0-9]+)(\/|$)/);
  return m ? `/${m[1]}` : null;
}

export function openPalette() {
  window.dispatchEvent(new Event(EVENT));
}

type Nav = { id: string; label: string; hint?: string; href: string; icon: React.ComponentType<{ className?: string }> };

const KIND_ICON = { video: FileVideo, image: FileImage, audio: FileAudio } as const;

/** True when `href` leads into a lane that is switched off (Settings > Lanes): such entries leave the palette. */
function intoLaneOff(href: string, lanesOn: readonly string[]): boolean {
  const m = href.match(/^\/(rtm|fkb)(?=[/?#]|$)/);
  return Boolean(m && !lanesOn.includes(m[1]));
}

export function CommandPalette({
  clients,
  lanesOn = ["rtm", "fkbpros", "fkb"],
  episodes = [],
}: {
  /** Visible clients only (hidden ones never reach the palette). */
  clients: { code: string; name: string }[];
  /** Enabled lane keys: entries into a switched-off lane are left out. */
  lanesOn?: readonly string[];
  /**
   * Prepped Lane A episodes (Phase 6): "New short from Ep N" opens the Shorts board's picker on it; "Cut reel · Ep N" (when
   * it has kept ideas) opens Cut reel on it.
   */
  episodes?: { id: number; num: number; title: string; keptIdeas?: number }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const L = useLabels();
  const A = L.lane.rtm;
  const B = L.lane.fkbpros;
  const C = L.lane.fkb;
  const fullA = L.laneFull.rtm !== A ? L.laneFull.rtm : undefined;
  const fullC = L.laneFull.fkb !== C ? L.laneFull.fkb : undefined;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [assets, setAssets] = useState<AssetCard[]>([]);
  /** "Add hook" / "Paste hooks" outside a channel: the palette asks which channel first. */
  const [pick, setPick] = useState<"add" | "paste" | null>(null);
  const gen = useGenerate();
  const newAd = useNewAd();
  const { drive, classify, describe, hooks, meta, youtube } = useStatus();
  const refreshStatus = useStatusRefresh();
  const reviewCount = classify.needsReview;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      if (term.length < 2) {
        setAssets([]);
        return;
      }
      try {
        const r = await fetch(`/api/assets?scope=all&limit=8&q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        if (r.ok) setAssets((await r.json()).items);
      } catch {
        /* aborted */
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const nav: Nav[] = useMemo(
    () => [
      { id: "rtm", label: A, hint: fullA, href: "/rtm/library", icon: Clapperboard },
      { id: "fkb-all", label: `All ${B}`, href: "/fkbpros/all/library", icon: Layers },
      ...clients.map((c) => ({ id: `c-${c.code}`, label: c.name, hint: c.code, href: `/fkbpros/${c.code}/library`, icon: User })),
      { id: "fkb", label: C, hint: fullC, href: "/fkb/library", icon: House },
      { id: "hooks-fkb", label: `Hooks · ${C}`, hint: fullC, href: "/fkb/hooks", icon: Type },
      { id: "hook-add-fkb", label: `Add hook · ${C}`, hint: `a text hook for ${C}`, href: "/fkb/hooks?dialog=add", icon: Plus },
      { id: "review", label: "Review queue", hint: reviewCount ? `${reviewCount} to review` : "nothing to review", href: "/review", icon: Inbox },
      { id: "rubric", label: "Rubric", hint: `hook scoring rubric, ${A} notes, who's who`, href: "/rubric", icon: Gauge },
      ...clients.map((c) => ({ id: `notes-${c.code}`, label: `Client notes · ${c.name}`, hint: c.code, href: `/fkbpros/${c.code}/client`, icon: FilePen })),
      { id: "notes-fkb", label: `Client notes · ${C}`, hint: fullC, href: "/fkb/client", icon: FilePen },
      { id: "run-all", label: `Running · All ${B}`, hint: "Meta ads", href: "/fkbpros/all/running", icon: Megaphone },
      ...clients.map((c) => ({ id: `run-${c.code}`, label: `Running · ${c.name}`, hint: c.code, href: `/fkbpros/${c.code}/running`, icon: Megaphone })),
      { id: "run-fkb", label: `Running · ${C}`, hint: fullC, href: "/fkb/running", icon: Megaphone },
      { id: "calibration", label: "Calibration", hint: "hook scores vs real Meta and YouTube results (Rubric page)", href: "/rubric#calibration", icon: Gauge },
      { id: "shorts-rtm", label: `Shorts · ${A}`, hint: "YouTube Shorts results", href: "/rtm/shorts#shorts", icon: Scissors },
      { id: "shorts-board", label: "Shorts board", hint: `${A} moments: Idea, Cutting, Review, Ready to post, Posted`, href: "/rtm/shorts#board", icon: Kanban },
      ...episodes.map((e) => ({ id: `new-short-${e.id}`, label: `New short from Ep${e.num}`, hint: e.title, href: `/rtm/shorts?newshort=${e.id}#board`, icon: Plus })),
      ...episodes
        .filter((e) => (e.keptIdeas ?? 0) > 0)
        .map((e) => ({
          id: `cut-reel-${e.id}`,
          label: `Cut reel · Ep${e.num}`,
          hint: `${e.title}: ${e.keptIdeas} kept idea${e.keptIdeas === 1 ? "" : "s"} to hand to ${L.skills.reelCut}`,
          href: `/rtm/shorts?cutreel=${e.id}#board`,
          icon: Scissors,
        })),
      { id: "yt-connect", label: "Connect YouTube", hint: `Settings: read-only access to the ${A} channel`, href: "/settings#youtube", icon: PlugZap },
      { id: "flags-fatiguing", label: "Flags · Fatiguing", hint: `All ${B} ads flagged fatiguing`, href: "/fkbpros/all/running?flag=fatiguing", icon: TrendingDown },
      { id: "flags-winner", label: "Flags · Winners", hint: `All ${B} ads worth new variants`, href: "/fkbpros/all/running?flag=winner", icon: Flame },
      ...clients.map((c) => ({ id: `test-${c.code}`, label: `Test order · ${c.name}`, hint: c.code, href: `/fkbpros/${c.code}/client#test-order`, icon: ListOrdered })),
      { id: "test-fkb", label: `Test order · ${C}`, hint: fullC, href: "/fkb/client#test-order", icon: ListOrdered },
      { id: "ad-orders", label: "Ad orders", hint: "new PAUSED Meta ads staged as files (Jobs page)", href: "/jobs#ad-orders", icon: Megaphone },
      { id: "jobs", label: "Jobs", href: "/jobs", icon: ListChecks },
      { id: "settings", label: "Settings", href: "/settings", icon: Settings },
    ].filter((n) => !intoLaneOff(n.href, lanesOn)),
    [clients, episodes, reviewCount, lanesOn, A, B, C, fullA, fullC, L.skills.reelCut],
  );
  const hookChannels = useMemo(
    () => [
      { id: "ch-rtm", label: A, base: "/rtm" },
      { id: "ch-fkb", label: companyLabel(L), base: "/fkb" },
      { id: "ch-all", label: `All ${B} (shared)`, base: "/fkbpros/all" },
      ...clients.map((c) => ({ id: `ch-${c.code}`, label: c.name, base: `/fkbpros/${c.code}` })),
    ].filter((c) => !intoLaneOff(c.base, lanesOn)),
    [clients, lanesOn, A, B, L],
  );
  const term = q.trim().toLowerCase();
  const navHits = term ? nav.filter((n) => `${n.label} ${n.hint ?? ""}`.toLowerCase().includes(term)) : nav;

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    setPick(null);
    router.push(href);
  };
  const hookDialog = (mode: "add" | "paste") => {
    const base = channelBase(pathname);
    if (base) go(`${base}/hooks?dialog=${mode}`);
    else {
      setPick(mode);
      setQ("");
    }
  };
  const hookHits = [
    { id: "hook-add", label: "Add hook", mode: "add" as const, icon: Plus },
    { id: "hook-paste", label: "Paste hooks", mode: "paste" as const, icon: ClipboardPaste },
  ].filter((x) => !term || `${x.label} hooks`.toLowerCase().includes(term));
  const hookHint = channelBase(pathname) ? "in this channel" : "pick a channel";
  const act = (fn: () => void) => {
    setOpen(false);
    setQ("");
    fn();
  };

  // Search by meaning for the typed text (a Jev search, in the Library open now or all channels), plus Pause / Resume
  // for the two AI queues.
  const meaningText = q.trim().slice(0, 200);
  const aiHits = [
    {
      id: "ai-describe",
      label: describe.paused ? "Resume describing" : "Pause describing",
      hint: "Ollama + whisper",
      icon: describe.paused ? Play : Pause,
      run: () => setDescribePausedAction({ paused: !describe.paused }),
    },
    {
      id: "ai-classify",
      label: classify.paused ? "Resume classifying" : "Pause classifying",
      hint: "Jev sorting",
      icon: classify.paused ? Play : Pause,
      run: () => setClassifyPausedAction({ paused: !classify.paused }),
    },
    {
      id: "ai-hooks",
      label: hooks.paused ? "Resume hook scoring" : "Pause hook scoring",
      hint: "Jev hook scores",
      icon: hooks.paused ? Play : Pause,
      run: () => setHooksPausedAction({ paused: !hooks.paused }),
    },
    {
      id: "meta-refresh",
      label: "Refresh Meta",
      hint: meta.state === "running" || meta.requested ? "syncing now" : "read every ad account now",
      icon: RefreshCw,
      run: () => requestMetaSyncAction(),
    },
    {
      id: "yt-sync",
      label: "Sync YouTube",
      hint: youtube.connected ? (youtube.state === "running" || youtube.requested ? "syncing now" : `read the ${A} channel's Shorts now`) : "connect YouTube in Settings first",
      icon: RefreshCw,
      run: () => requestYouTubeSyncAction(),
    },
    {
      id: "meta-pause",
      label: meta.paused ? "Resume Meta sync" : "Pause Meta sync",
      hint: "daily 6:00 PM read",
      icon: meta.paused ? Play : Pause,
      run: () => setMetaPausedAction({ paused: !meta.paused }),
    },
  ].filter((x) => !term || `${x.label} ${x.hint}`.toLowerCase().includes(term));
  const runAi = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    act(() => {
      void fn().then(async (r) => {
        if (!r.ok) toast.error(r.error ?? "Something went wrong");
        else if (r.message) toast.success(r.message);
        await refreshStatus();
      });
    });

  // New PAUSED ad (Phase 6 slice 3): one entry per Lane B client + Lane C (never Lane A).
  const adHits = [
    ...clients.map((c) => ({ id: `new-ad-${c.code}`, label: `New PAUSED ad · ${c.name}`, channel: c.code })),
    ...(lanesOn.includes("fkb") ? [{ id: "new-ad-fkb", label: `New PAUSED ad · ${C}`, channel: "fkb" }] : []),
  ].filter((x) => !term || `${x.label} meta ad new paused`.toLowerCase().includes(term));

  // Generate entries (+ the quick tools of the asset open in the drawer), filtered by the same search text.
  const genBlocked = drive.mounted ? null : needsDriveText(drive);
  const genHits = [
    { id: "gen-image", label: "Generate image", icon: ImageIcon, run: () => gen.openPanel({ mode: "hf-image" }) },
    { id: "gen-video", label: "Generate video", icon: Film, run: () => gen.openPanel({ mode: "hf-video" }) },
  ].filter((x) => !term || x.label.toLowerCase().includes(term) || "generate".includes(term));
  const drawer = gen.drawerAsset && gen.drawerAsset.kind !== "audio" ? gen.drawerAsset : null;
  const toolsOff = toolsBlocked(drive, gen.higgsfield);
  const toolHits = drawer
    ? TOOL_IDS.map((t) => ({ tool: t, label: toolMenuLabel(t, drawer.kind), off: toolsOff ?? toolUnavailable(t, drawer) })).filter(
        (x) => !term || `${x.label} quick tool ${drawer.filename}`.toLowerCase().includes(term),
      )
    : [];

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPick(null);
      }}       title="Command palette"
      description="Jump to a channel, find a file, or start a generation"
      className="sm:max-w-[600px]"
    >
      <Command shouldFilter={false} className="rounded-xl">
        <CommandInput
          placeholder={pick ? `Which channel? (${pick === "add" ? "Add hook" : "Paste hooks"})` : "Jump to a channel, generate, or search files by name or what they show…"}
          value={q}
          onValueChange={setQ}
        />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>No matches.</CommandEmpty>
          {pick ? (
            <CommandGroup heading={pick === "add" ? "Add hook to" : "Paste hooks into"}>
              {hookChannels
                .filter((c) => !term || c.label.toLowerCase().includes(term))
                .map((c) => (
                  <CommandItem key={c.id} value={c.id} onSelect={() => go(`${c.base}/hooks?dialog=${pick}`)}>
                    <Layers className="size-4 text-muted-foreground" />
                    <span>{c.label}</span>
                    <span className="ml-auto text-[12px] text-muted-foreground">Hooks tab</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          ) : (
          <>
          {genHits.length > 0 && (
            <CommandGroup heading="Generate">
              {genHits.map((x) => (
                <CommandItem key={x.id} value={x.id} disabled={Boolean(genBlocked)} onSelect={() => act(x.run)}>
                  <x.icon className="size-4 text-muted-foreground" />
                  <span>{x.label}</span>
                  {genBlocked && <span className="ml-auto text-[12px] text-muted-foreground">{genBlocked}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {drawer && toolHits.length > 0 && (
            <CommandGroup heading={`Quick tools · ${drawer.filename}`}>
              {toolHits.map((x) => {
                const Icon = TOOL_ICON[x.tool];
                return (
                  <CommandItem key={x.tool} value={`tool-${x.tool}`} disabled={Boolean(x.off)} onSelect={() => act(() => gen.openTool(drawer, x.tool))}>
                    <Icon className="size-4 text-muted-foreground" />
                    <span>{x.label}</span>
                    <span className="ml-auto text-[12px] text-muted-foreground">{x.off ?? "Higgsfield · asks to confirm"}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          {adHits.length > 0 && term.length > 0 && (
            <CommandGroup heading="Meta ads">
              {adHits.map((x) => (
                <CommandItem key={x.id} value={x.id} onSelect={() => act(() => newAd.open({ channel: x.channel }))}>
                  <SquarePlus className="size-4 text-muted-foreground" />
                  <span>{x.label}</span>
                  <span className="ml-auto text-[12px] text-muted-foreground">staged as an order file</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {hookHits.length > 0 && (
            <CommandGroup heading="Hooks">
              {hookHits.map((x) => (
                <CommandItem key={x.id} value={x.id} onSelect={() => hookDialog(x.mode)}>
                  <x.icon className="size-4 text-muted-foreground" />
                  <span>{x.label}</span>
                  <span className="ml-auto text-[12px] text-muted-foreground">{hookHint}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {navHits.length > 0 && (
            <CommandGroup heading="Go to">
              {navHits.map((n) => (
                <CommandItem key={n.id} value={n.id} onSelect={() => go(n.href)}>
                  <n.icon className="size-4 text-muted-foreground" />
                  <span>{n.label}</span>
                  {n.hint && <span className="ml-auto text-[12px] text-muted-foreground">{n.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {aiHits.length > 0 && (
            <CommandGroup heading="AI and sync">
              {aiHits.map((x) => (
                <CommandItem key={x.id} value={x.id} onSelect={() => runAi(x.run)}>
                  <x.icon className="size-4 text-muted-foreground" />
                  <span>{x.label}</span>
                  <span className="ml-auto text-[12px] text-muted-foreground">{x.hint}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {meaningText.length >= 2 && (
            <CommandGroup heading="Search">
              <CommandItem value="search-meaning" onSelect={() => go(meaningHref(meaningText))}>
                <Sparkles className="size-4 text-muted-foreground" />
                <span className="min-w-0 truncate">
                  Search by meaning: <span className="font-medium">{meaningText}</span>
                </span>
                <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
                  {isLibraryPath(pathname) ? "in this Library view" : "in all channels"}
                </span>
              </CommandItem>
            </CommandGroup>
          )}
          {assets.length > 0 && (
            <CommandGroup heading="Files">
              {assets.map((a) => {
                const Icon = KIND_ICON[a.kind];
                const base = libraryPathFor(a.sectionKey);
                return (
                  <CommandItem key={a.id} value={`asset-${a.id}`} onSelect={() => go(`${base}?asset=${a.id}`)}>
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="min-w-0 truncate">{a.filename}</span>
                    <span className="ml-auto max-w-[45%] truncate text-[12px] text-muted-foreground">
                      {a.durationS ? `${formatDuration(a.durationS)} · ` : ""}
                      {[a.rootLabel, a.relDir].filter(Boolean).join(" / ")}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
