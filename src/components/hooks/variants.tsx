"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Loader2, SquarePlus, Trash2, Wand2 } from "lucide-react";
import { useNewAd } from "@/components/ads/new-ad-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { decideVariantAction, queueVariantsAction } from "@/app/actions";
import { missingLabel, PP_IDS, PP_LABEL } from "@/lib/hooks/rubric";
import type { HookRow as Row } from "@/lib/hooks/queries";
import { PRIMARY_BTN, ppPillCls } from "./ui";

const STEER_MAX = 200;

/** "Rewrite variants" dialog: one optional steer line, then a hook_variants job for the worker (`claude -p`). */
export function RewriteDialog({
  row,
  open,
  onOpenChange,
  onQueued,
}: {
  row: Row;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onQueued: () => void;
}) {
  const [steer, setSteer] = useState("");
  const [pending, start] = useTransition();
  const weakest = row.score?.dims
    .filter((d) => d.level != null)
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
    .slice(0, 2)
    .map((d) => `${d.label} ${d.level!.toFixed(1)}`);
  const submit = () =>
    start(async () => {
      const r = await queueVariantsAction({ hookId: row.id, steer: steer.trim() || undefined });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.message) toast.success(r.message);
      setSteer("");
      onOpenChange(false);
      onQueued();
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Rewrite variants</DialogTitle>
          <DialogDescription>
            claude writes 5 new {row.kind === "video" ? "opening lines to film or say" : "hooks"}, each on a different copy mechanic chosen to lift
            the weakest scores{weakest?.length ? ` (${weakest.join(", ")})` : ""}, same avatar and promise. The copy rules are checked in code;
            the ones that pass are scored by Jev and wait under this hook for Keep or Discard.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13.5px] leading-snug">{row.text}</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="grid gap-1.5 text-[12.5px] text-muted-foreground">
            Steer (optional, one line)
            <Input
              autoFocus
              value={steer}
              maxLength={STEER_MAX}
              onChange={(e) => setSteer(e.target.value)}
              placeholder="e.g. lean on the one week timeline, talk to people who already got a quote"
              aria-label="Steer for the variants"
            />
          </label>
          <div className="mt-1 text-right text-[11.5px] text-muted-foreground tabular">
            {steer.length}/{STEER_MAX}
          </div>
          <DialogFooter className="mt-3 items-center">
            <span className="mr-auto text-[12px] text-muted-foreground">One claude run on your subscription (usually under 15 s) · Jev scoring about $0.001</span>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className={PRIMARY_BTN} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Wand2 />} Write 5 variants
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Bars({ row }: { row: Row }) {
  const s = row.score;
  if (!s) return null;
  return (
    <div className="flex items-center gap-1.5">
      {s.dims.map((d) => {
        const filled = d.level == null ? 0 : Math.max(0, Math.min(5, Math.round(d.level)));
        return (
          <div key={d.id} className="flex w-[40px] flex-col gap-0.5" title={`${d.label}: ${d.level != null ? d.level.toFixed(1) : "no answer"} of 5`}>
            <span className="truncate text-[10px] leading-none text-muted-foreground">{d.short}</span>
            <div className="flex gap-[2px]" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className={cn("h-[4px] flex-1 rounded-[1px]", i < filled ? "bg-foreground/70" : "bg-foreground/10")} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The variants under a hook, ranked (sort rule B: all three P's clear first, then overall): score, mechanic, the
 * Three P's, Keep / Discard. Kept ones are normal hooks now (shown here for reference, no buttons).
 */
export function VariantList({
  row,
  mechanics,
  parentOverall,
  scoring,
  onChanged,
}: {
  row: Row;
  mechanics: Record<string, string>;
  parentOverall: number | null;
  /** Hook ids the worker is scoring now. */
  scoring: Set<number>;
  onChanged: () => void;
}) {
  const [pending, start] = useTransition();
  const newAd = useNewAd();
  const [busyId, setBusyId] = useState<number | null>(null);
  const decide = (id: number, keep: boolean) => {
    setBusyId(id);
    start(async () => {
      const r = await decideVariantAction({ id, keep });
      if (!r.ok) toast.error(r.error);
      else if (r.message) toast.success(r.message);
      setBusyId(null);
      onChanged();
    });
  };
  return (
    <div className="border-t border-dashed border-border bg-muted/30 px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
      <div className="mb-1.5 flex items-center gap-2 text-[11.5px] font-medium tracking-wide text-muted-foreground uppercase">
        Variants
        <span className="font-normal tracking-normal normal-case">
          · ranked: Three P&apos;s clear first, then score{parentOverall != null ? ` · original ${parentOverall.toFixed(1)}` : ""}
        </span>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {row.variants.map((v) => {
          const s = v.score;
          const beats = s?.overall != null && parentOverall != null && s.overall > parentOverall + 0.05;
          const missing = s ? missingLabel(s.missing) : "";
          return (
            <li key={v.id} className="grid grid-cols-[52px_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2">
              <div className="flex flex-col items-center rounded-md border border-border py-1">
                {s?.overall != null ? (
                  <span className={cn("text-[16px] leading-none font-semibold tabular", beats && "text-brand-text")} title={beats ? "Beats the original" : undefined}>
                    {s.overall.toFixed(1)}
                  </span>
                ) : (
                  <Loader2 className={cn("size-4 text-muted-foreground", scoring.has(v.id) && "animate-spin")} aria-label="Scoring" />
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[13.5px] leading-snug">{v.text}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
                  <span className="rounded bg-muted px-1.5 py-px text-foreground/85" title="The copy mechanic claude wrote it on">
                    {v.variantMechanic ? (mechanics[v.variantMechanic] ?? v.variantMechanic) : "mechanic ?"}
                  </span>
                  {s ? (
                    <>
                      <span className="flex gap-1">
                        {PP_IDS.map((id) => {
                          return (
                            <span key={id} className={ppPillCls(s.pp[id], true)}>
                              {PP_LABEL[id]}
                            </span>
                          );
                        })}
                      </span>
                      {missing && <span className="font-medium text-brand-text">{missing}</span>}
                      {s.style && s.style !== v.variantMechanic && <span title="What Jev read as its mechanic">Jev: {mechanics[s.style] ?? s.style}</span>}
                    </>
                  ) : (
                    <span>{v.scoreError ? `Scoring failed: ${v.scoreError}` : scoring.has(v.id) ? "Scoring…" : "Queued for scoring"}</span>
                  )}
                </div>
              </div>
              <Bars row={v} />
              <div className="flex items-center gap-1">
                {v.kept ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11.5px] font-medium">
                      <Check className="size-3" /> Kept
                    </span>
                    {row.section !== "rtm" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => newAd.open({ hookId: v.id, channel: row.section === "fkb" ? "fkb" : v.clientCode })}
                            aria-label="New PAUSED ad from this variant"
                          >
                            <SquarePlus /> {v.adOrder ? `Ad ${v.adOrder.status}` : "New ad"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {v.adOrder ? `Its newest order: ${v.adOrder.name} (${v.adOrder.status}). Click for another New PAUSED ad.` : "New PAUSED ad from this kept variant: staged as an order file"}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </>
                ) : (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button size="xs" variant="outline" disabled={pending && busyId === v.id} onClick={() => decide(v.id, true)}>
                          <Check /> Keep
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>A normal hook in this channel from now on</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button size="xs" variant="ghost" disabled={pending && busyId === v.id} onClick={() => decide(v.id, false)} aria-label="Discard">
                          <Trash2 /> Discard
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Archived; never shown again</TooltipContent>
                    </Tooltip>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
