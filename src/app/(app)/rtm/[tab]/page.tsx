import { notFound } from "next/navigation";
import { ChannelHeader, ChannelMark, ComingSoon, RTM_TABS, type TabKey } from "@/components/channel/channel-header";
import { LibraryView } from "@/components/library/library-view";
import { HooksTab } from "@/components/hooks/hooks-tab";
import { parseFilters, sidebarData } from "@/lib/queries";
import { parseHookFilters } from "@/lib/hooks/queries";
import { ShortsSection } from "@/components/shorts/shorts-section";
import { BoardSection } from "@/components/shorts/board-section";
import { uiLabels } from "@/lib/ui-labels";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/rtm/[tab]">) {
  const { tab } = await props.params;
  return { title: `${uiLabels().lane.rtm} ${tab[0]?.toUpperCase()}${tab.slice(1)}` };
}

export default async function RtmPage(props: PageProps<"/rtm/[tab]">) {
  const { tab } = await props.params;
  if (!RTM_TABS.includes(tab as TabKey)) notFound();
  const sp = await props.searchParams;
  const filters = parseFilters(sp);
  const lane = sidebarData().sections.find((s) => s.key === "rtm");
  if (!lane) notFound(); // the lane is switched off (Settings > Lanes)
  const count = lane.count;
  const L = uiLabels();
  return (
    <>
      <ChannelHeader
        eyebrow="Organic channel"
        title={L.laneFull.rtm}
        mark={<ChannelMark letter={L.laneMark.rtm} />}
        meta={
          <>
            <span className="tabular">{count.toLocaleString()} files</span>
            {L.laneAbout.rtm && (
              <>
                <span aria-hidden>·</span>
                <span>{L.laneAbout.rtm}</span>
              </>
            )}
          </>
        }
        basePath="/rtm"
        tabs={RTM_TABS}
        active={tab as TabKey}
      />
      {tab === "library" ? (
        <LibraryView scope={{ kind: "rtm" }} filters={filters} />
      ) : tab === "hooks" ? (
        <HooksTab scope={{ kind: "rtm" }} filters={parseHookFilters(sp)} channelLabel={L.lane.rtm} importClient={null} />
      ) : tab === "shorts" ? (
        <>
          {/* Phase 5 slice 4: YouTube Shorts results, then the Phase 6 Shorts board. */}
          <ShortsSection searchParams={sp} />
          <BoardSection searchParams={sp} />
        </>
      ) : (
        <ComingSoon tab={tab as TabKey} />
      )}
    </>
  );
}
