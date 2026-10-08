import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const CHUNK = 8 * 1024 * 1024;

/**
 * Sampled fingerprint (docs/DECISIONS.md): sha256 over the size plus the first,
 * middle and last 8 MB. Files <= 24 MB are hashed whole. Read only.
 */
export async function fingerprint(file: string, size: number): Promise<string> {
  const h = createHash("sha256");
  h.update(`rtm-fp-v1:${size}\n`);
  const fh = await fs.open(file, "r");
  try {
    const readAt = async (pos: number, len: number) => {
      const buf = Buffer.allocUnsafe(len);
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      h.update(buf.subarray(0, off));
    };
    if (size <= 3 * CHUNK) {
      let pos = 0;
      while (pos < size) {
        const len = Math.min(CHUNK, size - pos);
        await readAt(pos, len);
        pos += len;
      }
    } else {
      await readAt(0, CHUNK);
      await readAt(Math.floor(size / 2 - CHUNK / 2), CHUNK);
      await readAt(size - CHUNK, CHUNK);
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}
