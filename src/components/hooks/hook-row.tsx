"use client";

import { memo, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Archive, ArchiveRestore, ChevronDown, Clapperboard, Copy, FileVideo, Loader2, Megaphone, MegaphoneOff, Pin, PinOff, RotateCcw, Scissors, SquarePlus, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/media";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { archiveHookAction, pinHookAction, scoreHooksAgainAction, sendHookToShortsAction } from "@/app/actions";
import { HOOK_QUESTION_LABEL, HOOK_SOURCE_LABEL, missingLabel, PP_IDS, PP_LABEL } from "@/lib/hooks/rubric";
import type { HookRow as Row, HookVideo } from "@/lib/hooks/queries";
import type { HookAdStats } from "@/lib/meta/hooks";
import type { HookShortStats } from "@/lib/youtube/store";
import type { OrderBadge } from "@/lib/meta/orders";
import { fmtInt, fmtPct, fmtUsd } from "@/lib/meta/windows";
import { RewriteDialog, VariantList } from "./variants";
import { useNewAd } from "@/components/ads/new-ad-provider";
import { ppPillCls } from "./ui";
import { useLabels } from "@/components/shell/labels-provider";

export type RowState = "scoring" | "queued" | "paused" | "error" | "scored";

export type Labels = {
  mechanics: Record<string, string>;
  avatars: Record<string, string>;
};

const iconBtn =
  "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45";

function pctText(p: number) {
  return `${Math.round(p * 100)}%`;
}

/** Five segments, filled up to the level (1..5, rounded); orange dot when Jev was unsure. */
function DimBar({ short, label, level, confidence, unsure }: { short: string; label: string; level: number | null; confidence: number | null; unsure: boolean }) {
  const filled = level == null ? 0 : Math.max(0, Math.min(5, Math.round(level)));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-[52px] flex-col gap-1" tabIndex={0} aria-label={`${label}: ${level != null ? level.toFixed(1) : "no answer"} of 5`}>
          <div className="flex items-center gap-1 text-[10.5px] leading-none text-muted-foreground">
            <span className="truncate">{short}</span>
            {unsure && <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-label="unsure" />}
          </div>
          <div className="flex gap-[2px]" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={cn("h-[5px] flex-1 rounded-[1.5px]", i < filled ? "bg-foreground/70" : "bg-foreground/10")} />
            ))}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}: {level != null ? `${level.toFixed(1)} of 5` : "no answer"}
        {confidence != null && ` · ${pctText(confidence)} sure`}
        {unsure && " · unsure"}
      </TooltipContent>
    </Tooltip>
  );
}

function PPills({ pp, unsure }: { pp: Record<(typeof PP_IDS)[number], number | null>; unsure: string[] }) {
  return (
    <div className="flex items-center gap-1">
      {PP_IDS.map((id) => {
        const p = pp[id];
        return (
          <span
            key={id}
            title={p != null ? `${PP_LABEL[id]} clear: ${pctText(p)} yes${unsure.includes(id) ? " (unsure)" : ""}` : PP_LABEL[id]}
            className={ppPillCls(p)}
          >
            {PP_LABEL[id]}
            {unsure.includes(id) && <span className="text-[10px] opacity-80">?</span>}
          </span>
        );
      })}
    </div>
  );
}

function videoSrc(v: HookVideo, variant: "thumb" | "proxy" | "sheet") {
  return `/api/media/${v.assetId}/${variant}${v.v ? `?v=${v.v}` : ""}`;
}

/** The video's poster; hovering plays the 480p proxy muted (like the Library cards). */
function VideoPoster({ v }: { v: HookVideo }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const fit = v.landscape ? "object-contain" : "object-cover";
  return (
    <div
      className={cn("relative h-[88px] w-[66px] shrink-0 overflow-hidden rounded-lg bg-muted", v.landscape && "bg-ink")}
      onMouseEnter={() => {
        if (v.hasProxy || v.hasSheet) timer.current = setTimeout(() => setHover(true), 250);
      }}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        setHover(false);
      }}
    >
      {v.hasThumb && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={videoSrc(v, "thumb")} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} className={cn("h-full w-full", fit)} />
      ) : (
        <div className="grid h-full place-items-center text-muted-foreground">
          <FileVideo className="size-5" />
        </div>
      )}
      {hover && v.hasProxy && (
        <video src={videoSrc(v, "proxy")} muted loop autoPlay playsInline preload="auto" className={cn("absolute inset-0 h-full w-full bg-ink", fit)} />
      )}
      {hover && !v.hasProxy && v.hasSheet && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={videoSrc(v, "sheet")} alt="" className="absolute inset-0 h-full w-full bg-ink object-contain" />
      )}
      {v.durationS != null && (
        <span className="pointer-events-none absolute right-1 bottom-1 rounded bg-ink/80 px-1 text-[10px] font-medium text-paper tabular">
          {formatDuration(v.durationS)}
        </span>
      )}
    </div>
  );
}

/**
 * The Meta ads carrying this hook, summed all time (PHASE-5 C2): spend, CTR, hook rate (video ads), leads + CPL, "on N
 * ads". Links to the Running tab filtered to those ads. Shared credit: an ad's numbers count for every hook it carries.
 */
function AdNumbers({ a }: { a: HookAdStats }) {
  const leadsWord = a.leadsSource === "meta" ? "Meta leads" : a.leadsSource === "ghl" ? "GHL leads" : "leads";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={a.runningHref}
          onClick={(e) => e.stopPropagation()}
          className="mt-1.5 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-muted/70 px-1.5 py-0.5 text-[11.5px] text-foreground/85 tabular hover:bg-muted"
        >
          <Megaphone className="size-3 shrink-0 text-muted-foreground" />
          <span className="font-medium">
            On {a.ads} {a.ads === 1 ? "ad" : "ads"}
            {a.active ? ` (${a.active} active)` : ""}
          </span>
          <span>{fmtUsd(a.spend)} spend</span>
          <span>CTR {fmtPct(a.ctr)}</span>
          {a.hookRate != null && <span>hook rate {fmtPct(a.hookRate, 1)}</span>}
          <span>
            {fmtInt(a.leads)} {leadsWord}
          </span>
          <span className="font-medium">CPL {fmtUsd(a.cpl)}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px]">
        All time, summed over the {a.ads === 1 ? "ad" : `${a.ads} ads`} carrying this hook ({a.roles.join(", ")}). An ad&apos;s numbers are credited to every hook it
        carries. CTR = clicks / impressions from the sums. Open the Running tab filtered to these ads.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Lane A (Phase 5 slice 4): the YouTube Shorts carrying this hook (a Short -> its matched file -> this file's video hook),
 * latest lifetime numbers: views, average % viewed (views-weighted), likes, subscribers gained. Links to the Shorts list.
 */
function ShortNumbers({ s }: { s: HookShortStats }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={s.href}
          onClick={(e) => e.stopPropagation()}
          className="mt-1.5 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-muted/70 px-1.5 py-0.5 text-[11.5px] text-foreground/85 tabular hover:bg-muted"
        >
          <Scissors className="size-3 shrink-0 text-muted-foreground" />
          <span className="font-medium">
            On {s.shorts} {s.shorts === 1 ? "Short" : "Shorts"}
          </span>
          <span className="font-medium">{fmtInt(s.views)} views</span>
          <span>{s.avgViewPct != null ? `${s.avgViewPct.toFixed(1)}% viewed` : "– viewed"}</span>
          <span>{fmtInt(s.likes)} likes</span>
          <span>+{fmtInt(s.subsGained)} subs</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px]">
        Lifetime numbers of the YouTube {s.shorts === 1 ? "Short" : "Shorts"} cut from this video, as of the last YouTube sync. Average % viewed is weighted
        by views. Open the Shorts list.
      </TooltipContent>
    </Tooltip>
  );
}

const ORDER_TEXT: Record<OrderBadge["status"], string> = {
  staged: "staged, waiting for an apply session",
  applying: "being applied in a Claude session",
  applied: "applied (PAUSED on Meta)",
  failed: "the apply session failed",
  cancelled: "cancelled",
  missing: "order file missing",
};

/** Phase 6 slice 3: this hook's newest new-ad order (read back from its order file by the worker). */
function OrderLine({ o }: { o: OrderBadge }) {
  const Icon = o.status === "cancelled" || o.status === "missing" ? MegaphoneOff : Megaphone;
  return (
    <Link
      href="/jobs#ad-orders"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "mt-1.5 inline-flex max-w-full flex-wrap items-center gap-x-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] hover:bg-muted",
        o.status === "failed" ? "text-brand-text" : "text-foreground/85",
        o.status === "staged" || o.status === "applied" ? "bg-brand/12" : "bg-muted/70",
      )}
      title="Open the Ad orders list on the Jobs page"
    >
      <Icon className="size-3 shrink-0" />
      <span className="font-medium">
        Staged as a PAUSED ad ·{" "}
        {o.status === "applying"
          ? o.stalled
            ? `may have stopped at step ${o.applyStep ?? "?"}`
            : `${ORDER_TEXT.applying}${o.applyStep ? `, step ${o.applyStep}` : ""}`
          : ORDER_TEXT[o.status]}
      </span>
      <span className="font-mono text-[11px] break-all">{o.name}</span>
      {o.inRunning && <span className="font-medium">· In Running</span>}
    </Link>
  );
}

function stateText(state: RowState, paused: boolean, error: string | null): string {
  if (state === "scoring") return "Scoring…";
  if (state === "queued") return "Queued";
  if (state === "error") return error ?? "Scoring failed";
  return paused ? "Not scored · scoring paused" : "Not scored";
}

export const HookRow = memo(function HookRow({
  row,
  state,
  paused,
  labels,
  showClient,
  onChanged,
  onOpenAsset,
  focused,
  scoringIds,
  autoRewrite,
  onAutoRewriteDone,
}: {
  row: Row;
  state: RowState;
  paused: boolean;
  labels: Labels;
  showClient: boolean;
  onChanged: () => void;
  /** Hook ids the worker is scoring now (for the variants under this row). */
  scoringIds: Set<number>;
  /** Video rows: open the asset drawer. */
  onOpenAsset?: (assetId: number) => void;
  /** Highlight and scroll into view (the drawer's Hook link). */
  focused?: boolean;
  /** Open the Rewrite dialog once (a Running tab Winner chip's link, `?rewrite=<id>`); the owner still confirms there. */
  autoRewrite?: boolean;
  onAutoRewriteDone?: () => void;
}) {
  const L = useLabels();
  const [pending, start] = useTransition();
  const newAd = useNewAd();
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [autoDone, setAutoDone] = useState(false);
  if (autoRewrite && !autoDone) {
    setAutoDone(true);
    if (!row.archived && row.variantJob == null) setRewriteOpen(true);
  }
  // Variants waiting for Keep / Discard show open; the owner can fold them away.
  const [expanded, setExpanded] = useState(row.undecided > 0);
  const [prevUndecided, setPrevUndecided] = useState(row.undecided);
  if (row.undecided !== prevUndecided) {
    setPrevUndecided(row.undecided);
    if (row.undecided > prevUndecided) setExpanded(true);
  }
  const s = row.score;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const v = row.video;
  const openAsset = v && onOpenAsset ? () => onOpenAsset(v.assetId) : undefined;

  const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Failed");
      else if (r.message) toast.success(r.message);
      onChanged();
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy (clipboard blocked)");
    }
  };

  const unsureLabels = s ? s.unsure.map((id) => s.dims.find((d) => d.id === id)?.label ?? HOOK_QUESTION_LABEL[id] ?? id) : [];
  const missing = s ? missingLabel(s.missing) : "";
  const busy = state === "scoring" || state === "queued";

  // Video rows: the row itself is a plain click container that opens the drawer; the hook text is its keyboard control
  // (a button whose click bubbles to the same handler); the action buttons stop their clicks. No nested controls.
  const writing = row.variantJob != null;
  return (
    <div ref={ref} className={cn("border-b border-border", focused && "bg-brand/8 ring-2 ring-brand/60 ring-inset")}>
    <div
      className={cn(
        // Narrow (phones, and desktop windows where the sidebar leaves too little room): score + (poster) + text on the
        // first line, bars and actions below, full width. One line per row only once the text keeps a readable width:
        // text rows from lg, video rows (the poster takes 66 px more) from xl.
        "group grid items-center gap-3 px-3 py-3 transition-colors hover:bg-hover/60 md:gap-4 md:px-4",
        v
          ? "cursor-pointer grid-cols-[52px_66px_minmax(0,1fr)] xl:grid-cols-[64px_66px_minmax(0,1fr)_auto_auto]"
          : "grid-cols-[52px_minmax(0,1fr)] lg:grid-cols-[64px_minmax(0,1fr)_auto_auto]",
        row.archived && "opacity-70",
      )}
      onClick={openAsset}
    >
      {/* Overall */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn("flex flex-col items-center justify-center self-start rounded-lg border border-border bg-card py-1.5", v ? "xl:self-center" : "lg:self-center")} tabIndex={0}>
            {s?.overall != null ? (
              <>
                <span className="text-[19px] leading-none font-semibold tracking-[-0.02em] tabular">{s.overall.toFixed(1)}</span>
                <span className={cn("mt-1 text-[9.5px] leading-none", s.stale ? "font-medium text-brand-text" : "text-muted-foreground")}>
                  {s.stale || row.section !== "rtm" ? `rubric v${s.version}` : "not calibrated"}
                </span>
              </>
            ) : state === "scoring" || state === "queued" ? (
              <Loader2 className={cn("size-4 text-muted-foreground", state === "scoring" && "animate-spin")} />
            ) : (
              <span className="text-[15px] text-muted-foreground">·</span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[280px]">
          {s?.overall != null
            ? `Overall ${s.overall.toFixed(2)}: the mean of ${s.dims.length} dimension levels (1 to 5), rubric v${s.version}.${s.stale ? " An older version's score: the current version's lands after Rescore (Rubric page)." : ""}${
                row.section === "rtm"
                  ? ` Not yet calibrated: ${L.lane.rtm} calibrates on YouTube Shorts.`
                  : " How scores line up with real Meta results: Calibration on the Rubric page."
              }`
            : stateText(state, paused, row.scoreError)}
        </TooltipContent>
      </Tooltip>

      {v && <VideoPoster v={v} />}

      {/* Text + meta */}
      <div className="min-w-0">
        {v ? (
          <button
            type="button"
            className="block max-w-full text-left text-[14.5px] leading-snug text-foreground outline-none focus-visible:underline"
            aria-label={`${row.text} (open ${v.filename})`}
          >
            {row.text}
          </button>
        ) : (
          <div className="text-[14.5px] leading-snug text-foreground">{row.text}</div>
        )}
        {v && (
          <div className="mt-1 space-y-0.5 text-[12px] leading-snug text-muted-foreground">
            <div className="line-clamp-1" title={v.spoken ?? undefined}>
              <span className="font-medium text-foreground/70">Said: </span>
              {v.spoken ?? "no speech"}
            </div>
            <div className="line-clamp-1" title={v.onScreen ?? undefined}>
              <span className="font-medium text-foreground/70">On screen: </span>
              {v.onScreen ?? "no text"}
            </div>
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-muted-foreground">
          {s && <PPills pp={s.pp} unsure={s.unsure} />}
          {missing && <span className="font-medium text-brand-text">{missing}</span>}
          {s?.style && (
            <span className="rounded-md bg-muted px-1.5 py-px text-[11.5px] text-foreground/85" title="Copy mechanic">
              {labels.mechanics[s.style] ?? s.style}
              {s.unsure.includes("style") && <span className="ml-0.5 text-brand-text">?</span>}
            </span>
          )}
          {s?.avatar && (
            <span title="Avatar">
              {s.avatar === "none" ? "No avatar" : (labels.avatars[s.avatar] ?? s.avatar)}
              {s.unsure.includes("avatar") && <span className="ml-0.5 text-brand-text">?</span>}
            </span>
          )}
          {s?.stopsScroll != null && (
            <span title={`Would stop a scroll: ${pctText(s.stopsScroll)} yes`} className={cn(s.stopsScroll >= 0.5 && "text-foreground/85")}>
              {s.stopsScroll >= 0.5 ? "Stops the scroll" : "Scrolls past"} · {pctText(s.stopsScroll)}
              {s.unsure.includes("stops_scroll") && <span className="ml-0.5 text-brand-text">?</span>}
            </span>
          )}
          {!s && <span className={cn(state === "error" && "text-brand-text")}>{stateText(state, paused, row.scoreError)}</span>}
          {s && state === "scoring" && <span>Rescoring…</span>}
          {s && state === "queued" && <span>Rescore queued</span>}
          {s && state === "error" && <span className="text-brand-text">Last rescore failed: {row.scoreError}</span>}
          <span className="text-muted-foreground/80">
            {v ? <span className="font-mono text-[11px]">{v.filename}</span> : row.source === "meta" ? null : HOOK_SOURCE_LABEL[row.source]}
            {row.angleSlug && <span className="font-mono text-[11px]"> · {row.angleSlug}</span>}
            {showClient && <span> · {row.clientShort ?? "Shared"}</span>}
          </span>
          {row.pinned && (
            <span className="inline-flex items-center gap-1 rounded-md bg-brand/15 px-1.5 py-px text-[11px] font-medium text-brand-text" title="Pinned to What works here (Client tab)">
              <Pin className="size-3" /> Pinned
            </span>
          )}
          {writing && (
            <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-foreground/80">
              <Loader2 className="size-3 animate-spin" /> {row.variantJob?.status === "running" ? "Writing variants…" : "Variants queued"}
            </span>
          )}
          {row.variants.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((x) => !x);
              }}
              aria-expanded={expanded}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                row.undecided > 0 ? "bg-brand/15 text-brand-text" : "bg-muted text-muted-foreground",
              )}
            >
              {row.undecided > 0 ? `${row.undecided} ${row.undecided === 1 ? "variant" : "variants"}` : `${row.variants.length} kept`}
              <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
            </button>
          )}
          {row.source === "meta" && !v && (
            <span className="rounded-md bg-muted px-1.5 py-px text-[11px] font-medium text-foreground/80" title="Made from a synced Meta ad's copy">
              From Meta
            </span>
          )}
          {unsureLabels.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-brand-text" tabIndex={0}>
                  {unsureLabels.length} unsure
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[300px]">
                Jev was unsure about: {unsureLabels.join(", ")}. Marked only; nothing is queued. A level score counts as unsure only when its
                two most likely neighbouring levels together fall under the threshold.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {row.ads && <AdNumbers a={row.ads} />}
        {row.shorts && <ShortNumbers s={row.shorts} />}
        {row.adOrder && <OrderLine o={row.adOrder} />}
      </div>

      {/* Dimension bars */}
      <div className={cn("col-span-full flex flex-wrap items-center gap-2.5", v ? "xl:col-auto xl:flex-nowrap" : "lg:col-auto lg:flex-nowrap")}>
        {s ? (
          s.dims.map((d) => <DimBar key={d.id} short={d.short} label={d.label} level={d.level} confidence={d.confidence} unsure={d.unsure} />)
        ) : (
          <div className="w-[120px]" />
        )}
      </div>

      {/* Actions (siblings, never nested; their clicks never open the drawer) */}
      <div className={cn("col-span-full flex items-center justify-end gap-0.5", v ? "xl:col-auto" : "lg:col-auto")} onClick={(e) => e.stopPropagation()}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={iconBtn} onClick={copy} aria-label="Copy hook text">
              <Copy className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Copy</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={iconBtn}
              disabled={pending || busy || row.archived}
              onClick={() => act(() => scoreHooksAgainAction({ ids: [row.id] }))}
              aria-label="Score again"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{row.archived ? "Restore it to score it" : "Score again (Jev, a fraction of a cent)"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={iconBtn}
              disabled={pending || writing || row.archived}
              onClick={() => setRewriteOpen(true)}
              aria-label="Rewrite variants"
            >
              <Wand2 className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{writing ? "Variants are being written" : row.archived ? "Restore it to rewrite it" : "Rewrite variants (claude, 5 new versions)"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={iconBtn}
              disabled={pending}
              onClick={() => act(() => archiveHookAction({ id: row.id, archived: !row.archived }))}
              aria-label={row.archived ? "Restore" : "Archive"}
            >
              {row.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{row.archived ? "Restore" : "Archive"}</TooltipContent>
        </Tooltip>
        {row.pinnable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(iconBtn, row.pinned && "text-brand-text")}
                disabled={pending}
                onClick={() => act(() => pinHookAction({ hookId: row.id, pinned: !row.pinned }))}
                aria-label={row.pinned ? "Unpin from What works here" : "Pin to What works here"}
                aria-pressed={row.pinned}
              >
                {row.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {row.pinned
                ? `Unpin from What works here (${row.clientShort ?? L.lane.fkb})`
                : `Pin to What works here (${row.clientShort ?? L.lane.fkb}'s Client tab)`}
            </TooltipContent>
          </Tooltip>
        )}
        {row.section !== "rtm" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[12px] font-medium text-foreground transition-colors outline-none hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45"
                disabled={pending || row.archived}
                onClick={() => newAd.open({ hookId: row.id, channel: row.section === "fkb" ? "fkb" : row.clientCode })}
                aria-label="New PAUSED ad from this hook"
              >
                <SquarePlus className="size-3.5" /> New ad
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {row.archived
                ? "Restore it to make an ad from it"
                : `New PAUSED ad from this hook${row.clientCode || row.section === "fkb" ? "" : " (pick the client)"}: staged as an order file, applied in a Claude session`}
            </TooltipContent>
          </Tooltip>
        )}
        {row.section === "rtm" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={iconBtn}
                disabled={pending || row.archived}
                onClick={() =>
                  act(async () => {
                    const r = await sendHookToShortsAction({ hookId: row.id });
                    return r.ok ? { ok: true, message: `${r.message ?? "Sent."} Open the Shorts board on the Shorts tab.` } : r;
                  })
                }
                aria-label="Send to Shorts"
              >
                <Clapperboard className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{row.archived ? "Restore it to send it to Shorts" : "Send to Shorts: an explainer reel idea on the Shorts board"}</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
                <button type="button" className={iconBtn} disabled aria-label={`Send to Shorts (${L.lane.rtm} hooks only)`}>
                  <Clapperboard className="size-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Send to Shorts is for {L.lane.rtm} hooks (the Shorts board is {L.lane.rtm}&apos;s)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
    {expanded && row.variants.length > 0 && (
      <VariantList row={row} mechanics={labels.mechanics} parentOverall={s?.overall ?? null} scoring={scoringIds} onChanged={onChanged} />
    )}
    {rewriteOpen && (
      <RewriteDialog
        row={row}
        open={rewriteOpen}
        onOpenChange={(o) => {
          setRewriteOpen(o);
          if (!o && autoRewrite) onAutoRewriteDone?.();
        }}
        onQueued={onChanged}
      />
    )}
    </div>
  );
});
