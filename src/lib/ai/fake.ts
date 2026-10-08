/**
 * Fakes for `npm run smoke` only (never registered in the worker). Tests never call Ollama, whisper or Jev.
 * - FakeVision records every call, answers with a fixed text (labels run together on purpose, to exercise
 *   normalizeDescription) and can pretend Ollama is off or that one request failed.
 * - FakeJev is a Jev transport: it answers /systemone with whatever `respond` says per question (defaults: the first
 *   option, score 2, noul 0.1), can pretend there is no key, that Jev is overloaded or refuses the request, and records
 *   every request body so the test can check what was asked (and that the key never appears anywhere).
 */
import { VisionUnavailableError, type VisionAdapter, type VisionResult, type VisionStatus } from "./ollama";
import type { JevHttpResponse, JevQuestion, JevTransport } from "./jev";

export class FakeVision implements VisionAdapter {
  readonly calls: { images: Buffer[]; prompt: string }[] = [];
  mode: "ok" | "unavailable" | "fail" = "ok";

  constructor(readonly model = "fake-vision:1") {}

  async describe(images: Buffer[], prompt: string): Promise<VisionResult> {
    this.calls.push({ images, prompt });
    if (this.mode === "unavailable") throw new VisionUnavailableError("Ollama is not reachable (fake)");
    if (this.mode === "fail") throw new Error("fake vision failure");
    const kind = prompt.includes("contact sheet") ? "video" : "image";
    return {
      text: `**Shows:** a zebrawood ${kind} scene with a pendant lamp. People: none\nText: "none"`,
      ms: 5,
      model: this.model,
    };
  }

  async status(): Promise<VisionStatus> {
    const up = this.mode !== "unavailable";
    return { reachable: up, modelPresent: up, version: "fake", error: up ? null : "Ollama is not reachable (fake)" };
  }
}

type FakeJevAnswer = { choice?: string; probabilities?: Record<string, number>; confidence?: number; score?: number; noul?: number };

export class FakeJev implements JevTransport {
  readonly requests: { state: unknown; model: string; questions: Record<string, JevQuestion> }[] = [];
  mode: "ok" | "overloaded" | "unauthorized" | "invalid" = "ok";
  hasKey = true;
  /** Model id the fake says answered. */
  answeredBy = "jev-1.13.0";
  /** Per question id (and the request's state): what to answer. undefined = the default for its type. */
  respond: (id: string, q: JevQuestion, state: unknown) => FakeJevAnswer | undefined = () => undefined;
  /** Runs while the request is "in flight" (after it was recorded, before the answer), e.g. to change the DB mid-call. */
  duringCall: ((state: unknown) => void | Promise<void>) | null = null;

  keyPresent() {
    return this.hasKey;
  }

  async get(): Promise<JevHttpResponse> {
    return { status: 200, retryAfter: null, body: { models: [{ name: "jev-latest" }, { name: "jev-preview" }] } };
  }

  async post(_path: "/systemone", body: unknown): Promise<JevHttpResponse> {
    const req = body as { state: unknown; model: string; questions: Record<string, JevQuestion> };
    this.requests.push(req);
    if (this.mode === "overloaded") return { status: 529, retryAfter: "0", body: { error: "overloaded" } };
    if (this.mode === "unauthorized") return { status: 401, retryAfter: null, body: { error: "bad key" } };
    if (this.mode === "invalid") return { status: 422, retryAfter: null, body: { detail: "questions.x.criteria: too many options" } };
    await this.duringCall?.(req.state);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const r = this.respond(id, q, req.state) ?? {};
      if (q.type === "choice") {
        const options = Object.keys(q.criteria);
        const choice = r.choice ?? options[0];
        const probabilities = r.probabilities ?? Object.fromEntries(options.map((o) => [o, o === choice ? 0.97 : 0.03 / (options.length - 1)]));
        answers[id] = { type: "choice", choice, probabilities, confidence: r.confidence ?? 0.95 };
      } else if (q.type === "score") {
        answers[id] = { type: "score", score: r.score ?? 2, legend: {}, probabilities: r.probabilities ?? { [String(Math.round(r.score ?? 2))]: 1 }, confidence: r.confidence ?? 0.9 };
      } else {
        answers[id] = { type: "noul", noul: r.noul ?? 0.1 };
      }
    }
    const inputTokens = Math.ceil(JSON.stringify(req).length / 4);
    return { status: 200, retryAfter: null, body: { model: this.answeredBy, answers, usage: { input_tokens: inputTokens, output_tokens: 20 } } };
  }
}
