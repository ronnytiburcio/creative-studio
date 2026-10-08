"use client";

import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, Inbox, Loader2, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { AssetDetail } from "@/lib/queries";
import { orientationUse } from "@/lib/media";
import { classifyAgain, setAssetClassAction } from "@/app/actions";
import { useStatus } from "@/components/shell/status-provider";
import { useLabels } from "@/components/shell/labels-provider";
import { setByText } from "@/lib/profile-shared";
import {
  CATEGORY_LABEL,
  QUESTION_LABEL,
  UNIVERSAL_ID,
  VISUAL_FORMAT_LABEL,
  categoriesFor,
  clientQuestionId,
  energyLabel,
  pct,
  type CategoryId,
  type StoredAnswer,
  type VisualFormatId,
  OWNER_SOURCE,
} from "@/lib/ai/classes";

function fmtTime(ms: number | null) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** "Yes · 92%" / "No · 8%" for a noul; the owner's answers say so (`setBy` = "set by <owner>"). */
export function yesNo(a: StoredAnswer, setBy: string): string {
  const p = Number(a.value);
  if (a.source === OWNER_SOURCE) return `${p >= 0.5 ? "Yes" : "No"} · ${setBy}`;
  return `${p >= 0.5 ? "Yes" : "No"} · ${pct(p)} yes`;
}

function confidenceText(a: StoredAnswer | undefined, setBy: string): string {
  if (!a) return "";
  if (a.source === OWNER_SOURCE) return setBy;
  return a.confidence != null ? `${pct(a.confidence)} sure` : "";
}

/**
 * Drawer "Jev" block (Phase 3 slice 2): category with an inline picker (a change is a correction and becomes the owner's
 * class), energy 1 to 5, hookable, brand safe, visual format (static ads), Three P's (ads), Jev's client proposals,
 * unsure answers marked, a "Needs review" link into the Review queue and "Classify again". No nested controls.
 * "Best use" is orientation_use (PHASE-3 B3): derived in code from kind + shape, never asked.
 */
export function ClassBlock({ a, clients, onChanged }: { a: AssetDetail; clients: { code: string; short: string }[]; onChanged: () => Promise<void> }) {
  const { classify } = useStatus();
  const setBy = setByText(useLabels().owner);
  const [pending, start] = useTransition();
  const c = a.ai.cls;
  if (!c) return null;
  const kind = a.kind === "video" ? "video" : "image";

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else if (r.message) toast.success(r.message);
      await onChanged();
    });

  const heading = (
    <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      Jev tags
      {c.needsReview && (
        <Link
          href={`/review?asset=${a.id}`}
          className="inline-flex h-5 items-center gap-1 rounded-md border border-brand/50 px-1.5 text-[11px] font-medium tracking-normal text-brand-text normal-case hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Inbox className="size-3" /> Needs review
        </Link>
      )}
    </h3>
  );

  const classifyButton = (
    <Button variant="outline" size="sm" onClick={() => run(() => classifyAgain({ assetId: a.id }))} disabled={pending || c.requested || !c.canClassify}>
      {c.requested ? <Loader2 className="animate-spin" /> : <Tags />} {c.requested ? "Classifying…" : "Classify again"}
    </Button>
  );

  if (!c.classified) {
    const waiting = !c.canClassify
      ? "Jev files it once it is described."
      : c.requested
        ? "Queued: Jev files it next."
        : classify.paused
          ? "Not classified yet. Classify is paused in Settings; Classify again runs it now."
          : "Queued. Not classified yet.";
    return (
      <section>
        {heading}
        {c.error ? (
          <div className="rounded-lg border border-brand/40 px-3 py-2 text-[12.5px] text-brand-text">Could not classify: {c.error}</div>
        ) : (
          <div className="rounded-lg border border-dashed border-foreground/20 px-3 py-2 text-[13px] text-muted-foreground">{waiting}</div>
        )}
        <div className="mt-2">{classifyButton}</div>
      </section>
    );
  }

  const unsure = new Set(c.unsure);
  const ans = Object.fromEntries(Object.entries(c.answers).filter(([, x]) => !x.dropped));
  const nouls = (["hookable", "brand_safe", "pp_person", "pp_pain", "pp_promise"] as const).filter((id) => ans[id]);
  const proposals = c.clientsAsked
    ? clients
        .map((cl) => ({ ...cl, p: Number(ans[clientQuestionId(cl.code)]?.value ?? 0) }))
        .filter((x) => x.p >= 0.25)
        .sort((x, y) => y.p - x.p)
    : [];
  const universal = ans[UNIVERSAL_ID] ? Number(ans[UNIVERSAL_ID].value) : null;
  const use = orientationUse(a.kind, a.orientation, a.durationS);

  return (
    <section>
      {heading}
      <dl className="grid grid-cols-[130px_1fr] items-center gap-x-4 gap-y-1.5 text-[13px]">
        <Row k={QUESTION_LABEL.asset_class} unsure={unsure.has("asset_class")}>
          <ClassPicker
            kind={kind}
            value={c.assetClass}
            disabled={pending}
            onPick={(cls) => run(() => setAssetClassAction({ assetId: a.id, cls }))}
          />
          <span className="text-[12px] text-muted-foreground">
            {c.classSource === "manual" ? setBy : c.classConfidence != null ? `${pct(c.classConfidence)} sure` : ""}
          </span>
        </Row>
        {c.energy != null && (
          <Row k={QUESTION_LABEL.energy} unsure={unsure.has("energy")}>
            <span className="font-medium tabular">{c.energy.toFixed(1)}</span>
            <span className="text-muted-foreground">{energyLabel(c.energy)}</span>
            <span className="text-[12px] text-muted-foreground">{confidenceText(ans.energy, setBy)}</span>
          </Row>
        )}
        {ans.visual_format && (
          <Row k={QUESTION_LABEL.visual_format} unsure={unsure.has("visual_format")}>
            <span>{VISUAL_FORMAT_LABEL[ans.visual_format.value as VisualFormatId] ?? String(ans.visual_format.value)}</span>
            <span className="text-[12px] text-muted-foreground">{confidenceText(ans.visual_format, setBy)}</span>
          </Row>
        )}
        {nouls.map((id) => (
          <Row key={id} k={QUESTION_LABEL[id]} unsure={unsure.has(id)}>
            <span>{yesNo(ans[id], setBy)}</span>
          </Row>
        ))}
        {use && (
          <Row k="Best use" unsure={false}>
            <span>{use}</span>
            <span className="text-[12px] text-muted-foreground">from its shape</span>
          </Row>
        )}
        {c.clientsDecided && a.sectionKey === "fkbpros" ? (
          <Row k="Clients" unsure={false}>
            <span className="text-[12.5px]">
              {a.clients.filter((x) => x.source !== "folder").map((x) => x.short).join(" · ") || "Shared"}
              <span className="text-muted-foreground"> · {setBy}</span>
            </span>
          </Row>
        ) : c.clientsAsked && (
          <Row k="Jev's clients" unsure={unsure.has("clients")}>
            <span className="text-[12.5px]">
              {proposals.length
                ? proposals.map((x) => `${x.short} ${pct(x.p)}`).join(" · ")
                : "No single client"}
              {universal != null && <span className="text-muted-foreground"> · universal {pct(universal)}</span>}
            </span>
          </Row>
        )}
      </dl>
      {c.unsure.length > 0 && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          Marked answers are unsure. An unsure category, client group or brand safe answer puts the file in Review.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        {classifyButton}
        <span className="text-[12px] text-muted-foreground">
          {c.model}
          {c.classifiedAt ? ` · ${fmtTime(c.classifiedAt)}` : ""}
          {!c.upToDate && c.classifiedAt ? " · due again (new description or questions)" : ""}
        </span>
      </div>
      {c.error && <div className="mt-2 rounded-lg border border-brand/40 px-3 py-2 text-[12.5px] text-brand-text">Last classify failed: {c.error}</div>}
    </section>
  );
}

function Row({ k, unsure, children }: { k: string; unsure: boolean; children: React.ReactNode }) {
  return (
    <>
      <dt className={cn("flex items-center gap-1.5 text-muted-foreground", unsure && "text-brand-text")}>
        {unsure && <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />}
        {k}
        {unsure && <span className="sr-only">(unsure)</span>}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 tabular">{children}</dd>
    </>
  );
}

/** Category picker (type to filter). Picking a different class stores a correction and makes it the owner's. */
export function ClassPicker({
  kind,
  value,
  disabled,
  onPick,
}: {
  kind: "image" | "video";
  value: string | null;
  disabled?: boolean;
  onPick: (cls: CategoryId) => void;
}) {
  const L = useLabels();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[13px] font-medium transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
          aria-label={`Category: ${value ? CATEGORY_LABEL[value as CategoryId] : "none"}. Change`}
        >
          {value ? (CATEGORY_LABEL[value as CategoryId] ?? value) : "None"}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Category…" />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No category.</CommandEmpty>
            <CommandGroup>
              {categoriesFor(kind).map((cat) => (
                <CommandItem key={cat.id} value={`${cat.label} ${cat.id}`} onSelect={() => cat.id !== value && onPick(cat.id)} title={L.categories[cat.id] ?? cat.description}>
                  {cat.label}
                  {cat.id === value && <span className="ml-auto text-[11.5px] text-muted-foreground">current</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
