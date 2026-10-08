"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, EyeOff, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PRIMARY_BTN } from "@/components/hooks/ui";
import { addClientAction, editClientAction, editLaneAction, setClientHiddenAction } from "@/app/actions";
import type { AdminClientRow, AdminLaneRow } from "@/lib/clients-admin";
import type { CampaignMode, LeadsMode } from "@/lib/studio-config";

type Act = () => Promise<{ ok: boolean; error?: string; message?: string }>;

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (fn: Act, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else {
        if (r.message) toast.success(r.message);
        after?.();
        router.refresh();
      }
    });
  return { pending, act };
}

const CAMPAIGN_LABEL: Record<CampaignMode, string> = {
  all: "Every campaign",
  one: "One campaign",
  state_json: "From state.json",
};
const LEADS_LABEL: Record<LeadsMode, string> = { meta: "Meta leads", ghl: "GHL leads", auto: "Meta, then GHL" };

function campaignText(c: AdminClientRow) {
  return c.campaignMode === "one" ? `Campaign ${c.campaignId ?? "?"}` : CAMPAIGN_LABEL[c.campaignMode];
}

function leadsText(c: AdminClientRow) {
  return c.leadsMode === "meta" ? LEADS_LABEL.meta : `${LEADS_LABEL[c.leadsMode]} · ${c.ghlSource || `${c.code}-fb-ad`}`;
}

/**
 * Settings > Lanes (Creative Studio 1b): the three lanes' names, colors and on / off. Lane B (clients) is always on; a
 * switched-off lane leaves the sidebar, cmd+K, Review, coverage and the Meta sync, and keeps every row.
 */
export function LanesCard({ lanes }: { lanes: AdminLaneRow[] }) {
  return (
    <div className="divide-y divide-border">
      {lanes.map((l) => (
        <LaneRow key={l.key} lane={l} />
      ))}
    </div>
  );
}

function LaneRow({ lane }: { lane: AdminLaneRow }) {
  const { pending, act } = useAct();
  const [name, setName] = useState(lane.name);
  const [color, setColor] = useState(lane.color ?? "#999999");
  const dirty = name !== lane.name || color.toLowerCase() !== (lane.color ?? "#999999").toLowerCase();
  const save = (enabled: boolean) => act(() => editLaneAction({ key: lane.key, name, color, enabled }));
  return (
    <form
      className="flex flex-wrap items-center gap-2 py-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        save(lane.enabled);
      }}
    >
      <span className="size-3 shrink-0 rounded-full border border-border" style={{ background: color }} aria-hidden />
      <span className="w-[72px] shrink-0 font-mono text-[12px] text-muted-foreground">{lane.key}</span>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={40}
        className="h-8 min-w-0 flex-1 basis-[140px] text-[13px]"
        aria-label={`Name of the ${lane.key} lane`}
      />
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-card p-0.5"
        aria-label={`Color of the ${lane.key} lane`}
      />
      <Button type="submit" variant="outline" size="sm" disabled={pending || !dirty || !name.trim()}>
        Save
      </Button>
      <span className="ml-auto flex items-center gap-2 text-[12.5px] text-muted-foreground" title={lane.canDisable ? undefined : "The clients lane is always on"}>
        {lane.enabled ? "On" : "Off"}
        <Switch
          checked={lane.enabled}
          disabled={pending || !lane.canDisable}
          onCheckedChange={(v) => save(v)}
          className="data-[state=checked]:bg-brand"
          aria-label={`${lane.enabled ? "Switch off" : "Switch on"} the ${lane.name} lane`}
        />
      </span>
    </form>
  );
}

type Draft = {
  code: string;
  name: string;
  metaAdAccount: string;
  hint: string;
  folder: string;
  campaignMode: CampaignMode;
  campaignId: string;
  leadsMode: LeadsMode;
  ghlSource: string;
  sort: string;
};

const EMPTY_DRAFT: Draft = {
  code: "",
  name: "",
  metaAdAccount: "",
  hint: "",
  folder: "",
  campaignMode: "all",
  campaignId: "",
  leadsMode: "meta",
  ghlSource: "",
  sort: "",
};

function draftOf(c: AdminClientRow): Draft {
  return {
    code: c.code,
    name: c.name,
    metaAdAccount: c.metaAdAccount ?? "",
    hint: c.hint ?? "",
    folder: c.folder ?? "",
    campaignMode: c.campaignMode,
    campaignId: c.campaignId ?? "",
    leadsMode: c.leadsMode,
    ghlSource: c.ghlSource ?? "",
    sort: String(c.sort),
  };
}

/**
 * Settings > Clients (Creative Studio 1b): every client (hidden ones too), Add, Edit, Hide / Unhide. The code is set once.
 * Hiding keeps every file, hook, order and number; the client just leaves the sidebar, scopes, cmd+K, Review, coverage
 * and the Meta sync.
 */
export function ClientsCard({ clients, laneName }: { clients: AdminClientRow[]; laneName: string }) {
  const { pending, act } = useAct();
  const [editing, setEditing] = useState<{ mode: "add" | "edit"; draft: Draft; locked: boolean } | null>(null);
  return (
    <div>
      {clients.length === 0 ? (
        <p className="rounded-lg bg-muted/60 px-3 py-3 text-[13px] text-muted-foreground">
          No clients yet. Add one, or list them in the Studio config file (they are added once, then edited here).
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {clients.map((c) => (
            <li key={c.code} className={cn("flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5", c.hidden && "opacity-60")}>
              <div className="min-w-0 flex-1 basis-[220px]">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="truncate text-[13.5px] font-medium">{c.name}</span>
                  <span className="font-mono text-[12px] text-muted-foreground">{c.code}</span>
                  {c.hidden && <span className="rounded bg-muted px-1.5 text-[11.5px] font-medium">Hidden</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
                  <span className="rounded bg-muted px-1.5 font-medium text-foreground/80">{c.lane}</span>
                  <span className="font-mono">{c.metaAdAccount ?? "no ad account"}</span>
                  <span>{campaignText(c)}</span>
                  <span>{leadsText(c)}</span>
                  {c.folder && <span className="truncate">Folder: {c.folder}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setEditing({ mode: "edit", draft: draftOf(c), locked: c.accountLocked })}
                  aria-label={`Edit ${c.name}`}
                >
                  <Pencil /> Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => act(() => setClientHiddenAction({ code: c.code, hidden: !c.hidden }))}
                  aria-label={`${c.hidden ? "Unhide" : "Hide"} ${c.name}`}
                >
                  {c.hidden ? <Eye /> : <EyeOff />} {c.hidden ? "Unhide" : "Hide"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 border-t border-border pt-3">
        <Button variant="outline" disabled={pending} onClick={() => setEditing({ mode: "add", draft: EMPTY_DRAFT, locked: false })}>
          <Plus /> Add client
        </Button>
      </div>
      {editing && (
        <ClientDialog
          key={`${editing.mode}-${editing.draft.code}`}
          mode={editing.mode}
          initial={editing.draft}
          accountLocked={editing.locked}
          laneName={laneName}
          pending={pending}
          onClose={() => setEditing(null)}
          onSave={(d) =>
            act(
              () =>
                (editing.mode === "add" ? addClientAction : editClientAction)({
                  code: d.code.trim(),
                  name: d.name,
                  metaAdAccount: d.metaAdAccount.trim(),
                  hint: d.hint,
                  folder: d.folder.trim(),
                  campaignMode: d.campaignMode,
                  campaignId: d.campaignMode === "one" ? d.campaignId.trim() : "",
                  leadsMode: d.leadsMode,
                  ghlSource: d.ghlSource.trim(),
                  ...(d.sort.trim() !== "" && Number.isFinite(Number(d.sort)) ? { sort: Number(d.sort) } : {}),
                }),
              () => setEditing(null),
            )
          }
        />
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="text-[12.5px] font-medium">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11.5px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

function ClientDialog({
  mode,
  initial,
  accountLocked,
  laneName,
  pending,
  onClose,
  onSave,
}: {
  mode: "add" | "edit";
  initial: Draft;
  accountLocked: boolean;
  laneName: string;
  pending: boolean;
  onClose: () => void;
  onSave: (d: Draft) => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const code = d.code.trim() || "<code>";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add a client" : `Edit ${initial.name}`}</DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? `A new client in ${laneName}. The code is set once and never changes.`
              : "The code never changes. Hiding the client (instead of editing it away) keeps its files, hooks and numbers."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(d);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field label="Code" hint={mode === "add" ? "2 to 32 lowercase letters or digits." : "Set when the client was added."}>
              <Input
                value={d.code}
                onChange={(e) => set("code", e.target.value.toLowerCase())}
                disabled={mode === "edit"}
                maxLength={32}
                className="h-8 font-mono text-[12.5px]"
                autoFocus={mode === "add"}
                required
              />
            </Field>
            <Field label="Name" hint='"Short / longer" shows the part before the slash in the sidebar.'>
              <Input value={d.name} onChange={(e) => set("name", e.target.value)} maxLength={80} className="h-8 text-[13px]" required />
            </Field>
          </div>
          <Field
            label="Meta ad account"
            hint={accountLocked ? "This account already has synced numbers, so it cannot change. Add the new account as a new client (with a new code)." : "act_ followed by digits. Empty = no Meta numbers."}
          >
            <Input
              value={d.metaAdAccount}
              onChange={(e) => set("metaAdAccount", e.target.value)}
              disabled={accountLocked}
              placeholder="act_100000000000001"
              className="h-8 font-mono text-[12.5px]"
            />
          </Field>
          <Field label="Who they are" hint="One line for the AI: brand, place, services. Helps it tag files to this client.">
            <Input value={d.hint} onChange={(e) => set("hint", e.target.value)} maxLength={300} className="h-8 text-[13px]" />
          </Field>
          <Field label="Folder" hint="Optional: a folder in the clients folder holding the approved copy doc and Static Ads. Empty = Import approved copy is off.">
            <Input value={d.folder} onChange={(e) => set("folder", e.target.value)} maxLength={120} className="h-8 text-[13px]" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Campaigns" hint="Which campaigns the daily Meta read counts.">
              <Select value={d.campaignMode} onValueChange={(v) => set("campaignMode", v as CampaignMode)}>
                <SelectTrigger className="h-8 w-full" aria-label="Campaigns">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{CAMPAIGN_LABEL.all}</SelectItem>
                  <SelectItem value="one">{CAMPAIGN_LABEL.one}</SelectItem>
                  <SelectItem value="state_json">{CAMPAIGN_LABEL.state_json}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {d.campaignMode === "one" && (
              <Field label="Campaign id">
                <Input value={d.campaignId} onChange={(e) => set("campaignId", e.target.value)} inputMode="numeric" className="h-8 font-mono text-[12.5px]" required />
              </Field>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Leads" hint={d.leadsMode === "meta" ? "Meta's own lead count. No GHL needed." : d.leadsMode === "ghl" ? "GHL contacts with this source." : "Meta leads until a GHL contact carries the source, then GHL."}>
              <Select value={d.leadsMode} onValueChange={(v) => set("leadsMode", v as LeadsMode)}>
                <SelectTrigger className="h-8 w-full" aria-label="Leads">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">{LEADS_LABEL.meta}</SelectItem>
                  <SelectItem value="ghl">{LEADS_LABEL.ghl}</SelectItem>
                  <SelectItem value="auto">{LEADS_LABEL.auto}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {d.leadsMode !== "meta" && (
              <Field label="GHL source" hint={`Empty = ${code}-fb-ad`}>
                <Input value={d.ghlSource} onChange={(e) => set("ghlSource", e.target.value)} maxLength={64} className="h-8 font-mono text-[12.5px]" />
              </Field>
            )}
          </div>
          <Field label="Sort" hint="Sidebar order (lower first).">
            <Input value={d.sort} onChange={(e) => set("sort", e.target.value)} inputMode="numeric" className="h-8 w-24 text-[13px] tabular" />
          </Field>
          <DialogFooter className="pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className={PRIMARY_BTN} disabled={pending || !d.name.trim() || (mode === "add" && !d.code.trim())}>
              {mode === "add" ? "Add client" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
