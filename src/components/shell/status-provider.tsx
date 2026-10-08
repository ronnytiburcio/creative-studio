"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { StatusData } from "@/lib/queries";

const Ctx = createContext<StatusData | null>(null);
const RefreshCtx = createContext<() => Promise<void>>(async () => {});

/** Polls /api/status every 5 s (drive mount + worker heartbeat + describe progress). */
export function StatusProvider({ initial, children }: { initial: StatusData; children: React.ReactNode }) {
  const [status, setStatus] = useState(initial);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (r.ok) setStatus(await r.json());
    } catch {
      /* server restarting; keep last value */
    }
  }, []);
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);
  return (
    <Ctx.Provider value={status}>
      <RefreshCtx.Provider value={refresh}>{children}</RefreshCtx.Provider>
    </Ctx.Provider>
  );
}

export function useStatus(): StatusData {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStatus outside StatusProvider");
  return s;
}

/** Poll /api/status now (after an action that changes what it reports). */
export function useStatusRefresh(): () => Promise<void> {
  return useContext(RefreshCtx);
}
