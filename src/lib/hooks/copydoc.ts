/**
 * "Import approved copy" (Phase 4 B3): parse a client's `<CODE>-ad-copy-final.md` (read only) into hook lines.
 *
 * Taken: every headline (`**Headline:** x`, Part C `- H1: x`, static slot `**H1:** x`) and the FIRST SENTENCE of every
 * primary (`**Primary:** x`, `**Primary A:** x`, Part C `- P1: x`, FORMAT v3 / static `**P1 (structured):**` with the
 * text on the next line). Descriptions, CTAs, tables, voiceover scripts and code blocks are ignored. The angle slug
 * comes from the nearest heading that names one (`## Angle \`slug\``, `### Angle \`slug\`: ...`, a FORMAT v3 heading
 * that is just the slug, or an ad heading with "angle \`slug\``"). Duplicates inside the doc collapse (normHook), the
 * first one wins and picks up an angle from a later copy when it had none.
 *
 * The folder per client is `clients.folder` (Settings > Clients / the Studio config, slice 1b) under STUDIO_CLIENT_DOCS_DIR;
 * a client without one has no approved copy (Import approved copy is off). Nothing here writes.
 */
import fs from "node:fs";
import path from "node:path";
import { normHook, HOOK_MAX_CHARS } from "./rubric";
import { firstSentence } from "./text";

export type CopyLine = { text: string; kind: "headline" | "primary"; angle: string | null };

export class CopyDocError extends Error {}

const COPY_FILE = /^[A-Za-z0-9]+-ad-copy-final\.md$/;

/** The one `<CODE>-ad-copy-final.md` in the client's folder (`clients.folder`), or a terse CopyDocError. */
export function copyDocPath(dir: string, folder: string | null): string {
  if (!folder || folder.includes("/") || folder === "." || folder === "..") {
    throw new CopyDocError("No approved copy folder is set for this client (Settings > Clients).");
  }
  const base = path.join(dir, folder);
  let files: string[];
  try {
    files = fs.readdirSync(base).filter((f) => COPY_FILE.test(f));
  } catch {
    throw new CopyDocError(`Approved copy not found: the folder "${folder}" is missing.`);
  }
  if (files.length === 0) throw new CopyDocError(`Approved copy not found: no *-ad-copy-final.md in "${folder}".`);
  if (files.length > 1) throw new CopyDocError(`More than one *-ad-copy-final.md in "${folder}".`);
  return path.join(base, files[0]);
}

const EMOJI_LEAD = /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\s]+/u;
const ANNOTATION = /\s*\*\([^)]*\)\*\s*$/;

/** Plain text: markdown emphasis, code ticks, trailing "*(added ..., approved)*" notes and leading emoji removed. */
export function cleanCopy(s: string): string {
  return s
    .replace(ANNOTATION, "")
    .replace(/\*\*|__/g, "")
    .replace(/`/g, "")
    .replace(EMOJI_LEAD, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The angle slug a heading names, or null. */
export function headingSlug(heading: string): string | null {
  const named = /angle\s+`([^`]+)`/i.exec(heading);
  if (named) return named[1].trim();
  // "### 01 `spring-refresh-offer` (offer, LEARN_MORE)": a backticked slug anywhere in the heading.
  const ticked = /`([a-z0-9][a-z0-9_]*(?:[-_][a-z0-9_]+)+)`/i.exec(heading);
  if (ticked) return ticked[1];
  const bare = /^`?([a-z0-9][a-z0-9_]*(?:[-_][a-z0-9_]+)+)`?$/i.exec(heading.trim());
  return bare ? bare[1] : null;
}

const HEADLINE_PATTERNS = [/^\*\*Headline:\*\*\s*(.+)$/i, /^[-*]\s*H\d+\s*:\s*(.+)$/, /^\*\*H\d+\s*:\*\*\s*(.+)$/];
const PRIMARY_PATTERNS = [
  /^\*\*Primary(?:\s+[A-Z0-9])?:\*\*\s*(.*)$/i,
  /^[-*]\s*P\d+\s*:\s*(.+)$/,
  /^\*\*P\d+(?:\s*\([^)]*\))?\s*:\*\*\s*(.*)$/,
];
/** A line that starts another field: a pending primary never takes it as its text. */
const FIELD_START = /^(?:\*\*[^*]+:\*\*|[-*]\s*[HPD]\d+\s*:|Description:|Headlines|Primaries|CTA:|#)/i;

export function parseCopyDoc(md: string): CopyLine[] {
  const out: CopyLine[] = [];
  const index = new Map<string, number>();
  let angle: string | null = null;
  let fence = false;
  let pendingPrimary = false;

  const push = (raw: string, kind: CopyLine["kind"]) => {
    let text = cleanCopy(raw);
    if (kind === "primary") text = firstSentence(text);
    if (!text || text.length > HOOK_MAX_CHARS) return;
    const norm = normHook(text);
    if (!norm) return;
    const at = index.get(norm);
    if (at != null) {
      if (!out[at].angle && angle) out[at].angle = angle;
      return;
    }
    index.set(norm, out.length);
    out.push({ text, kind, angle });
  };

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      angle = headingSlug(heading[1]);
      pendingPrimary = false;
      continue;
    }
    if (!line) continue;
    if (pendingPrimary) {
      pendingPrimary = false;
      if (!FIELD_START.test(line) && !line.startsWith("|") && !line.startsWith(">")) {
        push(line, "primary");
        continue;
      }
    }
    if (line.startsWith("|") || line.startsWith(">")) continue;
    const h = HEADLINE_PATTERNS.map((re) => re.exec(line)).find(Boolean);
    if (h) {
      push(h[1], "headline");
      continue;
    }
    const p = PRIMARY_PATTERNS.map((re) => re.exec(line)).find(Boolean);
    if (p) {
      if (p[1].trim()) push(p[1], "primary");
      else pendingPrimary = true;
    }
  }
  return out;
}
