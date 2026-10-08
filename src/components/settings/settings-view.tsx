"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bot,
  Cpu,
  Database,
  FolderPlus,
  HardDrive,
  KeyRound,
  Layers,
  Megaphone,
  Scissors,
  Plus,
  ScanEye,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { driveWords } from "@/lib/drive-mode";
import { useStatus } from "@/components/shell/status-provider";
import { addIgnore, addRoot, removeIgnore, removeTagRule, saveTagRule, setRootEnabled } from "@/app/actions";
import { EngineChecks } from "./engine-checks";
import { AiCard } from "./ai-card";
import { ClaudeCard } from "./claude-card";
import { MetaCard } from "./meta-card";
import { ThresholdsForm } from "./thresholds-form";
import { YouTubeCard } from "./youtube-card";
import type { YtSummary } from "@/lib/youtube/store";
import type { FlagThresholds } from "@/lib/meta/flags";
import type { CalibrationMinimums } from "@/lib/calibration/stats";
import type { KeyStatus } from "@/lib/config";
import type { MetaAccountView } from "@/lib/meta/store";
import { PresenceLine } from "./presence-line";
import { ClientsCard, LanesCard } from "./clients-lanes";
import type { AdminClientRow, AdminLaneRow } from "@/lib/clients-admin";
import { useLabels } from "@/components/shell/labels-provider";

type Root = { id: number; path: string; enabled: boolean; section: string; count: number; missing: number; hidden: number };
type Rule = { id: number; glob: string; codes: string[] };
type ClientLite = { code: string; short: string };

function Card({
  title,
  desc,
  icon: Icon,
  children,
  aside,
  id,
}: {
  title: string;
  desc?: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  aside?: React.ReactNode;
  /** Anchor (the Client tab links to #tag-rules). */
  id?: string;
}) {
  return (
    <section id={id} className="scroll-mt-4 rounded-[12px] border border-border bg-card">
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px]">{title}</h2>
          {desc && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{desc}</p>}
        </div>
        {aside}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "warn" }) {
  return (
    <div className="rounded-[12px] border border-border bg-card px-4 py-3.5">
      <div className="text-[12px] font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-[20px] font-semibold tracking-[-0.02em] tabular", tone === "warn" && "text-brand-text")}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{sub}</div>}
    </div>
  );
}


function ago(s: number | null) {
  if (s == null) return "never";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function SettingsView({
  roots,
  ignores,
  rules,
  clients,
  keys,
  paths,
  cacheSize,
  metaAccounts,
  thresholds,
  youtube,
  shortsGate,
  adminClients,
  lanes,
}: {
  /** Settings > Clients / Lanes (Creative Studio 1b). */
  adminClients: AdminClientRow[];
  lanes: AdminLaneRow[];
  /** Phase 7 B3: the Shorts board's hook gate. */
  shortsGate: number;
  youtube: { summary: YtSummary; paths: { secret: string; token: string; redirect: string }; result: string | null };
  roots: Root[];
  ignores: { id: number; pattern: string }[];
  rules: Rule[];
  clients: ClientLite[];
  keys: KeyStatus;
  paths: { db: string; cache: string; logs: string; env: string; meta: string; fkbMeta: string; port: number };
  cacheSize: string;
  metaAccounts: MetaAccountView[];
  thresholds: { flags: FlagThresholds; calibration: CalibrationMinimums };
}) {
  const L = useLabels();
  const router = useRouter();
  const { drive, worker } = useStatus();
  const driveState = driveWords(drive.mode)[drive.mounted ? "up" : "down"];
  const [pending, start] = useTransition();
  const [rootPath, setRootPath] = useState("");
  const [rootSection, setRootSection] = useState<"rtm" | "fkbpros" | "fkb">("fkbpros");
  const [pattern, setPattern] = useState("");
  const [newGlob, setNewGlob] = useState("");
  const [newCodes, setNewCodes] = useState<string[]>([]);
  const short = (code: string) => clients.find((c) => c.code === code)?.short ?? code;

  const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else {
        if (r.message) toast.success(r.message);
        after?.();
        router.refresh();
      }
    });

  return (
    <div className="mx-auto max-w-[1040px] px-6 pt-6 pb-16">
      <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">Studio</div>
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Settings</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Roots are read only. The one exception: generated outputs are saved into Studio Generated on {drive.label}. Nothing else is ever written, moved, renamed or deleted.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Drive"
          value={driveState.charAt(0).toUpperCase() + driveState.slice(1)}
          sub={drive.path}
          tone={drive.mounted ? undefined : "warn"}
        />
        <Stat
          label="Worker"
          value={worker.alive ? (worker.scanState === "scanning" ? "Scanning" : "Running") : "Offline"}
          sub={`Heartbeat ${ago(worker.ageS)}`}
          tone={worker.alive ? undefined : "warn"}
        />
        <Stat
          label="Queue"
          value={(worker.pending + worker.running).toLocaleString()}
          sub={worker.currentFile ?? (worker.error ? `${worker.error} errors` : "idle")}
        />
        <Stat label="Cache size" value={cacheSize} sub={paths.cache} />
      </div>

      <div className="mt-6 space-y-5">
        <Card
          id="lanes"
          title="Lanes"
          desc="The three channel groups: your own brand, your clients and one standalone company. Rename them, pick a color, or switch the brand or company lane off (nothing is deleted)."
          icon={Layers}
        >
          <LanesCard lanes={lanes} />
        </Card>

        <Card
          id="clients"
          title="Clients"
          desc="Each client's ad account, which campaigns and leads count, and its folder. Hidden clients leave the sidebar and the daily Meta read; everything they have stays."
          icon={Users}
        >
          <ClientsCard clients={adminClients} laneName={lanes.find((l) => l.key === "fkbpros")?.name ?? "Clients"} />
        </Card>

        <Card id="roots" title="Roots" desc="Folders the worker indexes. Changes apply within 5 seconds." icon={HardDrive}>
          <div className="divide-y divide-border">
            {roots.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className={cn("truncate font-mono text-[12.5px]", !r.enabled && "text-muted-foreground line-through")}>
                    {r.path}
                  </div>
                  <div className="mt-0.5 flex gap-2 text-[12px] text-muted-foreground">
                    <span className="rounded bg-muted px-1.5 font-medium text-foreground/80">{r.section}</span>
                    <span className="tabular">{r.count.toLocaleString()} files</span>
                    {r.missing > 0 && <span className="text-brand-text tabular">{r.missing} missing</span>}
                    {r.hidden > 0 && <span className="tabular">{r.hidden.toLocaleString()} hidden by ignore patterns</span>}
                  </div>
                </div>
                <Switch
                  checked={r.enabled}
                  disabled={pending}
                  onCheckedChange={(v) => act(() => setRootEnabled({ id: r.id, enabled: v }))}
                  className="data-[state=checked]:bg-brand"
                  aria-label={`${r.enabled ? "Disable" : "Enable"} ${r.path}`}
                />
              </div>
            ))}
          </div>
          <form
            className="mt-3 flex flex-wrap gap-2 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => addRoot({ path: rootPath, section: rootSection }), () => setRootPath(""));
            }}
          >
            <Input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="/Volumes/My Drive/Some Folder"
              className="h-8 min-w-[280px] flex-1 font-mono text-[12.5px]"
              aria-label="Folder path"
            />
            <Select value={rootSection} onValueChange={(v) => setRootSection(v as "rtm" | "fkbpros" | "fkb")}>
              <SelectTrigger className="h-8 w-[140px]" aria-label="Section">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rtm">{L.lane.rtm}</SelectItem>
                <SelectItem value="fkbpros">{L.lane.fkbpros}</SelectItem>
                <SelectItem value="fkb">{L.lane.fkb}</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={pending || !rootPath.trim()}>
              <FolderPlus /> Add root
            </Button>
          </form>
          <p
            className={cn(
              "mt-2 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed",
              rootSection === "fkb" ? "bg-brand/10 text-foreground" : "bg-muted/60 text-muted-foreground",
            )}
            role="note"
          >
            <span className="font-medium">{L.lane.fkb} folders:</span> Google Drive folders must be marked Available offline (or copied to {drive.label}), or
            indexing forces every file to download.
          </p>
        </Card>

        <Card
          title="Generation engines"
          desc="What Generate can use right now. Unavailable engines are disabled in the Generate panel with the reason."
          icon={Sparkles}
        >
          <EngineChecks />
        </Card>

        <Card
          title="AI"
          desc="Describe runs on this Mac for free: the Ollama vision model writes what each image or video shows (from the cached previews, never the drive) and whisper.cpp transcribes the first 15 s of every video."
          icon={ScanEye}
        >
          <AiCard shortsGate={shortsGate} envFile={paths.env} />
        </Card>

        <Card
          id="claude"
          title="Claude"
          desc="The claude CLI writes hook variants, Shorts moments and ad copy drafts on your Claude subscription."
          icon={Bot}
        >
          <ClaudeCard />
        </Card>

        <Card
          id="meta"
          title="Meta and GHL"
          desc={`The Running tab's numbers: every client's ${L.campaignWord ? `${L.campaignWord} ` : ""}campaign and ${L.lane.fkb}'s own account, read once a day, plus GHL ad leads. Read only.`}
          icon={Megaphone}
        >
          <MetaCard accounts={metaAccounts} keys={keys} paths={{ meta: paths.meta, fkb: paths.fkbMeta }} />
          <div className="mt-4">
            <ThresholdsForm flags={thresholds.flags} calibration={thresholds.calibration} />
          </div>
        </Card>

        <Card
          id="youtube"
          title="YouTube"
          desc={`${L.lane.rtm}'s Shorts results: views, average % viewed, likes and subscribers per Short, read once a day and matched to your ${L.lane.rtm} videos and their hooks.`}
          icon={Scissors}
        >
          <YouTubeCard summary={youtube.summary} paths={youtube.paths} result={youtube.result} />
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card
            title="Ignore patterns"
            desc="dir/ skips a folder anywhere, .* skips dotfiles, globs match a name. Matching files are hidden, not deleted, so un-ignoring restores them with their tags."
            icon={X}
          >
            <div className="flex flex-wrap gap-1.5">
              {ignores.map((p) => (
                <span key={p.id} className="inline-flex h-7 items-center gap-1 rounded-lg bg-muted pr-1 pl-2 font-mono text-[12px]">
                  {p.pattern}
                  <button
                    type="button"
                    className="grid size-5 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                    onClick={() => act(() => removeIgnore({ id: p.id }))}
                    aria-label={`Remove ${p.pattern}`}
                    disabled={pending}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                act(() => addIgnore({ pattern }), () => setPattern(""));
              }}
            >
              <Input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="renders/ or *.tmp"
                className="h-8 font-mono text-[12.5px]"
                aria-label="Ignore pattern"
              />
              <Button type="submit" variant="outline" disabled={pending || !pattern.trim()}>
                <Plus /> Add
              </Button>
            </form>
          </Card>

          <Card title="API keys" desc="Presence only. Values are never shown or sent to the browser." icon={KeyRound}>
            <div className="space-y-2">
              <PresenceLine size="md" ok={keys.typesafe} label="Jev (TYPESAFE_API_KEY)" note={paths.env} />
              <PresenceLine
                size="md"
                ok={keys.meta}
                label={`Meta, ${L.campaignWord ?? L.lane.fkbpros} (META_ACCESS_TOKEN)`}
                note={keys.metaFileExists ? `${paths.meta} · the Clients lane accounts` : `${paths.meta} not found`}
              />
              <PresenceLine
                size="md"
                ok={keys.fkbMeta}
                label={`Meta, ${L.lane.fkb} (META_ACCESS_TOKEN)`}
                note={keys.fkbMetaFileExists ? `${paths.fkbMeta} · ${L.lane.fkb}'s own account` : `${paths.fkbMeta} not found`}
              />
              <PresenceLine size="md" ok={keys.ghl} label="GHL (GHL_API_KEY)" note={`${paths.meta} · ad leads`} />
            </div>
            <p className="mt-4 text-[12px] text-muted-foreground">
              The Review threshold, the daily Jev cap and Jev spend live in the AI card above.
            </p>
          </Card>
        </div>

        <Card
          id="tag-rules"
          title="Tag rules"
          desc={`Folder globs (relative to the root; only * ** ? are wildcards, parentheses are literal) that tag files to clients. Files with no client are Shared. Manual tags are never overwritten.`}
          icon={Database}
        >
          <div className="divide-y divide-border">
            {rules.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <code className="min-w-[260px] flex-1 truncate font-mono text-[12.5px]" title={r.glob}>
                  {r.glob}
                </code>
                <div className="flex flex-wrap items-center gap-1">
                  {r.codes.map((c) => (
                    <span key={c} className="inline-flex h-6 items-center gap-1 rounded-md bg-muted pr-0.5 pl-1.5 text-[12px] font-medium">
                      {short(c)}
                      <button
                        type="button"
                        className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                        onClick={() => act(() => saveTagRule({ id: r.id, glob: r.glob, codes: r.codes.filter((x) => x !== c) }))}
                        aria-label={`Remove ${c} from rule`}
                        disabled={pending}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  <ClientPicker
                    clients={clients}
                    selected={r.codes}
                    onPick={(code) => act(() => saveTagRule({ id: r.id, glob: r.glob, codes: [...r.codes, code] }))}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => act(() => removeTagRule({ id: r.id }))}
                  aria-label="Delete rule"
                  disabled={pending}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          <form
            className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              act(
                () => saveTagRule({ glob: newGlob, codes: newCodes }),
                () => {
                  setNewGlob("");
                  setNewCodes([]);
                },
              );
            }}
          >
            <Input
              value={newGlob}
              onChange={(e) => setNewGlob(e.target.value)}
              placeholder="Client Name - Work Gallery/**"
              className="h-8 min-w-[260px] flex-1 font-mono text-[12.5px]"
              aria-label="Folder glob"
            />
            {newCodes.map((c) => (
              <span key={c} className="inline-flex h-6 items-center gap-1 rounded-md bg-muted pr-0.5 pl-1.5 text-[12px] font-medium">
                {short(c)}
                <button
                  type="button"
                  className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground"
                  onClick={() => setNewCodes(newCodes.filter((x) => x !== c))}
                  aria-label={`Remove ${c}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <ClientPicker clients={clients} selected={newCodes} onPick={(c) => setNewCodes([...newCodes, c])} />
            <Button type="submit" disabled={pending || !newGlob.trim()}>
              <Plus /> Add rule
            </Button>
          </form>
        </Card>

        <Card title="Paths" desc={`Set in ${paths.env} (restart the app and worker after changing).`} icon={Cpu}>
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            <dt className="text-muted-foreground">Database</dt>
            <dd className="truncate font-mono">{paths.db}</dd>
            <dt className="text-muted-foreground">Cache</dt>
            <dd className="truncate font-mono">{paths.cache}</dd>
            <dt className="text-muted-foreground">Logs</dt>
            <dd className="truncate font-mono">{paths.logs}</dd>
            <dt className="text-muted-foreground">Config</dt>
            <dd className="truncate font-mono">{paths.env}</dd>
            <dt className="text-muted-foreground">Address</dt>
            <dd className="font-mono">http://127.0.0.1:{paths.port}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function ClientPicker({
  clients,
  selected,
  onPick,
}: {
  clients: ClientLite[];
  selected: string[];
  onPick: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const avail = clients.filter((c) => !selected.includes(c.code));
  if (!avail.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs">
          <Plus /> Client
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-0">
        <Command>
          <CommandList>
            <CommandGroup>
              {avail.map((c) => (
                <CommandItem
                  key={c.code}
                  value={c.code}
                  onSelect={() => {
                    onPick(c.code);
                    setOpen(false);
                  }}
                >
                  {c.short}
                  <span className="ml-auto text-[11.5px] text-muted-foreground">{c.code}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
