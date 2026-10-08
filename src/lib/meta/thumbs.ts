/**
 * Meta ad thumbnails (worker only, Phase 5 B3): an ad with no matched local file gets its Meta thumbnail downloaded ONCE
 * into STUDIO_CACHE/meta/<ad id>.<ext>, so the browser never hotlinks Meta's CDN. The download is https-only to Meta's
 * CDN hosts, size-capped while streaming (5 MB), named by its bytes (JPEG / PNG / WebP / GIF, anything else refused),
 * written to a temp file then renamed, and the target is checked to stay inside the cache (resolveInside).
 * The fetcher is injectable (the smoke test stubs it).
 */
import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../fsguard";

export const THUMB_DIR = "meta";
export const THUMB_MAX_BYTES = 5 * 1024 * 1024;

export type ThumbFetch = (
  url: string,
  opts: { maxBytes: number; timeoutMs: number; allowed?: (url: string) => boolean },
) => Promise<{ status: number; bytes: Buffer }>;

const HOST_OK = /(^|\.)(fbcdn\.net|facebook\.com|cdninstagram\.com)$/i;

/** Meta CDN over https only. */
export function thumbUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && HOST_OK.test(u.hostname);
  } catch {
    return false;
  }
}

/** Most redirects a thumbnail download follows (each hop's URL is checked against the allowlist first). */
export const THUMB_MAX_HOPS = 3;

/**
 * Default fetcher: stream with a size cap. Redirects are followed by hand (`redirect: "manual"`), at most THUMB_MAX_HOPS,
 * and every hop's target must pass `allowed` (https + the host allowlist) BEFORE it is requested, so a redirect can
 * never send the request anywhere else.
 */
export const httpThumbFetch: ThumbFetch = async (url, { maxBytes, timeoutMs, allowed = thumbUrlAllowed }) => {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  let res: Response | null = null;
  for (let hop = 0; ; hop++) {
    if (!allowed(current)) throw new Error("thumbnail redirected off the allowed CDN");
    res = await fetch(current, { signal, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("location");
    await res.body?.cancel();
    if (!loc) return { status: res.status, bytes: Buffer.alloc(0) };
    if (hop >= THUMB_MAX_HOPS) throw new Error("thumbnail redirected too many times");
    current = new URL(loc, current).toString();
  }
  if (!res.ok || !res.body) return { status: res.status, bytes: Buffer.alloc(0) };
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("thumbnail larger than 5 MB");
    }
    chunks.push(Buffer.from(value));
  }
  return { status: res.status, bytes: Buffer.concat(chunks) };
};

/** Image type by magic bytes, or null. */
export function sniffImage(b: Buffer): "jpg" | "png" | "webp" | "gif" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii"))) return "gif";
  return null;
}

/**
 * Download one thumbnail into the cache. Returns the cache-relative path (meta/<adId>.<ext>). Throws a terse Error on
 * a refused host, a non-200, an oversize or a non-image body.
 */
export async function cacheThumb(cacheDir: string, metaAdId: string, url: string, fetcher: ThumbFetch = httpThumbFetch): Promise<string> {
  if (!/^\d{1,30}$/.test(metaAdId)) throw new Error("bad ad id");
  return cacheRemoteImage(cacheDir, { dir: THUMB_DIR, name: metaAdId, url, allowed: thumbUrlAllowed, fetcher, what: "Meta's CDN" });
}

/**
 * The shared download (Meta thumbnails, YouTube thumbnails in Phase 5 slice 4): an https URL the `allowed` check passes,
 * streamed with a 5 MB cap, named by its bytes (JPEG / PNG / WebP / GIF only), temp file + rename, inside the cache.
 */
export async function cacheRemoteImage(
  cacheDir: string,
  o: { dir: string; name: string; url: string; allowed: (url: string) => boolean; fetcher?: ThumbFetch; what: string },
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.name) || !/^[a-z]{1,16}$/.test(o.dir)) throw new Error("bad thumbnail name");
  if (!o.allowed(o.url)) throw new Error(`thumbnail is not on ${o.what}`);
  const { status, bytes } = await (o.fetcher ?? httpThumbFetch)(o.url, { maxBytes: THUMB_MAX_BYTES, timeoutMs: 30_000, allowed: o.allowed });
  if (status !== 200) throw new Error(`thumbnail HTTP ${status}`);
  if (bytes.length > THUMB_MAX_BYTES) throw new Error("thumbnail larger than 5 MB");
  const ext = sniffImage(bytes);
  if (!ext) throw new Error("thumbnail is not an image");
  const dir = path.join(cacheDir, o.dir);
  fs.mkdirSync(dir, { recursive: true });
  if (!resolveInside(dir, [cacheDir])) throw new Error("thumbnail folder escapes the cache");
  const rel = `${o.dir}/${o.name}.${ext}`;
  const target = path.join(cacheDir, rel);
  const tmp = `${target}.${process.pid}.part`;
  fs.writeFileSync(tmp, bytes, { mode: 0o644 });
  fs.renameSync(tmp, target);
  if (!resolveInside(target, [cacheDir])) {
    fs.rmSync(target, { force: true });
    throw new Error("thumbnail path escapes the cache");
  }
  return rel;
}
