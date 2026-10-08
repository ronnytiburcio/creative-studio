"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleStop, Pause, Play, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cancelGeneration,
  cancelVariantJobAction,
  classifyAgain,
  retryHookErrorsAction,
  retryVariantJobAction,
  cancelShortJobAction,
  retryShortJobAction,
  scoreHooksAgainAction,
  setHooksPausedAction,
  describeAgain,
  retryAllErrors,
  retryClassifyErrorsAction,
  retryDescribeErrorsAction,
  retryJob,
  setClassifyPausedAction,
  setDescribePausedAction,
  requestMetaSyncAction,
  requestYouTubeSyncAction,
  setYouTubePausedAction,
  setMetaPausedAction,
  cancelAdCopyJobAction,
  retryAdCopyJobAction,
  cancelAdOrderAction,
  clearErrorsAction,
} from "@/app/actions";
import { useStatusRefresh } from "@/components/shell/status-provider";
import type { ClearKind } from "@/lib/cleared";

export function RetryButton({ id, label = "Retry", title }: { id: number; label?: string; title?: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="outline"
      size="xs"
      title={title}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryJob({ id });
          if (!r.ok) toast.error(r.error);
          router.refresh();
        })
      }
    >
      <RotateCcw /> {label}
    </Button>
  );
}

/**
 * Cancel a generation: a waiting job (any engine) leaves the queue at once, nothing spent; a running ChatGPT
 * (Codex) job is killed by the worker within a few seconds.
 */
export function CancelButton({
  id,
  requested,
  title = "Stops the Codex run (nothing is billed per run)",
}: {
  id: number;
  requested: boolean;
  title?: string;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending || requested}
      title={title}
      onClick={() =>
        start(async () => {
          const r = await cancelGeneration({ id });
          if (!r.ok) toast.error(r.error);
          router.refresh();
        })
      }
    >
      <CircleStop /> {requested ? "Cancelling…" : "Cancel"}
    </Button>
  );
}

export function RetryAllButton({ count }: { count: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!count) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryAllErrors();
          if (r.ok && r.message) toast.success(r.message);
          router.refresh();
        })
      }
    >
      <RotateCcw /> Retry all {count}
    </Button>
  );
}

/** Hide one error row (Jobs page). Nothing is retried or changed; a different error on the same thing shows again. */
export function ClearErrorButton({ kind, id }: { kind: ClearKind; id: number }) {
  const [pending, run] = useAiAction();
  return (
    <Button variant="ghost" size="xs" disabled={pending} title="Hide this error. Nothing is retried or changed." onClick={() => run(() => clearErrorsAction({ kind, id }))}>
      <X /> Clear
    </Button>
  );
}

/** Hide every error showing on the Jobs page. */
export function ClearAllErrorsButton({ count }: { count: number }) {
  const [pending, run] = useAiAction();
  if (!count) return null;
  return (
    <Button variant="outline" size="sm" disabled={pending} title="Hide every error on this page. Nothing is retried or changed." onClick={() => run(() => clearErrorsAction({}))}>
      <X /> Clear all errors ({count.toLocaleString()})
    </Button>
  );
}

type AiQueue = "describe" | "classify" | "hooks";

function useAiAction() {
  const [pending, start] = useTransition();
  const router = useRouter();
  const refreshStatus = useStatusRefresh();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else if (r.message) toast.success(r.message);
      await refreshStatus();
      router.refresh();
    });
  return [pending, run] as const;
}

/** Retry one hook's scoring (Score again: runs next, even while paused). */
export function HookRetryButton({ hookId }: { hookId: number }) {
  const [pending, run] = useAiAction();
  return (
    <Button variant="outline" size="xs" disabled={pending} title="Score it again (runs next)" onClick={() => run(() => scoreHooksAgainAction({ ids: [hookId] }))}>
      <RotateCcw /> Retry
    </Button>
  );
}

/** Retry (error / cancelled) or Cancel (waiting) a Rewrite variants job. */
export function VariantJobButton({ id, kind }: { id: number; kind: "retry" | "cancel" }) {
  const [pending, run] = useAiAction();
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending}
      title={kind === "retry" ? "Runs claude again (one more run on your subscription)" : "Removes it from the queue before it starts"}
      onClick={() => run(() => (kind === "retry" ? retryVariantJobAction({ id }) : cancelVariantJobAction({ id })))}
    >
      {kind === "retry" ? <RotateCcw /> : <CircleStop />} {kind === "retry" ? "Retry" : "Cancel"}
    </Button>
  );
}

/** Retry / Cancel a Shorts moments job (Phase 6): Retry = one more claude run; Cancel only before it starts. */
export function ShortJobButton({ id, kind }: { id: number; kind: "retry" | "cancel" }) {
  const [pending, run] = useAiAction();
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending}
      title={kind === "retry" ? "Runs claude again (one more run on your subscription)" : "Removes it from the queue before it starts"}
      onClick={() => run(() => (kind === "retry" ? retryShortJobAction({ id }) : cancelShortJobAction({ id })))}
    >
      {kind === "retry" ? <RotateCcw /> : <CircleStop />} {kind === "retry" ? "Retry" : "Cancel"}
    </Button>
  );
}

/** Draft the rest jobs (Phase 6 slice 3): Retry a failed one, Cancel a waiting one. */
export function AdCopyJobButton({ id, kind }: { id: number; kind: "retry" | "cancel" }) {
  const [pending, run] = useAiAction();
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending}
      title={kind === "retry" ? "Runs claude again (one more run on your subscription)" : "Removes it from the queue before it starts"}
      onClick={() => run(() => (kind === "retry" ? retryAdCopyJobAction({ id }) : cancelAdCopyJobAction({ id })))}
    >
      {kind === "retry" ? <RotateCcw /> : <CircleStop />} {kind === "retry" ? "Retry" : "Cancel"}
    </Button>
  );
}

/** Cancel one of Studio's staged ad orders: the file becomes `cancelled`, so no apply session takes it. */
export function AdOrderCancelButton({ id }: { id: number }) {
  const [pending, run] = useAiAction();
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending}
      title="Rewrites Studio's own order file to cancelled (only while it is staged)"
      onClick={() => run(() => cancelAdOrderAction({ id }))}
    >
      <CircleStop /> Cancel
    </Button>
  );
}

/** Retry one file's describe (Describe again) or classify (Classify again). */
export function AiRetryButton({ queue, assetId }: { queue: "describe" | "classify"; assetId: number }) {
  const [pending, run] = useAiAction();
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending}
      title={queue === "describe" ? "Describe this file again (runs next)" : "Ask Jev about this file again (runs next)"}
      onClick={() => run(() => (queue === "describe" ? describeAgain({ assetId }) : classifyAgain({ assetId })))}
    >
      <RotateCcw /> Retry
    </Button>
  );
}

/** Clear every describe or classify error so those files go back in the queue. */
export function AiRetryAllButton({ queue, count }: { queue: AiQueue; count: number }) {
  const [pending, run] = useAiAction();
  if (!count) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending}
      onClick={() => run(queue === "describe" ? retryDescribeErrorsAction : queue === "classify" ? retryClassifyErrorsAction : retryHookErrorsAction)}
    >
      <RotateCcw /> Retry all {count.toLocaleString()}
    </Button>
  );
}

export function AiPauseButton({ queue, paused }: { queue: AiQueue; paused: boolean }) {
  const [pending, run] = useAiAction();
  const action = queue === "describe" ? setDescribePausedAction : queue === "classify" ? setClassifyPausedAction : setHooksPausedAction;
  return (
    <Button variant="outline" size="xs" disabled={pending} onClick={() => run(() => action({ paused: !paused }))}>
      {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
    </Button>
  );
}

/** Re-render the server page every few seconds while it is open. */
export function AutoRefresh({ ms = 4000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [router, ms]);
  return null;
}

/** Meta sync (Jobs page): Sync now (every account, even while paused) and Pause / Resume of the daily run. */
export function MetaSyncButtons({ paused, syncing }: { paused: boolean; syncing: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else if (r.message) toast.success(r.message);
      router.refresh();
    });
  return (
    <div className="flex justify-end gap-1.5">
      <Button variant="outline" size="xs" disabled={pending || syncing} onClick={() => run(() => requestMetaSyncAction())}>
        <RefreshCw /> Sync now
      </Button>
      <Button variant="outline" size="xs" disabled={pending} onClick={() => run(() => setMetaPausedAction({ paused: !paused }))}>
        {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
      </Button>
    </div>
  );
}

/** Jobs page: the YouTube Shorts sync's Sync now / Pause (Phase 5 slice 4). */
export function YouTubeSyncButtons({ paused, syncing, blocked }: { paused: boolean; syncing: boolean; blocked: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else if (r.message) toast.success(r.message);
      router.refresh();
    });
  return (
    <div className="flex justify-end gap-1.5">
      <Button variant="outline" size="xs" disabled={pending || syncing || blocked} onClick={() => run(() => requestYouTubeSyncAction())}>
        <RefreshCw /> Sync now
      </Button>
      <Button variant="outline" size="xs" disabled={pending} onClick={() => run(() => setYouTubePausedAction({ paused: !paused }))}>
        {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
      </Button>
    </div>
  );
}
