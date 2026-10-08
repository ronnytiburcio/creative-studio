/**
 * GET/HEAD /api/meta/thumb/:id (ads.id): the Meta thumbnail the worker cached for an ad with no local file
 * (STUDIO_CACHE/meta/<ad id>.<ext>, served through resolveCacheFile). The browser never loads Meta's CDN directly.
 */
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { resolveCacheFile } from "@/lib/fsguard";
import { mimeFor } from "@/lib/media";
import { adThumbPath } from "@/lib/meta/running";
import { errorResponse, serveFile } from "@/lib/serve";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().regex(/^\d{1,12}$/).transform(Number) });

async function handle(req: Request, ctx: RouteContext<"/api/meta/thumb/[id]">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return errorResponse(400, "bad request");
  const file = resolveCacheFile(getConfig().cacheDir, adThumbPath(getDb().sqlite, parsed.data.id));
  if (!file) return errorResponse(404, "not found");
  return serveFile(req, file, mimeFor(file), { immutable: true });
}

export async function GET(req: Request, ctx: RouteContext<"/api/meta/thumb/[id]">) {
  return handle(req, ctx);
}

export async function HEAD(req: Request, ctx: RouteContext<"/api/meta/thumb/[id]">) {
  return handle(req, ctx);
}
