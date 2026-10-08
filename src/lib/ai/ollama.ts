/**
 * Ollama vision adapter (server only). Talks to the local Ollama API on a loopback URL only (validated in config),
 * so media never leaves this Mac. Free: no key, no network beyond 127.0.0.1.
 *
 * Errors are split in two so the describe queue can back off instead of failing the whole library when Ollama
 * is simply off: VisionUnavailableError (not reachable, model not pulled, server busy) vs any other Error
 * (a problem with this one request, recorded on the asset).
 */
import { loopbackUrl } from "../config";

export type VisionResult = { text: string; ms: number; model: string };

export type VisionStatus = { reachable: boolean; modelPresent: boolean; version: string | null; error: string | null };

/** What the describe queue needs from a vision model (the smoke test injects a fake). */
export interface VisionAdapter {
  readonly model: string;
  describe(images: Buffer[], prompt: string, opts?: { signal?: AbortSignal }): Promise<VisionResult>;
  /** Free reachability check (used after a timeout to tell "Ollama hung / off" from "this request failed"). */
  status(): Promise<VisionStatus>;
}

/** Ollama is off, unreachable, busy or the model is not pulled: wait and retry later, never an asset error. */
export class VisionUnavailableError extends Error {}

/** The request ran longer than the timeout (the queue checks status() to tell a hung Ollama from a slow request). */
export class VisionTimeoutError extends Error {}

/** Low temperature and a token cap: descriptions should be literal and short (Jev reads them later). */
const GENERATE_OPTIONS = { temperature: 0.1, num_predict: 400 };
const DEFAULT_TIMEOUT_MS = 180_000;
const STATUS_TIMEOUT_MS = 2_500;

type FetchLike = typeof fetch;

function isConnectionError(e: unknown): boolean {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === "TypeError" && /fetch failed/i.test(err.message ?? "")) return true;
  return ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "UND_ERR_SOCKET"].includes(err?.cause?.code ?? "");
}

export class OllamaVision implements VisionAdapter {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly model: string,
    private readonly opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
  ) {
    const url = loopbackUrl(baseUrl);
    if (!url) throw new Error("Ollama URL must be a loopback address");
    this.baseUrl = url;
  }

  private get fetch(): FetchLike {
    return this.opts.fetchImpl ?? fetch;
  }

  async describe(images: Buffer[], prompt: string, opts: { signal?: AbortSignal } = {}): Promise<VisionResult> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          images: images.map((b) => b.toString("base64")),
          stream: false,
          options: GENERATE_OPTIONS,
        }),
        signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e; // shutdown: the caller knows
      if (timeout.aborted) throw new VisionTimeoutError(`Ollama took longer than ${Math.round(timeoutMs / 1000)} s`);
      if (isConnectionError(e)) throw new VisionUnavailableError(`Ollama is not reachable at ${this.baseUrl}`);
      throw new Error(`Ollama request failed: ${(e as Error).message}`.slice(0, 300));
    }
    let body: { response?: unknown; error?: unknown; model?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON body: handled by the status checks below */
    }
    const apiError = typeof body.error === "string" ? body.error.slice(0, 300) : null;
    if (!res.ok) {
      if (res.status === 404 && /not found/i.test(apiError ?? "")) {
        throw new VisionUnavailableError(`Model ${this.model} is not pulled in Ollama (ollama pull ${this.model})`);
      }
      if (res.status === 503 || res.status === 429) throw new VisionUnavailableError(`Ollama is busy (HTTP ${res.status})`);
      throw new Error(`Ollama error (HTTP ${res.status})${apiError ? `: ${apiError}` : ""}`);
    }
    if (typeof body.response !== "string") throw new Error("Ollama returned no text");
    return { text: body.response, ms: Date.now() - started, model: typeof body.model === "string" ? body.model : this.model };
  }

  status(): Promise<VisionStatus> {
    return ollamaStatus(this.baseUrl, this.model, this.opts.fetchImpl);
  }
}

/** Free check: is Ollama up (`/api/version`) and is the model pulled (`/api/tags`)? Never throws. */
export async function ollamaStatus(baseUrl: string, model: string, fetchImpl: FetchLike = fetch): Promise<VisionStatus> {
  const url = loopbackUrl(baseUrl);
  if (!url) return { reachable: false, modelPresent: false, version: null, error: "Ollama URL must be a loopback address" };
  try {
    const [versionRes, tagsRes] = await Promise.all([
      fetchImpl(`${url}/api/version`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) }),
      fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) }),
    ]);
    const version = versionRes.ok ? ((await versionRes.json()) as { version?: string }).version ?? null : null;
    const tags = tagsRes.ok ? ((await tagsRes.json()) as { models?: { name?: string; model?: string }[] }).models ?? [] : [];
    const names = new Set(tags.flatMap((m) => [m.name, m.model]).filter(Boolean) as string[]);
    const modelPresent = names.has(model) || (!model.includes(":") && names.has(`${model}:latest`));
    return { reachable: versionRes.ok || tagsRes.ok, modelPresent, version, error: null };
  } catch {
    return { reachable: false, modelPresent: false, version: null, error: `Ollama is not reachable at ${url}` };
  }
}
