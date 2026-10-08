import { cn } from "@/lib/utils";
import type { KitTag, ViewMedian } from "@/lib/shorts/kit";
import { splitHookWords } from "@/lib/shorts/vocab";

/** "Kit v1" / "Kit v1 · test: <change>" / "Before kit" (Phase 7 D3). A refused kit note says so in its tooltip. */
export function KitTagPill({ tag, className }: { tag: KitTag; className?: string }) {
  const kit = tag.version != null;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded-md px-1.5 py-0.5 text-[11.5px] font-medium",
        kit ? (tag.change ? "bg-brand/15 text-brand-text" : "bg-ink text-paper") : "bg-muted text-muted-foreground",
        className,
      )}
      title={tag.error ? `Kit note refused: ${tag.error} Counted as Before kit.` : tag.detail ? `Test: ${tag.detail}` : tag.label}
    >
      {tag.label}
    </span>
  );
}

/** "31% viewed · channel 24% (3)": a Short's average % viewed next to the channel's median over its Shorts. */
export function ViewedVsMedian({ pct, views, median, className }: { pct: number | null; views: number | null; median: ViewMedian; className?: string }) {
  // No views yet: no "% viewed" to compare (the same rule as the median's).
  if (pct == null || !(views && views > 0)) return null;
  return (
    <span className={cn("text-[12px] tabular", className)} title={median.median != null ? `Channel median over ${median.count} Shorts with numbers` : undefined}>
      <span className="font-medium">{Math.round(pct)}% viewed</span>
      {median.median != null && (
        <span className="text-muted-foreground">
          {" "}
          · channel {Math.round(median.median)}% ({median.count})
        </span>
      )}
    </span>
  );
}

/** The hook words as the reel opens on them: the `*...*` part in the orange block (the reel kit's open.md). */
export function HookWordsBlock({ words, className }: { words: string; className?: string }) {
  const parts = splitHookWords(words);
  return (
    <div className={cn("inline-block max-w-full rounded-md bg-ink px-2 py-1 text-[13px] leading-tight font-semibold tracking-[0.02em] text-paper break-words", className)}>
      {parts ? (
        <>
          {parts.before && <>{parts.before} </>}
          <span className="rounded-[4px] bg-brand px-1 text-ink">{parts.block}</span>
          {parts.after && <> {parts.after}</>}
        </>
      ) : (
        words
      )}
    </div>
  );
}
