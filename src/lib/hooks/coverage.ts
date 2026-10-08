/**
 * Coverage strips (Phase 4 D4 + F3, slice 2; server only): how a channel's live hooks spread over the 9 copy mechanics
 * (each hook's latest `style` answer; unscored and "none" counted apart), and for Lane B channels and Lane C how its
 * static ads spread over the 7 visual formats (the Phase 3 classify answer on visible `static_ad` images; "not an ad" and
 * no answer counted apart). A zero is a gap. Parameterized SQL on the app DB.
 */
import type Database from "better-sqlite3";
import { VISUAL_FORMATS } from "../ai/classes";
import { NONE_MECHANIC } from "./rubric";
import { currentRubric, HOOK_LIVE, hookScopeSql, LATEST_SCORE, type HookScope } from "./store";
import { laneNames } from "../clients-admin";

type Sql = Database.Database;

export type CoverageCell = { id: string; label: string; count: number };

export type MechanicCoverage = {
  /** The 9 mechanics in rubric order. */
  cells: CoverageCell[];
  none: number;
  unscored: number;
  total: number;
};

export type FormatCoverage = {
  /** The 7 formats (not "not an ad"). */
  cells: CoverageCell[];
  /** Static ads Jev called "not an ad" or left without a format answer. */
  other: number;
  total: number;
};

/** Live hooks (text + video) per copy mechanic in a Hooks tab's channel. */
export function mechanicCoverage(sql: Sql, scope: HookScope): MechanicCoverage {
  const rubric = currentRubric(sql);
  const w = hookScopeSql(scope);
  const rows = sql
    .prepare(
      `select case when hs.hook_id is null then '~unscored' else coalesce(hs.style, '~none') end as k, count(*) as n
         from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id
         left join hook_scores hs on hs.hook_id = h.id and ${LATEST_SCORE}
        where ${HOOK_LIVE} and ${w.sql}
        group by k`,
    )
    .all(...w.params) as { k: string; n: number }[];
  const by = new Map(rows.map((r) => [r.k, r.n]));
  const unscored = by.get("~unscored") ?? 0;
  const cells = rubric.mechanics.filter((m) => m.id !== NONE_MECHANIC).map((m) => ({ id: m.id, label: m.label, count: by.get(m.id) ?? 0 }));
  const total = rows.reduce((a, r) => a + r.n, 0);
  return { cells, none: (by.get(NONE_MECHANIC) ?? 0) + (by.get("~none") ?? 0), unscored, total };
}

/**
 * Static ads per visual format in a Lane B channel (All clients (Lane B) = every Lane B static; a client = its tagged ones)
 * or Lane C (its own statics).
 */
export function formatCoverage(sql: Sql, scope: Exclude<HookScope, { kind: "rtm" }>): FormatCoverage {
  const clientSql =
    scope.kind === "client"
      ? "and exists (select 1 from asset_clients ac join clients c on c.id = ac.client_id where ac.asset_id = a.id and c.code = ?)"
      : "";
  const section = scope.kind === "fkb" ? "fkb" : "fkbpros";
  const rows = sql
    .prepare(
      `select case when coalesce(json_extract(cl.answers, '$.visual_format.dropped'), 0) = 0
                   then json_extract(cl.answers, '$.visual_format.value') end as k, count(*) as n
         from assets a join roots r on r.id = a.root_id join sections s on s.id = a.section_id
         left join classifications cl on cl.asset_id = a.id
        where s.key = ? and r.enabled = 1 and a.missing = 0 and a.ignored = 0
          and a.kind = 'image' and a.asset_class = 'static_ad' ${clientSql}
        group by k`,
    )
    .all(section, ...(scope.kind === "client" ? [scope.code] : [])) as { k: string | null; n: number }[];
  const by = new Map(rows.map((r) => [r.k ?? "", r.n]));
  const cells = VISUAL_FORMATS.filter((f) => f.id !== "not_an_ad").map((f) => ({ id: f.id, label: f.label, count: by.get(f.id) ?? 0 }));
  const total = rows.reduce((a, r) => a + r.n, 0);
  return { cells, other: total - cells.reduce((a, c) => a + c.count, 0), total };
}

export type ChannelCoverage = {
  key: string;
  label: string;
  href: string;
  scope: HookScope;
  mechanics: MechanicCoverage;
  formats: FormatCoverage | null;
};

/**
 * Every channel in one place (Rubric page): Lane A, Lane C, All clients (Lane B), then each client in sidebar order. A
 * switched-off lane and a hidden client are left out (Creative Studio 1b).
 */
export function allCoverage(sql: Sql): ChannelCoverage[] {
  const clients = sql
    .prepare(
      "select c.code, c.name from clients c join sections s on s.id = c.section_id where s.key = 'fkbpros' and c.hidden_at is null order by c.sort, c.name",
    )
    .all() as { code: string; name: string }[];
  const on = new Set(sql.prepare("select key from sections where enabled = 1").pluck().all() as string[]);
  const L = laneNames(sql);
  const all: ChannelCoverage[] = [
    { key: "rtm", label: L.rtm, href: "/rtm/hooks", scope: { kind: "rtm" }, mechanics: mechanicCoverage(sql, { kind: "rtm" }), formats: null },
    {
      key: "fkb",
      label: L.fkb,
      href: "/fkb/hooks",
      scope: { kind: "fkb" },
      mechanics: mechanicCoverage(sql, { kind: "fkb" }),
      formats: formatCoverage(sql, { kind: "fkb" }),
    },
    {
      key: "fkbpros",
      label: `All ${L.fkbpros}`,
      href: "/fkbpros/all/hooks",
      scope: { kind: "fkbpros" },
      mechanics: mechanicCoverage(sql, { kind: "fkbpros" }),
      formats: formatCoverage(sql, { kind: "fkbpros" }),
    },
  ];
  const out = all.filter((c) => on.has(c.key));
  for (const c of clients) {
    const scope = { kind: "client" as const, code: c.code };
    out.push({
      key: c.code,
      label: c.name.split(" / ")[0].trim(),
      href: `/fkbpros/${c.code}/hooks`,
      scope,
      mechanics: mechanicCoverage(sql, scope),
      formats: formatCoverage(sql, scope),
    });
  }
  return out;
}
