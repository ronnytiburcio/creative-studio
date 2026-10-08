"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, CircleDashed, Loader2, Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiPurpose } from "@/lib/ai/jev";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import {
  retryClassifyErrorsAction,
  retryDescribeErrorsAction,
  setClassifyPausedAction,
  setClassifyThresholdAction,
  setDescribePausedAction,
  setJevDailyCapAction,
  retryHookErrorsAction,
  setHooksPausedAction,
  setShortsGateAction,
} from "@/app/actions";
import { THRESHOLD_MAX, THRESHOLD_MIN } from "@/lib/ai/classes";
import type { JevStatus } from "@/lib/ai/jev";
import { ACTIVE_PILL } from "@/components/hooks/ui";

type AiStatus = {
  ollama: { reachable: boolean; modelPresent: boolean; version: string | null; error: string | null; url: string; model: string };
  whisper: { binFound: boolean; modelFound: boolean; bin: string; model: string };
  jev: JevStatus;
};

const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

const pct = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 1000) / 10) : 0);

/**
 * Settings "AI" card: Describe (slice 1: Ollama + model, whisper, progress, Pause / Resume, Retry errors) and Classify
 * (slice 2: Jev key + the free `GET /v1/models` check, pinned model, classified / needs review counts, its own
 * Pause / Resume, the confidence threshold, the daily cap and Jev spend today / all time). No tokens are spent here.
 */
export function AiCard({ shortsGate, envFile }: { shortsGate: number; envFile: string }) {
  const router = useRouter();
  const { describe: d, worker } = useStatus();
  const refreshStatus = useStatusRefresh();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/ai/status", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(await r.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else {
        if (r.message) toast.success(r.message);
        await refreshStatus();
        router.refresh();
      }
    });

  const o = status?.ollama;
  const w = status?.whisper;
  const j = status?.jev;
  const stateLine = !worker.alive
    ? { text: "Worker offline. Describe runs in the worker.", warn: true }
    : d.state === "running"
      ? { text: `Describing ${d.current ?? "…"}`, warn: false }
      : d.state === "waiting"
        ? { text: `Waiting: ${d.note ?? "Ollama is not available"}. Retrying on its own.`, warn: true }
        : d.paused
          ? { text: "Paused. New files and the backfill wait; Describe again still works per file.", warn: false }
          : d.done >= d.total
            ? { text: "Idle. Everything is described.", warn: false }
            : { text: "Idle. The rest wait for their previews (or have errors).", warn: false };

  return (
    <div>
      <div className="grid gap-3 md:grid-cols-2">
        <CheckBox
          title="Ollama"
          sub={`Vision model ${o?.model ?? "…"} at ${o?.url ?? "…"}`}
          ok={o ? o.reachable && o.modelPresent : undefined}
          rows={[
            ["Reachable", o?.reachable],
            ["Model pulled", o ? o.reachable && o.modelPresent : undefined],
          ]}
          extra={o?.version ? `Ollama ${o.version}` : null}
          problem={o && !o.reachable ? "Start Ollama (brew services start ollama)." : o && !o.modelPresent ? `Run: ollama pull ${o.model}` : null}
        />
        <CheckBox
          title="whisper.cpp"
          sub="Spoken opening: first 15 s of every video"
          ok={w ? w.binFound && w.modelFound : undefined}
          rows={[
            ["Binary found", w?.binFound],
            ["Model found", w?.modelFound],
          ]}
          extra={null}
          problem={w && !w.binFound ? `Not found: ${w.bin}` : w && !w.modelFound ? `Not found: ${w.model}` : null}
        />
      </div>

      <div className="mt-4 rounded-lg border border-border px-3 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px] font-medium">
            Described <span className="tabular">{d.done.toLocaleString()}</span>
            <span className="text-muted-foreground tabular"> / {d.total.toLocaleString()} images and videos</span>
          </div>
          <span className="text-[12px] text-muted-foreground tabular">{pct(d.done, d.total)}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-foreground/70" style={{ width: `${pct(d.done, d.total)}%` }} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-4">
          <Fact k="Spoken openings" v={`${d.spokenChecked.toLocaleString()} / ${d.videos.toLocaleString()} videos`} />
          <Fact k="With speech" v={d.spokenWithSpeech.toLocaleString()} />
          <Fact k="Errors" v={d.errors.toLocaleString()} warn={d.errors > 0} />
          <Fact k="Describe again" v={d.requested ? `${d.requested} queued` : "none queued"} />
        </dl>
        <div className={cn("mt-3 truncate text-[12.5px]", stateLine.warn ? "text-brand-text" : "text-muted-foreground")} title={stateLine.text}>
          {stateLine.text}
        </div>
        <div className="mt-1 text-[11.5px] text-muted-foreground">
          {d.model} · prompt v{d.promptVersion} · new files first, then the rest of the Library, newest first, one at a time.
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {d.paused ? (
          <Button size="sm" onClick={() => act(() => setDescribePausedAction({ paused: false }))} disabled={pending} className="bg-brand text-ink hover:bg-brand/90">
            <Play /> Resume describing
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => act(() => setDescribePausedAction({ paused: true }))} disabled={pending}>
            <Pause /> Pause
          </Button>
        )}
        {d.errors > 0 && (
          <Button variant="outline" size="sm" onClick={() => act(() => retryDescribeErrorsAction())} disabled={pending}>
            <RotateCcw /> Retry {d.errors} error{d.errors === 1 ? "" : "s"}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again
        </Button>
        {error && <span className="text-[12px] text-brand-text">Could not check: {error}</span>}
      </div>

      <JevSection j={j} onAct={act} pending={pending} envFile={envFile} />
      <HooksSection onAct={act} pending={pending} shortsGate={shortsGate} />
    </div>
  );
}

// Every AiPurpose needs a label (a new purpose without one is a compile error); ai_calls rows carry plain text.
const PURPOSE_LABEL: Record<AiPurpose, string> = { classify: "Classify", search: "Search by meaning", hook_score: "Hook scoring", copy_gate: "Copy gate", page_score: "Page scoring", test: "Tests" };
const purposeLabel = (p: string) => (Object.hasOwn(PURPOSE_LABEL, p) ? PURPOSE_LABEL[p as AiPurpose] : p);

/**
 * Hooks (Phase 4 H2): scored / live, queued, paused + Pause / Resume, errors + Retry, and Jev spend today and all time
 * per purpose. Rewrite variants run on the claude subscription (no Jev spend of their own; their scoring is hook_score).
 */
function HooksSection({
  onAct,
  pending,
  shortsGate,
}: {
  onAct: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
  pending: boolean;
  shortsGate: number;
}) {
  const { hooks: h, worker } = useStatus();
  const [gate, setGate] = useState(String(shortsGate));
  const stateLine = !worker.alive
    ? { text: "Worker offline. Hook scoring runs in the worker.", warn: true }
    : h.state === "running"
      ? { text: `Scoring ${h.current.length} hook${h.current.length === 1 ? "" : "s"}…`, warn: false }
      : h.state === "waiting"
        ? { text: `Waiting: ${h.note ?? "Jev is not available"}`, warn: true }
        : h.paused
          ? { text: "Paused. New hooks wait; Score again, Rescore and new variants still run.", warn: false }
          : h.queued > 0
            ? { text: "Idle. The rest have errors or wait for a Rescore click (Rubric page).", warn: false }
            : { text: "Idle. Every live hook is scored for the current rubric.", warn: false };
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold">Hooks (Jev scoring)</div>
        <div className="text-[12px] text-muted-foreground">One call per hook, rubric v{h.version}. Variants are written by claude on your subscription.</div>
      </div>
      <div className="rounded-lg border border-border px-3 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px] font-medium">
            Scored <span className="tabular">{h.scored.toLocaleString()}</span>
            <span className="text-muted-foreground tabular"> / {h.total.toLocaleString()} live hooks</span>
          </div>
          <span className="text-[12px] text-muted-foreground tabular">{pct(h.scored, h.total)}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-foreground/70" style={{ width: `${pct(h.scored, h.total)}%` }} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-4">
          <Fact k="Queued" v={h.queued.toLocaleString()} />
          <Fact k="Score again" v={h.requested ? `${h.requested} requested` : "none requested"} />
          <Fact k="Errors" v={h.errors.toLocaleString()} warn={h.errors > 0} />
          <Fact k="State" v={h.paused ? "Paused" : "On"} />
        </dl>
        <div className={cn("mt-3 truncate text-[12.5px]", stateLine.warn ? "text-brand-text" : "text-muted-foreground")} title={stateLine.text}>
          {stateLine.text}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {h.paused ? (
          <Button size="sm" onClick={() => onAct(() => setHooksPausedAction({ paused: false }))} disabled={pending} className="bg-brand text-ink hover:bg-brand/90">
            <Play /> Resume hook scoring
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => onAct(() => setHooksPausedAction({ paused: true }))} disabled={pending}>
            <Pause /> Pause hook scoring
          </Button>
        )}
        {h.errors > 0 && (
          <Button variant="outline" size="sm" onClick={() => onAct(() => retryHookErrorsAction())} disabled={pending}>
            <RotateCcw /> Retry {h.errors} error{h.errors === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      <form
        id="shorts-gate"
        className="mt-4 flex scroll-mt-4 flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onAct(() => setShortsGateAction({ value: Number(gate) }));
        }}
      >
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Shorts board gate (main hook overall)
          <input
            type="number"
            min={1}
            max={5}
            step={0.1}
            value={gate}
            onChange={(e) => setGate(e.target.value)}
            className="h-8 w-24 rounded-md border border-border bg-card px-2 text-[13px] text-foreground tabular focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          />
        </label>
        <Button type="submit" variant="outline" size="sm" disabled={pending || gate === "" || Number(gate) === shortsGate}>
          Save
        </Button>
        <span className="basis-full text-[11.5px] text-muted-foreground md:basis-auto">
          Undecided Idea cards whose main hook (the cold open, else the first line) scores under this sit behind Show weaker. Default 2.6; unscored and kept cards always show.
        </span>
      </form>
      <div className="mt-4 overflow-hidden rounded-lg border border-border">
        <table className="w-full text-[12.5px]">
          <thead className="bg-muted/60 text-left text-[11.5px] text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Jev spend by purpose</th>
              <th className="px-3 py-1.5 text-right font-medium">Today</th>
              <th className="px-3 py-1.5 text-right font-medium">Calls today</th>
              <th className="px-3 py-1.5 text-right font-medium">All time</th>
              <th className="px-3 py-1.5 text-right font-medium">Calls</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {h.spend.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-2 text-muted-foreground">
                  No Jev calls yet.
                </td>
              </tr>
            ) : (
              h.spend.map((p) => (
                <tr key={p.purpose}>
                  <td className="px-3 py-1.5">{purposeLabel(p.purpose)}</td>
                  <td className="px-3 py-1.5 text-right tabular">{usd(p.todayUsd)}</td>
                  <td className="px-3 py-1.5 text-right tabular">{p.todayCalls.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right tabular">{usd(p.allTimeUsd)}</td>
                  <td className="px-3 py-1.5 text-right tabular">{p.allTimeCalls.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JevSection({
  j,
  onAct,
  pending,
  envFile,
}: {
  j: JevStatus | undefined;
  onAct: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
  pending: boolean;
  /** The env file path (rendered by the Settings page on the server; never in /api/status). */
  envFile: string;
}) {
  const { classify: k, worker } = useStatus();
  const [threshold, setThreshold] = useState(String(k.threshold));
  const [cap, setCap] = useState(String(k.spend.capUsd));
  const capReached = k.spend.todayUsd >= k.spend.capUsd;
  const stateLine = !worker.alive
    ? { text: "Worker offline. Classify runs in the worker.", warn: true }
    : k.state === "running"
      ? { text: `Classifying ${k.current ?? "…"}`, warn: false }
      : k.state === "waiting"
        ? { text: `Waiting: ${k.note ?? "Jev is not available"}`, warn: true }
        : capReached
          ? { text: "Daily Jev cap reached. Classify resumes after midnight (New York time).", warn: true }
          : k.paused
            ? { text: "Paused. New files and the backfill wait; Classify again still works per file.", warn: false }
            : k.done >= k.described
              ? { text: "Idle. Everything described is classified.", warn: false }
              : { text: "Idle. The rest wait for their description (or have errors).", warn: false };
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold">Classify (Jev)</div>
        <div className="text-[12px] text-muted-foreground">Reads descriptions only; one call per file.</div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <CheckBox
          title="Jev (TypeSafe)"
          sub={`Pinned model ${j?.pinned ?? "…"}`}
          ok={j ? j.keyPresent && j.reachable && !j.error : undefined}
          rows={[
            ["Key present", j?.keyPresent],
            ["GET /v1/models answers", j ? j.reachable && !j.error : undefined],
          ]}
          extra={j?.models?.length ? `Listed: ${j.models.join(", ")}${j.pinnedListed ? "" : ` (${j.pinned} is accepted even when only aliases are listed)`}` : null}
          problem={j && !j.keyPresent ? `Paste TYPESAFE_API_KEY into ${envFile}` : j?.error && j.keyPresent ? `Jev check: ${j.error}` : null}
        />
        <div className="rounded-lg border border-border px-3 py-2.5">
          <div className="text-[13px] font-medium">Spend</div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
            <Fact k="Today" v={`${usd(k.spend.todayUsd)} of ${usd(k.spend.capUsd)}`} warn={capReached} />
            <Fact k="All time" v={usd(k.spend.allTimeUsd)} />
            <Fact k="Calls today" v={k.spend.todayCalls.toLocaleString()} />
            <Fact k="Calls all time" v={k.spend.allTimeCalls.toLocaleString()} />
          </dl>
          <div className="mt-2 text-[11.5px] text-muted-foreground">$0.042 per 1M input tokens. The day resets at midnight New York time.</div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border px-3 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px] font-medium">
            Classified <span className="tabular">{k.done.toLocaleString()}</span>
            <span className="text-muted-foreground tabular"> / {k.described.toLocaleString()} described</span>
          </div>
          <span className="text-[12px] text-muted-foreground tabular">{pct(k.done, k.described)}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-foreground/70" style={{ width: `${pct(k.done, k.described)}%` }} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-4">
          <Fact k="Needs review" v={k.needsReview.toLocaleString()} warn={k.needsReview > 0} />
          <Fact k="Errors" v={k.errors.toLocaleString()} warn={k.errors > 0} />
          <Fact k="Classify again" v={k.requested ? `${k.requested} queued` : "none queued"} />
          <Fact k="Questions" v={`v${k.version}`} />
        </dl>
        <div className={cn("mt-3 truncate text-[12.5px]", stateLine.warn ? "text-brand-text" : "text-muted-foreground")} title={stateLine.text}>
          {stateLine.text}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
        {k.paused ? (
          <Button size="sm" onClick={() => onAct(() => setClassifyPausedAction({ paused: false }))} disabled={pending} className="bg-brand text-ink hover:bg-brand/90">
            <Play /> Resume classifying
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => onAct(() => setClassifyPausedAction({ paused: true }))} disabled={pending}>
            <Pause /> Pause classify
          </Button>
        )}
        {k.errors > 0 && (
          <Button variant="outline" size="sm" onClick={() => onAct(() => retryClassifyErrorsAction())} disabled={pending}>
            <RotateCcw /> Retry {k.errors} error{k.errors === 1 ? "" : "s"}
          </Button>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAct(() => setClassifyThresholdAction({ value: Number(threshold) }));
          }}
        >
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Confidence threshold
            <span className="flex items-center gap-2">
              <input
                type="range"
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                step={0.05}
                value={Number(threshold)}
                onChange={(e) => setThreshold(e.target.value)}
                className="w-32 accent-[var(--color-brand)]"
                aria-label="Confidence threshold"
              />
              <span className="w-9 font-medium text-foreground tabular">{Number(threshold).toFixed(2)}</span>
            </span>
          </label>
          <Button type="submit" variant="outline" size="sm" disabled={pending || Number(threshold) === k.threshold}>
            Save
          </Button>
        </form>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAct(() => setJevDailyCapAction({ usd: Number(cap) }));
          }}
        >
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Daily cap (USD)
            <input
              type="number"
              min={0}
              max={20}
              step={0.25}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="h-8 w-24 rounded-md border border-border bg-card px-2 text-[13px] text-foreground tabular focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          </label>
          <Button type="submit" variant="outline" size="sm" disabled={pending || Number(cap) === k.spend.capUsd || cap === ""}>
            Save
          </Button>
        </form>
      </div>
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        Choice and score answers under the threshold, and yes/no answers between 25% and 75%, are unsure. Only an unsure category, client group or brand safe answer sends a file to Review; the other unsure answers are marked in the drawer and in Review. Client tags Jev is sure about are applied at once (marked Jev).
      </p>
    </div>
  );
}

function Fact({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("truncate font-medium tabular", warn && "text-brand-text")}>{v}</dd>
    </div>
  );
}

function CheckBox({
  title,
  sub,
  ok,
  rows,
  extra,
  problem,
}: {
  title: string;
  sub: string;
  ok: boolean | undefined;
  rows: [string, boolean | undefined][];
  extra: string | null;
  problem: string | null;
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{title}</div>
          <div className="truncate text-[12px] text-muted-foreground" title={sub}>
            {sub}
          </div>
        </div>
        <span className={cn("text-[12px] font-medium", ok === undefined ? "text-muted-foreground" : ok ? "text-foreground" : "text-brand-text")}>
          {ok === undefined ? "Checking…" : ok ? "Ready" : "Not ready"}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {rows.map(([label, v]) => (
          <li key={label} className="flex items-center gap-2 text-[12.5px]">
            <span
              className={cn(
                "grid size-5 place-items-center rounded-md",
                v ? ACTIVE_PILL : v === false ? "bg-brand/15 text-brand-text" : "bg-muted text-muted-foreground",
              )}
            >
              {v ? <Check className="size-3" /> : <CircleDashed className="size-3" />}
            </span>
            {label}
            <span className="ml-auto text-[12px] text-muted-foreground">{v ? "Yes" : v === false ? "No" : "?"}</span>
          </li>
        ))}
      </ul>
      {extra && <div className="mt-2 text-[12px] text-muted-foreground tabular">{extra}</div>}
      {problem && <div className="mt-2 text-[12px] break-all text-brand-text">{problem}</div>}
    </div>
  );
}
