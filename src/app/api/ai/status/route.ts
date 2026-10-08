/**
 * GET /api/ai/status: can Describe and Classify run right now? Ollama reachable + model pulled, whisper binary + model
 * found (free local checks), and Jev: key present + `GET /v1/models` answers (free, no tokens). Never returns the key.
 */
import { NextResponse } from "next/server";
import { getConfig, readTypesafeKey } from "@/lib/config";
import { ollamaStatus } from "@/lib/ai/ollama";
import { whisperStatus } from "@/lib/ai/whisper";
import { HttpJevTransport, jevStatus } from "@/lib/ai/jev";

export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = getConfig();
  const ollama = await ollamaStatus(cfg.ollamaUrl, cfg.visionModel);
  const whisper = whisperStatus(cfg);
  const jev = await jevStatus(new HttpJevTransport(() => readTypesafeKey(cfg)), cfg.jevModel);
  return NextResponse.json(
    {
      ollama: { ...ollama, url: cfg.ollamaUrl, model: cfg.visionModel },
      whisper: { binFound: whisper.binFound, modelFound: whisper.modelFound, bin: whisper.bin, model: whisper.model },
      jev,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
