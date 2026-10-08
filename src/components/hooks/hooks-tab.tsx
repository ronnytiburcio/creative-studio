import { getDb } from "@/lib/db";
import { hookFacets, listHooks, type HookScope, type HookFilters } from "@/lib/hooks/queries";
import { avatarsFor } from "@/lib/hooks/rubric";
import { formatCoverage, mechanicCoverage } from "@/lib/hooks/coverage";
import { changedSinceScored, hookScoreUnitUsd, rubricVersions, sectionRescorePreview, sectionRescoreRefusal } from "@/lib/hooks/store";
import { listClients } from "@/lib/queries";
import { getConfig } from "@/lib/config";
import { copyDocPath, CopyDocError } from "@/lib/hooks/copydoc";
import { HooksView } from "./hooks-view";
import { calibrationLine } from "@/lib/calibration/report";

/**
 * Hooks tab (server): loads one page of the channel's hooks (HOOKS_PAGE rows, `?page=`), filter counts, rubric labels,
 * the coverage strip, the "changed since scored" counts for this view (notes, re-described videos) and, on the Lane A (`rtm`) tab,
 * the "Rescore <lane> hooks on vN" line (`sectionRescorePreview`), renders the client view.
 */
export function HooksTab({
  scope,
  filters,
  channelLabel,
  importClient,
}: {
  scope: HookScope;
  filters: HookFilters;
  channelLabel: string;
  importClient: { code: string; short: string } | null;
}) {
  const sql = getDb().sqlite;
  const { rows, total, page, rubric } = listHooks(scope, filters);
  const facets = hookFacets(scope, filters);
  const coverage = { mechanics: mechanicCoverage(sql, scope), formats: scope.kind === "rtm" ? null : formatCoverage(sql, scope) };
  const { count, notes, described } = changedSinceScored(sql, scope, filters.view);
  // Lane A only: its own rescore line while v3's Lane A change waits (never the global Rescore, never by itself).
  const rtmRescore = scope.kind === "rtm" ? sectionRescorePreview(sql, "rtm") : null;
  const sectionRescore = rtmRescore && sectionRescoreRefusal(rtmRescore) === null ? rtmRescore : null;
  const clients = listClients().map((c) => ({ code: c.code, short: c.short }));
  // Import approved copy needs the client's copy doc (its folder, Settings > Clients); without one it is off, with the reason.
  let importBlocked: string | null = null;
  if (importClient) {
    try {
      copyDocPath(getConfig().clientDocsDir, sql.prepare("select folder from clients where code = ?").pluck().get(importClient.code) as string | null);
    } catch (e) {
      importBlocked = e instanceof CopyDocError ? e.message : "Approved copy not found.";
    }
  }
  const section = scope.kind === "rtm" ? "rtm" : scope.kind === "fkb" ? "fkb" : "fkbpros";
  // Avatar filter options: the section's list (universal-only ones only where shared hooks show: All clients (Lane B)).
  const avatars = avatarsFor(rubric, section, scope.kind === "fkbpros").map((a) => ({ slug: a.slug, label: a.label }));
  // Labels for scores from older versions too (a removed avatar keeps its name on the hooks that got it).
  const avatarLabels: Record<string, string> = {};
  for (const v of rubricVersions(sql).values()) for (const a of v.avatars) avatarLabels[a.slug] = a.label;
  for (const a of rubric.avatars) avatarLabels[a.slug] = a.label;
  return (
    <HooksView
      scope={scope}
      filters={filters}
      rows={rows}
      total={total}
      page={page}
      facets={facets}
      rubricVersion={rubric.version}
      mechanics={rubric.mechanics}
      avatars={avatars}
      avatarLabels={avatarLabels}
      channelLabel={channelLabel}
      importClient={importClient ? { ...importClient, blocked: importBlocked } : null}
      perHookUsd={hookScoreUnitUsd(sql)}
      coverage={coverage}
      changed={{ count, notes, described }}
      sectionRescore={sectionRescore}
      clients={clients}
      calibration={calibrationLine(sql, scope)}
    />
  );
}
