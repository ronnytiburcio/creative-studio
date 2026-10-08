/**
 * Shared SQL fragments for hooks (no imports: store.ts re-exports them, and notes.ts / client.ts can use them without
 * an import cycle). Every fragment expects the hooks table aliased `h`; the scope helper expects `s` (sections) and
 * `c` (clients, left join).
 */

/**
 * What a Hooks tab shows: Lane A, All clients (Lane B: every client's hooks + shared), one Lane B client (its own) or Lane C
 * (the company lane, Phase 5: one channel, no clients).
 */
export type HookScope = { kind: "rtm" } | { kind: "fkbpros" } | { kind: "client"; code: string } | { kind: "fkb" };

/**
 * A video hook's asset is visible: in an enabled root, not missing, not ignored (text hooks always are). A hidden
 * video's hook is never deleted; it just drops out of lists, counts and the queue until its file is back.
 */
export const HOOK_VISIBLE = `(h.asset_id is null or exists (select 1 from assets va join roots vr on vr.id = va.root_id
  where va.id = h.asset_id and va.missing = 0 and va.ignored = 0 and vr.enabled = 1))`;
/** A live hook: not archived, a top level hook or a kept variant, and visible. */
export const HOOK_LIVE = `h.archived_at is null and (h.parent_id is null or h.kept = 1) and ${HOOK_VISIBLE}`;
/**
 * Live, or an undecided variant (slice 3): what the queue may score. Undecided variants are scored only on request
 * (they are requested when they are written); they never join the backfill, counts or coverage.
 */
export const HOOK_ACTIVE = `h.archived_at is null and ${HOOK_VISIBLE}`;
/**
 * Join condition for a hook's latest score (`hs`): the newest rubric version it was scored with. The Hooks tab, coverage
 * and "changed since scored" show that one until the current version's score lands.
 */
export const LATEST_SCORE = latestScoreFor("hs", "h");

/**
 * The same latest-score condition for any pair of aliases (a hook_scores alias and its hooks alias), e.g. the Shorts
 * board's cold open hook join (`chs` / `ch`). The aliases are code literals, never user input: they are spliced into SQL.
 */
export function latestScoreFor(scoreAlias: string, hookAlias: string): string {
  const sub = `${scoreAlias}l`;
  return `${scoreAlias}.rubric_version = (select max(${sub}.rubric_version) from hook_scores ${sub} where ${sub}.hook_id = ${hookAlias}.id)`;
}

/** A Hooks tab's channel as a condition on `s.key` / `c.code` (the Hooks tab list and the coverage strip share it). */
export function hookScopeSql(scope: HookScope): { sql: string; params: unknown[] } {
  if (scope.kind === "rtm") return { sql: "s.key = 'rtm'", params: [] };
  if (scope.kind === "fkbpros") return { sql: "s.key = 'fkbpros'", params: [] };
  if (scope.kind === "fkb") return { sql: "s.key = 'fkb'", params: [] };
  return { sql: "s.key = 'fkbpros' and c.code = ?", params: [scope.code] };
}

/**
 * The Hooks tab that holds a hook of this section + client code: `/rtm/hooks`, `/fkb/hooks`, `/fkbpros/<code>/hooks` or
 * `/fkbpros/all/hooks` for a shared Lane B hook (the one place the three sections map to a URL).
 */
export function hooksPath(section: string | null | undefined, code: string | null | undefined): string {
  if (section === "rtm") return "/rtm/hooks";
  if (section === "fkb") return "/fkb/hooks";
  return `/fkbpros/${code ?? "all"}/hooks`;
}
