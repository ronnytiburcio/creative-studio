/**
 * Rubric editing (Phase 4 F1 + F2, slice 3; client safe): the zod schema a new version must pass (used by the server
 * action and mirrored by the Rubric page editor), and the id helpers for new dimensions / avatars.
 *
 * Editable: dimension wording (label, short label, question, the 5 levels, where it applies), adding / removing a
 * dimension, the 9 copy mechanic definitions (ids and labels stay: coverage and old scores use them), avatars (edit, add,
 * remove; section; universal only is Lane B only; a Lane B avatar that is not universal only can also be offered on
 * Lane C hooks, and Lane C can have avatars of its own, since v2). Every combination of section and kind keeps at least one
 * dimension (the overall score needs one; Lane C once the rubric scores Lane C). Saving is always a new version
 * (src/lib/hooks/store.ts saveRubricVersion).
 */
import { z } from "zod";
import { avatarSections, NONE_AVATAR, NONE_MECHANIC, SECTION_KEYS, type RubricContent, type SectionKey } from "./rubric";

/** The neutral lane names (a schema checked before any DB exists: the profile's starter rubric). */
const NEUTRAL_NAMES: Record<SectionKey, string> = { rtm: "Brand", fkbpros: "Clients", fkb: "Company" };

/** Question ids a dimension may not take (they are asked on every hook besides the dimensions). */
export const RESERVED_QUESTION_IDS = ["pp_person", "pp_pain", "pp_promise", "style", "avatar", "stops_scroll"];

export const RUBRIC_NOTE_MAX = 200;

/** "Visual stop power" -> "visual_stop_power"; unique against `taken` (suffix _2, _3 ...). */
export function slugId(label: string, taken: Iterable<string>, max = 40): string {
  const base =
    label
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "d_$1")
      .slice(0, max - 3) || "item";
  const used = new Set(taken);
  if (!used.has(base) && !RESERVED_QUESTION_IDS.includes(base) && base !== NONE_AVATAR) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

const DimensionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  label: text(2, 40),
  short: text(2, 12),
  question: text(10, 500),
  appliesTo: z.object({
    kinds: z.array(z.enum(["text", "video"])).min(1).max(2),
    sections: z.array(z.enum(["rtm", "fkbpros", "fkb"])).min(1).max(3),
  }),
  levels: z.array(text(3, 300)).length(5),
});

const MechanicSchema = z.object({
  id: z.string().regex(/^[a-z_]{2,40}$/),
  label: text(2, 40),
  definition: text(5, 300),
});

const AvatarSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_]{2,60}$/),
  label: text(2, 50),
  section: z.enum(["rtm", "fkbpros", "fkb"]),
  sections: z.array(z.enum(["rtm", "fkbpros", "fkb"])).max(3).optional(),
  stage: z.enum(["ps", "obj"]).nullable(),
  person: text(3, 300),
  pain: text(3, 300),
  promise: text(3, 400),
  universalOnly: z.boolean(),
});

/**
 * A whole rubric version as the editor sends it. `baseMechanics` = the current version's (ids + labels are fixed).
 * `requireFkb` (the current version scores Lane C): Lane C text and video keep a dimension and Lane C keeps an avatar.
 */
export function rubricContentSchema(baseMechanics: { id: string; label: string }[], requireFkb = false, names: Record<SectionKey, string> = NEUTRAL_NAMES) {
  const [A, B, C] = [names.rtm, names.fkbpros, names.fkb];
  return z
    .object({
      dimensions: z.array(DimensionSchema).min(1).max(12),
      mechanics: z.array(MechanicSchema),
      avatars: z.array(AvatarSchema).min(2).max(60),
    })
    .superRefine((c, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: "custom", message });
      const dimIds = c.dimensions.map((d) => d.id);
      if (new Set(dimIds).size !== dimIds.length) issue("Two dimensions have the same id.");
      for (const id of dimIds) if (RESERVED_QUESTION_IDS.includes(id)) issue(`"${id}" is reserved; rename the dimension.`);
      const scored: SectionKey[] = requireFkb ? ["rtm", "fkbpros", "fkb"] : ["rtm", "fkbpros"];
      for (const section of scored) {
        for (const kind of ["text", "video"] as const) {
          if (!c.dimensions.some((d) => d.appliesTo.sections.includes(section) && d.appliesTo.kinds.includes(kind))) {
            issue(`${names[section]} ${kind} hooks need at least one dimension.`);
          }
        }
      }
      const same =
        c.mechanics.length === baseMechanics.length && c.mechanics.every((m, i) => m.id === baseMechanics[i].id && m.label === baseMechanics[i].label);
      if (!same) issue("The copy mechanics keep their names and order; only the definitions can change.");
      if (!c.mechanics.some((m) => m.id === NONE_MECHANIC)) issue('The "None" mechanic must stay.');
      const slugs = c.avatars.map((a) => a.slug);
      if (new Set(slugs).size !== slugs.length) issue("Two avatars have the same id.");
      if (slugs.includes(NONE_AVATAR)) issue('"none" is reserved.');
      for (const a of c.avatars) {
        const secs = avatarSections(a);
        if (a.section === "rtm" && (a.universalOnly || a.stage)) issue(`${a.label}: ${A} avatars have no stage and are never universal only.`);
        if (a.section !== "rtm" && !a.stage) issue(`${a.label}: pick problem / solution or objection.`);
        if (a.section === "fkb" && a.universalOnly) issue(`${a.label}: only ${B} avatars can be universal only.`);
        if (!secs.includes(a.section)) issue(`${a.label}: offered in its own section first.`);
        if (a.section === "rtm" ? secs.length > 1 : secs.includes("rtm")) issue(`${a.label}: ${A} avatars stay ${A} only.`);
        if (a.universalOnly && secs.includes("fkb")) issue(`${a.label}: a universal only avatar is for shared ${B} hooks, never ${C}.`);
      }
      if (!c.avatars.some((a) => a.section === "rtm")) issue(`${A} needs at least one avatar.`);
      if (!c.avatars.some((a) => a.section === "fkbpros" && !a.universalOnly)) issue(`${B} needs at least one avatar a client hook can get.`);
      if (requireFkb && !c.avatars.some((a) => avatarSections(a).includes("fkb"))) issue(`${C} needs at least one avatar.`);
    });
}

/** The content with a fixed key order and trimmed text (what is stored and compared). */
export function canonicalRubric(r: RubricContent): RubricContent {
  return {
    dimensions: r.dimensions.map((d) => ({
      id: d.id,
      label: d.label.trim(),
      short: d.short.trim(),
      question: d.question.trim(),
      appliesTo: {
        kinds: (["text", "video"] as const).filter((k) => d.appliesTo.kinds.includes(k)),
        sections: SECTION_KEYS.filter((s) => d.appliesTo.sections.includes(s)),
      },
      levels: d.levels.map((l) => l.trim()),
    })),
    mechanics: r.mechanics.map((m) => ({ id: m.id, label: m.label.trim(), definition: m.definition.trim() })),
    avatars: r.avatars.map((a) => {
      const universalOnly = a.section === "fkbpros" && a.universalOnly;
      // `sections` only when it says more than the avatar's own section (v1 content stays byte for byte the same).
      const extra = a.section === "rtm" || universalOnly ? [] : avatarSections(a).filter((x) => x !== a.section && x !== "rtm");
      const sections = extra.length ? SECTION_KEYS.filter((x) => x === a.section || extra.includes(x)) : undefined;
      return {
        slug: a.slug,
        label: a.label.trim(),
        section: a.section,
        ...(sections ? { sections } : {}),
        stage: a.section === "rtm" ? null : a.stage,
        person: a.person.trim(),
        pain: a.pain.trim(),
        promise: a.promise.trim(),
        universalOnly,
      };
    }),
  };
}

/** Same content (order included)? Saving an unchanged rubric is refused. */
export function sameRubric(a: RubricContent, b: RubricContent): boolean {
  return JSON.stringify(canonicalRubric(a)) === JSON.stringify(canonicalRubric(b));
}
