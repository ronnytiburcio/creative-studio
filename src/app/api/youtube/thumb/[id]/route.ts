/**
 * GET/HEAD /api/youtube/thumb/:videoId: a Short's YouTube thumbnail the worker cached (STUDIO_CACHE/youtube/<id>.<ext>,
 * served through resolveCacheFile). The browser never loads i.ytimg.com directly.
 */
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { resolveCacheFile } from "@/lib/fsguard";
import { mimeFor } from "@/lib/media";
import { shortThumbPath } from "@/lib/youtube/store";
import { errorResponse, serveFile } from "@/lib/serve";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{6,20}$/) });

async function handle(req: Request, ctx: RouteContext<"/api/youtube/thumb/[id]">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return errorResponse(400, "bad request");
  const file = resolveCacheFile(getConfig().cacheDir, shortThumbPath(getDb().sqlite, parsed.data.id));
  if (!file) return errorResponse(404, "not found");
  return serveFile(req, file, mimeFor(file), { immutable: true });
}

export async function GET(req: Request, ctx: RouteContext<"/api/youtube/thumb/[id]">) {
  return handle(req, ctx);
}

export async function HEAD(req: Request, ctx: RouteContext<"/api/youtube/thumb/[id]">) {
  return handle(req, ctx);
}
