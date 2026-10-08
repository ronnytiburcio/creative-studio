"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  Folder,
  Gauge,
  Inbox,
  Layers,
  RectangleVertical,
  Sparkles,
  Tags,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Switch } from "@/components/ui/switch";
import type { FolderOption, LibraryFilters, SourceKey } from "@/lib/queries";
import { CATEGORIES, CATEGORY_LABEL, ENERGY_BUCKETS, ENERGY_BUCKET_IDS, type CategoryId } from "@/lib/ai/classes";
import { useLabels } from "@/components/shell/labels-provider";

type Mode = "rtm" | "fkbpros" | "fkb" | "client" | "all";

const SORT_LABEL: Record<LibraryFilters["sort"], string> = {
  newest: "Newest",
  name: "Name",
  duration: "Longest",
  size: "Largest",
};

const SOURCE_LABEL: Record<SourceKey, string> = { all: "All", generated: "Generated", originals: "Originals" };

const pillCls =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors duration-150 hover:border-foreground/20 hover:bg-hover data-[state=open]:border-foreground/25 outline-none focus-visible:ring-3 focus-visible:ring-ring/30";

function Pill({
  icon: Icon,
  label,
  value,
  active,
  ...rest
}: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; active?: boolean } & React.ComponentProps<"button">) {
  return (
    <button type="button" className={cn(pillCls, active && "border-foreground/30")} {...rest}>
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className={cn("max-w-[240px] truncate", active ? "font-medium" : "text-muted-foreground")}>{value}</span>
      <ChevronDown className="size-3.5 text-muted-foreground" />
    </button>
  );
}

export function FilterBar({
  mode,
  filters,
  folders,
  kinds,
  orients,
  sources,
  classes,
  reviewCount,
  energies,
  clients,
  total,
  meaning = false,
}: {
  mode: Mode;
  filters: LibraryFilters;
  folders: FolderOption[];
  kinds: Record<string, number>;
  orients: Record<string, number>;
  sources: Record<SourceKey, number>;
  /** Jev categories with counts (inside the other filters). */
  classes: Record<string, number>;
  reviewCount: number;
  energies: Record<string, number>;
  clients: { code: string; short: string; count: number }[];
  total: number;
  /** Search by meaning is showing the results (MeaningGrid has its own count line). */
  meaning?: boolean;
}) {
  const L = useLabels();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    next.delete("asset");
    next.delete("page");
    startTransition(() => router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }));
  };

  const selectedFolder = filters.folder ? folders.find((f) => f.value === filters.folder) : undefined;
  const folderLabel = filters.folder ? (selectedFolder?.path || selectedFolder?.label || "Custom") : "All";
  const rootLabelOf = (value: string) => folders.find((f) => f.depth === 0 && f.value === value.split("/")[0])?.label ?? "";
  const clientsLabel =
    filters.clients.length === 0
      ? "Any"
      : filters.clients.length === 1
        ? filters.clients[0] === "shared"
          ? "Shared"
          : (clients.find((c) => c.code === filters.clients[0])?.short ?? filters.clients[0])
        : `${filters.clients.length} selected`;
  const anyFilter = Boolean(
    filters.kind ||
      filters.orient ||
      filters.folder ||
      filters.clients.length ||
      filters.q ||
      filters.source !== "all" ||
      filters.cls.length ||
      filters.review ||
      filters.energy,
  );
  const classLabel =
    filters.cls.length === 0
      ? "Any"
      : filters.cls.length === 1
        ? (CATEGORY_LABEL[filters.cls[0] as CategoryId] ?? filters.cls[0])
        : `${filters.cls.length} selected`;
  const classTotal = Object.values(classes).reduce((a, b) => a + b, 0);
  const toggleClass = (id: string) => {
    const s = new Set(filters.cls);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    set({ cls: [...s].join(",") || null });
  };
  const kindTotal = Object.values(kinds).reduce((a, b) => a + b, 0);
  const orientTotal = Object.values(orients).reduce((a, b) => a + b, 0);

  const toggleClient = (code: string) => {
    const s = new Set(filters.clients);
    if (s.has(code)) s.delete(code);
    else s.add(code);
    set({ clients: [...s].join(",") || null });
  };

  return (
    <div className="px-6 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Pill icon={Layers} label="Kind" value={filters.kind ? cap(filters.kind) : "Any"} active={!!filters.kind} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuRadioGroup value={filters.kind ?? "any"} onValueChange={(v) => set({ kind: v === "any" ? null : v })}>
              <Radio value="any" label="Any" count={kindTotal} />
              <Radio value="video" label="Video" count={kinds.video ?? 0} />
              <Radio value="image" label="Image" count={kinds.image ?? 0} />
              <Radio value="audio" label="Audio" count={kinds.audio ?? 0} />
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Pill
              icon={RectangleVertical}
              label="Orientation"
              value={filters.orient ?? "Any"}
              active={!!filters.orient}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuRadioGroup
              value={filters.orient ?? "any"}
              onValueChange={(v) => set({ orient: v === "any" ? null : v })}
            >
              <Radio value="any" label="Any" count={orientTotal} />
              {(["9:16", "4:5", "1:1", "16:9", "other"] as const).map((o) => (
                <Radio key={o} value={o} label={o === "other" ? "Other" : o} count={orients[o] ?? 0} />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Pill icon={Sparkles} label="Source" value={SOURCE_LABEL[filters.source]} active={filters.source !== "all"} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuRadioGroup
              value={filters.source}
              // Generated lists newest first.
              onValueChange={(v) => set(v === "generated" ? { source: v, sort: null } : { source: v === "all" ? null : v })}
            >
              <Radio value="all" label="All" count={sources.all} />
              <Radio value="generated" label="Generated" count={sources.generated} />
              <Radio value="originals" label="Originals" count={sources.originals} />
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Popover>
          <PopoverTrigger asChild>
            <Pill icon={Tags} label="Category" value={classLabel} active={filters.cls.length > 0} />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[260px] p-0">
            <Command>
              <CommandInput placeholder="Find a category…" />
              <CommandList className="max-h-[360px]">
                <CommandEmpty>No categories.</CommandEmpty>
                <CommandGroup heading={classTotal ? `${classTotal.toLocaleString()} classified` : "Nothing classified yet"}>
                  {CATEGORIES.map((c) => (
                    <CommandItem key={c.id} value={`${c.label} ${c.id}`} onSelect={() => toggleClass(c.id)} title={L.categories[c.id] ?? c.description}>
                      <Check className={cn("size-3.5", filters.cls.includes(c.id) ? "opacity-100" : "opacity-0")} />
                      {c.label}
                      <span className="ml-auto text-[11.5px] text-muted-foreground tabular">{(classes[c.id] ?? 0).toLocaleString()}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Pill
              icon={Gauge}
              label="Energy"
              value={filters.energy ? ENERGY_BUCKETS[filters.energy].label : "Any"}
              active={!!filters.energy}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuRadioGroup value={filters.energy ?? "any"} onValueChange={(v) => set({ energy: v === "any" ? null : v })}>
              <Radio value="any" label="Any" count={Object.values(energies).reduce((a, b) => a + b, 0)} />
              {ENERGY_BUCKET_IDS.map((b) => (
                <Radio key={b} value={b} label={ENERGY_BUCKETS[b].label} count={energies[b] ?? 0} />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <label className={cn(pillCls, "cursor-pointer gap-2", filters.review && "border-foreground/30")}>
          <Inbox className="size-3.5 text-muted-foreground" />
          <span className={filters.review ? "font-medium" : "text-muted-foreground"}>Needs review</span>
          <span className="text-[11.5px] text-muted-foreground tabular">{reviewCount.toLocaleString()}</span>
          <Switch
            checked={filters.review}
            onCheckedChange={(v) => set({ review: v ? "1" : null })}
            className="data-[state=checked]:bg-brand"
            aria-label="Only files that need review"
          />
        </label>

        <Popover>
          <PopoverTrigger asChild>
            <Pill icon={Folder} label="Folder" value={folderLabel} active={!!filters.folder} />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[380px] p-0">
            <Command>
              <CommandInput placeholder="Find a folder, like renders/Client…" />
              <CommandList className="max-h-[380px]">
                <CommandEmpty>No folders.</CommandEmpty>
                <CommandGroup>
                  <CommandItem value="__all" onSelect={() => set({ folder: null })}>
                    <Check className={cn("size-3.5", filters.folder ? "opacity-0" : "opacity-100")} />
                    All folders
                  </CommandItem>
                  {folders.map((f) => (
                    <CommandItem
                      key={f.value}
                      value={`${rootLabelOf(f.value)} ${f.path || f.label} ${f.value}`}
                      onSelect={() => set({ folder: f.value })}
                      title={f.path || f.label}
                    >
                      <Check className={cn("size-3.5 shrink-0", filters.folder === f.value ? "opacity-100" : "opacity-0")} />
                      <span
                        className={cn("min-w-0 truncate", f.depth === 0 ? "font-medium" : "text-foreground/90")}
                        style={{ paddingLeft: f.depth * 14 }}
                      >
                        {f.label}
                      </span>
                      <span className="ml-auto pl-2 text-[11.5px] text-muted-foreground tabular">{f.count}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {mode === "fkbpros" && (
          <Popover>
            <PopoverTrigger asChild>
              <Pill icon={Users} label="Clients" value={clientsLabel} active={filters.clients.length > 0} />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[260px] p-0">
              <Command>
                <CommandInput placeholder="Find a client…" />
                <CommandList className="max-h-[340px]">
                  <CommandEmpty>No clients.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem value="shared" onSelect={() => toggleClient("shared")}>
                      <Check className={cn("size-3.5", filters.clients.includes("shared") ? "opacity-100" : "opacity-0")} />
                      Shared (no client)
                    </CommandItem>
                    {clients.map((c) => (
                      <CommandItem key={c.code} value={`${c.short} ${c.code}`} onSelect={() => toggleClient(c.code)}>
                        <Check className={cn("size-3.5", filters.clients.includes(c.code) ? "opacity-100" : "opacity-0")} />
                        {c.short}
                        <span className="ml-auto text-[11.5px] text-muted-foreground tabular">{c.count}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}

        {mode === "client" && (
          <label className={cn(pillCls, "cursor-pointer gap-2")}>
            <Users className="size-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Include shared</span>
            <Switch
              checked={filters.shared}
              onCheckedChange={(v) => set({ shared: v ? null : "0" })}
              className="data-[state=checked]:bg-brand"
              aria-label="Include shared assets"
            />
          </label>
        )}

        {anyFilter && (
          <button
            type="button"
            onClick={() =>
              set({ kind: null, orient: null, folder: null, clients: null, q: null, mode: null, source: null, cls: null, review: null, energy: null })
            }
            className="flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <X className="size-3.5" />
            Clear
          </button>
        )}

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pill icon={ArrowDownWideNarrow} label="Sort" value={SORT_LABEL[filters.sort]} active={filters.sort !== "newest"} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-[11px] tracking-wide text-muted-foreground uppercase">Sort by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={filters.sort} onValueChange={(v) => set({ sort: v === "newest" ? null : v })}>
                <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="name">Name A to Z</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="duration">Longest first</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="size">Largest first</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {meaning ? (
        pending && <div className="mt-3 animate-pulse text-[12.5px] text-muted-foreground">Updating…</div>
      ) : (
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span className="tabular">
            <span className="font-medium text-foreground">{total.toLocaleString()}</span> {total === 1 ? "file" : "files"}
          </span>
          {filters.q && (
            <span>
              matching <span className="font-medium text-foreground">“{filters.q}”</span>
            </span>
          )}
          {pending && <span className="animate-pulse">Updating…</span>}
        </div>
      )}
    </div>
  );
}

function Radio({ value, label, count }: { value: string; label: string; count: number }) {
  return (
    <DropdownMenuRadioItem value={value}>
      {label}
      <span className="ml-auto pl-3 text-[11.5px] text-muted-foreground tabular">{count.toLocaleString()}</span>
    </DropdownMenuRadioItem>
  );
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}
