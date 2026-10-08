/**
 * GET/HEAD /api/brand/:file: the install's own brand mark (src/lib/brand.ts; one of BRAND_FILES from STUDIO_BRAND_DIR).
 * The param is zod-validated against the four names; the file is found through fsguard's resolveInside and read with
 * O_RDONLY | O_NOFOLLOW + fstat (a regular file of at most 256 KB that looks like an SVG). 404 (terse) when the install
 * has none (the UI then uses the generic marks in public/brand). Served as an image only: nosniff and a CSP that runs
 * no script.
 */
import { getConfig } from "@/lib/config";
import { brandFileSchema, readOwnBrandSvg } from "@/lib/brand";
import { errorResponse } from "@/lib/serve";

export const dynamic = "force-dynamic";

async function handle(req: Request, ctx: RouteContext<"/api/brand/[file]">) {
  const parsed = brandFileSchema.safeParse((await ctx.params).file);
  if (!parsed.success) return errorResponse(404, "not found");
  const svg = readOwnBrandSvg(getConfig(), parsed.data);
  if (svg == null) return errorResponse(404, "not found");
  return new Response(req.method === "HEAD" ? null : svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "cache-control": "no-cache",
    },
  });
}

export async function GET(req: Request, ctx: RouteContext<"/api/brand/[file]">) {
  return handle(req, ctx);
}

export async function HEAD(req: Request, ctx: RouteContext<"/api/brand/[file]">) {
  return handle(req, ctx);
}
