/**
 * GoHighLevel lead reader (worker only, Phase 5). The widget's query (widget_ads_stats.py ghl_leads, in META_ENV_FILE's folder), and
 * nothing else: `POST https://services.leadconnectorhq.com/contacts/search` with `source eq <source>` (the client's
 * `ghl_source`, default `<code>-fb-ad`; Creative Studio 1b), paged with `searchAfter`. That search is a read even though it is a POST; the transport refuses any other method or URL.
 *
 * - The ONLY reader of `GHL_API_KEY` / `GHL_LOCATION_ID` (META_ENV_FILE for the clients; Lane C's env file once the owner adds
 *   them there). Read fresh per request, sent in the Authorization header / body only, never logged or stored.
 * - Same headers as the widget: Bearer key, `Version: 2021-07-28`, JSON, a real User-Agent (Cloudflare 1010 blocks
 *   default ones).
 * - Each contact is reduced at once to what Studio keeps: the contact id, dateAdded, the test flag (`test record` /
 *   `claude-test-lead` tags) and the first-touch / last-touch attribution keys (`attributionSource` /
 *   `lastAttributionSource`: `utmContent` = the ad name, `mediumId` = the GHL form). No names, phones, emails,
 *   addresses, notes or any other contact detail leave this module.
 *
 * Tests inject a stub transport; they never reach the network.
 */
import { IDENTITY } from "../config";
import { GHL_LOCATION_RE, GHL_SOURCE_RE } from "../studio-config";
import fs from "node:fs";
import { parseEnvText } from "../envfile";
import { scrubSecrets } from "../scrub";
import type { MetaIdentity } from "./graph";

export const GHL_SEARCH_URL = "https://services.leadconnectorhq.com/contacts/search";
export const GHL_VERSION = "2021-07-28";
export const GHL_TEST_TAGS = new Set(["test record", "claude-test-lead"]);
const PAGE = 100;
const MAX_PAGES = 50;
// The install identity's slug (the original install keeps its own, which outside services already see).
const USER_AGENT = `${IDENTITY.slug}/1.0 (read only)`;

export type GhlRequest = { method: "POST"; url: string; headers: Record<string, string>; body: string; timeoutMs: number; signal?: AbortSignal };
export type GhlResponse = { status: number; body: string };
export type GhlTransport = (req: GhlRequest) => Promise<GhlResponse>;

export type GhlCallLog = { identity: MetaIdentity; kind: "ghl"; path: string; status: number | null; ms: number; error: string | null };

export class GhlError extends Error {
  constructor(message: string, readonly transient = false) {
    super(message);
    this.name = "GhlError";
  }
}

/** The contacts search, and only that URL, as a POST. Refused before a socket opens otherwise. */
export const httpGhlTransport: GhlTransport = async (req) => {
  if (req.method !== "POST" || req.url !== GHL_SEARCH_URL) throw new GhlError("Studio only runs the GHL contacts search.");
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const res = await fetch(GHL_SEARCH_URL, { method: "POST", headers: req.headers, body: req.body, signal, redirect: "error" });
  return { status: res.status, body: await res.text() };
};

export type GhlTouch = { utmContent: string | null; mediumId: string | null };

/** The fixed "not configured" text (never the env file path: error text is stored and shown). */
export const GHL_MISSING = "GHL_API_KEY or GHL_LOCATION_ID missing from the Meta env file.";

/** A contacts search: the leads, and whether the read reached the end of GHL's list (see searchLeads). */
export type GhlSearch = { leads: GhlLead[]; complete: boolean };

/** One ad lead as Studio keeps it (no contact details). */
export type GhlLead = {
  contactId: string;
  dateAdded: number | null;
  test: boolean;
  first: GhlTouch;
  last: GhlTouch;
};

function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnvText(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function touch(src: unknown): GhlTouch {
  const o = src && typeof src === "object" ? (src as Record<string, unknown>) : {};
  return { utmContent: str(o.utmContent), mediumId: str(o.mediumId, 100) };
}

/** Reduce a GHL contact to a GhlLead (everything else dropped here). */
export function toLead(c: Record<string, unknown>): GhlLead | null {
  const contactId = str(c.id, 100);
  if (!contactId) return null;
  const tags = Array.isArray(c.tags) ? (c.tags as unknown[]).map((t) => String(t).toLowerCase().trim()) : [];
  const stamp = typeof c.dateAdded === "string" ? Date.parse(c.dateAdded) : NaN;
  return {
    contactId,
    dateAdded: Number.isFinite(stamp) ? stamp : null,
    test: tags.some((t) => GHL_TEST_TAGS.has(t)),
    first: touch(c.attributionSource),
    last: touch(c.lastAttributionSource),
  };
}

const scrubKey = (text: string, key: string | null) => scrubSecrets(text, [key], "<key>");

export type GhlClientOptions = {
  identity: MetaIdentity;
  envFile: string;
  transport?: GhlTransport;
  onCall?: (c: GhlCallLog) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  retryDelays?: number[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class GhlClient {
  private readonly transport: GhlTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: GhlClientOptions) {
    this.transport = opts.transport ?? httpGhlTransport;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** The key from the env file; the location = the lane's override (Settings / config), else GHL_LOCATION_ID from the env file. */
  private creds(locationOverride: string | null = null): { key: string; location: string } | null {
    const env = readEnvFile(this.opts.envFile);
    const key = env.GHL_API_KEY?.trim();
    const location = locationOverride?.trim() || env.GHL_LOCATION_ID?.trim();
    return key && location ? { key, location } : null;
  }

  /** The GHL key (and a location: the override, else the env file's) are there (presence only). */
  configured(locationOverride: string | null = null): boolean {
    return this.creds(locationOverride) !== null;
  }

  /**
   * Every contact with `source = <source>` (test-tagged ones included, flagged; the caller never counts them).
   * `complete` says whether the read reached the end of GHL's list: `seen >= total` when GHL gives a numeric total, else
   * (no total) an empty or short page (< the page size) ends it, so paging continues past full pages. MAX_PAGES reached,
   * a full page without a `searchAfter` cursor, or a total not reached = an incomplete read: the caller must then only
   * upsert (never mirror-delete stored leads it did not see).
   * Throws GhlError (terse, key scrubbed) when GHL refuses or stays unreachable after the retries.
   */
  async searchLeads(source: string, locationOverride: string | null = null): Promise<GhlSearch> {
    if (!GHL_SOURCE_RE.test(source)) throw new GhlError("Bad GHL source.");
    if (locationOverride != null && !GHL_LOCATION_RE.test(locationOverride)) throw new GhlError("Bad GHL location.");
    const leads: GhlLead[] = [];
    let after: unknown = null;
    let seen = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const creds = this.creds(locationOverride);
      if (!creds) throw new GhlError(GHL_MISSING);
      const payload: Record<string, unknown> = {
        locationId: creds.location,
        pageLimit: PAGE,
        filters: [{ field: "source", operator: "eq", value: source }],
      };
      if (after) payload.searchAfter = after;
      const data = await this.post(creds.key, JSON.stringify(payload));
      const batch = Array.isArray(data.contacts) ? (data.contacts as Record<string, unknown>[]) : [];
      seen += batch.length;
      for (const c of batch) {
        const lead = toLead(c);
        if (lead) leads.push(lead);
      }
      const total = typeof data.total === "number" && Number.isFinite(data.total) ? data.total : null;
      if (total != null && seen >= total) return { leads, complete: true };
      if (!batch.length) return { leads, complete: total == null };
      if (total == null && batch.length < PAGE) return { leads, complete: true };
      after = batch[batch.length - 1]?.searchAfter ?? null;
      if (!after) return { leads, complete: false };
    }
    return { leads, complete: false };
  }

  private async post(key: string, body: string): Promise<Record<string, unknown>> {
    const delays = this.opts.retryDelays ?? [1_500, 3_000];
    let last: GhlError | null = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await this.sleep(delays[attempt - 1]);
      const started = this.now();
      let res: GhlResponse;
      try {
        res = await this.transport({
          method: "POST",
          url: GHL_SEARCH_URL,
          headers: {
            Authorization: `Bearer ${key}`,
            Version: GHL_VERSION,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          body,
          timeoutMs: this.opts.timeoutMs ?? 30_000,
          signal: this.opts.signal,
        });
      } catch (e) {
        if (e instanceof GhlError && !e.transient) throw e;
        last = new GhlError(scrubKey(`GHL network error: ${(e as Error).message}`, key).slice(0, 300), true);
        this.report(null, started, last.message);
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        try {
          const json = JSON.parse(res.body) as Record<string, unknown>;
          this.report(res.status, started, null);
          return json;
        } catch {
          last = new GhlError("GHL answered with something that is not JSON.");
          this.report(res.status, started, last.message);
          throw last;
        }
      }
      let detail = "";
      try {
        const j = JSON.parse(res.body) as { message?: unknown };
        detail = typeof j.message === "string" ? j.message : Array.isArray(j.message) ? j.message.join("; ") : "";
      } catch {
        detail = "";
      }
      const transient = res.status === 429 || res.status >= 500;
      last = new GhlError(scrubKey(`GHL ${res.status}${detail ? `: ${detail}` : ""}`, key).slice(0, 300), transient);
      this.report(res.status, started, last.message);
      if (!transient) throw last; // GHL refused it outright: retrying will not help (the widget's rule)
    }
    throw last ?? new GhlError("GHL request failed.");
  }

  private report(status: number | null, started: number, error: string | null) {
    try {
      this.opts.onCall?.({ identity: this.opts.identity, kind: "ghl", path: "contacts/search", status, ms: Math.max(0, this.now() - started), error });
    } catch {
      /* logging never breaks a read */
    }
  }
}
