"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircleDashed, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Capabilities } from "@/lib/gen/types";
import { ACTIVE_PILL } from "@/components/hooks/ui";

type Engines = { higgsfield: Capabilities; codex: Capabilities };

/** Settings: can each generation engine run right now? (Presence + sign-in + balance only; never the account.) */
export function EngineChecks() {
  const [engines, setEngines] = useState<Engines | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/gen/status${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setEngines(await r.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load(false);
    })();
  }, [load]);

  const hf = engines?.higgsfield;
  const cx = engines?.codex;
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-2">
        <EngineBox
          title="Higgsfield"
          sub="Images + video, on Higgsfield credits"
          caps={hf}
          rows={[
            ["CLI found", hf?.installed],
            ["Signed in", hf?.signedIn],
          ]}
          extra={hf?.available ? `Balance ${hf.credits ?? "?"} credits${hf.plan ? ` · ${hf.plan} plan` : ""}` : null}
        />
        <EngineBox
          title="ChatGPT (Codex)"
          sub="Images, included in the ChatGPT plan"
          caps={cx}
          rows={[
            ["CLI found", cx?.installed],
            ["Signed in with ChatGPT", cx?.signedIn],
          ]}
          extra={cx?.available ? "Ready" : null}
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again
        </Button>
        {error && <span className="text-[12px] text-brand-text">Could not check: {error}</span>}
      </div>
    </div>
  );
}

function EngineBox({
  title,
  sub,
  caps,
  rows,
  extra,
}: {
  title: string;
  sub: string;
  caps: Capabilities | undefined;
  rows: [string, boolean | undefined][];
  extra: string | null;
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{title}</div>
          <div className="truncate text-[12px] text-muted-foreground">{sub}</div>
        </div>
        <span className={cn("text-[12px] font-medium", !caps ? "text-muted-foreground" : caps.available ? "text-foreground" : "text-brand-text")}>
          {!caps ? "Checking…" : caps.available ? "Available" : "Unavailable"}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {rows.map(([label, ok]) => (
          <li key={label} className="flex items-center gap-2 text-[12.5px]">
            <span
              className={cn(
                "grid size-5 place-items-center rounded-md",
                ok ? ACTIVE_PILL : ok === false ? "bg-brand/15 text-brand-text" : "bg-muted text-muted-foreground",
              )}
            >
              {ok ? <Check className="size-3" /> : <CircleDashed className="size-3" />}
            </span>
            {label}
            <span className="ml-auto text-[12px] text-muted-foreground">{ok ? "Yes" : ok === false ? "No" : "?"}</span>
          </li>
        ))}
      </ul>
      {extra && <div className="mt-2 text-[12px] text-muted-foreground tabular">{extra}</div>}
      {caps && !caps.available && caps.reason && <div className="mt-2 text-[12px] text-brand-text">{caps.reason}</div>}
    </div>
  );
}
