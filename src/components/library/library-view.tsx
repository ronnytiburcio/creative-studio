import { Suspense } from "react";
import Link from "next/link";
import { FolderPlus } from "lucide-react";
import { getDb } from "@/lib/db";
import { filterOptions, listAssets, listClients, PAGE_SIZE, type LibraryFilters, type Scope } from "@/lib/queries";
import { FilterBar } from "./filter-bar";
import { AssetGrid } from "./asset-grid";
import { MeaningGrid } from "./meaning-grid";
import { MEANING_MIN_QUERY } from "@/lib/ai/search";
import { clampPage } from "@/lib/paging";
import { laneNames } from "@/lib/clients-admin";

function apiQueryFor(scope: Scope, f: LibraryFilters) {
  const q = new URLSearchParams();
  q.set("scope", scope.kind);
  if (scope.kind === "client") q.set("client", scope.code);
  if (f.kind) q.set("kind", f.kind);
  if (f.orient) q.set("orient", f.orient);
  if (f.folder) q.set("folder", f.folder);
  if (f.clients.length) q.set("clients", f.clients.join(","));
  if (!f.shared) q.set("shared", "0");
  if (f.source !== "all") q.set("source", f.source);
  if (f.cls.length) q.set("cls", f.cls.join(","));
  if (f.review) q.set("review", "1");
  if (f.energy) q.set("energy", f.energy);
  if (f.sort !== "newest") q.set("sort", f.sort);
  if (f.q) q.set("q", f.q);
  return q.toString();
}

/** Lane C's Library starts empty: until a folder is added in Settings, say how (and the Google Drive offline note). */
export function FkbEmptyLibrary({ lane: C }: { lane: string }) {
  return (
    <div className="mx-4 mt-6 rounded-2xl border border-dashed border-foreground/15 bg-card/60 px-6 py-10 text-center sm:mx-6">
      <FolderPlus className="mx-auto size-5 text-muted-foreground" />
      <h2 className="mt-2 text-[16px]">No {C} folder yet</h2>
      <p className="mx-auto mt-1 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
        Add {C}&apos;s media folder as a root in Settings (section {C}). Studio indexes it read only, like every other folder. A Google Drive
        folder must be marked Available offline (or copied to the drive) first, or indexing forces every file to download. Files Generate saves
        for {C} land here too.
      </p>
      <Link
        href="/settings#roots"
        className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium hover:bg-hover"
      >
        Add a folder in Settings
      </Link>
    </div>
  );
}

export function LibraryView({ scope, filters }: { scope: Scope; filters: LibraryFilters }) {
  if (scope.kind === "fkb") {
    // Only the generated folder (seed v8) or nothing yet, and no file indexed: the empty state explains the next step.
    const n = getDb()
      .sqlite.prepare("select count(*) from assets a join sections s on s.id = a.section_id where s.key = 'fkb' and a.missing = 0 and a.ignored = 0")
      .pluck()
      .get() as number;
    if (n === 0) return <FkbEmptyLibrary lane={laneNames(getDb().sqlite).fkb} />;
  }
  // Meaning switch on: Jev ranks the channel + filters (client side, MeaningGrid); the plain results for the same text
  // are the fallback, and the filter counts ignore the text (the candidates do too).
  const meaning = filters.meaning && filters.q.length >= MEANING_MIN_QUERY;
  // One page of cards (`?page=`); a page past the end (files went away, a filter shrank the list) shows the last one.
  let { items, total } = listAssets(scope, filters, (filters.page - 1) * PAGE_SIZE, PAGE_SIZE);
  const page = clampPage(filters.page, total, PAGE_SIZE);
  if (page !== filters.page) ({ items, total } = listAssets(scope, filters, (page - 1) * PAGE_SIZE, PAGE_SIZE));
  const opts = filterOptions(scope, meaning ? { ...filters, q: "" } : filters);
  const clients = listClients();
  const apiQuery = apiQueryFor(scope, filters);
  const chips = clients.map((c) => ({ code: c.code, short: c.short }));
  return (
    <Suspense>
      <FilterBar
        mode={scope.kind}
        filters={filters}
        folders={opts.folders}
        kinds={opts.kinds}
        orients={opts.orients}
        sources={opts.sources}
        classes={opts.classes}
        reviewCount={opts.review}
        energies={opts.energies}
        clients={clients.map((c) => ({ code: c.code, short: c.short, count: c.count }))}
        total={total}
        meaning={meaning}
      />
      {meaning ? (
        <MeaningGrid
          key={apiQuery}
          apiQuery={apiQuery}
          query={filters.q}
          fallback={{ items, total, page }}
          pageSize={PAGE_SIZE}
          clients={chips}
          adChannel={scope.kind === "client" ? scope.code : scope.kind === "fkb" ? "fkb" : null}
        />
      ) : (
        <AssetGrid
          key={apiQuery}
          initial={items}
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
          clients={chips}
          adChannel={scope.kind === "client" ? scope.code : scope.kind === "fkb" ? "fkb" : null}
        />
      )}
    </Suspense>
  );
}
