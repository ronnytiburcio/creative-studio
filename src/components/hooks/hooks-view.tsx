"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Archive,
  ArrowDownWideNarrow,
  RotateCcw,
  ChevronDown,
  Film,
  Gauge,
  Pause,
  Play,
  Search,
  Sparkles,
  Type,
  UserRound,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import { rescoreChangedAction, rescoreSectionAction, setHooksPausedAction } from "@/app/actions";
import { AssetDrawer } from "@/components/library/asset-drawer";
import type { FormatCoverage, MechanicCoverage } from "@/lib/hooks/coverage";
import { CoverageStrip } from "./coverage-strip";
import { HOOK_SOURCE_LABEL, HOOK_SOURCES, HOOKS_PAGE, SCORE_BAND_IDS, SCORE_BANDS, type ScoreBand } from "@/lib/hooks/rubric";
import { Pager } from "@/components/shell/pager";
import type { HookFacets, HookFilters, HookRow as Row, HookScope, HookSort } from "@/lib/hooks/queries";
import type { ChangedSinceScored, SectionRescorePreview } from "@/lib/hooks/store";
import { PRIMARY_BTN } from "./ui";
import { HookRow, type Labels, type RowState } from "./hook-row";
import { HookAddControls } from "./hook-add";
import { ACTIVE_PILL } from "@/components/hooks/ui";
import { useLabels } from "@/components/shell/labels-provider";

const SORT_LABEL: Record<HookSort, string> = {
  rule: "Three P's first",
  score: "Score only",
  newest: "Newest",
  style: "Style",
  avatar: "Avatar",
  spend: "Ad spend",
  ctr: "Ad CTR",
};

const BAND_LABEL: Record<ScoreBand, string> = { ...Object.fromEntries(Object.entries(SCORE_BANDS).map(([k, v]) => [k, v.label])), unscored: "Not scored yet" } as Record<ScoreBand, string>;

const pillCls =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors duration-150 hover:border-foreground/20 hover:bg-hover data-[state=open]:border-foreground/25 outline-none focus-visible:ring-3 focus-visible:ring-ring/30";

function Pill({
  icon: Icon,
  label,
  value,
  active,
  ...rest
}: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; active?: boolean } & React.ComponentProps<"button">) {
  return (
    <button type="button" className={cn(pillCls, active && "border-foreground/30")} {...rest}>
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className={cn("max-w-[200px] truncate", active ? "font-medium" : "text-muted-foreground")}>{value}</span>
      <ChevronDown className="size-3.5 text-muted-foreground" />
    </button>
  );
}

function Radio({ value, label, count }: { value: string; label: string; count?: number }) {
  return (
    <DropdownMenuRadioItem value={value}>
      {label}
      {count != null && <span className="ml-auto pl-3 text-[11.5px] text-muted-foreground tabular">{count.toLocaleString()}</span>}
    </DropdownMenuRadioItem>
  );
}

/** "$0.013", or 4 decimals under a cent ("$0.0002"). */
const usd = (x: number) => `$${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`;

export type HooksViewProps = {
  scope: HookScope;
  filters: HookFilters;
  rows: Row[];
  total: number;
  /** The page `rows` is (1-based, HOOKS_PAGE rows a page). */
  page: number;
  facets: HookFacets;
  rubricVersion: number;
  mechanics: { id: string; label: string; definition: string }[];
  avatars: { slug: string; label: string }[];
  /** Every avatar label any rubric version had (rows scored with an older version). */
  avatarLabels: Record<string, string>;
  channelLabel: string;
  /** `blocked` = why Import approved copy is off (no copy doc for this client), else null. */
  importClient: { code: string; short: string; blocked?: string | null } | null;
  /** Average cost of one hook score so far (for the Resume line). */
  perHookUsd: number;
  coverage: { mechanics: MechanicCoverage; formats: FormatCoverage | null };
  /** Hooks in this view whose inputs changed after their score: notes (D5), or a video described again. */
  changed: Omit<ChangedSinceScored, "ids">;
  /**
   * Lane A tab only (landing page Phase 2 slice 1): the section's own "Rescore <lane> hooks on vN" line, shown while Lane A's
   * content changed in the current version, the global Rescore was not clicked and some Lane A hooks carry an older score.
   * Null elsewhere. Spends nothing until the owner clicks.
   */
  sectionRescore: SectionRescorePreview | null;
  /** Client list for the asset drawer (video rows). */
  clients: { code: string; short: string }[];
  /** Phase 5 slice 3: whether this channel has enough Meta results for the Calibration report, and its link. */
  calibration: { text: string; href: string };
};

export function HooksView(props: HooksViewProps) {
  const L = useLabels();
  const { scope, filters, rows, total, page, facets, mechanics, avatars } = props;
  const isVideo = filters.view === "video";
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [acting, startAct] = useTransition();
  const status = useStatus();
  const refreshStatus = useStatusRefresh();
  const hooks = status.hooks;
  const paused = hooks.paused;

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    // A new filter or sort starts from the first page again (closing a dialog keeps the page).
    if (!Object.keys(patch).every((k) => k === "dialog" || k === "rewrite")) next.delete("page");
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    startTransition(() => router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }));
  };

  const refresh = useCallback(() => {
    router.refresh();
    void refreshStatus();
  }, [router, refreshStatus]);

  // A Running tab Winner chip lands here with ?focus=<id>&rewrite=<id>: that row opens its Rewrite dialog once.
  const rewriteId = Number(sp.get("rewrite")) || null;

  // cmd+K "Add hook" / "Paste hooks" land here with ?dialog=add|paste.
  const dialogParam = sp.get("dialog");
  const requestedDialog = dialogParam === "add" || dialogParam === "paste" ? dialogParam : null;

  // Video rows open the asset drawer (URL `asset`, like the Library).
  const selectedAsset = Number(sp.get("asset")) || null;
  const setAsset = useCallback(
    (assetId: number | null) => {
      const next = new URLSearchParams(sp.toString());
      if (assetId) next.set("asset", String(assetId));
      else next.delete("asset");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
    },
    [router, pathname, sp],
  );

  const rescoreChanged = () =>
    startAct(async () => {
      const r = await rescoreChangedAction({ scope, view: filters.view });
      if (!r.ok) toast.error(r.error);
      else if (r.message) toast.success(r.message);
      refresh();
    });

  const rescoreSection = () =>
    startAct(async () => {
      const r = await rescoreSectionAction({ section: "rtm" });
      if (!r.ok) toast.error(r.error);
      else if (r.message) toast.success(r.message);
      refresh();
    });

  // Refresh the rows when the worker scores something (or starts / stops scoring one of them).
  const signal = `${hooks.scored}|${hooks.errors}|${hooks.current.join(",")}|${hooks.requested}`;
  const lastSignal = useRef(signal);
  useEffect(() => {
    if (lastSignal.current !== signal) {
      lastSignal.current = signal;
      router.refresh();
    }
  }, [signal, router]);

  // Text filter: typed locally, pushed to the URL after a pause.
  const [hq, setHq] = useState(filters.hq);
  const [prevHq, setPrevHq] = useState(filters.hq);
  if (filters.hq !== prevHq) {
    setPrevHq(filters.hq);
    setHq(filters.hq);
  }
  const hqTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHq = (v: string) => {
    setHq(v);
    if (hqTimer.current) clearTimeout(hqTimer.current);
    hqTimer.current = setTimeout(() => set({ hq: v.trim() || null }), 250);
  };

  const labels: Labels = useMemo(
    () => ({
      mechanics: Object.fromEntries(mechanics.map((m) => [m.id, m.label])),
      avatars: { ...props.avatarLabels, ...Object.fromEntries(avatars.map((a) => [a.slug, a.label])) },
    }),
    [mechanics, avatars, props.avatarLabels],
  );

  const current = new Set(hooks.current);
  const stateOf = (r: Row): RowState => {
    if (current.has(r.id)) return "scoring";
    if (r.scoreError && !r.scoreRequested) return "error";
    if (r.scoreRequested) return "queued";
    if (!r.score) return paused ? "paused" : "queued";
    return "scored";
  };

  const setPaused = (value: boolean) =>
    startAct(async () => {
      const r = await setHooksPausedAction({ paused: value });
      if (!r.ok) toast.error(r.error);
      else if (r.message) toast.success(r.message);
      refresh();
    });

  const queuedAll = hooks.queued;
  const resumeCost = queuedAll * props.perHookUsd;
  const anyFilter = Boolean(filters.style || filters.avatar || filters.source || filters.band || filters.pp || filters.undecided || filters.hq);
  const viewHref = (v: "text" | "video") => {
    const next = new URLSearchParams(sp.toString());
    next.delete("page");
    if (v === "text") next.delete("view");
    else next.set("view", v);
    return `${pathname}${next.size ? `?${next}` : ""}`;
  };
  const showClient = scope.kind === "fkbpros";
  const withAds = rows.some((r) => r.ads);
  const changed = props.changed;
  const sectionRescore = props.sectionRescore;
  const NOTES_DETAIL = `brand notes, hint, What works here, ${L.lane.rtm} notes or who's who`;
  const changedReason = changed.described && changed.notes ? "Notes or the video's description" : changed.described ? "The video's description" : "Notes";
  const changedDetail = [
    changed.notes ? `${changed.described ? `${changed.notes.toLocaleString()} by notes: ` : ""}${NOTES_DETAIL}` : null,
    changed.described ? `${changed.notes ? `${changed.described.toLocaleString()} ` : ""}described again after the score: new opening, on-screen text or spoken line` : null,
  ]
    .filter(Boolean)
    .join("; ");
  const pageHref = (n: number) => {
    const next = new URLSearchParams(sp.toString());
    if (n > 1) next.set("page", String(n));
    else next.delete("page");
    return `${pathname}${next.size ? `?${next}` : ""}`;
  };

  return (
    <div className="pb-10">
      {/* Sub-views + scoring state + add controls */}
      <div className="flex flex-wrap items-center gap-3 px-4 sm:px-6 pt-4">
        <div className="flex rounded-lg border border-border bg-card p-0.5" role="tablist" aria-label="Hook kind">
          {(["text", "video"] as const).map((v) => (
            <Link
              key={v}
              href={viewHref(v)}
              role="tab"
              aria-selected={filters.view === v}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors",
                filters.view === v ? ACTIVE_PILL : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "text" ? <Type className="size-3.5" /> : <Film className="size-3.5" />}
              {v === "text" ? "Text" : "Video"}
              {facets.undecidedByView[v] > 0 && (
                <span
                  className="rounded-full bg-brand/15 px-1.5 text-[11px] font-medium text-brand-text tabular"
                  title={`${facets.undecidedByView[v]} ${facets.undecidedByView[v] === 1 ? "hook has" : "hooks have"} variants waiting for Keep or Discard`}
                >
                  {facets.undecidedByView[v]}
                </span>
              )}
            </Link>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
          <span className="tabular">
            <span className="font-medium text-foreground">{facets.scored.toLocaleString()}</span> of {facets.all.toLocaleString()} scored
          </span>
          <span aria-hidden>·</span>
          <span>Rubric v{props.rubricVersion}</span>
          <span aria-hidden>·</span>
          <span className={cn(hooks.state === "waiting" && "text-brand-text")}>
            {paused
              ? "Scoring paused"
              : hooks.state === "running"
                ? "Scoring…"
                : hooks.state === "waiting"
                  ? `Waiting: ${hooks.note ?? "Jev"}`
                  : hooks.state === "off"
                    ? "Worker offline"
                    : "Scoring on"}
          </span>
          {paused ? (
            <Button
              size="xs"
              className={PRIMARY_BTN}
              disabled={acting}
              onClick={() => setPaused(false)}
              title={queuedAll ? `Scores ${queuedAll.toLocaleString()} waiting hooks across every channel (about ${usd(resumeCost)} of Jev, inside the daily cap)` : undefined}
            >
              <Play /> Resume{queuedAll ? ` · ${queuedAll.toLocaleString()} waiting, ~${usd(resumeCost)}` : ""}
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={acting} onClick={() => setPaused(true)}>
              <Pause /> Pause
            </Button>
          )}
        </div>
        <div className="ml-auto">
          {isVideo ? (
            <span className="text-[12.5px] text-muted-foreground">Any other video: open it and click Add as hook.</span>
          ) : (
            <HookAddControls
              scope={scope}
              channelLabel={props.channelLabel}
              importClient={props.importClient}
              paused={paused}
              onChanged={refresh}
              requested={requestedDialog}
              onRequestDone={() => set({ dialog: null })}
            />
          )}
        </div>
      </div>

      {changed.count > 0 && (
        <div className="mx-4 sm:mx-6 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-brand/40 bg-brand/8 px-4 py-2.5 text-[13px]" role="status">
          <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden />
          <span>
            {changedReason} changed since these were scored:{" "}
            <span className="font-medium tabular">
              {changed.count.toLocaleString()} {isVideo ? "video" : "text"} {changed.count === 1 ? "hook" : "hooks"}
            </span>{" "}
            <span className="text-muted-foreground">({changedDetail}). Nothing rescores until you click.</span>
          </span>
          <Button size="xs" className={cn("ml-auto", PRIMARY_BTN)} disabled={acting} onClick={rescoreChanged}>
            <RotateCcw /> Score again (~{usd(changed.count * props.perHookUsd)})
          </Button>
        </div>
      )}

      {sectionRescore && (
        <div className="mx-4 sm:mx-6 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-brand/40 bg-brand/8 px-4 py-2.5 text-[13px]" role="status">
          <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden />
          <span>
            Rubric v{sectionRescore.version} changed {L.lane.rtm}&apos;s context:{" "}
            <span className="font-medium tabular">
              {sectionRescore.count.toLocaleString()} {L.lane.rtm} {sectionRescore.count === 1 ? "hook still carries" : "hooks still carry"} an older score
            </span>{" "}
            <span className="text-muted-foreground">
              (text and video). This rescores {L.lane.rtm} only, never {L.lane.fkbpros} or {L.lane.fkb}; nothing runs until you click.
            </span>
          </span>
          <Button size="xs" className={cn("ml-auto", PRIMARY_BTN)} disabled={acting} onClick={rescoreSection}>
            <RotateCcw /> Rescore {L.lane.rtm} hooks on v{sectionRescore.version} ({sectionRescore.count.toLocaleString()} x ~{usd(props.perHookUsd)} = ~
            {usd(sectionRescore.usd)})
          </Button>
        </div>
      )}

      <CoverageStrip mechanics={props.coverage.mechanics} formats={props.coverage.formats} />

      <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 pt-4">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pill icon={Wand2} label="Style" value={filters.style ? (labels.mechanics[filters.style] ?? filters.style) : "Any"} active={!!filters.style} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <DropdownMenuRadioGroup value={filters.style ?? "any"} onValueChange={(v) => set({ style: v === "any" ? null : v })}>
                  <Radio value="any" label="Any" />
                  {mechanics.map((m) => (
                    <Radio key={m.id} value={m.id} label={m.label} count={facets.styles[m.id] ?? 0} />
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pill
                  icon={UserRound}
                  label="Avatar"
                  value={filters.avatar ? (filters.avatar === "none" ? "None" : (labels.avatars[filters.avatar] ?? filters.avatar)) : "Any"}
                  active={!!filters.avatar}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuRadioGroup value={filters.avatar ?? "any"} onValueChange={(v) => set({ avatar: v === "any" ? null : v })}>
                  <Radio value="any" label="Any" />
                  {avatars.map((a) => (
                    <Radio key={a.slug} value={a.slug} label={a.label} count={facets.avatars[a.slug] ?? 0} />
                  ))}
                  <Radio value="none" label="None / other" count={facets.avatars.none ?? 0} />
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {!isVideo && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pill icon={Sparkles} label="Source" value={filters.source ? HOOK_SOURCE_LABEL[filters.source] : "Any"} active={!!filters.source} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuRadioGroup value={filters.source ?? "any"} onValueChange={(v) => set({ source: v === "any" ? null : v })}>
                  <Radio value="any" label="Any" />
                  {HOOK_SOURCES.filter((s) => s !== "asset").map((s) => (
                    <Radio key={s} value={s} label={HOOK_SOURCE_LABEL[s]} count={facets.sources[s] ?? 0} />
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pill icon={Gauge} label="Score" value={filters.band ? BAND_LABEL[filters.band] : "Any"} active={!!filters.band} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuRadioGroup value={filters.band ?? "any"} onValueChange={(v) => set({ band: v === "any" ? null : v })}>
                  <Radio value="any" label="Any" />
                  {SCORE_BAND_IDS.map((b) => (
                    <Radio key={b} value={b} label={BAND_LABEL[b]} count={facets.bands[b] ?? 0} />
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {(facets.undecided > 0 || filters.undecided) && (
              <label className={cn(pillCls, "cursor-pointer gap-2", filters.undecided ? "border-foreground/30" : "border-brand/40")}>
                <span className={filters.undecided ? "font-medium" : "text-brand-text"}>Undecided variants</span>
                <span className="text-[11.5px] text-muted-foreground tabular">{facets.undecided.toLocaleString()}</span>
                <Switch
                  checked={filters.undecided}
                  onCheckedChange={(v) => set({ undecided: v ? "1" : null })}
                  className="data-[state=checked]:bg-brand"
                  aria-label="Only hooks with variants waiting for Keep or Discard"
                />
              </label>
            )}

            <label className={cn(pillCls, "cursor-pointer gap-2", filters.pp && "border-foreground/30")}>
              <span className={filters.pp ? "font-medium" : "text-muted-foreground"}>Three P&apos;s clear</span>
              <span className="text-[11.5px] text-muted-foreground tabular">{facets.ppClear.toLocaleString()}</span>
              <Switch
                checked={filters.pp}
                onCheckedChange={(v) => set({ pp: v ? "1" : null })}
                className="data-[state=checked]:bg-brand"
                aria-label="Only hooks with Person, Pain and Promise all clear"
              />
            </label>

            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={hq}
                onChange={(e) => onHq(e.target.value)}
                placeholder={isVideo ? "Filter text, file, speech…" : "Filter hook text…"}
                className="h-8 w-[200px] rounded-lg border border-border bg-card pr-2 pl-7 text-[13px] outline-none placeholder:text-muted-foreground/80 hover:border-foreground/20 focus:border-brand focus:ring-3 focus:ring-brand/15"
                aria-label="Filter hooks by text"
              />
            </div>

            <label className={cn(pillCls, "cursor-pointer gap-2", filters.archived && "border-foreground/30")}>
              <Archive className="size-3.5 text-muted-foreground" />
              <span className={filters.archived ? "font-medium" : "text-muted-foreground"}>Archived</span>
              <span className="text-[11.5px] text-muted-foreground tabular">{facets.archived.toLocaleString()}</span>
              <Switch
                checked={filters.archived}
                onCheckedChange={(v) => set({ archived: v ? "1" : null })}
                className="data-[state=checked]:bg-brand"
                aria-label="Show archived hooks"
              />
            </label>

            {anyFilter && (
              <button
                type="button"
                onClick={() => {
                  setHq("");
                  set({ style: null, avatar: null, source: null, band: null, pp: null, undecided: null, hq: null });
                }}
                className="flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
              >
                <X className="size-3.5" />
                Clear
              </button>
            )}

            <div className="ml-auto">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Pill icon={ArrowDownWideNarrow} label="Sort" value={SORT_LABEL[filters.sort]} active={filters.sort !== "rule"} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuLabel className="text-[11px] tracking-wide text-muted-foreground uppercase">Sort by</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value={filters.sort} onValueChange={(v) => set({ sort: v === "rule" ? null : v })}>
                    <DropdownMenuRadioItem value="rule">Three P&apos;s clear first, then score</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="score">Score only</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="style">Style (copy mechanic)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="avatar">Avatar</DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioItem value="spend">Spend on its Meta ads</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="ctr">CTR of its Meta ads</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-4 text-[12.5px] text-muted-foreground sm:px-6">
            <span className="tabular">
              <span className="font-medium text-foreground">{total.toLocaleString()}</span> {filters.archived ? "archived " : ""}
              {total === 1 ? "hook" : "hooks"}
            </span>
            {total > rows.length && (
              <span className="tabular">
                · showing {rows.length.toLocaleString()} of {total.toLocaleString()}
              </span>
            )}
            {filters.sort === "rule" && <span>· hooks with Person, Pain and Promise all clear come first</span>}
            <span>
              ·{" "}
              <Link href={props.calibration.href} className="underline-offset-2 hover:text-foreground hover:underline">
                {props.calibration.text}
              </Link>
            </span>
            {withAds && <span title="An ad's numbers are credited to every hook it carries.">· ad numbers are all time, shared across the hooks an ad carries</span>}
            {pending && <span className="animate-pulse">Updating…</span>}
          </div>

          {rows.length === 0 ? (
            <div className="mx-4 sm:mx-6 mt-4 rounded-xl border border-dashed border-foreground/15 bg-card/60 px-4 sm:px-6 py-12 text-center text-[13.5px] text-muted-foreground">
              {facets.all === 0 && !filters.archived
                ? isVideo
                  ? "No video hooks yet. Hookable videos and the Intro clips land here on their own (the worker checks every 15 s); any other video can be added from its drawer (Add as hook)."
                  : props.importClient
                    ? "No hooks yet. Import this client's approved copy, paste a list or add one."
                    : scope.kind === "fkb"
                      ? `No hooks yet. ${L.lane.fkb}'s Meta ad copy lands here after the next Meta sync; paste a list or add one.`
                      : "No hooks yet. Paste a list or add one."
                : "No hooks match these filters."}
            </div>
          ) : (
            <div className="mx-4 sm:mx-6 mt-3 overflow-hidden rounded-xl border border-border bg-card">
              {rows.map((r) => (
                <HookRow
                  key={r.id}
                  row={r}
                  state={stateOf(r)}
                  paused={paused}
                  labels={labels}
                  showClient={showClient}
                  onChanged={refresh}
                  onOpenAsset={setAsset}
                  focused={filters.focus === r.id || r.variants.some((x) => x.id === filters.focus)}
                  autoRewrite={rewriteId === r.id}
                  onAutoRewriteDone={() => set({ rewrite: null })}
                  scoringIds={current}
                />
              ))}
            </div>
          )}
          <Pager className="mx-4 mt-3 sm:mx-6" page={page} total={total} pageSize={HOOKS_PAGE} hrefFor={pageHref} />
      </>

      {isVideo && <AssetDrawer assetId={selectedAsset} onClose={() => setAsset(null)} clients={props.clients} onOpenAsset={setAsset} />}
    </div>
  );
}
