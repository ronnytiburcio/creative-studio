"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eraser, Expand, FlaskConical, Loader2, RectangleVertical, TriangleAlert, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/media";
import { queueTool } from "@/app/actions";
import { useStatus } from "@/components/shell/status-provider";
import { FIRST_RUN_TEXT, MIN_QUOTE_TEXT, TOOL_IDS, TOOL_LABEL, type ToolId } from "@/lib/gen/tools";
import { needsDriveText, toolsBlocked, toolUnavailable, useGenerate, type ToolSource } from "./generate-provider";

export const TOOL_ICON: Record<ToolId, React.ComponentType<{ className?: string }>> = {
  upscale: Expand,
  remove_bg: Eraser,
  reframe_916: RectangleVertical,
};

/** Menu / button label for a tool on this kind of source ("Upscale 4k" for images, "Upscale 2k" for video). */
export function toolMenuLabel(tool: ToolId, kind: ToolSource["kind"]): string {
  return tool === "upscale" ? `${TOOL_LABEL.upscale} ${kind === "video" ? "2k" : "4k"}` : TOOL_LABEL[tool];
}

function credits(n: number | null | undefined) {
  if (n == null) return "";
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, "")} credit${n === 1 ? "" : "s"}`;
}

function Gated({ hint, block, children }: { hint: string | null; block?: boolean; children: React.ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={block ? "block" : "inline-flex"}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Card quick-tools menu (image + video cards). A sibling of the card's main button, never inside it.
 * Prop-driven (no context) so memoized cards do not re-render on every Generate state change.
 * Clicks and menu selections stop here so the card underneath does not open.
 */
export function QuickToolsMenu({
  asset,
  blocked,
  onTool,
  onMenuOpen,
}: {
  asset: ToolSource;
  /** toolsBlocked() for the whole grid (drive, Higgsfield). */
  blocked: string | null;
  onTool: (source: ToolSource, tool: ToolId) => void;
  onMenuOpen?: () => void;
}) {
  const trigger = (
    <button
      type="button"
      disabled={Boolean(blocked)}
      onClick={(e) => e.stopPropagation()}
      className="grid size-7 place-items-center rounded-md bg-ink/80 text-paper disabled:cursor-not-allowed disabled:text-paper/50"
      title={blocked ? undefined : "Quick tools"}
      aria-label={`Quick tools for ${asset.filename}`}
    >
      <WandSparkles className="size-3.5" />
    </button>
  );
  if (blocked) return <Gated hint={blocked}>{trigger}</Gated>;
  return (
    <DropdownMenu onOpenChange={(o) => o && onMenuOpen?.()}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-[11.5px] font-medium text-muted-foreground">Quick tools · Higgsfield</DropdownMenuLabel>
        {TOOL_IDS.map((t) => {
          const Icon = TOOL_ICON[t];
          const off = toolUnavailable(t, asset);
          return (
            <DropdownMenuItem key={t} disabled={Boolean(off)} onSelect={() => onTool(asset, t)} title={off ?? undefined}>
              <Icon className="text-muted-foreground" />
              {toolMenuLabel(t, asset.kind)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Drawer row: the three tools as buttons, same gating as the cards. */
export function QuickToolButtons({ asset, originalOk }: { asset: ToolSource; originalOk: boolean }) {
  const g = useGenerate();
  const { drive } = useStatus();
  const blocked = originalOk ? toolsBlocked(drive, g.higgsfield) : needsDriveText(drive);
  return (
    <div className="flex flex-wrap gap-2">
      {TOOL_IDS.map((t) => {
        const Icon = TOOL_ICON[t];
        const off = blocked ?? toolUnavailable(t, asset);
        return (
          <Gated key={t} hint={off}>
            <Button variant="outline" size="sm" disabled={Boolean(off)} onClick={() => g.openTool(asset, t)}>
              <Icon /> {toolMenuLabel(t, asset.kind)}
            </Button>
          </Gated>
        );
      })}
    </div>
  );
}

type Quote = {
  credits: number;
  exact: boolean;
  title: string;
  detail: string;
  modelLabel: string;
  jobType: string;
  workflow: boolean;
  destLabel: string;
  /** Untested tool (video) that has never finished for real. */
  firstRun: boolean;
  source: { id: number; filename: string; kind: "image" | "video"; durationS: number | null };
};

/** The one confirm for every quick tool: tool, source, quote, balance, one click. Mounted once in the app layout. */
export function QuickToolDialog() {
  const g = useGenerate();
  const { drive, worker } = useStatus();
  const router = useRouter();
  const [quote, setQuote] = useState<{ nonce: number; data?: Quote; error?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const req = g.tool;

  useEffect(() => {
    if (!req) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const r = await fetch(`/api/gen/tool-estimate?asset=${req.source.id}&tool=${req.tool}`, { cache: "no-store", signal: ctrl.signal });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
        setQuote({ nonce: req.nonce, data: data as Quote });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setQuote({ nonce: req.nonce, error: (e as Error).message });
      }
    })();
    return () => ctrl.abort();
  }, [req]);

  const live = req && quote?.nonce === req.nonce ? quote : null;
  const q = live?.data ?? null;
  const hf = g.higgsfield;
  const blocked =
    toolsBlocked(drive, hf) ??
    (!live
      ? "Getting the cost"
      : live.error
        ? `Cost unavailable: ${live.error}`
        : q && hf?.credits != null && q.credits > hf.credits
          ? "Not enough credits"
          : null);

  const confirm = () => {
    if (!req || !q || blocked) return;
    startTransition(async () => {
      const r = await queueTool({ assetId: req.source.id, tool: req.tool, estimate: q.credits });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      g.closeTool();
      toast.success(r.message ?? "Queued.", { action: { label: "Jobs", onClick: () => router.push("/jobs") } });
    });
  };

  const src = req?.source;
  const title = q?.title ?? (req ? toolMenuLabel(req.tool, req.source.kind) : "");
  const Icon = req ? TOOL_ICON[req.tool] : WandSparkles;
  return (
    <Dialog open={Boolean(req)} onOpenChange={(o) => !o && g.closeTool()}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[440px]">
        <DialogHeader className="border-b border-border px-5 py-4">
          <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">Quick tool</div>
          <DialogTitle className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.01em]">
            <Icon className="size-4 text-muted-foreground" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {q ? (
              <>
                Runs {q.modelLabel} on Higgsfield{q.detail ? ` (${q.detail})` : ""}. The result lands in{" "}
                <span className="font-medium text-foreground">{q.destLabel}</span>, the source’s channel.
              </>
            ) : (
              "Runs on Higgsfield. The result lands in the source's channel."
            )}
          </DialogDescription>
        </DialogHeader>

        {src && (
          <div className="flex items-center gap-3 px-5 py-3.5">
            <div className="size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
              {src.hasThumb && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/media/${src.id}/thumb${src.v ? `?v=${src.v}` : ""}`} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[11.5px] text-muted-foreground">Source</div>
              <div className="truncate text-[13.5px] font-medium" title={src.filename}>
                {src.filename}
              </div>
              <div className="text-[12px] text-muted-foreground tabular">
                {src.kind}
                {src.kind === "video" && src.durationS ? ` · ${formatDuration(src.durationS)}` : ""}
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-border px-5 py-3.5">
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="text-muted-foreground">
              {!live ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" /> Getting the cost…
                </span>
              ) : live.error ? (
                <span className="text-brand-text">Cost unavailable: {live.error}</span>
              ) : q ? (
                <>
                  {q.exact ? "Estimated " : "At least "}
                  <span className="font-semibold text-foreground tabular">{credits(q.credits)}</span>
                </>
              ) : null}
            </span>
            <span className="text-muted-foreground tabular">
              {hf?.available ? (
                <>
                  Balance <span className="font-medium text-foreground">{credits(hf.credits)}</span>
                </>
              ) : hf ? (
                <span className="text-brand-text">{hf.reason}</span>
              ) : null}
            </span>
          </div>
          {q?.firstRun && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md border border-brand/40 bg-brand/10 px-2.5 py-2 text-[12px] text-foreground">
              <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-brand-text" />
              <span>
                <span className="font-semibold">First real run.</span> {FIRST_RUN_TEXT}
              </span>
            </div>
          )}
          {q && !q.exact && (
            <div className="mt-1.5 flex items-start gap-1.5 text-[12px] text-brand-text">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{MIN_QUOTE_TEXT}.</span>
            </div>
          )}
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            Credits are spent as soon as it starts. You can cancel it on the Jobs page only while it waits in the queue.
            {!worker.alive && " The worker is offline: the job waits until it is back."}
          </p>
        </div>

        <DialogFooter className="m-0 border-t border-border px-5 py-3.5">
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Gated hint={blocked}>
            <Button className="bg-brand text-ink hover:bg-brand/90" disabled={Boolean(blocked) || pending} onClick={confirm}>
              {pending ? <Loader2 className="animate-spin" /> : <Icon />}
              {q ? `Spend ${q.exact ? "" : "at least "}${credits(q.credits)} · ${TOOL_LABEL[req!.tool].toLowerCase()}` : "Run"}
            </Button>
          </Gated>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
