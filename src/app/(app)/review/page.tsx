import { listClients, parseReviewScope, reviewCounts, reviewOpenable, reviewQueue, sidebarData } from "@/lib/queries";
import { ReviewView } from "@/components/review/review-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Review queue (Phase 3 slice 2): every asset with an unsure Jev answer, one at a time, keyboard first.
 * `?in=all|rtm|fkbpros|<client code>` filters by section / channel; `?asset=<id>` starts at that file (the drawer's
 * "Needs review" link), also when it is not in the queue.
 */
export default async function ReviewPage(props: PageProps<"/review">) {
  const sp = await props.searchParams;
  const clients = listClients();
  const lanes = sidebarData().sections.filter((l): l is typeof l & { key: "rtm" | "fkbpros" | "fkb" } => ["rtm", "fkbpros", "fkb"].includes(l.key));
  const scope = parseReviewScope(first(sp.in), clients.map((c) => c.code), new Set(lanes.map((l) => l.key)));
  const scopeKey = scope.kind === "client" ? scope.code : scope.kind;
  let ids = reviewQueue(scope);
  const startId = Number(first(sp.asset)) || null;
  if (startId && !ids.includes(startId) && reviewOpenable(startId)) ids = [startId, ...ids];
  return (
    <ReviewView
      key={scopeKey}
      ids={ids}
      startId={startId}
      scope={scopeKey}
      counts={reviewCounts()}
      clients={clients.map((c) => ({ code: c.code, short: c.short, name: c.name }))}
      lanes={lanes.map((l) => ({ key: l.key, name: l.name }))}
    />
  );
}
