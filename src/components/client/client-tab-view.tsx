"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpRight, Check, FolderTree, Pencil, Pin, PinOff, Plus, Save, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  addWorkAction,
  editWorkAction,
  moveWorkAction,
  pinHookAction,
  removeWorkAction,
  saveBrandNotesAction,
  saveClientHintAction,
} from "@/app/actions";
import type { ClientTabData, WorkItem } from "@/lib/hooks/client";
import { DraftBadge, EyebrowCard as Card, PRIMARY_BTN } from "@/components/hooks/ui";

type Result = { ok: boolean; error?: string; message?: string };

const iconBtn =
  "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40";

/** Why a pinned hook no longer rides along (see worksLines). */
const STALE_PIN: Record<"archived" | "hidden" | "moved", string> = {
  archived: "Archived.",
  hidden: "Its video is hidden (missing, ignored or in a disabled folder).",
  moved: "No longer in this channel (its video's client tag changed).",
};

/**
 * The Client tab: brand notes, Jev hint, What works here, ad account + folder rules (read only). Lane C's (Phase 5 slice 2)
 * shows its Library folders and where its leads come from instead of folder rules.
 */
export function ClientTabView({ data, testOrder }: { data: ClientTabData; testOrder?: React.ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<Result>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "Failed");
        return;
      }
      if (r.message) toast.success(r.message);
      after?.();
      router.refresh();
    });

  // Brand notes + hint: local drafts, reset when the saved value changes (after a save + refresh).
  const [notes, setNotes] = useState(data.brandNotes);
  const [prevNotes, setPrevNotes] = useState(data.brandNotes);
  if (data.brandNotes !== prevNotes) {
    setPrevNotes(data.brandNotes);
    setNotes(data.brandNotes);
  }
  const [hint, setHint] = useState(data.hint);
  const [prevHint, setPrevHint] = useState(data.hint);
  if (data.hint !== prevHint) {
    setPrevHint(data.hint);
    setHint(data.hint);
  }
  const notesDirty = notes.trim() !== data.brandNotes.trim();
  const hintDirty = hint.replace(/\s+/g, " ").trim() !== data.hint.trim();
  const saved = data.brandNotesSavedAt != null;
  const fkb = data.kind === "fkb";

  return (
    <div className="px-6 pt-5 pb-16">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card
            title="Brand notes"
            eyebrow="Notes"
            aside={<DraftBadge savedAt={data.brandNotesSavedAt} />}
          >
            <p className="mb-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
              One plain line per note: who {data.short} is, what they do and where, what the ads may and may not claim. Rides along on every{" "}
              {data.short} hook Jev scores{fkb ? ` (${data.short} speaks as itself)` : ""}.{" "}
              {saved ? "" : "Seeded as a draft from the business profile; saving marks them checked. "}
              Saving never rescores: the Hooks tab shows &quot;Notes changed&quot; with a Score again button.
            </p>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={12}
              maxLength={4000}
              className="min-h-[240px] font-[inherit] text-[13.5px] leading-relaxed"
              aria-label={`${data.short} brand notes`}
            />
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground tabular">
                {notes.split(/\r?\n/).filter((l) => l.trim()).length} lines
              </span>
              {notesDirty && (
                <Button variant="ghost" size="sm" className="ml-auto" disabled={pending} onClick={() => setNotes(data.brandNotes)}>
                  Revert
                </Button>
              )}
              <Button
                size="sm"
                className={cn(PRIMARY_BTN, !notesDirty && "ml-auto")}
                disabled={pending || (!notesDirty && saved)}
                onClick={() => run(() => saveBrandNotesAction({ code: data.code, body: notes }))}
              >
                <Save /> {notesDirty || saved ? "Save notes" : "Looks right, save"}
              </Button>
            </div>
          </Card>

          <Card title="Jev hint" eyebrow="One line">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (hintDirty) run(() => saveClientHintAction({ code: data.code, hint }));
              }}
            >
              <Input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={300} aria-label={`${data.short} Jev hint`} className="text-[13.5px]" />
              <Button type="submit" size="sm" className={PRIMARY_BTN} disabled={pending || !hintDirty}>
                <Save /> Save
              </Button>
            </form>
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
              {fkb
                ? `Who ${data.short} is, in one line. Hook scoring reads it (${data.short} files are never asked which client they belong to, so classify does not).`
                : `Who ${data.short} is, in one line. Classify reads it to decide whether a file is ${data.short}'s, and hook scoring reads it too. Changing it does not re-file files already classified (Classify again on a file re-files it with the new hint).`}
            </p>
          </Card>
        </div>

        <div className="space-y-5">
          {testOrder}
          <WhatWorks code={data.code} short={data.short} works={data.works} pending={pending} run={run} />

          <Card title="Account and folders" eyebrow="Read only">
            <div className="grid grid-cols-[140px_1fr] gap-y-1.5 text-[13px]">
              <span className="text-muted-foreground">{fkb ? "Section" : "Client code"}</span>
              <span className="font-mono text-[12.5px]">{data.code}</span>
              <span className="text-muted-foreground">Meta ad account</span>
              <span className="font-mono text-[12.5px]">{data.metaAdAccountId ?? "none"}</span>
              {fkb && (
                <>
                  <span className="text-muted-foreground">Lead source</span>
                  <span className="text-[12.5px] leading-relaxed">
                    {data.leadsSource === "ghl" ? "GHL leads" : "Meta leads"}. {data.short}&apos;s CPL uses Meta leads while its GHL leads carry no ad
                    source; the first GHL lead with that source switches {data.short} to GHL leads by itself.
                  </span>
                </>
              )}
            </div>
            {fkb ? (
              <>
                <div className="mt-4 flex items-center gap-2">
                  <FolderTree className="size-3.5 text-muted-foreground" />
                  <h3 className="text-[13px] font-semibold">Library folders (section {data.short})</h3>
                  <Link href="/settings#roots" className="ml-auto inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
                    Add in Settings <ArrowUpRight className="size-3.5" />
                  </Link>
                </div>
                {data.roots.length ? (
                  <ul className="mt-2 space-y-1">
                    {data.roots.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1">
                        <code className={cn("min-w-0 flex-1 truncate font-mono text-[12px]", !r.enabled && "line-through")} title={r.path}>
                          {r.path}
                        </code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[12.5px] text-muted-foreground">No folder yet.</p>
                )}
                <p className="mt-2 text-[12px] text-muted-foreground">
                  {data.short} has no clients, so there are no folder rules: every file in these folders is {data.short}&apos;s. Google Drive folders must be
                  Available offline (or copied to the drive) before they are added.
                </p>
                <Link href="/fkb/running" className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
                  Spend, leads and CPL on the Running tab <ArrowUpRight className="size-3.5" />
                </Link>
              </>
            ) : (
              <>
            <div className="mt-4 flex items-center gap-2">
              <FolderTree className="size-3.5 text-muted-foreground" />
              <h3 className="text-[13px] font-semibold">Folder rules that tag {data.short}</h3>
              <Link href="/settings#tag-rules" className="ml-auto inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
                Edit in Settings <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
            {data.rules.length ? (
              <ul className="mt-2 space-y-1">
                {data.rules.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1">
                    <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={r.glob}>
                      {r.glob}
                    </code>
                    {r.codes.length > 1 && <span className="shrink-0 text-[11px] text-muted-foreground">shared with {r.codes.filter((c) => c !== data.code).join(", ")}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[12.5px] text-muted-foreground">No folder rule tags this client yet.</p>
            )}
            <Link href={`/fkbpros/${data.code}/running`} className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
              Spend, leads and CPL on the Running tab <ArrowUpRight className="size-3.5" />
            </Link>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function WhatWorks({
  code,
  short,
  works,
  pending,
  run,
}: {
  code: string;
  short: string;
  works: WorkItem[];
  pending: boolean;
  run: (fn: () => Promise<Result>, after?: () => void) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);

  return (
    <Card title="What works here" eyebrow="Pinned" aside={<span className="tabular">{works.length} items</span>}>
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        What you know works for {short}: an offer, a line, an angle. Pin a hook from its row on the Hooks tab. Rides along on {short}&apos;s hook
        scoring; editing never rescores (the Hooks tab flags it).
      </p>
      {works.length === 0 ? (
        <div className="rounded-lg border border-dashed border-foreground/15 px-4 py-6 text-center text-[13px] text-muted-foreground">
          Nothing yet. Add a line below, or pin a hook from the Hooks tab.
        </div>
      ) : (
        <ol className="divide-y divide-border rounded-lg border border-border">
          {works.map((w, i) => (
            <li key={w.id} className="flex items-start gap-2 px-3 py-2">
              <span className="mt-1 w-4 shrink-0 text-right text-[11.5px] text-muted-foreground tabular">{i + 1}</span>
              <div className="min-w-0 flex-1">
                {w.hook ? (
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-brand-text">
                      <Pin className="size-3" /> Pinned {w.hook.kind} hook
                      {w.hook.overall != null && <span className="text-muted-foreground tabular">· {w.hook.overall.toFixed(1)}</span>}
                    </div>
                    <div className={cn("text-[13.5px] leading-snug", w.hook.state !== "live" && "text-muted-foreground line-through decoration-foreground/25")}>
                      {w.hook.text}
                    </div>
                    {w.hook.state !== "live" && (
                      <div className="mt-0.5 text-[12px] text-brand-text">{STALE_PIN[w.hook.state]} Not used in scoring; unpin it or bring the hook back.</div>
                    )}
                  </div>
                ) : editing?.id === w.id ? (
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      run(() => editWorkAction({ code, id: w.id, body: editing.text }), () => setEditing(null));
                    }}
                  >
                    <Input autoFocus value={editing.text} maxLength={300} onChange={(e) => setEditing({ id: w.id, text: e.target.value })} className="h-8 text-[13px]" aria-label="Edit item" />
                    <button type="submit" className={iconBtn} disabled={pending} aria-label="Save item">
                      <Check className="size-3.5" />
                    </button>
                    <button type="button" className={iconBtn} onClick={() => setEditing(null)} aria-label="Cancel editing">
                      <X className="size-3.5" />
                    </button>
                  </form>
                ) : (
                  <div className="text-[13.5px] leading-snug">{w.body}</div>
                )}
              </div>
              {editing?.id !== w.id && (
                <div className="flex shrink-0 items-center">
                  <button type="button" className={iconBtn} disabled={pending || i === 0} onClick={() => run(() => moveWorkAction({ code, id: w.id, dir: "up" }))} aria-label="Move up">
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    disabled={pending || i === works.length - 1}
                    onClick={() => run(() => moveWorkAction({ code, id: w.id, dir: "down" }))}
                    aria-label="Move down"
                  >
                    <ArrowDown className="size-3.5" />
                  </button>
                  {w.hook ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link href={w.hook.href} className={iconBtn} aria-label="Open on the Hooks tab">
                            <ArrowUpRight className="size-3.5" />
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent>Open on the Hooks tab</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className={iconBtn} disabled={pending} onClick={() => run(() => pinHookAction({ hookId: w.hook!.id, pinned: false }))} aria-label="Unpin">
                            <PinOff className="size-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Unpin</TooltipContent>
                      </Tooltip>
                    </>
                  ) : (
                    <>
                      <button type="button" className={iconBtn} disabled={pending} onClick={() => setEditing({ id: w.id, text: w.body ?? "" })} aria-label="Edit">
                        <Pencil className="size-3.5" />
                      </button>
                      <button type="button" className={iconBtn} disabled={pending} onClick={() => run(() => removeWorkAction({ code, id: w.id }))} aria-label="Remove">
                        <X className="size-3.5" />
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim().length >= 2) run(() => addWorkAction({ code, body: draft }), () => setDraft(""));
        }}
      >
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={300} placeholder="Add what works here…" aria-label="New item" className="text-[13.5px]" />
        <Button type="submit" size="sm" variant="outline" disabled={pending || draft.trim().length < 2}>
          <Plus /> Add
        </Button>
      </form>
    </Card>
  );
}
