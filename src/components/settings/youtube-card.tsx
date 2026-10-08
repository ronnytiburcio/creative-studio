"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, LogOut, Pause, Play, PlugZap, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import { connectYouTubeAction, disconnectYouTubeAction, requestYouTubeSyncAction, setYouTubePausedAction } from "@/app/actions";
import { PRIMARY_BTN } from "@/components/hooks/ui";
import type { YtSummary } from "@/lib/youtube/store";
import { PresenceLine } from "./presence-line";
import { formatWhen } from "@/lib/media";

const when = formatWhen;

/** Fixed words for the callback's result (?youtube=...): never anything Google sent. */
const RESULT_TEXT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "YouTube connected. The first Shorts sync starts within 15 seconds." },
  denied: { ok: false, text: "YouTube was not connected: the Google consent was cancelled." },
  expired: { ok: false, text: "That sign-in link expired or was already used. Click Connect YouTube again." },
  scopes: { ok: false, text: "Google did not grant both read-only permissions (YouTube and YouTube Analytics). Connect again and allow both." },
  failed: { ok: false, text: "Google did not finish the connection. Click Connect YouTube again." },
};


/**
 * Settings "YouTube" card (Phase 5 slice 4, PHASE-5 I1 / J1): client file present, connected, channel, last sync, Shorts
 * and matched counts, Connect / Reconnect / Disconnect, Pause / Sync now. Booleans and counts only: no token or secret
 * value ever reaches the browser. Connect opens Google's consent in a new tab; the owner completes it.
 */
export function YouTubeCard({
  summary,
  paths,
  result,
}: {
  summary: YtSummary;
  paths: { secret: string; token: string; redirect: string };
  result: string | null;
}) {
  const router = useRouter();
  const { youtube, worker } = useStatus();
  const refreshStatus = useStatusRefresh();
  const [pending, start] = useTransition();
  const k = summary.keys;
  const syncing = youtube.state === "running" || youtube.requested;
  const reconnect = summary.reconnectNeeded || (k.connected && !k.scopesOk);

  const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else if (r.message) toast.success(r.message);
      await refreshStatus();
      router.refresh();
    });

  const connect = () => {
    // Open the tab inside the click (popup blockers), then point it at Google once the server made the one-time link.
    const w = window.open("about:blank", "_blank");
    start(async () => {
      const r = await connectYouTubeAction();
      if (!r.ok) {
        w?.close();
        toast.error(r.error);
        return;
      }
      if (w) {
        w.opener = null;
        w.location.href = r.url;
        toast.success("Finish the Google consent in the new tab, then come back here.");
      } else {
        window.location.href = r.url;
      }
    });
  };

  const res = result ? RESULT_TEXT[result] : null;
  const stateText = !k.connected
    ? "Not connected"
    : reconnect
      ? "Reconnect needed"
      : !worker.alive
        ? "Worker offline"
        : syncing
          ? `Syncing${youtube.current ? ` ${youtube.current}` : ""}…`
          : summary.paused
            ? "Paused (Sync now still works)"
            : "Idle";

  return (
    <div className="space-y-4">
      {res && <div className={cn("rounded-lg px-3 py-2 text-[12.5px]", res.ok ? "bg-muted/60" : "border border-brand/40 bg-brand/10")}>{res.text}</div>}
      <div className="grid gap-2 sm:grid-cols-2">
        <PresenceLine yes="Yes" no="No" ok={k.clientSecret} label="Google OAuth client (Desktop)" note={`${paths.secret} · read only`} />
        <PresenceLine yes="Yes" no="No" ok={k.connected && !reconnect} label="Connected (read only)" note={k.connected ? `${paths.token}${k.privateFile ? " · private file" : ""}` : "Connect YouTube below"} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px]">
        <span className={cn("inline-flex items-center gap-1.5", (reconnect || !k.connected) && "text-brand-text")}>
          {syncing && <Loader2 className="size-3.5 animate-spin" />}
          {stateText}
        </span>
        {summary.channelTitle && <span className="font-medium">{summary.channelTitle}</span>}
        <span className="text-muted-foreground">Last sync {when(summary.lastSyncAt)}</span>
        <span className="text-muted-foreground tabular">
          {summary.shorts} Shorts · {summary.matched} linked to a file
        </span>
        {k.connected && <span className="text-muted-foreground">Next daily run {when(summary.nextRunAt)}</span>}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {!k.connected || reconnect ? (
            <Button size="sm" className={PRIMARY_BTN} disabled={pending || !k.clientSecret} onClick={connect}>
              <PlugZap /> {k.connected ? "Reconnect" : "Connect YouTube"}
            </Button>
          ) : null}
          {k.connected && (
            <>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => setYouTubePausedAction({ paused: !summary.paused }))}>
                {summary.paused ? <Play /> : <Pause />} {summary.paused ? "Resume" : "Pause"}
              </Button>
              <Button size="sm" variant="outline" disabled={pending || syncing || reconnect} onClick={() => act(() => requestYouTubeSyncAction())}>
                <RefreshCw className={cn(syncing && "animate-spin")} /> Sync now
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  if (window.confirm("Disconnect YouTube? Studio's read-only token is revoked and deleted. Synced numbers stay.")) act(() => disconnectYouTubeAction());
                }}
              >
                <LogOut /> Disconnect
              </Button>
            </>
          )}
        </div>
      </div>
      {summary.error && !summary.reconnectNeeded && <p className="text-[12px] break-words text-brand-text">Last sync failed: {summary.error}</p>}
      {summary.metricsFailed.length > 0 && (
        <p className="text-[12px] text-muted-foreground">YouTube Analytics refused: {summary.metricsFailed.join(", ")} (left empty).</p>
      )}
      <p className="text-[12px] text-muted-foreground">
        Read only (youtube.readonly + yt-analytics.readonly), Studio&apos;s own access: an upload login another tool keeps next to the client file (its token.json) is not touched. Connect opens Google in a new tab;
        after you allow it, Google sends you back to {paths.redirect} and Studio stores the token in a private file (never shown, logged or put in the database).
        The worker reads the channel&apos;s Shorts once a day at 6:00 AM (New York time) and on Sync now. {summary.callsToday} YouTube calls today.
      </p>
    </div>
  );
}
