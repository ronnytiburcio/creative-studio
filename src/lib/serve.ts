/** Stream a local file as a Response with HTTP Range support (server only). */
import fs from "node:fs";
import { Readable } from "node:stream";

export function errorResponse(status: number, message: string) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.includes(",") ? null : "invalid"; // multi-range: ignore, serve full
  const [, a, b] = m;
  if (a === "" && b === "") return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "invalid";
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

export async function serveFile(
  req: Request,
  file: string,
  contentType: string,
  opts: { immutable?: boolean; filename?: string } = {},
): Promise<Response> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return errorResponse(404, "not found");
  }
  if (!st.isFile()) return errorResponse(404, "not found");
  const size = st.size;
  const etag = `"${size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const headers = new Headers({
    "content-type": contentType,
    "accept-ranges": "bytes",
    etag,
    "last-modified": st.mtime.toUTCString(),
    "cache-control": opts.immutable ? "private, max-age=31536000, immutable" : "private, no-cache",
    "x-content-type-options": "nosniff",
  });
  if (opts.filename) headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(opts.filename)}`);

  const rangeHeader = req.headers.get("range");
  if (!rangeHeader && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  let start = 0;
  let end = size - 1;
  let status = 200;
  if (rangeHeader && size > 0) {
    const r = parseRange(rangeHeader, size);
    if (r === "invalid") {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (r) {
      ({ start, end } = r);
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${size}`);
    }
  }
  headers.set("content-length", String(size === 0 ? 0 : end - start + 1));
  if (req.method === "HEAD" || size === 0) return new Response(null, { status, headers });
  const node = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
  const body = Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}
