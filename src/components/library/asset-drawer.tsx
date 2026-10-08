"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Anchor, ArrowUpRight, ChevronDown, ChevronUp, Copy, ExternalLink, FolderOpen, FolderTree, ImagePlus, Loader2, Plus, ScanEye, Sparkles, SquarePlus, Trash2, X } from "lucide-react";
import { driveWords } from "@/lib/drive-mode";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration } from "@/lib/media";
import type { AssetDetail } from "@/lib/queries";
import { addVideoHookAction, describeAgain, discardAsset, revealInFinder, setAssetClient } from "@/app/actions";
import { describedWith } from "@/lib/ai/describe";
import { useStatus } from "@/components/shell/status-provider";
import { needsDriveText, toolUnavailable, useGenerate, type GenMode } from "@/components/generate/generate-provider";
import { QuickToolButtons, TOOL_ICON } from "@/components/generate/quick-tools";
import { toolTitle } from "@/lib/gen/tools";
import type { GenerationDetails } from "@/lib/gen/details";
import { ROLE_LABEL } from "@/lib/gen/rules";
import { destLabel as destLabelOf, destLabelsOf, parseDestKey } from "@/lib/gen/layout";
import { GeneratedBadge, JevMark, KIND_ICON, mediaUrl } from "./asset-card";
import { ClassBlock } from "./class-block";
import { useNewAd } from "@/components/ads/new-ad-provider";
import { useLabels } from "@/components/shell/labels-provider";

const BROWSER_VIDEO = new Set(["mp4", "m4v"]);
const BROWSER_IMAGE = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function fmtTime(ms: number | null) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function AssetDrawer({
  assetId,
  onClose,
  clients,
  onOpenAsset,
  onDiscarded,
  adChannel = null,
}: {
  assetId: number | null;
  onClose: () => void;
  clients: { code: string; short: string }[];
  /** Open another asset in the drawer (reference thumbnails). */
  onOpenAsset?: (id: number) => void;
  /** A generated file went to the Trash: drop its card right away. */
  onDiscarded?: (id: number) => void;
  /** The client channel / Lane C the drawer was opened in (a shared Lane B file then goes to that client). */
  adChannel?: string | null;
}) {
  const newAd = useNewAd();
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { drive } = useStatus();
  const gen = useGenerate();

  const load = useCallback(async (id: number) => {
    try {
      const r = await fetch(`/api/assets/${id}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 404 ? "This file is no longer in the index." : `HTTP ${r.status}`);
      setAsset(await r.json());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!assetId) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await load(assetId);
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, load, drive.mounted]);

  const a = asset && asset.id === assetId ? asset : null;
  const originalOk = !!a && a.originalAvailable && (!a.onDrive || drive.mounted);

  // While a "Describe again" / "Classify again" waits in the worker, refresh the drawer so the result shows when it lands.
  const aiRequested = Boolean(a?.ai.requested || a?.ai.cls?.requested);
  useEffect(() => {
    if (!assetId || !aiRequested) return;
    const t = setInterval(() => void load(assetId), 3000);
    return () => clearInterval(t);
  }, [assetId, aiRequested, load]);

  const redescribe = () => {
    if (!a) return;
    startTransition(async () => {
      const r = await describeAgain({ assetId: a.id });
      if (!r.ok) toast.error(r.error);
      else toast.success(r.message ?? "Queued.");
      await load(a.id);
    });
  };

  // cmd+K offers the quick tools of the asset open here.
  const { setDrawerAsset } = gen;
  useEffect(() => {
    setDrawerAsset(a ? { id: a.id, filename: a.filename, v: a.v, kind: a.kind, hasThumb: a.hasThumb, durationS: a.durationS } : null);
    return () => setDrawerAsset(null);
  }, [a, setDrawerAsset]);
  const needsDrive = needsDriveText(drive);

  const toggleClient = (code: string, on: boolean) => {
    if (!a) return;
    startTransition(async () => {
      const r = await setAssetClient({ assetId: a.id, code, on });
      if (!r.ok) toast.error(r.error);
      await load(a.id);
      router.refresh();
    });
  };

  const reveal = () => {
    if (!a) return;
    startTransition(async () => {
      const r = await revealInFinder({ assetId: a.id });
      if (!r.ok) toast.error(r.error);
    });
  };

  const addAsReference = () => {
    if (!a) return;
    gen.openPanel({ refs: [a] });
    onClose(); // the panel sits where the drawer was
  };

  /**
   * Reopen the Generate panel with this run: engine, model, prompt, settings, references still available, destination.
   * A quick tool output instead reopens that tool's confirm on the same source.
   */
  const remix = () => {
    const d = a?.generation;
    if (!d) return;
    if (d.tool) {
      const src = d.toolSource;
      if (!src?.available || src.kind === "audio") {
        toast.error("The source is no longer available.");
        return;
      }
      gen.openTool({ id: src.id, filename: src.filename, v: src.v, kind: src.kind, hasThumb: src.hasThumb, durationS: src.durationS }, d.tool);
      return;
    }
    const mode: GenMode = d.engine === "codex" ? "codex" : d.jobType === "gen_video" ? "hf-video" : "hf-image";
    const usable = d.references.filter((r) => r.available);
    gen.openPanel({
      replaceRefs: true,
      refs: usable.map(({ id, filename, v, kind, hasThumb, proof }) => ({ id, filename, v, kind, hasThumb, proof })),
      roles: Object.fromEntries(usable.map((r) => [r.id, r.role])),
      preset: { mode, model: d.model, prompt: d.prompt, brandGuard: d.brandGuard, params: d.params },
      dest: d.destination ?? undefined,
    });
    onClose();
    const left = d.references.length - usable.length;
    if (left > 0) toast(`${left} reference${left === 1 ? " is" : "s are"} no longer available and ${left === 1 ? "was" : "were"} left out.`);
  };

  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const discard = () => {
    if (!a) return;
    const id = a.id;
    startTransition(async () => {
      const r = await discardAsset({ assetId: id });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setConfirmDiscard(false);
      toast.success(r.message ?? "Moved to the Trash.");
      onDiscarded?.(id);
      onClose();
      router.refresh();
    });
  };

  const copyPath = async () => {
    if (!a) return;
    try {
      await navigator.clipboard.writeText(a.path);
      toast.success("Path copied");
    } catch {
      toast.error("Clipboard not available");
    }
  };

  const Icon = a ? KIND_ICON[a.kind] : null;
  const taggedCodes = new Set(a?.clients.map((c) => c.code));

  return (
    <Sheet open={assetId != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto p-0 data-[side=right]:w-[min(640px,100vw)] data-[side=right]:sm:max-w-none">
        <SheetHeader className="border-b border-border px-5 py-4 pr-12">
          <SheetTitle className="flex items-center gap-2 text-[15px] font-semibold">
            {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{a?.filename ?? (loadError ? "Unavailable" : "Loading…")}</span>
            {a?.generated && <GeneratedBadge className="shrink-0" />}
          </SheetTitle>
          <SheetDescription className="truncate text-[12.5px]">
            {a ? [a.rootLabel, a.relDir].filter(Boolean).join(" / ") : (loadError ?? " ")}
          </SheetDescription>
        </SheetHeader>

        {!a ? (
          <div className="grid h-64 place-items-center text-muted-foreground">
            {loadError ? <span className="text-[13px]">{loadError}</span> : <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : (
          <div className="space-y-6 px-5 py-5">
            <Preview a={a} originalOk={originalOk} />

            {a.ai.describable && <AiSection a={a} onDescribeAgain={redescribe} pending={pending} />}

            {a.ai.cls && (
              <ClassBlock
                a={a}
                clients={clients}
                onChanged={async () => {
                  await load(a.id);
                  router.refresh();
                }}
              />
            )}

            {a.kind === "video" && (
              <HookSection
                a={a}
                pending={pending}
                onAdd={() =>
                  startTransition(async () => {
                    const r = await addVideoHookAction({ assetId: a.id });
                    if (!r.ok) toast.error(r.error);
                    else toast.success(r.message ?? "Added.");
                    await load(a.id);
                    router.refresh();
                  })
                }
              />
            )}

            {(a.kind === "video" || a.kind === "image") && (a.sectionKey === "fkbpros" || a.sectionKey === "fkb") && (
              <section>
                <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Meta ad</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" className="h-11 sm:h-8" onClick={() => newAd.open({ assetId: a.id, channel: adChannel ?? (a.sectionKey === "fkb" ? "fkb" : null) })}>
                    <SquarePlus /> New PAUSED ad with this file
                  </Button>
                  <span className="text-[12px] text-muted-foreground">Staged as an order file; applied in a Claude session.</span>
                </div>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">File</h3>
              <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-[12px] leading-relaxed break-all">
                {a.path}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={copyPath}>
                  <Copy /> Copy path
                </Button>
                <DriveGated ok={originalOk} hint={needsDrive}>
                  <Button variant="outline" size="sm" onClick={reveal} disabled={!originalOk || pending}>
                    <FolderOpen /> Reveal in Finder
                  </Button>
                </DriveGated>
                <DriveGated ok={originalOk} hint={needsDrive}>
                  {originalOk ? (
                    <Button variant="outline" size="sm" asChild>
                      <a href={mediaUrl(a, "original")} target="_blank" rel="noreferrer">
                        <ExternalLink /> Open original
                      </a>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled>
                      <ExternalLink /> Open original
                    </Button>
                  )}
                </DriveGated>
                {a.kind !== "audio" && (
                  <DriveGated ok={originalOk} hint={needsDrive}>
                    <Button variant="outline" size="sm" onClick={addAsReference} disabled={!originalOk}>
                      <ImagePlus /> Use as reference
                    </Button>
                  </DriveGated>
                )}
              </div>
            </section>

            {a.kind !== "audio" && (
              <section>
                <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Quick tools</h3>
                <QuickToolButtons asset={a} originalOk={originalOk} />
              </section>
            )}

            {a.generated && (
              <GenerationSection
                d={a.generation}
                clients={clients}
                onRemix={remix}
                onOpenAsset={onOpenAsset}
                discard={
                  a.discardable ? (
                    <DriveGated ok={drive.mounted} hint={needsDrive}>
                      <Button variant="outline" size="sm" onClick={() => setConfirmDiscard(true)} disabled={!drive.mounted || pending}>
                        <Trash2 /> Discard
                      </Button>
                    </DriveGated>
                  ) : null
                }
              />
            )}

            {a.sectionKey === "fkbpros" && (
              <section>
                <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Clients</h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  {a.clients.length === 0 && (
                    <span className="inline-flex h-7 items-center rounded-lg border border-dashed border-foreground/20 px-2 text-[12.5px] text-muted-foreground">
                      Shared (shows in every client channel)
                    </span>
                  )}
                  {a.clients.map((c) => (
                    <span
                      key={c.code}
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted pr-1 pl-2 text-[12.5px] font-medium"
                    >
                      {c.source === "folder" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <FolderTree className="size-3.5 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>From a folder rule (edit in Settings)</TooltipContent>
                        </Tooltip>
                      )}
                      {c.short}
                      {c.source === "jev" && <JevMark />}
                      {c.source === "manual" || c.source === "jev" ? (
                        <button
                          type="button"
                          onClick={() => toggleClient(c.code, false)}
                          className="grid size-5 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                          aria-label={c.source === "jev" ? `Remove ${c.short} (tagged by Jev; counts as a correction)` : `Remove ${c.short}`}
                          disabled={pending}
                        >
                          <X className="size-3" />
                        </button>
                      ) : (
                        <span className="w-1" />
                      )}
                    </span>
                  ))}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" disabled={pending}>
                        <Plus /> Tag client
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-56 p-0">
                      <Command>
                        <CommandInput placeholder="Client…" />
                        <CommandList>
                          <CommandEmpty>No clients.</CommandEmpty>
                          <CommandGroup>
                            {clients
                              .filter((c) => !taggedCodes.has(c.code))
                              .map((c) => (
                                <CommandItem key={c.code} value={`${c.short} ${c.code}`} onSelect={() => toggleClient(c.code, true)}>
                                  {c.short}
                                  <span className="ml-auto text-[11.5px] text-muted-foreground">{c.code}</span>
                                </CommandItem>
                              ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Details</h3>
              <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                <Meta k="Kind" v={`${a.kind} · .${a.ext}`} />
                {a.codec && <Meta k="Codec" v={a.codec} />}
                {a.width && a.height && <Meta k="Dimensions" v={`${a.width} × ${a.height}`} />}
                {a.orientation && <Meta k="Orientation" v={a.orientation} />}
                {a.durationS != null && <Meta k="Duration" v={formatDuration(a.durationS)} />}
                {a.fps != null && <Meta k="Frame rate" v={`${a.fps} fps`} />}
                <Meta k="Size" v={`${formatBytes(a.bytes)} (${a.bytes.toLocaleString()} bytes)`} />
                <Meta k="Modified" v={fmtTime(a.mtime)} />
                {a.createdAt && <Meta k="Created" v={fmtTime(a.createdAt)} />}
                <Meta k="Indexed" v={fmtTime(a.indexedAt)} />
                <Meta
                  k="Previews"
                  v={
                    <span className={cn(a.deriveStatus === "error" && "text-brand-text")}>
                      {a.deriveStatus}
                      {a.kind === "video" && ` · proxy ${a.hasProxy ? "ready" : "pending"}`}
                    </span>
                  }
                />
                {a.deriveError && <Meta k="Last error" v={<span className="text-brand-text">{a.deriveError}</span>} />}
                <Meta k="Fingerprint" v={<span className="font-mono text-[11.5px] break-all">{a.sha256 ?? "…"}</span>} />
              </dl>
            </section>
          </div>
        )}
      </SheetContent>
      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Discard this file?</DialogTitle>
            <DialogDescription>
              {a?.filename} and its generation details go to the macOS Trash. You can put them back from the Trash.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep it</Button>
            </DialogClose>
            <Button onClick={discard} disabled={pending || !drive.mounted} className="bg-brand text-ink hover:bg-brand/90">
              {pending ? <Loader2 className="animate-spin" /> : <Trash2 />} Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}

function fmtIso(iso: string | null) {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : fmtTime(t);
}

function GenerationSection({
  d,
  clients,
  onRemix,
  onOpenAsset,
  discard,
}: {
  d: GenerationDetails | null;
  clients: { code: string; short: string }[];
  onRemix: () => void;
  onOpenAsset?: (id: number) => void;
  discard: React.ReactNode;
}) {
  const L = useLabels();
  const heading = <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Generation</h3>;
  if (!d) {
    return (
      <section>
        {heading}
        <p className="text-[13px] text-muted-foreground">Made by Studio. Its details could not be read (no sidecar next to the file).</p>
        {discard && <div className="mt-2 flex flex-wrap gap-2">{discard}</div>}
      </section>
    );
  }
  const dest = d.destination ? parseDestKey(d.destination) : null;
  const destLabel = dest ? destLabelOf(dest, clients, destLabelsOf(L)) : null;
  const params = Object.entries(d.params).filter(([, v]) => v !== null && v !== "");
  const src = d.toolSource;
  const ToolIcon = d.tool ? TOOL_ICON[d.tool] : null;
  const rerunOff = d.tool ? (!src?.available ? "The source is no longer available" : src.kind === "audio" ? "Not an image or video" : toolUnavailable(d.tool, src)) : null;
  return (
    <section>
      {heading}
      {d.tool ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2">
          {ToolIcon && <ToolIcon className="size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 text-[13.5px]">
            <span className="font-medium">{toolTitle(d.tool, d.toolDetail)}</span>
            {d.toolDetail && d.tool !== "upscale" && <span className="text-muted-foreground"> · {d.toolDetail}</span>}
            <span className="text-muted-foreground"> on</span>
          </div>
          {src && (
            <button
              type="button"
              onClick={() => onOpenAsset?.(src.id)}
              disabled={!onOpenAsset}
              className="group flex min-w-0 items-center gap-2 text-left"
              title={`Open the source: ${src.filename}`}
            >
              <span className="size-10 shrink-0 overflow-hidden rounded-md border border-border bg-muted transition-colors group-hover:border-brand/70">
                {src.hasThumb && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/media/${src.id}/thumb${src.v ? `?v=${src.v}` : ""}`} alt="" className="h-full w-full object-cover" />
                )}
              </span>
              <span className="max-w-[220px] truncate text-[12.5px] group-hover:underline">{src.filename}</span>
            </button>
          )}
        </div>
      ) : (
        <>
          <blockquote className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">{d.prompt}</blockquote>
          {d.brandGuard && <div className="mt-1 text-[12px] text-muted-foreground">Brand guard was on.</div>}
        </>
      )}
      <dl className="mt-3 grid grid-cols-[130px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <Meta k="Engine" v={d.engineLabel} />
        <Meta
          k="Model"
          v={
            <>
              {d.modelLabel} <span className="font-mono text-[11.5px] text-muted-foreground">{d.model}</span>
            </>
          }
        />
        {params.length > 0 && (
          <Meta
            k="Settings"
            v={
              <span className="flex flex-wrap gap-1">
                {params.map(([k, v]) => (
                  <span key={k} className="rounded-md bg-muted px-1.5 text-[12px]">
                    {k.replace(/_/g, " ")} <span className="font-medium">{String(v)}</span>
                  </span>
                ))}
              </span>
            }
          />
        )}
        <Meta
          k="Cost"
          v={
            d.billing === "chatgpt"
              ? "ChatGPT plan"
              : d.credits != null
                ? d.creditsMinimum
                  ? `at least ${d.credits} credits (quoted without the clip length)`
                  : `${d.credits} credits`
                : "not recorded"
          }
        />
        {d.createdAt && <Meta k="Created" v={fmtIso(d.createdAt)} />}
        {destLabel && <Meta k="Saved to" v={destLabel} />}
      </dl>
      {d.references.length > 0 && !d.tool && (
        <div className="mt-3">
          <div className="mb-1.5 text-[12px] text-muted-foreground">References</div>
          <div className="flex flex-wrap gap-2">
            {d.references.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onOpenAsset?.(r.id)}
                disabled={!onOpenAsset}
                className="group w-[64px] text-left"
                title={`${r.filename} · ${ROLE_LABEL[r.role]}`}
              >
                <div className="size-[64px] overflow-hidden rounded-lg border border-border bg-muted transition-colors group-hover:border-brand/70">
                  {r.hasThumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/media/${r.id}/thumb${r.v ? `?v=${r.v}` : ""}`} alt={r.filename} className="h-full w-full object-cover" />
                  ) : (
                    <div className="grid h-full place-items-center p-1 text-center text-[10px] text-muted-foreground">{r.filename}</div>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{ROLE_LABEL[r.role]}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {d.tool ? (
          <DriveGated ok={!rerunOff} hint={rerunOff ?? ""}>
            <Button variant="outline" size="sm" onClick={onRemix} disabled={Boolean(rerunOff)}>
              <Sparkles className="text-brand-text" /> Run again
            </Button>
          </DriveGated>
        ) : (
          <Button variant="outline" size="sm" onClick={onRemix}>
            <Sparkles className="text-brand-text" /> Remix
          </Button>
        )}
        {discard}
      </div>
    </section>
  );
}

/** Longer than this (characters or lines) starts collapsed. */
const DESCRIPTION_CLAMP = { chars: 560, lines: 8 };

/**
 * "AI description": what the local vision model saw, the spoken opening (videos), model + when, Describe again.
 * States: described, queued / paused / waiting for previews, error. No nested interactive elements.
 */
function AiSection({ a, onDescribeAgain, pending }: { a: AssetDetail; onDescribeAgain: () => void; pending: boolean }) {
  const { describe } = useStatus();
  const [expanded, setExpanded] = useState(false);
  const ai = a.ai;
  const long = !!ai.description && (ai.description.length > DESCRIPTION_CLAMP.chars || ai.description.split("\n").length > DESCRIPTION_CLAMP.lines);
  const waiting = ai.requested
    ? "Queued: described next."
    : ai.waitingForPreviews
      ? a.kind === "video"
        ? "Waiting for its previews (poster, contact sheet and proxy) to be made."
        : "Waiting for its thumbnail to be made."
      : describe.paused
        ? "Not described yet. Describing is paused in Settings; Describe again runs it now."
        : "Queued. Not described yet.";
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        AI description
      </h3>
      {ai.description ? (
        <>
          <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-[13.5px] leading-relaxed">
            <div id={`ai-desc-${a.id}`} className={cn("whitespace-pre-wrap", long && !expanded && "line-clamp-7")}>
              {ai.description}
            </div>
          </div>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls={`ai-desc-${a.id}`}
              className="mt-1 inline-flex items-center gap-1 rounded-md text-[12px] font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              {expanded ? "Show less" : "Show all"}
            </button>
          )}
        </>
      ) : ai.error ? null : (
        <div className="rounded-lg border border-dashed border-foreground/20 px-3 py-2 text-[13px] text-muted-foreground">{waiting}</div>
      )}
      {ai.error && (
        <div className="mt-2 rounded-lg border border-brand/40 px-3 py-2 text-[12.5px] text-brand-text">
          {ai.description ? ai.error : `Could not describe: ${ai.error}`}
        </div>
      )}
      {a.kind === "video" && ai.spokenOpen != null && (
        <div className="mt-3">
          <div className="mb-1 text-[12px] text-muted-foreground">Spoken opening (first 15 s)</div>
          {ai.spokenOpen ? (
            <blockquote className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-[13.5px] leading-relaxed">“{ai.spokenOpen}”</blockquote>
          ) : (
            <div className="text-[13px] text-muted-foreground">No speech</div>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="outline" size="sm" onClick={onDescribeAgain} disabled={pending || ai.requested}>
          {ai.requested ? <Loader2 className="animate-spin" /> : <ScanEye />} {ai.requested ? "Describing…" : "Describe again"}
        </Button>
        {ai.description && (
          <span className="text-[12px] text-muted-foreground">
            {describedWith(ai.model, ai.promptVersion)}
            {ai.describedAt ? ` · ${fmtTime(ai.describedAt)}` : ""}
            {!ai.upToDate && " · older model or prompt, queued to be described again"}
          </span>
        )}
      </div>
    </section>
  );
}

/** Videos: their hook on the Hooks tab (Phase 4), or "Add as hook". */
function HookSection({ a, pending, onAdd }: { a: AssetDetail; pending: boolean; onAdd: () => void }) {
  const h = a.hook;
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Hook</h3>
      {h ? (
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={h.href}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] transition-colors hover:border-foreground/20 hover:bg-hover"
          >
            <Anchor className="size-3.5 text-muted-foreground" />
            <span>Hook</span>
            <span aria-hidden className="text-muted-foreground">·</span>
            <span className="font-medium tabular">{h.overall != null ? h.overall.toFixed(1) : "not scored yet"}</span>
            {h.archived && <span className="text-muted-foreground">(archived)</span>}
            <ArrowUpRight className="size-3.5 text-muted-foreground" />
          </Link>
          <span className="text-[12px] text-muted-foreground">Opens its row on the Hooks tab (Video view).</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onAdd} disabled={pending || !a.ai.description}>
            <Anchor /> Add as hook
          </Button>
          <span className="text-[12px] text-muted-foreground">
            {a.ai.description
              ? "Adds it to its channel's Hooks tab (Video view); Jev scores it when hook scoring runs."
              : "Waiting for its description: the hook line comes from its spoken opening or on-screen text."}
          </span>
        </div>
      )}
    </section>
  );
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 tabular">{v}</dd>
    </>
  );
}

function DriveGated({ ok, hint, children }: { ok: boolean; hint: string; children: React.ReactNode }) {
  if (ok) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function Preview({ a, originalOk }: { a: AssetDetail; originalOk: boolean }) {
  const { drive } = useStatus();
  const box = "overflow-hidden rounded-xl border border-border bg-ink";
  if (a.kind === "video") {
    const src = a.hasProxy
      ? mediaUrl(a, "proxy")
      : originalOk && BROWSER_VIDEO.has(a.ext)
        ? mediaUrl(a, "original")
        : null;
    if (src) {
      return (
        <div className={box}>
          <video
            key={src}
            src={src}
            controls
            playsInline
            preload="metadata"
            poster={a.hasThumb ? mediaUrl(a, "thumb") : undefined}
            className="max-h-[60vh] w-full bg-ink object-contain"
          />
          {!a.hasProxy && <div className="px-3 py-1.5 text-[11.5px] text-paper/70">Playing the original. The 480p proxy is still in the queue.</div>}
        </div>
      );
    }
    return (
      <div className={box}>
        {a.hasSheet || a.hasThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl(a, a.hasSheet ? "sheet" : "thumb")} alt="" className="max-h-[60vh] w-full object-contain" />
        ) : (
          <div className="grid h-48 place-items-center text-[13px] text-paper/70">Preview not ready yet</div>
        )}
        <div className="px-3 py-1.5 text-[11.5px] text-paper/70">Proxy not ready yet. Showing the contact sheet.</div>
      </div>
    );
  }
  if (a.kind === "image") {
    const full = originalOk && BROWSER_IMAGE.has(a.ext);
    const src = full ? mediaUrl(a, "original") : a.hasThumb ? mediaUrl(a, "thumb") : null;
    return (
      <div className={cn(box, "bg-muted")}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={a.filename} className="max-h-[60vh] w-full object-contain" />
        ) : (
          <div className="grid h-48 place-items-center text-[13px] text-muted-foreground">Preview not ready yet</div>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-muted/50 p-4">
      {originalOk ? (
        <audio src={mediaUrl(a, "original")} controls preload="metadata" className="w-full" />
      ) : (
        <div className="text-[13px] text-muted-foreground">Audio plays from the original. {driveWords(drive.mode).bringBack(drive.label)} to listen.</div>
      )}
    </div>
  );
}
