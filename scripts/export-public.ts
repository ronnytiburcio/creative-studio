/**
 * The public export (Creative Studio Phase 4a): one command turns this repo into the public tree.
 *
 *   npm run export:public -- [--target DIR] [--allow-dirty]
 *
 * Source = git, never the working tree: the files `git ls-files` lists under EXPORTED (scripts/smoke-scrub.ts, the one
 * list), read from the index as blobs. Refused while an exported path has uncommitted or untracked changes;
 * --allow-dirty (the smoke and scratch runs only, printed loudly) skips that refusal and still exports the index.
 * Mapping: manual/** -> docs/**, manual/CLAUDE.public.md -> CLAUDE.md, AGENTS.md = a relative symlink to CLAUDE.md; the
 * paths in the copied scripts/leak-allow.txt are rewritten the same way. Everything else keeps its path.
 *
 * The tree is staged in a fresh temp folder and the gates run on it:
 *   (a) scripts/leak-grep.sh (the private denylist, the staged allowlist) over every staged file, as bytes;
 *   (b) the same denylist over every staged relative path (file and folder names);
 *   (c) the install's secret values (TYPESAFE_API_KEY, both Meta env files' tokens + GHL key / location, the YouTube
 *       client secret and token fields; files resolved by loadConfig(), values of 8+ characters) as bytes in every file
 *       and path. Values stay in memory: a hit names the file and the KEY only;
 *   (d) no symlink but AGENTS.md, no file over 5 MB, no env file but demo/.env and .env.example;
 *   (e) the export's own scripts/smoke-manual.ts, run inside the staged tree (its public layout).
 * Only when every gate passes is the target made equal to the stage (its own top-level .git never touched); a failed
 * gate leaves the target untouched. The staging folder is always deleted.
 *
 * Target: default ~/creative-studio-public; refused when it is /, the home folder (or holds it), inside this repo (or
 * holds it), on the media drive, a symlink, not a folder, inside another git working tree (a .git at the target itself
 * is fine), or a non-empty folder that is neither a previous export (its .export-public.json marker) nor an empty git
 * repo (only .git). The marker holds the export time, the source commit and counts: no path of this Mac.
 *
 * Never runs a git write, never touches the network, writes only the staging folder and the target.
 * Exit 0 = exported, 1 = a gate failed (target untouched), 2 = usage error or refusal (dirty source, bad target).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, gitTreeOf, loadConfig, type StudioConfig } from "../src/lib/config";
import { parseEnvText } from "../src/lib/envfile";
import { isUnderPath, onDrive, realishPath } from "../src/lib/privatefile";
import { EXPORTED } from "./smoke-scrub";

/** This script's repo: leak-grep.sh, node_modules (tsx for gate e) and, for the CLI, the source. */
export const TOOL_DIR = path.resolve(__dirname, "..");
export const DEFAULT_TARGET = "~/creative-studio-public";
export const MARKER = ".export-public.json";
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MIN_SECRET_CHARS = 8;
const AGENTS = { path: "AGENTS.md", to: "CLAUDE.md" };
const ALLOWED_ENV_FILES = new Set(["demo/.env", ".env.example"]);
const ALLOWLIST = "scripts/leak-allow.txt";
const MANUAL_CHECK = "scripts/smoke-manual.ts";

export class ExportRefused extends Error {}

/** Where an exported path lands in the public tree. */
export function mapPath(rel: string): string {
  if (rel === "manual/CLAUDE.public.md") return "CLAUDE.md";
  if (rel.startsWith("manual/")) return `docs/${rel.slice("manual/".length)}`;
  return rel;
}

/** The allowlist with each entry's path (2nd TAB cell) mapped like the files; comments and blank lines unchanged. */
export function rewriteAllowlist(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(#|$)/.test(line)) return line;
      const cells = line.split("\t");
      if (cells.length < 2) return line;
      cells[1] = mapPath(cells[1]);
      return cells.join("\t");
    })
    .join("\n");
}

/** An env file that may not ship: `.env`, `.env.<x>` or `<x>.env`, except demo/.env and .env.example. */
export function isStrayEnvFile(rel: string): boolean {
  const base = path.posix.basename(rel);
  return (/^\.env(\..+)?$/.test(base) || /.\.env$/.test(base)) && !ALLOWED_ENV_FILES.has(rel);
}

// ---------------------------------------------------------------- git (read only)

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[k];
  return env;
}

function git(repo: string, args: string[], input?: string): { status: number; out: Buffer } {
  const r = spawnSync("git", ["-C", repo, ...args], { input, maxBuffer: 1 << 30, env: gitEnv() });
  if (r.error) throw new ExportRefused(`git could not run (${(r.error as NodeJS.ErrnoException).code ?? "error"})`);
  return { status: r.status ?? 1, out: r.stdout };
}

function gitOk(repo: string, args: string[], input?: string): Buffer {
  const r = git(repo, args, input);
  if (r.status !== 0) throw new ExportRefused(`git ${args[0]} failed (is ${path.basename(repo)} a git repo?)`);
  return r.out;
}

/** Exported paths with uncommitted or untracked changes (`git status`, no lock taken). */
export function dirtyPaths(repo: string): string[] {
  const parts = gitOk(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...EXPORTED]).toString("utf8").split("\0");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    out.push(rec.slice(3));
    if (/[RC]/.test(rec.slice(0, 2))) i++; // a rename / copy carries its old path next
  }
  return out;
}

type IndexEntry = { mode: string; blob: string; rel: string };

function indexEntries(repo: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const rec of gitOk(repo, ["ls-files", "-s", "-z", "--", ...EXPORTED]).toString("utf8").split("\0")) {
    if (!rec) continue;
    const m = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/.exec(rec);
    if (!m) throw new ExportRefused("git ls-files returned an unexpected line");
    if (m[3] !== "0") throw new ExportRefused(`${m[4]} has an unresolved merge conflict`);
    if (m[1] === "160000") throw new ExportRefused(`${m[4]} is a submodule (not exportable)`);
    out.push({ mode: m[1], blob: m[2], rel: m[4] });
  }
  return out;
}

function readBlobs(repo: string, ids: string[]): Map<string, Buffer> {
  const uniq = [...new Set(ids)];
  const map = new Map<string, Buffer>();
  if (!uniq.length) return map;
  const out = gitOk(repo, ["cat-file", "--batch"], `${uniq.join("\n")}\n`);
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(10, at);
    const head = out.subarray(at, nl).toString("utf8").split(" ");
    if (head[1] !== "blob") throw new ExportRefused(`git object ${head[0]} is missing`);
    const size = Number(head[2]);
    map.set(head[0], Buffer.from(out.subarray(nl + 1, nl + 1 + size)));
    at = nl + 1 + size + 1;
  }
  return map;
}

function headCommit(repo: string): string | null {
  const r = git(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
  return r.status === 0 ? r.out.toString("utf8").trim() : null;
}

// ---------------------------------------------------------------- the target

/** The marker of a previous export, or null. */
function readMarker(dir: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")) as Record<string, unknown>;
    return j && j.tool === "export-public" ? j : null;
  } catch {
    return null;
  }
}

/** Why the target is refused, or null. `target` must be absolute. */
export function targetProblem(target: string, ctx: { home: string; repoDirs: string[]; drivePath: string | null }): string | null {
  const t = path.resolve(target);
  const rt = realishPath(t);
  if (t === "/" || rt === "/") return "is /";
  for (const h of new Set([path.resolve(ctx.home), realishPath(ctx.home)])) {
    if (t === h || rt === h) return "is the home folder";
    if (isUnderPath(h, t) || isUnderPath(h, rt)) return "holds the home folder";
  }
  for (const r of ctx.repoDirs) {
    for (const rr of new Set([path.resolve(r), realishPath(r)])) {
      if (isUnderPath(t, rr) || isUnderPath(rt, rr)) return "is inside the source repo";
      if (isUnderPath(rr, t) || isUnderPath(rr, rt)) return "holds the source repo";
    }
  }
  if (ctx.drivePath && onDrive(t, ctx.drivePath)) return "is on the media drive";
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(t);
  } catch {
    /* not there yet: created on export */
  }
  if (st?.isSymbolicLink()) return "is a symlink";
  if (st && !st.isDirectory()) return "is not a folder";
  if (gitTreeOf(path.dirname(t))) return "is inside another git working tree";
  if (st) {
    const names = fs.readdirSync(t);
    const emptyRepo = names.length === 1 && names[0] === ".git";
    if (names.length && !emptyRepo && !readMarker(t)) return `is a non-empty folder that is not a previous export (no ${MARKER})`;
  }
  return null;
}

// ---------------------------------------------------------------- secrets (values never leave this module's memory)

export type SecretSource = { label: string; file: string; kind: "env" | "json"; keys: string[] };
type Secret = { name: string; value: Buffer };

/** The secret files this install's config resolves and the keys read from each. */
export function installSecretSources(cfg: Pick<StudioConfig, "envFile" | "metaEnvFile" | "metaFkbEnvFile" | "youtubeClientSecretFile" | "youtubeTokenFile">): SecretSource[] {
  const meta = ["META_ACCESS_TOKEN", "GHL_API_KEY", "GHL_LOCATION_ID"];
  return [
    { label: "env file", file: cfg.envFile, kind: "env", keys: ["TYPESAFE_API_KEY"] },
    { label: "Meta env file", file: cfg.metaEnvFile, kind: "env", keys: meta },
    { label: "company Meta env file", file: cfg.metaFkbEnvFile, kind: "env", keys: meta },
    { label: "YouTube client file", file: cfg.youtubeClientSecretFile, kind: "json", keys: ["client_secret"] },
    { label: "YouTube token file", file: cfg.youtubeTokenFile, kind: "json", keys: ["access_token", "refresh_token", "id_token"] },
  ];
}

function jsonValues(node: unknown, keys: Set<string>, out: string[]) {
  if (Array.isArray(node)) for (const v of node) jsonValues(v, keys, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (keys.has(k) && typeof v === "string") out.push(v);
      else jsonValues(v, keys, out);
    }
  }
}

/** The values to search for (8+ characters), named `KEY (label)`. Notes say which files were skipped. */
export function loadSecrets(sources: SecretSource[], notes: string[]): Secret[] {
  const out: Secret[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    let text: string;
    try {
      text = fs.readFileSync(s.file, "utf8");
    } catch {
      notes.push(`secret scan: ${s.label} not found, skipped`);
      continue;
    }
    const pairs: [string, string][] = [];
    if (s.kind === "env") {
      const env = parseEnvText(text);
      for (const k of s.keys) if (typeof env[k] === "string") pairs.push([k, env[k]]);
    } else {
      let j: unknown;
      try {
        j = JSON.parse(text);
      } catch {
        notes.push(`secret scan: ${s.label} is not JSON, skipped`); // never the parser's message: it quotes the text
        continue;
      }
      for (const k of s.keys) {
        const vals: string[] = [];
        jsonValues(j, new Set([k]), vals);
        for (const v of vals) pairs.push([k, v]);
      }
    }
    for (const [k, raw] of pairs) {
      const v = raw.trim();
      if (v.length < MIN_SECRET_CHARS || seen.has(v)) continue;
      seen.add(v);
      out.push({ name: `${k} (${s.label})`, value: Buffer.from(v, "utf8") });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the export

type StagedEntry = { rel: string; type: "file" | "dir" | "symlink"; size: number; mode: number };

function walk(root: string): StagedEntry[] {
  const out: StagedEntry[] = [];
  const go = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out.push({ rel, type: "symlink", size: 0, mode: 0 });
      else if (st.isDirectory()) {
        out.push({ rel, type: "dir", size: 0, mode: 0 });
        go(abs);
      } else out.push({ rel, type: "file", size: st.size, mode: st.mode & 0o777 });
    }
  };
  go(root);
  return out;
}

export type ExportOptions = {
  /** The source git repo. */
  repoDir: string;
  /** Absolute target folder. */
  target: string;
  allowDirty?: boolean;
  /** The leak gate's denylist (this repo: private/leak-denylist.txt). */
  denyFile: string;
  secrets: SecretSource[];
  drivePath: string | null;
  home?: string;
  /** Where the staging folder is made (default the OS temp folder). */
  tmpRoot?: string;
  /** leak-grep.sh + node_modules (default this script's repo). */
  toolDir?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
};

export type ExportResult = { code: 0 | 1 | 2; files: number; bytes: number; gates: string[]; failures: string[]; changed: number; removed: number };

export function exportPublic(o: ExportOptions): ExportResult {
  const log = o.log ?? ((l: string) => console.log(l));
  const warn = o.warn ?? ((l: string) => console.error(l));
  const toolDir = o.toolDir ?? TOOL_DIR;
  const res: ExportResult = { code: 2, files: 0, bytes: 0, gates: [], failures: [], changed: 0, removed: 0 };
  let work: string | null = null;
  try {
    if (!path.isAbsolute(o.target)) throw new ExportRefused("the target must be an absolute path (or start with ~/)");
    const target = path.resolve(o.target);
    const tctx = { home: o.home ?? os.homedir(), repoDirs: [...new Set([o.repoDir, toolDir])], drivePath: o.drivePath };
    const bad = targetProblem(target, tctx);
    if (bad) throw new ExportRefused(`target refused: it ${bad}`);
    if (!fs.existsSync(o.denyFile)) throw new ExportRefused("the leak gate's denylist is missing (private/leak-denylist.txt)");

    const dirty = dirtyPaths(o.repoDir);
    if (dirty.length && !o.allowDirty) {
      throw new ExportRefused(
        `${dirty.length} exported path(s) have uncommitted or untracked changes (commit them, or --allow-dirty for a scratch run):\n${dirty
          .slice(0, 20)
          .map((p) => `  ${p}`)
          .join("\n")}${dirty.length > 20 ? `\n  ... and ${dirty.length - 20} more` : ""}`,
      );
    }
    if (o.allowDirty) {
      const bar = "!".repeat(72);
      warn(`${bar}\n!! --allow-dirty: scratch run. The INDEX is exported: of ${dirty.length} changed or untracked exported path(s), only what is staged goes out.\n${bar}`);
    }
    const entries = indexEntries(o.repoDir);
    if (!entries.length) throw new ExportRefused("git lists no exported files");
    const commit = headCommit(o.repoDir);
    const notes: string[] = [];
    const secrets = loadSecrets(o.secrets, notes);
    const skipped = notes.length;

    // ------------------------------------------------ stage
    work = fs.mkdtempSync(path.join(o.tmpRoot ?? os.tmpdir(), "creative-studio-export-"));
    const tree = path.join(work, "tree");
    fs.mkdirSync(tree);
    const blobs = readBlobs(o.repoDir, entries.map((e) => e.blob));
    const dests = new Set<string>();
    for (const e of entries) {
      const dest = mapPath(e.rel);
      if (dests.has(dest) || dest === AGENTS.path || dest === MARKER) throw new ExportRefused(`two exported files map to ${dest}`);
      dests.add(dest);
      const abs = path.join(tree, ...dest.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      let data = blobs.get(e.blob)!;
      if (e.mode === "120000") {
        fs.symlinkSync(data.toString("utf8"), abs); // gate (d) refuses it
        continue;
      }
      if (dest === ALLOWLIST) data = Buffer.from(rewriteAllowlist(data.toString("utf8")), "utf8");
      fs.writeFileSync(abs, data, { mode: e.mode === "100755" ? 0o755 : 0o644 });
      fs.chmodSync(abs, e.mode === "100755" ? 0o755 : 0o644);
    }
    fs.symlinkSync(AGENTS.to, path.join(tree, AGENTS.path));
    const staged = walk(tree);
    res.files = staged.filter((s) => s.type !== "dir").length;
    res.bytes = staged.reduce((n, s) => n + s.size, 0);
    const marker = { tool: "export-public", schema: 1, exported_at: new Date().toISOString(), source_commit: commit, files: res.files, bytes: res.bytes, allow_dirty: Boolean(o.allowDirty) };
    fs.writeFileSync(path.join(tree, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
    const all = walk(tree);
    const files = all.filter((s) => s.type === "file");

    // ------------------------------------------------ gates
    const gate = (id: string, title: string, problems: string[]) => {
      if (problems.length) {
        res.failures.push(`gate (${id}) ${title}: FAILED`);
        for (const p of problems.slice(0, 40)) res.failures.push(`  ${p}`);
        if (problems.length > 40) res.failures.push(`  ... and ${problems.length - 40} more`);
      } else res.gates.push(`(${id}) ${title}`);
    };
    const leakGrep = path.join(toolDir, "scripts", "leak-grep.sh");
    const grep = (args: string[], cwd: string) => spawnSync("/bin/bash", [leakGrep, "--deny", o.denyFile, ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });

    // (a) contents
    {
      const r = grep(["--allow", path.join(tree, ...ALLOWLIST.split("/")), "--root", tree, ...files.map((f) => f.rel)], tree);
      const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
      const problems = r.status === 0 ? [] : r.status === 1 ? lines.slice(0, -1) : [`leak-grep.sh could not run (exit ${r.status}): ${(r.stderr ?? "").trim().split("\n")[0]}`];
      for (const w of (r.stderr ?? "").split("\n")) if (/never matched/.test(w)) notes.push(w.trim());
      gate("a", `leak gate over ${files.length} files (${lines.pop() ?? "no summary"})`, problems);
    }
    // (b) path names
    const rels = all.map((s) => s.rel);
    {
      const problems: string[] = rels.filter((r) => /[\n\r]/.test(r)).map((r) => `a path name holds a line break: ${JSON.stringify(r)}`);
      fs.writeFileSync(path.join(work, "paths.txt"), `${rels.join("\n")}\n`);
      const r = grep(["--allow", "/dev/null", "--root", work, "paths.txt"], work);
      if (r.status === 1) {
        for (const l of (r.stdout ?? "").split("\n")) {
          const m = /^paths\.txt:(\d+): (.*)$/.exec(l);
          if (m) problems.push(`${rels[Number(m[1]) - 1]} (name matches "${m[2]}")`);
        }
      } else if (r.status !== 0) problems.push(`leak-grep.sh could not run (exit ${r.status})`);
      gate("b", `denylist over ${rels.length} path names`, problems);
    }
    // (c) secret values
    {
      const problems: string[] = [];
      for (const f of files) {
        const buf = fs.readFileSync(path.join(tree, ...f.rel.split("/")));
        for (const s of secrets) if (buf.indexOf(s.value) >= 0) problems.push(`${f.rel}: holds the value of ${s.name}`);
      }
      const names = Buffer.from(rels.join("\n"), "utf8");
      for (const s of secrets) if (names.indexOf(s.value) >= 0) problems.push(`a path name holds the value of ${s.name}`);
      gate("c", `${secrets.length} secret value(s) searched as bytes${skipped ? ` (${skipped} file(s) skipped)` : ""}`, problems);
    }
    // (d) links, sizes, env files
    {
      const problems: string[] = [];
      for (const s of all) {
        if (s.type === "symlink") {
          const to = fs.readlinkSync(path.join(tree, ...s.rel.split("/")));
          if (s.rel !== AGENTS.path) problems.push(`${s.rel}: a symlink (only ${AGENTS.path} may be one)`);
          else if (to !== AGENTS.to || !files.some((f) => f.rel === AGENTS.to)) problems.push(`${s.rel}: must link to an exported ${AGENTS.to}`);
        }
        if (s.type === "file" && s.size > MAX_FILE_BYTES) problems.push(`${s.rel}: ${(s.size / 1024 / 1024).toFixed(1)} MB (over 5 MB)`);
        if (s.type !== "dir" && isStrayEnvFile(s.rel)) problems.push(`${s.rel}: an env file (only demo/.env and .env.example ship)`);
      }
      gate("d", "no stray symlink, no file over 5 MB, no stray env file", problems);
    }
    // (e) the export's own manual check, inside the staged tree (node_modules linked next to it, never in it)
    {
      const problems: string[] = [];
      if (!fs.existsSync(path.join(tree, ...MANUAL_CHECK.split("/")))) problems.push(`${MANUAL_CHECK} is not in the export`);
      else {
        const nm = path.join(work, "node_modules");
        fs.symlinkSync(path.join(toolDir, "node_modules"), nm);
        const env: Record<string, string> = {};
        for (const k of ["HOME", "PATH", "TMPDIR", "LANG", "USER", "LOGNAME"]) {
          const v = process.env[k];
          if (v) env[k] = v;
        }
        const r = spawnSync(process.execPath, [path.join(toolDir, "node_modules", "tsx", "dist", "cli.mjs"), MANUAL_CHECK], {
          cwd: tree,
          env: env as NodeJS.ProcessEnv,
          encoding: "utf8",
          timeout: 180_000,
          maxBuffer: 1 << 26,
        });
        fs.unlinkSync(nm);
        if (r.status !== 0) {
          const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").filter((l) => !/^ok\s/.test(l));
          problems.push(`exit ${r.status ?? r.signal}`, ...out.slice(0, 30));
        }
        const after = walk(tree);
        if (JSON.stringify(after) !== JSON.stringify(all)) problems.push("the manual check changed the staged tree");
      }
      gate("e", `${MANUAL_CHECK} on the public layout`, problems);
    }

    for (const n of notes) log(n);
    if (res.failures.length) {
      for (const l of res.failures) log(l);
      log(`export: FAILED, ${res.failures.filter((l) => l.startsWith("gate")).length} gate(s); the target was not touched`);
      res.code = 1;
      return res;
    }

    // ------------------------------------------------ the target = the stage
    const again = targetProblem(target, tctx);
    if (again) throw new ExportRefused(`target refused: it ${again}`);
    const r = syncTarget(tree, target, all);
    res.changed = r.changed;
    res.removed = r.removed;
    res.code = 0;
    log(`export: ${res.files} files, ${(res.bytes / 1024 / 1024).toFixed(2)} MB from ${commit ? commit.slice(0, 12) : "an unborn HEAD"}${o.allowDirty ? " (--allow-dirty)" : ""}`);
    for (const g of res.gates) log(`  gate ${g}: passed`);
    log(`  target ${target}: ${r.changed} written, ${r.removed} removed, its .git untouched`);
    log("Next (Phase 5, by hand): in the target, git init if it has no .git, read git status and the diff, commit, then create the GitHub repo and push.");
    return res;
  } catch (e) {
    if (!(e instanceof ExportRefused)) throw e;
    log(`export: refused: ${e.message}`);
    res.code = 2;
    return res;
  } finally {
    if (work) {
      fs.rmSync(path.join(work, "node_modules"), { force: true });
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

/** Make `target` hold exactly the staged tree (its top-level .git kept). Never follows a symlink in the target. */
function syncTarget(tree: string, target: string, staged: StagedEntry[]): { changed: number; removed: number } {
  fs.mkdirSync(target, { recursive: true });
  const want = new Map(staged.map((s) => [s.rel, s]));
  let removed = 0;
  let changed = 0;
  const prune = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(target, abs).split(path.sep).join("/");
      if (rel === ".git") continue;
      const st = fs.lstatSync(abs);
      const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
      const w = want.get(rel);
      if (!w || w.type !== type) {
        if (type === "dir") fs.rmSync(abs, { recursive: true, force: true });
        else fs.unlinkSync(abs); // a link is removed, never followed
        removed++;
      } else if (type === "dir") prune(abs);
    }
  };
  prune(target);
  for (const s of staged) {
    const src = path.join(tree, ...s.rel.split("/"));
    const dst = path.join(target, ...s.rel.split("/"));
    if (s.type === "dir") {
      fs.mkdirSync(dst, { recursive: true });
      continue;
    }
    if (s.type === "symlink") {
      const to = fs.readlinkSync(src);
      let cur: string | null = null;
      try {
        cur = fs.readlinkSync(dst);
      } catch {
        /* missing */
      }
      if (cur !== to) {
        fs.rmSync(dst, { force: true });
        fs.symlinkSync(to, dst);
        changed++;
      }
      continue;
    }
    const data = fs.readFileSync(src);
    let same = false;
    try {
      const st = fs.lstatSync(dst);
      same = st.isFile() && st.size === data.length && (st.mode & 0o777) === s.mode && fs.readFileSync(dst).equals(data);
    } catch {
      /* missing */
    }
    if (same) continue;
    const fd = fs.openSync(dst, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, s.mode);
    try {
      fs.writeSync(fd, data);
      fs.fchmodSync(fd, s.mode);
    } finally {
      fs.closeSync(fd);
    }
    changed++;
  }
  return { changed, removed };
}

// ---------------------------------------------------------------- CLI

const USAGE = "usage: npm run export:public -- [--target DIR] [--allow-dirty]   (default target ~/creative-studio-public)";

export function parseExportArgs(argv: string[]): { target: string; allowDirty: boolean } | { error: string } | { help: true } {
  let target = DEFAULT_TARGET;
  let allowDirty = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    else if (a === "--allow-dirty") allowDirty = true;
    else if (a === "--target") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: "--target needs a folder" };
      target = v;
    } else if (a.startsWith("--target=")) target = a.slice("--target=".length);
    else return { error: `unknown argument: ${a}` };
  }
  return { target, allowDirty };
}

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = parseExportArgs(process.argv.slice(2));
  if ("help" in args) {
    console.log(USAGE);
    process.exit(0);
  }
  if ("error" in args) {
    console.error(`export: ${args.error}\n${USAGE}`);
    process.exit(2);
  }
  const home = os.homedir();
  const target = expandHome(args.target, home);
  if (!path.isAbsolute(target)) {
    console.error(`export: the target must be an absolute path (or start with ~/)\n${USAGE}`);
    process.exit(2);
  }
  let cfg: StudioConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(`export: ${(e as Error).message.split("\n")[0]}`);
    process.exit(2);
  }
  const r = exportPublic({
    repoDir: TOOL_DIR,
    target,
    allowDirty: args.allowDirty,
    denyFile: path.join(TOOL_DIR, "private", "leak-denylist.txt"),
    secrets: installSecretSources(cfg),
    drivePath: cfg.drivePath,
    home,
  });
  process.exit(r.code);
}
