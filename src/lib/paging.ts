/**
 * Page numbers for the long lists (client safe). The owner, 2026-10-06: the Library, the Hooks tab and the Running tab show
 * LIST_PAGE_SIZE items a page with page links (src/components/shell/pager.tsx) instead of an endless scroll / Show more.
 * The page lives in the URL as `page` (1-based); every filter change drops it (back to page 1).
 */
export const LIST_PAGE_SIZE = 15;

export function pageCount(total: number, size = LIST_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/** The `page` query value -> a 1-based page (anything else = 1). Clamp it to the list with clampPage once the total is known. */
export function parsePage(v: string | null | undefined): number {
  return /^\d{1,6}$/.test(v ?? "") ? Math.max(1, Number(v)) : 1;
}

/** A page past the end (rows were removed, a filter shrank the list) shows the last page. */
export function clampPage(page: number, total: number, size = LIST_PAGE_SIZE): number {
  return Math.min(Math.max(1, page), pageCount(total, size));
}

/** The page holding the row at this 0-based index. */
export function pageOfIndex(index: number, size = LIST_PAGE_SIZE): number {
  return Math.floor(Math.max(0, index) / size) + 1;
}
