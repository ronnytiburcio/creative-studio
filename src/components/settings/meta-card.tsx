"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Pause, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import { requestMetaSyncAction, setMetaPausedAction } from "@/app/actions";
import type { MetaAccountView } from "@/lib/meta/store";
import type { KeyStatus } from "@/lib/config";
import { PresenceLine } from "./presence-line";
import { formatWhen } from "@/lib/media";
import { useLabels } from "@/components/shell/labels-provider";

const when = formatWhen;


/**
 * Settings "Meta and GHL" card (Phase 5): key presence (booleans only), the daily sync state, Sync now / Pause, and one
 * line per ad account (last good sync, lead source, ads, error). Nothing here calls Meta or GHL.
 */
export function MetaCard({ accounts, keys, paths }: { accounts: MetaAccountView[]; keys: KeyStatus; paths: { meta: string; fkb: string } }) {
  const L = useLabels();
  const clientToken = `${L.campaignWord ?? L.lane.fkbpros} token`;
  const router = useRouter();
  const { meta, worker } = useStatus();
  const refreshStatus = useStatusRefresh();
  const [pending, start] = useTransition();
  const syncing = meta.state === "running" || meta.requested;

  const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else if (r.message) toast.success(r.message);
      await refreshStatus();
      router.refresh();
    });

  const stateText = !worker.alive
    ? "Worker offline"
    : syncing
      ? `Syncing${meta.current ? ` ${meta.current}` : ""}…`
      : meta.state === "waiting"
        ? meta.note ?? "Waiting"
        : meta.paused
          ? "Paused (Refresh still works)"
          : "Idle";

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <PresenceLine ok={keys.meta} label={`${clientToken} (the client accounts)`} note={`${paths.meta} · META_ACCESS_TOKEN`} />
        <PresenceLine ok={keys.fkbMeta} label={`${L.lane.fkb} token (${L.lane.fkb}'s own account)`} note={`${paths.fkb} · META_ACCESS_TOKEN`} />
        <PresenceLine ok={keys.ghl} label="GHL key (client leads)" note={`${paths.meta} · GHL_API_KEY + GHL_LOCATION_ID`} />
        <PresenceLine
          ok={keys.ghl}
          label={`${L.lane.fkb} leads (same GHL key)`}
          note={`Meta leads until ${L.lane.fkb}'s GHL leads carry its ad source, then GHL leads by themselves`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px]">
        <span className={cn("inline-flex items-center gap-1.5", (meta.state === "waiting" || !worker.alive) && "text-brand-text")}>
          {syncing && <Loader2 className="size-3.5 animate-spin" />}
          {stateText}
        </span>
        <span className="text-muted-foreground">Last run {when(meta.lastRunFinishedAt)}</span>
        <span className="text-muted-foreground">Next daily run {when(meta.nextRunAt)}</span>
        <span className="text-muted-foreground tabular">{meta.callsToday} calls today</span>
        {meta.errors > 0 && <span className="text-brand-text tabular">{meta.errors} account{meta.errors === 1 ? "" : "s"} with errors</span>}
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => setMetaPausedAction({ paused: !meta.paused }))}>
            {meta.paused ? <Play /> : <Pause />} {meta.paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="outline" disabled={pending || syncing} onClick={() => act(() => requestMetaSyncAction())}>
            <RefreshCw className={cn(syncing && "animate-spin")} /> Sync now
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead className="border-b border-border text-left text-[11.5px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Channel</th>
              <th className="px-3 py-2 font-medium">Ad account</th>
              <th className="px-3 py-2 font-medium">Last good sync</th>
              <th className="px-3 py-2 font-medium">Leads</th>
              <th className="px-3 py-2 text-right font-medium">Ads (active)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {accounts.map((a) => (
              <tr key={a.id} className="align-top">
                <td className="px-3 py-2">
                  <Link href={a.href} className="font-medium hover:underline">
                    {a.label}
                  </Link>
                  <div className="text-[11px] text-muted-foreground">
                    {a.code} · {a.campaignSource ? `campaign via ${a.campaignSource}` : "campaign not found yet"}
                  </div>
                  {a.error && <div className="mt-0.5 max-w-[360px] text-[11.5px] break-words text-brand-text">{a.error}</div>}
                  {a.ghlError && <div className="mt-0.5 max-w-[360px] text-[11.5px] break-words text-brand-text">GHL: {a.ghlError}</div>}
                </td>
                <td className="px-3 py-2 font-mono text-[11.5px]">
                  {a.actId}
                  <div className="font-sans text-[11px] text-muted-foreground">{a.identity === "fkb" ? `${L.lane.fkb} token` : clientToken}{a.timezone ? ` · ${a.timezone}` : ""}</div>
                </td>
                <td className="px-3 py-2 tabular">{when(a.lastSyncAt)}</td>
                <td className="px-3 py-2">
                  {a.leadsSource === "meta" ? "Meta" : a.leadsSource === "ghl" ? "GHL" : "–"}
                  {a.ghlSyncedAt && <div className="text-[11px] text-muted-foreground">pulled {when(a.ghlSyncedAt)}</div>}
                </td>
                <td className="px-3 py-2 text-right tabular">
                  {a.ads} <span className="text-muted-foreground">({a.active})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Read only: Studio never writes to Meta or GHL. The worker reads every account once a day at 6:00 PM (New York time), and on Refresh (Running tab, Sync now, cmd+K). Tokens and keys are read by the worker only, fresh per request, and never shown, logged or stored.
      </p>
    </div>
  );
}
