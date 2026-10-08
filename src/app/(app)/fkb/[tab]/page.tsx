import { notFound } from "next/navigation";
import { ChannelHeader, ChannelMark, FKB_TABS, type TabKey } from "@/components/channel/channel-header";
import { RunningTab } from "@/components/running/running-tab";
import { LibraryView } from "@/components/library/library-view";
import { HooksTab } from "@/components/hooks/hooks-tab";
import { ClientTab } from "@/components/client/client-tab";
import { parseRunningFilters } from "@/lib/meta/running";
import { parseHookFilters } from "@/lib/hooks/queries";
import { FKB_CODE } from "@/lib/hooks/client";
import { parseFilters, sidebarData } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { uiLabels } from "@/lib/ui-labels";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/fkb/[tab]">) {
  const { tab } = await props.params;
  return { title: `${uiLabels().lane.fkb} ${tab[0]?.toUpperCase()}${tab.slice(1)}` };
}

/**
 * Lane C (the company lane, `fkb`, Phase 5): the owner's own company as a third section with one channel. Library (roots in
 * section fkb, added in Settings), Hooks (scored like a Lane B client, rubric v2), Running (its own Meta account,
 * every campaign; Meta leads until its GHL leads carry source fkb-fb-ad) and Client (Lane C's brand notes, hint, What works
 * here). No Shorts tab, no client questions.
 */
export default async function FkbPage(props: PageProps<"/fkb/[tab]">) {
  const { tab } = await props.params;
  if (!FKB_TABS.includes(tab as TabKey)) notFound();
  const lane = sidebarData().sections.find((s) => s.key === "fkb");
  if (!lane) notFound(); // the lane is switched off (Settings > Lanes)
  const sp = await props.searchParams;
  const count = lane.count;
  const L = uiLabels();
  // The lane's own ad account (the Studio config's lanes.fkb.metaAdAccount, seeded once).
  const act = getDb().sqlite.prepare("select a.act_id from ad_accounts a join sections s on s.id = a.section_id where s.key = 'fkb' and a.client_id is null order by a.sort, a.id limit 1").pluck().get() as string | undefined;
  return (
    <>
      <ChannelHeader
        eyebrow="Own brand"
        title={L.lane.fkb === L.laneFull.fkb ? L.lane.fkb : `${L.lane.fkb} · ${L.laneFull.fkb}`}
        mark={<ChannelMark letter={L.laneMark.fkb} />}
        meta={
          <>
            {L.laneAbout.fkb && (
              <>
                <span>{L.laneAbout.fkb}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="tabular">{count.toLocaleString()} files</span>
            {act && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono text-[12px]">{act}</span>
              </>
            )}
          </>
        }
        basePath="/fkb"
        tabs={FKB_TABS}
        active={tab as TabKey}
      />
      {tab === "running" ? (
        <RunningTab scope={{ kind: "fkb" }} filters={parseRunningFilters(sp)} channelLabel={L.lane.fkb} />
      ) : tab === "library" ? (
        <LibraryView scope={{ kind: "fkb" }} filters={parseFilters(sp)} />
      ) : tab === "hooks" ? (
        <HooksTab scope={{ kind: "fkb" }} filters={parseHookFilters(sp)} channelLabel={L.lane.fkb} importClient={null} />
      ) : (
        <ClientTab code={FKB_CODE} />
      )}
    </>
  );
}
