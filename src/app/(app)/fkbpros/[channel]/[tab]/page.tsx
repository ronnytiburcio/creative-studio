import { notFound } from "next/navigation";
import {
  ALL_FKB_TABS,
  CLIENT_TABS,
  ChannelHeader,
  ChannelMark,
  ComingSoon,
  type TabKey,
} from "@/components/channel/channel-header";
import { LibraryView } from "@/components/library/library-view";
import { HooksTab } from "@/components/hooks/hooks-tab";
import { ClientTab } from "@/components/client/client-tab";
import { getClient, parseFilters, sidebarData, type Scope } from "@/lib/queries";
import { parseHookFilters } from "@/lib/hooks/queries";
import { RunningTab } from "@/components/running/running-tab";
import { parseRunningFilters } from "@/lib/meta/running";
import { uiLabels } from "@/lib/ui-labels";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/fkbpros/[channel]/[tab]">) {
  const { channel, tab } = await props.params;
  const name = channel === "all" ? `All ${uiLabels().lane.fkbpros}` : (getClient(channel)?.short ?? channel);
  return { title: `${name} ${tab[0]?.toUpperCase()}${tab.slice(1)}` };
}

export default async function FkbChannelPage(props: PageProps<"/fkbpros/[channel]/[tab]">) {
  const { channel, tab } = await props.params;
  const sp = await props.searchParams;
  const filters = parseFilters(sp);
  const L = uiLabels();
  const allB = `All ${L.lane.fkbpros}`;

  if (channel === "all") {
    if (!ALL_FKB_TABS.includes(tab as TabKey)) notFound();
    const side = sidebarData();
    const count = side.sections.find((s) => s.key === "fkbpros")?.count ?? 0;
    return (
      <>
        <ChannelHeader
          eyebrow={L.lane.fkbpros}
          title={allB}
          mark={<ChannelMark letter={L.laneMark.fkbpros} />}
          meta={
            <>
              <span className="tabular">{count.toLocaleString()} files</span>
              <span aria-hidden>·</span>
              <span className="tabular">{side.clients.length} clients</span>
              <span aria-hidden>·</span>
              <span className="tabular">{side.sharedCount.toLocaleString()} shared</span>
            </>
          }
          basePath="/fkbpros/all"
          tabs={ALL_FKB_TABS}
          active={tab as TabKey}
        />
        {tab === "library" ? (
          <LibraryView scope={{ kind: "fkbpros" }} filters={filters} />
        ) : tab === "hooks" ? (
          <HooksTab scope={{ kind: "fkbpros" }} filters={parseHookFilters(sp)} channelLabel={allB} importClient={null} />
        ) : tab === "running" ? (
          <RunningTab scope={{ kind: "fkbpros" }} filters={parseRunningFilters(sp)} channelLabel={allB} />
        ) : (
          <ComingSoon tab={tab as TabKey} />
        )}
      </>
    );
  }

  const client = /^[a-z0-9]{2,32}$/.test(channel) ? getClient(channel) : undefined;
  if (!client || !CLIENT_TABS.includes(tab as TabKey)) notFound();
  const scope: Scope = { kind: "client", code: client.code };
  const rest = client.name.includes(" / ") ? client.name.split(" / ").slice(1).join(" / ") : null;
  return (
    <>
      <ChannelHeader
        eyebrow="Client"
        title={rest ? `${client.short} · ${rest}` : client.short}
        mark={<ChannelMark letter={client.short[0]} variant="sand" />}
        meta={
          <>
            <span className="font-mono text-[12px]">{client.code}</span>
            {client.metaAdAccountId && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono text-[12px]">{client.metaAdAccountId}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span className="tabular">{client.count.toLocaleString()} tagged files</span>
          </>
        }
        basePath={`/fkbpros/${client.code}`}
        tabs={CLIENT_TABS}
        active={tab as TabKey}
      />
      {tab === "library" ? (
        <LibraryView scope={scope} filters={filters} />
      ) : tab === "hooks" ? (
        <HooksTab
          scope={{ kind: "client", code: client.code }}
          filters={parseHookFilters(sp)}
          channelLabel={client.short}
          importClient={{ code: client.code, short: client.short }}
        />
      ) : tab === "client" ? (
        <ClientTab code={client.code} />
      ) : tab === "running" ? (
        <RunningTab scope={{ kind: "client", code: client.code }} filters={parseRunningFilters(sp)} channelLabel={client.short} />
      ) : (
        <ComingSoon tab={tab as TabKey} />
      )}
    </>
  );
}
