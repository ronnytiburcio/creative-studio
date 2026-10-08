"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clapperboard,
  Copy,
  FileText,
  FileVideo,
  Kanban,
  Lightbulb,
  Link2,
  Link2Off,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Scissors,
  ThumbsUp,
  Trash2,
  CirclePlay,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStatus, useStatusRefresh } from "@/components/shell/status-provider";
import {
  approveShortAction,
  cancelShortJobAction,
  cutReelAction,
  decideShortAction,
  linkShortOutputAction,
  makeExplainerAction,
  newShortAction,
  setColdOpenAction,
  nudgeShortAction,
  retryShortJobAction,
  setShortHookWordsAction,
  setShortLayoutAction,
  setShortStatusAction,
  unlinkShortOutputAction,
} from "@/app/actions";
import { FilePickerDialog } from "@/components/running/link-file";
import { clockMSS, DEFAULT_HANDOFF_FORMAT, formatLabel, handoffFormatHint, HANDOFF_FORMATS, type HandoffFormat } from "@/lib/shorts/handoff-text";
import { HookWordsBlock, KitTagPill, ViewedVsMedian } from "./kit-ui";
import { PP_IDS, PP_LABEL } from "@/lib/hooks/rubric";
import { formatDuration } from "@/lib/media";
import { fmtClock } from "@/lib/shorts/srt";
import { HOOK_WORDS_MAX, HOOK_WORDS_MIN, SHORT_LAYOUT_LABEL, SHORT_LAYOUTS, SHORT_STATUS_LABEL, SHORT_STATUSES, type ShortStatus } from "@/lib/shorts/vocab";
import type { Board, ColdChoice, ShortCard } from "@/lib/shorts/board";
import type { ViewMedian } from "@/lib/shorts/kit";
import type { EpisodeView, TranscriptState } from "@/lib/shorts/episodes";
import type { MomentJobView } from "@/lib/shorts/moments";
import { ACTIVE_PILL, PRIMARY_BTN, ppPillCls } from "@/components/hooks/ui";
import { useLabels } from "@/components/shell/labels-provider";

type Act = () => Promise<{ ok: boolean; error?: string; message?: string }>;

/** Board wide numbers the cards compare against (Phase 7 D3): the channel's median "% viewed". */
const BoardCtx = createContext<{ channelMedian: ViewMedian }>({ channelMedian: { median: null, count: 0 } });

/** Phone first: 44 px tap targets under 768 px, the usual compact sizes above. */
const TAP = "min-h-11 md:min-h-0";
const ghostBtn =
  "inline-flex items-center justify-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45 md:h-7 md:text-[12.5px]";

function useAct() {
  const router = useRouter();
  const refreshStatus = useStatusRefresh();
  const [pending, start] = useTransition();
  const run = (fn: Act, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else {
        if (r.message) toast.success(r.message);
        after?.();
      }
      await refreshStatus();
      router.refresh();
    });
  return [pending, run] as const;
}

async function copyText(text: string, what = "Copied.") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    toast.error("Could not copy: select the text and copy it by hand.");
  }
}

/** The reel file: its 9:16 poster, playing its proxy on hover (or focus) when one exists. */
function OutputPoster({ out }: { out: NonNullable<ShortCard["output"]> }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div
      className="relative aspect-[9/16] w-[56px] shrink-0 overflow-hidden rounded-md bg-ink"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {out.hasThumb && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/media/${out.assetId}/thumb${out.v ? `?v=${out.v}` : ""}`} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center text-paper/60">
          <FileVideo className="size-4" />
        </div>
      )}
      {hover && out.hasProxy && out.visible && (
        <video src={`/api/media/${out.assetId}/proxy`} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" />
      )}
    </div>
  );
}

function Poster({ card }: { card: ShortCard }) {
  if (card.output) return <OutputPoster out={card.output} />;
  if (card.explainer) {
    return (
      <div className="grid aspect-video w-[88px] shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Lightbulb className="size-4" />
      </div>
    );
  }
  return <MasterPoster card={card} />;
}

function MasterPoster({ card }: { card: ShortCard }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [card.master?.assetId]);
  const m = card.master;
  return (
    <div className="aspect-video w-[88px] shrink-0 overflow-hidden rounded-md bg-ink">
      {m?.hasThumb && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={ref}
          src={`/api/media/${m.assetId}/thumb${m.v ? `?v=${m.v}` : ""}`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center text-paper/60">
          <FileVideo className="size-4" />
        </div>
      )}
    </div>
  );
}

function ScoreLine({ card }: { card: ShortCard }) {
  const L = useLabels();
  const s = card.score;
  const what = card.cold ? "the cold open" : "the first line";
  if (!s || s.overall == null) {
    return (
      <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
        {card.scoreError ? (
          <span className="text-brand-text">Score failed: {card.scoreError}</span>
        ) : card.scoring ? (
          <>
            <Loader2 className="size-3.5 animate-spin" /> Scoring: Jev is scoring {what}
          </>
        ) : (
          "Not scored"
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {card.hookHref ? (
        <Link
          href={card.hookHref}
          className="inline-flex h-6 items-center rounded-md border border-border bg-card px-1.5 text-[13px] font-semibold tabular hover:bg-hover"
          title={`${card.cold ? "Cold open" : "First line"} overall ${s.overall.toFixed(2)} (rubric v${s.version}): open the hook on the ${L.lane.rtm} Hooks tab`}
        >
          {s.overall.toFixed(1)}
        </Link>
      ) : (
        <span className="text-[13px] font-semibold tabular">{s.overall.toFixed(1)}</span>
      )}
      {PP_IDS.map((id) => (
        <span key={id} className={ppPillCls(s.pp[id])} title={`${PP_LABEL[id]} clear: ${s.pp[id] != null ? Math.round(s.pp[id]! * 100) : "?"}% yes`}>
          {PP_LABEL[id]}
        </span>
      ))}
      {card.scoring && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="rescoring" />}
    </div>
  );
}

/** The first line's own score, small, when the card's main hook is its cold open (Phase 7 B2). */
function LineScore({ line }: { line: NonNullable<ShortCard["line"]> }) {
  const v = line.overall != null ? line.overall.toFixed(1) : line.scoring ? "scoring" : "not scored";
  const body = (
    <>
      First line <span className="font-medium tabular">{v}</span>
    </>
  );
  return line.href ? (
    <Link href={line.href} className="text-[11.5px] text-muted-foreground hover:text-foreground hover:underline" title="The first line's own hook score (still scored; the cold open is the main hook)">
      {body}
    </Link>
  ) : (
    <span className="text-[11.5px] text-muted-foreground">{body}</span>
  );
}

/** The cold open line (Phase 7 B1): what the reel plays first, under the hook words. */
function ColdOpenLine({ card }: { card: ShortCard }) {
  if (card.explainer) return null;
  if (!card.cold) {
    return <div className="mt-2 text-[12.5px] text-brand-text">No cold open yet: pick one in Edit (Cut reel needs it).</div>;
  }
  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/40 px-2 py-1.5">
      <div className="text-[11.5px] text-muted-foreground tabular">
        Cold open · {fmtClock(card.cold.start)} to {fmtClock(card.cold.end)} · {(card.cold.end - card.cold.start).toFixed(1)} s
      </div>
      <p className="text-[14px] leading-snug md:text-[13px]">&ldquo;{card.cold.text}&rdquo;</p>
    </div>
  );
}

/**
 * The cold open picker (Phase 7 B4, in the Edit panel): the moment's sentences; click one, or two adjacent, then Set.
 * The server checks the pick again (2 to 6 s, inside the moment, copy rules) and links / makes its hook.
 */
function ColdOpenPicker({ card }: { card: ShortCard }) {
  type Loaded = { key: string; data: { unit: "sentence" | "cue"; units: ColdChoice[]; selected: number[] } | null; error: string | null };
  // Each load is tagged with what it was fetched for: a refetch (new times / cold open) starts clean, with the loading
  // line and no stale error from an earlier failed load (gate fix), without a synchronous setState in the effect.
  const loadKey = `${card.id}:${card.start}:${card.end}:${card.cold?.start ?? ""}:${card.cold?.end ?? ""}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const data = loaded?.key === loadKey ? loaded.data : null;
  const error = loaded?.key === loadKey ? loaded.error : null;
  const [sel, setSel] = useState<number[]>([]);
  const [pending, run] = useAct();
  useEffect(() => {
    let live = true;
    fetch(`/api/shorts/${card.id}/sentences`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json();
        if (!live) return;
        if (!r.ok) setLoaded({ key: loadKey, data: null, error: body.error ?? "Not available" });
        else {
          setLoaded({ key: loadKey, data: body, error: null });
          setSel(body.selected ?? []);
        }
      })
      .catch(() => live && setLoaded({ key: loadKey, data: null, error: "Could not load the sentences." }));
    return () => {
      live = false;
    };
  }, [card.id, loadKey]);
  const pick = (i: number) =>
    setSel((cur) => {
      if (cur.includes(i)) return cur.filter((x) => x !== i);
      if (cur.length === 1 && Math.abs(cur[0] - i) === 1) return [cur[0], i].sort((a, b) => a - b);
      return [i];
    });
  // Scroll the list (never the page) to the current cold open once the sentences are in.
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const ol = listRef.current;
    const li = ol?.querySelector<HTMLElement>("[data-picked='true']");
    if (ol && li) ol.scrollTop = Math.max(0, li.offsetTop - 8); // the list is `relative`: offsetTop is inside it
  }, [data]);
  const chosen = data ? data.units.filter((u) => sel.includes(u.i)) : [];
  const span = chosen.length ? chosen[chosen.length - 1].end - chosen[0].start : 0;
  const unchanged = data != null && sel.length > 0 && sel.length === data.selected.length && sel.every((x) => data.selected.includes(x));
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <div className="text-[12px] text-muted-foreground">
        Cold open: click one {data?.unit === "cue" ? "cue" : "sentence"}, or two next to each other (2 to 6 s). It plays first and is the card&apos;s main hook.
      </div>
      {error ? (
        <div className="text-[12.5px] text-brand-text">{error}</div>
      ) : !data ? (
        <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading the sentences…
        </div>
      ) : (
        <ol ref={listRef} className="relative grid max-h-64 grid-cols-1 gap-1 overflow-y-auto pr-1" aria-label="Sentences of the moment">
          {data.units.map((u) => {
            const on = sel.includes(u.i);
            const d = u.end - u.start;
            return (
              <li key={u.i} data-picked={data.selected.includes(u.i) ? "true" : undefined}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => pick(u.i)}
                  className={cn(
                    "flex min-h-11 w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-[13px] leading-snug md:min-h-0",
                    on ? `border-transparent ${ACTIVE_PILL}` : "border-border bg-card hover:bg-hover",
                  )}
                >
                  <span className={cn("w-10 shrink-0 text-[11.5px] tabular", on ? "opacity-80" : "text-muted-foreground")}>{d.toFixed(1)} s</span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{u.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {data && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className={cn(TAP, PRIMARY_BTN)}
            disabled={pending || !chosen.length || unchanged}
            onClick={() => chosen.length && run(() => setColdOpenAction({ id: card.id, start: chosen[0].start, end: chosen[chosen.length - 1].end }))}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Check />} {card.cold ? "Swap cold open" : "Set cold open"}
          </Button>
          {chosen.length > 0 && <span className="text-[12px] text-muted-foreground tabular">{(span + 0.4).toFixed(1)} s with the pad</span>}
        </div>
      )}
    </div>
  );
}

function HookWordsEditor({ card, onDone }: { card: ShortCard; onDone: () => void }) {
  const [value, setValue] = useState(card.hookWords);
  const [pending, run] = useAct();
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => setShortHookWordsAction({ id: card.id, words: value }), onDone);
      }}
    >
      <Input
        value={value}
        maxLength={80}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`Hook words (${HOOK_WORDS_MIN} to ${HOOK_WORDS_MAX}, all caps, *one block* in orange)`}
        placeholder="YOU PAID FOR *THIS LEAD*"
        className="h-11 min-w-0 flex-1 basis-[140px] text-[16px] uppercase md:h-8 md:text-[13px]"
      />
      <Button type="submit" size="sm" className={cn(TAP, PRIMARY_BTN)} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <Check />} Save
      </Button>
    </form>
  );
}

function Nudge({ card, edge }: { card: ShortCard; edge: "start" | "end" }) {
  const [pending, run] = useAct();
  const go = (dir: -1 | 1) => run(() => nudgeShortAction({ id: card.id, edge, dir }));
  const label = edge === "start" ? "Start" : "End";
  const unit = card.nudgeUnit === "sentence" ? "sentence" : "cue";
  const sq = cn(ghostBtn, "min-w-11 border border-border md:min-w-8");
  return (
    <div className="flex items-center gap-1">
      <span className="w-9 text-[12px] text-muted-foreground">{label}</span>
      <button type="button" className={cn(sq, TAP)} disabled={pending} onClick={() => go(-1)} aria-label={`${label} one ${unit} earlier`} title={`One ${unit} earlier`}>
        <ChevronLeft className="size-4" />
      </button>
      <span className="w-12 text-center text-[13px] tabular">{fmtClock(edge === "start" ? card.start : card.end)}</span>
      <button type="button" className={cn(sq, TAP)} disabled={pending} onClick={() => go(1)} aria-label={`${label} one ${unit} later`} title={`One ${unit} later`}>
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

/** The reel, caption, hand-off and posted Short of a card (slice 2: the automatic moves' evidence). */
function ReelBlock({ card, onLink }: { card: ShortCard; onLink: () => void }) {
  const [pending, run] = useAct();
  const { channelMedian } = useContext(BoardCtx);
  const out = card.output;
  const showLink = card.explainer || card.status !== "idea";
  return (
    // grid-cols-1 = minmax(0, 1fr): a long file name or Short title truncates inside the card instead of widening the track.
    <div className="mt-2 grid grid-cols-1 gap-1.5">
      {card.explainer && card.explainerLine && card.status === "idea" && (
        <button
          type="button"
          className={cn(ghostBtn, TAP, "justify-self-start border border-border")}
          onClick={() => copyText(card.explainerLine!, "Paste line copied.")}
          title={card.explainerLine}
        >
          <Copy className="size-3.5" /> Copy paste line
        </button>
      )}
      {card.handoff && card.status === "cutting" && (
        <div className="rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-[12.5px]">
          <div className="flex min-w-0 items-start gap-1.5">
            <Scissors className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 break-words" title={card.handoff.path}>
              Handed off {card.handoff.format === "kit" ? `on ${card.handoff.formatLabel}` : `in ${card.handoff.format} (${card.handoff.formatLabel})`}
            </span>
          </div>
          <div className="mt-0.5 text-[11.5px] break-words text-muted-foreground [overflow-wrap:anywhere]" title={card.handoff.path}>
            {card.handoff.filename} · moves to Review when the reel file shows up
          </div>
          <button type="button" className={cn(ghostBtn, TAP, "mt-1 border border-border")} onClick={() => copyText(card.handoff!.line, "Paste line copied.")} title="Copy the line to paste into a live session">
            <Copy className="size-3.5" /> Copy paste line
          </button>
        </div>
      )}
      {out ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px]">
          <FileVideo className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 flex-1 basis-[120px] truncate", !out.visible && "line-through opacity-70")} title={out.filename}>
            {out.filename}
          </span>
          {/* The label and its button wrap together (never a lone icon on its own line). */}
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">{!out.visible ? "file gone" : out.source === "manual" ? "linked by you" : "matched"}</span>
            {out.source === "manual" ? (
              <button type="button" className={cn(ghostBtn, TAP)} disabled={pending} onClick={() => run(() => unlinkShortOutputAction({ id: card.id }))} title="Unlink: back to the automatic match">
                <Link2Off className="size-3.5" />
                <span className="sr-only">Unlink</span>
              </button>
            ) : (
              <button type="button" className={cn(ghostBtn, TAP)} onClick={onLink} title="Link another file">
                <Link2 className="size-3.5" />
                <span className="sr-only">Link another file</span>
              </button>
            )}
          </span>
        </div>
      ) : (
        showLink && (
          <button
            type="button"
            className={cn(ghostBtn, TAP, "justify-start border border-dashed border-foreground/15")}
            onClick={onLink}
            title={card.status === "idea" || card.status === "cutting" ? "Link the finished reel: moves the card to Review" : "Link the finished reel"}
          >
            <Link2 className="size-3.5" /> Link a file
          </button>
        )
      )}
      {!out && card.linkHint && (
        <button
          type="button"
          className={cn(TAP, "inline-flex items-center justify-self-start text-left text-[11.5px] text-muted-foreground hover:text-foreground hover:underline")}
          onClick={onLink}
          title="Only reel files written after the card entered Cutting move it by themselves: link one made earlier"
        >
          Reel already made? Link a file
        </button>
      )}
      {out && (card.status === "review" || card.status === "ready" || card.status === "posted") &&
        (card.caption ? (
          <details className="group">
            <summary className={cn("flex min-w-0 cursor-pointer list-none items-center gap-1 overflow-hidden text-[12.5px] text-muted-foreground select-none hover:text-foreground", TAP)}>
              <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
              <FileText className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={card.caption.filename}>Caption · {card.caption.filename}</span>
            </summary>
            <p className="mt-1 text-[12.5px] leading-snug whitespace-pre-line text-foreground/85 [overflow-wrap:anywhere]">{card.caption.preview}</p>
          </details>
        ) : (
          <div className="flex items-center gap-1 text-[12.5px] text-brand-text">
            <FileText className="size-3.5" /> No caption file yet
          </div>
        ))}
      {card.status === "review" && (
        <Button
          size="sm"
          className={cn(TAP, PRIMARY_BTN, "justify-self-start")}
          disabled={pending || !out || !card.caption}
          title={!out ? "No reel file yet" : !card.caption ? "No caption file yet" : "Approve: ready to post"}
          onClick={() => run(() => approveShortAction({ id: card.id }))}
        >
          {pending ? <Loader2 className="animate-spin" /> : <ThumbsUp />} Approve
        </Button>
      )}
      {card.short && (
        <a
          href={`https://www.youtube.com/shorts/${card.short.videoId}`}
          target="_blank"
          rel="noreferrer"
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border px-2 py-1.5 text-[12.5px] hover:bg-hover"
          title={card.short.title ?? undefined}
        >
          <CirclePlay className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 basis-[120px] truncate">{card.short.title ?? card.short.videoId}</span>
          <span className="tabular">{card.short.views != null ? `${card.short.views.toLocaleString()} views` : "no numbers yet"}</span>
          <ViewedVsMedian pct={card.short.avgViewPct} views={card.short.views} median={channelMedian} />
        </a>
      )}
      {out && card.kit && (card.status === "review" || card.status === "ready" || card.status === "posted") && <KitTagPill tag={card.kit} className="justify-self-start" />}
    </div>
  );
}

function CardView({ card }: { card: ShortCard }) {
  const L = useLabels();
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [pending, run] = useAct();
  const router = useRouter();
  const dur = card.end - card.start;
  return (
    // relative: the card is the containing block of its sr-only labels (absolutely positioned), so they are clipped with it
    // and never stretch the page's scroll width.
    <article className={cn("relative min-w-0 overflow-hidden rounded-xl border border-border bg-card p-3", card.kept == null && "border-l-[3px] border-l-brand")}>
      <div className="flex gap-2.5">
        <Poster card={card} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-medium" title={card.episode ?? undefined}>
              {card.explainer ? "Explainer idea" : (card.episode ?? "No episode")}
            </span>
            {card.k != null && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{card.k}</span>}
          </div>
          {card.explainer ? (
            <div className="text-[12.5px] text-muted-foreground">
              {card.source?.num != null ? `From ${L.episodes.prefix}${card.source.num} at ${clockMSS(card.source.start)}` : `From a ${L.lane.rtm} hook`} · made with {L.skills.explainer}
            </div>
          ) : (
            <>
              <div className="text-[12.5px] text-muted-foreground tabular">
                {fmtClock(card.start)} to {fmtClock(card.end)} · {Math.round(dur)} s
              </div>
              <div className="text-[12px] text-muted-foreground">
                {SHORT_LAYOUT_LABEL[card.layout]}
                {card.kept == null ? <span className="ml-1.5 font-medium text-brand-text">Undecided</span> : card.kept ? <span className="ml-1.5">· Kept</span> : null}
              </div>
            </>
          )}
        </div>
      </div>

      {card.hookWords ? <HookWordsBlock words={card.hookWords} className="mt-2.5" /> : null}
      <ColdOpenLine card={card} />
      <div className="mt-2">
        <ScoreLine card={card} />
      </div>
      {card.cold ? (
        <div className="mt-2 grid grid-cols-1 gap-0.5">
          <p className="text-[13px] leading-snug text-foreground/80 md:text-[12.5px]">&ldquo;{card.firstLine}&rdquo;</p>
          {card.line && <LineScore line={card.line} />}
        </div>
      ) : (
        <p className="mt-2 text-[15px] leading-snug text-foreground md:text-[13.5px]">&ldquo;{card.firstLine}&rdquo;</p>
      )}
      {card.why && (
        <details className="group mt-1.5">
          <summary className={cn("flex cursor-pointer list-none items-center gap-1 text-[12.5px] text-muted-foreground select-none hover:text-foreground", TAP)}>
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Why this moment
          </summary>
          <p className="mt-1 text-[13.5px] leading-snug text-foreground/85 md:text-[12.5px]">{card.why}</p>
        </details>
      )}

      <ReelBlock card={card} onLink={() => setLinking(true)} />

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {card.kept == null && (
          <>
            <Button size="sm" variant="outline" className={TAP} disabled={pending} onClick={() => run(() => decideShortAction({ id: card.id, keep: true }))}>
              <Check /> Keep
            </Button>
            <Button size="sm" variant="ghost" className={cn(TAP, "text-muted-foreground")} disabled={pending} onClick={() => run(() => decideShortAction({ id: card.id, keep: false }))}>
              <Trash2 /> Discard
            </Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className={TAP} disabled={pending}>
              {SHORT_STATUS_LABEL[card.status]} <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={card.status} onValueChange={(v) => run(() => setShortStatusAction({ id: card.id, status: v }))}>
              {SHORT_STATUSES.map((s) => (
                <DropdownMenuRadioItem key={s} value={s} className="min-h-11 md:min-h-0">
                  {SHORT_STATUS_LABEL[s]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {!card.explainer && card.mainHookId != null && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="min-h-11 md:min-h-0" onSelect={() => run(() => makeExplainerAction({ id: card.id }))}>
                  <Lightbulb /> Make explainer
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" className={cn(ghostBtn, TAP, "ml-auto")} onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
          <Pencil className="size-3.5" /> {editing ? "Done" : "Edit"}
        </button>
        {card.kept === true && (
          <button type="button" className={cn(ghostBtn, TAP)} disabled={pending} onClick={() => run(() => decideShortAction({ id: card.id, keep: false }))} title="Discard this card">
            <Trash2 className="size-3.5" />
            <span className="sr-only">Discard</span>
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg border border-border bg-muted/40 p-2">
          {card.episodeId != null && (
            <>
              <Nudge card={card} edge="start" />
              <Nudge card={card} edge="end" />
              <ColdOpenPicker card={card} />
            </>
          )}
          <HookWordsEditor card={card} onDone={() => undefined} />
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Layout</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className={TAP} disabled={pending}>
                  {SHORT_LAYOUT_LABEL[card.layout]} <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuRadioGroup value={card.layout} onValueChange={(v) => run(() => setShortLayoutAction({ id: card.id, layout: v }))}>
                  {SHORT_LAYOUTS.map((l) => (
                    <DropdownMenuRadioItem key={l} value={l} className="min-h-11 md:min-h-0">
                      {SHORT_LAYOUT_LABEL[l]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <p className="text-[12px] leading-snug text-muted-foreground">
            {card.explainer
              ? `An explainer idea: its hook words are the headline ${L.skills.explainer} opens on (*one part* in the orange block).`
              : `The arrows move one ${card.nudgeUnit === "sentence" ? "sentence" : "transcript cue"} (30 to 90 s). A new start gives a new first line, which Jev scores again. Hook words: ${HOOK_WORDS_MIN} to ${HOOK_WORDS_MAX}, mark the orange block with *one pair*.`}
          </p>
        </div>
      )}
      {linking && (
        <FilePickerDialog
          scopeQuery="scope=rtm"
          kind="video"
          subtitle={`${card.explainer ? "Explainer idea" : `${card.episode} #${card.k}`} · the finished reel (${L.lane.rtm} videos)`}
          onClose={() => setLinking(false)}
          onPick={async (asset) => {
            const r = await linkShortOutputAction({ id: card.id, assetId: asset.id });
            if (!r.ok) toast.error(r.error);
            else {
              if (r.message) toast.success(r.message);
              setLinking(false);
              router.refresh();
            }
          }}
        />
      )}
    </article>
  );
}

function Column({ status, cards, weaker = [], gate }: { status: ShortStatus; cards: ShortCard[]; weaker?: ShortCard[]; gate?: number }) {
  const [showWeak, setShowWeak] = useState(false);
  return (
    <section aria-label={SHORT_STATUS_LABEL[status]} className="flex min-w-0 flex-col gap-2 lg:min-w-[216px] lg:flex-1 lg:basis-0">
      <header className="hidden items-baseline gap-2 px-1 lg:flex">
        <h3 className="text-[13px] font-semibold">{SHORT_STATUS_LABEL[status]}</h3>
        <span className="text-[12px] text-muted-foreground tabular">
          {cards.length}
          {weaker.length ? ` + ${weaker.length} weaker` : ""}
        </span>
      </header>
      {cards.length === 0 && weaker.length === 0 ? (
        <div className="rounded-xl border border-dashed border-foreground/15 px-3 py-6 text-center text-[13px] text-muted-foreground">
          {status === "idea" ? "No ideas yet. New short picks moments from an episode." : "Nothing here yet."}
        </div>
      ) : (
        cards.map((c) => <CardView key={c.id} card={c} />)
      )}
      {weaker.length > 0 && (
        <>
          <button
            type="button"
            className={cn(ghostBtn, TAP, "justify-start border border-dashed border-foreground/15")}
            aria-expanded={showWeak}
            onClick={() => setShowWeak((v) => !v)}
            title={`Undecided ideas whose main hook scored under ${gate?.toFixed(1)} (the gate in Settings)`}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", showWeak && "rotate-90")} />
            {showWeak ? "Hide weaker" : "Show weaker"} ({weaker.length}) · under {gate?.toFixed(1)}
          </button>
          {showWeak && weaker.map((c) => <CardView key={c.id} card={c} />)}
        </>
      )}
    </section>
  );
}

function JobStrip({ jobs }: { jobs: MomentJobView[] }) {
  const [pending, run] = useAct();
  if (!jobs.length) return null;
  return (
    <ul className="mt-3 grid gap-2">
      {jobs.map((j) => (
        <li key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px]">
          {j.status === "error" ? (
            <>
              <span className="font-medium text-brand-text">Moments for {j.episode} failed</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={j.error ?? undefined}>
                {j.error}
              </span>
              <Button size="sm" variant="outline" className={TAP} disabled={pending} onClick={() => run(() => retryShortJobAction({ id: j.id }))}>
                <RotateCcw /> Retry
              </Button>
            </>
          ) : (
            <>
              <Loader2 className={cn("size-4 text-muted-foreground", j.status === "running" && "animate-spin")} />
              <span className="min-w-0 flex-1">
                {j.status === "running"
                  ? `Writing moments for ${j.episode}…`
                  : j.waitingWords
                    ? `${j.episode}: waiting for the word-timed transcript`
                    : `Waiting to write moments for ${j.episode}`}
              </span>
              {j.status === "pending" && (
                <Button size="sm" variant="outline" className={TAP} disabled={pending} onClick={() => run(() => cancelShortJobAction({ id: j.id }))}>
                  <CircleStop /> Cancel
                </Button>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The word-timed transcript's state in the New short picker. */
function TranscriptLine({ t, picked }: { t: TranscriptState; picked: boolean }) {
  const muted = picked ? "opacity-80" : "text-muted-foreground";
  if (t.state === "ready") return <span className={cn("block text-[12px] tabular", muted)}>{t.sentences.toLocaleString()} sentences (word-timed transcript)</span>;
  if (t.state === "running")
    return (
      <span className={cn("flex items-center gap-1 text-[12px]", muted)}>
        <Loader2 className="size-3 animate-spin" /> Transcribing…
      </span>
    );
  if (t.state === "waiting_proxy") return <span className={cn("block text-[12px]", muted)}>Waiting for the preview copy</span>;
  if (t.state === "error") return <span className={cn("block truncate text-[12px]", picked ? "opacity-90" : "text-brand-text")}>Transcript failed: {t.error}</span>;
  return <span className={cn("block text-[12px]", muted)}>Transcribing soon (the worker makes it in a minute or two)</span>;
}

/** "New short": pick an episode, one claude run proposes moments (5 to 8) that land in Idea. */
function NewShortDialog({
  open,
  onOpenChange,
  episodes,
  notPrepped,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  episodes: EpisodeView[];
  notPrepped: { folder: string; title: string; filename: string }[];
  initial: number | null;
}) {
  const L = useLabels();
  const [picked, setPicked] = useState<number | null>(initial);
  const [pending, run] = useAct();
  const { worker } = useStatus();
  const ep = episodes.find((e) => e.id === picked) ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>New short</DialogTitle>
          <DialogDescription>
            Pick a prepped episode. claude reads its word-timed transcript and proposes 5 to 8 moments of 30 to 60 s that start and end on a sentence
            ({L.skills.reelCut}&apos;s rules); the ones that pass the checks land in Idea and Jev scores their first lines. An episode still being transcribed
            waits for it.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1.5" role="radiogroup" aria-label="Episode">
          {episodes.map((e) => {
            const disabled = !e.cueCount || e.activeJob != null;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={picked === e.id}
                  disabled={disabled}
                  onClick={() => setPicked(e.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors min-h-11 disabled:opacity-55",
                    picked === e.id ? "border-transparent " + ACTIVE_PILL : "border-border bg-card hover:bg-hover",
                  )}
                >
                  <Clapperboard className="size-4 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{e.label}</span>
                    <span className={cn("block text-[12px] tabular", picked === e.id ? "opacity-80" : "text-muted-foreground")}>
                      {e.readError
                        ? `Could not read the transcript: ${e.readError}`
                        : `${formatDuration(e.durationS)} · ${e.cards} card${e.cards === 1 ? "" : "s"}${e.undecided ? ` (${e.undecided} undecided)` : ""}${e.activeJob ? " · writing now" : ""}`}
                    </span>
                    {!e.readError && <TranscriptLine t={e.transcript} picked={picked === e.id} />}
                  </span>
                </button>
              </li>
            );
          })}
          {notPrepped.map((f) => (
            <li key={f.folder} className="flex items-center gap-3 rounded-lg border border-dashed border-foreground/15 px-3 py-2 text-[13px] text-muted-foreground">
              <FileVideo className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground/80">{f.title}</span>
                <span className="block text-[12px]">Not prepped yet: run {L.skills.episodePrep}</span>
              </span>
            </li>
          ))}
          {episodes.length === 0 && notPrepped.length === 0 && (
            <li className="text-[13px] text-muted-foreground">No {L.lane.rtm} episodes found yet. The worker lists them within a minute of starting.</li>
          )}
        </ul>
        <DialogFooter className="items-center">
          <span className="mr-auto text-[12px] text-muted-foreground">One claude run on your subscription (about a minute) · Jev scoring about $0.002</span>
          <Button type="button" variant="ghost" className={TAP} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            className={cn(TAP, PRIMARY_BTN)}
            disabled={pending || !ep || !worker.alive}
            title={!worker.alive ? "The worker is offline" : undefined}
            onClick={() => ep && run(() => newShortAction({ episodeId: ep.id }), () => onOpenChange(false))}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Plus />} Write moments{ep ? ` for ${ep.short}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Cut reel (Phase 6 D): kept Idea cards of ONE episode + a format -> Studio writes the list in the reel cut skill's
 * `reels.json` shape into its own hand-off folder and shows the line to paste into a live session. Never a render.
 */
function CutReelDialog({
  open,
  onOpenChange,
  episodes,
  ideas,
  initial,
  kitVersion,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  episodes: EpisodeView[];
  ideas: ShortCard[];
  initial: number | null;
  kitVersion: number;
}) {
  const router = useRouter();
  const refreshStatus = useStatusRefresh();
  const L = useLabels();
  const withKept = episodes.filter((e) => ideas.some((c) => c.episodeId === e.id));
  const [epId, setEpId] = useState<number | null>(initial ?? withKept[0]?.id ?? null);
  const cards = ideas.filter((c) => c.episodeId === epId).sort((a, b) => (a.k ?? 0) - (b.k ?? 0));
  // Phase 7 B4: a card without a cold open cannot go (Cut reel refuses it), so it starts unticked and disabled.
  const [picked, setPicked] = useState<Set<number>>(() => new Set(ideas.filter((c) => c.episodeId === (initial ?? withKept[0]?.id) && c.cold).map((c) => c.id)));
  const [format, setFormat] = useState<HandoffFormat>(DEFAULT_HANDOFF_FORMAT);
  const [result, setResult] = useState<{ path: string; line: string } | null>(null);
  const [pending, start] = useTransition();
  const ep = episodes.find((e) => e.id === epId) ?? null;
  const chooseEpisode = (id: number) => {
    setEpId(id);
    setPicked(new Set(ideas.filter((c) => c.episodeId === id && c.cold).map((c) => c.id)));
  };
  const toggle = (id: number) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const write = () =>
    start(async () => {
      if (!ep) return;
      const r = await cutReelAction({ episodeId: ep.id, cardIds: cards.filter((c) => picked.has(c.id)).map((c) => c.id), format });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message);
      setResult({ path: r.path, line: r.line });
      await refreshStatus();
      router.refresh();
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Cut reel</DialogTitle>
          <DialogDescription>
            Studio writes the approved moments as a list for {L.skills.reelCut} and gives you a line to paste into a live session. It never cuts or renders
            anything, and never writes to the episode folder. The cards move to Cutting, then to Review when the reel file shows up.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-3">
            <div className="text-[13px]">
              <div className="text-muted-foreground">List written to</div>
              <div className="font-mono text-[12px] break-all">{result.path}</div>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="paste-line" className="text-[13px] text-muted-foreground">
                Paste this into a live Claude session
              </label>
              <textarea id="paste-line" readOnly value={result.line} rows={5} className="w-full rounded-lg border border-border bg-muted/40 p-2 text-[14px] leading-snug md:text-[13px]" onFocus={(e) => e.currentTarget.select()} />
              <Button className={cn(TAP, PRIMARY_BTN, "justify-self-start")} onClick={() => copyText(result.line, "Paste line copied.")}>
                <Copy /> Copy line
              </Button>
            </div>
            <DialogFooter>
              <Button variant="ghost" className={TAP} onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : withKept.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No kept ideas yet. Keep the moments you want on the board first.</p>
        ) : (
          <div className="grid gap-4">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Episode">
              {withKept.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  aria-checked={epId === e.id}
                  onClick={() => chooseEpisode(e.id)}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-[14px] md:min-h-9 md:text-[13px]",
                    epId === e.id ? `border-transparent ${ACTIVE_PILL}` : "border-border bg-card text-muted-foreground hover:bg-hover",
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-[13px] text-muted-foreground">Kept ideas ({picked.size} of {cards.length})</legend>
              {cards.map((c) => (
                <label
                  key={c.id}
                  className={cn(
                    "flex min-h-11 items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2",
                    c.cold ? "cursor-pointer hover:bg-hover" : "cursor-not-allowed opacity-70",
                  )}
                >
                  <input type="checkbox" checked={picked.has(c.id)} disabled={!c.cold} onChange={() => toggle(c.id)} className="mt-1 size-4 accent-brand" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
                      <span className="font-mono text-[11px] text-muted-foreground">#{c.k}</span>
                      <span className="min-w-0 font-semibold break-words">{c.hookWords}</span>
                      <span className="ml-auto shrink-0 text-[12px] text-muted-foreground tabular">
                        {fmtClock(c.start)} · {Math.round(c.end - c.start)} s
                      </span>
                    </span>
                    {c.cold ? (
                      <span className="block truncate text-[12.5px] text-muted-foreground">Cold open: {c.cold.text}</span>
                    ) : (
                      <span className="block text-[12.5px] font-medium text-brand-text">Pick a cold open first (Edit on the card)</span>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset className="grid gap-1.5" role="radiogroup" aria-label="Format">
              <legend className="mb-1 text-[13px] text-muted-foreground">Format</legend>
              {/* The kit is the one format for new reels; v2 / v3 / v1 only re-render an old reel. */}
              {HANDOFF_FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  onClick={() => setFormat(f)}
                  className={cn(
                    "flex min-h-11 w-full items-start gap-2 rounded-lg border px-3 py-2 text-left",
                    format === f ? `border-transparent ${ACTIVE_PILL}` : "border-border bg-card hover:bg-hover",
                  )}
                >
                  <span className="w-7 shrink-0 font-mono text-[13px] font-semibold">{f}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium">
                      {formatLabel(f, kitVersion, L)}
                      {f === DEFAULT_HANDOFF_FORMAT ? " (default)" : " · re-render an old reel"}
                    </span>
                    <span className={cn("block text-[12px]", format === f ? "opacity-80" : "text-muted-foreground")}>{handoffFormatHint(f, L)}</span>
                  </span>
                </button>
              ))}
            </fieldset>
            <DialogFooter className="items-center">
              <Button type="button" variant="ghost" className={TAP} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" className={cn(TAP, PRIMARY_BTN)} disabled={pending || !ep || picked.size === 0} onClick={write}>
                {pending ? <Loader2 className="animate-spin" /> : <Scissors />} Write hand-off{ep ? ` for ${ep.short}` : ""}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * lg+: the five columns in one row that scrolls sideways inside itself when the main area is narrower than the five
 * minimum widths (1024 px window: about three and a half columns), never the page. `relative` makes the row the
 * containing block of anything absolutely positioned inside it (sr-only labels), so nothing escapes its clip. The edge
 * that has more columns behind it fades out (a mask, no color).
 */
type Edges = { l: boolean; r: boolean };
function readEdges(el: HTMLElement | null, set: (f: (e: Edges) => Edges) => void) {
  if (!el) return;
  const l = el.scrollLeft > 2;
  const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
  set((e) => (e.l === l && e.r === r ? e : { l, r }));
}

function BoardRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ l: false, r: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => readEdges(el, setEdges);
    on();
    el.addEventListener("scroll", on, { passive: true });
    // The five columns have fixed minimum widths (cards never widen them), so the row's overflow only changes with its
    // own width.
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", on);
      ro.disconnect();
    };
  }, []);
  const mask =
    edges.l || edges.r
      ? `linear-gradient(to right, ${edges.l ? "transparent 0, #000 28px" : "#000 0"}, ${edges.r ? "#000 calc(100% - 28px), transparent 100%" : "#000 100%"})`
      : undefined;
  return (
    <div
      ref={ref}
      className="scrollbar-thin relative mt-4 hidden gap-3 overflow-x-auto pb-2 lg:flex"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The Shorts board (Phase 6 C1): Idea | Cutting | Review | Ready to post | Posted. Desktop (lg+): the five columns side
 * by side (the board scrolls sideways inside itself when the window is narrow, never the page). Below that: one column
 * at a time behind a wrapping column switch. Cards move by their status menu (any column, any direction).
 */
export function BoardView({
  board,
  episodes,
  notPrepped,
  jobs,
  openEpisode,
  openCutReel,
  kitVersion,
}: {
  board: Board;
  episodes: EpisodeView[];
  notPrepped: { folder: string; title: string; masterAssetId: number; filename: string }[];
  jobs: MomentJobView[];
  openEpisode: number | null;
  /** `?cutreel=<episode id>` (cmd+K "Cut reel · Ep N") opens Cut reel on that episode. */
  openCutReel: number | null;
  /** The reel kit's VERSION (the kit hand-off format's label). */
  kitVersion: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const L = useLabels();
  const { shorts, hooks } = useStatus();
  const [dialog, setDialog] = useState(openEpisode != null);
  const [cutDialog, setCutDialog] = useState(openCutReel != null);
  const [col, setCol] = useState<ShortStatus>("idea");
  const keptIdeas = board.columns.idea.filter((c) => c.kept === true && !c.explainer && c.episodeId != null);

  // Refresh when a moments job finishes, a card changes (the worker's automatic moves too), a transcript lands or a hook
  // score lands (the cards' numbers).
  const sig = `${shorts.active}:${shorts.lastFinishedAt}:${shorts.boardAt}:${shorts.wordsAt}:${hooks.scored}:${hooks.requested}`;
  const last = useRef(sig);
  useEffect(() => {
    if (last.current !== sig) {
      last.current = sig;
      router.refresh();
    }
  }, [sig, router]);

  const dropParam = (key: string) => {
    if (!search.has(key)) return;
    const q = new URLSearchParams(search.toString());
    q.delete(key);
    router.replace(`${pathname}${q.size ? `?${q}` : ""}#board`, { scroll: false });
  };
  const closeDialog = (o: boolean) => {
    setDialog(o);
    if (!o) dropParam("newshort");
  };
  const closeCut = (o: boolean) => {
    setCutDialog(o);
    if (!o) dropParam("cutreel");
  };

  const total = SHORT_STATUSES.reduce((n, s) => n + board.columns[s].length, 0) + board.weaker.length;
  return (
    <section id="board" className="scroll-mt-4 px-4 pt-8 pb-12 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Kanban className="size-4 text-muted-foreground" />
        <h2 className="text-[16px] font-semibold">Shorts board</h2>
        <span className="text-[12px] text-muted-foreground tabular">
          {total} card{total === 1 ? "" : "s"} · {episodes.length} episode{episodes.length === 1 ? "" : "s"}
        </span>
        {board.undecided > 0 && (
          <span className="inline-flex h-6 items-center rounded-md bg-brand/15 px-2 text-[12px] font-medium text-brand-text tabular">Undecided {board.undecided}</span>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className={TAP}
            disabled={keptIdeas.length === 0}
            title={keptIdeas.length ? `Hand kept ideas of one episode to ${L.skills.reelCut}` : "Keep some ideas first"}
            onClick={() => setCutDialog(true)}
          >
            <Scissors /> Cut reel
          </Button>
          <Button size="sm" className={cn(TAP, PRIMARY_BTN)} onClick={() => setDialog(true)}>
            <Plus /> New short
          </Button>
        </div>
      </div>
      <p className="mt-1 max-w-[760px] text-[13px] text-muted-foreground">
        Moments from prepped episodes, picked by claude with a cold open each and scored by Jev on it (the main hook; the first line is scored too).
        Ideas under the gate sit behind Show weaker. Keep the good ones, then Cut reel hands them to a live {L.skills.reelCut} session on the reel kit.
        Cards move on by themselves when the reel file shows up (Review), and when its Short is linked on YouTube (Posted); Approve needs the caption
        file.
      </p>

      <JobStrip jobs={jobs} />

      {/* Below lg: one column at a time. */}
      <div className="mt-4 flex flex-wrap gap-1.5 lg:hidden" role="tablist" aria-label="Board column">
        {SHORT_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={col === s}
            onClick={() => setCol(s)}
            className={cn(
              "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-[14px]",
              col === s ? `border-transparent ${ACTIVE_PILL}` : "border-border bg-card text-muted-foreground hover:bg-hover",
            )}
          >
            {SHORT_STATUS_LABEL[s]} <span className="tabular opacity-75">{board.columns[s].length + (s === "idea" ? board.weaker.length : 0)}</span>
          </button>
        ))}
      </div>
      <BoardCtx.Provider value={{ channelMedian: board.channelMedian }}>
        <div className="mt-3 lg:hidden">
          <Column status={col} cards={board.columns[col]} weaker={col === "idea" ? board.weaker : []} gate={board.gate} />
        </div>

        {/* lg+: the five columns side by side, scrolling inside the board when narrow. */}
        <BoardRow>
          {SHORT_STATUSES.map((s) => (
            <Column key={s} status={s} cards={board.columns[s]} weaker={s === "idea" ? board.weaker : []} gate={board.gate} />
          ))}
        </BoardRow>
      </BoardCtx.Provider>

      {dialog && <NewShortDialog open={dialog} onOpenChange={closeDialog} episodes={episodes} notPrepped={notPrepped} initial={openEpisode} />}
      {cutDialog && <CutReelDialog open={cutDialog} onOpenChange={closeCut} episodes={episodes} ideas={keptIdeas} initial={openCutReel} kitVersion={kitVersion} />}
    </section>
  );
}
