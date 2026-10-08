import { getConfig, keyStatus } from "@/lib/config";
import { formatBytes } from "@/lib/media";
import { getStatus, settingsData } from "@/lib/queries";
import { SettingsView } from "@/components/settings/settings-view";
import { getDb } from "@/lib/db";
import { metaAccounts } from "@/lib/meta/store";
import { calibrationMinimums, flagThresholds } from "@/lib/meta/thresholds";
import { redirectUri, youtubeKeyStatus } from "@/lib/youtube/auth";
import { ytSummary } from "@/lib/youtube/store";
import { shortsGate } from "@/lib/shorts/board";
import { adminClients, adminLanes } from "@/lib/clients-admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage(props: PageProps<"/settings">) {
  const sp = await props.searchParams;
  const ytResult = typeof sp.youtube === "string" && /^[a-z]{1,16}$/.test(sp.youtube) ? sp.youtube : null;
  const cfg = getConfig();
  const data = settingsData();
  const keys = keyStatus(cfg);
  const status = getStatus();
  return (
    <SettingsView
      roots={data.roots.map((r) => ({
        id: r.id,
        path: r.path,
        enabled: Boolean(r.enabled),
        section: r.section_name,
        count: r.n,
        missing: r.missing,
        hidden: r.hidden,
      }))}
      ignores={data.ignores}
      rules={data.rules}
      clients={data.clients.map((c) => ({ code: c.code, short: c.short }))}
      keys={keys}
      paths={{ db: cfg.dbPath, cache: cfg.cacheDir, logs: cfg.logsDir, env: cfg.envFile, meta: cfg.metaEnvFile, fkbMeta: cfg.metaFkbEnvFile, port: cfg.port }}
      metaAccounts={metaAccounts(getDb().sqlite)}
      thresholds={{ flags: flagThresholds(getDb().sqlite), calibration: calibrationMinimums(getDb().sqlite) }}
      youtube={{
        summary: ytSummary(getDb().sqlite, youtubeKeyStatus(cfg)),
        paths: { secret: cfg.youtubeClientSecretFile, token: cfg.youtubeTokenFile, redirect: redirectUri(cfg) },
        result: ytResult,
      }}
      shortsGate={shortsGate(getDb().sqlite)}
      adminClients={adminClients(getDb().sqlite)}
      lanes={adminLanes(getDb().sqlite)}
      cacheSize={status.worker.cacheBytes != null ? formatBytes(status.worker.cacheBytes) : "measuring…"}
    />
  );
}
