import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ChannelCoverage, CoverageCell, FormatCoverage, MechanicCoverage } from "@/lib/hooks/coverage";

/** Short column labels for the compact table (Rubric page). */
const SHORT: Record<string, string> = {
  be_specific: "Specific",
  lead_number: "Number",
  call_out: "Call out",
  taboo: "Taboo",
  primal_desire: "Desire",
  curiosity_loop: "Curiosity",
  negative: "Negative",
  golden_nugget: "Testimonial",
  transformation: "Transform",
  educational_infographic: "Infographic",
  headliner: "Headliner",
  benefits_callout: "Benefits",
  comparison: "Comparison",
  grid: "Grid",
  text_only: "Text only",
};

function Chip({ cell }: { cell: CoverageCell }) {
  const gap = cell.count === 0;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px]",
        gap ? "border border-dashed border-brand/70 text-brand-text" : "bg-muted text-foreground/85",
      )}
      title={gap ? `${cell.label}: none yet (a gap)` : `${cell.label}: ${cell.count}`}
    >
      {cell.label}
      <span className={cn("tabular", gap ? "font-semibold" : "text-muted-foreground")}>{cell.count}</span>
    </span>
  );
}

function Row({ title, sub, cells, extra }: { title: string; sub: string; cells: CoverageCell[]; extra: React.ReactNode }) {
  const gaps = cells.filter((c) => c.count === 0).length;
  return (
    <div className="grid grid-cols-[170px_minmax(0,1fr)] items-start gap-3">
      <div className="pt-0.5">
        <div className="text-[12px] font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">
          {sub}
          {gaps > 0 && <span className="text-brand-text"> · {gaps} {gaps === 1 ? "gap" : "gaps"}</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {cells.map((c) => (
          <Chip key={c.id} cell={c} />
        ))}
        {extra && <span className="ml-1 text-[11.5px] text-muted-foreground tabular">{extra}</span>}
      </div>
    </div>
  );
}

/** Above the Hooks list: live hooks per copy mechanic, and (Lane B) statics per visual format. Zero = gap (orange). */
export function CoverageStrip({ mechanics, formats }: { mechanics: MechanicCoverage; formats: FormatCoverage | null }) {
  return (
    <div className="mx-4 mt-4 space-y-2.5 rounded-xl border border-border bg-card px-4 py-3 sm:mx-6" aria-label="Coverage">
      <Row
        title="Copy mechanics"
        sub={`${mechanics.total.toLocaleString()} live hooks (text + video)`}
        cells={mechanics.cells}
        extra={
          <>
            None {mechanics.none}
            {mechanics.unscored > 0 && <> · not scored yet {mechanics.unscored}</>}
          </>
        }
      />
      {formats && (
        <Row
          title="Statics · visual formats"
          sub={`${formats.total.toLocaleString()} static ads (Library)`}
          cells={formats.cells}
          extra={formats.other > 0 ? <>not an ad / no format {formats.other}</> : null}
        />
      )}
    </div>
  );
}

function Cell({ n }: { n: number }) {
  return (
    <td className={cn("px-1.5 py-1 text-center tabular", n === 0 ? "font-semibold text-brand-text" : "text-foreground/85")}>
      {n === 0 ? <span className="inline-block min-w-5 rounded border border-dashed border-brand/70 px-1">0</span> : n}
    </td>
  );
}

/** Rubric page: every channel in one compact table per strip. */
export function CoverageTables({ channels, lanes }: { channels: ChannelCoverage[]; lanes: Record<"rtm" | "fkbpros" | "fkb", string> }) {
  const L = { lane: lanes };
  const mechs = channels[0]?.mechanics.cells ?? [];
  const fmts = channels.find((c) => c.formats)?.formats?.cells ?? [];
  const th = "px-1.5 py-1.5 text-center font-medium";
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[13px] font-semibold">Live hooks per copy mechanic</h3>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/60 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Channel</th>
                {mechs.map((m) => (
                  <th key={m.id} className={th} title={m.label}>
                    {SHORT[m.id] ?? m.label}
                  </th>
                ))}
                <th className={th}>None</th>
                <th className={th}>Not scored</th>
                <th className={th}>Total</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.key} className="border-t border-border">
                  <td className="px-3 py-1 whitespace-nowrap">
                    <Link href={c.href} className="hover:underline">
                      {c.label}
                    </Link>
                  </td>
                  {c.mechanics.cells.map((m) => (
                    <Cell key={m.id} n={m.count} />
                  ))}
                  <td className="px-1.5 py-1 text-center text-muted-foreground tabular">{c.mechanics.none}</td>
                  <td className="px-1.5 py-1 text-center text-muted-foreground tabular">{c.mechanics.unscored}</td>
                  <td className="px-1.5 py-1 text-center font-medium tabular">{c.mechanics.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <h3 className="text-[13px] font-semibold">{L.lane.fkbpros} statics per visual format</h3>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/60 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Channel</th>
                {fmts.map((f) => (
                  <th key={f.id} className={th} title={f.label}>
                    {SHORT[f.id] ?? f.label}
                  </th>
                ))}
                <th className={th}>Other</th>
                <th className={th}>Total</th>
              </tr>
            </thead>
            <tbody>
              {channels
                .filter((c) => c.formats)
                .map((c) => (
                  <tr key={c.key} className="border-t border-border">
                    <td className="px-3 py-1 whitespace-nowrap">{c.label}</td>
                    {c.formats!.cells.map((f) => (
                      <Cell key={f.id} n={f.count} />
                    ))}
                    <td className="px-1.5 py-1 text-center text-muted-foreground tabular">{c.formats!.other}</td>
                    <td className="px-1.5 py-1 text-center font-medium tabular">{c.formats!.total}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
