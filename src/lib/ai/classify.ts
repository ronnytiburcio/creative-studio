/**
 * Classify: what Jev is asked about one asset, and how its answers become Studio fields (pure functions, no I/O;
 * the worker's ClassifyQueue loads the inputs and writes the result, the smoke test drives these directly).
 *
 * One call per asset with speculative fan-out: the class-dependent questions (visual format for images, the Three P's
 * for images and videos) are asked in the same call and dropped in code when the class does not call for them (kept
 * with `dropped`, so a manual class change can restore them without another call). Measured on the slice 2 real run:
 * ~2,700 input tokens per call, of which the state is ~240 and the fan-out questions ~490. A second call after the
 * class is known (only for ads, ~1 in 4 files) would save ~12% of tokens (about $0.02 over the whole library) at the
 * cost of two requests, two ai_calls rows and a half-classified state between them; one call was kept.
 *
 * State (small and relevant, per TypeSafe's jev-1.13 guidance): the file facts computed in code (name, folder, section,
 * kind, orientation words, a duration bucket), the description, the spoken opening, the folder/manual client tags, the
 * generation prompt for Studio Generated files, and (only when client questions are asked) the owner's recent client
 * corrections. Category corrections ride inside the asset_class question instead, so they cost nothing elsewhere.
 *
 * Client questions are asked only while nobody has decided the clients: no folder or manual tag and no client decision
 * by the owner (assets.clients_decided_at: a Review confirm or a drawer chip edit, "shared" included). A decided asset is
 * like a tagged one: nothing asked, nothing applied, never unsure.
 */
import {
  AD_CLASSES,
  CLIENT_YES,
  ENERGY_LEVELS,
  NOUL_IDS,
  UNIVERSAL_ID,
  VISUAL_FORMATS,
  answerUnsure,
  appliesTo,
  categoriesFor,
  clientQuestionId,
  isCategory,
  isNoulUnsure,
  type CategoryId,
  type Kind,
  type StoredAnswer,
  OWNER_SOURCE,
} from "./classes";
import type { JevAnswer, JevQuestion } from "./jev";
import { folderOf } from "../media";
import { profile } from "../profile";

export type ClassifyInput = {
  id: number;
  kind: Kind;
  /** fkb = Lane C, the company lane (Phase 5 slice 2): a single channel, never asked about clients. */
  section: "rtm" | "fkbpros" | "fkb";
  filename: string;
  relPath: string;
  rootLabel: string;
  orientation: string | null;
  durationS: number | null;
  description: string;
  /** null = never checked; "" = no speech. */
  spokenOpen: string | null;
  generationPrompt: string | null;
  /** Folder and manual client tags (names). Jev rows are not listed: they are what is being re-decided. */
  fixedClients: string[];
  /** The owner decided the clients (assets.clients_decided_at): the manual rows, or shared when there are none. */
  clientsDecided?: boolean;
  /** The owner's class (class_source = manual): not asked again, and it decides the class-dependent questions. */
  manualClass: CategoryId | null;
};

export type ClientInfo = { code: string; name: string; hint: string };

export type CorrectionExample =
  | { question: "asset_class"; file: string; folder: string; description: string; category: string }
  | { question: "clients"; file: string; folder: string; description: string; clients: string[] };

/** Ask the client questions? Lane B assets with no folder or manual client tag and no decision by the owner (Lane A and Lane C never). */
export function asksClients(input: Pick<ClassifyInput, "section" | "fixedClients" | "clientsDecided">): boolean {
  return input.section === "fkbpros" && input.fixedClients.length === 0 && !input.clientsDecided;
}

export function durationBucket(s: number | null): string | null {
  if (s == null || !Number.isFinite(s)) return null;
  if (s < 10) return "under 10 seconds";
  if (s < 30) return "10 to 30 seconds";
  if (s < 90) return "30 to 90 seconds";
  return "over 90 seconds";
}

export function orientationWords(o: string | null): string | null {
  switch (o) {
    case "9:16":
      return "vertical 9:16";
    case "4:5":
      return "vertical 4:5";
    case "1:1":
      return "square 1:1";
    case "16:9":
      return "horizontal 16:9";
    case "other":
      return "other shape";
    default:
      return null;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * `file.section` as Jev reads it: the business profile's lane text (`profile.classify.sections`, slice 1c). An install
 * keeps its exact wording in its profile (the files already classified saw it), so CLASSIFY_VERSION stays.
 */
export function sectionStateText(section: ClassifyInput["section"]): string {
  return profile().classify.sections[section];
}

/** A category's description as Jev reads it: the profile's override, else the neutral built-in (classes.ts). */
export function categoryDescription(c: { id: string; description: string }): string {
  return profile().classify.categories[c.id] ?? c.description;
}

/** A visual format's description as Jev reads it: the profile's override, else the neutral built-in. */
export function visualFormatDescription(f: { id: string; description: string }): string {
  return profile().classify.visualFormats[f.id] ?? f.description;
}

export function buildState(input: ClassifyInput, clientExamples: CorrectionExample[] = []): Record<string, unknown> {
  const file: Record<string, string> = {
    name: input.filename,
    folder: folderOf(input.relPath, input.rootLabel),
    section: sectionStateText(input.section),
    kind: input.kind,
  };
  const orientation = orientationWords(input.orientation);
  if (orientation) file.shape = orientation;
  const length = input.kind === "video" ? durationBucket(input.durationS) : null;
  if (length) file.length = length;
  const state: Record<string, unknown> = { file, description: clip(input.description, 2500) };
  if (input.kind === "video" && input.spokenOpen != null) {
    state.spoken_opening = input.spokenOpen ? clip(input.spokenOpen, 800) : "none (no speech in the first 15 seconds)";
  }
  if (input.fixedClients.length) state.client_tags = input.fixedClients;
  if (input.generationPrompt) state.generation_prompt = clip(input.generationPrompt, 600);
  const examples = clientExamples.filter((e) => e.question === "clients");
  if (asksClients(input) && examples.length) {
    state[profile().classify.clientTagsKey] = examples.map((e) => ({
      file: e.file,
      folder: e.folder,
      description: clip(e.description, 160),
      clients: e.question === "clients" ? e.clients : [],
    }));
  }
  return state;
}

const noul = (instructions: JevQuestion["instructions"], yes: string, no: string): JevQuestion => ({
  type: "noul",
  instructions,
  criteria: { true: yes, false: no },
});

/**
 * The questions for one asset. `examples`: the owner's recent category corrections (they ride inside asset_class only).
 * Class-dependent questions are asked speculatively (see the file header) unless the owner's class already rules them out.
 */
export function buildQuestions(
  input: ClassifyInput,
  clients: ClientInfo[],
  examples: CorrectionExample[] = [],
): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {};
  const words = input.kind === "video" ? "`description`, `spoken_opening`" : "`description`";
  const P = profile().classify;

  if (!input.manualClass) {
    const categoryExamples = examples.filter((e) => e.question === "asset_class");
    const question = `Which one category best fits this media file? Decide from ${words}, \`file.name\`, \`file.folder\` and \`file.kind\`.`;
    q.asset_class = {
      type: "choice",
      instructions: categoryExamples.length
        ? {
            question: `${question} ${P.correctionsLine}`,
            [P.correctionsKey]: categoryExamples.map((e) => ({
              file: e.file,
              folder: e.folder,
              description: clip(e.description, 160),
              category: e.question === "asset_class" ? e.category : "",
            })),
          }
        : question,
      criteria: Object.fromEntries(categoriesFor(input.kind).map((c) => [c.id, categoryDescription(c)])),
    };
  }

  if (asksClients(input)) {
    for (const c of clients) {
      q[clientQuestionId(c.code)] = noul(
        { question: P.client.question, [P.client.key]: { code: c.code, who: c.hint } },
        P.client.yes,
        P.client.no,
      );
    }
    q[UNIVERSAL_ID] = noul(P.universal.question, P.universal.yes, P.universal.no);
  }

  q.energy = {
    type: "score",
    instructions: `How much energy does this file have? Judge the pace, movement, text and tone in ${words}.`,
    criteria: [...ENERGY_LEVELS],
  };

  if (input.kind === "video") {
    q.hookable = noul(
      "In the first 3 seconds (the 'First 3 seconds' line of `description` and the first sentence of `spoken_opening`), does something happen or get said that grabs attention right away?",
      "Yes: a striking reveal or transformation, a bold claim, a direct question or call-out to the viewer, or a surprising statement in the first 3 seconds.",
      "No: the first 3 seconds are a plain shot, a slow pan, a greeting or introduction, a logo, or nothing happens.",
    );
  }

  q.brand_safe = noul(
    `Is this file safe to post as is? Judge from ${words}.`,
    P.brandSafe.yes,
    P.brandSafe.no,
  );

  const cls = input.manualClass;
  if (input.kind === "image" && (!cls || cls === "static_ad")) {
    q.visual_format = {
      type: "choice",
      instructions: "If this image is a static ad, which layout does it use? Judge from `description`.",
      criteria: Object.fromEntries(VISUAL_FORMATS.map((f) => [f.id, visualFormatDescription(f)])),
    };
  }
  if (!cls || AD_CLASSES.includes(cls)) {
    q.pp_person = noul(
      `Do the words in this ad (on-screen text in ${words}) clearly say who the ad is for?`,
      P.pp.person.yes,
      P.pp.person.no,
    );
    q.pp_pain = noul(
      `Do the words in this ad (on-screen text in ${words}) clearly state the viewer's problem?`,
      P.pp.pain.yes,
      P.pp.pain.no,
    );
    q.pp_promise = noul(
      `Do the words in this ad (on-screen text in ${words}) clearly state the one outcome the ad promises?`,
      P.pp.promise.yes,
      P.pp.promise.no,
    );
  }
  return q;
}

export type Evaluation = {
  /** Answers kept (class-dependent ones dropped when the class does not call for them), prior OWNER_SOURCE answers kept. */
  answers: Record<string, StoredAnswer>;
  /** Question ids that are unsure; the client nouls count as one group, "clients". */
  unsure: string[];
  /** Jev's class (null when the owner's class stands). */
  jevClass: CategoryId | null;
  classConfidence: number | null;
  /** 1..5. */
  energy: number | null;
  /** Client codes to apply as jev rows; [] = shared; null = client questions not asked. Empty when the group is unsure. */
  applyClients: string[] | null;
  /** Clients Jev leans to (>= 0.75), for Review's proposal and corrections. */
  proposedClients: string[];
  universal: number | null;
};

function isSharedSet(codes: string[]): boolean {
  const s = [...codes].sort().join(",");
  return profile().classify.sharedClientSets.some((set) => [...set].sort().join(",") === s);
}

/**
 * The confidence gate (threshold from Settings, default 0.7):
 * - choice / score: confidence < threshold = unsure;
 * - noul: P(yes) in [0.25, 0.75] = unsure;
 * - clients (one group): unsure when any client or the universal noul is in that band, when nobody is >= 0.75
 *   (no client and not universal), when a client and universal are both >= 0.75, or when two or more clients are
 *   >= 0.75 and they are not a known shared set (two clients of the same business).
 * Answers the owner already confirmed (prior source OWNER_SOURCE) are kept as they are and never unsure; so is the owner's client
 * decision (see asksClients).
 */
export function evaluate(
  full: Record<string, JevAnswer>,
  ctx: { input: ClassifyInput; clientCodes: string[]; threshold: number; prior?: Record<string, StoredAnswer> | null },
): Evaluation {
  const { input, threshold } = ctx;
  const prior = ctx.prior ?? {};
  const answers: Record<string, StoredAnswer> = {};
  const unsure: string[] = [];
  const fromJev = (a: JevAnswer): StoredAnswer => ({ ...a, source: "jev" });

  const jevClass = full.asset_class && isCategory(full.asset_class.value) ? (full.asset_class.value as CategoryId) : null;
  const gatingClass = input.manualClass ?? jevClass;
  if (input.manualClass) {
    const p = prior.asset_class;
    answers.asset_class = p?.source === OWNER_SOURCE ? p : { type: "choice", value: input.manualClass, probabilities: {}, confidence: null, source: OWNER_SOURCE };
  } else if (full.asset_class) {
    answers.asset_class = fromJev(full.asset_class);
    if ((full.asset_class.confidence ?? 0) < threshold) unsure.push("asset_class");
  }

  // Every answer is stored; class-dependent ones the class does not call for are flagged `dropped` (not shown, never
  // unsure) so a later manual class change can bring them back without another Jev call.
  for (const id of ["energy", ...NOUL_IDS, "visual_format"]) {
    const a = full[id];
    if (!a) continue;
    const applies = appliesTo(id, gatingClass, input.kind);
    const kept: StoredAnswer = prior[id]?.source === OWNER_SOURCE ? prior[id] : fromJev(a);
    answers[id] = applies ? { ...kept, dropped: undefined } : { ...kept, dropped: true };
    if (applies && answerUnsure(kept, threshold)) unsure.push(id);
  }

  let applyClients: string[] | null = null;
  let proposedClients: string[] = [];
  let universal: number | null = null;
  // Tagged or decided by the owner: the client group is not Jev's to answer (nothing stored, applied or unsure).
  if (asksClients(input) && full[UNIVERSAL_ID]) {
    const ps = ctx.clientCodes.map((code) => ({ code, p: Number(full[clientQuestionId(code)]?.value ?? 0) }));
    universal = Number(full[UNIVERSAL_ID].value);
    for (const code of ctx.clientCodes) {
      const a = full[clientQuestionId(code)];
      if (a) answers[clientQuestionId(code)] = fromJev(a);
    }
    answers[UNIVERSAL_ID] = fromJev(full[UNIVERSAL_ID]);
    proposedClients = ps.filter((x) => x.p >= CLIENT_YES).map((x) => x.code);
    const universalYes = universal >= CLIENT_YES;
    const groupUnsure =
      ps.some((x) => isNoulUnsure(x.p)) ||
      isNoulUnsure(universal) ||
      (proposedClients.length === 0 && !universalYes) ||
      (proposedClients.length > 0 && universalYes) ||
      (proposedClients.length > 1 && !isSharedSet(proposedClients));
    if (groupUnsure) unsure.push("clients");
    applyClients = groupUnsure ? [] : proposedClients;
  }

  const energyAnswer = answers.energy;
  // Stored answers keep Jev's 0-based level (also for the owner's), the asset column holds 1..5.
  const energy = energyAnswer ? Math.round((Number(energyAnswer.value) + 1) * 10) / 10 : null;
  return {
    answers,
    unsure,
    jevClass: input.manualClass ? null : jevClass,
    classConfidence: input.manualClass ? null : (full.asset_class?.confidence ?? null),
    energy,
    applyClients,
    proposedClients,
    universal,
  };
}
