"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ImagePlus, Loader2, RefreshCw, Sparkles, TriangleAlert, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { queueGeneration } from "@/app/actions";
import { useStatus } from "@/components/shell/status-provider";
import {
  BRAND_GUARD_SUFFIX,
  brandGuardDefault,
  CODEX_MODEL,
  CODEX_SCHEMA,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VERSIONS,
  DEFAULT_VIDEO_MODEL,
  formParams,
  resolveParams,
  studioDefaults,
  type Capabilities,
  type ModelListItem,
  type ModelParam,
  type ModelSchema,
  type ParamValue,
} from "@/lib/gen/types";
import { assignRoles, mediaCounts, PROOF_GUARD_TEXT, ROLE_LABEL, rolesFor, ruleViolations, type RefRole, type RoleAssignment } from "@/lib/gen/rules";
import { needsDriveText, useGenerate, type GenMode, type RefItem } from "./generate-provider";
import { destKey, destLabel, destLabelsOf, type GenDest } from "@/lib/gen/layout";
import { useLabels } from "@/components/shell/labels-provider";

type Models = { shortlist: ModelListItem[]; all: ModelListItem[] };
type Estimate = { perVersion: number; total: number; versions: number; key: string };
type Values = Record<string, ParamValue | null>;
type Engines = { higgsfield: Capabilities; codex: Capabilities };

const DEFAULT_TOKEN = "__default";

const MODES: { mode: GenMode; label: string; engine: keyof Engines }[] = [
  { mode: "hf-image", label: "Higgsfield image", engine: "higgsfield" },
  { mode: "codex", label: "ChatGPT image", engine: "codex" },
  { mode: "hf-video", label: "Higgsfield video", engine: "higgsfield" },
];
const kindOf = (mode: GenMode) => (mode === "hf-video" ? "video" : "image");

function label(name: string) {
  const s = name.replace(/_/g, " ");
  return s[0].toUpperCase() + s.slice(1);
}

function credits(n: number | null | undefined) {
  if (n == null) return "";
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, "")} credit${n === 1 ? "" : "s"}`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

/** Initial form values: the model's defaults, then Studio's (9:16; gpt_image_2_5 high 2k; kling3_0 std 5 s). */
function initialValues(schema: ModelSchema): Values {
  const out: Values = {};
  for (const p of formParams(schema)) out[p.name] = p.default;
  return { ...out, ...studioDefaults(schema) };
}

/** Only values that are set; the server drops the ones equal to the model default. */
function setValues(values: Values): Record<string, ParamValue> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== "")) as Record<string, ParamValue>;
}

export function GeneratePanel({ clients }: { clients: { code: string; short: string }[] }) {
  const L = useLabels();
  const g = useGenerate();
  const { drive, worker, gen: genStatus } = useStatus();
  const router = useRouter();
  const [mode, setModeRaw] = useState<GenMode>("hf-image");
  const [modelsBy, setModelsBy] = useState<Partial<Record<"image" | "video", Models>>>({});
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelBy, setModelBy] = useState<{ "hf-image": string; "hf-video": string }>({
    "hf-image": DEFAULT_IMAGE_MODEL,
    "hf-video": DEFAULT_VIDEO_MODEL,
  });
  const [schemas, setSchemas] = useState<Record<string, ModelSchema>>({ [CODEX_MODEL]: CODEX_SCHEMA });
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [valuesBy, setValuesBy] = useState<Record<string, Values>>({});
  const [prompt, setPrompt] = useState("");
  const [brandGuard, setBrandGuard] = useState(true);
  const [versions, setVersions] = useState(DEFAULT_VERSIONS);
  const [engines, setEngines] = useState<Engines | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateError, setEstimateError] = useState<{ key: string; message: string } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<{ model: string; params: Values } | null>(null);
  const [pending, startTransition] = useTransition();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const kind = kindOf(mode);
  const model = mode === "codex" ? CODEX_MODEL : modelBy[mode];
  const engineKey = mode === "codex" ? "codex" : "higgsfield";
  const engine = engines?.[engineKey] ?? null;

  const setMode = (next: GenMode) => {
    if (kindOf(mode) !== kindOf(next)) setBrandGuard(brandGuardDefault(kindOf(next)));
    setModeRaw(next);
  };

  const loadModels = useCallback(async (k: "image" | "video", refresh = false) => {
    try {
      const list = await getJson<Models>(`/api/gen/models?kind=${k}${refresh ? "&refresh=1" : ""}`);
      setModelsBy((prev) => ({ ...prev, [k]: list }));
      setModelsError(null);
    } catch (e) {
      setModelsError((e as Error).message);
    }
  }, []);

  const loadStatus = useCallback(async (refresh = false) => {
    try {
      setEngines(await getJson<Engines>(`/api/gen/status${refresh ? "?refresh=1" : ""}`));
    } catch {
      const down = { available: false, reason: "Could not reach Studio" };
      setEngines({ higgsfield: down, codex: down });
    }
  }, []);

  // Engine status when the panel opens; the model list for the current Higgsfield kind.
  useEffect(() => {
    if (!g.open) return;
    void (async () => {
      await loadStatus();
    })();
  }, [g.open, loadStatus]);
  const hasModels = Boolean(modelsBy[kind]);
  useEffect(() => {
    if (!g.open || mode === "codex" || hasModels) return;
    void (async () => {
      await loadModels(kind);
    })();
  }, [g.open, mode, kind, hasModels, loadModels]);

  // A generation landed: the balance changed.
  const lastGenDone = useRef(genStatus.lastDoneAt);
  useEffect(() => {
    if (genStatus.lastDoneAt === lastGenDone.current) return;
    lastGenDone.current = genStatus.lastDoneAt;
    if (!g.open) return;
    void (async () => {
      await loadStatus(true);
    })();
  }, [genStatus.lastDoneAt, g.open, loadStatus]);

  // cmd+K "Generate image" / "Generate video": switch the engine tab once per request.
  const [appliedModeNonce, setAppliedModeNonce] = useState<number | null>(null);
  const modeRequest = g.modeRequest;
  if (modeRequest && modeRequest.nonce !== appliedModeNonce) {
    setAppliedModeNonce(modeRequest.nonce);
    const wanted = modeRequest.mode === "hf-image" && mode === "codex" ? "codex" : modeRequest.mode; // keep ChatGPT when asked for "an image"
    if (kindOf(mode) !== kindOf(wanted)) setBrandGuard(brandGuardDefault(kindOf(wanted)));
    setModeRaw(wanted);
  }

  // Remix: reopen with a finished run. Applied once per nonce (state adjusted during render, not in an
  // effect); its params land as soon as that model's schema is in.
  const [appliedNonce, setAppliedNonce] = useState<number | null>(null);
  const preset = g.preset;
  if (preset && preset.nonce !== appliedNonce) {
    setAppliedNonce(preset.nonce);
    setModeRaw(preset.mode);
    if (preset.mode !== "codex") setModelBy((prev) => ({ ...prev, [preset.mode]: preset.model }));
    setPrompt(preset.prompt);
    setBrandGuard(preset.brandGuard);
    setPendingPreset({ model: preset.mode === "codex" ? CODEX_MODEL : preset.model, params: preset.params });
  }
  const presetSchema = pendingPreset ? schemas[pendingPreset.model] : undefined;
  if (pendingPreset && presetSchema) {
    const names = new Set(formParams(presetSchema).map((p) => p.name));
    const kept = Object.fromEntries(Object.entries(pendingPreset.params).filter(([k, v]) => names.has(k) && v != null));
    setValuesBy((prev) => ({ ...prev, [pendingPreset.model]: { ...initialValues(presetSchema), ...kept } }));
    setPendingPreset(null);
  }

  // Schema for the chosen Higgsfield model; the form is built from it (never hardcoded). Cached per model.
  const haveSchema = Boolean(schemas[model]);
  useEffect(() => {
    if (!g.open || haveSchema) return;
    let cancelled = false;
    void (async () => {
      try {
        const s = await getJson<ModelSchema>(`/api/gen/models/${model}`);
        if (cancelled) return;
        setSchemas((prev) => ({ ...prev, [s.jobType]: s }));
        setSchemaError(null);
      } catch (e) {
        if (!cancelled) setSchemaError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [g.open, model, haveSchema]);

  const liveSchema = schemas[model] ?? null;
  const values = useMemo<Values>(() => valuesBy[model] ?? (liveSchema ? initialValues(liveSchema) : {}), [valuesBy, model, liveSchema]);
  const setVal = (name: string, v: ParamValue | null) =>
    setValuesBy((prev) => ({ ...prev, [model]: { ...(prev[model] ?? (liveSchema ? initialValues(liveSchema) : {})), [name]: v } }));
  const valuesKey = JSON.stringify(setValues(values));

  // Reference roles (start frame / end frame / reference / video reference) and the model's rules.
  const assignments = useMemo<RoleAssignment[]>(
    () => (liveSchema ? assignRoles(liveSchema, g.refs, g.roles) : g.refs.map((r) => ({ id: r.id, kind: r.kind, role: null }))),
    [liveSchema, g.refs, g.roles],
  );
  const roleOf = new Map(assignments.map((a) => [a.id, a.role]));
  const rolesKey = assignments.map((a) => a.role ?? "none").join(",");
  const unplaced = liveSchema ? g.refs.filter((r) => !roleOf.get(r.id)) : [];
  const violations = useMemo(() => {
    if (!liveSchema) return [];
    const resolved = resolveParams(liveSchema, JSON.parse(valuesKey));
    if (!resolved.ok) return [resolved.error];
    return ruleViolations(liveSchema, resolved.effective, mediaCounts(assignments));
  }, [liveSchema, valuesKey, assignments]);
  const proof = g.refs.some((r) => r.proof);

  // Debounced cost quote for the whole run (Higgsfield only; ChatGPT is included in the plan).
  const quotable = g.open && mode !== "codex" && Boolean(liveSchema) && unplaced.length === 0 && violations.length === 0;
  // A quote only counts for exactly the settings it was taken for (never a stale one after a change).
  const quoteKey = `${model}|${valuesKey}|${versions}|${rolesKey}`;
  useEffect(() => {
    if (!quotable) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setEstimating(true);
      try {
        const refs = rolesKey.split(",").filter((r) => r && r !== "none").join(",");
        const q = new URLSearchParams({ model, p: valuesKey, n: String(versions), refs });
        const r = await fetch(`/api/gen/estimate?${q}`, { cache: "no-store", signal: ctrl.signal });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        setEstimate({ ...(data as Omit<Estimate, "key">), key: quoteKey });
        setEstimateError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setEstimate(null);
          setEstimateError({ key: quoteKey, message: (e as Error).message });
        }
      } finally {
        if (!ctrl.signal.aborted) setEstimating(false);
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [quotable, model, valuesKey, versions, rolesKey, quoteKey]);
  const liveEstimate = quotable && estimate?.key === quoteKey && !estimating ? estimate : null;
  const liveEstimateError = quotable && estimateError?.key === quoteKey ? estimateError.message : null;

  const fields = useMemo(() => (liveSchema ? formParams(liveSchema) : []), [liveSchema]);
  const modelName = liveSchema?.displayName ?? model;

  const blocker = !drive.mounted
    ? needsDriveText(drive)
    : engine && !engine.available
      ? (engine.reason ?? "This engine is unavailable")
      : !liveSchema
        ? "Loading the model"
        : !prompt.trim()
          ? "Write a prompt first"
          : unplaced.length
            ? `${modelName} can't use ${unplaced[0].filename} (remove it)`
            : violations.length
              ? violations[0]
              : mode === "codex"
                ? null
                : !liveEstimate
                  ? liveEstimateError
                    ? `Cost unavailable: ${liveEstimateError}`
                    : "Getting the cost"
                  : null;

  const submit = () => {
    if (blocker) return;
    startTransition(async () => {
      const r = await queueGeneration({
        engine: mode === "codex" ? "codex" : "higgsfield",
        model,
        prompt,
        brandGuard,
        params: setValues(values),
        references: g.refs.map((ref) => ({ id: ref.id, role: g.roles[ref.id] })),
        versions,
        dest: g.dest,
        estimate: liveEstimate?.perVersion ?? null,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Queued.", {
        action: { label: "Jobs", onClick: () => router.push("/jobs") },
      });
    });
  };

  const dests: GenDest[] = [
    { section: "rtm" },
    { section: "fkb" },
    { section: "fkbpros", client: null },
    ...clients.map((c): GenDest => ({ section: "fkbpros", client: c.code })),
  ];
  const destOptions = dests.map((d) => ({ value: destKey(d), label: destLabel(d, clients, destLabelsOf(L)) }));
  const models = mode === "codex" ? null : (modelsBy[kind] ?? null);
  const shortlistTypes = new Set(models?.shortlist.map((m) => m.jobType));
  const others = models?.all.filter((m) => !shortlistTypes.has(m.jobType)) ?? [];

  return (
    <Sheet open={g.open} onOpenChange={(o) => !o && g.close()} modal={false}>
      <SheetContent
        side="right"
        showOverlay={false}
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          promptRef.current?.focus();
        }}
        className="gap-0 p-0 data-[side=right]:w-[min(440px,100vw)] data-[side=right]:sm:max-w-none"
        aria-describedby="generate-desc"
      >
        <SheetHeader className="border-b border-border px-5 py-4 pr-12">
          <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">Generate</div>
          <SheetTitle className="text-[17px] font-semibold tracking-[-0.01em]">{kind === "video" ? "New video" : "New image"}</SheetTitle>
          <SheetDescription id="generate-desc" className="text-[12.5px]">
            Click cards in the Library to add them as references. Results land back in the Library, tagged to the channel you pick.
          </SheetDescription>
        </SheetHeader>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <Field label="Engine">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="tablist">
              {MODES.map((m) => {
                const caps = engines?.[m.engine];
                return (
                  <EngineTab
                    key={m.mode}
                    label={m.label}
                    active={mode === m.mode}
                    unavailable={caps && !caps.available ? (caps.reason ?? "Unavailable") : null}
                    onClick={() => setMode(m.mode)}
                  />
                );
              })}
            </div>
          </Field>

          <Field
            label="Model"
            aside={
              mode !== "codex" && (
                <button
                  type="button"
                  className="flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => void loadModels(kind, true)}
                  title="Reload the model list from Higgsfield"
                >
                  <RefreshCw className="size-3" /> Refresh
                </button>
              )
            }
          >
            {mode === "codex" ? (
              <div className="flex h-8 items-center rounded-lg border border-border bg-card px-2.5 text-[13.5px]">
                GPT Image
                <span className="ml-1.5 text-[11.5px] text-muted-foreground">via Codex, on your ChatGPT plan</span>
              </div>
            ) : modelsError && !models ? (
              <Problem>{modelsError}</Problem>
            ) : (
              <Select value={model} onValueChange={(v) => setModelBy((prev) => ({ ...prev, [mode]: v }))} disabled={!models}>
                <SelectTrigger className="w-full bg-card" aria-label="Model">
                  <SelectValue placeholder="Loading models…" />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-[360px]">
                  <SelectGroup>
                    <SelectLabel>Shortlist</SelectLabel>
                    {models?.shortlist.map((m) => (
                      <ModelItem key={m.jobType} m={m} />
                    ))}
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>All models</SelectLabel>
                    {others.map((m) => (
                      <ModelItem key={m.jobType} m={m} />
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field label="Prompt" aside={<span className="text-[11.5px] text-muted-foreground tabular">{prompt.length}/4000</span>}>
            <Textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, 4000))}
              placeholder={
                kind === "video"
                  ? "Slow push-in on a sunlit studio desk, morning light through the window"
                  : "Bright minimal workspace, a laptop and a coffee cup on an oak desk, wide shot"
              }
              className="min-h-[108px] bg-card text-[13.5px]"
            />
            <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
              <Switch checked={brandGuard} onCheckedChange={setBrandGuard} className="mt-0.5 data-[state=checked]:bg-brand" aria-label="Brand guard" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">Brand guard</span>
                <span className="block text-[12px] text-muted-foreground">Adds: “{BRAND_GUARD_SUFFIX}”</span>
              </span>
            </label>
          </Field>

          <Field label="References" aside={<span className="text-[11.5px] text-muted-foreground tabular">{g.refs.length}</span>}>
            <ReferenceTray
              refs={g.refs}
              schema={liveSchema}
              roleOf={roleOf}
              onRole={g.setRole}
              onRemove={g.removeRef}
            />
            {proof && <Problem>{PROOF_GUARD_TEXT}</Problem>}
            {unplaced.map((r) => (
              <Problem key={r.id}>
                {modelName} can’t use {r.filename}
                {r.kind === "audio" ? " (audio references aren’t supported)" : rolesFor(liveSchema!, r.kind).length ? " (no free slot)" : ` (it takes no ${r.kind} references)`}.
              </Problem>
            ))}
            {violations.map((v) => (
              <Problem key={v}>{v}</Problem>
            ))}
          </Field>

          {liveSchema ? (
            fields.length > 0 && (
              <Field label="Settings">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  {fields.map((p) => (
                    <ParamField key={p.name} p={p} value={values[p.name] ?? null} onChange={(v) => setVal(p.name, v)} />
                  ))}
                </div>
              </Field>
            )
          ) : schemaError ? (
            <Problem>{schemaError}</Problem>
          ) : (
            <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading settings…
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Versions">
              <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setVersions(n)}
                    className={cn(
                      "h-7 rounded-md text-[13px] font-medium tabular transition-colors",
                      versions === n ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-pressed={versions === n}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Save to">
              <Select value={g.dest} onValueChange={g.setDest}>
                <SelectTrigger className="w-full bg-card" aria-label="Save to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {destOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>

        <footer className="border-t border-border bg-card px-5 py-3.5">
          {mode === "codex" ? (
            <>
              <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className="font-medium text-foreground">Included in your ChatGPT plan</span>
                {engine && !engine.available && <span className="text-brand-text">{engine.reason}</span>}
              </div>
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                About a minute per image, two at a time. You can cancel on the Jobs page.
                {!worker.alive && " The worker is offline: jobs wait until it is back."}
              </p>
            </>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className="text-muted-foreground">
                  {!quotable ? (
                    <span>Estimate after the settings are valid</span>
                  ) : liveEstimateError && !estimating ? (
                    <span className="text-brand-text">Cost unavailable: {liveEstimateError}</span>
                  ) : liveEstimate ? (
                    <>
                      Estimated <span className="font-semibold text-foreground tabular">{credits(liveEstimate.total)}</span>
                      {liveEstimate.versions > 1 && (
                        <span className="tabular">
                          {" "}
                          ({liveEstimate.versions} × {liveEstimate.perVersion})
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="size-3 animate-spin" /> Estimating…
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground tabular">
                  {engine?.available ? (
                    <>
                      Balance <span className="font-medium text-foreground">{credits(engine.credits)}</span>
                    </>
                  ) : engine ? (
                    <span className="text-brand-text">{engine.reason}</span>
                  ) : null}
                </span>
              </div>
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                Credits are spent as soon as it starts. You can cancel on the Jobs page only while a job waits in the queue.
                {!worker.alive && " The worker is offline: jobs wait until it is back."}
              </p>
            </>
          )}
          <Gate hint={blocker}>
            <Button
              className="mt-2.5 h-10 w-full bg-brand text-[14px] text-ink hover:bg-brand/90"
              disabled={Boolean(blocker) || pending}
              onClick={submit}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {mode === "codex"
                ? `Generate ${versions} · ChatGPT plan`
                : liveEstimate
                  ? `Spend ${credits(liveEstimate.total)} · generate ${versions}`
                  : `Generate ${versions}`}
            </Button>
          </Gate>
          <div className="mt-2 text-center text-[11.5px] text-muted-foreground">
            Progress and logs on <Link href="/jobs" className="underline underline-offset-2 hover:text-foreground">Jobs</Link>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label: text, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{text}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1.5 flex items-start gap-1.5 text-[12px] text-brand-text">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function EngineTab({
  label: text,
  active,
  unavailable,
  onClick,
}: {
  label: string;
  active: boolean;
  unavailable: string | null;
  onClick: () => void;
}) {
  const tab = (
    <button
      type="button"
      role="tab"
      disabled={Boolean(unavailable)}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center justify-center rounded-md px-1 text-[12px] font-medium transition-colors",
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        unavailable && "cursor-not-allowed text-muted-foreground/60 hover:text-muted-foreground/60",
      )}
      aria-selected={active}
    >
      {text}
    </button>
  );
  if (!unavailable) return tab;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {tab}
        </span>
      </TooltipTrigger>
      <TooltipContent>{unavailable}</TooltipContent>
    </Tooltip>
  );
}

function ModelItem({ m }: { m: ModelListItem }) {
  return (
    <SelectItem value={m.jobType}>
      <span>{m.displayName}</span>
      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{m.jobType}</span>
    </SelectItem>
  );
}

function ParamField({ p, value, onChange }: { p: ModelParam; value: ParamValue | null; onChange: (v: ParamValue | null) => void }) {
  const title = <div className="mb-1 truncate text-[12px] text-muted-foreground">{label(p.name)}</div>;
  if (p.enum?.length) {
    const nullable = p.type.includes("null") || p.default == null;
    return (
      <div className="min-w-0">
        {title}
        <Select value={value == null ? DEFAULT_TOKEN : String(value)} onValueChange={(v) => onChange(v === DEFAULT_TOKEN ? null : v)}>
          <SelectTrigger size="sm" className="w-full bg-card" aria-label={label(p.name)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-[300px]">
            {nullable && <SelectItem value={DEFAULT_TOKEN}>Auto</SelectItem>}
            {p.enum.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  if (p.type.startsWith("boolean")) {
    return (
      <label className="flex min-w-0 cursor-pointer items-center justify-between gap-2 self-end rounded-lg border border-border bg-card px-2.5 py-1.5">
        <span className="truncate text-[12.5px]">{label(p.name)}</span>
        <Switch size="sm" checked={value === true} onCheckedChange={(v) => onChange(v)} aria-label={label(p.name)} />
      </label>
    );
  }
  const numeric = p.type.startsWith("integer") || p.type.startsWith("number");
  return (
    <div className="min-w-0">
      {title}
      <Input
        type={numeric ? "number" : "text"}
        inputMode={numeric ? "numeric" : undefined}
        value={value == null ? "" : String(value)}
        placeholder={p.default == null ? "Auto" : String(p.default)}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(null);
          onChange(numeric ? Number(raw) : raw);
        }}
        className="h-7 bg-card text-[13px]"
      />
    </div>
  );
}

const ROLE_SHORT: Record<RefRole, string> = {
  start_image: "Start",
  end_image: "End",
  image_references: "Ref",
  video_references: "Video ref",
};

function ReferenceTray({
  refs,
  schema,
  roleOf,
  onRole,
  onRemove,
}: {
  refs: RefItem[];
  schema: ModelSchema | null;
  roleOf: Map<number, RefRole | null>;
  onRole: (id: number, role: RefRole) => void;
  onRemove: (id: number) => void;
}) {
  if (refs.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-lg border-2 border-dashed border-foreground/20 bg-muted/40 px-3.5 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-card text-brand-text">
          <ImagePlus className="size-[18px]" />
        </span>
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium text-foreground">Click any card in the Library to add it here</span>
          <span className="block text-[12px] text-muted-foreground">Or use a card’s + button. References are optional.</span>
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {refs.map((r) => {
        const role = roleOf.get(r.id) ?? null;
        const options = schema ? rolesFor(schema, r.kind) : [];
        return (
          <div key={r.id} className="w-[72px]">
            <div
              className={cn("group relative size-[72px] overflow-hidden rounded-lg border bg-muted", role ? "border-border" : "border-brand/60")}
              title={r.filename}
            >
              {r.hasThumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/media/${r.id}/thumb${r.v ? `?v=${r.v}` : ""}`} alt={r.filename} className="h-full w-full object-cover" draggable={false} />
              ) : (
                <div className="grid h-full place-items-center p-1 text-center text-[10px] text-muted-foreground">{r.filename}</div>
              )}
              <button
                type="button"
                onClick={() => onRemove(r.id)}
                className="absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-ink/75 text-paper opacity-90 transition-opacity hover:opacity-100"
                aria-label={`Remove ${r.filename}`}
              >
                <X className="size-3" />
              </button>
            </div>
            {options.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="mt-1 flex h-6 w-full items-center justify-center gap-0.5 rounded-md border border-border bg-card text-[11px] font-medium hover:bg-muted"
                    aria-label={`Role of ${r.filename}`}
                  >
                    {role ? ROLE_SHORT[role] : "Not used"}
                    <ChevronDown className="size-3 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuRadioGroup value={role ?? ""} onValueChange={(v) => onRole(r.id, v as RefRole)}>
                    {options.map((o) => (
                      <DropdownMenuRadioItem key={o} value={o}>
                        {ROLE_LABEL[o]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className={cn("mt-1 h-6 text-center text-[11px] leading-6 font-medium", role ? "text-muted-foreground" : "text-brand-text")}>
                {role ? ROLE_SHORT[role] : "Not used"}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Gate({ hint, children }: { hint: string | null; children: React.ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="block">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
