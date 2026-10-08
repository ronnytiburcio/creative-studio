/**
 * Meta + GHL sync queue (worker only, Phase 5 A5). Reads (never writes) every ad account in `ad_accounts`: once a day at
 * 18:00 America/New_York (also right after a worker start when an account's last good sync is older than the latest
 * 18:00), and whenever the app asks for a Refresh (`meta:sync_requested_at`, runs every account, even while paused).
 * Pause (`meta:paused`) holds the daily run. The drive's state does not matter.
 *
 * Accounts run one at a time (friendly to Meta's rate limits); a failure is recorded on that account (terse, scrubbed)
 * and the next one still runs; its last good numbers stay. A Meta rate limit longer than 5 minutes (MetaThrottledError)
 * ends the run and the queue waits until Meta's regain time. No jobs rows: the Jobs page shows one summary row plus the
 * accounts with errors. Every request lands in `meta_calls` (path only), pruned after 30 days.
 *
 * Phase 5 slice 2: after each good account sync the ads' copy becomes hooks (src/lib/meta/hooks.ts syncMetaHooks: links
 * to equal hooks, new `meta` hooks, the matched video's hook), and once over every account when the queue starts (so ads
 * synced before this existed, or a crash between the two steps, catch up). SQL only; the hook scoring queue scores them.
 *
 * Phase 5 slice 3: right after the hooks step the test order suggestions are refreshed (src/lib/meta/test-order.ts
 * syncTestOrders: one row per batch of new ads; the start-up pass is the backfill). SQL only; never touches the owner's
 * answers. Flags and the calibration report are computed at read time (nothing to do here).
 */
import type Database from "better-sqlite3";
import { META_RUN_FINISHED_KEY, META_RUN_STARTED_KEY, metaPaused, metaRequestPending, scheduledAccountIds } from "../lib/meta/store";
import { listAccounts, syncAccount, type AccountRow, type SyncDeps, type SyncResult } from "../lib/meta/sync";
import { syncMetaHooks, type MetaHookStats } from "../lib/meta/hooks";
import { syncTestOrders, type TestOrderStats } from "../lib/meta/test-order";
import { MetaThrottledError } from "../lib/meta/graph";
import { setSetting } from "../lib/ai/state";

export type MetaSyncState = "running" | "idle" | "paused" | "waiting" | "off";

export type MetaSyncQueueOptions = Omit<SyncDeps, "isStopped" | "now" | "log"> & {
  log: (...args: unknown[]) => void;
  isStopped: () => boolean;
  now?: () => number;
  /** How often the loop checks for a request or the schedule (default 15 s). */
  pollMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CALL_LOG_DAYS = 30;

export class MetaSyncQueue {
  state: MetaSyncState = "idle";
  /** The account being synced (label), for the heartbeat. */
  current: string | null = null;
  note: string | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private waitUntil = 0;

  constructor(
    private readonly sql: Database.Database,
    private readonly opts: MetaSyncQueueOptions,
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private isStopped() {
    return this.stopped || this.opts.isStopped();
  }

  private deps(): SyncDeps {
    return { ...this.opts, now: () => this.now(), log: this.opts.log, isStopped: () => this.isStopped() };
  }

  /** What is due now: every account on a Refresh, else the accounts the daily schedule wants (none while paused). */
  due(): { reason: "request" | "schedule"; accounts: AccountRow[] } | null {
    if (this.waitUntil > this.now()) return null;
    const all = listAccounts(this.sql);
    if (metaRequestPending(this.sql)) return { reason: "request", accounts: all };
    if (metaPaused(this.sql)) return null;
    const ids = new Set(scheduledAccountIds(this.sql, this.now()));
    const accounts = all.filter((a) => ids.has(a.id));
    return accounts.length ? { reason: "schedule", accounts } : null;
  }

  /** One run over the given accounts. Never throws. */
  async runOnce(reason: "request" | "schedule", accounts: AccountRow[]): Promise<Map<string, SyncResult>> {
    const results = new Map<string, SyncResult>();
    const started = this.now();
    setSetting(this.sql, META_RUN_STARTED_KEY, String(started));
    this.sql.prepare("delete from meta_calls where at < ?").run(started - CALL_LOG_DAYS * 86_400_000);
    this.state = "running";
    this.note = null;
    this.opts.log(`meta: ${reason} sync of ${accounts.length} account(s)`);
    for (const acc of accounts) {
      if (this.isStopped()) break;
      this.current = acc.label.split(" / ")[0];
      try {
        const r = await syncAccount(this.sql, acc, this.deps());
        results.set(acc.code, r);
        this.opts.log(
          r.ok
            ? `meta: ${acc.code}: ${r.campaigns} campaign(s), ${r.inScope}/${r.ads} ads in scope, ${r.metricRows} daily rows, ` +
                `leads ${r.leads ?? "n/a"} (${r.attributed ?? 0} tied to an ad${r.leadsComplete === false ? `, partial GHL read: ${r.leadsKept} stored kept` : r.leadsRemoved ? `, ${r.leadsRemoved} removed` : ""}), match ${JSON.stringify(r.match)}, ${r.thumbs} thumbs`
            : `meta: ${acc.code}: error: ${r.error}`,
        );
        if (r.ok) {
          this.metaHooks([acc.id]);
          this.testOrders([acc.id]);
        }
      } catch (e) {
        if (e instanceof MetaThrottledError) {
          this.waitUntil = e.resumeAt;
          this.note = e.message;
          this.opts.log(`meta: ${e.message}`);
          break;
        }
        this.opts.log(`meta: ${acc.code}: unexpected error`, (e as Error).message);
      }
    }
    this.current = null;
    setSetting(this.sql, META_RUN_FINISHED_KEY, String(this.now()));
    this.state = this.waitUntil > this.now() ? "waiting" : metaPaused(this.sql) ? "paused" : "idle";
    return results;
  }

  /** Run whatever is due now (smoke tests, one-shot runs). */
  async drain(): Promise<Map<string, SyncResult> | null> {
    const d = this.due();
    return d ? this.runOnce(d.reason, d.accounts) : null;
  }

  private async worker(pollMs: number) {
    while (!this.isStopped()) {
      let d: ReturnType<MetaSyncQueue["due"]> = null;
      try {
        d = this.due();
      } catch (e) {
        this.opts.log("meta: due check error", (e as Error).message);
      }
      if (d) {
        await this.runOnce(d.reason, d.accounts);
        continue;
      }
      if (this.waitUntil > this.now()) this.state = "waiting";
      else {
        this.state = metaPaused(this.sql) ? "paused" : "idle";
        if (this.waitUntil) {
          this.waitUntil = 0;
          this.note = null;
        }
      }
      await sleep(pollMs);
    }
  }

  /** Meta copy -> hooks for these accounts (all when omitted). SQL only; never throws. */
  metaHooks(accountIds?: number[]): MetaHookStats | null {
    try {
      const s = syncMetaHooks(this.sql, { accountIds, clientsDir: this.opts.clientsDir, universalRegistry: this.opts.universalRegistry ?? null, now: this.now() });
      if (s.created || s.newLinks || s.videoHooksCreated) {
        this.opts.log(
          `meta: hooks: ${s.created} new meta hooks, ${s.linkedExisting} existing hooks linked, ${s.newLinks} links (${s.videoLinks} video), ` +
            `${s.videoHooksCreated} video hooks made for matched ad videos`,
        );
      }
      return s;
    } catch (e) {
      this.opts.log("meta: hooks error", (e as Error).message);
      return null;
    }
  }

  /** Test order suggestions for these accounts (all when omitted). SQL only; never throws. */
  testOrders(accountIds?: number[]): TestOrderStats | null {
    try {
      const s = syncTestOrders(this.sql, { accountIds, now: this.now() });
      if (s.inserted || s.updated) this.opts.log(`meta: test order: ${s.inserted} new batch(es), ${s.updated} updated over ${s.accounts} account(s)`);
      return s;
    } catch (e) {
      this.opts.log("meta: test order error", (e as Error).message);
      return null;
    }
  }

  start() {
    if (this.loop) return;
    this.metaHooks();
    this.testOrders();
    this.loop = this.worker(this.opts.pollMs ?? 15_000);
  }

  async stop() {
    this.stopped = true;
    this.state = "off";
    if (this.loop) await Promise.race([this.loop, sleep(5_000)]);
  }
}
