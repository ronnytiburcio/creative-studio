import Link from "next/link";
import { Anchor, Film, Images, Megaphone, Scissors, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { GenerateButton } from "@/components/generate/generate-button";
import { ACTIVE_PILL } from "@/components/hooks/ui";

export type TabKey = "library" | "shorts" | "hooks" | "running" | "client";

export const TAB_META: Record<
  TabKey,
  { label: string; icon: React.ComponentType<{ className?: string }>; blurb: string }
> = {
  library: { label: "Library", icon: Images, blurb: "" },
  shorts: {
    label: "Shorts",
    icon: Scissors,
    blurb: "A kanban for Reels and Shorts cut from episodes: pick a moment, cut it, caption it, ship it.",
  },
  hooks: {
    label: "Hooks",
    icon: Anchor,
    blurb: "Text and video hooks scored against the rubric, tagged with the nine copy mechanics, with variants on demand.",
  },
  running: {
    label: "Running",
    icon: Megaphone,
    blurb: "Live Meta ads for this account with spend, CPL, CTR and hook rate, matched back to the files in the Library.",
  },
  client: {
    label: "Client",
    icon: UserRound,
    blurb: "Brand notes, the Jev hint, ad account, folder rules and a pinned list of what works for this client.",
  },
};

export const RTM_TABS: TabKey[] = ["library", "shorts", "hooks"];
export const CLIENT_TABS: TabKey[] = ["hooks", "running", "library", "client"];
export const ALL_FKB_TABS: TabKey[] = ["hooks", "running", "library"];
/** Lane C (the company lane, Phase 5): one channel, every tab live since slice 2 (no Shorts). */
export const FKB_TABS: TabKey[] = ["hooks", "running", "library", "client"];

export function ChannelHeader({
  title,
  eyebrow,
  meta,
  mark,
  basePath,
  tabs,
  active,
  query,
  soon = [],
}: {
  /** Tabs that route but are not built yet (a small "soon" badge). */
  soon?: TabKey[];
  title: string;
  eyebrow: string;
  meta?: React.ReactNode;
  mark: React.ReactNode;
  basePath: string;
  tabs: TabKey[];
  active: TabKey;
  query?: string;
}) {
  return (
    <div className="px-4 pt-5 sm:px-6">
      <div className="flex items-center gap-3.5">
        {mark}
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">{eyebrow}</div>
          <h1 className="truncate text-[22px] leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
          {meta && <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">{meta}</div>}
        </div>
        <div className="ml-auto hidden shrink-0 sm:block">
          <GenerateButton />
        </div>
      </div>
      <nav className="scrollbar-thin mt-4 flex gap-5 overflow-x-auto border-b border-border sm:overflow-visible" aria-label="Channel tabs">
        {tabs.map((t) => {
          const m = TAB_META[t];
          const isActive = t === active;
          return (
            <Link
              key={t}
              href={`${basePath}/${t}${t === "library" && query ? `?${query}` : ""}`}
              className={cn(
                "relative -mb-px flex h-10 shrink-0 items-center gap-1.5 text-[13.5px] transition-colors duration-150",
                isActive ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <m.icon className="size-4" />
              {m.label}
              {soon.includes(t) && !isActive && (
                <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">soon</span>
              )}
              {isActive && <span className="absolute right-0 bottom-0 left-0 h-[2px] rounded-full bg-brand" />}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function ChannelMark({ letter, variant = "ink" }: { letter: string; variant?: "ink" | "sand" }) {
  return (
    <div
      className={cn(
        "grid size-11 shrink-0 place-items-center rounded-xl text-[18px] font-semibold tracking-[-0.02em]",
        variant === "ink" ? ACTIVE_PILL : "border border-border bg-card text-foreground",
      )}
      aria-hidden
    >
      {letter}
    </div>
  );
}

export function ComingSoon({ tab, extra, when }: { tab: TabKey; extra?: React.ReactNode; when?: string }) {
  const m = TAB_META[tab];
  return (
    <div className="px-6 py-10">
      <div className="mx-auto flex max-w-[520px] flex-col items-center rounded-2xl border border-dashed border-foreground/15 bg-card/60 px-8 py-12 text-center">
        <div className="grid size-12 place-items-center rounded-xl bg-muted">
          <m.icon className="size-5 text-muted-foreground" />
        </div>
        <div className="mt-4 text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">{when ?? "Coming soon"}</div>
        <h2 className="mt-1 text-[18px]">{m.label}</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">{m.blurb}</p>
        {extra}
        {!when && (
          <div className="mt-5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Film className="size-3.5" />
            The Library tab is live today.
          </div>
        )}
      </div>
    </div>
  );
}
