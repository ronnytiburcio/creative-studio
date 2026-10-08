"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { FileImage, FileVideo, Flame, Link2, Loader2, Megaphone, RefreshCw, SquarePlus, TrendingDown, Unlink, Wand2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import { AssetDrawer } from "@/components/library/asset-drawer";
import { requestMetaSyncAction, unlinkAdAction } from "@/app/actions";
import type { AdCard, RunningData, WindowNumbers } from "@/lib/meta/running";
import {
  fmtInt,
  fmtNum,
  fmtPct,
  fmtUsd,
  RUN_SORTS,
  RUN_STATUSES,
  RUN_WINDOWS,
  SORT_LABEL,
  STATUS_LABEL,
  WINDOW_LABEL,
  type RunWindow,
} from "@/lib/meta/windows";
import { ACTIVE_PILL, PRIMARY_BTN, ppPillCls } from "@/components/hooks/ui";
import { PP_IDS, PP_LABEL } from "@/lib/hooks/rubric";
import { LinkFileDialog } from "./link-file";
import { useNewAd } from "@/components/ads/new-ad-provider";
import type { OrderBadge } from "@/lib/meta/orders";
import { FLAG_IDS, FLAG_LABEL, type FlagId } from "@/lib/meta/flags";
import { formatWhen } from "@/lib/media";
import { Pager } from "@/components/shell/pager";
import { clampPage, LIST_PAGE_SIZE, parsePage } from "@/lib/paging";
import { useLabels } from "@/components/shell/labels-provider";

const when = formatWhen;
/** "2026-09-28" -> "Sep 28" (the stale sync day). */
const staleDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const STATUS_TEXT: Record<string, string> = {
  PAUSED: "Paused",
  CAMPAIGN_PAUSED: "Campaign paused",
  ADSET_PAUSED: "Ad set paused",
  PENDING_REVIEW: "In review",
  DISAPPROVED: "Disapproved",
  WITH_ISSUES: "With issues",
  IN_PROCESS: "Processing",
  ARCHIVED: "Archived",
};

const MATCH_TEXT: Record<string, string> = { map: "from the ad map", name: "by Meta's file name", manual: "linked by you" };

/** The widget's three windows on the header. */
const HEADER_WINDOWS: RunWindow[] = ["today", "7d", "lifetime"];

function Metric({ label, value, strong, sub }: { label: string; value: string; strong?: boolean; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10.5px] text-muted-foreground">{label}</div>
      <div className={cn("truncate text-[13px] tabular", strong ? "font-semibold" : "font-medium")}>{value}</div>
      {sub && <div className="truncate text-[10.5px] text-muted-foreground tabular">{sub}</div>}
    </div>
  );
}

function WindowPanel({ label, n, leadsLabel }: { label: string; n: WindowNumbers; leadsLabel: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">{label}</div>
        {!n.delivered && <div className="text-[11.5px] text-muted-foreground">no delivery</div>}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold tracking-[-0.02em] tabular">{fmtUsd(n.spend)}</span>
        <span className="text-[12px] text-muted-foreground">spend</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2">
        <Metric label={leadsLabel} value={fmtInt(n.leads)} />
        <Metric label="CPL" value={fmtUsd(n.cpl)} strong />
        <Metric label="CTR" value={fmtPct(n.ctr)} />
        <Metric label="CPM" value={fmtUsd(n.cpm)} />
        <Metric label="Cost / link click" value={fmtUsd(n.cplc)} />
      </div>
    </div>
  );
}

function Seg<T extends string>({ label, options, value, onChange, counts }: { label: string; options: readonly T[]; value: T; onChange: (v: T) => void; counts?: Partial<Record<T, number>> }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap rounded-lg border border-border bg-card p-0.5" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            aria-pressed={o === value}
            className={cn(
              "h-8 rounded-md px-2.5 text-[12.5px] transition-colors duration-150",
              o === value ? ACTIVE_PILL : "text-muted-foreground hover:bg-hover hover:text-foreground",
            )}
          >
            {optionLabel(o)}
            {counts?.[o] != null && <span className="ml-1 tabular opacity-70">{counts[o]}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

const FLAG_OPTIONS = ["any", ...FLAG_IDS] as const;
const FLAG_OPTION_LABEL: Record<string, string> = { any: "Any", fatiguing: "Fatiguing", winner: "Winners" };

function optionLabel(o: string): string {
  return (
    (WINDOW_LABEL as Record<string, string>)[o] ??
    (STATUS_LABEL as Record<string, string>)[o] ??
    (SORT_LABEL as Record<string, string>)[o] ??
    FLAG_OPTION_LABEL[o] ??
    o
  );
}

export function RunningView({ data, channelLabel, clients }: { data: RunningData; channelLabel: string; clients: { code: string; short: string }[] }) {
  const L = useLabels();
  const camp = `${L.campaignWord ? `${L.campaignWord} ` : ""}campaign`;
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startNav] = useTransition();
  const [acting, startAct] = useTransition();
  const status = useStatus();
  const refreshStatus = useStatusRefresh();
  const meta = status.meta;
  const [linkFor, setLinkFor] = useState<AdCard | null>(null);
  const { channel, filters, cards } = data;
  const leadsLabel = channel.leadsSource === "meta" ? "Meta leads" : "GHL leads";
  const syncing = meta.state === "running" || meta.requested;

  // The cards page through LIST_PAGE_SIZE at a time (`?page=`; the whole list comes from the server, it is small).
  const page = clampPage(parsePage(sp.get("page")), cards.length);
  const pageCards = cards.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE);
  const pageHref = (n: number) => {
    const next = new URLSearchParams(sp.toString());
    if (n > 1) next.set("page", String(n));
    else next.delete("page");
    next.delete("asset");
    return `${pathname}${next.size ? `?${next}` : ""}`;
  };

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    next.delete("page");
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k);
      else next.set(k, v);
    }
    startNav(() => router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }));
  };

  // Matched ads open the asset drawer (URL `asset`, like the Library).
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

  // New numbers when a sync finishes.
  const signal = `${meta.newestSyncAt}|${meta.lastRunFinishedAt}`;
  const lastSignal = useRef(signal);
  useEffect(() => {
    if (lastSignal.current !== signal) {
      lastSignal.current = signal;
      router.refresh();
    }
  }, [signal, router]);

  const refresh = () =>
    startAct(async () => {
      const r = await requestMetaSyncAction();
      if (!r.ok) toast.error(r.error);
      else if (r.message) toast.success(r.message);
      await refreshStatus();
    });

  const unlink = (ad: AdCard) =>
    startAct(async () => {
      const r = await unlinkAdAction({ adId: ad.id });
      if (!r.ok) toast.error(r.error);
      else if (r.message) toast.success(r.message);
      router.refresh();
    });

  const open = (ad: AdCard) => {
    if (ad.match?.visible) setAsset(ad.match.assetId);
    else if (data.canLink) setLinkFor(ad);
  };

  const loose = channel.unattributed[filters.window];
  const never = channel.lastSyncAt == null && cards.length === 0 && data.counts.all === 0;

  return (
    <div className="px-4 pt-5 pb-16 sm:px-6">
      {/* Sync line */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 text-[12.5px] text-muted-foreground">
          {syncing ? (
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Syncing{meta.current ? ` ${meta.current}` : ""}…
            </span>
          ) : (
            <>Last synced {when(channel.lastSyncAt)}</>
          )}
          {!syncing && channel.stale && (
            <span className="text-brand-text"> · Last synced {staleDay(channel.stale)}: numbers stop there</span>
          )}
          <span aria-hidden> · </span>
          <span>Daily at 6:00 PM{meta.paused ? " (paused: Refresh still works)" : ""}</span>
          {meta.state === "waiting" && meta.note && <span className="text-brand-text"> · {meta.note}</span>}
        </div>
        <Button size="sm" variant="outline" className="ml-auto h-9" onClick={refresh} disabled={acting || syncing}>
          <RefreshCw className={cn(syncing && "animate-spin")} /> Refresh
        </Button>
      </div>
      {channel.errors.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[12px] text-brand-text">
          {channel.errors.map((e) => (
            <li key={e} className="break-words">
              {e}
            </li>
          ))}
        </ul>
      )}

      {/* The widget's numbers */}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {HEADER_WINDOWS.map((w) => (
          <WindowPanel key={w} label={WINDOW_LABEL[w]} n={channel.windows[w]} leadsLabel={leadsLabel} />
        ))}
      </div>
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        {channelLabel}: spend, CTR, CPM and cost per link click from Meta (
        {data.scope.kind === "fkb" ? "the whole ad account" : data.scope.kind === "fkbpros" ? `each client's ${camp}` : `the ${camp}`}); leads
        {channel.leadsSource === "ghl"
          ? " from GHL, tests excluded. CPL = spend / leads. 7 days: Meta counts the 7 days before the last sync day, GHL the 7 days including it."
          : `${
              data.scope.kind === "fkb"
                ? ` from Meta: ${L.lane.fkb}'s GHL leads are not tagged with an ad source yet, so GHL cannot tell ad leads from the rest. The first GHL lead with that source switches ${L.lane.fkb} to GHL leads by itself.`
                : " from Meta (the ad account's own lead events)."
            } CPL = spend / leads. 7 days = the 7 days before the last sync day.`}
      </p>

      {data.clientRows && <ClientTable rows={data.clientRows} window={filters.window} />}

      {data.hook && (
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-brand/40 bg-brand/8 px-4 py-2.5 text-[13px]" role="status">
          <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden />
          <span className="min-w-0">
            Ads carrying the hook{" "}
            <Link href={data.hook.href} className="font-medium hover:underline">
              &ldquo;{data.hook.text}&rdquo;
            </Link>
            <span className="text-muted-foreground"> · an ad&apos;s numbers are credited to every hook it carries</span>
          </span>
          <Button size="xs" variant="outline" className="ml-auto" onClick={() => set({ hook: null })}>
            <X /> Show every ad
          </Button>
        </div>
      )}

      {/* Controls */}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Seg label="Window" options={RUN_WINDOWS} value={filters.window} onChange={(v) => set({ w: v === "7d" ? null : v })} />
        <Seg label="Ads" options={RUN_STATUSES} value={filters.status} onChange={(v) => set({ status: v === "active" ? null : v })} counts={data.counts} />
        <Seg label="Sort" options={RUN_SORTS} value={filters.sort} onChange={(v) => set({ sort: v === "spend" ? null : v })} />
        <Seg
          label="Flags"
          options={FLAG_OPTIONS}
          value={filters.flag ?? "any"}
          onChange={(v) => set({ flag: v === "any" ? null : v })}
          counts={{ fatiguing: data.flagCounts.fatiguing, winner: data.flagCounts.winner }}
        />
      </div>
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        Flags are code rules and never act. Fatiguing: the last 7 days&apos; frequency over {data.thresholds.frequency} (whatever window is shown), or the last 7
        days&apos; CTR or hook rate down {data.thresholds.dropPct}%+ from the ad&apos;s own earlier average ({data.thresholds.minImpressions.toLocaleString("en-US")}+
        impressions each side). Winner: 14 day CPL {data.thresholds.winnerPct}%+ better than the channel&apos;s, with {data.thresholds.winnerLeads}+ leads.{" "}
        <Link href="/settings#meta" className="underline-offset-2 hover:underline">
          Thresholds
        </Link>
      </p>
      {loose > 0 && channel.leadsSource === "ghl" && (
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          <span className="font-medium text-foreground tabular">{loose}</span> {loose === 1 ? "lead" : "leads"} ({WINDOW_LABEL[filters.window].toLowerCase()}) not tied to an ad: no ad name in their first or last touch. They count in the totals above only.
        </p>
      )}

      {never ? (
        <div className="mt-6 rounded-2xl border border-dashed border-foreground/15 bg-card/60 px-6 py-10 text-center">
          <Megaphone className="mx-auto size-5 text-muted-foreground" />
          <h2 className="mt-2 text-[16px]">Not synced yet</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">The worker reads Meta at 6:00 PM every day. Click Refresh to read it now.</p>
        </div>
      ) : cards.length === 0 ? (
        <p className="mt-6 text-[13px] text-muted-foreground">
          No {filters.status === "all" ? "" : `${STATUS_LABEL[filters.status].toLowerCase()} `}ads here{filters.flag ? ` flagged ${FLAG_LABEL[filters.flag].toLowerCase()}` : ""}.
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 min-[1800px]:grid-cols-5">
            {pageCards.map((ad) => (
              <AdCardView
                key={ad.id}
                ad={ad}
                showClient={data.scope.kind === "fkbpros"}
                canLink={data.canLink}
                busy={acting}
                onOpen={() => open(ad)}
                onLink={() => setLinkFor(ad)}
                onUnlink={() => unlink(ad)}
              />
            ))}
          </div>
          <Pager className="mt-4" page={page} total={cards.length} pageSize={LIST_PAGE_SIZE} hrefFor={pageHref} />
        </>
      )}

      {linkFor && (
        <LinkFileDialog
          ad={linkFor}
          onClose={() => setLinkFor(null)}
          onLinked={() => {
            setLinkFor(null);
            router.refresh();
          }}
        />
      )}
      <AssetDrawer assetId={selectedAsset} onClose={() => setAsset(null)} clients={clients} onOpenAsset={setAsset} />
    </div>
  );
}

function ClientTable({ rows, window }: { rows: NonNullable<RunningData["clientRows"]>; window: RunWindow }) {
  return (
    <section id="client-table" className="mt-5 overflow-hidden rounded-xl border border-border bg-card">
      <header className="border-b border-border px-4 py-2.5 text-[13px] font-medium">
        Clients · {WINDOW_LABEL[window]}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-[12.5px]">
          <thead className="border-b border-border text-left text-[11.5px] text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Client</th>
              <th className="px-3 py-2 text-right font-medium">Active ads</th>
              <th className="px-3 py-2 text-right font-medium">Spend</th>
              <th className="px-3 py-2 text-right font-medium">Leads</th>
              <th className="px-3 py-2 text-right font-medium">CPL</th>
              <th className="px-3 py-2 text-right font-medium">CTR</th>
              <th className="px-3 py-2 text-right font-medium">CPM</th>
              <th className="px-3 py-2 text-right font-medium">Cost / link click</th>
              <th className="px-3 py-2 text-right font-medium" title="Active ads flagged fatiguing / winner">Flags</th>
              <th className="px-4 py-2 text-right font-medium">Not tied to an ad</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.code} className={cn(r.comparison && "bg-muted/40")}>
                <td className="px-4 py-2">
                  <Link href={r.href} className="font-medium hover:underline">
                    {r.label}
                  </Link>
                  {r.comparison && <span className="ml-1.5 text-[11px] text-muted-foreground">comparison · {r.leadsSource === "meta" ? "Meta leads" : "GHL leads"}</span>}
                  {r.error && <div className="max-w-[260px] truncate text-[11px] text-brand-text" title={r.error}>{r.error}</div>}
                </td>
                <td className="px-3 py-2 text-right tabular">{r.active}</td>
                <td className="px-3 py-2 text-right tabular">{fmtUsd(r.numbers.spend)}</td>
                <td className="px-3 py-2 text-right tabular">{fmtInt(r.numbers.leads)}</td>
                <td className="px-3 py-2 text-right font-medium tabular">{fmtUsd(r.numbers.cpl)}</td>
                <td className="px-3 py-2 text-right tabular">{fmtPct(r.numbers.ctr)}</td>
                <td className="px-3 py-2 text-right tabular">{fmtUsd(r.numbers.cpm)}</td>
                <td className="px-3 py-2 text-right tabular">{fmtUsd(r.numbers.cplc)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <FlagCounts code={r.code} href={r.href} flags={r.flags} />
                </td>
                <td className="px-4 py-2 text-right tabular text-muted-foreground">{r.comparison ? "–" : r.unattributed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FlagCounts({ href, flags }: { code: string; href: string; flags: Record<FlagId, number> }) {
  if (!flags.fatiguing && !flags.winner) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="inline-flex gap-1">
      {FLAG_IDS.filter((f) => flags[f] > 0).map((f) => (
        <Link key={f} href={`${href}?flag=${f}`} className={cn(flagChipCls(f), "hover:opacity-85")} title={`${flags[f]} active ${flags[f] === 1 ? "ad" : "ads"} ${FLAG_LABEL[f].toLowerCase()}`}>
          <span className="tabular">{flags[f]}</span> {f === "winner" ? "winner" : "fatiguing"}
        </Link>
      ))}
    </span>
  );
}

function flagChipCls(f: FlagId) {
  return cn(
    "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-medium",
    f === "winner" ? ACTIVE_PILL : "bg-brand/15 text-brand-text",
  );
}

/**
 * The ad's flags: reason on the chip; a winner links to Rewrite variants for its best-scoring hook (never queued here)
 * and offers "New ad" (Phase 6 slice 3: the New PAUSED ad dialog prefilled with this channel, that hook and this file).
 */
function CardFlags({ ad }: { ad: AdCard }) {
  const { flags, rewriteHref } = ad;
  const newAd = useNewAd();
  return (
    <div className="flex flex-col gap-1">
      {flags.map((f) => (
        <div key={f.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={flagChipCls(f.id)}>
            {f.id === "winner" ? <Flame className="size-3" /> : <TrendingDown className="size-3" />}
            {f.id === "winner" ? "Winner" : "Fatiguing"}
          </span>
          <span className="min-w-0 text-[11.5px] text-muted-foreground tabular">{f.reasons.join(", ")}</span>
          {f.id === "winner" && rewriteHref && (
            <Link href={rewriteHref} className="inline-flex items-center gap-1 text-[11.5px] font-medium text-foreground hover:underline" title="Open its best-scoring hook with Rewrite variants (you confirm there)">
              <Wand2 className="size-3" /> Rewrite variants
            </Link>
          )}
          {f.id === "winner" && (
            <button
              type="button"
              onClick={() => newAd.open({ adId: ad.metaAdId, hookId: ad.winnerHookId, channel: ad.client?.code ?? (ad.sectionKey === "fkb" ? "fkb" : null) })}
              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-foreground hover:underline"
              title="New PAUSED ad prefilled with this channel, its best hook and this file (staged as an order file)"
            >
              <SquarePlus className="size-3" /> New ad
            </button>
          )}
        </div>
      ))}
      {ad.orderFromWinner && <OrderNote o={ad.orderFromWinner} lead="New ad from this winner" />}
    </div>
  );
}

const ORDER_WORD: Record<OrderBadge["status"], string> = {
  staged: "staged",
  applying: "being applied",
  applied: "applied (PAUSED)",
  failed: "failed",
  cancelled: "cancelled",
  missing: "file missing",
};

function OrderNote({ o, lead }: { o: OrderBadge; lead: string }) {
  return (
    <Link href="/jobs#ad-orders" className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1 text-[11.5px] hover:underline", o.status === "failed" ? "text-brand-text" : "text-muted-foreground")}>
      <Megaphone className="size-3 shrink-0" />
      <span>
        {lead}: {o.status === "applying" ? (o.stalled ? `may have stopped at step ${o.applyStep ?? "?"}` : `being applied${o.applyStep ? `, step ${o.applyStep}` : ""}`) : ORDER_WORD[o.status]}
      </span>
      <span className="font-mono text-[11px] break-all">{o.name}</span>
    </Link>
  );
}

function AdCardView({
  ad,
  showClient,
  canLink,
  busy,
  onOpen,
  onLink,
  onUnlink,
}: {
  ad: AdCard;
  showClient: boolean;
  canLink: boolean;
  busy: boolean;
  onOpen: () => void;
  onLink: () => void;
  onUnlink: () => void;
}) {
  const m = ad.m;
  const FileIcon = ad.isVideo ? FileVideo : FileImage;
  const statusText = ad.active ? null : (STATUS_TEXT[ad.status] ?? ad.status.toLowerCase().replace(/_/g, " "));
  const clickable = Boolean(ad.match?.visible) || canLink;
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div
        className={cn("relative aspect-[4/5] w-full overflow-hidden bg-muted", clickable && "cursor-pointer")}
        onClick={clickable ? onOpen : undefined}
      >
        {ad.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ad.thumb} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center text-muted-foreground">
            <div className="flex flex-col items-center gap-1.5 text-[12px]">
              <Megaphone className="size-5" />
              No preview
            </div>
          </div>
        )}
        <div className="absolute top-2 left-2 flex gap-1">
          {statusText && <span className="rounded-md bg-ink/80 px-1.5 py-0.5 text-[11px] text-paper">{statusText}</span>}
          <span className="rounded-md bg-ink/60 px-1.5 py-0.5 text-[11px] text-paper">{ad.isVideo ? "Video" : "Static"}</span>
        </div>
        {ad.daysRunning != null && (
          <span className="absolute right-2 bottom-2 rounded-md bg-ink/70 px-1.5 py-0.5 text-[11px] text-paper tabular">
            {ad.daysRunning} {ad.daysRunning === 1 ? "day" : "days"}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={clickable ? onOpen : undefined}
            disabled={!clickable}
            className="line-clamp-2 text-left text-[13px] leading-snug font-medium break-all hover:underline disabled:no-underline"
            title={ad.name}
          >
            {ad.name}
          </button>
          <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground" title={ad.adsetName ?? ""}>
            {showClient && ad.client && <span className="font-medium text-foreground/80">{ad.client.short} · </span>}
            {ad.adsetName ?? "No ad set"}
          </div>
        </div>
        {ad.flags.length > 0 && <CardFlags ad={ad} />}
        {ad.studioOrder && <OrderNote o={ad.studioOrder} lead="Staged in Studio" />}
        <div className="grid grid-cols-3 gap-x-2 gap-y-2">
          <Metric label="Spend" value={fmtUsd(m.spend)} strong />
          <Metric
            label={ad.leadsSource === "meta" ? "Meta leads" : "GHL leads"}
            value={fmtInt(m.leads)}
            sub={ad.leadsSource === "ghl" ? `Meta says ${m.metaLeads}` : undefined}
          />
          <Metric label="CPL" value={fmtUsd(m.cpl)} strong />
          <Metric label="CTR" value={fmtPct(m.ctr)} />
          <Metric label="CPM" value={fmtUsd(m.cpm)} />
          <Metric label="Cost / link click" value={fmtUsd(m.cplc)} />
          <Metric label="Hook rate" value={ad.isVideo ? fmtPct(m.hookRate, 1) : "–"} />
          <Metric label="Hold rate" value={ad.isVideo ? fmtPct(m.holdRate, 1) : "–"} />
          <Metric label="Frequency" value={fmtNum(m.frequency)} />
        </div>
        {ad.hooks.length > 0 && <CardHooks hooks={ad.hooks} />}
        <div className="mt-auto flex min-h-9 items-center gap-2 border-t border-border pt-2 text-[12px]">
          {ad.match ? (
            <>
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className={cn("truncate", !ad.match.visible && "text-muted-foreground line-through")} title={ad.match.detail ?? ""}>
                  {ad.match.filename ?? "file"}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {ad.match.visible ? MATCH_TEXT[ad.match.source] ?? ad.match.source : "the linked file is hidden or gone"}
                </div>
              </div>
              {canLink && (
                <Button size="sm" variant="ghost" className="h-8 px-2" onClick={onLink} disabled={busy} title="Link a different file">
                  <Link2 /> Change
                </Button>
              )}
              {ad.match.source === "manual" && (
                <Button size="sm" variant="ghost" className="h-8 px-2" onClick={onUnlink} disabled={busy} title="Back to the automatic match">
                  <Unlink /> Unlink
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">No local file</span>
              {canLink ? (
                <Button size="sm" className={cn("h-8", PRIMARY_BTN)} onClick={onLink} disabled={busy}>
                  <Link2 /> Link a file
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

const ROLE_TEXT: Record<string, string> = { headline: "Headline", primary: "Primary", video: "Video" };

/** The hooks an ad carries (its headlines, primary first sentences and its video's hook), each linking to its row. */
function CardHooks({ hooks }: { hooks: AdCard["hooks"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? hooks : hooks.slice(0, 3);
  return (
    <div className="border-t border-border pt-2">
      <div className="mb-1 flex items-baseline justify-between text-[10.5px] text-muted-foreground">
        <span>Hooks on this ad</span>
        <span title="An ad's numbers are credited to every hook it carries">shared credit</span>
      </div>
      <ul className="space-y-1.5">
        {shown.map((h) => (
          <li key={h.id} className="flex items-start gap-2">
            <span
              className="mt-px w-8 shrink-0 rounded-md border border-border py-px text-center text-[11.5px] font-semibold tabular"
              title={h.overall != null ? `Overall ${h.overall.toFixed(2)} (latest score)` : "Not scored yet"}
            >
              {h.overall != null ? h.overall.toFixed(1) : "·"}
            </span>
            <div className="min-w-0 flex-1">
              <Link href={h.href} className={cn("line-clamp-2 text-[12px] leading-snug hover:underline", h.archived && "text-muted-foreground")}>
                {h.text}
              </Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10.5px] text-muted-foreground">
                <span>{h.roles.map((r) => ROLE_TEXT[r] ?? r).join(", ")}</span>
                {h.archived && <span>· archived</span>}
                {h.pp &&
                  PP_IDS.map((id) => (
                    <span key={id} className={ppPillCls(h.pp![id], true)}>
                      {PP_LABEL[id]}
                    </span>
                  ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {hooks.length > 3 && (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-1 text-[11.5px] text-muted-foreground hover:text-foreground">
          {all ? "Show fewer" : `Show all ${hooks.length}`}
        </button>
      )}
    </div>
  );
}
