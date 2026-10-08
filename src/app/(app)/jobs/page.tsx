import Link from "next/link";
import { aiJobErrors, channelHrefFor, genJobs, getStatus, jobsData, readTail, type AiErrorRow, type GenJobView, type JobListRow, type StatusData } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { hookErrors, type HookErrorRow } from "@/lib/hooks/store";
import { variantJobs, type VariantJobView } from "@/lib/hooks/variants";
import { momentJobs, type MomentJobView } from "@/lib/shorts/moments";
import { adOrders, applyingText, ORDER_STATUS_LABEL, type AdOrderView } from "@/lib/meta/orders";
import { adCopyJobs, type AdCopyJobView } from "@/lib/meta/ad-copy-job";
import { wordsSummary } from "@/lib/shorts/transcript";
import { metaAccounts, type MetaAccountView } from "@/lib/meta/store";
import { getConfig } from "@/lib/config";
import { youtubeKeyStatus } from "@/lib/youtube/auth";
import { ytSummary, type YtSummary } from "@/lib/youtube/store";
import { clearedIds, unclearedCount } from "@/lib/cleared";
import { DERIVE_JOB_TYPES, JOB_STATUSES, JOB_TYPE_LABEL, type JobStatus, type JobType } from "@/lib/jobs";
import {
  AiPauseButton,
  AiRetryAllButton,
  AiRetryButton,
  AutoRefresh,
  ClearAllErrorsButton,
  ClearErrorButton,
  HookRetryButton,
  MetaSyncButtons,
  YouTubeSyncButtons,
  VariantJobButton,
  ShortJobButton,
  AdCopyJobButton,
  AdOrderCancelButton,
  CancelButton,
  RetryAllButton,
  RetryButton,
} from "@/components/settings/job-actions";
import { cn } from "@/lib/utils";
import { formatWhen } from "@/lib/media";
import { uiLabels } from "@/lib/ui-labels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs" };


function when(ms: number | null) {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

/** A clock time ("Oct 1, 6:00 AM"), for times in the future too. */
const stamp = formatWhen;

function elapsed(j: GenJobView) {
  if (!j.startedAt) return j.status === "pending" ? "waiting" : "";
  const s = Math.max(0, Math.round(((j.finishedAt ?? Date.now()) - j.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function assetHref(j: { asset_id: number | null; section_key: string | null }) {
  if (!j.asset_id) return null;
  return `${channelHrefFor(j.section_key ?? "rtm")}?asset=${j.asset_id}`;
}

export default function JobsPage() {
  const d = jobsData();
  const gens = genJobs();
  const status = getStatus();
  const aiErrors = aiJobErrors();
  const hookErrs = hookErrors(getDb().sqlite);
  const variants = variantJobs(getDb().sqlite);
  const shortJobs = momentJobs(getDb().sqlite);
  const countOf = (type: JobType, status: JobStatus) =>
    d.counts.find((row) => row.type === type && row.status === status)?.n ?? 0;
  const types = DERIVE_JOB_TYPES;
  const totalErr = types.reduce((s, t) => s + countOf(t, "error"), 0);
  const derive = (k: string) => d.derive.find((x) => x.k === k)?.n ?? 0;

  return (
    <div className="mx-auto max-w-[1040px] px-6 pt-6 pb-16">
      <AutoRefresh />
      <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">Worker</div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Jobs</h1>
        <ClearAllErrorsButton count={unclearedCount(getDb().sqlite)} />
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Generations and quick tools (Higgsfield 3 at a time, ChatGPT via Codex 2 at a time), describe (Ollama + whisper, one at a time),
        classify and hook scoring (Jev, two at a time each), hook variants, Shorts moments and ad copy drafts (claude, one at a time each), new PAUSED ad orders (read back from their files every minute) and the derive queue (concurrency 2). Thumbnails run first so the Library fills fast; proxies follow,
        shortest first.
      </p>

      <AiQueues status={status} errors={aiErrors} hookErrors={hookErrs} />

      <MetaSync status={status} accounts={metaAccounts(getDb().sqlite)} cleared={clearedIds(getDb().sqlite, "meta")} />

      <YouTubeSync
        status={status}
        summary={ytSummary(getDb().sqlite, youtubeKeyStatus(getConfig()))}
        errorCleared={clearedIds(getDb().sqlite, "youtube").size > 0}
      />

      <VariantList jobs={variants} />

      <ShortMomentsList jobs={shortJobs} words={wordsSummary(getDb().sqlite)} />

      <AdOrdersList orders={adOrders(getDb().sqlite)} />

      <AdCopyList jobs={adCopyJobs(getDb().sqlite)} />

      <GenerationList jobs={gens} />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Assets done", derive("done")],
          ["Assets pending", derive("pending")],
          ["Assets with errors", derive("error")],
          ["Jobs running", types.reduce((s, t) => s + countOf(t, "running"), 0)],
        ].map(([label, v]) => (
          <div key={label as string} className="rounded-[12px] border border-border bg-card px-4 py-3.5">
            <div className="text-[12px] font-medium text-muted-foreground">{label}</div>
            <div className="mt-1 text-[20px] font-semibold tracking-[-0.02em] tabular">{(v as number).toLocaleString()}</div>
          </div>
        ))}
      </div>

      <section className="mt-5 overflow-hidden rounded-[12px] border border-border bg-card">
        <table className="w-full text-[13px]">
          <thead className="border-b border-border text-left text-[12px] text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Job type</th>
              {JOB_STATUSES.map((s) => (
                <th key={s} className="px-4 py-2.5 text-right font-medium capitalize">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {types.map((t) => (
              <tr key={t}>
                <td className="px-4 py-2.5 font-medium">{JOB_TYPE_LABEL[t]}</td>
                {JOB_STATUSES.map((s) => (
                  <td key={s} className={cn("px-4 py-2.5 text-right tabular", s === "error" && countOf(t, s) > 0 && "text-brand-text")}>
                    {countOf(t, s).toLocaleString()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <JobList title="Running now" empty="Nothing running." jobs={d.running} time={(j) => `started ${when(j.started_at)}`} />
        <JobList title="Up next" empty="Queue is empty." jobs={d.next} time={() => ""} />
      </div>

      <section className="mt-5 rounded-[12px] border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[15px]">Recent errors</h2>
          <RetryAllButton count={totalErr} />
        </header>
        {d.errors.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-muted-foreground">No errors.</div>
        ) : (
          <ul className="divide-y divide-border">
            {d.errors.map((j) => (
              <li key={j.id} className="flex items-start gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {assetHref(j) ? <Link className="hover:underline" href={assetHref(j)!}>{j.filename}</Link> : j.filename}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {JOB_TYPE_LABEL[j.type]} · {when(j.finished_at)} · attempt {j.attempts}
                  </div>
                  <div className="mt-1 line-clamp-2 font-mono text-[11.5px] break-all text-brand-text">{j.error}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <RetryButton id={j.id} />
                  <ClearErrorButton kind="derive" id={j.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-5">
        <JobList title="Recently finished" empty="Nothing yet." jobs={d.recent} time={(j) => when(j.finished_at)} />
      </div>
    </div>
  );
}


function GenerationList({ jobs }: { jobs: GenJobView[] }) {
  return (
    <section className="mt-5 rounded-[12px] border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px]">Generations</h2>
        <span className="text-[12px] text-muted-foreground tabular">
          {jobs.filter((j) => j.status === "running" || j.status === "pending").length} active
        </span>
      </header>
      {jobs.length === 0 ? (
        <div className="px-4 py-6 text-[13px] text-muted-foreground">No generations yet. Use Generate in any channel.</div>
      ) : (
        <ul className="divide-y divide-border">
          {jobs.map((j) => (
            <li key={j.id} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <StatusChip status={j.status} />
                <div className="min-w-0 flex-1">
                  {j.tool ? (
                    <div className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
                      <span className="shrink-0 font-medium">{j.tool.title}</span>
                      <span aria-hidden className="text-muted-foreground">·</span>
                      <Link className="min-w-0 truncate hover:underline" href={j.tool.sourceHref} title={`Source: ${j.tool.sourceName}`}>
                        {j.tool.sourceName}
                      </Link>
                    </div>
                  ) : (
                    <div className="line-clamp-2 text-[13px] font-medium" title={j.prompt}>
                      {j.prompt}
                    </div>
                  )}
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
                    {j.firstRun && (
                      <span
                        className="rounded border border-brand/40 px-1 text-[11px] font-medium text-brand-text"
                        title="This tool had never run for real when it shipped. If Higgsfield rejects it before starting, no credits are spent."
                      >
                        First real run
                      </span>
                    )}
                    <span className="font-medium text-foreground/80">{j.engineLabel}</span>
                    <span aria-hidden>·</span>
                    <span>{j.modelLabel}</span>
                    {j.versions > 1 && (
                      <span className="tabular">
                        v{j.version}/{j.versions}
                      </span>
                    )}
                    <span aria-hidden>·</span>
                    <Link className="hover:text-foreground hover:underline" href={j.destHref}>
                      {j.destLabel}
                    </Link>
                    {j.engine === "codex" ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>ChatGPT plan</span>
                      </>
                    ) : (
                      j.credits != null && (
                        <>
                          <span aria-hidden>·</span>
                          <span
                            className="tabular"
                            title={
                              j.creditsMinimum
                                ? "Higgsfield quotes this tool without the clip length: the real charge may be higher"
                                : j.creditsQuoted
                                  ? "Quoted by Higgsfield when the job started"
                                  : "Estimate shown when queued"
                            }
                          >
                            {j.creditsMinimum ? "at least " : ""}
                            {j.credits} credit{j.credits === 1 ? "" : "s"}
                            {j.creditsQuoted ? "" : " (est.)"}
                          </span>
                        </>
                      )
                    )}
                    <span aria-hidden>·</span>
                    <span className="tabular">{elapsed(j)}</span>
                    {j.externalId && (
                      <span className="font-mono text-[11px]" title={j.externalId}>
                        {j.externalId.slice(0, 8)}
                      </span>
                    )}
                  </div>
                  {j.outputs.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[12px]">
                      {j.outputs.map((o) =>
                        o.assetId ? (
                          <Link key={o.filename} className="truncate hover:underline" href={`${j.destHref.split("?")[0]}?asset=${o.assetId}`}>
                            {o.filename}
                          </Link>
                        ) : (
                          <span key={o.filename} className="truncate">
                            {o.filename}
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  {j.error && <div className="mt-1 text-[12px] text-brand-text">{j.error}</div>}
                  {j.engine === "higgsfield" && !j.externalId && (j.status === "error" || j.status === "cancelled") && (
                    <div className="mt-1 text-[12px] font-medium text-foreground">
                      {j.startUncertain ? "Check Higgsfield first: this job may already exist there. " : ""}
                      Retry creates a new Higgsfield job and spends {j.credits != null ? `${j.creditsMinimum ? "at least " : ""}${j.credits} credits` : "credits"}{" "}
                      again.
                    </div>
                  )}
                  {j.logTail.length > 0 && (
                    <details className="mt-1.5 group/log" open={j.status === "running"}>
                      <summary className="cursor-pointer text-[11.5px] text-muted-foreground select-none hover:text-foreground">Log</summary>
                      <pre className="scrollbar-thin mt-1 max-h-[180px] overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-foreground/85">
                        {j.logTail.join("\n")}
                      </pre>
                    </details>
                  )}
                </div>
                {(j.status === "error" || j.status === "cancelled") && j.engine === "codex" && (
                  <RetryButton id={j.id} label="Retry" title="Runs it again on your ChatGPT plan." />
                )}
                {(j.status === "error" || (j.status === "cancelled" && !j.externalId)) &&
                  j.engine !== "codex" &&
                  (j.externalId ? (
                    <RetryButton id={j.id} label="Retry" title="Re-polls the same Higgsfield job and downloads it again. No new credits." />
                  ) : (
                    <RetryButton
                      id={j.id}
                      label={j.credits != null ? `Retry · spends ${j.creditsMinimum ? "≥ " : ""}${j.credits} credits` : "Retry · spends credits"}
                      title={
                        j.startUncertain
                          ? "Creates a new Higgsfield job and spends credits again. The first one may already exist on Higgsfield: check there first."
                          : "Creates a new Higgsfield job: credits are spent again."
                      }
                    />
                  ))}
                {(j.status === "running" || j.status === "pending") && j.cancellable && (
                  <CancelButton
                    id={j.id}
                    requested={j.cancelRequested}
                    title={j.engine === "codex" ? undefined : "Removes it from the queue before it starts. Nothing is spent."}
                  />
                )}
                {j.status === "running" && j.engine === "higgsfield" && (
                  <span className="shrink-0 text-[11.5px] text-muted-foreground" title="Higgsfield has no cancel">
                    Can’t cancel: credits already spent
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type QueueView = {
  key: "describe" | "classify" | "hooks";
  label: string;
  sub: string;
  queued: number;
  done: number;
  total: number;
  errors: number;
  paused: boolean;
  state: string;
  current: string | null;
  note: string | null;
};

function queueState(q: QueueView, workerAlive: boolean): { text: string; warn: boolean } {
  if (!workerAlive) return { text: "Worker offline", warn: true };
  if (q.state === "running") return { text: "Running", warn: false };
  if (q.state === "waiting") return { text: `Waiting: ${q.note ?? "engine not available"}`, warn: true };
  if (q.paused) return { text: q.key === "hooks" && q.queued > 0 ? "Paused (Score again and new variants still run)" : "Paused", warn: false };
  if (q.key === "hooks") return { text: q.queued > 0 ? "Idle (the rest have errors or wait for Rescore)" : "Idle, up to date", warn: false };
  return { text: q.queued > 0 ? "Idle (the rest wait for previews or a description)" : "Idle, up to date", warn: false };
}

/**
 * Describe and classify are pull queues over `assets` (no job rows): one summary row each, plus their error rows with
 * Retry (Describe again / Classify again) and Retry all. Never one row per file.
 */
function AiQueues({
  status,
  errors,
  hookErrors,
}: {
  status: StatusData;
  errors: { describe: AiErrorRow[]; classify: AiErrorRow[] };
  hookErrors: HookErrorRow[];
}) {
  const d = status.describe;
  const c = status.classify;
  const h = status.hooks;
  const queues: QueueView[] = [
    { key: "describe", label: "Describe", sub: `Ollama ${d.model} + whisper`, queued: d.queued, done: d.done, total: d.total, errors: d.errors, paused: d.paused, state: d.state, current: d.current, note: d.note },
    { key: "classify", label: "Classify", sub: `Jev, pinned ${c.model}`, queued: c.queued, done: c.done, total: c.total, errors: c.errors, paused: c.paused, state: c.state, current: c.current, note: c.note },
    {
      key: "hooks",
      label: "Hook scoring",
      sub: `Jev, rubric v${h.version}`,
      queued: h.queued,
      done: h.scored,
      total: h.total,
      errors: h.errors,
      paused: h.paused,
      state: h.state,
      current: h.current.length ? `${h.current.length} hook${h.current.length === 1 ? "" : "s"} (#${h.current.join(", #")})` : null,
      note: h.note,
    },
  ];
  const errorRows = [
    ...errors.describe.map((e) => ({ ...e, queue: "describe" as const })),
    ...errors.classify.map((e) => ({ ...e, queue: "classify" as const })),
  ];
  return (
    <section className="mt-5 overflow-hidden rounded-[12px] border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px]">Describe, classify and hook scoring</h2>
        <Link href="/settings" className="text-[12px] text-muted-foreground hover:text-foreground hover:underline">
          AI settings
        </Link>
      </header>
      <table className="w-full text-[13px]">
        <thead className="border-b border-border text-left text-[12px] text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">Queue</th>
            <th className="px-4 py-2.5 text-right font-medium">Queued</th>
            <th className="px-4 py-2.5 font-medium">Running</th>
            <th className="px-4 py-2.5 text-right font-medium">Done</th>
            <th className="px-4 py-2.5 text-right font-medium">Errors</th>
            <th className="px-4 py-2.5 font-medium">State</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {queues.map((q) => {
            const st = queueState(q, status.worker.alive);
            const running = status.worker.alive && q.state === "running";
            return (
              <tr key={q.key} className="align-top">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{q.label}</div>
                  <div className="text-[11.5px] text-muted-foreground">{q.sub}</div>
                </td>
                <td className="px-4 py-2.5 text-right tabular">{q.queued.toLocaleString()}</td>
                <td className="max-w-[240px] px-4 py-2.5">
                  {running ? (
                    <span className="block truncate" title={q.current ?? ""}>
                      {q.current ?? "…"}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular">
                  {q.done.toLocaleString()}
                  <span className="text-muted-foreground"> / {q.total.toLocaleString()}</span>
                </td>
                <td className={cn("px-4 py-2.5 text-right tabular", q.errors > 0 && "text-brand-text")}>{q.errors.toLocaleString()}</td>
                <td className={cn("max-w-[220px] px-4 py-2.5", st.warn ? "text-brand-text" : "text-muted-foreground")}>
                  <span className="line-clamp-2">{st.text}</span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end gap-1.5">
                    <AiRetryAllButton queue={q.key} count={q.errors} />
                    <AiPauseButton queue={q.key} paused={q.paused} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {errorRows.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {errorRows.map((e) => (
            <li key={`${e.queue}-${e.id}`} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  <Link className="hover:underline" href={`${channelHrefFor(e.sectionKey)}?asset=${e.id}`}>
                    {e.filename}
                  </Link>
                </div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {e.queue === "describe" ? "Describe" : "Classify"} · {e.relPath}
                </div>
                <div className="mt-1 line-clamp-2 font-mono text-[11.5px] break-all text-brand-text">{e.error}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <AiRetryButton queue={e.queue} assetId={e.id} />
                <ClearErrorButton kind={e.queue} id={e.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {hookErrors.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {hookErrors.map((e) => (
            <li key={`hook-${e.id}`} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  <Link className="hover:underline" href={e.href}>
                    {e.text}
                  </Link>
                </div>
                <div className="truncate text-[12px] text-muted-foreground">
                  Hook scoring · {e.variant ? "variant" : e.kind === "video" ? "video hook" : "text hook"} #{e.id}
                </div>
                <div className="mt-1 line-clamp-2 font-mono text-[11.5px] break-all text-brand-text">{e.error}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <HookRetryButton hookId={e.id} />
                <ClearErrorButton kind="hook" id={e.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Meta + GHL sync (Phase 5): a pull over the ad accounts (no job rows), one summary row (state, last run, next run,
 * accounts synced today, errors, calls today) plus one row per account with an error.
 */
function MetaSync({ status, accounts, cleared }: { status: StatusData; accounts: MetaAccountView[]; cleared: Set<number> }) {
  const m = status.meta;
  const syncing = m.state === "running" || m.requested;
  const errored = accounts.filter((a) => (a.error || a.ghlError) && !cleared.has(a.id));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fresh = accounts.filter((a) => a.lastSyncAt && a.lastSyncAt >= today.getTime()).length;
  const stateText = !status.worker.alive
    ? "Worker offline"
    : syncing
      ? `Syncing${m.current ? ` ${m.current}` : ""}`
      : m.state === "waiting"
        ? `Waiting: ${m.note ?? "Meta rate limit"}`
        : m.paused
          ? "Paused (Sync now still works)"
          : "Idle";
  return (
    <section className="mt-5 overflow-hidden rounded-[12px] border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px]">Meta sync</h2>
        <Link href="/settings#meta" className="text-[12px] text-muted-foreground hover:text-foreground hover:underline">
          Meta settings
        </Link>
      </header>
      <table className="w-full text-[13px]">
        <thead className="border-b border-border text-left text-[12px] text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">Queue</th>
            <th className="px-4 py-2.5 font-medium">Last run</th>
            <th className="px-4 py-2.5 font-medium">Next run</th>
            <th className="px-4 py-2.5 text-right font-medium">Synced today</th>
            <th className="px-4 py-2.5 text-right font-medium">Errors</th>
            <th className="px-4 py-2.5 font-medium">State</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          <tr className="align-top">
            <td className="px-4 py-2.5">
              <div className="font-medium">Meta + GHL</div>
              <div className="text-[11.5px] text-muted-foreground tabular">read only · {m.callsToday} calls today</div>
            </td>
            <td className="px-4 py-2.5 tabular">{m.lastRunFinishedAt ? when(m.lastRunFinishedAt) : "never"}</td>
            <td className="px-4 py-2.5 tabular">{m.paused ? "paused" : stamp(m.nextRunAt)}</td>
            <td className="px-4 py-2.5 text-right tabular">
              {fresh}
              <span className="text-muted-foreground"> / {accounts.length}</span>
            </td>
            <td className={cn("px-4 py-2.5 text-right tabular", errored.length > 0 && "text-brand-text")}>{errored.length}</td>
            <td className={cn("max-w-[220px] px-4 py-2.5", m.state === "waiting" || !status.worker.alive ? "text-brand-text" : "text-muted-foreground")}>
              <span className="line-clamp-2">{stateText}</span>
            </td>
            <td className="px-4 py-2.5">
              <MetaSyncButtons paused={m.paused} syncing={syncing} />
            </td>
          </tr>
        </tbody>
      </table>
      {errored.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {errored.map((a) => (
            <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  <Link className="hover:underline" href={a.href}>
                    {a.label}
                  </Link>
                  <span className="ml-2 font-mono text-[11.5px] text-muted-foreground">{a.actId}</span>
                </div>
                <div className="text-[12px] text-muted-foreground">Last good sync {stamp(a.lastSyncAt)} · tried {stamp(a.lastAttemptAt)}</div>
                {a.error && <div className="mt-1 line-clamp-2 font-mono text-[11.5px] break-all text-brand-text">Meta: {a.error}</div>}
                {a.ghlError && <div className="mt-1 line-clamp-2 font-mono text-[11.5px] break-all text-brand-text">GHL: {a.ghlError}</div>}
              </div>
              <ClearErrorButton kind="meta" id={a.id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * YouTube Shorts sync (Phase 5 slice 4): one pull over the connected channel (no job rows), one summary row (state, last
 * run, next run, Shorts, matched) plus the last error.
 */
function YouTubeSync({ status, summary, errorCleared }: { status: StatusData; summary: YtSummary; errorCleared: boolean }) {
  const L = uiLabels().lane;
  const y = status.youtube;
  const syncing = y.state === "running" || y.requested;
  const blocked = !summary.keys.connected || summary.reconnectNeeded;
  const stateText = !summary.keys.connected
    ? "Not connected (Settings)"
    : summary.reconnectNeeded
      ? "Reconnect needed (Settings)"
      : !status.worker.alive
        ? "Worker offline"
        : syncing
          ? `Syncing${y.current ? ` ${y.current}` : ""}`
          : summary.paused
            ? "Paused (Sync now still works)"
            : "Idle";
  return (
    <section className="mt-5 overflow-hidden rounded-[12px] border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px]">YouTube Shorts sync</h2>
        <Link href="/settings#youtube" className="text-[12px] text-muted-foreground hover:text-foreground hover:underline">
          YouTube settings
        </Link>
      </header>
      <table className="w-full text-[13px]">
        <thead className="border-b border-border text-left text-[12px] text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">Queue</th>
            <th className="px-4 py-2.5 font-medium">Last good sync</th>
            <th className="px-4 py-2.5 font-medium">Next run</th>
            <th className="px-4 py-2.5 text-right font-medium">Shorts</th>
            <th className="px-4 py-2.5 text-right font-medium">Linked</th>
            <th className="px-4 py-2.5 font-medium">State</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          <tr className="align-top">
            <td className="px-4 py-2.5">
              <div className="font-medium">{summary.channelTitle ?? `${L.rtm} channel`}</div>
              <div className="text-[11.5px] text-muted-foreground tabular">read only · {summary.callsToday} calls today</div>
            </td>
            <td className="px-4 py-2.5 tabular">{summary.lastSyncAt ? when(summary.lastSyncAt) : "never"}</td>
            <td className="px-4 py-2.5 tabular">{blocked ? "–" : summary.paused ? "paused" : stamp(summary.nextRunAt)}</td>
            <td className="px-4 py-2.5 text-right tabular">{summary.shorts}</td>
            <td className="px-4 py-2.5 text-right tabular">{summary.matched}</td>
            <td className={cn("max-w-[220px] px-4 py-2.5", blocked || !status.worker.alive ? "text-brand-text" : "text-muted-foreground")}>
              <span className="line-clamp-2">{stateText}</span>
            </td>
            <td className="px-4 py-2.5">
              <YouTubeSyncButtons paused={summary.paused} syncing={syncing} blocked={blocked} />
            </td>
          </tr>
        </tbody>
      </table>
      {summary.error && !errorCleared && (
        <div className="flex items-start gap-3 border-t border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-muted-foreground">Last attempt failed</div>
            <div className="mt-1 line-clamp-2 font-mono text-[11.5px] break-all text-brand-text">{summary.error}</div>
          </div>
          <ClearErrorButton kind="youtube" id={0} />
        </div>
      )}
    </section>
  );
}

/** Rewrite variants jobs (`claude -p`, one at a time): hook, channel, survivors, log; Retry / Cancel. */
function VariantList({ jobs }: { jobs: VariantJobView[] }) {
  return (
    <section className="mt-5 rounded-[12px] border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px]">Hook variants</h2>
        <span className="text-[12px] text-muted-foreground tabular">
          claude on your subscription · {jobs.filter((j) => j.status === "running" || j.status === "pending").length} active
        </span>
      </header>
      {jobs.length === 0 ? (
        <div className="px-4 py-6 text-[13px] text-muted-foreground">No rewrites yet. Use Rewrite variants on any hook row.</div>
      ) : (
        <ul className="divide-y divide-border">
          {jobs.map((j) => {
            const tail = readTail(j.logPath, 12);
            return (
              <li key={j.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <StatusChip status={j.status} />
                  <div className="min-w-0 flex-1">
                    <Link href={j.href} className="line-clamp-2 text-[13px] font-medium hover:underline">
                      {j.hookText}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
                      <span className="font-medium text-foreground/80">{j.channel}</span>
                      {j.steer && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="max-w-[360px] truncate" title={j.steer}>
                            Steer: {j.steer}
                          </span>
                        </>
                      )}
                      {(j.status === "done" || j.attempts > 0) && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="tabular">
                            {j.survivors} of {j.returned} kept by the rules{j.attempts > 1 ? " (2 runs)" : ""}
                          </span>
                        </>
                      )}
                      <span aria-hidden>·</span>
                      <span className="tabular">{when(j.finishedAt ?? j.startedAt ?? j.createdAt)}</span>
                      <span className="font-mono text-[11px]">#{j.id}</span>
                    </div>
                    {j.note && <div className="mt-1 text-[12px] text-brand-text">{j.note}</div>}
                    {j.error && j.error !== j.note && <div className="mt-1 text-[12px] text-brand-text">{j.error}</div>}
                    {tail.length > 0 && (
                      <details className="mt-1.5" open={j.status === "running"}>
                        <summary className="cursor-pointer text-[11.5px] text-muted-foreground select-none hover:text-foreground">Log</summary>
                        <pre className="scrollbar-thin mt-1 max-h-[180px] overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-foreground/85">
                          {tail.join("\n")}
                        </pre>
                      </details>
                    )}
                  </div>
                  {(j.status === "error" || j.status === "cancelled") && <VariantJobButton id={j.id} kind="retry" />}
                  {j.status === "pending" && <VariantJobButton id={j.id} kind="cancel" />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Shorts moments jobs (Phase 6, `claude -p`, one at a time): episode, cards kept of returned, log; Retry / Cancel. */
function ShortMomentsList({ jobs, words }: { jobs: MomentJobView[]; words: { episodes: number; ready: number; running: number } }) {
  const L = uiLabels().lane;
  return (
    <section className="mt-5 rounded-[12px] border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px]">Short moments</h2>
        <span className="text-[12px] text-muted-foreground tabular">
          claude on your subscription · {words.ready} of {words.episodes} episodes word-timed{words.running ? " (transcribing)" : ""} ·{" "}
          {jobs.filter((j) => j.status === "running" || j.status === "pending").length} active
        </span>
      </header>
      {jobs.length === 0 ? (
        <div className="px-4 py-6 text-[13px] text-muted-foreground">
          No moments yet. Use New short on the <Link href="/rtm/shorts#board" className="underline">{L.rtm} Shorts board</Link>.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {jobs.map((j) => {
            const tail = readTail(j.logPath, 14);
            return (
              <li key={j.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <StatusChip status={j.status} />
                  <div className="min-w-0 flex-1">
                    <Link href="/rtm/shorts#board" className="text-[13px] font-medium hover:underline">
                      {j.episode}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
                      {(j.status === "done" || j.attempts > 0) && (
                        <>
                          <span className="tabular">
                            {j.survivors} card{j.survivors === 1 ? "" : "s"} of {j.returned} moments{j.attempts > 1 ? " (2 runs)" : ""}
                          </span>
                          <span aria-hidden>·</span>
                        </>
                      )}
                      <span className="tabular">{when(j.finishedAt ?? j.startedAt ?? j.createdAt)}</span>
                      <span className="font-mono text-[11px]">#{j.id}</span>
                    </div>
                    {j.waitingWords && <div className="mt-1 text-[12px] text-muted-foreground">Waiting for the word-timed transcript (the worker makes it first).</div>}
                    {j.note && <div className="mt-1 text-[12px] text-brand-text">{j.note}</div>}
                    {j.error && j.error !== j.note && <div className="mt-1 text-[12px] text-brand-text">{j.error}</div>}
                    {tail.length > 0 && (
                      <details className="mt-1.5" open={j.status === "running"}>
                        <summary className="cursor-pointer text-[11.5px] text-muted-foreground select-none hover:text-foreground">Log</summary>
                        <pre className="scrollbar-thin mt-1 max-h-[220px] overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-foreground/85">
                          {tail.join("\n")}
                        </pre>
                      </details>
                    )}
                  </div>
                  {(j.status === "error" || j.status === "cancelled") && <ShortJobButton id={j.id} kind="retry" />}
                  {j.status === "pending" && <ShortJobButton id={j.id} kind="cancel" />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const ORDER_CHIP: Record<AdOrderView["status"], string> = {
  staged: "bg-brand/15 text-brand-text",
  // Neutral while a Claude session applies it (not an alert).
  applying: "border border-border bg-muted/60 text-foreground",
  applied: "bg-muted text-foreground",
  failed: "border border-brand/40 text-brand-text",
  cancelled: "border border-border text-muted-foreground",
  missing: "border border-dashed border-border text-muted-foreground",
};

/**
 * New PAUSED ad orders (Phase 6 slice 3): Studio's staged order files, their status as the apply skill wrote it back
 * (read every minute by the worker), the real ad name once applied, "In Running" once the next Meta sync has it.
 */
function AdOrdersList({ orders }: { orders: AdOrderView[] }) {
  const L = uiLabels().lane;
  return (
    <section id="ad-orders" className="mt-5 scroll-mt-4 rounded-[12px] border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h2 className="text-[15px]">Ad orders</h2>
        <span className="text-[12px] text-muted-foreground tabular">
          new PAUSED Meta ads, staged as files · {orders.filter((o) => o.status === "staged").length} staged
          {orders.some((o) => o.status === "applying") ? ` · ${orders.filter((o) => o.status === "applying").length} being applied` : ""} · applied in a Claude session
        </span>
      </header>
      {orders.length === 0 ? (
        <div className="px-4 py-6 text-[13px] text-muted-foreground">No ad orders yet. Use New ad on a {L.fkbpros} or {L.fkb} hook, a Winner card or a Library file.</div>
      ) : (
        <ul className="divide-y divide-border">
          {orders.map((o) => (
            <li key={o.id} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <span className={cn("mt-0.5 inline-flex h-5 w-[62px] shrink-0 items-center justify-center rounded-md text-[11px] font-medium capitalize", ORDER_CHIP[o.status])}>
                  {o.status}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-[12.5px] font-medium break-all">{o.name}</span>
                    {!o.named && <span className="text-[11.5px] text-muted-foreground">(preview: the number is assigned when applied)</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
                    <span className="font-medium text-foreground/80">{o.channel}</span>
                    <span aria-hidden>·</span>
                    <span>{o.status === "applying" ? applyingText(o.applyStep, o.stalled) : ORDER_STATUS_LABEL[o.status]}</span>
                    {o.mediaName && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="max-w-[260px] truncate" title={o.mediaName}>
                          {o.mediaName}
                        </span>
                      </>
                    )}
                    <span aria-hidden>·</span>
                    <span className="tabular">{when(o.createdAt)}</span>
                    {o.adId && <span className="font-mono text-[11px]">ad {o.adId}</span>}
                    {o.creativeId && <span className="font-mono text-[11px]">creative {o.creativeId}</span>}
                    {o.inRunning && (
                      <Link href={o.inRunning} className="font-medium text-foreground hover:underline">
                        In Running
                      </Link>
                    )}
                  </div>
                  {o.hookText && (
                    <div className="mt-0.5 text-[12px] text-muted-foreground">
                      From the hook{" "}
                      {o.hookHref ? (
                        <Link href={o.hookHref} className="text-foreground/85 hover:underline">
                          “{o.hookText}”
                        </Link>
                      ) : (
                        <>“{o.hookText}”</>
                      )}
                      {o.source === "winner" ? " (a Winner card)" : ""}
                    </div>
                  )}
                  <div className="mt-0.5 font-mono text-[11px] break-all text-muted-foreground" title={o.filePath}>
                    {o.filePath}
                  </div>
                  {o.status === "failed" && o.failedStep && (
                    <div className="mt-1 text-[12px] text-brand-text">Stopped at the apply step: {o.failedStep}</div>
                  )}
                  {o.error && o.status !== "applying" && <div className="mt-1 text-[12px] text-brand-text">{o.error}</div>}
                  {o.readError && <div className="mt-1 text-[12px] text-brand-text">Read back: {o.readError}</div>}
                </div>
                {o.status === "staged" && <AdOrderCancelButton id={o.id} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Draft the rest jobs (`ad_copy`, `claude -p`, one at a time): channel, hook, what was kept, log; Retry / Cancel. */
function AdCopyList({ jobs }: { jobs: AdCopyJobView[] }) {
  return (
    <section className="mt-5 rounded-[12px] border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px]">Ad copy drafts</h2>
        <span className="text-[12px] text-muted-foreground tabular">
          claude on your subscription · {jobs.filter((j) => j.status === "running" || j.status === "pending").length} active
        </span>
      </header>
      {jobs.length === 0 ? (
        <div className="px-4 py-6 text-[13px] text-muted-foreground">No drafts yet. Use Draft the rest in the New PAUSED ad dialog.</div>
      ) : (
        <ul className="divide-y divide-border">
          {jobs.map((j) => {
            const tail = readTail(j.logPath, 14);
            const kept = j.draft ? j.draft.headlines.length + j.draft.primaries.length + (j.draft.description ? 1 : 0) : 0;
            return (
              <li key={j.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <StatusChip status={j.status} />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[13px] font-medium">{j.hookText ? `“${j.hookText}”` : "No hook (brand notes only)"}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
                      <span className="font-medium text-foreground/80">{j.channel}</span>
                      {j.status === "done" && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="tabular">
                            {kept} line{kept === 1 ? "" : "s"} drafted{j.dropped ? `, ${j.dropped} dropped by the rules` : ""}
                            {j.attempts > 1 ? " (2 runs)" : ""}
                          </span>
                        </>
                      )}
                      <span aria-hidden>·</span>
                      <span className="tabular">{when(j.finishedAt ?? j.startedAt ?? j.createdAt)}</span>
                      <span className="font-mono text-[11px]">#{j.id}</span>
                    </div>
                    {j.note && <div className="mt-1 text-[12px] text-brand-text">{j.note}</div>}
                    {j.error && j.error !== j.note && <div className="mt-1 text-[12px] text-brand-text">{j.error}</div>}
                    {tail.length > 0 && (
                      <details className="mt-1.5" open={j.status === "running"}>
                        <summary className="cursor-pointer text-[11.5px] text-muted-foreground select-none hover:text-foreground">Log</summary>
                        <pre className="scrollbar-thin mt-1 max-h-[220px] overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-foreground/85">
                          {tail.join("\n")}
                        </pre>
                      </details>
                    )}
                  </div>
                  {(j.status === "error" || j.status === "cancelled") && <AdCopyJobButton id={j.id} kind="retry" />}
                  {j.status === "pending" && <AdCopyJobButton id={j.id} kind="cancel" />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: JobStatus }) {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex h-5 w-[62px] shrink-0 items-center justify-center rounded-md text-[11px] font-medium capitalize",
        status === "running" && "bg-brand/15 text-brand-text",
        status === "pending" && "bg-muted text-muted-foreground",
        status === "done" && "bg-muted text-foreground",
        status === "error" && "border border-brand/40 text-brand-text",
        status === "cancelled" && "border border-border text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

function JobList({ title, jobs, empty, time }: { title: string; jobs: JobListRow[]; empty: string; time: (j: JobListRow) => string }) {
  return (
    <section className="rounded-[12px] border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-[15px]">{title}</h2>
      </header>
      {jobs.length === 0 ? (
        <div className="px-4 py-6 text-[13px] text-muted-foreground">{empty}</div>
      ) : (
        <ul className="divide-y divide-border">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-3 px-4 py-2">
              <span className="w-[150px] shrink-0 text-[12px] text-muted-foreground">{JOB_TYPE_LABEL[j.type]}</span>
              <span className="min-w-0 flex-1 truncate text-[13px]" title={j.rel_path ?? ""}>
                {j.filename}
              </span>
              <span className="shrink-0 text-[12px] text-muted-foreground tabular">{time(j)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
