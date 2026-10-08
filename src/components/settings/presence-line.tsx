import { Check, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACTIVE_PILL } from "@/components/hooks/ui";

/**
 * One Settings presence line (a key, a file, a connection): a check / dashed mark, the label + a note, and the answer
 * word. Booleans only: no value is ever shown. `yes` / `no` keep each card's wording ("Present" / "Missing" for keys,
 * "Yes" / "No" for YouTube); `size` "md" is the larger API keys card.
 */
export function PresenceLine({
  ok,
  label,
  note,
  yes = "Present",
  no = "Missing",
  size = "sm",
}: {
  ok: boolean;
  label: string;
  note: string;
  yes?: string;
  no?: string;
  size?: "sm" | "md";
}) {
  const md = size === "md";
  return (
    <div className={cn("flex min-w-0 items-center rounded-lg border border-border px-3", md ? "gap-3 py-2.5" : "gap-2.5 py-2")}>
      <span className={cn("grid shrink-0 place-items-center rounded-md", md ? "size-6" : "size-5", ok ? ACTIVE_PILL : "bg-brand/15 text-brand-text")}>
        {ok ? <Check className={md ? "size-3.5" : "size-3"} /> : <CircleDashed className={md ? "size-3.5" : "size-3"} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("font-medium", md ? "text-[13px]" : "truncate text-[12.5px]")}>{label}</div>
        <div className={cn("truncate text-muted-foreground", md ? "text-[12px]" : "text-[11.5px]")}>{note}</div>
      </div>
      <span className={cn("shrink-0 font-medium", md ? "text-[12px]" : "text-[11.5px]", ok ? "text-foreground" : "text-brand-text")}>{ok ? yes : no}</span>
    </div>
  );
}
