"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Play, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { rescoreAction, saveNoteAction, saveRubricAction } from "@/app/actions";
import { slugId } from "@/lib/hooks/rubric-edit";
import { PRIMARY_BTN } from "@/components/hooks/ui";
import { avatarSections, type Avatar, type Dimension, type HookKind, type Mechanic, type RubricContent, type SectionKey } from "@/lib/hooks/rubric";
import { useLabels } from "@/components/shell/labels-provider";
const iconBtn =
  "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40";

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("grid gap-1 text-[11.5px] font-medium text-muted-foreground", className)}>
      {label}
      {children}
    </label>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12.5px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-[var(--color-brand)]" />
      {label}
    </label>
  );
}

const area = "min-h-0 text-[13px] leading-snug";

/**
 * The Rubric page in edit mode (F1, F2): dimensions (wording, levels, where they apply, add / remove), the 9 mechanic
 * definitions, avatars (edit, add, remove, section, universal only, also offered on Lane C). Save = a new version with a
 * note; nothing is rescored until the Rescore click that follows.
 */
export function RubricEditor({ initial, version, children }: { initial: RubricContent; version: number; children: React.ReactNode }) {
  const SECTION_NAME = useLabels().lane;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RubricContent>(initial);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const hasFkb = initial.dimensions.some((d) => d.appliesTo.sections.includes("fkb"));
  const sectionsShown: SectionKey[] = hasFkb ? ["rtm", "fkbpros", "fkb"] : ["rtm", "fkbpros"];

  const begin = () => {
    setDraft(structuredClone(initial));
    setNote("");
    setEditing(true);
  };

  const setDim = (i: number, patch: Partial<Dimension>) =>
    setDraft((d) => ({ ...d, dimensions: d.dimensions.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const setMech = (i: number, patch: Partial<Mechanic>) =>
    setDraft((d) => ({ ...d, mechanics: d.mechanics.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const setAv = (slug: string, patch: Partial<Avatar>) =>
    setDraft((d) => ({ ...d, avatars: d.avatars.map((x) => (x.slug === slug ? { ...x, ...patch } : x)) }));

  const toggle = <T extends string>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  const addDimension = () =>
    setDraft((d) => ({
      ...d,
      dimensions: [
        ...d.dimensions,
        {
          id: slugId("new dimension", d.dimensions.map((x) => x.id)),
          label: "",
          short: "",
          question: "",
          appliesTo: { kinds: ["text", "video"], sections: [...sectionsShown] },
          levels: ["", "", "", "", ""],
        },
      ],
    }));

  const addAvatar = (section: SectionKey) =>
    setDraft((d) => ({
      ...d,
      avatars: [
        ...d.avatars,
        {
          slug: slugId(`${section === "rtm" ? "rtm " : ""}new avatar`, d.avatars.map((a) => a.slug), 60),
          label: "",
          section,
          stage: section === "rtm" ? null : "ps",
          person: "",
          pain: "",
          promise: "",
          universalOnly: false,
        },
      ],
    }));

  const save = () =>
    start(async () => {
      // New rows get an id from their label (existing ids never change: old scores point at them).
      const known = new Set(initial.dimensions.map((d) => d.id));
      const knownAv = new Set(initial.avatars.map((a) => a.slug));
      const taken = new Set<string>();
      const dimensions = draft.dimensions.map((d) => {
        const id = known.has(d.id) ? d.id : slugId(d.label || "dimension", [...known, ...taken]);
        taken.add(id);
        return { ...d, id };
      });
      const takenAv = new Set<string>();
      const avatars = draft.avatars.map((a) => {
        const slug = knownAv.has(a.slug) ? a.slug : slugId(`${a.section === "rtm" ? "rtm " : ""}${a.label || "avatar"}`, [...knownAv, ...takenAv], 60);
        takenAv.add(slug);
        return { ...a, slug };
      });
      const r = await saveRubricAction({ content: { ...draft, dimensions, avatars }, note });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.message) toast.success(r.message);
      setEditing(false);
      router.refresh();
    });

  if (!editing) {
    return (
      <>
        <div className="mt-4 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={begin}>
            <Pencil /> Edit rubric
          </Button>
          <span className="text-[12px] text-muted-foreground">Saving makes v{version + 1}; nothing is rescored until you click Rescore.</span>
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="mt-5 space-y-5">
      <div className="sticky top-0 z-10 flex flex-wrap items-end gap-3 rounded-xl border border-brand/40 bg-card px-4 py-3 shadow-sm">
        <div className="text-[13px]">
          <div className="font-semibold">Editing: saves as v{version + 1}</div>
          <div className="text-[12px] text-muted-foreground">v{version} and its scores stay. Hooks are rescored only after you click Rescore.</div>
        </div>
        <Field label="Note (what changed and why)" className="min-w-[280px] flex-1">
          <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Offer clarity reads the spoken opening on video" />
        </Field>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={pending}>
          <X /> Cancel
        </Button>
        <Button size="sm" className={PRIMARY_BTN} onClick={save} disabled={pending || note.trim().length < 3}>
          {pending ? <Loader2 className="animate-spin" /> : <Save />} Save v{version + 1}
        </Button>
      </div>

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold">Dimensions</h2>
          <Button variant="outline" size="xs" className="ml-auto" onClick={addDimension}>
            <Plus /> Add dimension
          </Button>
        </div>
        <div className="divide-y divide-border">
          {draft.dimensions.map((d, i) => (
            <div key={`${d.id}-${i}`} className="grid gap-3 px-5 py-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto]">
                <Field label="Label">
                  <Input value={d.label} onChange={(e) => setDim(i, { label: e.target.value })} maxLength={40} />
                </Field>
                <Field label="Short (row bars)">
                  <Input value={d.short} onChange={(e) => setDim(i, { short: e.target.value })} maxLength={12} />
                </Field>
                <div className="flex items-end">
                  <button
                    type="button"
                    className={iconBtn}
                    onClick={() => setDraft((x) => ({ ...x, dimensions: x.dimensions.filter((_, j) => j !== i) }))}
                    aria-label={`Remove ${d.label || "dimension"}`}
                    title="Remove this dimension"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
                <span className="text-muted-foreground">Applies to:</span>
                {sectionsShown.map((sec) => (
                  <Check
                    key={sec}
                    label={SECTION_NAME[sec]}
                    checked={d.appliesTo.sections.includes(sec)}
                    onChange={(on) => setDim(i, { appliesTo: { ...d.appliesTo, sections: toggle(d.appliesTo.sections, sec, on) } })}
                  />
                ))}
                <span className="text-muted-foreground">·</span>
                {(["text", "video"] as HookKind[]).map((k) => (
                  <Check
                    key={k}
                    label={k === "text" ? "Text hooks" : "Video hooks"}
                    checked={d.appliesTo.kinds.includes(k)}
                    onChange={(on) => setDim(i, { appliesTo: { ...d.appliesTo, kinds: toggle(d.appliesTo.kinds, k, on) } })}
                  />
                ))}
                <span className="font-mono text-[11px] text-muted-foreground">{initial.dimensions.some((x) => x.id === d.id) ? d.id : "new"}</span>
              </div>
              <Field label="Question Jev reads (name the state keys it should look at, like `hook.text`)">
                <Textarea rows={2} className={area} value={d.question} onChange={(e) => setDim(i, { question: e.target.value })} />
              </Field>
              <div className="grid gap-1.5">
                {d.levels.map((l, k) => (
                  <div key={k} className="grid grid-cols-[28px_1fr] items-start gap-2">
                    <span className="mt-1.5 grid h-5 w-6 place-items-center rounded-md bg-muted text-[11.5px] font-medium tabular">{k + 1}</span>
                    <Textarea
                      rows={1}
                      className={area}
                      value={l}
                      aria-label={`${d.label} level ${k + 1}`}
                      onChange={(e) => setDim(i, { levels: d.levels.map((x, j) => (j === k ? e.target.value : x)) })}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold">Copy mechanics</h2>
          <p className="text-[12px] text-muted-foreground">Definitions only: the names stay (coverage and old scores use them).</p>
        </div>
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
          {draft.mechanics.map((m, i) => (
            <Field key={m.id} label={m.label}>
              <Textarea rows={2} className={area} value={m.definition} onChange={(e) => setMech(i, { definition: e.target.value })} />
            </Field>
          ))}
        </div>
      </section>

      {((hasFkb ? ["fkbpros", "fkb", "rtm"] : ["fkbpros", "rtm"]) as SectionKey[]).map((sec) => (
        <section key={sec} className="rounded-xl border border-border bg-card">
          <div className="flex items-center border-b border-border px-5 py-3">
            <h2 className="text-[15px] font-semibold">Avatars · {SECTION_NAME[sec]}</h2>
            {sec === "fkb" && (
              <span className="ml-3 text-[12px] text-muted-foreground">
                {SECTION_NAME.fkb}&apos;s own avatars; the {SECTION_NAME.fkbpros} ones marked &quot;Also {SECTION_NAME.fkb}&quot; are offered too
              </span>
            )}
            <Button variant="outline" size="xs" className="ml-auto" onClick={() => addAvatar(sec)}>
              <Plus /> Add avatar
            </Button>
          </div>
          <div className="divide-y divide-border">
            {draft.avatars
              .filter((a) => a.section === sec)
              .map((a) => (
                <div key={a.slug} className="grid gap-2.5 px-5 py-3.5">
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="Label" className="min-w-[220px] flex-1">
                      <Input value={a.label} maxLength={50} onChange={(e) => setAv(a.slug, { label: e.target.value })} />
                    </Field>
                    <Field label="Section">
                      <select
                        value={a.section}
                        onChange={(e) => {
                          const next = e.target.value as SectionKey;
                          setAv(a.slug, {
                            section: next,
                            sections: undefined,
                            stage: next === "rtm" ? null : (a.stage ?? "ps"),
                            universalOnly: next === "fkbpros" ? a.universalOnly : false,
                          });
                        }}
                        className="h-9 rounded-md border border-border bg-card px-2 text-[13px] text-foreground"
                      >
                        <option value="fkbpros">{SECTION_NAME.fkbpros}</option>
                        {hasFkb && <option value="fkb">{SECTION_NAME.fkb}</option>}
                        <option value="rtm">{SECTION_NAME.rtm}</option>
                      </select>
                    </Field>
                    {a.section !== "rtm" && (
                      <Field label="Stage">
                        <select
                          value={a.stage ?? "ps"}
                          onChange={(e) => setAv(a.slug, { stage: e.target.value as "ps" | "obj" })}
                          className="h-9 rounded-md border border-border bg-card px-2 text-[13px] text-foreground"
                        >
                          <option value="ps">Problem / solution</option>
                          <option value="obj">Objection</option>
                        </select>
                      </Field>
                    )}
                    {a.section === "fkbpros" && (
                      <div className="flex gap-4 pb-2">
                        <Check
                          label="Universal only (shared hooks)"
                          checked={a.universalOnly}
                          onChange={(on) => setAv(a.slug, on ? { universalOnly: true, sections: undefined } : { universalOnly: false })}
                        />
                        {hasFkb && (
                          <Check
                            label={`Also ${SECTION_NAME.fkb}`}
                            checked={!a.universalOnly && avatarSections(a).includes("fkb")}
                            onChange={(on) =>
                              setAv(a.slug, { sections: on ? ["fkbpros", "fkb"] : undefined, universalOnly: on ? false : a.universalOnly })
                            }
                          />
                        )}
                      </div>
                    )}
                    <span className="pb-2 font-mono text-[11px] text-muted-foreground">{initial.avatars.some((x) => x.slug === a.slug) ? a.slug : "new"}</span>
                    <button
                      type="button"
                      className={cn(iconBtn, "mb-1")}
                      onClick={() => setDraft((x) => ({ ...x, avatars: x.avatars.filter((y) => y.slug !== a.slug) }))}
                      aria-label={`Remove ${a.label || "avatar"}`}
                      title="Remove this avatar (hooks that got it keep it on their old score)"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-3">
                    <Field label="Person">
                      <Textarea rows={2} className={area} value={a.person} onChange={(e) => setAv(a.slug, { person: e.target.value })} />
                    </Field>
                    <Field label="Pain">
                      <Textarea rows={2} className={area} value={a.pain} onChange={(e) => setAv(a.slug, { pain: e.target.value })} />
                    </Field>
                    <Field label="Promise">
                      <Textarea rows={2} className={area} value={a.promise} onChange={(e) => setAv(a.slug, { promise: e.target.value })} />
                    </Field>
                  </div>
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** "N hooks will be rescored, about $X" + Rescore, shown while the current version's rescore waits for the owner. */
export function RescoreBanner({
  version,
  count,
  waiting,
  usd,
  paused,
  sections,
}: {
  version: number;
  count: number;
  waiting: number;
  usd: number;
  paused: boolean;
  /** "<Lane A> v3 · <Lane B> v2 · <Lane C> v2" (the current version's per section versions). */
  sections: string;
}) {
  const L = useLabels().lane;
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = () =>
    start(async () => {
      const r = await rescoreAction({ resume: paused });
      if (!r.ok) toast.error(r.error);
      else if (r.message) toast.success(r.message);
      router.refresh();
    });
  const cost = `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-brand/40 bg-brand/8 px-4 py-3 text-[13px]" role="status">
      <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden />
      <span>
        <span className="font-medium">v{version} saved.</span>{" "}
        <span className="tabular">
          {count.toLocaleString()} {count === 1 ? "hook" : "hooks"} will be rescored
          {waiting > 0 && ` + ${waiting.toLocaleString()} waiting`}, about {cost}
        </span>{" "}
        <span className="text-muted-foreground">
          of Jev, inside the daily cap.
          {waiting > 0 &&
            ` Scoring is paused, so this click also resumes it: the ${waiting.toLocaleString()} ${waiting === 1 ? "hook" : "hooks"} never scored yet get scored too.`}{" "}
          Until then every hook keeps its older score (labelled with its version).
        </span>{" "}
        <span className="mt-1 block text-muted-foreground">
          <span className="font-medium text-brand-text">This Rescore covers every section</span> ({L.rtm}, {L.fkbpros} and {L.fkb}), even the ones
          whose content did not change ({sections}). To rescore only the section that changed, use its own button on that Hooks tab ({L.rtm}:
          &quot;Rescore {L.rtm} hooks on v{version}&quot;).
        </span>
      </span>
      <Button size="sm" className={cn("ml-auto", PRIMARY_BTN)} disabled={pending || count + waiting === 0} onClick={go}>
        {pending ? <Loader2 className="animate-spin" /> : paused ? <Play /> : <RotateCcw />} {paused ? "Rescore and resume scoring" : "Rescore"}
      </Button>
    </div>
  );
}

/** Lane A notes / who's who (not versioned): view as lines, Edit -> textarea -> Save. */
export function NoteEditor({ noteKey, body, children }: { noteKey: "rtm" | "whos_who"; body: string; children: React.ReactNode }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await saveNoteAction({ key: noteKey, body: text });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.message) toast.success(r.message);
      setEditing(false);
      router.refresh();
    });
  if (!editing) {
    return (
      <div>
        {children}
        <Button
          variant="outline"
          size="xs"
          className="mt-3"
          onClick={() => {
            setText(body);
            setEditing(true);
          }}
        >
          <Pencil /> Edit
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Textarea rows={Math.min(16, Math.max(5, text.split("\n").length + 1))} className="text-[13px] leading-relaxed" value={text} onChange={(e) => setText(e.target.value)} aria-label="Note text, one line per point" />
      <div className="flex items-center gap-2">
        <span className="mr-auto text-[12px] text-muted-foreground">One point per line. Saving flags the hooks scored with the old text (Notes changed); nothing rescores by itself.</span>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" className={PRIMARY_BTN} onClick={save} disabled={pending || text === body}>
          {pending ? <Loader2 className="animate-spin" /> : <Save />} Save
        </Button>
      </div>
    </div>
  );
}
