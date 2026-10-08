/**
 * GET/HEAD /api/media/:id/:variant  (variant = thumb | sheet | proxy | original)
 * Derived files come only from STUDIO_CACHE (resolveCacheFile); originals only via
 * originalFileFor (enabled root, drive mounted, realpath inside a root).
 */
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { resolveCacheFile } from "@/lib/fsguard";
import { mimeFor } from "@/lib/media";
import { originalFileFor } from "@/lib/originals";
import { errorResponse, serveFile } from "@/lib/serve";
import { MEDIA_VARIANTS, VARIANT_COLUMN } from "@/lib/variants";

export const dynamic = "force-dynamic";

const Params = z.object({
  id: z.string().regex(/^\d{1,12}$/).transform(Number),
  variant: z.enum(MEDIA_VARIANTS),
});

async function handle(req: Request, ctx: RouteContext<"/api/media/[id]/[variant]">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return errorResponse(400, "bad request");
  const { id, variant } = parsed.data;

  if (variant === "original") {
    const original = originalFileFor(id);
    if (!original.ok) return errorResponse(original.status, original.error);
    return serveFile(req, original.file, mimeFor(original.file), { filename: original.filename });
  }

  const column = VARIANT_COLUMN[variant];
  const row = getDb().sqlite.prepare(`select ${column} as rel from assets where id = ? and ignored = 0`).get(id) as
    | { rel: string | null }
    | undefined;
  if (!row) return errorResponse(404, "not found");
  const file = resolveCacheFile(getConfig().cacheDir, row.rel);
  if (!file) return errorResponse(404, "not derived yet");
  const immutable = new URL(req.url).searchParams.has("v");
  return serveFile(req, file, mimeFor(file), { immutable });
}

export async function GET(req: Request, ctx: RouteContext<"/api/media/[id]/[variant]">) {
  return handle(req, ctx);
}

export async function HEAD(req: Request, ctx: RouteContext<"/api/media/[id]/[variant]">) {
  return handle(req, ctx);
}
