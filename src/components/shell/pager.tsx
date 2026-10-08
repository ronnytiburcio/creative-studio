"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { pageCount } from "@/lib/paging";

/**
 * Page links under a long list (Library, Hooks, Running; 2026-10-06, replacing the endless scroll / Show more):
 * "Showing 16 to 30 of 1,234", Prev, the first / last / nearby page numbers, Next. Either real links (`hrefFor`, the page
 * lives in the URL so Back works) or buttons (`onPage`, a list already in memory). A new page scrolls the main pane back
 * to the top. Nothing renders while everything fits on one page.
 */
export function Pager({
  page,
  total,
  pageSize,
  hrefFor,
  onPage,
  className,
}: {
  /** 1-based. */
  page: number;
  total: number;
  pageSize: number;
  hrefFor?: (page: number) => string;
  onPage?: (page: number) => void;
  className?: string;
}) {
  const pages = pageCount(total, pageSize);
  const shown = useRef(page);
  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    document.getElementById("main-scroll")?.scrollTo({ top: 0 });
  }, [page]);
  if (pages <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  const item = (n: number, label: React.ReactNode, opts: { aria?: string; current?: boolean; disabled?: boolean; wide?: boolean } = {}) => {
    const cls = cn(
      "inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg border px-2.5 text-[13px] tabular transition-colors",
      opts.current ? "border-brand bg-brand/10 font-medium text-brand-text" : "border-border bg-card hover:bg-hover",
      opts.disabled && "pointer-events-none opacity-40",
      !opts.wide && "hidden sm:inline-flex",
    );
    if (opts.disabled || opts.current) {
      return (
        <span key={`${n}-${opts.aria ?? ""}`} className={cls} aria-current={opts.current ? "page" : undefined} aria-disabled={opts.disabled || undefined} aria-label={opts.aria}>
          {label}
        </span>
      );
    }
    return hrefFor ? (
      <Link key={`${n}-${opts.aria ?? ""}`} href={hrefFor(n)} scroll={false} className={cls} aria-label={opts.aria}>
        {label}
      </Link>
    ) : (
      <button key={`${n}-${opts.aria ?? ""}`} type="button" onClick={() => onPage?.(n)} className={cls} aria-label={opts.aria}>
        {label}
      </button>
    );
  };

  return (
    <nav aria-label="Pages" className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[12.5px] text-muted-foreground", className)}>
      <span className="tabular">
        Showing {first.toLocaleString()} to {last.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        {item(page - 1, (
          <>
            <ChevronLeft className="size-4" /> Prev
          </>
        ), { aria: "Previous page", disabled: page <= 1, wide: true })}
        {pageWindow(page, pages).map((n, i) =>
          n == null ? (
            <span key={`gap-${i}`} className="hidden px-1 sm:inline" aria-hidden>
              …
            </span>
          ) : (
            item(n, n.toLocaleString(), { current: n === page, aria: `Page ${n}` })
          ),
        )}
        <span className="px-2 tabular sm:hidden">
          {page} / {pages}
        </span>
        {item(page + 1, (
          <>
            Next <ChevronRight className="size-4" />
          </>
        ), { aria: "Next page", disabled: page >= pages, wide: true })}
      </div>
    </nav>
  );
}

/** Page numbers to show: the first, the last and the two around the current one; null = a gap. */
function pageWindow(page: number, pages: number): (number | null)[] {
  const want = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const sorted = [...want].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (typeof prev === "number" && n - prev === 2) out.push(prev + 1);
    else if (typeof prev === "number" && n - prev > 2) out.push(null);
    out.push(n);
  }
  return out;
}
