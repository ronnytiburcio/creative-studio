/**
 * Test order store (Phase 5 slice 3, PHASE-5 G; server only, SQL only). The worker runs `syncTestOrders` after each good
 * account sync and once over every account when its Meta queue starts (the backfill: every batch already on the
 * accounts gets a suggestion; only the latest batch per channel asks the owner to confirm). The rules live in
 * test-order-rules.ts. The owner's answer (`variable` + `confirmed_at`) is never overwritten by a later suggestion, and a
 * batch he answered keeps its stored suggestion too: only unanswered batches are recomputed.
 */
import type Database from "better-sqlite3";
import { normHook } from "../hooks/rubric";
import { channelHref } from "../media";
import { primaryHookLine } from "./hooks";
import { normAdName, readCreative, stripCopy } from "./match";
import { localDate } from "./windows";
import { laneNames } from "../clients-admin";
import {
  classifyBatch,
  effectiveAnswer,
  nextInOrder,
  TEST_ANSWERS,
  TEST_VARIABLES,
  type AdFeatures,
  type AdVerdict,
  type TestAnswer,
  type TestVariable,
} from "./test-order-rules";

type Sql = Database.Database;

/** Batches are days in New York time (the owner's day, like the GHL buckets). */
export const BATCH_TZ = "America/New_York";

type AdRow = { meta_ad_id: string; name: string; created_time: number | null; creative: string | null; matched_asset_id: number | null; angle_key: string | null };

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function linkKey(link: string | null): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return link.trim().toLowerCase() || null;
  }
}

/** The rules' view of an ad row (`angle` = its own angle_key, else the one a same-name earlier ad carries). */
export function adFeatures(ad: AdRow, angle: string | null = ad.angle_key): AdFeatures {
  const c = readCreative(ad.creative);
  const opening = (c?.primaries ?? []).map(primaryHookLine).find(Boolean) ?? (c?.headlines ?? [])[0] ?? null;
  const line = opening ? normHook(opening) || null : null;
  const angleLabel = angle ? angle.replace(/^universal:/, "universal ") : opening ? `the opening "${clip(opening)}"` : "an unknown angle";
  const ids = [...(c?.videoIds ?? []), ...(c?.imageHashes ?? [])];
  const asset = ad.matched_asset_id != null ? `asset:${ad.matched_asset_id}` : null;
  const metaMedia = ids.length ? ids.sort().join(",") : null;
  const texts = [...new Set([...(c?.headlines ?? []), ...(c?.primaries ?? [])].map(normHook).filter(Boolean))].sort().join("|");
  return { id: ad.meta_ad_id, name: ad.name, angle, line, angleLabel, asset, metaMedia, isVideo: c?.isVideo ?? false, texts, ctas: [...(c?.ctas ?? [])].sort(), link: linkKey(c?.link ?? null) };
}

export type TestOrderStats = {
  accounts: number;
  batches: number;
  inserted: number;
  /** Unconfirmed batches whose stored suggestion was rewritten. */
  updated: number;
  /** ... of which the suggested variable itself changed. */
  changed: number;
};

/** Suggest the variable of every batch of these accounts (all when omitted). Idempotent; never touches the owner's answer. */
export function syncTestOrders(sql: Sql, opts: { accountIds?: number[]; now?: number } = {}): TestOrderStats {
  const now = opts.now ?? Date.now();
  const stats: TestOrderStats = { accounts: 0, batches: 0, inserted: 0, updated: 0, changed: 0 };
  const accounts = (sql.prepare("select id from ad_accounts order by sort, id").pluck().all() as number[]).filter((id) => !opts.accountIds || opts.accountIds.includes(id));
  const get = sql.prepare("select suggested, parts, detail, reason, ad_ids, variable from test_orders where account_id = ? and batch_date = ?");
  const insert = sql.prepare(
    `insert into test_orders (account_id, batch_date, ad_ids, n_ads, suggested, parts, detail, reason, variable, confirmed_at, found_at, updated_at)
     values (@account, @date, @adIds, @n, @suggested, @parts, @detail, @reason, null, null, @now, @now)`,
  );
  const update = sql.prepare(
    `update test_orders set ad_ids = @adIds, n_ads = @n, suggested = @suggested, parts = @parts, detail = @detail, reason = @reason, updated_at = @now
      where account_id = @account and batch_date = @date and variable is null`,
  );
  const updateAds = sql.prepare("update test_orders set ad_ids = @adIds, n_ads = @n, updated_at = @now where account_id = @account and batch_date = @date");
  for (const accountId of accounts) {
    stats.accounts++;
    const ads = sql
      .prepare("select meta_ad_id, name, created_time, creative, matched_asset_id, angle_key from ads where account_id = ? and created_time is not null order by created_time, id")
      .all(accountId) as AdRow[];
    // A relaunched copy (same name, "-Copy" or not) whose map row gave no angle keeps its original's.
    const angleByName = new Map<string, string>();
    for (const ad of ads) if (ad.angle_key) angleByName.set(stripCopy(normAdName(ad.name)), ad.angle_key);
    const angleOf = (ad: AdRow) => ad.angle_key ?? angleByName.get(stripCopy(normAdName(ad.name))) ?? null;
    const byDay = new Map<string, AdRow[]>();
    for (const ad of ads) {
      const day = localDate(ad.created_time!, BATCH_TZ);
      byDay.set(day, [...(byDay.get(day) ?? []), ad]);
    }
    const days = [...byDay.keys()].sort();
    const prior: AdFeatures[] = [];
    sql.transaction(() => {
      for (const day of days) {
        const batch = byDay.get(day)!.map((ad) => adFeatures(ad, angleOf(ad)));
        const s = classifyBatch(batch, prior);
        const row = {
          account: accountId,
          date: day,
          adIds: JSON.stringify(batch.map((a) => a.id)),
          n: batch.length,
          suggested: s.suggested,
          parts: JSON.stringify(s.parts),
          detail: JSON.stringify(s.detail),
          reason: s.reason,
          now,
        };
        const have = get.get(accountId, day) as { suggested: string; parts: string; detail: string; reason: string; ad_ids: string; variable: string | null } | undefined;
        if (!have) {
          insert.run(row);
          stats.inserted++;
        } else if (
          have.variable == null &&
          (have.suggested !== row.suggested || have.parts !== row.parts || have.detail !== row.detail || have.reason !== row.reason || have.ad_ids !== row.adIds)
        ) {
          // Only batches the owner has not answered: the confirmed / changed answer (and the suggestion shown) stay as they are.
          stats.updated += update.run(row).changes;
          if (have.suggested !== row.suggested) stats.changed++;
        } else if (have.variable != null && have.ad_ids !== row.adIds) {
          // An answered batch that gained an ad the same day: its ad list follows, the suggestion and answer do not.
          updateAds.run({ account: row.account, date: row.date, adIds: row.adIds, n: row.n, now: row.now });
        }
        stats.batches++;
        prior.push(...batch);
      }
    })();
  }
  return stats;
}

// ------------------------------------------------------------------ reads

export type TestBatch = {
  date: string;
  nAds: number;
  suggested: TestAnswer;
  parts: TestVariable[];
  mixed: boolean;
  detail: AdVerdict[];
  reason: string;
  /** The owner's answer, or null (the suggestion stands, marked "suggested"). */
  variable: TestAnswer | null;
  confirmedAt: number | null;
  answer: TestAnswer;
  first: boolean;
};

type TestRow = {
  batch_date: string;
  n_ads: number;
  suggested: string;
  parts: string;
  detail: string;
  reason: string;
  variable: string | null;
  confirmed_at: number | null;
};

function toBatch(r: TestRow): TestBatch {
  const parse = <T,>(s: string, d: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return d;
    }
  };
  const parts = parse<TestVariable[]>(r.parts, []).filter((p) => (TEST_VARIABLES as readonly string[]).includes(p));
  const detail = parse<AdVerdict[]>(r.detail, []);
  return {
    date: r.batch_date,
    nAds: r.n_ads,
    suggested: effectiveAnswer({ variable: null, suggested: r.suggested }),
    parts,
    mixed: parts.length > 1,
    detail,
    reason: r.reason,
    variable: r.variable && (TEST_ANSWERS as string[]).includes(r.variable) ? (r.variable as TestAnswer) : null,
    confirmedAt: r.confirmed_at,
    answer: effectiveAnswer(r),
    first: detail.length > 0 && detail.every((d) => d.why === "first ads on the account"),
  };
}

export class TestOrderError extends Error {}

/** A channel code (client code, or "fkb") -> its ad account id. */
function accountFor(sql: Sql, code: string): number {
  const id =
    code === "fkb"
      ? (sql.prepare("select acc.id from ad_accounts acc join sections s on s.id = acc.section_id where s.key = 'fkb' order by acc.sort, acc.id limit 1").pluck().get() as number | undefined)
      : (sql.prepare("select acc.id from ad_accounts acc join clients c on c.id = acc.client_id where c.code = ? order by acc.sort, acc.id limit 1").pluck().get(code) as number | undefined);
  if (id == null) throw new TestOrderError("No ad account for this channel.");
  return id;
}

export type ChannelTestOrder = {
  code: string;
  /** Newest first (the Client tab shows the first few). */
  batches: TestBatch[];
  /** The newest batch waits for the owner (not confirmed and not the account's first ads). */
  prompt: TestBatch | null;
  /** The newest batch that tested something (answer is a variable). */
  lastTested: TestBatch | null;
  next: TestVariable;
};

export function channelTestOrder(sql: Sql, code: string, limit = 6): ChannelTestOrder {
  let accountId: number;
  try {
    accountId = accountFor(sql, code);
  } catch {
    return { code, batches: [], prompt: null, lastTested: null, next: "offer" };
  }
  const all = (sql.prepare("select * from test_orders where account_id = ? order by batch_date desc").all(accountId) as TestRow[]).map(toBatch);
  const newest = all[0] ?? null;
  const lastTested = all.find((b) => b.answer !== "none") ?? null;
  return {
    code,
    batches: all.slice(0, limit),
    prompt: newest && newest.confirmedAt == null && !newest.first ? newest : null,
    lastTested,
    next: nextInOrder(lastTested ? (lastTested.answer as TestVariable) : null),
  };
}

export type TestOrderTableRow = {
  code: string;
  label: string;
  href: string;
  lastTested: TestVariable | null;
  /** true = the owner confirmed or set it; false = Studio's suggestion. */
  confirmed: boolean;
  date: string | null;
  nAds: number | null;
  mixed: boolean;
  next: TestVariable;
  /** The newest batch still waits for a Confirm. */
  pending: boolean;
};

/** The Rubric page's table: one row per client (sidebar order), then Lane C. */
export function testOrderTable(sql: Sql): TestOrderTableRow[] {
  const channels = [
    ...(sql
      .prepare("select c.code, c.name from clients c where exists (select 1 from ad_accounts acc where acc.client_id = c.id) order by c.sort, c.name")
      .all() as { code: string; name: string }[]).map((c) => ({ code: c.code, label: c.name.split(" / ")[0], href: `${channelHref("fkbpros", c.code, "client")}#test-order` })),
    { code: "fkb", label: laneNames(sql).fkb, href: `${channelHref("fkb", null, "client")}#test-order` },
  ];
  return channels.map((c) => {
    const t = channelTestOrder(sql, c.code, 1);
    return {
      code: c.code,
      label: c.label,
      href: c.href,
      lastTested: t.lastTested ? (t.lastTested.answer as TestVariable) : null,
      confirmed: t.lastTested?.confirmedAt != null,
      date: t.lastTested?.date ?? null,
      nAds: t.lastTested?.nAds ?? null,
      mixed: t.lastTested ? t.lastTested.variable == null && t.lastTested.mixed : false,
      next: t.next,
      pending: t.prompt != null,
    };
  });
}

// ------------------------------------------------------------------ the owner's answers

/** Confirm the suggestion of a batch (keeps what Studio suggested as the owner's answer). */
export function confirmTestOrder(sql: Sql, code: string, date: string, now = Date.now()): TestAnswer {
  const accountId = accountFor(sql, code);
  const row = sql.prepare("select suggested from test_orders where account_id = ? and batch_date = ?").get(accountId, date) as { suggested: string } | undefined;
  if (!row) throw new TestOrderError("That batch is not there any more. Reload the page.");
  const answer = effectiveAnswer({ variable: null, suggested: row.suggested });
  sql.prepare("update test_orders set variable = ?, confirmed_at = ? where account_id = ? and batch_date = ?").run(answer, now, accountId, date);
  return answer;
}

/** Set a batch's variable by hand (offer / hook / format / copy / none = not a test). */
export function setTestOrder(sql: Sql, code: string, date: string, answer: TestAnswer, now = Date.now()): void {
  if (!TEST_ANSWERS.includes(answer)) throw new TestOrderError("Pick offer, hook, format, copy or not a test.");
  const accountId = accountFor(sql, code);
  const n = sql.prepare("update test_orders set variable = ?, confirmed_at = ? where account_id = ? and batch_date = ?").run(answer, now, accountId, date).changes;
  if (!n) throw new TestOrderError("That batch is not there any more. Reload the page.");
}
