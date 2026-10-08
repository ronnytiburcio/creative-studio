/** Ignore patterns + tag rules matching (server only). */
import picomatch from "picomatch";

export type IgnoreMatcher = (relPath: string, isDir?: boolean) => boolean;

/**
 * Folder names often contain ( ) [ ] etc. Only * ** ? are wildcards here; every other
 * glob metacharacter is escaped so "renders/Acme (Acme Renovation)/**" matches literally.
 */
export function literalGlob(glob: string): string {
  return glob.replace(/[()[\]{}!+@]/g, (ch) => "\\" + ch);
}

function compile(glob: string): picomatch.Matcher {
  return picomatch(literalGlob(glob), { dot: true, nocase: true });
}

/**
 * gitignore-lite, see IGNORE_SEED docs in db/seed.ts.
 * relPath is relative to the root, "/" separated.
 */
export function buildIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const dirSeg: picomatch.Matcher[] = [];
  const anySeg: picomatch.Matcher[] = [];
  const full: picomatch.Matcher[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    if (p.endsWith("/")) {
      dirSeg.push(compile(p.slice(0, -1)));
    } else if (p.includes("/")) {
      full.push(compile(p.replace(/^\//, "")));
    } else {
      anySeg.push(compile(p));
    }
  }
  return (relPath: string, isDir = false) => {
    if (!relPath) return false;
    const segs = relPath.split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const segIsDir = i < segs.length - 1 || isDir;
      if (segIsDir && dirSeg.some((m) => m(seg))) return true;
      if (anySeg.some((m) => m(seg))) return true;
    }
    return full.some((m) => m(relPath));
  };
}

export type TagRule = { id: number; pathGlob: string; clientCodes: string[] };

export type TagMatcher = (relPath: string, absPath: string) => string[];

export function buildTagMatcher(rules: TagRule[]): TagMatcher {
  const compiled = rules.map((r) => {
    const abs = r.pathGlob.startsWith("/");
    return { abs, m: compile(r.pathGlob), codes: r.clientCodes };
  });
  return (relPath, absPath) => {
    const out = new Set<string>();
    for (const c of compiled) {
      if (c.m(c.abs ? absPath : relPath)) c.codes.forEach((code) => out.add(code));
    }
    return [...out];
  };
}

export function parseCodes(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
