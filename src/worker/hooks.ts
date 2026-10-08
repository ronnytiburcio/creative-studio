/**
 * Hook scoring queue (worker only, Phase 4 C1 to C4): Jev scores every hook against the current rubric version. One
 * call per hook (src/lib/hooks/score.ts has the state, questions and evaluation), purpose `hook_score`.
 *
 * Same pull design as the classify queue (no jobs rows, nothing to recover after a restart: nothing is written until
 * Jev answered). Undecided variants (slice 3) are scored on request only. Due = a live hook (not archived; a top level
 * hook or a kept variant; a video hook's file visible) with no error and no score for the current rubric version (one
 * with an older version's score only after the owner's Rescore click), or a "Score again" request. A video described again
 * after its score is NOT due by itself: the Hooks tab lists it in the "changed since scored" banner and its Score again
 * click requests it (same for a drawer "Describe again"). The loops also sync video hooks with their assets every 15 s
 * (src/lib/hooks/video.ts; text refreshed, nothing requested). Order: requests first, then the newest hooks.
 * Concurrency 2. Pause key `hooks:paused` (seeded paused); while paused only requests run.
 *
 * Waits (no hook touched): no key, key refused, Jev down / overloaded after the adapter's retries (backoff 5 s doubling
 * to 5 min), daily cap (until the next America/New_York midnight). A refused request (422) or an answer that does not
 * fit is stored on that hook (score_error) and skipped until Score again.
 */
import type Database from "better-sqlite3";
import { jevFailureKind, type JevAdapter, type JevCapReachedError } from "../lib/ai/jev";
import { classifyThreshold } from "../lib/ai/state";
import { loadChannelNotes } from "../lib/hooks/notes";
import { buildHookQuestions, buildHookState, evaluateHook, type HookInput } from "../lib/hooks/score";
import { currentRubric, HOOK_ACTIVE, HOOK_DUE, HOOK_LIVE, hooksPaused, recomputeHookUnsure, storeHookScore } from "../lib/hooks/store";
import { syncVideoHooks, videoHookText, videoLines } from "../lib/hooks/video";
import type { HookKind, RubricVersion, SectionKey } from "../lib/hooks/rubric";

type DueRow = {
  id: number;
  kind: HookKind;
  section: SectionKey;
  text: string;
  client_id: number | null;
  asset_id: number | null;
  score_requested_at: number | null;
};

export type HookScoreState = "running" | "idle" | "paused" | "waiting" | "off";
export type HookScoreOutcome = "scored" | "error" | "unavailable" | "capped" | "interrupted";

export type HookScoreQueueOptions = {
  jev: JevAdapter;
  concurrency?: number;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  idleMs?: number;
  backoffMs?: { min: number; max: number };
  now?: () => number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How often the worker syncs video hooks with their assets (new hookable videos, re-described text, client tags). */
const VIDEO_SYNC_MS = 15_000;

export class HookScoreQueue {
  state: HookScoreState = "idle";
  note: string | null = null;
  readonly model: string;
  /** Hook id -> short label, for the heartbeat. */
  readonly running = new Map<number, string>();
  private stopped = false;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];
  private backoff = 0;
  private waitUntil = 0;
  private lastSync = 0;

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: HookScoreQueueOptions,
  ) {
    this.model = opts.jev.model;
  }

  /** Comma list of the hook ids being scored (the Hooks tab marks those rows "Scoring"). */
  get current(): string | null {
    return this.running.size ? [...this.running.keys()].join(",") : null;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private isStopped() {
    return this.stopped || this.opts.isStopped();
  }

  /** Next hook to score (skipping ones in flight), or null. While paused only "Score again" requests. */
  claimNext(): (DueRow & { rubric: RubricVersion }) | null {
    const rubric = currentRubric(this.sql);
    const row = this.sql
      .prepare(
        `select h.id, h.kind, s.key as section, h.text, h.client_id, h.asset_id, h.score_requested_at
           from hooks h join sections s on s.id = h.section_id
          where ${HOOK_ACTIVE} and h.id not in (select value from json_each(@inflight))
            and (h.score_requested_at is not null or (@paused = 0 and ${HOOK_LIVE} and ${HOOK_DUE}))
          order by h.score_requested_at is null, h.score_requested_at, h.created_at desc, h.id desc
          limit 1`,
      )
      .get({ inflight: JSON.stringify([...this.running.keys()]), paused: hooksPaused(this.sql) ? 1 : 0, version: rubric.version }) as
      | DueRow
      | undefined;
    return row ? { ...row, rubric } : null;
  }

  inputFor(row: DueRow): HookInput {
    let video: HookInput["video"] = null;
    if (row.kind === "video" && row.asset_id) {
      const a = this.sql.prepare("select description, spoken_open from assets where id = ?").get(row.asset_id) as
        | { description: string | null; spoken_open: string | null }
        | undefined;
      if (a) {
        const lines = videoLines(a.description, a.spoken_open);
        video = {
          firstSeconds: lines.opening,
          earlyFrame: lines.earlyFrame,
          onScreenText: lines.onScreen,
          spokenOpening: lines.spoken,
          textFrom: videoHookText(lines)?.from,
        };
      }
    }
    return {
      ...loadChannelNotes(this.sql, row.section, row.client_id),
      id: row.id,
      kind: row.kind,
      text: row.text,
      video,
    };
  }

  /**
   * Video hooks follow their assets (src/lib/hooks/video.ts): create the missing automatic ones, refresh text and
   * channel. Free (SQL only); throttled to every 15 s in the loops, forced by drain().
   */
  syncVideos(force = false) {
    if (!force && this.now() - this.lastSync < VIDEO_SYNC_MS) return;
    this.lastSync = this.now();
    try {
      const r = syncVideoHooks(this.sql, this.now());
      if (r.created || r.refreshed || r.moved) {
        this.opts.log(`hooks: video hooks ${r.created} created, ${r.refreshed} text refreshed, ${r.moved} moved channel`);
      }
    } catch (e) {
      this.opts.log("hooks: video sync error", (e as Error).message);
    }
  }

  /** Score one hook. Never throws. */
  async runOne(row: DueRow & { rubric: RubricVersion }): Promise<{ outcome: HookScoreOutcome; message?: string; resumeAt?: number }> {
    try {
      const input = this.inputFor(row);
      const questions = buildHookQuestions(row.rubric, input);
      const { state, notesFp } = buildHookState(row.rubric, input);
      const res = await this.opts.jev.ask(questions, state, "hook_score", { signal: this.abort.signal });
      if (this.isStopped()) return { outcome: "interrupted" };
      const ev = evaluateHook(row.rubric, input, res.full, classifyThreshold(this.sql));
      const now = this.now();
      this.sql.transaction(() => {
        storeHookScore(this.sql, { hookId: row.id, version: row.rubric.version, ev, notesFp, model: res.model, callId: res.callId, now });
        this.sql
          .prepare(
            `update hooks set score_error = null,
               score_requested_at = case when score_requested_at is ? then null else score_requested_at end
             where id = ?`,
          )
          .run(row.score_requested_at, row.id);
      })();
      this.opts.log(
        `hooks: #${row.id} scored ${ev.overall?.toFixed(1) ?? "?"} (v${row.rubric.version})` +
          `${ev.unsure.length ? `, unsure: ${ev.unsure.join(", ")}` : ""} · ${res.inputTokens} tokens`,
      );
      return { outcome: "scored" };
    } catch (e) {
      const failure = jevFailureKind(e);
      if (failure === "cap") {
        const cap = e as JevCapReachedError;
        return { outcome: "capped", message: cap.message, resumeAt: cap.resumeAt };
      }
      if (this.isStopped()) return { outcome: "interrupted" };
      if (failure) return { outcome: "unavailable", message: (e as Error).message };
      const message = ((e as Error).message || "Scoring failed").slice(0, 500);
      this.opts.log(`hooks error: #${row.id}: ${message}`);
      this.sql
        .prepare(
          `update hooks set score_error = ?,
             score_requested_at = case when score_requested_at is ? then null else score_requested_at end
           where id = ?`,
        )
        .run(message, row.score_requested_at, row.id);
      return { outcome: "error", message };
    }
  }

  private noteWait(outcome: "unavailable" | "capped", message: string, resumeAt?: number) {
    if (outcome === "capped") {
      this.waitUntil = resumeAt ?? this.now() + 3_600_000;
      this.backoff = 0;
      this.note = "Daily Jev cap reached. Scoring resumes after midnight.";
    } else {
      const { min, max } = this.opts.backoffMs ?? { min: 5_000, max: 300_000 };
      this.backoff = this.backoff ? Math.min(this.backoff * 2, max) : min;
      this.waitUntil = this.now() + this.backoff;
      this.note = message;
    }
    this.state = "waiting";
    this.opts.log(`hooks: ${this.note}; waiting until ${new Date(this.waitUntil).toISOString()}`);
  }

  /** Work until nothing is due (smoke tests, one-shot runs). Stops at the first wait (key, Jev down, cap). */
  async drain(): Promise<Record<HookScoreOutcome, number>> {
    const counts: Record<HookScoreOutcome, number> = { scored: 0, error: 0, unavailable: 0, capped: 0, interrupted: 0 };
    this.syncVideos(true);
    for (;;) {
      if (this.isStopped() || this.waitUntil > this.now()) return counts;
      const row = this.claimNext();
      if (!row) return counts;
      this.running.set(row.id, row.text.slice(0, 60));
      const { outcome, message, resumeAt } = await this.runOne(row);
      this.running.delete(row.id);
      counts[outcome]++;
      if (outcome === "unavailable" || outcome === "capped") {
        this.noteWait(outcome, message ?? "Jev is not available", resumeAt);
        return counts;
      }
      if (outcome === "interrupted") return counts;
    }
  }

  private async worker(idle: number) {
    while (!this.isStopped()) {
      this.syncVideos();
      const wait = this.waitUntil - this.now();
      if (wait > 0) {
        this.state = "waiting";
        await sleep(Math.min(wait, idle));
        continue;
      }
      let row: (DueRow & { rubric: RubricVersion }) | null = null;
      try {
        row = this.claimNext();
      } catch (e) {
        this.opts.log("hooks claim error", (e as Error).message);
      }
      if (!row) {
        if (!this.running.size) {
          this.state = hooksPaused(this.sql) ? "paused" : "idle";
          if (this.waitUntil && this.waitUntil <= this.now()) this.note = null;
        }
        await sleep(idle);
        continue;
      }
      this.running.set(row.id, row.text.slice(0, 60));
      this.state = "running";
      const { outcome, message, resumeAt } = await this.runOne(row);
      this.running.delete(row.id);
      if (outcome === "unavailable" || outcome === "capped") this.noteWait(outcome, message ?? "Jev is not available", resumeAt);
      else if (outcome !== "interrupted") {
        if (this.backoff) this.opts.log("hooks: Jev is back");
        this.backoff = 0;
        this.note = null;
      }
    }
  }

  /** Bring every stored score's `unsure` up to the current rule (once per rule version; SQL only, no Jev). */
  recomputeUnsure() {
    try {
      const n = recomputeHookUnsure(this.sql, classifyThreshold(this.sql));
      if (n) this.opts.log(`hooks: unsure marks recomputed on ${n} stored scores (neighbouring levels rule)`);
    } catch (e) {
      this.opts.log("hooks: unsure recompute error", (e as Error).message);
    }
  }

  start() {
    if (this.loops.length) return;
    this.recomputeUnsure();
    const idle = this.opts.idleMs ?? 2_000;
    const n = Math.max(1, this.opts.concurrency ?? 2);
    for (let i = 0; i < n; i++) this.loops.push(this.worker(idle));
  }

  /** Stop the loops and abort in-flight Jev requests (nothing is written for them). */
  async stop() {
    this.stopped = true;
    this.abort.abort();
    this.state = "off";
    if (this.loops.length) await Promise.race([Promise.all(this.loops), sleep(5_000)]);
  }
}
