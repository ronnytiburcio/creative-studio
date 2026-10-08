/**
 * Fake engine for the smoke test: no network, no credits. Implements GenAdapter exactly like a real
 * engine (start -> id, poll -> running then done, collect -> PNG or MP4 files). Never registered in the worker.
 * `hang` keeps a job running until it is cancelled (Codex-style cancel test); `resumable: false` behaves
 * like a local-process engine on restart.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { AdapterContext, Capabilities, GenAdapter, GenInput, PollResult, PreparedRef } from "./types";

export class FakeAdapter implements GenAdapter {
  readonly id = "fake" as const;
  readonly resumable: boolean;
  /** How many jobs were created (the restart test asserts this stays put). */
  starts = 0;
  polls = 0;
  cancels = 0;
  /** References handed to the last start (the smoke test checks originals vs transcodes). */
  lastRefs: PreparedRef[] = [];
  /** Every start: the request and the prepared references (the smoke test checks tool job types, params, sources). */
  calls: { input: GenInput; refs: PreparedRef[] }[] = [];
  private readonly pending = new Map<string, number>();
  /** Output media per job: a tool's output matches its source (image or video). */
  private readonly kinds = new Map<string, "image" | "video">();
  private readonly cancelled = new Set<string>();

  constructor(private readonly opts: { pollsUntilDone?: number; outputs?: number; hang?: boolean; resumable?: boolean } = {}) {
    this.resumable = opts.resumable ?? true;
  }

  async capabilities(): Promise<Capabilities> {
    return { available: true, credits: 100, plan: "fake" };
  }

  async estimate(input: GenInput): Promise<number> {
    if (input.tool) return input.tool.media === "video" ? (input.tool.workflow ? 25.5 : 1) : 2;
    if (input.kind === "video") return 7.5;
    return input.params.quality === "high" ? 2.75 : 0.25;
  }

  async start(input: GenInput, references: PreparedRef[], ctx: AdapterContext): Promise<string> {
    this.starts++;
    this.lastRefs = references;
    this.calls.push({ input, refs: references });
    const id = `fake-${randomUUID()}`;
    this.pending.set(id, this.opts.pollsUntilDone ?? 1);
    this.kinds.set(id, input.tool?.media ?? (input.kind === "video" ? "video" : "image"));
    ctx.log(`fake create -> ${id} (${references.map((r) => `${r.role}:${path.basename(r.path)}`).join(", ") || "no references"})`);
    return id;
  }

  /** Unknown ids (e.g. a job created before a "restart") finish on their first poll. */
  async poll(externalId: string): Promise<PollResult> {
    this.polls++;
    if (this.cancelled.has(externalId)) return { state: "failed", status: "cancelled", reason: "Cancelled" };
    if (this.opts.hang) return { state: "running", status: "in_progress" };
    const left = this.pending.get(externalId) ?? 0;
    if (left > 0) {
      this.pending.set(externalId, left - 1);
      return { state: "running", status: "in_progress" };
    }
    return { state: "done", status: "completed" };
  }

  async collect(externalId: string, ctx: AdapterContext): Promise<string[]> {
    fs.mkdirSync(ctx.tmpDir, { recursive: true });
    const files: string[] = [];
    // Seed the colour from the id so every output has its own fingerprint.
    const hue = [...externalId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 255, 40);
    for (let i = 1; i <= (this.opts.outputs ?? 1); i++) {
      if (this.kinds.get(externalId) === "video") {
        const file = path.join(ctx.tmpDir, `${i}.mp4`);
        const color = `0x${[hue, 120, 255 - hue].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
        const r = spawnSync(process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg", [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", `color=c=${color}:size=360x640:rate=30:duration=1`,
          "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
        ]);
        if (r.status !== 0) throw new Error("fake video render failed");
        files.push(file);
      } else {
        const file = path.join(ctx.tmpDir, `${i}.png`);
        await sharp({ create: { width: 360, height: 640, channels: 3, background: { r: (hue + i * 40) % 255, g: 120, b: 255 - hue } } })
          .png()
          .toFile(file);
        files.push(file);
      }
    }
    return files;
  }

  async cancel(externalId: string, ctx: AdapterContext): Promise<void> {
    this.cancels++;
    this.cancelled.add(externalId);
    ctx.log(`fake cancel ${externalId}`);
  }
}
