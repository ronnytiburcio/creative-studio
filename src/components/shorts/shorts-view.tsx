"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileVideo, Link2, Loader2, RefreshCw, Scissors, Unlink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import { linkShortAction, requestYouTubeSyncAction, unlinkShortAction } from "@/app/actions";
import { FilePickerDialog } from "@/components/running/link-file";
import { formatDuration } from "@/lib/media";
import { fmtInt } from "@/lib/meta/windows";
import { SHORT_SORT_LABEL, SHORT_SORTS, type ShortSort } from "@/lib/youtube/sorts";
import type { ShortRow, YtSummary } from "@/lib/youtube/store";
import type { KitTag, KitTestReel, ViewMedian } from "@/lib/shorts/kit";
import { KitTagPill, ViewedVsMedian } from "./kit-ui";
import { ACTIVE_PILL } from "@/components/hooks/ui";
import { formatWhen } from "@/lib/media";
import { useLabels } from "@/components/shell/labels-provider";

const when = formatWhen;
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "–");

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10.5px] text-muted-foreground">{label}</div>
      <div className={cn("truncate text-[13px] tabular", strong ? "font-semibold" : "font-medium")}>{value}</div>
    </div>
  );
}

function Thumb({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // A server-rendered <img> can fail before React attaches onError: check once after mount.
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [src]);
  return (
    <div className="aspect-[9/16] w-[56px] shrink-0 overflow-hidden rounded-md bg-muted sm:w-[64px]">
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={ref} src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center">
          <FileVideo className="size-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function sortHref(s: ShortSort, hookId: number | null, kit: string | null = null) {
  const q = new URLSearchParams();
  if (s !== "newest") q.set("ssort", s);
  if (hookId != null) q.set("hook", String(hookId));
  if (kit) q.set("kit", kit);
  return `/rtm/shorts${q.size ? `?${q}` : ""}#shorts`;
}

type KitRow = ShortRow & { kit: KitTag; test: KitTestReel | null };
type KitGroup = { group: string; label: string; median: number | null; count: number; total: number };

/** A kit test reel's result line (Phase 7 D3): the winner mark, or why it is not one yet. */
function TestLine({ t }: { t: KitTestReel }) {
  if (t.winner) {
    return (
      <span className="inline-flex items-center rounded-md bg-brand/15 px-1.5 py-0.5 text-[12px] font-medium text-brand-text tabular">
        Beat kit v{t.version} by {t.beatBy?.toFixed(1)} points: fold in?
      </span>
    );
  }
  return (
    <span className="text-[12px] text-muted-foreground tabular">
      Test vs kit v{t.version}: {t.note}
    </span>
  );
}

/**
 * The Lane A Shorts list (Phase 5 slice 4): sync line + Sync now, sort (newest / views / avg % viewed), one row per Short
 * (thumbnail, title, published, the six numbers, file line with Link a file / Change / Unlink, the file's hook score).
 * Not connected: a pointer to Settings. Nothing here calls YouTube.
 */
export function ShortsView({
  rows,
  sort,
  hookId,
  kitFilter,
  groups,
  channelMedian,
  summary,
  beforeKit,
}: {
  rows: KitRow[];
  sort: ShortSort;
  hookId: number | null;
  kitFilter: string | null;
  groups: KitGroup[];
  channelMedian: ViewMedian;
  summary: YtSummary;
  beforeKit: string;
}) {
  const L = useLabels();
  const router = useRouter();
  const { youtube, worker } = useStatus();
  const refreshStatus = useStatusRefresh();
  const [pending, start] = useTransition();
  const [picking, setPicking] = useState<ShortRow | null>(null);
  const syncing = youtube.state === "running" || youtube.requested;
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else if (r.message) toast.success(r.message);
      await refreshStatus();
      router.refresh();
    });

  const connected = summary.keys.connected;
  return (
    <section id="shorts" className="scroll-mt-4 px-4 pt-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Scissors className="size-4 text-muted-foreground" />
        <h2 className="text-[16px] font-semibold">YouTube Shorts</h2>
        {summary.channelTitle && <span className="text-[12.5px] text-muted-foreground">{summary.channelTitle}</span>}
        <span className="text-[12px] text-muted-foreground tabular">
          {summary.shorts} Shorts · {summary.matched} linked to a file · last synced {when(summary.lastSyncAt)}
        </span>
        {connected && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={pending || syncing || !worker.alive}
            onClick={() => run(() => requestYouTubeSyncAction())}
          >
            {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />} {syncing ? "Syncing…" : "Sync now"}
          </Button>
        )}
      </div>

      {!connected ? (
        <div className="mt-3 rounded-xl border border-dashed border-foreground/15 bg-card/60 px-5 py-6 text-[13.5px]">
          <div className="font-medium">Connect YouTube in Settings</div>
          <p className="mt-1 text-muted-foreground">
            Studio reads the {L.laneFull.rtm} channel&apos;s Shorts once a day (views, average % viewed, likes, subscribers) with its own read-only
            access, and puts them beside your {L.lane.rtm} video hooks.
          </p>
          <Link href="/settings#youtube" className="mt-3 inline-flex h-9 items-center rounded-md bg-brand px-3 text-[13px] font-medium text-ink hover:bg-brand/90">
            Open Settings
          </Link>
        </div>
      ) : (
        <>
          {(summary.reconnectNeeded || summary.error) && (
            <div className="mt-3 rounded-lg border border-brand/40 bg-brand/10 px-3 py-2 text-[12.5px]">
              {summary.reconnectNeeded ? (
                <>
                  Google refused Studio&apos;s YouTube access. <Link href="/settings#youtube" className="font-medium underline">Reconnect in Settings</Link>. The numbers below are
                  from the last good sync.
                </>
              ) : (
                <>Last sync failed: {summary.error}</>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Sort</span>
            {SHORT_SORTS.map((s) => (
              <Link
                key={s}
                href={sortHref(s, hookId, kitFilter)}
                scroll={false}
                aria-current={s === sort ? "true" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-md border px-2.5 text-[12.5px]",
                  s === sort ? `border-transparent ${ACTIVE_PILL}` : "border-border bg-card text-muted-foreground hover:bg-hover hover:text-foreground",
                )}
              >
                {SHORT_SORT_LABEL[s]}
              </Link>
            ))}
            {hookId != null && (
              <Link href={sortHref(sort, null, kitFilter)} scroll={false} className="inline-flex h-8 items-center gap-1 rounded-md bg-brand/15 px-2.5 text-[12.5px] text-brand-text">
                Only the Shorts of hook #{hookId} <X className="size-3.5" />
              </Link>
            )}
          </div>
          {groups.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Kit filter">
              <span className="text-[12px] text-muted-foreground">Kit</span>
              <Link
                href={sortHref(sort, hookId, null)}
                scroll={false}
                aria-current={kitFilter == null ? "true" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-md border px-2.5 text-[12.5px] tabular",
                  kitFilter == null ? `border-transparent ${ACTIVE_PILL}` : "border-border bg-card text-muted-foreground hover:bg-hover hover:text-foreground",
                )}
                title={channelMedian.median != null ? `Channel median ${channelMedian.median.toFixed(1)}% viewed over ${channelMedian.count} Shorts` : undefined}
              >
                All{channelMedian.median != null ? ` · ${Math.round(channelMedian.median)}% (${channelMedian.count})` : ""}
              </Link>
              {groups.map((g) => (
                <Link
                  key={g.group}
                  href={sortHref(sort, hookId, g.group)}
                  scroll={false}
                  aria-current={kitFilter === g.group ? "true" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md border px-2.5 text-[12.5px] tabular",
                    kitFilter === g.group ? `border-transparent ${ACTIVE_PILL}` : "border-border bg-card text-muted-foreground hover:bg-hover hover:text-foreground",
                  )}
                  title={`${g.label}: ${g.total} Short${g.total === 1 ? "" : "s"}, ${g.count} with numbers${g.median != null ? `, median ${g.median.toFixed(1)}% viewed` : ""}`}
                >
                  {g.label} · {g.median != null ? `${Math.round(g.median)}%` : "no numbers"} ({g.count})
                </Link>
              ))}
              {kitFilter && !groups.some((g) => g.group === kitFilter) && (
                <span className="text-[12px] text-muted-foreground">No Shorts in {kitFilter === beforeKit ? "Before kit" : `Kit ${kitFilter}`}.</span>
              )}
            </div>
          )}
          {rows.length === 0 ? (
            <p className="mt-4 text-[13px] text-muted-foreground">
              {summary.lastSyncAt ? "No Shorts here yet." : "Connected. The first sync runs within a minute; the list fills in after it."}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
              {rows.map((r) => (
                <li key={r.videoId} className="flex gap-3 px-3 py-3">
                  <Thumb src={r.thumb} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="min-w-0 text-[13.5px] leading-snug font-medium break-words">{r.title || r.videoId}</span>
                      {r.privacy && r.privacy !== "public" && <span className="rounded bg-muted px-1 text-[10.5px] text-muted-foreground">{r.privacy}</span>}
                    </div>
                    <div className="text-[11.5px] text-muted-foreground tabular">
                      {day(r.publishedAt)}
                      {r.durationS != null && ` · ${formatDuration(r.durationS)}`}
                      {r.snapshotDate && ` · numbers as of ${r.snapshotDate}`}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <KitTagPill tag={r.kit} />
                      <ViewedVsMedian pct={r.avgViewPct} views={r.views} median={channelMedian} />
                      {r.test && <TestLine t={r.test} />}
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
                      <Metric label="Views" value={fmtInt(r.views)} strong />
                      <Metric label="Avg % viewed" value={r.avgViewPct != null ? `${r.avgViewPct.toFixed(1)}%` : "–"} strong />
                      <Metric label="Avg view" value={r.avgViewS != null ? `${r.avgViewS.toFixed(0)} s` : "–"} />
                      <Metric label="Likes" value={fmtInt(r.likes)} />
                      <Metric label="Subs gained" value={fmtInt(r.subsGained)} />
                      <Metric label="Engaged views" value={fmtInt(r.engagedViews)} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                      {r.file ? (
                        <>
                          <Link href={`/rtm/library?asset=${r.file.assetId}`} className="min-w-0 truncate font-medium hover:underline" title={r.file.detail ?? undefined}>
                            {r.file.filename}
                          </Link>
                          <span className="text-muted-foreground">{r.file.source === "manual" ? "linked by you" : "matched by title and length"}</span>
                          <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-hover hover:text-foreground" onClick={() => setPicking(r)}>
                            <Link2 className="size-3.5" /> Change
                          </button>
                          {r.file.source === "manual" && (
                            <button
                              type="button"
                              disabled={pending}
                              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-hover hover:text-foreground"
                              onClick={() => run(() => unlinkShortAction({ videoId: r.videoId }))}
                            >
                              <Unlink className="size-3.5" /> Unlink
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="text-muted-foreground">No local file</span>
                          <button
                            type="button"
                            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-foreground hover:bg-hover"
                            onClick={() => setPicking(r)}
                          >
                            <Link2 className="size-3.5" /> Link a file
                          </button>
                        </>
                      )}
                      {r.hook ? (
                        <Link href={r.hook.href} className="ml-auto inline-flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 hover:bg-muted">
                          Hook{r.hook.archived ? " (archived)" : ""} ·{" "}
                          <span className="font-semibold tabular">{r.hook.overall != null ? r.hook.overall.toFixed(1) : "not scored"}</span>
                        </Link>
                      ) : r.file ? (
                        <span className="ml-auto text-muted-foreground">No video hook yet (describe the file first)</span>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {picking && (
        <FilePickerDialog
          scopeQuery="scope=rtm"
          kind="video"
          subtitle={`${picking.title || picking.videoId} · ${L.lane.rtm} Library · videos`}
          onClose={() => setPicking(null)}
          onPick={async (asset) => {
            const r = await linkShortAction({ videoId: picking.videoId, assetId: asset.id });
            if (!r.ok) toast.error(r.error);
            else {
              if (r.message) toast.success(r.message);
              setPicking(null);
              router.refresh();
            }
          }}
        />
      )}
    </section>
  );
}
