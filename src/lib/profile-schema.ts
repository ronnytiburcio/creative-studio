/**
 * The business profile's schema (client safe: zod only, no node imports, no state). The business profile (Creative Studio slice 1c): `profile` in the Studio config file (src/lib/studio-config.ts). It
 * holds every piece of business wording the code used to carry as constants: what Jev reads (classify categories,
 * lane texts, the hook scoring state's wording and examples, the legacy section briefs), what the describe model reads
 * (the opening line of each prompt), what `claude -p` reads (the voice and rule lines of the variants, moments and ad
 * copy prompts), the house copy rules (dashes, US state names, client names, per channel bans, the emoji palette), the
 * naming conventions (ad names, the campaign name scan, the media name prefix, the transcript proper noun fixes) and
 * what a FRESH seed writes (the starter rubric, notes, who's who, brand notes).
 *
 * Every key is optional. A missing key = the neutral built-in text (src/lib/profile-defaults.ts, the ONE place it
 * lives). Objects merge key by key; strings, lists and `rubric` replace whole. Unknown keys are refused (strict), so a
 * typo never loads silently. Errors name the path (`profile.classify.sections.rtm: ...`), never a value.
 *
 * Field by field (all optional):
 *   owner              { name, display }   the person who files, steers and approves ("set by <name>"); display = the
 *                                           sidebar's user tile. Neutral: none ("set by you").
 *   lanes.<lane>       { fullName, sub, about, mark }   a lane's long name (Jev / claude read it where a lane is named in
 *                                           full), the sidebar sub label, the channel header's one line about it and
 *                                           its 1 to 3 letter mark. <lane> = rtm | fkbpros | fkb (Lane A, B, C).
 *   describe           { image, video }    the first line of the image / video describe prompts.
 *   classify.categories       { <category id>: description }   override a category's description (classes.ts ids).
 *   classify.visualFormats    { <format id>: description }     override a static ad format's description.
 *   classify.sections         { rtm, fkbpros, fkb }            `file.section` as Jev reads it.
 *   classify.correctionsKey / correctionsLine / clientTagsKey  the corrections state key + the asset_class note, the
 *                                           client corrections state key.
 *   classify.client    { key, question, yes, no }   the per client question (key = the instructions' object key).
 *   classify.universal { question, yes, no }        the "generic, no one client" question.
 *   classify.sharedLabel                    the label of a correction that made a file shared.
 *   classify.sharedClientSets [[codes]]     client sets one file may be tagged to together (not "unsure").
 *   classify.brandSafe { yes, no }          the brand safe criteria.
 *   classify.pp.<person|pain|promise> { yes, no }   the Three P's criteria for classify.
 *   hooks.sections     { rtm, fkbpros, fkb }   `channel.section` in the hook scoring state.
 *   hooks.clientKey                         `channel.<key>` = {name, who} for a client hook.
 *   hooks.sharedScope                       `channel.scope` for a shared Lane B hook.
 *   hooks.pp.<person|pain|promise> { yes, no }   the Three P's criteria for hooks.
 *   hooks.legacyBriefs { rtm, fkbpros, fkb }   `channel.brief` for a rubric version without its own briefs.
 *   rubric             { dimensions, mechanics, avatars, briefs, note }   the ONE rubric version a fresh DB is seeded
 *                                           with (validated like a Rubric page save). Never read on a DB that has one.
 *   seed               { rtmNotes, whosWho, companyNotes, companyHint, brandNotes { <client code>: text } }   the draft
 *                                           notes a fresh seed writes ("Draft, check me" until saved).
 *   variants           { channels {rtm, fkb, client, shared}, whoClient, whoCompany, notesHeadings {client, fkb, rtm},
 *                        videoLine, steerHeading, rules {rtm[], fkbpros[], fkb[]} }   the hook variants prompt.
 *   moments            { system, task, episodeAbout, layoutLine, copyRules[] }   the Shorts moments prompt; `{layouts}`
 *                                           = the layout list, a `{ai_tells}` item = the generated AI tells line.
 *   adCopy             { channels {fkb, client}, whoClient, whoCompany, notesHeadings {client, fkb}, runningHeading,
 *                        filledHeading, p1Line, formatLines[], conceptLine, voice {fkb, client}, houseRules[],
 *                        emojiPalette[], landing {client, company} }   the "Draft the rest" prompt, the primary emoji
 *                                           palette and the landing pages (`{code}` = the client code).
 *   copyRules          { dashes {rtm, fkbpros, fkb, prose, ads}: none | punctuation | allowed, stateNames {lane: bool},
 *                        banClientNames {lane: bool}, bans {<code>: [price | financing]}, messages {...} }
 *   ads                { clientPrefix, companyPrefix, mediaPrefix, campaignWord, conceptExample }   ad name patterns,
 *                                           Lane C media name matching, the campaign name scan, the dialog's example.
 *   generated          { rtm, fkbpros, fkb }   the folder per lane under `<drive>/Studio Generated/` (Generate writes there;
 *                                           seeded as roots / tag rules on a fresh DB; never rename on a live install).
 *   transcripts        { properNounFixes [{from [words], to}] }   whisper's known misses, fixed word by word.
 *   pages              { broadGroup, proofExample }   the two audience / proof examples in the page rubric.
 *   skills             { reelCut, reelKit, explainer, episodePrep, adApplyClients, adApplyCompany }   the outside skills
 *                                           named in hand-offs, paste lines and help text (reelKit = a kit.json's `kit`).
 *   episodes           { prefix, kitLabel }   Lane A episode file names (`<prefix>N.srt`, `<prefix>N reels.json`,
 *                                           `<prefix>N Reel K vN.mp4`) and the reel kit format's label.
 *
 * Resolving (`resolveProfile`) is pure and lives here too. The ACTIVE profile (`profile()`, server only) is
 * src/lib/profile.ts; client safe helpers and types are src/lib/profile-shared.ts.
 */
import { z } from "zod";
import { rubricContentSchema } from "./hooks/rubric-edit";
import { DASH_POLICIES, NEUTRAL_PROFILE, type DashPolicy, type ResolvedProfile } from "./profile-defaults";

/** One line of text: no newline, carriage return or NUL (shared by the config, the profile and Settings forms). */
export const ONE_LINE_RE = /^[^\n\r\0]*$/;

const str = (max = 4_000) => z.string().max(max, `at most ${max} characters`);
const line = (max = 1_000) => z.string().max(max, `at most ${max} characters`).regex(ONE_LINE_RE, "one line");
const lanes3 = <T extends z.ZodTypeAny>(t: T) => z.object({ rtm: t.optional(), fkbpros: t.optional(), fkb: t.optional() }).strict();
const yesNo = z.object({ yes: line().optional(), no: line().optional() }).strict();
const pp = z.object({ person: yesNo.optional(), pain: yesNo.optional(), promise: yesNo.optional() }).strict();
const lineList = (n = 30) => z.array(line()).max(n);
const dash = z.enum(DASH_POLICIES as [DashPolicy, ...DashPolicy[]], { message: "none | punctuation | allowed" });
const codeKey = z.string().regex(/^[a-z0-9]{2,32}$/, "a client code");

const rubricSchema = z
  .object({
    dimensions: z.array(z.unknown()),
    mechanics: z.array(z.unknown()),
    avatars: z.array(z.unknown()),
    briefs: lanes3(str(2_000)).optional(),
    note: line(200).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const mechs = (r.mechanics as { id?: string; label?: string }[]).map((m) => ({ id: String(m?.id ?? ""), label: String(m?.label ?? "") }));
    const parsed = rubricContentSchema(mechs, true).safeParse({ dimensions: r.dimensions, mechanics: r.mechanics, avatars: r.avatars });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      ctx.addIssue({ code: "custom", path: i.path, message: i.message });
    }
  });

export const profileSchema = z
  .object({
    owner: z.object({ name: line(60).nullable().optional(), display: line(60).nullable().optional() }).strict().optional(),
    lanes: lanes3(
      z
        .object({
          fullName: line(120).optional(),
          sub: line(60).nullable().optional(),
          about: line(160).nullable().optional(),
          mark: z.string().regex(/^[^\n]{1,3}$/, "1 to 3 characters").nullable().optional(),
        })
        .strict(),
    ).optional(),
    describe: z.object({ image: line().optional(), video: line().optional() }).strict().optional(),
    classify: z
      .object({
        categories: z.record(z.string().regex(/^[a-z_]{2,40}$/), line()).optional(),
        visualFormats: z.record(z.string().regex(/^[a-z_]{2,40}$/), line()).optional(),
        sections: lanes3(line()).optional(),
        correctionsKey: z.string().regex(/^[a-z_]{2,60}$/, "a state key (lowercase letters and _)").optional(),
        correctionsLine: line().optional(),
        clientTagsKey: z.string().regex(/^[a-z_]{2,60}$/, "a state key (lowercase letters and _)").optional(),
        client: z
          .object({ key: z.string().regex(/^[a-z_]{2,40}$/, "a state key").optional(), question: line().optional(), yes: line().optional(), no: line().optional() })
          .strict()
          .optional(),
        universal: z.object({ question: line().optional(), yes: line().optional(), no: line().optional() }).strict().optional(),
        sharedLabel: line(200).optional(),
        sharedClientSets: z.array(z.array(codeKey).min(2).max(10)).max(50).optional(),
        brandSafe: yesNo.optional(),
        pp: pp.optional(),
      })
      .strict()
      .optional(),
    hooks: z
      .object({
        sections: lanes3(line(200)).optional(),
        clientKey: z.string().regex(/^[a-z_]{2,40}$/, "a state key").optional(),
        sharedScope: line(300).optional(),
        pp: pp.optional(),
        legacyBriefs: lanes3(str(2_000)).optional(),
      })
      .strict()
      .optional(),
    rubric: rubricSchema.optional(),
    seed: z
      .object({
        rtmNotes: str().optional(),
        whosWho: str().optional(),
        companyNotes: str().optional(),
        companyHint: line(300).optional(),
        brandNotes: z.record(codeKey, str()).optional(),
      })
      .strict()
      .optional(),
    variants: z
      .object({
        channels: z.object({ rtm: line().optional(), fkb: line().optional(), client: line().optional(), shared: line().optional() }).strict().optional(),
        whoClient: line(200).optional(),
        whoCompany: line(200).optional(),
        notesHeadings: z.object({ client: line(200).optional(), fkb: line(200).optional(), rtm: line(200).optional() }).strict().optional(),
        videoLine: line().optional(),
        steerHeading: line().optional(),
        rules: lanes3(lineList()).optional(),
      })
      .strict()
      .optional(),
    moments: z
      .object({ system: line().optional(), task: line().optional(), episodeAbout: line().optional(), layoutLine: line(2_000).optional(), copyRules: lineList().optional() })
      .strict()
      .optional(),
    adCopy: z
      .object({
        channels: z.object({ fkb: line().optional(), client: line().optional() }).strict().optional(),
        whoClient: line(200).optional(),
        whoCompany: line(200).optional(),
        notesHeadings: z.object({ client: line(200).optional(), fkb: line(200).optional() }).strict().optional(),
        runningHeading: line().optional(),
        filledHeading: line().optional(),
        p1Line: line(2_000).optional(),
        formatLines: lineList().optional(),
        conceptLine: line(2_000).optional(),
        voice: z.object({ fkb: line().optional(), client: line().optional() }).strict().optional(),
        houseRules: lineList().optional(),
        emojiPalette: z.array(z.string().min(1).max(8)).max(20).optional(),
        landing: z.object({ client: line(300).optional(), company: line(300).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    copyRules: z
      .object({
        dashes: z.object({ rtm: dash.optional(), fkbpros: dash.optional(), fkb: dash.optional(), prose: dash.optional(), ads: dash.optional() }).strict().optional(),
        stateNames: lanes3(z.boolean()).optional(),
        banClientNames: lanes3(z.boolean()).optional(),
        bans: z.record(z.string().regex(/^[a-z0-9]{2,32}$/, "a channel code"), z.array(z.enum(["price", "financing"]))).optional(),
        messages: z
          .object({
            rtmName: line(200).optional(),
            clientName: line(200).optional(),
            companyName: line(200).optional(),
            noHyphen: line(200).optional(),
            adClientName: line(200).optional(),
            adCompanyName: line(200).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    ads: z
      .object({
        clientPrefix: z.string().regex(/^[A-Za-z0-9]{0,20}$/, "letters and digits (up to 20)").optional(),
        companyPrefix: z.string().regex(/^[A-Za-z0-9 ]{1,20}$/, "letters, digits and spaces (up to 20)").optional(),
        mediaPrefix: z.string().regex(/^[A-Za-z0-9]{1,10}$/, "letters and digits (up to 10)").nullable().optional(),
        campaignWord: z.string().regex(/^[A-Za-z0-9]{1,20}$/, "letters and digits (up to 20)").nullable().optional(),
        conceptExample: z.string().regex(/^[a-z0-9_]{2,48}$/, "a concept slug").optional(),
      })
      .strict()
      .optional(),
    generated: lanes3(z.string().regex(/^(?!\.{1,2}$)[^/\0\n]{1,60}$/, "one folder name (no slashes)")).optional(),
    transcripts: z
      .object({
        properNounFixes: z
          .array(z.object({ from: z.array(z.string().regex(/^[a-z0-9']{1,40}$/, "lower case words")).min(1).max(8), to: line(80) }).strict())
          .max(200)
          .optional(),
      })
      .strict()
      .optional(),
    pages: z.object({ broadGroup: line(80).optional(), proofExample: line(200).optional() }).strict().optional(),
    skills: z
      .object({
        reelCut: line(120).optional(),
        reelKit: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/, "letters, digits, dot, dash or underscore").optional(),
        explainer: line(120).optional(),
        episodePrep: line(120).optional(),
        adApplyClients: line(200).optional(),
        adApplyCompany: line(200).optional(),
      })
      .strict()
      .optional(),
    episodes: z
      .object({
        prefix: z.string().regex(/^[A-Za-z0-9 ._-]{1,30}$/, "letters, digits, spaces, dot, dash or underscore (up to 30)").optional(),
        kitLabel: line(60).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ProfileFile = z.infer<typeof profileSchema>;

// ------------------------------------------------------------------------------------------------ resolve

const isPlain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Objects merge key by key; anything else (strings, lists, null) replaces. `rubric` replaces whole (it is one version). */
function merge(base: unknown, over: unknown, path: string): unknown {
  if (over === undefined) return base;
  if (path === "rubric") return { ...(base as object), ...(over as object) };
  if (isPlain(base) && isPlain(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v, path ? `${path}.${k}` : k);
    return out;
  }
  return over;
}

/** The profile with every key present: the neutral built-ins overlaid with the file's keys. */
export function resolveProfile(file: ProfileFile | undefined | null): ResolvedProfile {
  if (!file) return NEUTRAL_PROFILE;
  return merge(NEUTRAL_PROFILE, file, "") as ResolvedProfile;
}
