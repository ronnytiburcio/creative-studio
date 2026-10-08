/**
 * Engine catalog for the app (server only): Higgsfield model lists, model schemas, cost quotes and the
 * account balance, plus the Codex sign-in check, read from the CLIs (free calls) and cached. Lists and
 * schemas live in memory and in app_settings (refreshed daily or on demand); quotes and statuses are
 * memory-only and short lived. Generation itself never runs here: the server action only inserts jobs.
 */
import { getDb } from "../db";
import { codexCapabilities } from "./codex";
import { HiggsfieldAdapter, higgsfieldCatalog } from "./higgsfield";
import { mediaCounts, type MediaCounts } from "./rules";
import type { ToolSpec } from "./tools";
import {
  IMAGE_SHORTLIST,
  VIDEO_SHORTLIST,
  type Capabilities,
  type GenInput,
  type ModelListItem,
  type ModelSchema,
  type ParamValue,
} from "./types";

const DAY = 24 * 60 * 60_000;
type Entry = { at: number; value: unknown };

const g = globalThis as unknown as { __rtmGenCache?: Map<string, Entry>; __rtmGenInflight?: Map<string, Promise<unknown>> };
const mem = (g.__rtmGenCache ??= new Map());
const inflight = (g.__rtmGenInflight ??= new Map());

function readSetting(key: string): Entry | null {
  const row = getDb().sqlite.prepare("select value from app_settings where key = ?").get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Entry;
    return typeof parsed?.at === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeSetting(key: string, entry: Entry) {
  getDb()
    .sqlite.prepare("insert into app_settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
    .run(key, JSON.stringify(entry));
}

async function cached<T>(key: string, ttl: number, load: () => Promise<T>, opts: { refresh?: boolean; persist?: boolean } = {}): Promise<T> {
  const now = Date.now();
  if (!opts.refresh) {
    const hit = mem.get(key) ?? (opts.persist ? readSetting(key) : null);
    if (hit && now - hit.at < ttl) {
      mem.set(key, hit);
      return hit.value as T;
    }
  }
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = load()
    .then((value) => {
      const entry = { at: Date.now(), value };
      mem.set(key, entry);
      if (opts.persist) writeSetting(key, entry);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export type ModelKind = "image" | "video";
export type ModelLists = { shortlist: ModelListItem[]; all: ModelListItem[] };

const SHORTLIST: Record<ModelKind, readonly string[]> = { image: IMAGE_SHORTLIST, video: VIDEO_SHORTLIST };

export async function models(kind: ModelKind, refresh = false): Promise<ModelLists> {
  const all = await cached(`gen:hf:models:${kind}`, DAY, () => higgsfieldCatalog.listModels(kind), { refresh, persist: true });
  const byType = new Map(all.map((m) => [m.jobType, m]));
  return {
    shortlist: SHORTLIST[kind].map((jt) => byType.get(jt)).filter((m): m is ModelListItem => Boolean(m)),
    all,
  };
}

/** Schema for a model that is in the live image or video list (never a free-form job type). */
export async function modelSchema(jobType: string, refresh = false): Promise<ModelSchema | null> {
  const known = (await models("image")).all.some((m) => m.jobType === jobType) || (await models("video")).all.some((m) => m.jobType === jobType);
  if (!known) return null;
  return cached(`gen:hf:model:${jobType}`, DAY, () => higgsfieldCatalog.getModel(jobType), { refresh, persist: true });
}

/** Workflow schema (`workflow get`), for the quick tools that run as a workflow (video reframe). Fixed names only. */
export async function workflowSchema(name: "reframe", refresh = false): Promise<ModelSchema> {
  return cached(`gen:hf:workflow:${name}`, DAY, () => higgsfieldCatalog.getWorkflow(name), { refresh, persist: true });
}

/** The schema a quick tool runs against: a model from the live lists, or a workflow. */
export function toolSchema(spec: Pick<ToolSpec, "jobType" | "workflow">): Promise<ModelSchema | null> {
  return spec.workflow ? (spec.jobType === "reframe" ? workflowSchema("reframe") : Promise.resolve(null)) : modelSchema(spec.jobType);
}

/**
 * Cache key for a quote: every param and every slot count, exactly (false, 0 and "" included, keys sorted),
 * so e.g. {generate_audio: false} never shares a key with the model default.
 */
export function quoteKey(model: string, params: Record<string, ParamValue>, counts: Partial<MediaCounts> = {}, variant = "cost"): string {
  const exact = (o: object) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `gen:hf:${variant}:${model}:${exact(params)}:${exact(counts)}`;
}

/** Credits for one quick-tool job (tool models take no prompt; workflows are quoted from their cost params only). */
export function quoteTool(input: Pick<GenInput, "model" | "references" | "tool">): Promise<number> {
  const tool = input.tool!;
  const counts = tool.workflow ? {} : mediaCounts(input.references.map((r) => ({ role: r.role ?? "image_references" })));
  const key = quoteKey(input.model, tool.quoteParams, counts, tool.workflow ? "toolcost:workflow" : "toolcost");
  return cached(key, 10 * 60_000, () => higgsfieldCatalog.cost(input.model, tool.quoteParams, counts, { prompt: false, workflow: tool.workflow }));
}

/** Credits for one job with these (validated) params and reference slots. */
export function quoteCredits(model: string, params: Record<string, ParamValue>, counts: Partial<MediaCounts> = {}): Promise<number> {
  return cached(quoteKey(model, params, counts), 10 * 60_000, () => higgsfieldCatalog.cost(model, params, counts));
}

/** Signed in? Balance + plan only (the account email is never read out). */
export function higgsfieldStatus(refresh = false): Promise<Capabilities> {
  return cached("gen:hf:status", 30_000, () => new HiggsfieldAdapter().capabilities(), { refresh });
}

/** Codex found and signed in with ChatGPT (never the account itself). */
export function codexStatus(refresh = false): Promise<Capabilities> {
  return cached("gen:codex:status", 60_000, () => codexCapabilities(), { refresh });
}
