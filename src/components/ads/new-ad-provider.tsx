"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { NewAdDialog } from "./new-ad-dialog";

/**
 * "New PAUSED ad" from anywhere (Phase 6 slice 3): a hook row, a Running Winner chip, a Library card / the asset drawer,
 * cmd+K. One dialog for the whole app, mounted once in the shell.
 */
export type NewAdArgs = {
  /** A client code or `fkb`; null = choose in the dialog. */
  channel?: string | null;
  hookId?: number | null;
  assetId?: number | null;
  /** A Running Winner's Meta ad id (prefills its channel, best hook and matched file). */
  adId?: string | null;
};

const Ctx = createContext<{ open: (args: NewAdArgs) => void } | null>(null);

export function NewAdProvider({ children }: { children: React.ReactNode }) {
  const [args, setArgs] = useState<(NewAdArgs & { key: number }) | null>(null);
  const open = useCallback((a: NewAdArgs) => setArgs({ ...a, key: Date.now() }), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {args && <NewAdDialog key={args.key} args={args} onClose={() => setArgs(null)} />}
    </Ctx.Provider>
  );
}

export function useNewAd() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNewAd outside NewAdProvider");
  return v;
}
