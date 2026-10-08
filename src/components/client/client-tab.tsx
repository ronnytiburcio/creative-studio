import { getDb } from "@/lib/db";
import { clientTabData } from "@/lib/hooks/client";
import { channelTestOrder } from "@/lib/meta/test-order";
import { ClientTabView } from "./client-tab-view";
import { TestOrderCard } from "./test-order-card";

/**
 * Client tab (Phase 4 G1, server): loads the client's notes, hint, account, folder rules and What works here; Phase 5
 * slice 3 adds the test order card (Lane B clients and Lane C).
 */
export function ClientTab({ code }: { code: string }) {
  const sql = getDb().sqlite;
  const data = clientTabData(sql, code);
  return <ClientTabView data={data} testOrder={<TestOrderCard data={channelTestOrder(sql, code)} />} />;
}
