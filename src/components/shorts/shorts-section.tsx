import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { youtubeKeyStatus } from "@/lib/youtube/auth";
import { SHORT_SORTS, shortsList, ytSummary, type ShortSort } from "@/lib/youtube/store";
import { BEFORE_KIT, channelViewMedian, groupMedians, kitShorts, kitTests, kitTagOf } from "@/lib/shorts/kit";
import { ShortsView } from "./shorts-view";

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

/**
 * Lane A Shorts tab, "YouTube Shorts" results (server, Phase 5 slice 4, PHASE-5 I3): every Short of the connected channel
 * with its latest lifetime numbers, the linked file and that file's hook. Reads only what the worker's YouTube sync
 * stored; never calls YouTube. URL keys: `ssort` (newest | views | viewed), `hook` (only the Shorts carrying that hook),
 * `kit` (Phase 7 D3: `before` | `v<N>`, the matched file's kit note group). Each row also carries its Kit tag, the
 * channel median "% viewed" and, for a kit test reel, its result against the version's no-test median.
 */
export function ShortsSection({ searchParams }: { searchParams: SP }) {
  const sql = getDb().sqlite;
  const sortRaw = one(searchParams, "ssort");
  const sort: ShortSort = SHORT_SORTS.includes(sortRaw as ShortSort) ? (sortRaw as ShortSort) : "newest";
  const hookRaw = one(searchParams, "hook");
  const hookId = hookRaw && /^\d{1,9}$/.test(hookRaw) ? Number(hookRaw) : null;
  const kitRaw = one(searchParams, "kit");
  const kitFilter = kitRaw && /^(before|v\d{1,4})$/.test(kitRaw) ? kitRaw : null;
  const summary = ytSummary(sql, youtubeKeyStatus(getConfig()));
  const all = summary.keys.connected || summary.shorts ? shortsList(sql, sort, hookId) : [];
  const ks = all.length ? kitShorts(sql) : [];
  const byVideo = new Map(ks.map((k) => [k.videoId, k]));
  const tests = new Map(kitTests(ks).tests.map((t) => [t.videoId, t]));
  const rows = all
    .map((r) => ({ ...r, kit: byVideo.get(r.videoId)?.kit ?? kitTagOf(null), test: tests.get(r.videoId) ?? null }))
    .filter((r) => !kitFilter || r.kit.group === kitFilter);
  return (
    <ShortsView
      rows={rows}
      sort={sort}
      hookId={hookId}
      kitFilter={kitFilter}
      groups={ks.length ? groupMedians(ks) : []}
      channelMedian={channelViewMedian(ks)}
      summary={summary}
      beforeKit={BEFORE_KIT}
    />
  );
}
