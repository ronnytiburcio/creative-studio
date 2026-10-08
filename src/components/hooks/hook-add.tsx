"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ClipboardPaste, FileDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { addHookAction, importApprovedCopyAction, pasteHooksAction } from "@/app/actions";
import { HOOK_MAX_CHARS } from "@/lib/hooks/rubric";
import type { HookScope } from "@/lib/hooks/queries";
import { PRIMARY_BTN } from "./ui";

type Mode = "add" | "paste" | "import" | null;

/** Add one hook, paste a list, or import a client's approved copy (the controls on the Hooks tab header). */
export function HookAddControls({
  scope,
  channelLabel,
  importClient,
  paused,
  onChanged,
  requested = null,
  onRequestDone,
}: {
  scope: HookScope;
  channelLabel: string;
  /** Client channel: its copy doc can be imported. */
  /** `blocked` = why Import approved copy is off (no copy doc for this client), else null. */
  importClient: { code: string; short: string; blocked?: string | null } | null;
  paused: boolean;
  onChanged: () => void;
  /** cmd+K asked for a dialog (URL ?dialog=add|paste). */
  requested?: "add" | "paste" | null;
  /** The requested dialog closed: drop the URL param. */
  onRequestDone?: () => void;
}) {
  const [mode, setModeRaw] = useState<Mode>(null);
  const [text, setText] = useState("");
  const [seenRequest, setSeenRequest] = useState<string | null>(null);
  if (requested && requested !== seenRequest) {
    setSeenRequest(requested);
    setModeRaw(requested);
    setText("");
  }
  const setMode = (m: Mode) => {
    setModeRaw(m);
    if (m === null && requested) {
      setSeenRequest(null);
      onRequestDone?.();
    }
  };
  const [pending, start] = useTransition();
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  const shared = scope.kind === "fkbpros";

  const open = (m: Mode) => {
    setText("");
    setMode(m);
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "Failed");
        return;
      }
      if (r.message) toast.success(r.message);
      setMode(null);
      onChanged();
    });

  const afterNote = paused ? "Scoring is paused: new hooks wait until it resumes (or Score again on a row)." : "New hooks are scored by the worker in the background.";

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={() => open("add")}>
          <Plus /> Add hook
        </Button>
        <Button variant="outline" size="sm" onClick={() => open("paste")}>
          <ClipboardPaste /> Paste list
        </Button>
        {importClient && (
          <span title={importClient.blocked ?? undefined}>
            <Button variant="outline" size="sm" disabled={Boolean(importClient.blocked)} onClick={() => open("import")}>
              <FileDown /> Import approved copy
            </Button>
          </span>
        )}
      </div>

      <Dialog open={mode === "add"} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Add a hook</DialogTitle>
            <DialogDescription>
              To {channelLabel}
              {shared ? " (shared: not tied to one client)" : ""}. Stored exactly as typed. {afterNote}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => addHookAction({ scope, text }));
            }}
          >
            <Input
              autoFocus
              value={text}
              maxLength={HOOK_MAX_CHARS}
              onChange={(e) => setText(e.target.value)}
              placeholder="Still waiting three weeks for a quote?"
              aria-label="Hook text"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setMode(null)}>
                Cancel
              </Button>
              <Button type="submit" className={PRIMARY_BTN} disabled={pending || text.trim().length < 2}>
                Add hook
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "paste"} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>Paste hooks</DialogTitle>
            <DialogDescription>
              One hook per line, to {channelLabel}
              {shared ? " (shared)" : ""}. Blank lines and hooks this channel already has are skipped; a leading &quot;-&quot; or
              &quot;1.&quot; list marker is dropped. {afterNote}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            className="font-[inherit] text-[13.5px]"
            placeholder={"Still waiting three weeks for a quote?\nThe hardest part of the job, handled\n..."}
            aria-label="Hooks, one per line"
          />
          <DialogFooter className="items-center">
            <span className="mr-auto text-[12.5px] text-muted-foreground tabular">
              {lines} {lines === 1 ? "line" : "lines"}
            </span>
            <Button type="button" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button className={PRIMARY_BTN} disabled={pending || lines === 0} onClick={() => run(() => pasteHooksAction({ scope, text }))}>
              Add {lines || ""} {lines === 1 ? "hook" : "hooks"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {importClient && (
        <Dialog open={mode === "import"} onOpenChange={(o) => !o && setMode(null)}>
          <DialogContent className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle>Import approved copy · {importClient.short}</DialogTitle>
              <DialogDescription>
                Reads this client&apos;s <span className="font-mono text-[12px]">*-ad-copy-final.md</span> (read only) and adds every headline and
                the first sentence of every primary, tagged with its angle. Hooks already in this channel (archived ones too) are skipped, so it
                is safe to run again. {afterNote}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setMode(null)}>
                Cancel
              </Button>
              <Button className={PRIMARY_BTN} disabled={pending} onClick={() => run(() => importApprovedCopyAction({ code: importClient.code }))}>
                Import
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
