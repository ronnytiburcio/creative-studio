import { Search } from "lucide-react";
import { LibraryView } from "@/components/library/library-view";
import { parseFilters } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Search" };

export default async function SearchPage(props: PageProps<"/search">) {
  const filters = parseFilters(await props.searchParams);
  return (
    <>
      <div className="px-6 pt-5">
        <div className="flex items-center gap-3.5 border-b border-border pb-4">
          <div className="grid size-11 place-items-center rounded-xl border border-border bg-card">
            <Search className="size-5 text-muted-foreground" />
          </div>
          <div>
            <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">All channels</div>
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.02em]">
              {filters.q ? `Search: ${filters.q}` : "All media"}
            </h1>
          </div>
        </div>
      </div>
      <LibraryView scope={{ kind: "all" }} filters={filters} />
    </>
  );
}
