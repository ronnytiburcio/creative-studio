/**
 * The NEUTRAL built-in business profile (Creative Studio slice 1c): every piece of business wording Jev, the describe
 * model or `claude -p` reads, every house copy rule and every naming convention, in generic small business / creator /
 * agency words. A Studio whose config has no `profile` (or leaves a key out) uses exactly this. The ONE place the neutral
 * wording lives (client safe: data only). Shape and per field docs: src/lib/profile.ts.
 *
 * Rules for this file: no home services words, no brand, client or person names, and no house rule a stranger did not
 * ask for (dashes are allowed, US state names are allowed, client names are not banned unless a note says so).
 * scripts/smoke-profile.ts checks every model-facing string built from it against a denylist.
 */
import type { Avatar, Dimension, Mechanic } from "./hooks/rubric";

const LANE_KEYS3 = ["rtm", "fkbpros", "fkb"] as const;

const DIMENSIONS: Dimension[] = [
  {
    id: "specificity",
    label: "Specificity",
    short: "Specific",
    question: "How specific are the words in `hook.text`? Count concrete details a viewer could picture or check.",
    appliesTo: { kinds: ["text", "video"], sections: [...LANE_KEYS3] },
    levels: [
      "Generic: could run for any company (like \"Quality work you can trust\"); no number, place, person, problem or result named.",
      "Mostly generic: names a product, a service or an audience, but nothing a viewer could picture or check.",
      "One concrete detail (a place, a number, a named problem or a clear result); the rest is general.",
      "Two or more concrete details, like a place and a number, or a named problem and a timeline.",
      "Concrete all the way through: exact numbers or timelines, a named person or place and a result a viewer could picture or check.",
    ],
  },
  {
    id: "avatar_match",
    label: "Avatar match",
    short: "Avatar",
    question:
      "How clearly is `hook.text` written for ONE person in `avatars`? Check two things: does it say WHO they are, and does it name THEIR exact problem or situation?",
    appliesTo: { kinds: ["text", "video"], sections: [...LANE_KEYS3] },
    levels: [
      "Written for nobody in particular, or about the company itself (\"We are...\", \"Our team...\").",
      "Written for everyone (\"customers\", \"business owners\"): no situation or problem that belongs to one person in `avatars`.",
      "Fits the situation of one person in `avatars` in general words, but names neither who they are nor their exact problem.",
      "Names the exact problem or situation of one person in `avatars` (their pain, in words they would use), but not who they are.",
      "Names who they are AND their exact problem, in words they would use, for one person in `avatars` only.",
    ],
  },
  {
    id: "curiosity_gap",
    label: "Curiosity gap",
    short: "Curiosity",
    question: "How strongly does `hook.text` make the viewer want to see what comes next?",
    appliesTo: { kinds: ["text", "video"], sections: [...LANE_KEYS3] },
    levels: [
      "Nothing to find out: a plain statement, label or slogan that closes itself.",
      "Mild: a topic is raised, but the answer is obvious or already given in the same line.",
      "A clear question or tease, but a familiar one the viewer has seen many times.",
      "An open loop: sets up a specific mistake, surprise, reveal or result and holds back the payoff.",
      "A strong open loop: a specific, unexpected or slightly uncomfortable setup the viewer can only settle by watching or clicking.",
    ],
  },
  {
    id: "offer_clarity",
    label: "Offer clarity",
    short: "Offer",
    question: "How clearly does `hook.text` say what the viewer gets if they act, and what to do next?",
    appliesTo: { kinds: ["text", "video"], sections: ["fkbpros", "fkb"] },
    levels: [
      "No offer: nothing the viewer gets and nothing to do.",
      "An offer is only implied (\"we can help\", \"find out how\"), with nothing concrete to get.",
      "Names what they get in general words (a quote, a consultation, a free trial), with no detail about it.",
      "A concrete offer with a detail that makes it easy to say yes: free, local, trusted, no pressure or a timeline.",
      "A concrete offer plus the next step in plain words: exactly what they get, what it costs them (like free) and what to do now.",
    ],
  },
  {
    id: "visual_stop_power",
    label: "Visual stop power",
    short: "Visual",
    question:
      "How strongly would the first 3 seconds of this video stop someone scrolling? Judge `video.first_3_seconds` and `video.on_screen_text`.",
    appliesTo: { kinds: ["video"], sections: [...LANE_KEYS3] },
    levels: [
      "Nothing stands out in the first 3 seconds: a logo, a dark or blank frame, or a slow establishing shot.",
      "A plain shot of a place, a product or a person with little movement and no on-screen text.",
      "A clear subject (a person talking or a product) with some movement or on-screen text, but nothing unusual.",
      "A striking opening: a big reveal, a strong before, bold on-screen text or a person speaking straight to the camera from the first frame.",
      "An opening nobody could miss: a dramatic transformation or surprising image together with bold text in the first second.",
    ],
  },
  {
    id: "brand_fit",
    label: "Brand fit",
    short: "Brand",
    question:
      "Does `hook.text` follow this channel's voice and rules? Check it against `channel.brief` and every line of `channel.notes`.",
    appliesTo: { kinds: ["text", "video"], sections: [...LANE_KEYS3] },
    levels: [
      "Breaks a rule: names someone `channel.notes` says never to name, makes a claim `channel.notes` does not allow, or speaks as the wrong speaker.",
      "Off voice: hype, shouting, fake urgency or corporate phrases (\"we pride ourselves\"), or it is about the company instead of the viewer.",
      "Breaks no rule but has no voice: a bare label, slogan or list of services (like \"Design, Build, or Both\").",
      "On voice: plain words about the viewer's own problem or goal, calm and confident, and every claim is one `channel.notes` allows.",
      "On voice and tied to this channel: plain words about the viewer plus a detail from `channel.notes` (a place, a product or a proof point) used the way `channel.notes` allows.",
    ],
  },
];

const MECHANICS: Mechanic[] = [
  { id: "be_specific", label: "Be specific", definition: "Exact details carry it: a precise person, number, place or real result instead of general words." },
  { id: "lead_number", label: "Lead with a number", definition: "Opens with a number that carries time, effort or cost, like \"in 1 week\", \"under $5\" or \"10 years\"." },
  { id: "call_out", label: "Call out the audience", definition: "Names who it is for so they pick themselves out, like \"New parents:\" or \"Dentists,\"." },
  { id: "taboo", label: "Lean into the taboo", definition: "Says what competitors are too polite to say out loud." },
  { id: "primal_desire", label: "Primal desire", definition: "Sells a deep want (status, safety, belonging, approval, pride) instead of a product feature." },
  { id: "curiosity_loop", label: "Curiosity loop", definition: "Shows the setup and hides the payoff behind the click." },
  { id: "negative", label: "Negative", definition: "Phrased in the negative: names what the viewer fears, hates or wants to avoid." },
  { id: "golden_nugget", label: "Golden nugget testimonial", definition: "Borrows a real customer's own words." },
  { id: "transformation", label: "Show the transformation", definition: "Puts the before and the after in front of the viewer instead of describing the result." },
  { id: "none", label: "None", definition: "None of these: a plain statement, slogan or label." },
];

const AVATARS: Avatar[] = [
  {
    slug: "clients_busy_buyer",
    label: "Busy buyer",
    section: "fkbpros",
    sections: ["fkbpros", "fkb"],
    stage: "ps",
    universalOnly: false,
    person: "Busy customer with no time to compare providers",
    pain: "Every quote takes days and it is hard to tell who is any good",
    promise: "A trusted local provider and a clear answer fast",
  },
  {
    slug: "clients_first_timer",
    label: "First timer",
    section: "fkbpros",
    sections: ["fkbpros", "fkb"],
    stage: "ps",
    universalOnly: false,
    person: "Customer buying this service for the first time",
    pain: "Does not know what it should cost or what to ask",
    promise: "A clear, honest walkthrough of the options and the price",
  },
  {
    slug: "clients_burned_before",
    label: "Burned before",
    section: "fkbpros",
    sections: ["fkbpros", "fkb"],
    stage: "obj",
    universalOnly: false,
    person: "Customer who was let down by a provider before",
    pain: "Paid once and was ignored; afraid to try again",
    promise: "A provider with real reviews who answers and shows up",
  },
  {
    slug: "brand_owner_more_customers",
    label: "Owner who wants customers",
    section: "rtm",
    stage: null,
    universalOnly: false,
    person: "Small business owner who wants more customers from social media",
    pain: "Posts get likes but almost nobody books or buys",
    promise: "A simple plan that turns attention into paying customers",
  },
  {
    slug: "brand_owner_new_to_ads",
    label: "New to ads",
    section: "rtm",
    stage: null,
    universalOnly: false,
    person: "Owner who has never run paid ads",
    pain: "Afraid to waste money on ads they do not understand",
    promise: "A first campaign with plain numbers on what each customer costs",
  },
];

const AI_TELLS_LINE = "{ai_tells}";

/** The neutral profile, fully resolved (every key present). */
export const NEUTRAL_PROFILE = {
  owner: { name: null as string | null, display: null as string | null },
  /** Per lane: the long name, the sidebar sub label, the channel header's one line about it and its letter mark. */
  lanes: {
    rtm: { fullName: "Brand", sub: null as string | null, about: "Reels, Shorts, YouTube, statics and brand kit" as string | null, mark: null as string | null },
    fkbpros: { fullName: "Clients", sub: null as string | null, about: null as string | null, mark: null as string | null },
    fkb: { fullName: "Company", sub: null as string | null, about: null as string | null, mark: null as string | null },
  },
  describe: {
    image:
      "Describe this image for a searchable media library. Files are photos of work, products and places, ads, thumbnails, logos and other graphics. Describe what is actually there.",
    video:
      "Describe this video for a searchable media library. Files are videos of work, products and places, ads, intros and graphics. Describe what is actually there.",
  },
  classify: {
    /** Overrides of the category descriptions (classes.ts holds the neutral ones). */
    categories: {} as Record<string, string>,
    /** Overrides of the visual format descriptions (classes.ts holds the neutral ones). */
    visualFormats: {} as Record<string, string>,
    sections: {
      rtm: "Brand (the owner's own content: YouTube and social)",
      fkbpros: "Clients (ads made for client businesses)",
      fkb: "Company (a standalone company: its ads and project media)",
    },
    correctionsKey: "recent_corrections",
    correctionsLine: "`recent_corrections` shows how similar files were filed.",
    clientTagsKey: "recent_client_tags",
    client: {
      key: "client",
      question:
        "Does this file name or clearly point to the client in `client`? Look at `file.name`, `file.folder`, the words on screen in `description` and `spoken_opening`.",
      yes: "Yes: the file name, folder, on-screen words or spoken words name this client, their company, their code, their town or region, or an offer only they make.",
      no: "No: nothing names this client. Generic work that any client could have done is a no.",
    },
    universal: {
      question: "Is this generic shared material that is not about any one client?",
      yes: "Yes: shared or generic material that names no single client, company, code, town or offer.",
      no: "No: it names or clearly belongs to one client, company or town.",
    },
    sharedLabel: "shared: no single client (generic material)",
    /** Client code sets that may legitimately be tagged to one file together (e.g. two branches of one brand). */
    sharedClientSets: [] as string[][],
    brandSafe: {
      yes: "Yes: no logo or name of an outside company (other than your own brands or the client it is about), no private info (street addresses, house numbers, license plates, children's faces, personal paperwork) and no broken, glitched, blurry or unfinished frames or text.",
      no: "No: it shows an outside company's logo or name, private info (an address, a house number, a license plate, a child's face, personal paperwork), or broken, glitched or unfinished frames or text.",
    },
    pp: {
      person: {
        yes: "Yes: a specific person is named so they recognize themselves, like new parents, first time buyers, local runners or busy families.",
        no: "No: the words name no specific audience.",
      },
      pain: {
        yes: "Yes: a specific problem is stated, like a slow website, a long wait, a confusing bill or a provider who disappeared.",
        no: "No: the words state no specific problem.",
      },
      promise: {
        yes: "Yes: a specific outcome is promised, like a fresh look without starting over, results in about a week, or a trusted local expert.",
        no: "No: the words promise no specific outcome.",
      },
    },
  },
  hooks: {
    sections: { rtm: "Brand", fkbpros: "Clients", fkb: "Company" },
    clientKey: "client",
    sharedScope: "shared: the clients lane in general, not one client",
    pp: {
      person: {
        yes: "Yes: a specific person is named or described, like new parents, local runners, people waiting weeks for a quote, or owners running their first ads.",
        no: "No: nobody specific; only \"you\" or a broad word like \"customers\" or \"business owners\" with nothing that narrows it.",
      },
      pain: {
        yes: "Yes: a specific problem is stated, like a slow website, a provider who disappeared, a long wait, or ad spend with no sales.",
        no: "No: no specific problem is stated.",
      },
      promise: {
        yes: "Yes: a specific outcome is promised, like a fresh look without starting over, results in about a week, a trusted local expert, or customers from ad spend.",
        no: "No: no specific outcome is promised.",
      },
    },
    legacyBriefs: {
      rtm: "The owner's own organic content (YouTube, Shorts, Reels, social), in the owner's own first person voice.",
      fkbpros:
        "Paid ads made for client businesses. Voice: plain, calm and specific, about the viewer and their problem, never about the company first; no hype, no shouting, no fake urgency.",
      fkb: "The company's own paid ads, speaking as itself. Voice: plain, calm and confident, about the viewer, never about the company first; no hype, no shouting, no fake urgency.",
    },
  },
  rubric: {
    dimensions: DIMENSIONS,
    mechanics: MECHANICS,
    avatars: AVATARS,
    briefs: {} as Partial<Record<"rtm" | "fkbpros" | "fkb", string>>,
    note: "Starter rubric: six dimensions, the 9 copy mechanics and a few starter avatars per lane.",
  },
  seed: {
    rtmNotes: "",
    whosWho: "",
    companyNotes: "",
    companyHint: "",
    brandNotes: {} as Record<string, string>,
  },
  variants: {
    channels: {
      rtm: "Brand (the owner's own content)",
      fkb: "Company (speaking as itself)",
      client: "Client: {name}",
      shared: "Clients, shared (no one client)",
    },
    whoClient: "Who the client is",
    whoCompany: "Who the company is",
    notesHeadings: { client: "Brand notes (the rules for this client)", fkb: "Company brand notes (its own rules)", rtm: "Brand notes" },
    videoLine: "It opens a video. Your variants are new opening lines the presenter can film or say (spoken and on screen), not edits of the footage.",
    steerHeading: "The steer (a direction for the variants; it never overrides the copy rules)",
    rules: {
      fkb: ["The company speaks as itself (we, our team) and never names a client.", "Only claims the company's brand notes allow."],
      fkbpros: ["Only claims the brand notes allow. No price, financing, licensing, warranty or rating claim the notes do not allow."],
      rtm: ["The owner's own first person voice."],
    },
  },
  moments: {
    system:
      "You are a short form video editor for a YouTube channel. Follow the rules in the user's message exactly. Reply with one JSON object only: no prose, no code fences.",
    task: "Pick the best moments of a YouTube episode to cut as vertical Reels / Shorts (9:16, Instagram, Facebook, YouTube Shorts).",
    episodeAbout: "The host teaches over a screen recording with a webcam in a corner.",
    layoutLine:
      "`layout`: one of {layouts}. stack = the screen content (or a before and after image) on top and the host's webcam crop below: use it unless another one clearly fits better. center = the host's face only, for a talking moment. blurfill = the full 16:9 frame over a blurred copy, when the screen is the point. pip = rarely.",
    copyRules: [AI_TELLS_LINE],
  },
  adCopy: {
    channels: { fkb: "{lane}, speaking as itself", client: "An ad for {label}" },
    whoClient: "Who the client is",
    whoCompany: "Who the company is",
    notesHeadings: { client: "Brand notes (the rules for this client)", fkb: "Company brand notes (its own rules)" },
    runningHeading: "Copy running now (its voice; do not repeat it)",
    filledHeading: "Already written (keep the set coherent with these; never repeat them)",
    p1Line: '- The FIRST primary text you write must open with this exact line, the hook, word for word: "{line}". After it, the rest of the format below.',
    formatLines: [
      "- Write {n} primary texts, each one the same shape:",
      "  1. An opening line that names who it is for and the offer.",
      "  2. One line that names the pain as a question or a plain statement, for exactly ONE person.",
      "  3. Two or three short lines, one claim each, only claims the notes allow.",
      "  4. A closing line that tells them to tap to get started.",
      "  Make the Three P's plain in every primary: the Person it is for, their Pain, and the Promise (the one outcome).",
      "  DOUBLE SPACED: a blank line between EVERY line (write \\n\\n between lines in the JSON string).",
    ],
    conceptLine:
      '- Suggest the ad\'s concept slug for its name: 2 or 3 lowercase words joined by "_" naming the person or situation and the hook (like busy_parents, late_quote_fix), and ps_obj: "ps" when the ad states a problem and its solution, "obj" when it answers a doubt that stops the click.',
    voice: {
      fkb: "The company speaks as itself (we, our team) and never names a client.",
      client: "Speak to the viewer about their problem; only claims the brand notes allow.",
    },
    houseRules: [] as string[],
    emojiPalette: ["✅", "⭐", "\u{1F4CD}", "\u{1F447}", "\u{1F4C5}"],
    landing: { client: "", company: "" },
  },
  copyRules: {
    /** none = no dash or hyphen at all; punctuation = no dash, no hyphen used as punctuation (compounds fine); allowed = not checked. */
    dashes: { rtm: "allowed", fkbpros: "allowed", fkb: "allowed", prose: "allowed", ads: "allowed" } as Record<"rtm" | "fkbpros" | "fkb" | "prose" | "ads", DashPolicy>,
    /** Refuse US state names (per lane). */
    stateNames: { rtm: false, fkbpros: false, fkb: false } as Record<"rtm" | "fkbpros" | "fkb", boolean>,
    /** Refuse the client names (Lane B: the client's own on its hooks, every client's on shared hooks; Lane A also the codes). */
    banClientNames: { rtm: false, fkbpros: false, fkb: false } as Record<"rtm" | "fkbpros" | "fkb", boolean>,
    /** Fixed per channel code bans for new ads, beyond the notes' own lines. */
    bans: {} as Record<string, ("price" | "financing")[]>,
    messages: {
      rtmName: 'names a client ("{name}")',
      clientName: 'names the client ("{name}")',
      companyName: 'names a client ("{name}")',
      noHyphen: 'hyphenated compound "{text}" (this lane allows none)',
      adClientName: 'Names the client ("{name}")',
      adCompanyName: 'Names a client ("{name}")',
    },
  },
  ads: {
    /** Lane B ad names: `<prefix>-<code>-<concept>-<ps|obj>-<nn>` (no prefix: `<code>-...`). */
    clientPrefix: "",
    /** Lane C ad names: `<prefix> <n>`. */
    companyPrefix: "Ad",
    /** A media name prefix dropped when matching Lane C ads to files (e.g. a filmer's initials). */
    mediaPrefix: null as string | null,
    /** A word the campaign name scan also accepts (besides the client code). */
    campaignWord: null as string | null,
    /** The concept slug example the ad dialog's error shows. */
    conceptExample: "late_quote_fix",
  },
  /** The folders under `<drive>/Studio Generated/` per lane (one folder name each). */
  generated: { rtm: "Brand", fkbpros: "Clients", fkb: "Company" },
  transcripts: {
    properNounFixes: [] as { from: string[]; to: string }[],
  },
  pages: {
    broadGroup: "customers",
    proofExample: "4.9 stars from 212 customers",
  },
  /**
   * The outside skills Studio names in its hand-off lists, paste lines and help text (decision 10: they are documented,
   * not shipped). `reelKit` is also the `kit` value a kit.json note must carry. `adApply*` = the step an order's paste
   * line asks for (Lane B / Lane C).
   */
  skills: {
    reelCut: "reel-cut",
    reelKit: "reel-kit",
    explainer: "explainer-reel",
    episodePrep: "episode-prep",
    adApplyClients: "ad-apply",
    adApplyCompany: "ad-apply",
  },
  /**
   * Lane A episode files (written by the episode prep and reel skills, read by Studio): `<prefix>N.srt` (the prepped
   * transcript), `<prefix>N reels.json` (the reel list), `<prefix>N Reel K[ vN].mp4` + `... caption.md` (the reels).
   * `kitLabel` = the reel kit format's name in the Cut reel dialog and hand-off.
   */
  episodes: {
    prefix: "Episode ",
    kitLabel: "Reel kit",
  },
};

export type DashPolicy = "none" | "punctuation" | "allowed";
export type ResolvedProfile = typeof NEUTRAL_PROFILE;
export const DASH_POLICIES: readonly DashPolicy[] = ["none", "punctuation", "allowed"];
export const AI_TELLS_TOKEN = AI_TELLS_LINE;
