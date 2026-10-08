/**
 * Classify queue (worker only, Phase 3 slice 2): Jev files every described image and video: its category, clients
 * (Lane B assets without a folder or manual tag), energy, hookable (video), brand safe, visual format (static ads)
 * and the Three P's (ads). One Jev call per asset (src/lib/ai/classify.ts has the questions, state and gate).
 *
 * Same pull design as the describe queue (no jobs rows, nothing to recover after a restart: nothing is written until
 * Jev answered). Due = a current description whose last classify used another CLASSIFY_VERSION / Jev model, never
 * ran, or predates the description. Order: "Classify again" requests, then files indexed since classify was introduced
 * (new), then the backfill, newest first. Concurrency 2. Pause key `classify:paused` (separate from describe's);
 * while paused only requests run.
 *
 * Waits (no asset touched, no error flood): no key, key refused, Jev down / overloaded after the adapter's retries
 * (backoff 5 s doubling to 5 min), daily cap reached (until the next America/New_York midnight). A bad request (422)
 * or an answer that does not fit is stored on that asset and skipped until Classify again / Retry.
 *
 * Writes: the classifications row, the asset's filterable fields (a manual class is never overwritten), the described_at
 * it read at claim time (classify_described_at: a description written during the call makes the asset due again) and
 * the jev client rows (replaced; folder and manual rows are never touched and always win; none once the owner decided).
 */
import type Database from "better-sqlite3";
import { jevFailureKind, type JevAdapter, type JevCapReachedError } from "../lib/ai/jev";
import { CLASSIFY_VERSION, isCategory, needsReview, type CategoryId, type StoredAnswer } from "../lib/ai/classes";
import { buildQuestions, buildState, evaluate, type ClassifyInput, type ClientInfo, type CorrectionExample } from "../lib/ai/classify";
import { DESCRIBE_PROMPT_VERSION } from "../lib/ai/describe";
import { profile } from "../lib/profile";
import { folderOf, rootLabel } from "../lib/media";
import {
  CLASSIFY_DESCRIBED,
  CLASSIFY_STALE,
  DESCRIBABLE,
  classifyPaused,
  classifySince,
  classifyThreshold,
} from "../lib/ai/state";

type DueRow = {
  id: number;
  kind: "image" | "video";
  section: "rtm" | "fkbpros" | "fkb";
  filename: string;
  rel_path: string;
  root_path: string;
  orientation: string | null;
  duration_s: number | null;
  description: string;
  spoken_open: string | null;
  described_at: number | null;
  clients_decided_at: number | null;
  generated: number;
  asset_class: string | null;
  class_source: string | null;
  classify_requested_at: number | null;
};

export type ClassifyState = "running" | "idle" | "paused" | "waiting" | "off";
export type ClassifyOutcome = "classified" | "error" | "unavailable" | "capped" | "interrupted";

export type ClassifyQueueOptions = {
  jev: JevAdapter;
  /** The describe model + prompt version a description must come from. */
  visionModel: string;
  describeVersion?: number;
  /** Defaults to CLASSIFY_VERSION (the smoke test bumps it). */
  version?: number;
  /** whisper available: videos wait for their spoken opening (else they go without). */
  spokenReady?: () => boolean;
  /** Studio Generated files: the prompt that made them (sidecar or job row). */
  generationPrompt?: (assetId: number) => string | null;
  concurrency?: number;
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  idleMs?: number;
  backoffMs?: { min: number; max: number };
  now?: () => number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ClassifyQueue {
  state: ClassifyState = "idle";
  note: string | null = null;
  readonly model: string;
  readonly version: number;
  readonly running = new Map<number, string>();
  private readonly since: number;
  private stopped = false;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];
  private backoff = 0;
  private waitUntil = 0;

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: ClassifyQueueOptions,
  ) {
    this.model = opts.jev.model;
    this.version = opts.version ?? CLASSIFY_VERSION;
    this.since = classifySince(sql);
  }

  get current(): string | null {
    return this.running.size ? [...this.running.values()].join("  |  ") : null;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private isStopped() {
    return this.stopped || this.opts.isStopped();
  }

  // ------------------------------------------------------------------ claim

  /** Next asset to classify (skipping ones in flight), or null. While paused only "Classify again" requests. */
  claimNext(): DueRow | null {
    const paused = classifyPaused(this.sql);
    return (
      (this.sql
        .prepare(
          `select a.id, a.kind, s.key as section, a.filename, a.rel_path, r.path as root_path, a.orientation, a.duration_s,
                  a.description, a.spoken_open, a.described_at, a.clients_decided_at, a.generated, a.asset_class,
                  a.class_source, a.classify_requested_at
             from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
            where r.enabled = 1 and ${DESCRIBABLE} and a.description is not null
              and a.id not in (select value from json_each(@inflight))
              and (a.kind = 'image' or a.spoken_open is not null or @spoken = 0 or a.proxy_path is null or a.describe_error is not null)
              and (a.classify_requested_at is not null
                   or (@paused = 0 and a.classify_error is null and ${CLASSIFY_DESCRIBED} and ${CLASSIFY_STALE}))
            order by a.classify_requested_at is null, a.classify_requested_at, a.indexed_at >= @since desc, a.mtime desc, a.id desc
            limit 1`,
        )
        .get({
          inflight: JSON.stringify([...this.running.keys()]),
          spoken: (this.opts.spokenReady?.() ?? true) ? 1 : 0,
          paused: paused ? 1 : 0,
          model: this.model,
          version: this.version,
          vmodel: this.opts.visionModel,
          vversion: this.opts.describeVersion ?? DESCRIBE_PROMPT_VERSION,
          since: this.since,
        }) as DueRow | undefined) ?? null
    );
  }

  // ----------------------------------------------------------------- inputs

  private clients(): ClientInfo[] {
    return (
      this.sql.prepare("select c.code, c.name, c.classify_hint from clients c join sections s on s.id = c.section_id where s.key = 'fkbpros' order by c.sort, c.name").all() as {
        code: string;
        name: string;
        classify_hint: string | null;
      }[]
    ).map((c) => ({ code: c.code, name: c.name, hint: c.classify_hint?.trim() || c.name }));
  }

  private fixedClients(assetId: number): string[] {
    return this.sql
      .prepare(
        `select c.name from asset_clients ac join clients c on c.id = ac.client_id
          where ac.asset_id = ? and ac.source in ('folder', 'manual') order by c.sort`,
      )
      .pluck()
      .all(assetId) as string[];
  }

  /** Up to 12 of the owner's most recent category / client corrections (one per asset + question), as short examples. */
  examples(excludeAssetId: number): CorrectionExample[] {
    const rows = this.sql
      .prepare(
        `select k.question, k.ronny_answer, a.filename, a.rel_path, r.path as root_path, a.description
           from ai_corrections k join assets a on a.id = k.asset_id join roots r on r.id = a.root_id
          where k.question in ('asset_class', 'clients') and k.asset_id != ? and a.description is not null
            and k.id = (select max(k2.id) from ai_corrections k2 where k2.asset_id = k.asset_id and k2.question = k.question)
          order by k.id desc limit 12`,
      )
      .all(excludeAssetId) as { question: string; ronny_answer: string; filename: string; rel_path: string; root_path: string; description: string }[];
    const names = new Map(this.clients().map((c) => [c.code, c.name]));
    const out: CorrectionExample[] = [];
    for (const r of rows) {
      const base = { file: r.filename, folder: folderOf(r.rel_path, r.root_path), description: r.description };
      let answer: unknown;
      try {
        answer = JSON.parse(r.ronny_answer);
      } catch {
        continue;
      }
      if (r.question === "asset_class" && isCategory(answer)) out.push({ question: "asset_class", ...base, category: answer });
      if (r.question === "clients" && Array.isArray(answer)) {
        const list = answer.filter((c): c is string => typeof c === "string").map((c) => names.get(c) ?? c);
        out.push({ question: "clients", ...base, clients: list.length ? list : [profile().classify.sharedLabel] });
      }
    }
    return out;
  }

  private prior(assetId: number): Record<string, StoredAnswer> | null {
    const raw = this.sql.prepare("select answers from classifications where asset_id = ?").pluck().get(assetId) as string | undefined;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, StoredAnswer>;
    } catch {
      return null;
    }
  }

  inputFor(row: DueRow): ClassifyInput {
    let generationPrompt: string | null = null;
    if (row.generated && this.opts.generationPrompt) {
      try {
        generationPrompt = this.opts.generationPrompt(row.id);
      } catch {
        generationPrompt = null; // unreadable sidecar: classify without it
      }
    }
    return {
      id: row.id,
      kind: row.kind,
      section: row.section,
      filename: row.filename,
      relPath: row.rel_path,
      rootLabel: rootLabel(row.root_path),
      orientation: row.orientation,
      durationS: row.duration_s,
      description: row.description,
      spokenOpen: row.spoken_open,
      generationPrompt,
      fixedClients: this.fixedClients(row.id),
      clientsDecided: row.clients_decided_at != null,
      manualClass: row.class_source === "manual" && isCategory(row.asset_class) ? (row.asset_class as CategoryId) : null,
    };
  }

  // -------------------------------------------------------------------- run

  /** Classify one asset. Never throws. */
  async runOne(row: DueRow): Promise<{ outcome: ClassifyOutcome; message?: string; resumeAt?: number }> {
    try {
      const input = this.inputFor(row);
      const clients = this.clients();
      const examples = this.examples(row.id);
      const questions = buildQuestions(input, clients, examples);
      const state = buildState(input, examples);
      const res = await this.opts.jev.ask(questions, state, "classify", { assetId: row.id, signal: this.abort.signal });
      if (this.isStopped()) return { outcome: "interrupted" };
      const ev = evaluate(res.full, {
        input,
        clientCodes: clients.map((c) => c.code),
        threshold: classifyThreshold(this.sql),
        prior: this.prior(row.id),
      });
      const now = this.now();
      this.sql.transaction(() => {
        this.sql
          .prepare(
            `insert into classifications (asset_id, model, version, answers, unsure, call_id, created_at) values (?, ?, ?, ?, ?, ?, ?)
             on conflict (asset_id) do update set model = excluded.model, version = excluded.version, answers = excluded.answers,
               unsure = excluded.unsure, call_id = excluded.call_id, created_at = excluded.created_at`,
          )
          .run(row.id, res.model, this.version, JSON.stringify(ev.answers), JSON.stringify(ev.unsure), res.callId, now);
        this.sql
          .prepare(
            `update assets set
               asset_class = case when class_source = 'manual' then asset_class else @cls end,
               class_confidence = case when class_source = 'manual' then class_confidence else @conf end,
               class_source = case when class_source = 'manual' then 'manual' else 'jev' end,
               energy = @energy, needs_review = @review, classified_at = @now, classify_described_at = @describedAt,
               classify_version = @version,
               classify_model = @model, classify_error = null,
               classify_requested_at = case when classify_requested_at is @req then null else classify_requested_at end
             where id = @id`,
          )
          .run({
            id: row.id,
            cls: ev.jevClass,
            conf: ev.classConfidence,
            energy: ev.energy,
            review: needsReview(ev.unsure) ? 1 : 0,
            now,
            describedAt: row.described_at,
            version: this.version,
            model: this.model,
            req: row.classify_requested_at,
          });
        // Jev rows are replaced. A folder / manual tag or the owner's decision (also one made while Jev was answering)
        // wins: then none.
        this.sql.prepare("delete from asset_clients where asset_id = ? and source = 'jev'").run(row.id);
        const fixed = this.sql.prepare("select count(*) from asset_clients where asset_id = ? and source in ('folder', 'manual')").pluck().get(row.id) as number;
        const decided = this.sql.prepare("select clients_decided_at is not null from assets where id = ?").pluck().get(row.id) === 1;
        if (ev.applyClients?.length && fixed === 0 && !decided) {
          const add = this.sql.prepare(
            `insert into asset_clients (asset_id, client_id, source, created_at)
             select ?, id, 'jev', ? from clients where code = ? on conflict (asset_id, client_id) do nothing`,
          );
          for (const code of ev.applyClients) add.run(row.id, now, code);
        }
      })();
      this.opts.log(
        `classify: ${row.rel_path}: ${ev.jevClass ?? row.asset_class ?? "?"}${ev.classConfidence != null ? ` (${ev.classConfidence.toFixed(2)})` : ""}` +
          `${ev.unsure.length ? `, unsure: ${ev.unsure.join(", ")}` : ""} · ${res.inputTokens} tokens`,
      );
      return { outcome: "classified" };
    } catch (e) {
      const failure = jevFailureKind(e);
      if (failure === "cap") {
        const cap = e as JevCapReachedError;
        return { outcome: "capped", message: cap.message, resumeAt: cap.resumeAt };
      }
      if (failure) {
        if (this.isStopped()) return { outcome: "interrupted" };
        return { outcome: "unavailable", message: (e as Error).message };
      }
      if (this.isStopped()) return { outcome: "interrupted" };
      const message = ((e as Error).message || "Classify failed").slice(0, 500);
      this.opts.log(`classify error: ${row.rel_path}: ${message}`);
      this.sql
        .prepare(
          `update assets set classify_error = ?,
             classify_requested_at = case when classify_requested_at is ? then null else classify_requested_at end
           where id = ?`,
        )
        .run(message, row.classify_requested_at, row.id);
      return { outcome: "error", message };
    }
  }

  // ------------------------------------------------------------------ loops

  private noteWait(outcome: "unavailable" | "capped", message: string, resumeAt?: number) {
    if (outcome === "capped") {
      this.waitUntil = resumeAt ?? this.now() + 3_600_000;
      this.backoff = 0;
      this.note = "Daily Jev cap reached. Classify resumes after midnight.";
    } else {
      const { min, max } = this.opts.backoffMs ?? { min: 5_000, max: 300_000 };
      this.backoff = this.backoff ? Math.min(this.backoff * 2, max) : min;
      this.waitUntil = this.now() + this.backoff;
      this.note = message;
    }
    this.state = "waiting";
    this.opts.log(`classify: ${this.note}; waiting until ${new Date(this.waitUntil).toISOString()}`);
  }

  /** Work until nothing is due (smoke tests, one-shot runs). Stops at the first wait (key, Jev down, cap). */
  async drain(): Promise<Record<ClassifyOutcome, number>> {
    const counts: Record<ClassifyOutcome, number> = { classified: 0, error: 0, unavailable: 0, capped: 0, interrupted: 0 };
    for (;;) {
      if (this.isStopped()) return counts;
      if (this.waitUntil > this.now()) return counts;
      const row = this.claimNext();
      if (!row) return counts;
      this.running.set(row.id, row.rel_path);
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
      const wait = this.waitUntil - this.now();
      if (wait > 0) {
        this.state = "waiting";
        await sleep(Math.min(wait, idle));
        continue;
      }
      let row: DueRow | null = null;
      try {
        row = this.claimNext();
      } catch (e) {
        this.opts.log("classify claim error", (e as Error).message);
      }
      if (!row) {
        if (!this.running.size) {
          this.state = classifyPaused(this.sql) ? "paused" : "idle";
          if (this.waitUntil && this.waitUntil <= this.now()) this.note = null;
        }
        await sleep(idle);
        continue;
      }
      this.running.set(row.id, row.rel_path);
      this.state = "running";
      const { outcome, message, resumeAt } = await this.runOne(row);
      this.running.delete(row.id);
      if (outcome === "unavailable" || outcome === "capped") this.noteWait(outcome, message ?? "Jev is not available", resumeAt);
      else if (outcome !== "interrupted") {
        if (this.backoff) this.opts.log("classify: Jev is back");
        this.backoff = 0;
        this.note = null;
      }
    }
  }

  start() {
    if (this.loops.length) return;
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
