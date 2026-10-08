"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { saveCalibrationMinimumsAction, saveFlagThresholdsAction } from "@/app/actions";
import { DEFAULT_FLAG_THRESHOLDS, type FlagThresholds } from "@/lib/meta/flags";
import { DEFAULT_CAL_MINIMUMS, type CalibrationMinimums } from "@/lib/calibration/stats";
import { PRIMARY_BTN } from "@/components/hooks/ui";
import { useLabels } from "@/components/shell/labels-provider";

type Field<K extends string> = { key: K; label: string; suffix: string; step: number; note: string };

const FLAG_FIELDS: Field<keyof FlagThresholds>[] = [
  { key: "frequency", label: "Fatiguing: frequency above", suffix: "", step: 0.1, note: "over the last 7 days" },
  { key: "dropPct", label: "Fatiguing: CTR or hook rate down", suffix: "%", step: 1, note: "last 7 days vs the ad's earlier average" },
  { key: "minImpressions", label: "… with impressions on each side", suffix: "", step: 100, note: "before a drop counts" },
  { key: "winnerPct", label: "Winner: 14 day CPL better by", suffix: "%", step: 1, note: "than the channel's 14 day CPL" },
  { key: "winnerLeads", label: "… with at least", suffix: "leads", step: 1, note: "in those 14 days" },
];

const calFields = (laneA: string): Field<keyof CalibrationMinimums>[] => [
  { key: "impressions", label: "A hook counts for CTR / hook rate with", suffix: "impressions", step: 100, note: "summed over its linked ads" },
  { key: "leads", label: "A hook counts for CPL with", suffix: "leads", step: 1, note: "summed over its linked ads" },
  { key: "views", label: `${laneA}: a hook counts with`, suffix: "views", step: 50, note: "summed over its YouTube Shorts" },
  { key: "hooks", label: "A cell needs at least", suffix: "hooks", step: 1, note: "else \"Not enough data yet\"" },
  { key: "groups", label: "… on at least", suffix: "ad groups", step: 1, note: `distinct sets of ads (${laneA}: Shorts) behind them` },
];

function Group<K extends string>({
  title,
  fields,
  values,
  defaults,
  onChange,
}: {
  title: string;
  fields: Field<K>[];
  values: Record<K, string>;
  defaults: Record<K, number>;
  onChange: (k: K, v: string) => void;
}) {
  return (
    <div className="min-w-0">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      <div className="mt-2 space-y-2">
        {fields.map((f) => (
          <label key={f.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 text-[12.5px]">
            <span className="min-w-0">
              {f.label}
              <span className="block text-[11px] text-muted-foreground">
                {f.note} · default {defaults[f.key].toLocaleString("en-US")}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <Input
                type="number"
                inputMode="decimal"
                step={f.step}
                value={values[f.key]}
                onChange={(e) => onChange(f.key, e.target.value)}
                className={cn("h-9 w-[92px] text-right tabular", Number(values[f.key]) !== defaults[f.key] && "border-foreground/30")}
              />
              <span className="w-[74px] text-[11.5px] text-muted-foreground">{f.suffix}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

const asStrings = <K extends string>(o: Record<K, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) as Record<K, string>;
const asNumbers = <K extends string>(o: Record<K, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)])) as Record<K, number>;

/**
 * Settings (Meta card): the Running flag thresholds and the calibration minimum sample. Saved through zod-validated server
 * actions into app_settings; Reset goes back to the defaults. Changing them never acts on an ad or a score.
 */
export function ThresholdsForm({ flags, calibration }: { flags: FlagThresholds; calibration: CalibrationMinimums }) {
  const L = useLabels();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState(asStrings(flags));
  const [c, setC] = useState(asStrings(calibration));
  const [prev, setPrev] = useState({ flags, calibration });
  if (prev.flags !== flags || prev.calibration !== calibration) {
    setPrev({ flags, calibration });
    setF(asStrings(flags));
    setC(asStrings(calibration));
  }
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Failed");
      else if (r.message) toast.success(r.message);
      router.refresh();
    });
  const dirty = JSON.stringify(asNumbers(f)) !== JSON.stringify(flags) || JSON.stringify(asNumbers(c)) !== JSON.stringify(calibration);
  const custom = JSON.stringify(flags) !== JSON.stringify(DEFAULT_FLAG_THRESHOLDS) || JSON.stringify(calibration) !== JSON.stringify(DEFAULT_CAL_MINIMUMS);

  const save = () =>
    run(async () => {
      const a = await saveFlagThresholdsAction(asNumbers(f));
      if (!a.ok) return a;
      const b = await saveCalibrationMinimumsAction(asNumbers(c));
      return b.ok ? { ok: true, message: "Flag thresholds and calibration minimums saved." } : b;
    });
  const reset = () =>
    run(async () => {
      const a = await saveFlagThresholdsAction(null);
      if (!a.ok) return a;
      const b = await saveCalibrationMinimumsAction(null);
      return b.ok ? { ok: true, message: "Back to the defaults." } : b;
    });

  return (
    <div id="thresholds" className="scroll-mt-20 rounded-lg border border-border px-4 py-3">
      <div className="grid gap-5 md:grid-cols-2">
        <Group title="Running flags" fields={FLAG_FIELDS} values={f} defaults={DEFAULT_FLAG_THRESHOLDS} onChange={(k, v) => setF((x) => ({ ...x, [k]: v }))} />
        <Group title="Calibration minimums" fields={calFields(L.lane.rtm)} values={c} defaults={DEFAULT_CAL_MINIMUMS} onChange={(k, v) => setC((x) => ({ ...x, [k]: v }))} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">Code rules, free. Flags and the report never pause an ad, queue a job or change a score.</p>
        <Button size="sm" variant="outline" disabled={pending || !custom} onClick={reset}>
          <RotateCcw /> Reset
        </Button>
        <Button size="sm" className={PRIMARY_BTN} disabled={pending || !dirty} onClick={save}>
          <Save /> Save
        </Button>
      </div>
    </div>
  );
}
