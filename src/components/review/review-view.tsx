"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleCheckBig, FolderTree, Inbox, Keyboard, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatDuration, libraryPathFor } from "@/lib/media";
import type { AssetDetail } from "@/lib/queries";
import { confirmReviewAction } from "@/app/actions";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import { mediaUrl } from "@/components/library/asset-card";
import { useLabels } from "@/components/shell/labels-provider";
import { setByText } from "@/lib/profile-shared";
import {
  CATEGORY_LABEL,
  CLIENT_YES,
  ENERGY_LABEL,
  QUESTION_LABEL,
  UNIVERSAL_ID,
  VISUAL_FORMATS,
  VISUAL_FORMAT_LABEL,
  answerUnsure,
  appliesTo,
  categoriesFor,
  clientQuestionId,
  pct,
  type CategoryId,
  type NoulId,
  type StoredAnswer,
  type VisualFormatId,
  OWNER_SOURCE,
} from "@/lib/ai/classes";

type ClientOpt = { code: string; short: string; name: string };
type Counts = { all: number; rtm: number; fkbpros: number; fkb: number; clients: Record<string, number> };

const BROWSER_IMAGE = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const NOUL_ORDER: NoulId[] = ["hookable", "brand_safe", "pp_person", "pp_pain", "pp_promise"];
/** What each yes/no means, in one line (the full wording is what Jev was asked). */
const NOUL_HINT: Record<NoulId, string> = {
  hookable: "The first 3 seconds could stop a scroll",
  brand_safe: "No outside logos, private info or broken frames",
  pp_person: "The words say who the ad is for",
  pp_pain: "The words state the viewer's problem",
  pp_promise: "The words state the one outcome promised",
};

type Edits = {
  cls: CategoryId | null;
  clients: string[];
  nouls: Partial<Record<NoulId, boolean>>;
  energy: number | null;
  vf: VisualFormatId | null;
};

function initialEdits(a: AssetDetail, clients: ClientOpt[]): Edits {
  const c = a.ai.cls!;
  const ans = c.answers;
  const proposed =
    c.clientsAsked && !c.clientsDecided ? clients.filter((cl) => Number(ans[clientQuestionId(cl.code)]?.value ?? 0) >= CLIENT_YES).map((cl) => cl.code) : [];
  const nouls: Partial<Record<NoulId, boolean>> = {};
  for (const id of NOUL_ORDER) if (ans[id]) nouls[id] = Number(ans[id].value) >= 0.5;
  return {
    cls: (c.assetClass as CategoryId | null) ?? null,
    clients: [...new Set([...a.clients.map((x) => x.code), ...proposed])],
    nouls,
    energy: c.energy != null ? Math.min(5, Math.max(1, Math.round(c.energy))) : null,
    vf: ans.visual_format ? (ans.visual_format.value as VisualFormatId) : null,
  };
}

/** Answer rows shown for the asset with its (edited) class, in display order. */
function rowKeys(a: AssetDetail, cls: string | null): string[] {
  const c = a.ai.cls!;
  const ans = c.answers;
  const keys = ["asset_class"];
  if (a.sectionKey === "fkbpros") keys.push("clients");
  if (ans.energy) keys.push("energy");
  if (ans.visual_format && appliesTo("visual_format", cls, a.kind)) keys.push("visual_format");
  for (const id of NOUL_ORDER) if (ans[id] && appliesTo(id, cls, a.kind)) keys.push(id);
  return keys;
}

/** Unsure rows for the edited class: the stored list, plus class-dependent answers a class change brought back. */
function unsureKeys(a: AssetDetail, cls: string | null, threshold: number, shown: string[]): string[] {
  const c = a.ai.cls!;
  const out = new Set(c.unsure.filter((k) => shown.includes(k)));
  for (const id of ["visual_format", "pp_person", "pp_pain", "pp_promise"]) {
    const x = c.answers[id];
    if (x?.dropped && shown.includes(id) && answerUnsure(x, threshold)) out.add(id);
  }
  return shown.filter((k) => out.has(k));
}

export function ReviewView({
  ids: initialIds,
  startId,
  scope,
  counts,
  clients,
  lanes,
}: {
  ids: number[];
  startId: number | null;
  scope: string;
  counts: Counts;
  clients: ClientOpt[];
  /** Enabled lanes (Settings > Lanes), in sidebar order: the channel menu's lane entries. */
  lanes: { key: "rtm" | "fkbpros" | "fkb"; name: string }[];
}) {
  const L = useLabels();
  const router = useRouter();
  const { drive, classify } = useStatus();
  const refreshStatus = useStatusRefresh();
  const [ids, setIds] = useState(initialIds);
  const [index, setIndex] = useState(() => Math.max(0, startId ? initialIds.indexOf(startId) : 0));
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Edits | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [pending, start] = useTransition();
  const [announce, setAnnounce] = useState("");
  const cache = useRef(new Map<number, AssetDetail>());
  /** Unsaved edits per file, so Back / Skip return to what you had changed. */
  const drafts = useRef(new Map<number, Edits>());
  const clientsRef = useRef(clients);
  const thresholdRef = useRef(classify.threshold);
  useEffect(() => {
    clientsRef.current = clients;
    thresholdRef.current = classify.threshold;
  });
  const currentId = ids[index] ?? null;

  const fetchAsset = useCallback(async (id: number): Promise<AssetDetail> => {
    const hit = cache.current.get(id);
    if (hit) return hit;
    const r = await fetch(`/api/assets/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "This file is no longer in the index." : `HTTP ${r.status}`);
    const data = (await r.json()) as AssetDetail;
    cache.current.set(id, data);
    return data;
  }, []);

  // Load the current asset (and warm the next one); keep ?asset= in the URL without a server round trip.
  useEffect(() => {
    if (currentId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const a = await fetchAsset(currentId);
        if (cancelled) return;
        setAsset(a);
        setLoadError(null);
        if (a.ai.cls) {
          const e = drafts.current.get(a.id) ?? initialEdits(a, clientsRef.current);
          setEdits(e);
          const shown = rowKeys(a, e.cls);
          setFocusKey(unsureKeys(a, e.cls, thresholdRef.current, shown)[0] ?? shown[0] ?? null);
        }
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    const next = ids[index + 1];
    if (next != null) void fetchAsset(next).catch(() => {});
    const url = new URL(window.location.href);
    url.searchParams.set("asset", String(currentId));
    window.history.replaceState(null, "", url.toString());
    return () => {
      cancelled = true;
    };
    // ids[index + 1] is only a prefetch hint: moving the queue must not reset the edits of the current file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, fetchAsset]);

  const a = asset && asset.id === currentId ? asset : null;
  const c = a?.ai.cls ?? null;
  const shown = useMemo(() => (a && c && edits ? rowKeys(a, edits.cls) : []), [a, c, edits]);
  const unsure = useMemo(() => (a && c && edits ? unsureKeys(a, edits.cls, classify.threshold, shown) : []), [a, c, edits, classify.threshold, shown]);

  const focusRow = useCallback((key: string | null) => {
    setFocusKey(key);
    if (!key) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-answer="${key}"] [data-primary]`)?.focus());
  }, []);

  // Remember the current file's edits (Back / Skip keep them until it is confirmed).
  useEffect(() => {
    if (a && edits) drafts.current.set(a.id, edits);
  }, [a, edits]);

  const patch = (p: Partial<Edits>) => setEdits((e) => (e ? { ...e, ...p } : e));
  const toggleClient = useCallback(
    (code: string) => {
      if (!a || a.sectionKey !== "fkbpros") return;
      if (a.clients.some((x) => x.code === code && x.source === "folder")) {
        toast("Folder tags are fixed. Edit the folder rule in Settings.");
        return;
      }
      setEdits((e) => (e ? { ...e, clients: e.clients.includes(code) ? e.clients.filter((x) => x !== code) : [...e.clients, code] } : e));
      setFocusKey("clients");
    },
    [a],
  );
  const setShared = useCallback(() => {
    if (!a || a.sectionKey !== "fkbpros") return;
    const folder = a.clients.filter((x) => x.source === "folder").map((x) => x.code);
    if (folder.length) toast("Folder tags are fixed; the other tags were cleared.");
    setEdits((e) => (e ? { ...e, clients: folder } : e));
    setFocusKey("clients");
  }, [a]);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= ids.length) {
        toast(delta > 0 ? "That was the last file in the queue." : "This is the first file in the queue.");
        return;
      }
      setIndex(next);
    },
    [index, ids.length],
  );

  const confirm = useCallback(() => {
    if (!a || !c || !edits || pending) return;
    const payload = {
      assetId: a.id,
      assetClass: edits.cls ?? undefined,
      clients: a.sectionKey === "fkbpros" ? edits.clients : undefined,
      nouls: Object.fromEntries(NOUL_ORDER.filter((id) => shown.includes(id) && edits.nouls[id] != null).map((id) => [id, edits.nouls[id]])),
      energy: shown.includes("energy") && edits.energy != null ? edits.energy : undefined,
      visualFormat: shown.includes("visual_format") && edits.vf ? edits.vf : undefined,
    };
    const id = a.id;
    start(async () => {
      const r = await confirmReviewAction(payload);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      cache.current.delete(id);
      drafts.current.delete(id);
      setAnnounce(`${a.filename} confirmed. ${r.message ?? ""}`);
      toast.success(r.message ?? "Confirmed.", { duration: 1500 });
      const rest = ids.filter((x) => x !== id);
      setIds(rest);
      setIndex(Math.min(index, Math.max(0, rest.length - 1)));
      setAsset(null);
      void refreshStatus(); // sidebar badge
    });
  }, [a, c, edits, pending, shown, ids, index, refreshStatus]);

  // Keyboard: never while typing in a field or while a dialog (picker, legend) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pickerOpen || legendOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog'], [role='menu']")) return;
      const k = e.key === "/" && e.shiftKey ? "?" : e.key;
      if (!a || !c || !edits) {
        if (k === "?") setLegendOpen(true);
        return;
      }
      if (/^[1-8]$/.test(k)) {
        const cl = clients[Number(k) - 1];
        if (cl) {
          e.preventDefault();
          toggleClient(cl.code);
        }
        return;
      }
      if (k === "0") {
        e.preventDefault();
        setShared();
        return;
      }
      if (k === "c" || k === "C") {
        e.preventDefault();
        setFocusKey("asset_class");
        setPickerOpen(true);
        return;
      }
      if (k === "y" || k === "Y" || k === "n" || k === "N") {
        const key = t?.closest<HTMLElement>("[data-answer]")?.dataset.answer ?? focusKey;
        if (key && (NOUL_ORDER as string[]).includes(key)) {
          e.preventDefault();
          setEdits((ed) => (ed ? { ...ed, nouls: { ...ed.nouls, [key]: k.toLowerCase() === "y" } } : ed));
          setFocusKey(key);
        }
        return;
      }
      if (k === "Tab") {
        e.preventDefault();
        const ring = unsure.length ? unsure : shown;
        if (!ring.length) return;
        const at = focusKey ? ring.indexOf(focusKey) : -1;
        const next = e.shiftKey ? (at <= 0 ? ring.length - 1 : at - 1) : (at + 1) % ring.length;
        focusRow(ring[next]);
        return;
      }
      if (k === "Enter") {
        e.preventDefault();
        confirm();
        return;
      }
      if (k === "ArrowRight") {
        e.preventDefault();
        go(1);
        return;
      }
      if (k === "ArrowLeft") {
        e.preventDefault();
        go(-1);
        return;
      }
      if (k === "?") {
        e.preventDefault();
        setLegendOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a, c, edits, pickerOpen, legendOpen, clients, focusKey, unsure, shown, toggleClient, setShared, confirm, go, focusRow]);

  const scopeLabel =
    scope === "all" ? "All channels" : (lanes.find((l) => l.key === scope)?.name ?? clients.find((x) => x.code === scope)?.short ?? scope);
  const scopeCount =
    scope === "all" ? counts.all : scope === "rtm" ? counts.rtm : scope === "fkbpros" ? counts.fkbpros : scope === "fkb" ? counts.fkb : (counts.clients[scope] ?? 0);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg border border-border bg-card">
            <Inbox className="size-4 text-muted-foreground" />
          </span>
          <div>
            <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">Review</div>
            <h1 className="text-[17px] leading-tight font-semibold tracking-[-0.01em]">
              {ids.length ? `${ids.length.toLocaleString()} to review` : "All reviewed"}
            </h1>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] transition-colors hover:border-foreground/20 focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <span className="text-muted-foreground">Channel:</span>
              <span className="font-medium">{scopeLabel}</span>
              <span className="text-[11.5px] text-muted-foreground tabular">{scopeCount}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuRadioGroup value={scope} onValueChange={(v) => router.push(v === "all" ? "/review" : `/review?in=${v}`)}>
              <ScopeItem value="all" label="All channels" n={counts.all} />
              {lanes.map((l) => (
                <ScopeItem key={l.key} value={l.key} label={l.name} n={counts[l.key]} />
              ))}
              <DropdownMenuSeparator />
              {clients.map((cl) => (
                <ScopeItem key={cl.code} value={cl.code} label={cl.short} n={counts.clients[cl.code] ?? 0} />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {ids.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[12.5px] text-muted-foreground tabular">
              {Math.min(index + 1, ids.length)} of {ids.length}
            </span>
            <Button variant="outline" size="sm" onClick={() => go(-1)} disabled={index === 0} aria-label="Back to the previous file (Left arrow)">
              <ArrowLeft /> Back
            </Button>
            <Button variant="outline" size="sm" onClick={() => go(1)} disabled={index >= ids.length - 1} aria-label="Skip to the next file (Right arrow)">
              Skip <ArrowRight />
            </Button>
            <Button size="sm" onClick={confirm} disabled={!a || !edits || pending} className="bg-brand text-ink hover:bg-brand/90">
              {pending ? <Loader2 className="animate-spin" /> : <Check />} Confirm
              <kbd className="ml-1 rounded border border-ink/25 px-1 text-[10.5px] font-medium">Enter</kbd>
            </Button>
          </div>
        )}
      </div>

      <div className="sr-only" aria-live="polite">
        {announce}
      </div>

      {ids.length === 0 ? (
        <EmptyState paused={classify.paused} scope={scopeLabel} anyElsewhere={counts.all > 0 && scope !== "all"} />
      ) : !a || !c || !edits ? (
        <div className="grid flex-1 place-items-center py-24 text-muted-foreground">
          {loadError ? <span className="text-[13px]">{loadError}</span> : <Loader2 className="size-5 animate-spin" />}
        </div>
      ) : (
        <main aria-label={`Review ${a.filename}`} className="grid flex-1 gap-6 px-6 py-5 lg:grid-cols-[minmax(0,1fr)_440px]">
          <div className="min-w-0 space-y-4">
            <Preview a={a} originalOk={a.originalAvailable && (!a.onDrive || drive.mounted)} />
            <div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="min-w-0 truncate text-[15px] font-semibold" title={a.filename}>
                  {a.filename}
                </h2>
                <Link
                  href={`${libraryPathFor(a.sectionKey)}?asset=${a.id}`}
                  className="inline-flex items-center gap-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <ExternalLink className="size-3" /> Open in Library
                </Link>
              </div>
              <div className="truncate text-[12.5px] text-muted-foreground" title={a.relPath}>
                {[a.rootLabel, a.relDir].filter(Boolean).join(" / ")}
                {a.durationS != null && a.kind === "video" ? ` · ${formatDuration(a.durationS)}` : ""}
                {a.orientation ? ` · ${a.orientation}` : ""}
              </div>
            </div>
            {a.ai.description && (
              <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">{a.ai.description}</div>
            )}
            {a.kind === "video" && a.ai.spokenOpen != null && (
              <div>
                <div className="mb-1 text-[12px] text-muted-foreground">Spoken opening (first 15 s)</div>
                {a.ai.spokenOpen ? (
                  <blockquote className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-[13px] leading-relaxed">“{a.ai.spokenOpen}”</blockquote>
                ) : (
                  <div className="text-[13px] text-muted-foreground">No speech</div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2" aria-label="Jev's answers">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Jev&apos;s answers</h3>
              <span className="text-[12px] text-muted-foreground">
                {unsure.length ? `${unsure.length} unsure` : "nothing unsure"} · Tab moves between them
              </span>
            </div>
            {shown.map((key) => (
              <AnswerRow
                key={key}
                answerKey={key}
                a={a}
                edits={edits}
                unsure={unsure.includes(key)}
                focused={focusKey === key}
                clients={clients}
                onFocus={() => setFocusKey(key)}
                onPickClass={() => {
                  setFocusKey("asset_class");
                  setPickerOpen(true);
                }}
                onToggleClient={toggleClient}
                onShared={setShared}
                patch={patch}
              />
            ))}
          </div>
        </main>
      )}

      <LegendStrip clients={clients} onOpen={() => setLegendOpen(true)} />

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="p-0 sm:max-w-[420px]" aria-describedby={undefined}>
          <DialogHeader className="px-4 pt-4">
            <DialogTitle className="text-[15px]">Category</DialogTitle>
          </DialogHeader>
          <Command className="rounded-b-xl">
            <CommandInput placeholder="Type to filter, Enter picks…" autoFocus />
            <CommandList className="max-h-[360px]">
              <CommandEmpty>No category.</CommandEmpty>
              <CommandGroup>
                {a &&
                  categoriesFor(a.kind === "video" ? "video" : "image").map((cat) => (
                    <CommandItem
                      key={cat.id}
                      value={`${cat.label} ${cat.id}`}
                      onSelect={() => {
                        patch({ cls: cat.id });
                        setPickerOpen(false);
                        focusRow("asset_class");
                      }}
                    >
                      <Check className={cn("size-3.5", edits?.cls === cat.id ? "opacity-100" : "opacity-0")} />
                      <span>{cat.label}</span>
                      <span className="ml-auto max-w-[55%] truncate text-[11.5px] text-muted-foreground">{L.categories[cat.id] ?? cat.description}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      <Dialog open={legendOpen} onOpenChange={setLegendOpen}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Review keys</DialogTitle>
            <DialogDescription>Keys work anywhere on this page except while typing in a field. Everything is also clickable.</DialogDescription>
          </DialogHeader>
          <FullLegend clients={clients} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScopeItem({ value, label, n }: { value: string; label: string; n: number }) {
  return (
    <DropdownMenuRadioItem value={value}>
      {label}
      <span className="ml-auto pl-3 text-[11.5px] text-muted-foreground tabular">{n}</span>
    </DropdownMenuRadioItem>
  );
}

function EmptyState({ paused, scope, anyElsewhere }: { paused: boolean; scope: string; anyElsewhere: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
      <CircleCheckBig className="size-9 text-muted-foreground" />
      <div className="text-[16px] font-semibold">Nothing to review{scope !== "All channels" ? ` in ${scope}` : ""}</div>
      <p className="max-w-[440px] text-[13px] text-muted-foreground">
        Every file Jev filed here was a confident answer, or you confirmed it.
        {paused ? " Classify is paused in Settings, so new files are not being filed yet." : ""}
      </p>
      <div className="mt-2 flex gap-2">
        {anyElsewhere && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/review">Review all channels</Link>
          </Button>
        )}
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings">Classify settings</Link>
        </Button>
      </div>
    </div>
  );
}

function Preview({ a, originalOk }: { a: AssetDetail; originalOk: boolean }) {
  const box = "overflow-hidden rounded-xl border border-border bg-ink";
  if (a.kind === "video") {
    if (a.hasProxy) {
      return (
        <div className={box}>
          <video
            key={a.id}
            src={mediaUrl(a, "proxy")}
            controls
            muted
            autoPlay
            loop
            playsInline
            poster={a.hasThumb ? mediaUrl(a, "thumb") : undefined}
            className="max-h-[58vh] w-full bg-ink object-contain"
          />
        </div>
      );
    }
    return (
      <div className={box}>
        {(a.hasSheet || a.hasThumb) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl(a, a.hasSheet ? "sheet" : "thumb")} alt="" className="max-h-[58vh] w-full object-contain" />
        )}
        <div className="px-3 py-1.5 text-[11.5px] text-paper/70">Proxy not ready yet. Showing the contact sheet.</div>
      </div>
    );
  }
  const src = originalOk && BROWSER_IMAGE.has(a.ext) ? mediaUrl(a, "original") : a.hasThumb ? mediaUrl(a, "thumb") : null;
  return (
    <div className={cn(box, "bg-muted")}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={a.id} src={src} alt={a.filename} className="max-h-[58vh] w-full object-contain" />
      ) : (
        <div className="grid h-48 place-items-center text-[13px] text-muted-foreground">Preview not ready yet</div>
      )}
    </div>
  );
}

const segBtn =
  "h-7 rounded-md border px-2 text-[12.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";
const segOn = "border-foreground/70 bg-foreground text-background";
const segOff = "border-border bg-card hover:border-foreground/30";

function jevLine(x: StoredAnswer | undefined, setBy: string): string {
  if (!x) return "";
  if (x.source === OWNER_SOURCE) return setBy;
  if (x.type === "noul") return `Jev: ${pct(Number(x.value))} yes`;
  return x.confidence != null ? `Jev ${pct(x.confidence)} sure` : "";
}

function AnswerRow({
  answerKey,
  a,
  edits,
  unsure,
  focused,
  clients,
  onFocus,
  onPickClass,
  onToggleClient,
  onShared,
  patch,
}: {
  answerKey: string;
  a: AssetDetail;
  edits: Edits;
  unsure: boolean;
  focused: boolean;
  clients: ClientOpt[];
  onFocus: () => void;
  onPickClass: () => void;
  onToggleClient: (code: string) => void;
  onShared: () => void;
  patch: (p: Partial<Edits>) => void;
}) {
  const L = useLabels();
  const setBy = setByText(L.owner);
  const c = a.ai.cls!;
  const ans = c.answers;
  const label = QUESTION_LABEL[answerKey] ?? answerKey;
  let body: React.ReactNode = null;
  let jev = "";

  if (answerKey === "asset_class") {
    const jevClass = ans.asset_class?.source !== OWNER_SOURCE ? (ans.asset_class?.value as string | undefined) : undefined;
    jev = c.classSource === "manual" ? setBy : jevLine(ans.asset_class, setBy);
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-primary onClick={onPickClass} className={cn(segBtn, segOff, "flex items-center gap-1.5")} aria-label="Change the category (C)">
          {edits.cls ? CATEGORY_LABEL[edits.cls] : "None"}
          <ChevronDown className="size-3.5 text-muted-foreground" />
          <kbd className="rounded border border-border px-1 text-[10.5px] text-muted-foreground">C</kbd>
        </button>
        {jevClass && edits.cls !== jevClass && (
          <span className="text-[12px] text-muted-foreground">Jev said {CATEGORY_LABEL[jevClass as CategoryId] ?? jevClass}</span>
        )}
      </div>
    );
  } else if (answerKey === "clients") {
    const folder = new Set(a.clients.filter((x) => x.source === "folder").map((x) => x.code));
    const universal = ans[UNIVERSAL_ID] ? Number(ans[UNIVERSAL_ID].value) : null;
    jev = c.clientsDecided ? setBy : c.clientsAsked ? (universal != null ? `Jev: universal ${pct(universal)}` : "") : "tags from folders or you";
    const shared = edits.clients.length === 0;
    body = (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          {clients.map((cl, i) => {
            const on = edits.clients.includes(cl.code);
            const p = ans[clientQuestionId(cl.code)] ? Number(ans[clientQuestionId(cl.code)].value) : null;
            const fixed = folder.has(cl.code);
            return (
              <button
                key={cl.code}
                type="button"
                data-primary={i === 0 ? true : undefined}
                aria-pressed={on}
                onClick={() => onToggleClient(cl.code)}
                disabled={fixed}
                title={fixed ? "Tagged by a folder rule (edit it in Settings)" : cl.name}
                className={cn(segBtn, "flex items-center gap-1.5 text-left", on ? segOn : segOff)}
              >
                <kbd className={cn("rounded border px-1 text-[10.5px]", on ? "border-background/40" : "border-border text-muted-foreground")}>{i + 1}</kbd>
                <span className="min-w-0 flex-1 truncate">{cl.short}</span>
                {fixed ? (
                  <FolderTree className="size-3.5 shrink-0" aria-label="folder tag" />
                ) : p != null ? (
                  <span className={cn("text-[11px] tabular", on ? "text-background/75" : "text-muted-foreground")}>{pct(p)}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <button type="button" aria-pressed={shared} onClick={onShared} className={cn(segBtn, "flex w-full items-center gap-1.5", shared ? segOn : segOff)}>
          <kbd className={cn("rounded border px-1 text-[10.5px]", shared ? "border-background/40" : "border-border text-muted-foreground")}>0</kbd>
          Shared (no single client)
        </button>
      </div>
    );
  } else if (answerKey === "energy") {
    const e = c.energy;
    jev = e != null ? `Jev ${e.toFixed(1)}${ans.energy?.source === OWNER_SOURCE ? ` · ${setBy}` : ans.energy?.confidence != null ? ` · ${pct(ans.energy.confidence)} sure` : ""}` : "";
    body = (
      <div className="flex gap-1" role="group" aria-label="Energy 1 to 5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            data-primary={n === 1 ? true : undefined}
            aria-pressed={edits.energy === n}
            aria-label={`Energy ${n}, ${ENERGY_LABEL[n - 1]}`}
            onClick={() => patch({ energy: n })}
            className={cn(segBtn, "min-w-9", edits.energy === n ? segOn : segOff)}
            title={ENERGY_LABEL[n - 1]}
          >
            {n}
          </button>
        ))}
        <span className="ml-1 self-center text-[12px] text-muted-foreground">{edits.energy ? ENERGY_LABEL[edits.energy - 1] : ""}</span>
      </div>
    );
  } else if (answerKey === "visual_format") {
    jev = jevLine(ans.visual_format, setBy);
    body = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-primary className={cn(segBtn, segOff, "flex items-center gap-1.5")}>
            {edits.vf ? VISUAL_FORMAT_LABEL[edits.vf] : "Pick a format"}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuRadioGroup value={edits.vf ?? ""} onValueChange={(v) => patch({ vf: v as VisualFormatId })}>
            {VISUAL_FORMATS.map((f) => (
              <DropdownMenuRadioItem key={f.id} value={f.id} title={L.visualFormats[f.id] ?? f.description}>
                {f.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else if ((NOUL_ORDER as string[]).includes(answerKey)) {
    const id = answerKey as NoulId;
    const v = edits.nouls[id];
    jev = jevLine(ans[id], setBy);
    body = (
      <div className="flex items-center gap-1" role="group" aria-label={`${label}: yes or no`}>
        <button type="button" data-primary aria-pressed={v === true} onClick={() => patch({ nouls: { ...edits.nouls, [id]: true } })} className={cn(segBtn, v === true ? segOn : segOff)}>
          Yes <kbd className={cn("ml-1 rounded border px-1 text-[10.5px]", v === true ? "border-background/40" : "border-border text-muted-foreground")}>Y</kbd>
        </button>
        <button type="button" aria-pressed={v === false} onClick={() => patch({ nouls: { ...edits.nouls, [id]: false } })} className={cn(segBtn, v === false ? segOn : segOff)}>
          No <kbd className={cn("ml-1 rounded border px-1 text-[10.5px]", v === false ? "border-background/40" : "border-border text-muted-foreground")}>N</kbd>
        </button>
        <span className="ml-1 truncate text-[12px] text-muted-foreground">{NOUL_HINT[id]}</span>
      </div>
    );
  }

  return (
    <div
      data-answer={answerKey}
      onFocusCapture={onFocus}
      onClickCapture={onFocus}
      className={cn(
        "rounded-lg border px-3 py-2 transition-colors",
        unsure ? "border-brand/60 bg-brand/5" : "border-border bg-card",
        focused && "ring-2 ring-brand/60",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12.5px] font-medium">{label}</span>
        {unsure && <span className="rounded bg-brand/15 px-1.5 text-[10.5px] font-semibold tracking-wide text-brand-text uppercase">Unsure</span>}
        <span className="ml-auto text-[11.5px] text-muted-foreground tabular">{jev}</span>
      </div>
      {body}
    </div>
  );
}

const KEYS: [string, string][] = [
  ["0", "Shared (clears the client tags)"],
  ["C", "Category picker (type to filter, Enter picks)"],
  ["Y / N", "Yes or no for the focused question"],
  ["Tab", "Next unsure answer (Shift+Tab: previous)"],
  ["Enter", "Confirm everything shown and go to the next file"],
  ["→ / ←", "Skip / back"],
  ["?", "This legend"],
];

/** Strip label: the first word ("Acme", "Northwind"), except pairs like "Smith and Jones". */
const stripName = (short: string) => (short.includes(" and ") ? short : short.split(" ")[0]);

function LegendStrip({ clients, onOpen }: { clients: ClientOpt[]; onOpen: () => void }) {
  return (
    <div className="sticky bottom-0 z-10 border-t border-border bg-background/95 px-6 py-2 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
        {clients.map((cl, i) => (
          <span key={cl.code} className="whitespace-nowrap" title={cl.name}>
            <Kbd>{i + 1}</Kbd> {stripName(cl.short)}
          </span>
        ))}
        <span className="whitespace-nowrap">
          <Kbd>0</Kbd> Shared
        </span>
        <span aria-hidden className="text-border">
          |
        </span>
        <span className="whitespace-nowrap">
          <Kbd>C</Kbd> Category
        </span>
        <span className="whitespace-nowrap">
          <Kbd>Y</Kbd>/<Kbd>N</Kbd> Yes/No
        </span>
        <span className="whitespace-nowrap">
          <Kbd>Tab</Kbd> Next unsure
        </span>
        <span className="whitespace-nowrap">
          <Kbd>Enter</Kbd> Confirm
        </span>
        <span className="whitespace-nowrap">
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> Back/Skip
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:outline-none"
          aria-label="Show all keys (?)"
        >
          <Keyboard className="size-3.5" /> All keys <Kbd>?</Kbd>
        </button>
      </div>
    </div>
  );
}

function FullLegend({ clients }: { clients: ClientOpt[] }) {
  const L = useLabels();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <div className="mb-1.5 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Clients ({L.lane.fkbpros})</div>
        <ul className="space-y-1 text-[13px]">
          {clients.map((cl, i) => (
            <li key={cl.code} className="flex items-center gap-2">
              <Kbd>{i + 1}</Kbd>
              <span className="truncate" title={cl.name}>
                {cl.name}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-1.5 text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Everything else</div>
        <ul className="space-y-1 text-[13px]">
          {KEYS.map(([k, v]) => (
            <li key={k} className="flex items-start gap-2">
              <Kbd>{k}</Kbd>
              <span>{v}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-muted-foreground">
          Number keys toggle a client on or off (folder tags are fixed). Enter always confirms; Space presses a focused button.
        </p>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-card px-1 font-sans text-[10.5px] font-medium text-foreground/80">
      {children}
    </kbd>
  );
}
