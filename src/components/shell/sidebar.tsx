"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  ChevronRight,
  Clapperboard,
  Hammer,
  House,
  Inbox,
  Layers,
  ListChecks,
  Moon,
  Ruler,
  Settings,
  Sun,
  Users,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStatus } from "./status-provider";
import { useLabels } from "./labels-provider";

export type SidebarProps = {
  /** Enabled lanes only (a switched-off lane is not passed). Names come from Settings > Lanes. */
  sections: { key: string; name: string; color?: string | null; count: number }[];
  clients: { code: string; name: string; short: string; count: number }[];
  sharedCount: number;
};

function Count({ n, className }: { n?: number; className?: string }) {
  if (n == null) return null;
  return <span className={cn("ml-auto text-[11px] text-muted-foreground tabular", className)}>{n.toLocaleString()}</span>;
}

function NavItem({
  href,
  icon: Icon,
  label,
  sub,
  count,
  active,
  indent,
  badge,
  disabled,
  disabledHint,
}: {
  href?: string;
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  sub?: string;
  count?: number;
  active?: boolean;
  indent?: boolean;
  badge?: React.ReactNode;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const inner = (
    <>
      {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-brand" aria-hidden />}
      {Icon && <Icon className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />}
      <span className="min-w-0 truncate">
        <span className={cn(active ? "font-medium" : "font-normal")}>{label}</span>
        {sub && <span className="text-muted-foreground"> · {sub}</span>}
      </span>
      {badge}
      {!badge && <Count n={count} />}
    </>
  );
  const cls = cn(
    "relative flex h-8 items-center gap-2.5 rounded-lg pr-2 text-[13.5px] transition-colors duration-150",
    indent ? "pl-3" : "pl-2.5",
    active
      ? "bg-card text-foreground shadow-[0_1px_2px_rgba(18,21,26,0.06)]"
      : "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground",
    disabled && "cursor-not-allowed opacity-55 hover:bg-transparent",
  );
  if (disabled || !href) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cls} aria-disabled>
            {inner}
          </div>
        </TooltipTrigger>
        {disabledHint && <TooltipContent side="right">{disabledHint}</TooltipContent>}
      </Tooltip>
    );
  }
  return (
    <Link href={href} className={cls} aria-current={active ? "page" : undefined}>
      {inner}
    </Link>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setTheme(dark ? "light" : "dark")}
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          aria-label="Toggle theme"
        >
          <Sun className="size-4 dark:hidden" />
          <Moon className="hidden size-4 dark:block" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{dark ? "Light mode" : "Dark mode"}</TooltipContent>
    </Tooltip>
  );
}

function ago(s: number | null) {
  if (s == null) return "never";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function Sidebar({ sections, clients, sharedCount }: SidebarProps) {
  const L = useLabels();
  const pathname = usePathname();
  const status = useStatus();
  const inFkb = pathname.startsWith("/fkbpros");
  const [open, setOpen] = useState(true);
  const rtm = sections.find((s) => s.key === "rtm");
  const fkb = sections.find((s) => s.key === "fkbpros");
  const own = sections.find((s) => s.key === "fkb");
  const inOwn = pathname === "/fkb" || pathname.startsWith("/fkb/");
  const w = status.worker;

  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <Link href={rtm ? "/rtm/library" : "/fkbpros/all/library"} className="flex h-14 items-center gap-2 px-4" aria-label={`${status.app.name} home`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={L.brand.wordmarkInk} alt={L.ownerDisplay ?? ""} className="-ml-1.5 h-[30px] w-auto dark:hidden" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={L.brand.wordmarkPaper} alt={L.ownerDisplay ?? ""} className="-ml-1.5 hidden h-[30px] w-auto dark:block" />
        <span className="-ml-2 pt-[3px] text-[15px] font-medium tracking-[-0.01em] text-muted-foreground">Studio</span>
      </Link>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-2.5 pt-2 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Channels
        </div>
        {rtm && (
          <NavItem
            href="/rtm/library"
            icon={Clapperboard}
            label={rtm.name}
            count={rtm.count}
            active={pathname.startsWith("/rtm")}
          />
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "mt-0.5 flex h-8 w-full items-center gap-2.5 rounded-lg pr-2 pl-2.5 text-[13.5px] transition-colors duration-150 hover:bg-sidebar-accent",
            inFkb ? "text-foreground" : "text-sidebar-foreground/85",
          )}
          aria-expanded={open}
        >
          <Hammer className="size-4 shrink-0 text-muted-foreground" />
          <span className={cn("truncate", inFkb && "font-medium")}>{fkb?.name ?? "Clients"}</span>
          <ChevronRight
            className={cn("size-3.5 text-muted-foreground transition-transform duration-150", open && "rotate-90")}
          />
          <Count n={fkb?.count} />
        </button>
        {open && (
          <div className="relative mt-0.5 ml-[18px] space-y-px border-l border-sidebar-border pl-1.5">
            <NavItem
              href="/fkbpros/all/library"
              icon={Layers}
              label={`All ${fkb?.name ?? "Clients"}`}
              count={fkb?.count}
              indent
              active={pathname.startsWith("/fkbpros/all")}
            />
            {clients.map((c) => {
              const rest = c.name.includes(" / ") ? c.name.split(" / ").slice(1).join(" / ") : undefined;
              return (
                <NavItem
                  key={c.code}
                  href={`/fkbpros/${c.code}/library`}
                  label={c.short}
                  sub={rest}
                  count={c.count}
                  indent
                  active={pathname.startsWith(`/fkbpros/${c.code}/`) || pathname === `/fkbpros/${c.code}`}
                />
              );
            })}
            <div className="flex h-7 items-center gap-2 pr-2 pl-3 text-[12px] text-muted-foreground">
              <Users className="size-3.5" />
              <span>Shared across clients</span>
              <Count n={sharedCount} />
            </div>
          </div>
        )}
        {own && (
          <div className="mt-0.5">
            <NavItem href="/fkb/running" icon={House} label={own.name} sub={L.laneSub.fkb ?? undefined} count={own.count || undefined} active={inOwn} />
          </div>
        )}
      </nav>

      <div className="space-y-px border-t border-sidebar-border px-2 pt-2 pb-2">
        <NavItem
          href="/review"
          icon={Inbox}
          label="Review"
          active={pathname.startsWith("/review")}
          badge={
            status.classify.needsReview > 0 ? (
              <span
                className="ml-auto rounded-md bg-brand/15 px-1.5 text-[11px] font-medium text-brand-text tabular"
                aria-label={`${status.classify.needsReview} files need review`}
              >
                {status.classify.needsReview.toLocaleString()}
              </span>
            ) : undefined
          }
        />
        <NavItem href="/rubric" icon={Ruler} label="Rubric" active={pathname.startsWith("/rubric")} />
        <NavItem
          href="/jobs"
          icon={ListChecks}
          label="Jobs"
          active={pathname.startsWith("/jobs")}
          badge={
            w.error > 0 ? (
              <span className="ml-auto rounded-md bg-brand/15 px-1.5 text-[11px] font-medium text-brand-text tabular">
                {w.error} err
              </span>
            ) : w.pending + w.running > 0 ? (
              <Count n={w.pending + w.running} />
            ) : undefined
          }
        />
        <NavItem href="/settings" icon={Settings} label="Settings" active={pathname.startsWith("/settings")} />
      </div>

      <div className="flex items-center gap-2.5 border-t border-sidebar-border px-3 py-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={L.brand.markSand} alt="" className="size-8 rounded-lg bg-ink p-1" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-medium">{L.ownerDisplay ?? status.app.name}</div>
          <div className="flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
            <span
              className={cn("inline-block size-1.5 rounded-full", w.alive ? "bg-foreground/70" : "bg-brand")}
              aria-hidden
            />
            {w.alive ? `Worker ${w.scanState === "scanning" ? "scanning" : "up"}` : `Worker offline · ${ago(w.ageS)}`}
          </div>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
