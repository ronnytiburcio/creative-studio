"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, CircleStop, Copy, FileImage, FileVideo, Loader2, Megaphone, Plus, RotateCcw, Sparkles, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FilePickerDialog } from "@/components/running/link-file";
import { PRIMARY_BTN, ACTIVE_PILL } from "@/components/hooks/ui";
import { cancelAdCopyJobAction, queueAdCopyAction, retryAdCopyJobAction, stageAdAction } from "@/app/actions";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration } from "@/lib/media";
import {
  checkAdCopy,
  cleanAdCopy,
  compileAdRules,
  fillEmptySlots,
  conceptProblem,
  HEADLINES_MAX,
  HEADLINES_MIN,
  namePreview,
  PRIMARIES_MAX,
  PRIMARIES_MIN,
  PS_OBJ_LABEL,
  type AdCopy,
  type LineCheck,
  type PsObj,
} from "@/lib/meta/ad-copy-rules";
import type { AdMedia, NewAdPrefill } from "@/lib/meta/new-ad";
import type { AdCopyJobView } from "@/lib/meta/ad-copy-job";
import type { NewAdArgs } from "./new-ad-provider";
import { useLabels } from "@/components/shell/labels-provider";
import { companyLabel } from "@/lib/profile-shared";

const CONFIRM_TEXT = "Stage this ad as PAUSED. Nothing goes to Meta until you apply it in a Claude session.";

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function Problems({ check }: { check: LineCheck | undefined }) {
  if (!check || (!check.problems.length && !check.warnings.length)) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[12px] leading-snug">
      {check.problems.map((p) => (
        <li key={p} className="flex gap-1 text-brand-text">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>{p}</span>
        </li>
      ))}
      {check.warnings.map((w) => (
        <li key={w} className="text-muted-foreground">
          {w}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

type DraftState = { jobId: number; view: AdCopyJobView | null } | null;

export function NewAdDialog({ args, onClose }: { args: NewAdArgs; onClose: () => void }) {
  const L = useLabels();
  const narrow = useNarrow();
  const router = useRouter();
  const [data, setData] = useState<NewAdPrefill | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(args.channel ?? null);
  const [copy, setCopy] = useState<AdCopy>({ headlines: ["", "", ""], primaries: ["", ""], description: "" });
  const [concept, setConcept] = useState("");
  const [psObj, setPsObj] = useState<PsObj>("ps");
  const [assetId, setAssetId] = useState<number | null>(args.assetId ?? null);
  const [media, setMedia] = useState<AdMedia | null>(null);
  const [notes, setNotes] = useState("");
  const [picker, setPicker] = useState<"video" | "image" | null>(null);
  const [draft, setDraft] = useState<DraftState>(null);
  const [confirming, setConfirming] = useState(false);
  const [staged, setStaged] = useState<{ path: string; name: string } | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const filledFromDraft = useRef<number | null>(null);
  const conceptRef = useRef("");
  /** The hook line primary 1 was prefilled with (a hook longer than a headline), sent with Draft the rest. */
  const p1OpeningRef = useRef<string | null>(null);
  useEffect(() => {
    conceptRef.current = concept;
  }, [concept]);

  // ---------------------------------------------------------------- load (and reload on a channel change)
  const assetRef = useRef<number | null>(args.assetId ?? null);
  useEffect(() => {
    assetRef.current = assetId;
  }, [assetId]);
  const fetchPrefill = useCallback(
    async (ch: string | null): Promise<NewAdPrefill> => {
      const q = new URLSearchParams();
      if (ch) q.set("channel", ch);
      if (args.hookId) q.set("hook", String(args.hookId));
      // A file picked here survives a channel change (it is checked again for the new channel).
      if (assetRef.current) q.set("asset", String(assetRef.current));
      if (args.adId) q.set("ad", args.adId);
      const r = await fetch(`/api/ads/prefill?${q}`, { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      return (await r.json()) as NewAdPrefill;
    },
    [args.hookId, args.adId],
  );
  const applyPrefill = useCallback((d: NewAdPrefill) => {
    const pad = (list: string[], n: number) => [...list, ...Array.from({ length: Math.max(0, n - list.length) }, () => "")];
    setData(d);
    setLoadError(null);
    setChannel(d.channel?.code ?? null);
    setCopy({ headlines: pad(d.copy.headlines, HEADLINES_MIN), primaries: pad(d.copy.primaries, PRIMARIES_MIN), description: d.copy.description });
    setConcept(d.concept);
    setPsObj(d.psObj);
    setAssetId(d.assetId);
    setMedia(d.media);
  }, []);
  const load = useCallback(
    async (ch: string | null) => {
      try {
        applyPrefill(await fetchPrefill(ch));
      } catch (e) {
        setLoadError((e as Error).message);
      }
    },
    [fetchPrefill, applyPrefill],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchPrefill(args.channel ?? null);
        if (!cancelled) applyPrefill(d);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPrefill, applyPrefill, args.channel]);

  const ch = data?.channel ?? null;
  const fpc = ch?.section === "fkbpros";
  const channelLocked = Boolean(args.adId) || Boolean(data?.hook && (data.hook.section === "fkb" || data.hook.code));

  // ---------------------------------------------------------------- checks (live; Stage runs them again on the server)
  const ruleCtx = data?.rules ?? null;
  const rules = useMemo(() => (ruleCtx ? compileAdRules(ruleCtx) : null), [ruleCtx]);
  const cleaned = useMemo(() => cleanAdCopy({ ...copy, headlines: copy.headlines.filter((h) => h.trim()), primaries: copy.primaries.filter((p) => p.trim()) }), [copy]);
  const check = useMemo(() => (rules ? checkAdCopy(cleaned, rules) : null), [cleaned, rules]);
  // Per slot (empty slots show no problems; the counts line says what is missing).
  const slotCheck = (kind: "headlines" | "primaries", i: number): LineCheck | undefined => {
    if (!check) return undefined;
    const text = copy[kind][i];
    if (!text.trim()) return undefined;
    const idx = copy[kind].slice(0, i).filter((x) => x.trim()).length;
    return check[kind][idx];
  };
  const naming = data?.naming ?? { clientPrefix: "", companyPrefix: "Ad", conceptExample: "late_quote_fix" };
  const conceptBad = fpc ? conceptProblem(concept.trim(), naming) : null;
  const mediaOk = media?.ok === true;
  const canStage = Boolean(ch && rules && check?.ok && mediaOk && !conceptBad && !staged);
  const preview = ch ? namePreview(ch.section, ch.code, concept.trim(), psObj, data?.nextN ?? 0, naming) : "";

  // ---------------------------------------------------------------- media
  const pickMedia = async (id: number) => {
    if (!ch) return;
    setAssetId(id);
    setMedia(null);
    try {
      const r = await fetch(`/api/ads/media?channel=${ch.code}&asset=${id}`, { cache: "no-store" });
      setMedia(r.ok ? ((await r.json()) as AdMedia) : { ok: false, error: `HTTP ${r.status}` });
    } catch (e) {
      setMedia({ ok: false, error: (e as Error).message });
    }
  };

  // ---------------------------------------------------------------- Draft the rest
  const setLine = (kind: "headlines" | "primaries", i: number, v: string) => setCopy((c) => ({ ...c, [kind]: c[kind].map((x, j) => (j === i ? v : x)) }));
  const addLine = (kind: "headlines" | "primaries") => setCopy((c) => ({ ...c, [kind]: [...c[kind], ""] }));
  const removeLine = (kind: "headlines" | "primaries", i: number) => setCopy((c) => ({ ...c, [kind]: c[kind].filter((_, j) => j !== i) }));
  // The line in the hook's slot: the hook asked for, else the video's own line (NewAdPrefill.videoLine).
  const lineText = data?.hook?.text ?? data?.videoLine?.text ?? null;
  // The video's line only counts while that same video is the media (a swapped file keeps the copy, not the hook link).
  const videoLineHere = !data?.hook && data?.videoLine && data.videoLine.assetId === assetId ? data.videoLine : null;
  const hookOnlyP1 = Boolean(data?.hookInPrimary && lineText && (copy.primaries[0] ?? "").trim() === lineText.replace(/\s+/g, " ").trim());
  const emptySlots =
    Math.max(0, HEADLINES_MIN - copy.headlines.filter((h) => h.trim()).length) +
    Math.max(0, PRIMARIES_MIN - copy.primaries.filter((p) => p.trim()).length + (hookOnlyP1 ? 1 : 0)) +
    (copy.description.trim() ? 0 : 1);

  const draftRunning = draft != null && (draft.view == null || draft.view.status === "pending" || draft.view.status === "running");
  // When the draft lands: fill only the slots that are empty NOW (never what the owner typed meanwhile).
  const landDraft = useCallback(
    (v: AdCopyJobView) => {
      if (v.status !== "done" || !v.draft || filledFromDraft.current === v.id) return;
      filledFromDraft.current = v.id;
      const d = v.draft;
      setCopy((c) => fillEmptySlots(c, d, p1OpeningRef.current));
      if (fpc && d.concept && !conceptRef.current.trim()) {
        setConcept(d.concept);
        if (d.psObj) setPsObj(d.psObj);
      }
      toast.success(v.note ? `Draft filled the empty slots. ${v.note}` : "Draft filled the empty slots. Read every line before you stage.");
    },
    [fpc],
  );
  const draftJobId = draft?.jobId ?? null;
  useEffect(() => {
    if (draftJobId == null || !draftRunning) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/ads/draft/${draftJobId}`, { cache: "no-store" });
        if (!r.ok || stop) return;
        const view = (await r.json()) as AdCopyJobView;
        setDraft((d) => (d && d.jobId === view.id ? { ...d, view } : d));
        landDraft(view);
      } catch {
        /* next tick */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [draftJobId, draftRunning, landDraft]);

  const startDraft = () =>
    start(async () => {
      if (!ch) return;
      const opening = hookOnlyP1 ? copy.primaries[0].trim() : null;
      p1OpeningRef.current = opening;
      const r = await queueAdCopyAction({
        channel: ch.code,
        hookId: data?.hook?.id ?? videoLineHere?.hookId ?? null,
        angleKey: data?.angle ?? null,
        filled: { headlines: copy.headlines, primaries: copy.primaries, description: copy.description },
        p1Opening: opening,
      });
      if (!r.ok) toast.error(r.error);
      else setDraft({ jobId: r.jobId, view: null });
    });

  // ---------------------------------------------------------------- Stage
  const source = args.adId ? { from: "winner" as const, ref: args.adId } : data?.hook ? { from: "hook" as const, ref: String(data.hook.id) } : { from: "library" as const, ref: assetId ? String(assetId) : null };
  const stage = () =>
    start(async () => {
      if (!ch || !assetId) return;
      setStageError(null);
      const r = await stageAdAction({
        channel: ch.code,
        assetId,
        copy: cleaned,
        angleKey: data?.angle ?? null,
        concept: fpc ? concept.trim() : null,
        psObj: fpc ? psObj : null,
        hookIds: data?.hook ? [data.hook.id] : videoLineHere?.hookId != null ? [videoLineHere.hookId] : [],
        videoHook: Boolean(videoLineHere && videoLineHere.hookId == null),
        source,
        notes: notes.trim() || null,
      });
      setConfirming(false);
      if (!r.ok) {
        setStageError(r.error);
        toast.error(r.error);
        return;
      }
      setStaged({ path: r.path, name: r.name });
      toast.success(r.message);
      router.refresh();
    });

  const pasteLine = staged
    ? `Apply the Studio ad order ${staged.path}: create it PAUSED (${ch?.section === "fkb" ? L.skills.adApplyCompany : L.skills.adApplyClients}), confirm the copy with me first, never activate.`
    : "";
  const copyText = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      toast.success("Copied");
    } catch {
      toast.error("Clipboard not available");
    }
  };

  const MediaIcon = media?.ok ? (media.kind === "video" ? FileVideo : FileImage) : FileVideo;
  const pickerScope = ch ? (ch.section === "fkb" ? "scope=fkb" : `scope=client&client=${encodeURIComponent(ch.code)}`) : "";

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side={narrow ? "bottom" : "right"}
        className={cn(
          "gap-0 overflow-hidden p-0",
          narrow ? "rounded-t-2xl data-[side=bottom]:h-[92dvh] data-[side=bottom]:max-h-[92dvh]" : "data-[side=right]:w-[min(720px,100vw)] data-[side=right]:sm:max-w-none",
        )}
      >
        <SheetHeader className="border-b border-border px-4 py-3.5 pr-12 sm:px-5">
          <SheetTitle className="flex items-center gap-2 text-[15px] font-semibold">
            <Megaphone className="size-4 text-muted-foreground" /> New PAUSED ad
            {ch && <span className="truncate font-normal text-muted-foreground">· {ch.label}</span>}
          </SheetTitle>
          <SheetDescription className="text-[12.5px]">Staged as an order file. Nothing goes to Meta until you apply it in a Claude session.</SheetDescription>
        </SheetHeader>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-5">
          {!data ? (
            <div className="grid h-48 place-items-center text-muted-foreground">
              {loadError ? <span className="text-[13px] text-brand-text">{loadError}</span> : <Loader2 className="size-5 animate-spin" />}
            </div>
          ) : (
            <div className="space-y-6">
              {data.error && <p className="rounded-lg border border-brand/40 px-3 py-2 text-[13px] text-brand-text">{data.error}</p>}

              {/* Channel */}
              <Section title="Channel">
                {channelLocked && ch ? (
                  <div className="text-[14px] font-medium">{ch.section === "fkb" ? companyLabel(L) : ch.label}</div>
                ) : (
                  <select
                    value={channel ?? ""}
                    onChange={(e) => {
                      const v = e.target.value || null;
                      setChannel(v);
                      setData(null);
                      void load(v);
                    }}
                    className="h-11 w-full rounded-lg border border-border bg-card px-3 text-[14px] outline-none focus-visible:ring-3 focus-visible:ring-ring/40 sm:h-9"
                    aria-label="Channel"
                  >
                    <option value="">Pick a client or {L.lane.fkb}…</option>
                    {data.channels.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                )}
                {data.hook && (
                  <p className="text-[12.5px] text-muted-foreground">
                    Hook: <span className="text-foreground">“{data.hook.text}”</span>
                    {data.angle && <span className="font-mono text-[11.5px]"> · {data.angle}</span>}
                  </p>
                )}
                {!data.hook && data.videoLine && (
                  <p className="text-[12.5px] text-muted-foreground">
                    The video&apos;s own line: <span className="text-foreground">“{data.videoLine.text}”</span>
                    {data.angle && <span className="font-mono text-[11.5px]"> · {data.angle}</span>}
                    {videoLineHere
                      ? videoLineHere.hookId == null
                        ? " · becomes this video's hook when you stage"
                        : ""
                      : " · from the first video, check it matches this file"}
                  </p>
                )}
              </Section>

              {ch && (
                <>
                  {/* Media */}
                  <Section title="Media">
                    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-2.5">
                      <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
                        {media?.ok && media.hasThumb ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`/api/media/${media.assetId}/thumb?v=${media.v}`} alt="" className="size-full object-cover" />
                        ) : (
                          <MediaIcon className="size-5 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        {media?.ok ? (
                          <>
                            <div className="truncate text-[13px] font-medium" title={media.path}>
                              {media.fileName}
                            </div>
                            <div className="text-[12px] text-muted-foreground tabular">
                              {media.kind === "video" ? "Video" : "Image"} · {formatBytes(media.bytes)}
                              {media.durationS != null && media.kind === "video" ? ` · ${formatDuration(media.durationS)}` : ""}
                            </div>
                          </>
                        ) : media ? (
                          <div className="text-[13px] text-brand-text">{media.error}</div>
                        ) : assetId ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : (
                          <div className="text-[13px] text-muted-foreground">Pick a video or an image from this channel&apos;s Library.</div>
                        )}
                      </div>
                    </div>
                    {media?.ok && media.warnings.map((w) => (
                      <p key={w} className="text-[12px] text-muted-foreground">
                        {w}
                      </p>
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" className="h-11 sm:h-8" onClick={() => setPicker("video")}>
                        <FileVideo /> {media?.ok ? "Another video" : "Pick a video"}
                      </Button>
                      <Button variant="outline" className="h-11 sm:h-8" onClick={() => setPicker("image")}>
                        <FileImage /> {media?.ok ? "Another image" : "Pick an image"}
                      </Button>
                    </div>
                  </Section>

                  {/* Copy */}
                  <Section
                    title="Copy"
                    aside={
                      <span className="text-[12px] text-muted-foreground">
                        {data.copySource === "doc"
                          ? `Prefilled from the approved copy doc (angle ${data.angle})`
                          : data.copySource === "map"
                            ? `Prefilled from the ad map's angle block (${data.angle})`
                            : ch.section === "fkb"
                              ? `${ch.label} has no approved copy doc: Draft the rest`
                              : data.angle
                                ? `No block for angle ${data.angle}: Draft the rest`
                                : data.hook
                                  ? "No angle on this hook: Draft the rest"
                                  : "No angle known: Draft the rest"}
                      </span>
                    }
                  >
                    {data.hookInPrimary && (
                      <p className="text-[12px] text-muted-foreground">
                        {data.hook ? "The hook" : "The video's line"} is longer than a headline (over 40 characters), so it opens primary 1.
                      </p>
                    )}

                    <div className="space-y-2">
                      <div className="text-[12.5px] font-medium">
                        Headlines <span className="font-normal text-muted-foreground">({HEADLINES_MIN} to {HEADLINES_MAX}, no emoji)</span>
                      </div>
                      {copy.headlines.map((h, i) => (
                        <div key={`h${i}`}>
                          <div className="flex items-center gap-1.5">
                            <span className="w-5 shrink-0 text-center text-[11.5px] text-muted-foreground tabular">{i + 1}</span>
                            <Input value={h} onChange={(e) => setLine("headlines", i, e.target.value)} className="h-11 text-[14px] sm:h-9" aria-label={`Headline ${i + 1}`} placeholder="Empty: Draft the rest fills it" />
                            {copy.headlines.length > HEADLINES_MIN && (
                              <button type="button" className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover" onClick={() => removeLine("headlines", i)} aria-label={`Remove headline ${i + 1}`}>
                                <X className="size-4" />
                              </button>
                            )}
                          </div>
                          <div className="pl-6">
                            <Problems check={slotCheck("headlines", i)} />
                          </div>
                        </div>
                      ))}
                      {copy.headlines.length < HEADLINES_MAX && (
                        <button type="button" onClick={() => addLine("headlines")} className="ml-6 inline-flex h-9 items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
                          <Plus className="size-3.5" /> Add a headline
                        </button>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="text-[12.5px] font-medium">
                        Primary texts <span className="font-normal text-muted-foreground">({PRIMARIES_MIN} to {PRIMARIES_MAX}; emoji 🏠 🛁 ✅ ⭐ 📍 👇 📅 only, double spaced)</span>
                      </div>
                      {copy.primaries.map((p, i) => (
                        <div key={`p${i}`}>
                          <div className="flex items-start gap-1.5">
                            <span className="mt-2 w-5 shrink-0 text-center text-[11.5px] text-muted-foreground tabular">{i + 1}</span>
                            <Textarea value={p} onChange={(e) => setLine("primaries", i, e.target.value)} rows={narrow ? 7 : 9} className="min-h-[120px] text-[14px] leading-snug" aria-label={`Primary text ${i + 1}`} placeholder="Empty: Draft the rest fills it" />
                            {copy.primaries.length > PRIMARIES_MIN && (
                              <button type="button" className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover" onClick={() => removeLine("primaries", i)} aria-label={`Remove primary ${i + 1}`}>
                                <X className="size-4" />
                              </button>
                            )}
                          </div>
                          <div className="pl-6">
                            <Problems check={slotCheck("primaries", i)} />
                          </div>
                        </div>
                      ))}
                      {copy.primaries.length < PRIMARIES_MAX && (
                        <button type="button" onClick={() => addLine("primaries")} className="ml-6 inline-flex h-9 items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
                          <Plus className="size-3.5" /> Add a primary text
                        </button>
                      )}
                    </div>

                    <div>
                      <div className="mb-1 text-[12.5px] font-medium">
                        Description <span className="font-normal text-muted-foreground">(exactly 1, no emoji)</span>
                      </div>
                      <Input value={copy.description} onChange={(e) => setCopy((c) => ({ ...c, description: e.target.value }))} className="h-11 text-[14px] sm:h-9" aria-label="Description" placeholder="Empty: Draft the rest fills it" />
                      {copy.description.trim() && <Problems check={check?.description} />}
                    </div>

                    {check && check.set.length > 0 && (
                      <ul className="space-y-0.5 text-[12px] text-brand-text">
                        {check.set.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    )}

                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2.5">
                      <Sparkles className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 text-[12.5px]">
                        {draftRunning ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Loader2 className="size-3.5 animate-spin" /> {draft?.view?.status === "running" ? "claude is writing the empty slots…" : "Draft queued…"}
                          </span>
                        ) : draft?.view?.status === "error" ? (
                          <span className="text-brand-text">Draft failed: {draft.view.error}</span>
                        ) : (
                          <span className="text-muted-foreground">
                            Draft the rest: claude writes the {emptySlots ? `${emptySlots} empty slot${emptySlots === 1 ? "" : "s"}` : "empty slots"} in FORMAT v4 from the brand notes{data.angle ? " and the angle" : ""}. It never overwrites what you typed.
                          </span>
                        )}
                      </div>
                      {draftRunning && draft?.view?.status === "pending" ? (
                        <Button variant="outline" size="sm" className="h-11 sm:h-8" onClick={() => start(async () => void (await cancelAdCopyJobAction({ id: draft.jobId })))}>
                          <CircleStop /> Cancel
                        </Button>
                      ) : draft?.view?.status === "error" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-11 sm:h-8"
                          onClick={() =>
                            start(async () => {
                              const r = await retryAdCopyJobAction({ id: draft.jobId });
                              if (!r.ok) toast.error(r.error);
                              else setDraft({ jobId: draft.jobId, view: null });
                            })
                          }
                        >
                          <RotateCcw /> Retry
                        </Button>
                      ) : (
                        <Button size="sm" className={cn("h-11 sm:h-8", PRIMARY_BTN)} disabled={pending || draftRunning || !emptySlots} onClick={startDraft}>
                          <Sparkles /> Draft the rest
                        </Button>
                      )}
                    </div>
                  </Section>

                  {/* Name */}
                  <Section title="Ad name">
                    {fpc && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <div>
                          <Input
                            value={concept}
                            onChange={(e) => setConcept(e.target.value.toLowerCase())}
                            className="h-11 font-mono text-[13px] sm:h-9"
                            placeholder={`concept, like ${naming.conceptExample}`}
                            aria-label="Concept"
                          />
                          {conceptBad && concept && <p className="mt-1 text-[12px] text-brand-text">{conceptBad}</p>}
                        </div>
                        <div className="flex gap-1" role="radiogroup" aria-label="ps or obj">
                          {(["ps", "obj"] as const).map((v) => (
                            <button
                              key={v}
                              type="button"
                              role="radio"
                              aria-checked={psObj === v}
                              title={PS_OBJ_LABEL[v]}
                              onClick={() => setPsObj(v)}
                              className={cn("h-11 min-w-14 rounded-lg border border-border px-3 text-[13px] font-medium sm:h-9", psObj === v ? ACTIVE_PILL : "bg-card text-muted-foreground")}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="rounded-lg border border-border bg-card px-3 py-2">
                      <div className="font-mono text-[13px] break-all">{preview}</div>
                      <div className="text-[11.5px] text-muted-foreground">
                        {fpc ? `${PS_OBJ_LABEL[psObj]}. ` : ""}Number assigned when applied (next is {data.nextN} as of now).
                      </div>
                    </div>
                  </Section>

                  {/* Context (read only) */}
                  <Section title="Where it goes">
                    <ul className="space-y-1 text-[12.5px] text-muted-foreground">
                      {data.context.lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                      {data.context.warnings.map((w) => (
                        <li key={w} className="flex gap-1 text-brand-text">
                          <AlertTriangle className="mt-px size-3.5 shrink-0" /> {w}
                        </li>
                      ))}
                      <li>
                        Button <span className="font-medium text-foreground">Learn More</span> · status <span className="font-medium text-foreground">PAUSED</span> · landing{" "}
                        <span className="font-mono text-[12px] text-foreground break-all">{ch.landing}</span>
                      </li>
                      <li className="font-mono text-[11.5px]">Ad account {ch.actId ?? "unknown"}</li>
                    </ul>
                  </Section>

                  <Section title="Note for the apply session (optional)">
                    <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} className="text-[13px]" placeholder="Anything the apply session should know" aria-label="Note for the apply session" />
                  </Section>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer: Stage + its one confirm, or the staged result */}
        <div className="border-t border-border bg-popover px-4 py-3 sm:px-5">
          {staged ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <Check className="size-4 text-foreground" /> Staged as a PAUSED ad · <span className="font-mono text-[12px]">{staged.name}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-[11.5px]" title={staged.path}>
                  {staged.path}
                </code>
                <Button variant="outline" size="sm" className="h-11 shrink-0 sm:h-8" onClick={() => copyText(pasteLine)}>
                  <Copy /> Copy line
                </Button>
              </div>
              <p className="text-[12px] text-muted-foreground">Paste the line in a Claude session to apply it. The Jobs page shows its status; Cancel there while it is staged.</p>
              <div className="flex justify-end">
                <Button variant="outline" className="h-11 sm:h-8" onClick={onClose}>
                  Done
                </Button>
              </div>
            </div>
          ) : confirming ? (
            <div className="space-y-2">
              <p className="text-[13px] font-medium">{CONFIRM_TEXT}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" className="h-11 sm:h-8" onClick={() => setConfirming(false)} disabled={pending}>
                  Back
                </Button>
                <Button className={cn("h-11 sm:h-8", PRIMARY_BTN)} onClick={stage} disabled={pending || !canStage}>
                  {pending ? <Loader2 className="animate-spin" /> : <Megaphone />} Stage as PAUSED
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 text-[12px] text-muted-foreground">
                {stageError ? (
                  <span className="text-brand-text">{stageError}</span>
                ) : !ch ? (
                  "Pick the channel first."
                ) : !mediaOk ? (
                  "Pick a video or an image."
                ) : check && !check.ok ? (
                  `${check.all.length} check${check.all.length === 1 ? "" : "s"} to fix before Stage.`
                ) : conceptBad ? (
                  conceptBad
                ) : (
                  "Every check passes."
                )}
              </div>
              <Button variant="outline" className="h-11 sm:h-8" onClick={onClose}>
                Close
              </Button>
              <Button className={cn("h-11 sm:h-8", PRIMARY_BTN)} disabled={!canStage || pending || draftRunning} onClick={() => setConfirming(true)}>
                <Megaphone /> Stage
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
      {picker && ch && (
        <FilePickerDialog
          scopeQuery={pickerScope}
          kind={picker}
          title="Pick the ad's media"
          subtitle={`${ch.section === "fkb" ? `${ch.label}'s Library` : `${ch.label}'s Library (and shared ${L.lane.fkbpros} files)`} · ${picker === "video" ? "videos" : "images"}`}
          onClose={() => setPicker(null)}
          onPick={async (asset) => {
            setPicker(null);
            await pickMedia(asset.id);
          }}
        />
      )}
    </Sheet>
  );
}
