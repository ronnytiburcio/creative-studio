/**
 * Classify vocabulary (client safe: no node imports). The 18 categories (DECISIONS "Phase 3 grilling"), the 7 static
 * ad formats (+ not an ad, from ~/.claude/skills/static-ads/references/formats.md), the 5 energy levels, the question
 * labels the UI shows, and the confidence gate constants. Wording here is what Jev reads: bump CLASSIFY_VERSION on any
 * change to a question, an option description or the state shape, and every classified asset becomes due again.
 *
 * Creative Studio slice 1c: the descriptions below are the NEUTRAL built-ins. A business profile may override any of
 * them (`profile.classify.categories` / `visualFormats`, read by classify.ts on the server; the UI gets them through
 * `profileUi`). An install's profile that keeps its texts byte for byte needs no version bump.
 */

/**
 * v2 (slice 2 real run, 2026-09-29): client nouls ask whether the file NAMES or clearly points to the client business (a
 * generic job photo is a no) and carry the client code; hookable is literal about the first 3 seconds; sharper
 * boundaries for episode / vsl, reference / thumbnail, brand_asset (banners, headshots) and screen_demo / static_ad.
 */
export const CLASSIFY_VERSION = 2;

export type Kind = "image" | "video";

export const CATEGORIES = [
  { id: "job_photo", label: "Job photo", kinds: ["image"], description: "A real photo of the work, a product, a place or a job site (finished, in progress or before) with no ad headline or offer text on it." },
  { id: "before_after", label: "Before / after", kinds: ["image", "video"], description: "Shows the same room before and after the work: side by side, stacked, a slider, or a before scene followed by an after scene." },
  { id: "static_ad", label: "Static ad", kinds: ["image"], description: "A single image made to run as an ad: a photo or graphic with a headline, offer, benefits or call-to-action text on it. Not a YouTube thumbnail, not a profile banner, not a screenshot of a website or app." },
  { id: "video_ad", label: "Video ad", kinds: ["video"], description: "A finished, edited ad video: burned-in captions or on-screen text plus a call to action or a branded end card, usually 15 to 90 seconds." },
  { id: "hook_clip", label: "Hook clip", kinds: ["video"], description: "A short standalone opening clip made to lead an ad: one attention-grabbing moment or line, usually under 8 seconds, not in the Intro or Outro folders." },
  { id: "intro_outro", label: "Intro / outro", kinds: ["video"], description: "A clip from a filmed Intro or Outro library (a presenter saying one opening or closing line; files in the Intro, Outro or Outtro folders), or a branded end card." },
  { id: "talking_head", label: "Talking head", kinds: ["video"], description: "Raw footage of one person talking to the camera, not a finished ad: no end card and few or no captions." },
  { id: "testimonial", label: "Testimonial", kinds: ["image", "video"], description: "A customer telling their experience with a business, or a customer review shown as the main content." },
  { id: "broll", label: "B-roll", kinds: ["video"], description: "Supporting footage with nobody talking to the camera: room pans, close-ups, work in progress or job site footage, used as cutaways." },
  { id: "vsl", label: "VSL", kinds: ["video"], description: "A sales video for one offer or one landing page: a presenter walking through the offer, usually 1 to 10 minutes. Not a numbered YouTube episode." },
  { id: "episode", label: "Episode", kinds: ["video"], description: "A full long-form YouTube episode or podcast recording, many minutes long, usually a presenter teaching with slides; file names like 'Ep. 7' or 'Episode'." },
  { id: "short", label: "Short", kinds: ["video"], description: "A finished vertical short video for organic social (YouTube Shorts, Reels) that is not a paid ad and has no ad call to action." },
  { id: "thumbnail", label: "Thumbnail", kinds: ["image"], description: "Your own YouTube thumbnail or episode slide: a bold horizontal graphic with a face and a few huge words, made to be clicked. Not one saved from another creator as inspiration." },
  { id: "ai_render", label: "AI render", kinds: ["image", "video"], description: "An AI generated or 3D rendered room or design (image or clip), not a real photo, with no ad text on it." },
  { id: "screen_demo", label: "Screen demo", kinds: ["image", "video"], description: "A screen recording, or a screenshot of a website, web page, app, dashboard, form or document, even when the page shows headlines and buttons; file names with 'site', 'screenshot' or 'Screen Shot' are often this." },
  { id: "brand_asset", label: "Brand asset", kinds: ["image", "video"], description: "A logo, brand mark, icon, color palette, font sample, social profile banner or cover image, profile headshot or other brand identity file, or a logo animation; file names with 'logo', 'banner', 'cover' or 'profile' are often this." },
  { id: "reference", label: "Reference", kinds: ["image", "video"], description: "Inspiration saved from someone else: another brand's ad, another creator's thumbnail or a screenshot of their work. Files in a folder named 'inspo', 'inspiration' or 'Creative References' are this." },
  { id: "other", label: "Other", kinds: ["image", "video"], description: "Nothing above fits." },
] as const satisfies readonly { id: string; label: string; kinds: readonly Kind[]; description: string }[];

export type CategoryId = (typeof CATEGORIES)[number]["id"];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as CategoryId[];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<CategoryId, string>;
export const isCategory = (v: unknown): v is CategoryId => typeof v === "string" && (CATEGORY_IDS as string[]).includes(v);

/** Categories Jev may pick for this kind (code narrows the options; an image is never a video ad). */
export function categoriesFor(kind: Kind) {
  return CATEGORIES.filter((c) => (c.kinds as readonly Kind[]).includes(kind));
}

export const VISUAL_FORMATS = [
  { id: "educational_infographic", label: "Educational infographic", description: "Teaches something useful (a guide, checklist, cost table or steps) in 3 to 6 rows or steps; looks like content, not an ad." },
  { id: "headliner", label: "Headliner", description: "One big headline takes most of the image, with one supporting picture and at most one short line of support." },
  { id: "benefits_callout", label: "Benefits callout", description: "A room or product in the middle with 3 or 4 short callouts pointing at it and a headline on top." },
  { id: "comparison", label: "Comparison (us vs them)", description: "Two columns or sides comparing two options, with checks and crosses or pros and cons." },
  { id: "transformation", label: "Transformation", description: "A before and an after of the same room, split or stacked, with ad text." },
  { id: "grid", label: "Grid", description: "4 to 9 tiles of finished jobs, rooms, products or services." },
  { id: "text_only", label: "Text only", description: "The words are the whole ad (a letter, a note, a statement on a plain background) with no main photo." },
  { id: "not_an_ad", label: "Not an ad", description: "No headline, offer or call to action: a plain photo, graphic or render." },
] as const;

export type VisualFormatId = (typeof VISUAL_FORMATS)[number]["id"];
export const VISUAL_FORMAT_IDS = VISUAL_FORMATS.map((f) => f.id) as VisualFormatId[];
export const VISUAL_FORMAT_LABEL = Object.fromEntries(VISUAL_FORMATS.map((f) => [f.id, f.label])) as Record<VisualFormatId, string>;

/** Energy rubric: 5 described levels (Jev's score is 0-based; shown 1 to 5). */
export const ENERGY_LEVELS = [
  "Calm and still: a quiet photo, a plain graphic or a still scene; nothing moving, no urgency.",
  "Low: gentle and slow, like a slow pan or a calm room shot, a soft tone and little text.",
  "Medium: steady and clear, like a normal talking head, a tidy ad or a before and after with some text.",
  "High: bold and punchy: fast cuts, big bold text, excited speech or a strong reveal.",
  "Very high: intense: rapid cuts, shouting or hype, loud bold text everywhere.",
] as const;
export const ENERGY_LABEL = ["Calm", "Low", "Medium", "High", "Very high"] as const;

/** 1..5 display value (one decimal) -> nearest level label. */
export function energyLabel(energy: number): string {
  return ENERGY_LABEL[Math.max(0, Math.min(4, Math.round(energy) - 1))];
}

/** Library Energy filter buckets over the stored 1..5 value. */
export const ENERGY_BUCKETS = {
  low: { label: "1 to 2 (calm, low)", min: 0, max: 2.5 },
  mid: { label: "3 (medium)", min: 2.5, max: 3.5 },
  high: { label: "4 to 5 (high)", min: 3.5, max: 99 },
} as const;
export type EnergyBucket = keyof typeof ENERGY_BUCKETS;
export const ENERGY_BUCKET_IDS = Object.keys(ENERGY_BUCKETS) as EnergyBucket[];

export const AD_CLASSES: CategoryId[] = ["static_ad", "video_ad"];

export const NOUL_IDS = ["hookable", "brand_safe", "pp_person", "pp_pain", "pp_promise"] as const;
export type NoulId = (typeof NOUL_IDS)[number];

/** Human labels for question ids (Review queue, drawer, sample docs). */
export const QUESTION_LABEL: Record<string, string> = {
  asset_class: "Category",
  clients: "Clients",
  energy: "Energy",
  hookable: "Could be a hook",
  brand_safe: "Brand safe",
  visual_format: "Visual format",
  pp_person: "Person clear",
  pp_pain: "Pain clear",
  pp_promise: "Promise clear",
};

/** Noul answers inside [low, high] are unsure (DECISIONS "Phase 3 grilling"). */
export const NOUL_UNSURE = { low: 0.25, high: 0.75 } as const;
/** A client (or "universal") noul at or above this is a confident yes. */
export const CLIENT_YES = 0.75;

export const THRESHOLD_DEFAULT = 0.7;
export const THRESHOLD_MIN = 0.3;
export const THRESHOLD_MAX = 0.95;

/**
 * The `source` of an answer the owner gave (confirmed or set in Review / the drawer), and the `model` of the
 * classifications row such an answer creates. A value stored in every DB since Phase 3 slice 2 and read back by every
 * classify: never rename it (renaming stored values is a migration, not a wording change).
 */
export const OWNER_SOURCE = "ronny" as const;

/**
 * One stored answer (classifications.answers[id]). source OWNER_SOURCE = confirmed or set in Review / the drawer.
 * dropped = a speculative class-dependent answer the current class does not call for (kept so a class change can
 * bring it back without asking Jev again; never shown, never unsure).
 */
export type StoredAnswer = {
  type: "choice" | "score" | "noul";
  value: string | number;
  probabilities: Record<string, number>;
  confidence: number | null;
  source?: "jev" | typeof OWNER_SOURCE;
  dropped?: boolean;
};

/** Does this question apply to an asset of this kind + class? visual_format: static ads; the Three P's: ads. */
export function appliesTo(id: string, cls: string | null, kind: string): boolean {
  if (id === "visual_format") return kind === "image" && cls === "static_ad";
  if (id.startsWith("pp_")) return cls != null && (AD_CLASSES as string[]).includes(cls);
  if (id === "hookable") return kind === "video";
  return true;
}

/** Is a (non-client) answer unsure under this threshold? */
export function answerUnsure(a: Pick<StoredAnswer, "type" | "value" | "confidence" | "source">, threshold: number): boolean {
  if (a.source === OWNER_SOURCE) return false;
  return a.type === "noul" ? isNoulUnsure(Number(a.value)) : (a.confidence ?? 0) < threshold;
}

export const clientQuestionId = (code: string) => `client_${code}`;
export const UNIVERSAL_ID = "client_universal";

export function isNoulUnsure(p: number): boolean {
  return p >= NOUL_UNSURE.low && p <= NOUL_UNSURE.high;
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;

/**
 * Answers whose "unsure" sends a file to the Review queue (the owner, 2026-09-30: where it goes and whether it is safe).
 * The soft answers (energy, hookable, visual format, Three P's) still show "unsure" in the drawer and in Review,
 * but do not queue a file on their own.
 */
export const REVIEW_TRIGGERS: readonly string[] = ["asset_class", "clients", "brand_safe"];

/** needs_review for an unsure list. */
export function needsReview(unsure: readonly string[]): boolean {
  return unsure.some((id) => REVIEW_TRIGGERS.includes(id));
}
