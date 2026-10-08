/**
 * Model rules + reference roles (pure, safe for client + server).
 *
 * `higgsfield model get` returns CEL rules such as
 *   params.mode != "t2v" || size(params.image_references) + ... == 0
 * The panel evaluates them BEFORE confirm so a violation shows as a plain message instead of a CLI exit 4.
 * This is a small CEL subset (literals, params.x, size(), ! - + == != < <= > >= && || ?:, parentheses).
 * A rule the parser does not understand is skipped (the CLI still enforces it at quote/create time).
 *
 * Reference roles map tray items onto the model's media params (--start-image, --end-image,
 * --image-references, --video-references).
 */
import type { ModelSchema, ParamValue } from "./types";

// ------------------------------------------------------------------ roles

export const REF_ROLES = ["start_image", "end_image", "image_references", "video_references"] as const;
export type RefRole = (typeof REF_ROLES)[number];

export const ROLE_LABEL: Record<RefRole, string> = {
  start_image: "Start frame",
  end_image: "End frame",
  image_references: "Reference",
  video_references: "Video reference",
};

export type RefKind = "image" | "video" | "audio";

/** Roles this model offers for a reference of this kind, in auto-assignment order. */
export function rolesFor(schema: ModelSchema, kind: RefKind): RefRole[] {
  const has = (name: string) => schema.params.some((p) => p.name === name);
  if (kind === "image") return (["start_image", "image_references", "end_image"] as const).filter(has);
  if (kind === "video") return (["video_references"] as const).filter(has);
  return [];
}

export type RoleAssignment = { id: number; kind: RefKind; role: RefRole | null };

/**
 * Give every reference a role. Valid overrides win; the rest are auto-assigned in tray order:
 * the first image is the start frame where the model has one, other images are references
 * (or the end frame when the model only has start/end), videos are video references.
 * start_image / end_image hold one item each. role null = this model cannot take it.
 */
export function assignRoles(
  schema: ModelSchema,
  refs: { id: number; kind: RefKind }[],
  overrides: Record<number, RefRole | undefined> = {},
): RoleAssignment[] {
  const taken = new Set<RefRole>();
  const out = new Map<number, RefRole | null>();
  for (const r of refs) {
    const o = overrides[r.id];
    if (!o || !rolesFor(schema, r.kind).includes(o)) continue;
    if ((o === "start_image" || o === "end_image") && taken.has(o)) continue;
    out.set(r.id, o);
    taken.add(o);
  }
  for (const r of refs) {
    if (out.has(r.id)) continue;
    const role = rolesFor(schema, r.kind).find((x) => !((x === "start_image" || x === "end_image") && taken.has(x))) ?? null;
    out.set(r.id, role);
    if (role) taken.add(role);
  }
  return refs.map((r) => ({ id: r.id, kind: r.kind, role: out.get(r.id) ?? null }));
}

export type MediaCounts = Record<RefRole | "audio_references", number>;

export function mediaCounts(assignments: { role: RefRole | null }[]): MediaCounts {
  const counts: MediaCounts = { start_image: 0, end_image: 0, image_references: 0, video_references: 0, audio_references: 0 };
  for (const a of assignments) if (a.role) counts[a.role]++;
  return counts;
}

// ------------------------------------------------------------ CEL subset

type Val = string | number | boolean | null | unknown[] | Record<string, unknown>;
type Tok = { t: "num" | "str" | "id" | "op"; v: string };

const OPS = ["||", "&&", "==", "!=", "<=", ">=", "<", ">", "+", "-", "!", "?", ":", "(", ")", ".", ","];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        s += src[j++] ?? "";
      }
      if (j >= src.length) throw new Error("unterminated string");
      out.push({ t: "str", v: s });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw new Error(`unexpected ${c}`);
      out.push({ t: "op", v: op });
      i += op.length;
    }
  }
  return out;
}

/** Recursive-descent evaluator over the token list. Throws on anything outside the subset. */
function evaluate(src: string, params: Record<string, Val>): Val {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (v?: string) => (toks[pos] && (v === undefined || toks[pos].v === v) ? toks[pos] : null);
  const eat = (v: string) => {
    if (!peek(v) || toks[pos].t === "str") throw new Error(`expected ${v}`);
    pos++;
  };
  const bool = (v: Val) => {
    if (typeof v !== "boolean") throw new Error("not a boolean");
    return v;
  };
  const num = (v: Val) => {
    if (typeof v !== "number") throw new Error("not a number");
    return v;
  };
  const eq = (a: Val, b: Val) => {
    if (a === undefined) a = null;
    if (b === undefined) b = null;
    if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && !isNaN(Number(b))) return a === Number(b);
    if (typeof b === "number" && typeof a === "string" && a.trim() !== "" && !isNaN(Number(a))) return b === Number(a);
    if (Array.isArray(a) || Array.isArray(b)) return false;
    if (a && typeof a === "object") return false; // objects are only ever compared with null in these rules
    return a === b;
  };

  const ternary = (): Val => {
    const cond = or();
    if (!peek("?")) return cond;
    eat("?");
    const a = ternary();
    eat(":");
    const b = ternary();
    return bool(cond) ? a : b;
  };
  const or = (): Val => {
    let left = and();
    while (peek("||")) {
      pos++;
      const right = and();
      left = bool(left) || bool(right);
    }
    return left;
  };
  const and = (): Val => {
    let left = cmp();
    while (peek("&&")) {
      pos++;
      const right = cmp();
      left = bool(left) && bool(right);
    }
    return left;
  };
  const cmp = (): Val => {
    const left = add();
    const op = toks[pos]?.t === "op" ? toks[pos].v : "";
    if (!["==", "!=", "<", "<=", ">", ">="].includes(op)) return left;
    pos++;
    const right = add();
    if (op === "==") return eq(left, right);
    if (op === "!=") return !eq(left, right);
    const [a, b] = [num(left), num(right)];
    return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
  };
  const add = (): Val => {
    let left = unary();
    while (peek("+") || peek("-")) {
      const op = toks[pos++].v;
      const right = unary();
      if (op === "+" && typeof left === "string" && typeof right === "string") left = left + right;
      else left = op === "+" ? num(left) + num(right) : num(left) - num(right);
    }
    return left;
  };
  const unary = (): Val => {
    if (peek("!") && toks[pos].t === "op") {
      pos++;
      return !bool(unary());
    }
    if (peek("-") && toks[pos].t === "op") {
      pos++;
      return -num(unary());
    }
    return primary();
  };
  const primary = (): Val => {
    const tok = toks[pos++];
    if (!tok) throw new Error("unexpected end");
    if (tok.t === "num") return Number(tok.v);
    if (tok.t === "str") return tok.v;
    if (tok.t === "op" && tok.v === "(") {
      const v = ternary();
      eat(")");
      return v;
    }
    if (tok.t === "id") {
      if (tok.v === "null") return null;
      if (tok.v === "true") return true;
      if (tok.v === "false") return false;
      if (tok.v === "size") {
        eat("(");
        const v = ternary();
        eat(")");
        if (v == null) return 0;
        if (Array.isArray(v) || typeof v === "string") return v.length;
        if (typeof v === "object") return Object.keys(v).length;
        throw new Error("size() of a scalar");
      }
      if (tok.v === "params") {
        eat(".");
        const name = toks[pos++];
        if (!name || name.t !== "id") throw new Error("expected a param name");
        const v = params[name.v];
        return v === undefined ? null : v;
      }
    }
    throw new Error(`unsupported ${tok.v}`);
  };

  const v = ternary();
  if (pos !== toks.length) throw new Error("trailing tokens");
  return v;
}

/**
 * Evaluate the model's rules against the effective settings and the reference slots in use.
 * Returns the messages of the rules that fail. Rules outside the CEL subset are skipped.
 */
export function ruleViolations(
  schema: ModelSchema,
  effective: Record<string, ParamValue | null>,
  counts: MediaCounts,
): string[] {
  const params: Record<string, Val> = {};
  for (const p of schema.params) {
    if (p.name in counts) {
      const n = counts[p.name as keyof MediaCounts];
      params[p.name] = p.type.startsWith("array") ? Array.from({ length: n }, () => ({})) : n > 0 ? {} : null;
    } else if (p.type.startsWith("array")) {
      params[p.name] = [];
    } else {
      params[p.name] = effective[p.name] ?? p.default ?? null;
    }
  }
  const out: string[] = [];
  for (const rule of schema.rules) {
    try {
      if (evaluate(rule.cel, params) === false) out.push(rule.message || "These settings are not allowed together.");
    } catch {
      /* outside the subset: the CLI still checks it */
    }
  }
  return out;
}

// -------------------------------------------------------------- proof guard

/** Exact copy shown when a reference is a real job photo (the owner, 2026-09-29). */
export const PROOF_GUARD_TEXT = "AI will redraw this job photo. Don't run the result as real proof.";

/**
 * A reference from a client "* - Work Gallery" folder or a "* Before After *" folder (any folder on the
 * asset's path, case-insensitive; the file name itself is not checked).
 */
export function isProofPath(absPath: string): boolean {
  const dirs = absPath.split("/").slice(0, -1);
  return dirs.some((d) => / - work gallery$/i.test(d) || /(^|\s)before after(\s|$)/i.test(d));
}
