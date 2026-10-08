"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import type { AssetCard } from "@/lib/queries";
import type { RefRole } from "@/lib/gen/rules";
import type { ToolId } from "@/lib/gen/tools";
import type { Capabilities, ParamValue } from "@/lib/gen/types";
import { driveWords, type DriveMode } from "@/lib/drive-mode";

/** What the reference tray needs from a Library asset. */
export type RefItem = Pick<AssetCard, "id" | "filename" | "v" | "kind" | "hasThumb" | "proof">;

export type GenMode = "hf-image" | "codex" | "hf-video";

/** A run to reopen the panel with (Remix). Applied once per `nonce`. */
export type GenPreset = {
  nonce: number;
  mode: GenMode;
  model: string;
  prompt: string;
  brandGuard: boolean;
  params: Record<string, ParamValue | null>;
};

/** What a quick tool needs from its source asset (card, drawer, cmd+K, Remix of a tool output). */
export type ToolSource = Pick<AssetCard, "id" | "filename" | "v" | "kind" | "hasThumb" | "durationS">;

/** Tooltip for anything that needs the media drive (its configured label, e.g. "Media Drive"; worded by its mode). */
export function needsDriveText(drive: { label: string; mode: DriveMode }): string {
  return driveWords(drive.mode).needs(drive.label);
}

/** Why quick tools are off right now (same tooltip pattern as Reveal in Finder), or null. */
export function toolsBlocked(drive: { mounted: boolean; label: string; mode: DriveMode }, higgsfield: Capabilities | null): string | null {
  if (!drive.mounted) return needsDriveText(drive);
  if (higgsfield && !higgsfield.available) return higgsfield.reason ?? "Higgsfield is unavailable";
  return null;
}

/** Why one tool is off for this source (beyond toolsBlocked), or null. */
export function toolUnavailable(tool: ToolId, a: Pick<ToolSource, "kind" | "durationS">): string | null {
  if (a.kind === "audio") return "Quick tools work on images and videos";
  if (tool === "reframe_916" && a.kind === "video" && !(a.durationS && a.durationS > 0)) return "Clip length unknown (still indexing)";
  return null;
}

type GenerateCtx = {
  open: boolean;
  /**
   * Open the panel. `dest` defaults to the channel you are in (or the preset's). `replaceRefs` empties the tray first.
   * `mode` switches the engine tab (cmd+K "Generate video").
   */
  openPanel: (opts?: {
    refs?: RefItem[];
    replaceRefs?: boolean;
    roles?: Record<number, RefRole>;
    preset?: Omit<GenPreset, "nonce">;
    dest?: string;
    mode?: GenMode;
  }) => void;
  /** Engine tab asked for by openPanel({ mode }), applied once per nonce. */
  modeRequest: { mode: GenMode; nonce: number } | null;
  close: () => void;
  refs: RefItem[];
  addRef: (ref: RefItem) => void;
  removeRef: (id: number) => void;
  hasRef: (id: number) => boolean;
  /** Roles the owner picked for tray items (the rest are auto-assigned from the model). */
  roles: Record<number, RefRole>;
  setRole: (id: number, role: RefRole) => void;
  preset: GenPreset | null;
  /** Destination key for new runs ("rtm" | "fkb" | "fkbpros" | "fkbpros:<code>"), seeded from the current channel. */
  dest: string;
  setDest: (key: string) => void;
  /** Quick tool confirm (one dialog for cards, drawer, cmd+K and Remix of a tool output). */
  tool: { source: ToolSource; tool: ToolId; nonce: number } | null;
  openTool: (source: ToolSource, tool: ToolId) => void;
  closeTool: () => void;
  /** Higgsfield status (signed in, balance) for the quick tools; null until the first check. */
  higgsfield: Capabilities | null;
  refreshHiggsfield: (force?: boolean) => void;
  /** The asset open in the drawer (cmd+K offers its quick tools). */
  drawerAsset: ToolSource | null;
  setDrawerAsset: (a: ToolSource | null) => void;
};

const Ctx = createContext<GenerateCtx | null>(null);

/** "rtm" | "fkb" | "fkbpros" (All clients (Lane B) -> _shared) | "fkbpros:<code>" from the current URL. */
export function destForPath(pathname: string): string {
  const client = /^\/fkbpros\/([a-z0-9]{2,32})(\/|$)/.exec(pathname)?.[1];
  if (client && client !== "all") return `fkbpros:${client}`;
  if (pathname.startsWith("/fkbpros")) return "fkbpros";
  if (pathname === "/fkb" || pathname.startsWith("/fkb/")) return "fkb";
  return "rtm";
}

export function GenerateProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [roles, setRoles] = useState<Record<number, RefRole>>({});
  const [preset, setPreset] = useState<GenPreset | null>(null);
  const [dest, setDest] = useState("rtm");
  const [modeRequest, setModeRequest] = useState<GenerateCtx["modeRequest"]>(null);
  const [tool, setTool] = useState<GenerateCtx["tool"]>(null);
  const [higgsfield, setHiggsfield] = useState<Capabilities | null>(null);
  const [drawerAsset, setDrawerAsset] = useState<ToolSource | null>(null);

  const refreshHiggsfield = useCallback((force = false) => {
    void (async () => {
      try {
        const r = await fetch(`/api/gen/status${force ? "?refresh=1" : ""}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        setHiggsfield(((await r.json()) as { higgsfield: Capabilities }).higgsfield);
      } catch {
        setHiggsfield({ available: false, reason: "Could not reach Studio" });
      }
    })();
  }, []);
  // One check when the app loads; tool menus and the confirm refresh it when they open.
  useEffect(() => refreshHiggsfield(), [refreshHiggsfield]);
  const openTool = useCallback(
    (source: ToolSource, t: ToolId) => {
      setTool({ source, tool: t, nonce: Date.now() });
      refreshHiggsfield();
    },
    [refreshHiggsfield],
  );
  const closeTool = useCallback(() => setTool(null), []);

  const addRef = useCallback((ref: RefItem) => {
    setRefs((prev) => (prev.some((r) => r.id === ref.id) ? prev : [...prev, ref]));
  }, []);
  const removeRef = useCallback((id: number) => {
    setRefs((prev) => prev.filter((r) => r.id !== id));
    setRoles((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  const setRole = useCallback((id: number, role: RefRole) => setRoles((prev) => ({ ...prev, [id]: role })), []);
  const openPanel = useCallback<GenerateCtx["openPanel"]>(
    (opts) => {
      if (opts?.dest) setDest(opts.dest);
      else if (!open) setDest(destForPath(pathname));
      if (opts?.replaceRefs) {
        setRefs(opts.refs ?? []);
        setRoles(opts.roles ?? {});
      } else {
        opts?.refs?.forEach(addRef);
        if (opts?.roles) setRoles((prev) => ({ ...prev, ...opts.roles }));
      }
      if (opts?.preset) setPreset({ ...opts.preset, nonce: Date.now() });
      if (opts?.mode) setModeRequest({ mode: opts.mode, nonce: Date.now() });
      setOpen(true);
    },
    [open, pathname, addRef],
  );
  const close = useCallback(() => setOpen(false), []);

  const value = useMemo<GenerateCtx>(
    () => ({
      open,
      openPanel,
      close,
      refs,
      addRef,
      removeRef,
      hasRef: (id) => refs.some((r) => r.id === id),
      roles,
      setRole,
      preset,
      dest,
      setDest,
      modeRequest,
      tool,
      openTool,
      closeTool,
      higgsfield,
      refreshHiggsfield,
      drawerAsset,
      setDrawerAsset,
    }),
    [open, openPanel, close, refs, addRef, removeRef, roles, setRole, preset, dest, modeRequest, tool, openTool, closeTool, higgsfield, refreshHiggsfield, drawerAsset],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGenerate(): GenerateCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGenerate outside GenerateProvider");
  return ctx;
}

/** Main content wrapper: leaves room for the panel so the whole grid stays clickable while it is open. */
export function GenerateAware({ children }: { children: React.ReactNode }) {
  const { open } = useGenerate();
  return <div className={open ? "min-[1100px]:pr-[440px]" : undefined}>{children}</div>;
}
