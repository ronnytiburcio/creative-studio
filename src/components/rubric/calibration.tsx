/**
 * Rubric page: "Calibration" (Phase 5 slice 3, PHASE-5 F) and the test order table (G2). Server rendered; the selectors
 * are plain links (URL keys cal_v, cal_view, cal_m), so nothing here needs client JS. Nothing here acts: the owner edits the
 * rubric, and a new version rescores only on his click.
 */
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { CalReport, CalViewData, MissRow } from "@/lib/calibration/report";
import { CAL_METRIC_BETTER, CAL_METRIC_LABEL, CAL_METRICS, cellText, isNoise, NOISE_GROUPS, NOISE_RHO, strengthOf, type CalCell, type CalMetric } from "@/lib/calibration/stats";
import type { TestOrderTableRow } from "@/lib/meta/test-order";
import { TEST_LABEL } from "@/lib/meta/test-order-rules";
import { ACTIVE_PILL, EyebrowCard as Card } from "@/components/hooks/ui";

type Params = CalReport["params"];

function href(p: Params, patch: Partial<Record<"cal_v" | "cal_view" | "cal_m", string>>) {
  const q = new URLSearchParams();
  const v = patch.cal_v ?? String(p.version);
  const view = patch.cal_view ?? p.view;
  // Switching the view starts on its first metric (Lane A reads views / average % viewed, the rest CTR / hook rate / CPL).
  const m = patch.cal_m ?? (patch.cal_view && patch.cal_view !== p.view ? null : p.missMetric);
  if (v !== "latest") q.set("cal_v", v);
  if (view !== "overall") q.set("cal_view", view);
  if (m && m !== (view === "rtm" ? "views" : "ctr")) q.set("cal_m", m);
  return `/rubric${q.size ? `?${q}` : ""}#calibration`;
}

/** Brand tokens only: positive = ink (stronger = darker), negative = orange; weak / none = plain. */
function cellCls(c: CalCell): string {
  if (!c.enough || c.rho == null) return "text-muted-foreground";
  // Mostly noise (|rho| under 0.2 on fewer than 30 ad groups): muted, whatever its sign.
  if (isNoise(c)) return "text-muted-foreground";
  const s = strengthOf(c.rho);
  if (c.rho > 0) return s === "strong" ? ACTIVE_PILL : s === "moderate" ? "bg-ink/15 font-medium" : s === "weak" ? "bg-ink/6" : "";
  return s === "strong" ? "bg-brand text-ink" : s === "moderate" ? "bg-brand/30 font-medium" : s === "weak" ? "bg-brand/12" : "";
}

function cellTitle(c: CalCell, metric: CalMetric, unit: string): string {
  const what = metric === "cpl" ? "leads" : metric === "views" || metric === "avg_viewed" ? "views" : "impressions";
  if (!c.enough) return `Needs ${c.need} hooks with enough ${what} on ${c.needGroups}+ different ${unit}; ${c.n} hooks on ${c.groups} ${unit} so far.`;
  if (c.rho == null) return "Every counted hook has the same score or the same result: nothing to rank.";
  const s = strengthOf(c.rho);
  const noise = isNoise(c) ? ` Mostly noise: under ±${NOISE_RHO} on fewer than ${NOISE_GROUPS} ${unit}.` : "";
  return `${s === "none" ? "No real link" : `A ${s} link`}: ${c.rho > 0 ? `higher scores went with ${CAL_METRIC_BETTER[metric]}` : `higher scores went with worse results (not ${CAL_METRIC_BETTER[metric]})`} across ${c.n} hooks on ${c.groups} ${unit}.${noise}`;
}

function Seg({ items }: { items: { label: string; href: string; active: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((i) => (
        <Link
          key={i.href + i.label}
          href={i.href}
          scroll={false}
          aria-current={i.active ? "true" : undefined}
          className={cn(
            "inline-flex h-8 items-center rounded-md border px-2.5 text-[12.5px] transition-colors",
            i.active ? `border-transparent ${ACTIVE_PILL}` : "border-border bg-card text-muted-foreground hover:bg-hover hover:text-foreground",
          )}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );
}

function CellChip({ c, metric, unit }: { c: CalCell | undefined; metric: CalMetric; unit: string }) {
  if (!c) return <span className="text-muted-foreground">–</span>;
  return (
    <span
      className={cn("inline-block rounded-md px-2 py-1 text-[12px] tabular", c.enough && "whitespace-nowrap", cellCls(c), isNoise(c) && "italic")}
      title={cellTitle(c, metric, unit)}
    >
      {cellText(c, unit)}
    </span>
  );
}

function Cell({ c, metric, unit }: { c: CalCell | undefined; metric: CalMetric; unit: string }) {
  return (
    <td className="px-2 py-1.5">
      <CellChip c={c} metric={metric} unit={unit} />
    </td>
  );
}

function minText(m: CalMetric, min: CalReport["minimums"]): string {
  if (m === "cpl") return `${min.leads}+ leads`;
  if (m === "views" || m === "avg_viewed") return `${min.views.toLocaleString("en-US")}+ views`;
  return `${min.impressions.toLocaleString("en-US")}+ ${m === "hook" ? "video " : ""}impressions`;
}

function ViewTable({ view, min }: { view: CalViewData; min: CalReport["minimums"] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px] text-left text-[12.5px]">
        <thead className="bg-muted/60 text-[11.5px] text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Score</th>
            {view.metrics.map((m) => (
              <th key={m} className="px-2 py-2 font-medium">
                {CAL_METRIC_LABEL[m]}
                <span className="block font-normal">
                  {view.counted[m] ?? 0} {view.counted[m] === 1 ? "hook counts" : "hooks count"} ({minText(m, min)}) · {view.countedGroups[m] ?? 0} {view.unit}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map(({ item, cells }) => (
            <tr key={item.id} className={cn("border-t border-border", item.group === "overall" && "font-medium")}>
              <td className="px-3 py-1.5">
                <div>{item.label}</div>
                <div className="text-[11px] font-normal text-muted-foreground">{item.hint}</div>
              </td>
              {view.metrics.map((m) => (
                <Cell key={m} c={cells[m]} metric={m} unit={view.unit} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Misses({ title, note, rows, metric }: { title: string; note: string; rows: MissRow[]; metric: CalMetric }) {
  return (
    <div className="min-w-0">
      <h3 className="text-[13.5px] font-semibold">{title}</h3>
      <p className="text-[12px] text-muted-foreground">{note}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-muted-foreground">None yet.</p>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <li key={r.hookId} className="rounded-lg border border-border px-3 py-2">
              <Link href={r.href} className="line-clamp-2 text-[13px] leading-snug hover:underline">
                {r.text}
              </Link>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground tabular">
                <span>
                  Score <span className="font-medium text-foreground">{r.score.toFixed(1)}</span>
                </span>
                <span>
                  {CAL_METRIC_LABEL[metric]} <span className="font-medium text-foreground">{r.valueText}</span>
                </span>
                {metric === "views" || metric === "avg_viewed" ? (
                  <span>
                    {r.ads} {r.ads === 1 ? "Short" : "Shorts"}
                  </span>
                ) : (
                  <>
                    <span>
                      {r.ads} {r.ads === 1 ? "ad" : "ads"}
                    </span>
                    <span>{r.impressions.toLocaleString("en-US")} impressions</span>
                  </>
                )}
                {metric === "cpl" && r.leads != null && <span>{r.leads} leads</span>}
                <span>{r.channel}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function CalibrationSection({ report }: { report: CalReport }) {
  const A = report.rtm.label;
  const C = report.channels.find((c) => c.key === "fkb")?.label ?? "";
  const p = report.params;
  const min = report.minimums;
  const viewLabel = report.view.label;
  return (
    <Card
      title="Calibration"
      eyebrow="Scores vs real Meta and YouTube results"
      aside={
        <Link href="/settings#meta" className="hover:text-foreground hover:underline">
          Minimums: {min.impressions.toLocaleString("en-US")} impressions · {min.leads} leads · {min.views.toLocaleString("en-US")} views · {min.hooks} hooks on{" "}
          {min.groups} ad groups a cell
        </Link>
      }
    >
      <div id="calibration" className="scroll-mt-20 space-y-4">
        <p className="max-w-[780px] text-[13px] leading-relaxed">
          Does a higher Jev score go with better ads? Each number ranks the hooks by score and by their Meta results ({A}: its YouTube Shorts)
          and says how well the two orders agree. A hook&apos;s results are the sum of every Meta ad that carries it (all time, shared credit: an ad
          counts in full for each hook on it); an {A} hook&apos;s are its Shorts&apos; views and average % viewed.
        </p>
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-[12.5px] leading-relaxed">
          <b>+1</b>: higher scores always went with better results (higher CTR, higher hook rate, lower CPL). <b>0</b>: no link, the score says
          nothing about results. <b>−1</b>: higher scores went with worse results, the rubric points the wrong way there. Around ±0.3 is a real but
          loose link; ±0.5 or more is strong. Hooks on the same ads share results, so what counts is the number of ad groups; with fewer than
          about 30 groups, numbers between -0.2 and +0.2 are mostly noise.{" "}
          <span className="text-muted-foreground">(Those cells are greyed out. {A} counts Shorts the same way.)</span>
        </p>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-[92px] shrink-0 text-[12px] text-muted-foreground">Rubric version</span>
            <Seg items={report.versionOptions.map((o) => ({ label: o.label, href: href(p, { cal_v: o.value }), active: String(p.version) === o.value }))} />
          </div>
          <p className="text-[12px] text-muted-foreground sm:pl-[100px]">{report.versionNote}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-[92px] shrink-0 text-[12px] text-muted-foreground">View</span>
            <Seg items={report.channels.map((c) => ({ label: c.key === "overall" ? "Overall" : c.label, href: href(p, { cal_view: c.key }), active: p.view === c.key }))} />
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-[14px] font-semibold">{viewLabel}</h3>
            <span className="text-[12px] text-muted-foreground">
              {report.view.linked} scored {report.view.linked === 1 ? "hook" : "hooks"} on {report.view.key === "rtm" ? "YouTube Shorts" : "Meta ads"}
              {report.view.metaLeads ? ` · CPL counts Meta leads for ${C} (its GHL leads carry no ad source yet)` : ""}
            </span>
          </div>
          <ViewTable view={report.view} min={min} />
        </div>

        <div id="calibration-channels">
          <h3 className="mb-2 text-[14px] font-semibold">By channel · overall score</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-left text-[12.5px]">
              <thead className="bg-muted/60 text-[11.5px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  {CAL_METRICS.map((m) => (
                    <th key={m} className="px-2 py-2 font-medium">
                      {CAL_METRIC_LABEL[m]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.byChannel.map((c) => (
                  <tr key={c.key} className={cn("border-t border-border", c.key === p.view && "bg-brand/8")}>
                    <td className="px-3 py-1.5">
                      <Link href={href(p, { cal_view: c.key })} scroll={false} className="font-medium hover:underline">
                        {c.label}
                      </Link>
                      <div className="text-[11px] text-muted-foreground">{c.linked} scored hooks on ads</div>
                    </td>
                    {CAL_METRICS.map((m) => (
                      <Cell key={m} c={c.rows[0].cells[m]} metric={m} unit={c.unit} />
                    ))}
                  </tr>
                ))}
                <tr className={cn("border-t border-border", p.view === "rtm" && "bg-brand/8")}>
                  <td className="px-3 py-1.5">
                    <Link href={href(p, { cal_view: "rtm" })} scroll={false} className="font-medium hover:underline">
                      {report.rtm.label}
                    </Link>
                    <div className="text-[11px] text-muted-foreground">{report.rtm.view.linked} scored hooks on Shorts</div>
                  </td>
                  <td colSpan={3} className="px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {report.rtm.view.metrics.map((m) => (
                        <span key={m} className="inline-flex items-center gap-1.5 text-[12px]">
                          <span className="text-muted-foreground">{CAL_METRIC_LABEL[m]}</span>
                          <CellChip c={report.rtm.view.rows[0]?.cells[m]} metric={m} unit={report.rtm.view.unit} />
                        </span>
                      ))}
                    </div>
                    {report.rtm.note && <div className="mt-1 text-[12px] text-muted-foreground">{report.rtm.note}</div>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div id="calibration-misses">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <h3 className="text-[14px] font-semibold">Biggest misses · {viewLabel}</h3>
            <Seg items={report.view.metrics.map((m) => ({ label: CAL_METRIC_LABEL[m], href: href(p, { cal_m: m }), active: p.missMetric === m }))} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Misses
              title="High score, poor result"
              note={`Overall score ranks far above its ${CAL_METRIC_LABEL[report.misses.metric]} rank: what did Jev like that the audience did not?`}
              rows={report.misses.high}
              metric={report.misses.metric}
            />
            <Misses
              title="Low score, strong result"
              note={`Overall score ranks far below its ${CAL_METRIC_LABEL[report.misses.metric]} rank: what does the rubric miss here?`}
              rows={report.misses.low}
              metric={report.misses.metric}
            />
          </div>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Nothing here changes a score. To act on it, edit the rubric above (a new version); it rescores only when you click Rescore.
        </p>
      </div>
    </Card>
  );
}

export function TestOrderCard({ rows }: { rows: TestOrderTableRow[] }) {
  return (
    <Card title="Test order" eyebrow="Offer → hook → format → copy" aside="Suggested from each batch of new ads; confirm or change it on the Client tab">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-left text-[12.5px]">
          <thead className="bg-muted/60 text-[11.5px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Channel</th>
              <th className="px-3 py-2 font-medium">Last tested</th>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Next in the order</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-t border-border">
                <td className="px-3 py-1.5">
                  <Link href={r.href} className="font-medium hover:underline">
                    {r.label}
                  </Link>
                  {r.pending && <span className="ml-1.5 rounded bg-brand/15 px-1 text-[10.5px] font-medium text-brand-text">confirm</span>}
                </td>
                <td className="px-3 py-1.5">
                  {r.lastTested ? (
                    <>
                      <span className="font-medium capitalize">{TEST_LABEL[r.lastTested]}</span>
                      {!r.confirmed && <span className="ml-1.5 text-[11.5px] text-muted-foreground">suggested{r.mixed ? ", mixed" : ""}</span>}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Nothing tested yet</span>
                  )}
                </td>
                <td className="px-3 py-1.5 tabular text-muted-foreground">
                  {r.date ? `${fmtDay(r.date)} · ${r.nAds} new ${r.nAds === 1 ? "ad" : "ads"}` : "–"}
                </td>
                <td className="px-3 py-1.5 font-medium capitalize">{TEST_LABEL[r.next]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function fmtDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
