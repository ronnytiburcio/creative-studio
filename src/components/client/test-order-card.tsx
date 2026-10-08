"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmTestOrderAction, setTestOrderAction } from "@/app/actions";
import type { ChannelTestOrder, TestBatch } from "@/lib/meta/test-order";
import { TEST_ANSWERS, TEST_LABEL, type TestAnswer } from "@/lib/meta/test-order-rules";
import { EyebrowCard as Card, PRIMARY_BTN } from "@/components/hooks/ui";

function fmtDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ads = (n: number) => `${n} new ${n === 1 ? "ad" : "ads"}`;

function headline(b: TestBatch): React.ReactNode {
  if (b.first) return <>The first ads on this account ({ads(b.nAds)} on {fmtDay(b.date)})</>;
  const a = b.variable ?? b.suggested;
  if (a === "none") return <>Not a test: {ads(b.nAds)} on {fmtDay(b.date)} repeat ads already running</>;
  return (
    <>
      {b.variable ? "A " : "Looks like a "}
      <b>{TEST_LABEL[a]}</b> test{b.variable == null && b.mixed ? ` (mixed: ${b.parts.map((p) => TEST_LABEL[p]).join(" + ")})` : ""} ({ads(b.nAds)} on {fmtDay(b.date)})
    </>
  );
}

/**
 * Client tab: what the newest batch of ads tested (offer -> hook -> format -> copy), Confirm / Change, and the last few
 * batches. Studio only suggests; the owner's answer is kept and never replaced by a later suggestion.
 */
export function TestOrderCard({ data }: { data: ChannelTestOrder }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Failed");
      else if (r.message) toast.success(r.message);
      router.refresh();
    });

  const change = (b: TestBatch) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8" disabled={pending}>
          Change <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-[11px] tracking-wide text-muted-foreground uppercase">What did it test?</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={b.variable ?? ""}
          onValueChange={(v) => run(() => setTestOrderAction({ code: data.code, date: b.date, variable: v }))}
        >
          {TEST_ANSWERS.map((a: TestAnswer) => (
            <DropdownMenuRadioItem key={a} value={a}>
              {cap(TEST_LABEL[a])}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const newest = data.batches[0] ?? null;
  return (
    <div id="test-order" className="scroll-mt-20">
      <Card title="Test order" eyebrow="Offer → hook → format → copy" aside={<span>Next in the order: <b className="text-foreground">{cap(TEST_LABEL[data.next])}</b></span>}>
        {!newest ? (
          <p className="text-[13px] text-muted-foreground">No ads synced yet. After the next Meta sync each batch of new ads gets a suggestion here.</p>
        ) : (
          <div className="space-y-4">
            <div className={cn("rounded-lg px-3 py-2.5", data.prompt ? "border border-brand/40 bg-brand/8" : "bg-muted/50")}>
              <p className="text-[13.5px] leading-snug">{headline(newest)}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{newest.reason}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {data.prompt ? (
                  <Button size="sm" className={cn("h-8", PRIMARY_BTN)} disabled={pending} onClick={() => run(() => confirmTestOrderAction({ code: data.code, date: newest.date }))}>
                    <Check /> Confirm
                  </Button>
                ) : newest.confirmedAt ? (
                  <span className="text-[12px] text-muted-foreground">Confirmed by you</span>
                ) : null}
                {change(newest)}
              </div>
            </div>
            {data.batches.length > 1 && (
              <div>
                <h3 className="text-[12.5px] font-semibold">Earlier batches</h3>
                <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border">
                  {data.batches.slice(1).map((b) => (
                    <li key={b.date} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <span className="w-12 shrink-0 text-[12px] text-muted-foreground tabular">{fmtDay(b.date)}</span>
                      <span className="min-w-0 flex-1 text-[12.5px]">
                        <span className="font-medium">{cap(b.first ? "first ads" : TEST_LABEL[b.answer])}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {ads(b.nAds)} · {b.variable ? "yours" : `suggested${b.mixed ? ", mixed" : ""}`}
                        </span>
                        <span className="block truncate text-[11.5px] text-muted-foreground" title={b.reason}>
                          {b.reason}
                        </span>
                      </span>
                      {!b.first && change(b)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
