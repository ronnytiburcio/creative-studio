import { getDb } from "@/lib/db";
import { listClients } from "@/lib/queries";
import { runningData, type RunningFilters, type RunningScope } from "@/lib/meta/running";
import { RunningView } from "./running-view";

/**
 * Running tab (server, Phase 5 D): the channel's widget numbers, its ads with the selected window's numbers, the client
 * summary table on All clients (Lane B). Reads only what the worker's Meta sync stored; never calls Meta or GHL.
 */
export function RunningTab({ scope, filters, channelLabel }: { scope: RunningScope; filters: RunningFilters; channelLabel: string }) {
  const data = runningData(getDb().sqlite, scope, filters);
  const clients = listClients().map((c) => ({ code: c.code, short: c.short }));
  return <RunningView data={data} channelLabel={channelLabel} clients={clients} />;
}
