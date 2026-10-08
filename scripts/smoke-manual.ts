/**
 * Creative Studio Phase 3 (the manual) checks: called by scripts/smoke.ts, and runnable alone while writing docs:
 *
 *   npx tsx scripts/smoke-manual.ts          every check, one line per problem (file:line), exit 1 when any fails
 *   npx tsx scripts/smoke-manual.ts d g      only the named checks
 *   npx tsx scripts/smoke-manual.ts --root DIR [a ..]   the same on another tree (e.g. a staged public export)
 *
 *  (a) every CONFIG_KEYS key and the five process-only switches appear in the configuration page
 *  (b) .env.example is byte identical to envTemplate() for the neutral identity
 *  (c) every top-level key of the Studio config schema and of the profile schema appears as `key` in the configuration page
 *  (d) every relative link and image in the docs resolves to a file (and a #anchor to a heading, by GitHub's slug rule)
 *  (e) every `npm run <x>` in the docs is a package.json script
 *  (f) no em / en dash outside code fences and inline code spans, and no " - " / " -- " used as punctuation there (a
 *      line-start "- " list marker, a table cell holding only "-" and a "> - " quoted list stay fine)
 *  (g) every screenshot listed in images/SHOTS.md has its <name>.png in images/, is shown as an image (with alt text)
 *      exactly once, on the page the list names; no <!-- SCREENSHOT ... --> comment is left and no PNG is unlisted
 *  (h) every page of the manual is linked from its README.md
 *
 * Where the docs live: `manual/` in this repo (the export copies it to `docs/` and writes manual/CLAUDE.public.md to the
 * root as CLAUDE.md); a copy without `manual/` (the public repo) is checked at `docs/` + the root CLAUDE.md. Root files
 * (README.md, SECURITY.md, CONTRIBUTING.md, the public CLAUDE.md) link `docs/<page>.md`, which maps to the manual folder.
 * Read only: never writes a file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The five switches that can never go in the Studio config's `env` section: the first four are read from the process
 * environment only, STUDIO_FAKE_UNMOUNTED also from the env file.
 */
export const PROCESS_ONLY_SWITCHES = ["STUDIO_ENV_FILE", "STUDIO_IDENTITY", "STUDIO_ENGINES", "STUDIO_DIST_DIR", "STUDIO_FAKE_UNMOUNTED"];
/** Root files the checks read when they exist. */
const ROOT_DOCS = ["README.md", "SECURITY.md", "CONTRIBUTING.md"];
/** The manual's public CLAUDE.md: it moves to the repo root on export, so its links are read from the root. */
const PUBLIC_CLAUDE = "CLAUDE.public.md";

export type ManualIssue = { file: string; line: number; msg: string };
export type ManualCheck = { id: string; title: string; issues: ManualIssue[] };

type Doc = { rel: string; abs: string; text: string; lines: string[]; rootLinks: boolean; inManual: boolean };

/** `manual/` in this repo, `docs/` in a copy that has no `manual/` (the public repo). */
export function manualDirOf(repo: string): string {
  return fs.existsSync(path.join(repo, "manual")) ? "manual" : "docs";
}

function walkMd(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out.sort();
}

function loadDocs(repo: string): Doc[] {
  const mdir = manualDirOf(repo);
  const docs: Doc[] = [];
  const add = (abs: string, rootLinks: boolean, inManual: boolean) => {
    const text = fs.readFileSync(abs, "utf8");
    docs.push({ rel: path.relative(repo, abs), abs, text, lines: text.split("\n"), rootLinks, inManual });
  };
  for (const f of ROOT_DOCS) if (fs.existsSync(path.join(repo, f))) add(path.join(repo, f), true, false);
  if (mdir === "docs" && fs.existsSync(path.join(repo, "CLAUDE.md"))) add(path.join(repo, "CLAUDE.md"), true, false);
  for (const abs of walkMd(path.join(repo, mdir))) add(abs, path.basename(abs) === PUBLIC_CLAUDE, true);
  return docs;
}

/**
 * Each line with fenced code blocks blanked and inline code spans replaced by spaces (same length, so columns hold).
 * `fence` marks the lines inside a fence (or its ``` lines).
 */
function proseLines(lines: string[]): { text: string; fence: boolean }[] {
  const out: { text: string; fence: boolean }[] = [];
  let open: string | null = null;
  for (const raw of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (open) {
      out.push({ text: "", fence: true });
      if (m && m[1][0] === open[0] && m[1].length >= open.length && raw.trim() === m[1]) open = null;
      continue;
    }
    if (m) {
      open = m[1];
      out.push({ text: "", fence: true });
      continue;
    }
    out.push({ text: stripCodeSpans(raw), fence: false });
  }
  return out;
}

/**
 * A hyphen (or two) standing alone between words, used as sentence punctuation: something other than a space, `|` or
 * `>` before it, something other than a space or `|` after it. A list marker at the line start ("- ", "  - ") has only
 * spaces before it, a table cell holding "-" has `|` around it, and "> - " is a quoted list.
 */
const HYPHEN_PUNCT = /(?<=[^\s|>]) (-{1,2}) (?=[^\s|])/;

/** Inline code spans (one or more backticks, matched by the same count) replaced by spaces. */
function stripCodeSpans(line: string): string {
  return line.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (s) => " ".repeat(s.length));
}

/** GitHub's heading anchor: lower case, punctuation out (letters, digits, spaces, - and _ stay), spaces to -. */
export function githubSlug(heading: string): string {
  const text = heading
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");
}

/** The anchors of a markdown file (ATX headings outside fences; duplicates get -1, -2, ...). */
export function anchorsOf(lines: string[]): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  const prose = proseLines(lines);
  lines.forEach((raw, i) => {
    if (prose[i].fence) return;
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (!m) return;
    const base = githubSlug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  });
  return out;
}

type Link = { target: string; line: number };

/** Inline links and images `[x](target)` / `![x](target)` and reference definitions `[x]: target`, outside code. */
function linksOf(lines: string[]): Link[] {
  const out: Link[] = [];
  proseLines(lines).forEach(({ text }, i) => {
    for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1], line: i + 1 });
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(\s+.*)?$/.exec(text);
    if (def) out.push({ target: def[1], line: i + 1 });
  });
  return out;
}

/** Where a relative link points (absolute path) and its anchor, or null for an outside link. */
function resolveLink(repo: string, mdir: string, doc: Doc, target: string): { file: string; anchor: string | null } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // http(s), mailto, ...
  const hash = target.indexOf("#");
  let p = hash >= 0 ? target.slice(0, hash) : target;
  const anchor = hash >= 0 ? decodeURIComponent(target.slice(hash + 1)) : null;
  if (!p) return { file: doc.abs, anchor };
  p = decodeURIComponent(p.split("?")[0]);
  if (doc.rootLinks) {
    if (p.startsWith("/")) p = p.slice(1);
    if (p === "docs" || p.startsWith("docs/")) p = mdir + p.slice(4);
    return { file: path.join(repo, p), anchor };
  }
  return { file: path.resolve(path.dirname(doc.abs), p), anchor };
}

/** Every check (or the named ones), with each problem's file and line. */
export async function checkManual(repo = process.cwd(), only?: string[]): Promise<ManualCheck[]> {
  const mdir = manualDirOf(repo);
  const docs = loadDocs(repo);
  const want = (id: string) => !only?.length || only.includes(id);
  const checks: ManualCheck[] = [];
  const configPage = path.join(mdir, "configuration.md");
  const configText = fs.existsSync(path.join(repo, configPage)) ? fs.readFileSync(path.join(repo, configPage), "utf8") : null;

  if (want("a")) {
    const issues: ManualIssue[] = [];
    const { CONFIG_KEYS } = await import("../src/lib/config");
    if (configText == null) issues.push({ file: configPage, line: 0, msg: "missing" });
    else
      for (const k of [...CONFIG_KEYS, ...PROCESS_ONLY_SWITCHES])
        if (!new RegExp(`(^|[^A-Z0-9_])${k}([^A-Z0-9_]|$)`).test(configText)) issues.push({ file: configPage, line: 0, msg: `does not mention ${k}` });
    checks.push({ id: "a", title: "every config key and process-only switch is in the configuration page", issues });
  }

  if (want("b")) {
    const issues: ManualIssue[] = [];
    const { envTemplate, resolveIdentity } = await import("../src/lib/config");
    // The neutral identity for this user's home: envTemplate writes its folders as ~/..., so the text does not depend on
    // who runs the check.
    const expected = envTemplate(resolveIdentity(os.homedir(), { STUDIO_IDENTITY: "neutral" }, repo));
    const file = path.join(repo, ".env.example");
    if (!fs.existsSync(file)) issues.push({ file: ".env.example", line: 0, msg: "missing" });
    else {
      const got = fs.readFileSync(file, "utf8");
      if (got !== expected) {
        const a = got.split("\n");
        const b = expected.split("\n");
        const i = a.findIndex((l, n) => l !== b[n]);
        const line = i >= 0 ? i + 1 : Math.min(a.length, b.length) + 1;
        issues.push({ file: ".env.example", line, msg: `differs from envTemplate() (expected ${JSON.stringify(b[line - 1] ?? "<end of file>")})` });
      }
    }
    checks.push({ id: "b", title: ".env.example equals envTemplate() for the neutral identity", issues });
  }

  if (want("c")) {
    const issues: ManualIssue[] = [];
    const { studioFileSchema } = await import("../src/lib/studio-config");
    const { profileSchema } = await import("../src/lib/profile-schema");
    const keys = [...Object.keys(studioFileSchema.shape), ...Object.keys(profileSchema.shape)];
    if (configText == null) issues.push({ file: configPage, line: 0, msg: "missing" });
    else for (const k of new Set(keys)) if (!configText.includes(`\`${k}\``)) issues.push({ file: configPage, line: 0, msg: `does not mention \`${k}\`` });
    checks.push({ id: "c", title: "every Studio config and profile top-level key is in the configuration page", issues });
  }

  if (want("d")) {
    const issues: ManualIssue[] = [];
    const anchorCache = new Map<string, Set<string>>();
    const anchors = (file: string) => {
      if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(fs.readFileSync(file, "utf8").split("\n")));
      return anchorCache.get(file)!;
    };
    for (const doc of docs) {
      for (const l of linksOf(doc.lines)) {
        const r = resolveLink(repo, mdir, doc, l.target);
        if (!r) continue;
        if (!fs.existsSync(r.file)) {
          issues.push({ file: doc.rel, line: l.line, msg: `broken link ${l.target} (no ${path.relative(repo, r.file)})` });
          continue;
        }
        if (r.anchor != null) {
          if (!r.file.endsWith(".md") || fs.statSync(r.file).isDirectory()) continue;
          if (!anchors(r.file).has(r.anchor)) issues.push({ file: doc.rel, line: l.line, msg: `no heading #${r.anchor} in ${path.relative(repo, r.file)}` });
        }
      }
    }
    checks.push({ id: "d", title: "every relative link, image and #anchor in the docs resolves", issues });
  }

  if (want("e")) {
    const issues: ManualIssue[] = [];
    const scripts = Object.keys((JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {});
    for (const doc of docs)
      doc.lines.forEach((line, i) => {
        for (const m of line.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
          if (!scripts.includes(m[1])) issues.push({ file: doc.rel, line: i + 1, msg: `npm run ${m[1]} is not a package.json script` });
        }
      });
    checks.push({ id: "e", title: "every npm run <x> in the docs is a package.json script", issues });
  }

  if (want("f")) {
    const issues: ManualIssue[] = [];
    for (const doc of docs)
      proseLines(doc.lines).forEach(({ text }, i) => {
        const m = /[\u2013\u2014]/.exec(text);
        if (m) issues.push({ file: doc.rel, line: i + 1, msg: `${m[0] === "\u2014" ? "em" : "en"} dash outside code` });
        const h = HYPHEN_PUNCT.exec(text);
        if (h) issues.push({ file: doc.rel, line: i + 1, msg: `"${h[1]}" used as punctuation outside code` });
      });
    checks.push({ id: "f", title: "no em / en dash, \" - \" or \" -- \" as punctuation outside code", issues });
  }

  if (want("g")) {
    const issues: ManualIssue[] = [];
    const imagesDir = path.join(repo, mdir, "images");
    const shotsRel = path.join(mdir, "images", "SHOTS.md");
    const shotsAbs = path.join(repo, shotsRel);
    // A page as SHOTS.md writes it: relative to the manual folder (guide/library.md; a root file is ../README.md).
    const pageOf = (abs: string) => path.relative(path.join(repo, mdir), abs).split(path.sep).join("/");
    // Every image in the docs that points at <manual>/images/<name>.png (root files: docs/images/<name>.png).
    const used = new Map<string, { file: string; page: string; line: number }[]>();
    for (const doc of docs) {
      if (doc.abs === shotsAbs) continue;
      proseLines(doc.lines).forEach(({ text }, i) => {
        if (/<!--\s*SCREENSHOT\b/.test(text)) issues.push({ file: doc.rel, line: i + 1, msg: "a <!-- SCREENSHOT ... --> comment is left: replace it with its image" });
        for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
          const r = resolveLink(repo, mdir, doc, m[2]);
          if (!r || path.dirname(r.file) !== imagesDir) continue;
          const base = path.basename(r.file);
          if (!base.endsWith(".png")) {
            issues.push({ file: doc.rel, line: i + 1, msg: `screenshot ${m[2]} is not a .png` });
            continue;
          }
          const name = base.slice(0, -4);
          if (!m[1].trim()) issues.push({ file: doc.rel, line: i + 1, msg: `image ${name} has no alt text` });
          const at = used.get(name) ?? [];
          at.push({ file: doc.rel, page: pageOf(doc.abs), line: i + 1 });
          used.set(name, at);
        }
      });
    }
    const listed = fs.existsSync(shotsAbs) ? parseShots(fs.readFileSync(shotsAbs, "utf8")) : null;
    if (!listed) issues.push({ file: shotsRel, line: 0, msg: "missing" });
    else {
      const seen = new Set<string>();
      for (const row of listed) {
        if (seen.has(row.name)) issues.push({ file: shotsRel, line: row.line, msg: `${row.name} is listed twice` });
        seen.add(row.name);
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(row.name)) issues.push({ file: shotsRel, line: row.line, msg: `slot name ${row.name} is not kebab-case` });
        if (!fs.existsSync(path.join(imagesDir, `${row.name}.png`))) issues.push({ file: shotsRel, line: row.line, msg: `${row.name}.png is missing from ${path.join(mdir, "images")}` });
        const at = used.get(row.name) ?? [];
        if (!at.length) issues.push({ file: shotsRel, line: row.line, msg: `${row.name} is not shown as an image on any page` });
        else if (at.length > 1) issues.push({ file: shotsRel, line: row.line, msg: `${row.name} is shown ${at.length} times (${at.map((s) => `${s.file}:${s.line}`).join(", ")}); once only` });
        else if (row.page && at[0].page !== row.page) issues.push({ file: shotsRel, line: row.line, msg: `${row.name} is listed for ${row.page} but shown in ${at[0].page}` });
      }
      for (const [name, at] of used) if (!seen.has(name)) for (const s of at) issues.push({ file: s.file, line: s.line, msg: `image ${name}.png is not listed in ${shotsRel}` });
      const pngs = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir).filter((f) => f.endsWith(".png")) : [];
      for (const f of pngs) if (!seen.has(f.slice(0, -4))) issues.push({ file: path.join(mdir, "images", f), line: 0, msg: `not listed in ${shotsRel}` });
    }
    checks.push({ id: "g", title: "every screenshot in images/SHOTS.md has its PNG and is shown exactly once, on its page", issues });
  }

  if (want("h")) {
    const issues: ManualIssue[] = [];
    const indexRel = path.join(mdir, "README.md");
    const index = docs.find((d) => d.rel === indexRel);
    if (!index) issues.push({ file: indexRel, line: 0, msg: "missing" });
    else {
      const linked = new Set(linksOf(index.lines).map((l) => resolveLink(repo, mdir, index, l.target)?.file).filter((f): f is string => Boolean(f)));
      for (const d of docs) {
        if (!d.inManual || d.abs === index.abs || path.basename(d.abs) === PUBLIC_CLAUDE) continue;
        if (!linked.has(d.abs)) issues.push({ file: indexRel, line: 0, msg: `does not link ${d.rel}` });
      }
    }
    checks.push({ id: "h", title: "every manual page is linked from the manual's README.md", issues });
  }
  return checks;
}

export type ShotRow = { name: string; page: string; line: number };

/**
 * images/SHOTS.md rows: every markdown table row after a header row whose first cell is `name` (any case). Cell 1 = the
 * slot name (backticks allowed), cell 2 = the page holding the slot, relative to the manual folder (guide/library.md;
 * a root file is ../README.md; empty = not checked).
 */
export function parseShots(text: string): ShotRow[] {
  const rows: ShotRow[] = [];
  let inTable = false;
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim().replace(/^`|`$/g, ""));
  text.split("\n").forEach((line, i) => {
    if (!line.trim().startsWith("|")) {
      inTable = false;
      return;
    }
    const c = cells(line);
    if (c[0].toLowerCase() === "name") {
      inTable = true;
      return;
    }
    if (!inTable || /^:?-{3,}:?$/.test(c[0])) return;
    if (c[0]) rows.push({ name: c[0], page: c[1] ?? "", line: i + 1 });
  });
  return rows;
}

type Ctx = { ok: (msg: string) => void };

/** The smoke's entry: every check must pass. */
export async function runManualSmoke({ ok }: Ctx) {
  const checks = await checkManual(process.cwd());
  for (const c of checks) {
    assert.equal(c.issues.length, 0, `manual check (${c.id}) ${c.title}:\n${c.issues.map(fmt).join("\n")}`);
  }
  ok(`the manual: ${checks.map((c) => `(${c.id}) ${c.title}`).join("; ")}`);
}

const fmt = (i: ManualIssue) => `  ${i.file}${i.line ? `:${i.line}` : ""}: ${i.msg}`;

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = at >= 0 ? path.resolve(args[at + 1] ?? ".") : process.cwd();
  if (at >= 0) args.splice(at, 2);
  const only = args.map((a) => a.replace(/^[(-]+|\)$/g, "").toLowerCase());
  checkManual(root, only)
    .then((checks) => {
      let bad = 0;
      for (const c of checks) {
        console.log(`${c.issues.length ? "FAIL" : "ok  "} (${c.id}) ${c.title}${c.issues.length ? ` [${c.issues.length}]` : ""}`);
        for (const i of c.issues) console.log(fmt(i));
        bad += c.issues.length;
      }
      process.exit(bad ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(2);
    });
}
