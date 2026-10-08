"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, PlugZap, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { openClaudeLoginAction } from "@/app/actions";
import { PRIMARY_BTN } from "@/components/hooks/ui";
import type { ClaudeAuth } from "@/lib/hooks/claude";
import { PresenceLine } from "./presence-line";

const POLL_MS = 3_000;
const POLL_FOR_MS = 5 * 60_000;

/**
 * Settings "Claude" card: is the claude CLI signed in to the subscription (hook variants, Shorts moments, ad copy
 * drafts all run on it)? Sign in / Sign in again opens a Terminal window on `claude auth login`; the owner finishes it in
 * the browser, and the card polls `/api/claude/status` until it flips. Booleans + the auth method word only.
 */
export function ClaudeCard() {
  const [auth, setAuth] = useState<ClaudeAuth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitingUntil, setWaitingUntil] = useState<number | null>(null);
  const [pending, start] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/claude/status", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const next = (await r.json()) as ClaudeAuth;
      setAuth(next);
      setError(null);
      return next;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // After Sign in: check every 3 s (for 5 minutes) until the CLI says signed in.
  useEffect(() => {
    if (waitingUntil == null) return;
    const t = setInterval(() => {
      if (Date.now() > waitingUntil) {
        setWaitingUntil(null);
        return;
      }
      void load().then((a) => {
        if (a?.signedIn) {
          setWaitingUntil(null);
          toast.success("Claude is signed in. Retry any failed claude jobs on the Jobs page.");
        }
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waitingUntil, load]);

  const signIn = () =>
    start(async () => {
      const r = await openClaudeLoginAction();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.message) toast.success(r.message);
      setWaitingUntil(Date.now() + POLL_FOR_MS);
    });

  const signedIn = auth?.signedIn === true;
  const waiting = waitingUntil != null;
  const stateText = !auth
    ? "Checking…"
    : !auth.installed
      ? "claude CLI not found"
      : signedIn
        ? `Signed in${auth.method && auth.method !== "none" ? ` (${auth.method})` : ""}`
        : waiting
          ? "Waiting for the sign-in in Terminal…"
          : auth.signedIn === false
            ? "Signed out: claude jobs fail until you sign in"
            : "Could not tell";

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <PresenceLine yes="Yes" no="No" ok={auth?.installed ?? false} label="claude CLI found" note="~/.local/bin/claude (resolved per run)" />
        <PresenceLine yes="Yes" no="No" ok={signedIn} label="Signed in (Claude subscription)" note="Login kept in the macOS keychain, never by Studio" />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px]">
        <span className={cn("inline-flex items-center gap-1.5", auth && !signedIn && "text-brand-text")}>
          {(waiting || (!auth && loading)) && <Loader2 className="size-3.5 animate-spin" />}
          {stateText}
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {auth?.installed && (
            <Button size="sm" className={signedIn ? undefined : PRIMARY_BTN} variant={signedIn ? "outline" : "default"} disabled={pending} onClick={signIn}>
              <PlugZap /> {signedIn ? "Sign in again" : "Sign in"}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={cn(loading && "animate-spin")} /> Check again
          </Button>
        </div>
      </div>
      {error && <p className="text-[12px] text-brand-text">Could not check: {error}</p>}
      <p className="text-[12px] text-muted-foreground">
        Rewrite variants, Shorts moments and Draft the rest run the claude CLI on your Claude subscription (no API key). Sign in opens a Terminal window
        running <code className="font-mono">claude auth login</code>; finish it in the browser and this card updates by itself. Jobs that failed while signed out
        need a Retry on the <Link href="/jobs" className="underline underline-offset-2">Jobs page</Link>.
      </p>
    </div>
  );
}
