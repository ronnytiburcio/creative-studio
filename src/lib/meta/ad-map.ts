/**
 * What a new PAUSED ad's copy is prefilled from (Phase 6 slice 3, E2; server only, read only):
 *  - the client's approved copy doc (`<CODE>-ad-copy-final.md`, the Phase 4 folder rule in copydoc.ts): its angle blocks
 *    (Part C `## Angle \`slug\``: `- H1:` / `- P1:` / `Description:`), later sections of the same slug replacing the
 *    fields they carry (the FORMAT v3 `## slug` sections replace the primaries, as the doc says), static slot blocks
 *    (`### Angle \`static_x\``: `**H1:**` / `**P1 (structured):**` + lines / `**D1:**`) and one-line `**Headlines:** a | b`;
 *  - the client's `video_script_map.json` (`<code>/` in META_ENV_FILE's folder, the file the apply executor builds from): its
 *    `angles` blocks (the fallback when the doc has no block for the angle), `forbidden_terms`, `landing_url` and the
 *    `ads` rows (n, ad name, angle, stage, avatar concept) for the concept / ps|obj prefill and the next ad number.
 * Nothing here writes; neither file is ever edited by Studio.
 */
import fs from "node:fs";
import path from "node:path";
import { cleanCopy, copyDocPath, headingSlug } from "../hooks/copydoc";
import { profile } from "../profile";

export type AngleBlock = { headlines: string[]; primaries: string[]; description: string | null; stage: "ps" | "obj" | null };

export type MapAdRow = { n: number | null; adName: string | null; angleKey: string | null; stage: "ps" | "obj" | null; concept: string | null };

export type ClientAdMap = {
  forbiddenTerms: string[];
  landingUrl: string | null;
  angles: Map<string, AngleBlock>;
  rows: MapAdRow[];
};

const MAP_MAX_BYTES = 4 * 1024 * 1024;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => x != null) : []);
const stageOf = (v: unknown): "ps" | "obj" | null => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "ps" || s === "obj" ? s : null;
};
const numOf = (v: unknown): number | null => {
  const t = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^\d{1,3}$/.test(t) ? Number(t) : null;
};

/** The client's ad map (read only), or null when missing / unreadable / not an object. */
export function readClientAdMap(clientsDir: string, code: string): ClientAdMap | null {
  if (!/^[a-z0-9]{2,32}$/.test(code)) return null;
  const file = path.join(clientsDir, code, "video_script_map.json");
  let data: Record<string, unknown>;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAP_MAX_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const angles = new Map<string, AngleBlock>();
  const rawAngles = data.angles && typeof data.angles === "object" && !Array.isArray(data.angles) ? (data.angles as Record<string, unknown>) : {};
  for (const [slug, raw] of Object.entries(rawAngles)) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    angles.set(slug, { headlines: strList(a.headlines), primaries: strList(a.primaries), description: str(a.description), stage: stageOf(a.stage) });
  }
  const rows = (Array.isArray(data.ads) ? data.ads : [])
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => ({
      n: numOf(r.n) ?? numOf(r.ad),
      adName: str(r.ad_name),
      angleKey: str(r.angle_key) ?? str(r.angle),
      stage: stageOf(r.stage),
      concept: str(r.avatar_concept),
    }));
  return { forbiddenTerms: strList(data.forbidden_terms), landingUrl: str(data.landing_url), angles, rows };
}

/** `<prefix>-<code>-<concept>-<ps|obj>-<n>` (the profile's `ads.clientPrefix`; none = `<code>-...`) -> its parts (null for legacy names). */
export function parseFpcName(name: string, code: string): { concept: string; stage: "ps" | "obj"; n: number } | null {
  const prefix = profile().ads.clientPrefix;
  const lead = prefix ? `${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-` : "";
  const m = new RegExp(`^${lead}${code}-(.+)-(ps|obj)-(\\d{1,3})$`, "i").exec(name.trim());
  return m ? { concept: m[1].toLowerCase(), stage: m[2].toLowerCase() as "ps" | "obj", n: Number(m[3]) } : null;
}

// ------------------------------------------------------------------------------------------------ copy doc blocks

type Partial = { headlines: string[]; primaries: string[]; description: string | null };

const H_LINE = [/^[-*]\s*H\d+\s*:\s*(.+)$/, /^\*\*H\d+\s*:\*\*\s*(.+)$/, /^\*\*Headline:\*\*\s*(.+)$/i];
const H_MULTI = /^\*\*Headlines?:\*\*\s*(.+)$/i;
const P_LINE = [/^[-*]\s*P\d+\s*:\s*(.*)$/, /^\*\*P\d+(?:\s*\([^)]*\))?\s*:\*\*\s*(.*)$/, /^\*\*Primary(?:\s+[A-Z0-9])?:\*\*\s*(.*)$/i];
const D_LINE = [/^Description:\s*(.+)$/i, /^\*\*Description:\*\*\s*(.+)$/i, /^\*\*D\d+\s*:\*\*\s*(.+)$/, /^[-*]\s*D\d*\s*:\s*(.+)$/];
/** A line that starts another field (or a table / quote / rule): a multi-line primary stops before it. */
const STOP = /^(?:\*\*[^*]+:\*\*|[-*]\s*[HPD]\d+\s*:|Description:|Headlines\b|Primaries\b|CTA:|#|\||>|---|\*\*\*)/i;
const ANNOTATION = /\s*\*\([^)]*\)\*\s*$/;

/** A primary's text as written (emoji kept, markdown emphasis / ticks / trailing notes removed, double spacing kept). */
function cleanPrimary(lines: string[]): string {
  return lines
    .map((l) => l.replace(ANNOTATION, "").replace(/\*\*|__/g, "").replace(/`/g, "").replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Angle blocks of an approved copy doc: slug -> headlines / primaries / description. A later section of the same slug
 * replaces each field it carries (FORMAT v3's primaries replace Part C's; a block repeated in a refresh section wins).
 */
export function parseAngleBlocks(md: string): Map<string, AngleBlock> {
  const blocks = new Map<string, AngleBlock>();
  let slug: string | null = null;
  let cur: Partial = { headlines: [], primaries: [], description: null };
  let fence = false;
  let primary: string[] | null = null;

  const flushPrimary = () => {
    if (primary) {
      const t = cleanPrimary(primary);
      if (t) cur.primaries.push(t);
    }
    primary = null;
  };
  const flushSection = () => {
    flushPrimary();
    if (slug) {
      const prev = blocks.get(slug) ?? { headlines: [], primaries: [], description: null, stage: null };
      blocks.set(slug, {
        headlines: cur.headlines.length ? cur.headlines : prev.headlines,
        primaries: cur.primaries.length ? cur.primaries : prev.primaries,
        description: cur.description ?? prev.description,
        stage: prev.stage,
      });
    }
    cur = { headlines: [], primaries: [], description: null };
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushSection();
      slug = headingSlug(heading[1]);
      continue;
    }
    if (!slug) continue;
    if (primary) {
      if (!line) {
        primary.push("");
        continue;
      }
      if (!STOP.test(line)) {
        primary.push(raw.trim());
        continue;
      }
      flushPrimary();
    }
    if (!line) continue;
    const hm = H_MULTI.exec(line);
    if (hm && hm[1].includes("|")) {
      for (const part of hm[1].split("|")) {
        const t = cleanCopy(part);
        if (t) cur.headlines.push(t);
      }
      continue;
    }
    const h = H_LINE.map((re) => re.exec(line)).find(Boolean);
    if (h) {
      const t = cleanCopy(h[1]);
      if (t) cur.headlines.push(t);
      continue;
    }
    const p = P_LINE.map((re) => re.exec(line)).find(Boolean);
    if (p) {
      if (p[1].trim()) {
        const t = cleanPrimary([p[1]]);
        if (t) cur.primaries.push(t);
      } else {
        primary = [];
      }
      continue;
    }
    const d = D_LINE.map((re) => re.exec(line)).find(Boolean);
    if (d) {
      const t = cleanCopy(d[1]);
      if (t) cur.description = t;
    }
  }
  flushSection();
  for (const [k, b] of blocks) if (!b.headlines.length && !b.primaries.length && !b.description) blocks.delete(k);
  return blocks;
}

/** The angle blocks of the client's approved copy doc (its `clients.folder`; read only), or an empty map when there is none. */
export function readCopyDocBlocks(clientDocsDir: string, folder: string | null): Map<string, AngleBlock> {
  try {
    const file = copyDocPath(clientDocsDir, folder);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAP_MAX_BYTES) return new Map();
    return parseAngleBlocks(fs.readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}
