/**
 * Small shared UI bits for the Hooks tab, Client tab and Rubric page (no hooks, no "use client": server pages and client
 * components both import it).
 */
import { cn } from "@/lib/utils";
import { PP_CLEAR } from "@/lib/hooks/rubric";

/** The orange primary button (key CTAs only: Save, Score again, Rescore, Resume, Rewrite). */
export const PRIMARY_BTN = "bg-brand text-ink hover:bg-brand/90";
/** The selected / "yes" pill: ink on sand (sand on ink in dark mode). One definition for every toggle, check and chip. */
export const ACTIVE_PILL = "bg-ink text-sand dark:bg-sand dark:text-ink";

/** A Three P's pill: filled when clear (P >= PP_CLEAR), dashed when missing. `compact` = the variant rows' smaller pill. */
export function ppPillCls(p: number | null, compact = false): string {
  const clear = p != null && p >= PP_CLEAR;
  return cn(
    compact ? "rounded px-1 text-[10.5px] font-medium" : "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium",
    clear ? ACTIVE_PILL : cn("border border-dashed border-foreground/20", !compact && "text-muted-foreground"),
  );
}

function date(ms: number | null) {
  return ms ? new Date(ms).toLocaleDateString("en-US", { dateStyle: "medium" }) : "";
}

/** "Saved <date>", or the orange "Draft, check me" until the owner saves seeded notes. */
export function DraftBadge({ savedAt }: { savedAt: number | null }) {
  return savedAt ? (
    <span className="rounded-md bg-muted px-1.5 py-px text-[11px] text-muted-foreground">Saved {date(savedAt)}</span>
  ) : (
    <span className="rounded-md bg-brand/15 px-1.5 py-px text-[11px] font-medium text-brand-text">Draft, check me</span>
  );
}

/** A titled card with an optional orange eyebrow over the title and a muted aside on the right. */
export function EyebrowCard({
  title,
  eyebrow,
  aside,
  children,
  className,
}: {
  title: string;
  eyebrow?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          {eyebrow && <div className="text-[10.5px] font-semibold tracking-[0.14em] text-brand-text uppercase">{eyebrow}</div>}
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        </div>
        {aside && <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-[12px] text-muted-foreground">{aside}</div>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
