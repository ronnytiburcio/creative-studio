import path from "node:path";
import type { NextConfig } from "next";

/**
 * `STUDIO_DIST_DIR` (optional): the build folder instead of `.next`, for a second build that must never touch the main
 * one (the demo, `npm run demo`, builds into `.demo-data/next`). Relative to the project, inside it, plain segments
 * only (no `.` / `..`, no absolute path); anything else fails the build / start. Unset = `.next` (a real install never
 * sets it). tsconfig.json lists `.demo-data/next/types/**` in "include" on purpose, so Next has nothing to add to it
 * when the demo builds.
 */
function distDir(): string {
  const raw = process.env.STUDIO_DIST_DIR?.trim();
  if (!raw) return ".next";
  const ok =
    !path.isAbsolute(raw) &&
    /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(raw) &&
    raw.split("/").every((s) => s !== "." && s !== "..") &&
    path.normalize(raw) === raw;
  if (!ok) throw new Error("STUDIO_DIST_DIR must be a relative folder inside the project (plain segments, no . or ..), like .demo-data/next");
  return raw;
}

const nextConfig: NextConfig = {
  distDir: distDir(),
  // Native / heavy server deps stay out of the bundle.
  serverExternalPackages: ["better-sqlite3", "sharp", "chokidar", "fsevents"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  poweredByHeader: false,
  devIndicators: false,
  // `next dev` must not write its agent rules into AGENTS.md / CLAUDE.md: they are tracked files (AGENTS.md links to
  // CLAUDE.md in the public tree), so a first `npm run dev` would leave the checkout modified.
  agentRules: false,
};

export default nextConfig;
