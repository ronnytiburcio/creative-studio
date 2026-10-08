/** Lane A Shorts list sorts (client safe: no imports; Phase 5 slice 4). */
export const SHORT_SORTS = ["newest", "views", "viewed"] as const;
export type ShortSort = (typeof SHORT_SORTS)[number];
export const SHORT_SORT_LABEL: Record<ShortSort, string> = { newest: "Newest", views: "Views", viewed: "Avg % viewed" };
