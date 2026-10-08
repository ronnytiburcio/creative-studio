/**
 * Landing page section rubric (client safe: no I/O). Landing page Phase 2 slice 2, design
 * `runs/_phase2-design.md` of the landing page skill, A1 to A3.
 *
 * A CODE versioned constant, not a `rubric_versions` row (A1): the hook rubric's "exactly one current" line is what the
 * Lane B copy gate scores with, so a page rubric never goes there. Same rule as CLASSIFY_VERSION: a version is immutable;
 * ANY wording change (a part's job / passes / fails, a question, a level, a label) appends a NEW version to
 * PAGE_RUBRICS and moves CURRENT_PAGE_RUBRIC. Old versions stay, so a BEFORE can be rescored on the version the AFTER
 * used. The page rubric is ADVISORY: it never blocks anything and never writes to hooks / hook_scores / notes /
 * rubric_versions (scripts/score-page.ts writes only ai_calls rows, purpose `page_score`).
 *
 * Parts follow the 17 part skeleton (`references/skeleton.md`): 9 parts whose job Jev can judge from the words, plus the
 * page level story test. Not scored here (the structural audit owns them; Jev cannot judge truth or owner approval):
 * P7 credentials (folded into proof), P8 benefits, P11 bonuses, P14 scarcity, P15 risk reversal, the FAQ. P4 intrigue
 * folds into the subheadline. Each dimension is one Jev `score` question with exactly 5 literal levels, low (1) to high
 * (5), naming the state keys it reads (jev-1.13 guidance, like the hook rubric). Arithmetic stays in code
 * (src/lib/pages/score.ts).
 *
 * The owner's rule for Lane A (2026-10-07): Lane A never handles a client's lead intake or calls, so no level here
 * rewards a page for promising call handling, call backs or answering anyone's leads.
 *
 * Creative Studio slice 1c: v1's two audience / proof examples come from the business profile's `pages` (the builders
 * in PAGE_RUBRICS take them; `pageRubric` reads the active profile on the server).
 */
import { profile } from "../profile";

/** The parts a page rubric scores (one Jev call each). `story` reads the headline + section headings only. */
export type PagePartId = "eyebrow" | "headline" | "subheadline" | "problem" | "solution" | "proof" | "offer" | "cta" | "ps" | "story";

export type PageDimension = {
  /** Question id in the Jev call (unique within the part, never a hook rubric reserved id). */
  id: string;
  /** Shown in `why` when the level is 2 or below. */
  label: string;
  /** The question Jev reads (literal, names the state keys it looks at). */
  question: string;
  /** Exactly 5, low (1) to high (5). */
  levels: string[];
};

export type PagePart = {
  id: PagePartId;
  label: string;
  /** Where the part sits in skeleton.md. */
  skeleton: string;
  /** Freight parts (the headline complex + the offer section): `freight_score` is their mean. */
  freight: boolean;
  /** One line each from skeleton.md: the state's `part` block. */
  job: string;
  passes: string;
  fails: string;
  /** 2 to 4. */
  dims: PageDimension[];
};

export type PageRubric = {
  version: number;
  note: string;
  parts: PagePart[];
};

/** The two audience / proof examples in v1's wording (the business profile's `pages`, Creative Studio slice 1c). */
export type PageExamples = { broadGroup: string; proofExample: string };

const v1Parts = (ex: PageExamples): PagePart[] => [
  {
    id: "eyebrow",
    label: "Eyebrow",
    skeleton: "P1 call out the audience",
    freight: true,
    job: 'Tell the right reader "this is for you" in under a second, and lead with proof.',
    passes: "Names who the page is for AND carries a proof token (a rating with a review count, jobs done, years, clients served).",
    fails: "A generic category label, a missing callout, or proof that cannot be backed.",
    dims: [
      {
        id: "audience_callout",
        label: "Audience callout",
        question: "How clearly does `section.text` (the small line above the headline) say who the page is for? Compare with the people in `avatars`.",
        levels: [
          "Names nobody: a category label, a slogan or the company name only.",
          `A very broad group only, like "business owners" or "${ex.broadGroup}".`,
          "A group narrowed by one detail: a trade, a place or a situation.",
          "A group that matches one person in `avatars`, by who they are or by their situation.",
          "One person in `avatars`, by who they are AND their situation, in words they would use.",
        ],
      },
      {
        id: "proof_token",
        label: "Proof token",
        question:
          "Does `section.text` (the small line above the headline) carry a concrete proof token a reader could check, such as a rating with a review count, a number of jobs or clients, or years in business?",
        levels: [
          "No proof at all.",
          'A vague claim with no number, like "trusted" or "top rated".',
          'One number with nothing to anchor it, like "100+ happy clients".',
          'One specific number with its unit, like "212 reviews" or "12 years".',
          `A specific proof token with its source or time window, like "${ex.proofExample}".`,
        ],
      },
    ],
  },
  {
    id: "headline",
    label: "Headline",
    skeleton: "P2 big promise headline",
    freight: true,
    job: "State the dream outcome so clearly the reader gets it instantly and wants more.",
    passes: "Names the person or their situation and a concrete outcome, ideally with a time frame or a named method; readable in one glance on a phone.",
    fails: "Clever wordplay, a brand slogan, a feature, or a promise the page cannot back.",
    dims: [
      {
        id: "specific_person",
        label: "Specific person",
        question:
          "How clearly does `section.text` (the page's main headline) name the person it is for, or their exact situation? Compare with the people in `avatars`.",
        levels: [
          "Names nobody: a slogan or a statement about the business.",
          `A broad group only, like "small businesses" or "${ex.broadGroup}".`,
          "A group narrowed by one detail: a trade, a place or a situation.",
          "One person in `avatars`, by their situation or by who they are.",
          "One person in `avatars`, by who they are AND their situation, in words they would use.",
        ],
      },
      {
        id: "dream_outcome",
        label: "Dream outcome",
        question: "How concrete is the outcome `section.text` (the page's main headline) promises the reader?",
        levels: [
          "No outcome: a slogan, a feature or a statement about the business.",
          'A vague benefit, like "grow your business" or "better results".',
          'A clear outcome in general words, like "more customers".',
          "A concrete outcome the person in `avatars` wants, said in their terms.",
          "A concrete outcome with a measure or a picture of the result the reader can see themselves in.",
        ],
      },
      {
        id: "time_or_mechanism",
        label: "Time frame or method",
        question: "Does `section.text` (the page's main headline) say how fast the outcome comes, or the named way it happens?",
        levels: [
          "Neither a time frame nor a way it happens.",
          'A vague hint only, like "fast" or "with our proven process".',
          "Either a concrete time frame or a described way it happens, without a name.",
          "A concrete time frame, or a named method.",
          "Both a concrete time frame and a named method.",
        ],
      },
      {
        id: "clear_not_clever",
        label: "Clear, not clever",
        question:
          "Would a busy reader understand `section.text` (the page's main headline) in one glance, with no wordplay, slogan or feature talk to decode?",
        levels: [
          "A slogan, pun or riddle: the reader cannot tell what is offered.",
          "Mostly clever: the meaning needs a second read.",
          "Understandable, but long, abstract or full of jargon.",
          "Plain and clear in one read, with a word or two of filler.",
          "Plain, short and instantly clear: a stranger could repeat what is offered.",
        ],
      },
    ],
  },
  {
    id: "subheadline",
    label: "Subheadline",
    skeleton: "P3 subheadline + P4 intrigue",
    freight: true,
    job: "Back up and expand the headline with one or two specifics, then open a loop only the rest of the page closes.",
    passes: "Adds a specific the headline lacks (how, how fast, what it is not) and ends with a specific reason to keep reading.",
    fails: "Repeats the headline, tells the whole story, lists services, or teases vaguely.",
    dims: [
      {
        id: "adds_specifics",
        label: "Adds specifics",
        question: "Compared with `page.headline`, what does `section.text` (the subheadline) add?",
        levels: [
          "Nothing: it repeats the headline in other words, or lists services.",
          "A general line that adds no new fact.",
          "One new detail, but a general one.",
          "One concrete specific the headline lacks: how, how fast or what it is not.",
          "One or two concrete specifics the headline lacks that make its promise more believable.",
        ],
      },
      {
        id: "open_loop",
        label: "Open loop",
        question: "Does `section.text` (the subheadline) end on a specific question or gap that only the rest of the page answers?",
        levels: [
          "No open question: it closes the thought or tells the whole story.",
          'A vague teaser, like "you will not believe this" or "find out more".',
          "A general reason to read on, not tied to anything specific.",
          "A specific question or gap tied to the problem or the method.",
          "A specific, curious gap tied to the named method that the reader wants closed now.",
        ],
      },
    ],
  },
  {
    id: "problem",
    label: "Problem",
    skeleton: "P5 lead in: floodlight the problem",
    freight: false,
    job: "Describe the reader's problem in such intimate, specific detail that they feel understood, in the market's own words.",
    passes: "Concrete scenes and the reader's own vocabulary, pains and fears; the subhead is a hook.",
    fails: "Generic pain, or the business talking about itself.",
    dims: [
      {
        id: "intimacy",
        label: "Intimacy",
        question: "How concretely do `section.heading` and `section.text` describe the reader's own situation?",
        levels: [
          "No problem described, or only the business's view of it.",
          'Generic pain only, like "marketing is hard" or "repairs are stressful".',
          "A real problem in general terms, without a scene.",
          "A concrete scene or detail from the reader's own situation.",
          "Several concrete scenes or details the person in `avatars` would recognize as their own week.",
        ],
      },
      {
        id: "market_words",
        label: "Market words",
        question:
          "Does `section.text` use the words the market uses about its own situation? Compare with `voice` when it is present, else with the `pain` lines in `avatars`.",
        levels: [
          "Industry, marketing or company language only.",
          "Mostly industry language, with one plain word.",
          "Plain pain words, but none the way `voice` or `avatars` say it.",
          "One or two phrases the way a reader in `voice` or `avatars` would say it.",
          "Several phrases a reader in `voice` or `avatars` would use about their own situation.",
        ],
      },
      {
        id: "reader_focus",
        label: "Reader focus",
        question: "Who are `section.heading` and `section.text` about: the reader or the business?",
        levels: [
          "All about the business: its story, team or services.",
          "Mostly the business, with a nod to the reader.",
          "Half the reader, half the business.",
          "Mostly the reader; the business is barely mentioned.",
          "Entirely the reader: their situation, their words, their stakes.",
        ],
      },
    ],
  },
  {
    id: "solution",
    label: "Solution",
    skeleton: "P6 reveal the solution + the hero mechanism",
    freight: false,
    job: "Introduce the way out and answer why it will work when everything else the reader tried failed.",
    passes: "Names the alternatives fairly and why each fails, gives the method a name with clear parts, and shows how it fixes each failure.",
    fails: '"Our proven process", no alternatives addressed, or a name with nothing behind it.',
    dims: [
      {
        id: "alternatives_named",
        label: "Alternatives named",
        question: "Do `section.heading` and `section.text` name the alternatives the reader already tried, and say why each one fails them?",
        levels: [
          "No alternatives mentioned.",
          'A vague swipe only, like "other companies" or "the old way".',
          "One alternative named, without why it fails.",
          "Alternatives named, with why at least one of them fails the reader.",
          "Each alternative the reader likely tried, named fairly, with the specific reason it fails them.",
        ],
      },
      {
        id: "named_mechanism",
        label: "Named method",
        question: "Does `section.text` give the method a name and clear parts or steps?",
        levels: [
          'No method: just "we help" or "our proven process".',
          "A described approach with no name and no steps.",
          "Either a name or clear steps, not both.",
          "A named method whose steps are a little vague.",
          "A named method with 2 to 4 clear, concrete parts or steps.",
        ],
      },
      {
        id: "fix_ties_to_failure",
        label: "Fix ties to failure",
        question: "Does `section.text` show how the method fixes the reasons the alternatives failed?",
        levels: [
          "No link between the method and any failure.",
          "A general claim that it works better.",
          "Links the method to one failure, in general words.",
          "Shows how the method fixes a named failure.",
          "Shows, step by step, how the method fixes each named failure.",
        ],
      },
    ],
  },
  {
    id: "proof",
    label: "Proof",
    skeleton: "P9 unquestionable proof + P7 credentials",
    freight: false,
    job: "Convince a jury: back every claim made so far, and show why this person or company is qualified to make the promise.",
    passes: "Real numbers with a date window, verbatim reviews with a source, before and afters, specific checkable credentials.",
    fails: "Adjectives, stock or AI images presented as real work, unattributed quotes, stale numbers.",
    dims: [
      {
        id: "jury_grade",
        label: "Jury grade proof",
        question: "How checkable is the proof in `section.heading` and `section.text`?",
        levels: [
          "No proof: adjectives or claims only.",
          'Vague proof, like "trusted by many" or an unnamed quote.',
          "One specific item (a number, a named review or a credential) without a source or a date.",
          "Several specific items, at least one with a source or a date window.",
          "Specific numbers with date windows, named sources or verbatim reviews, and checkable credentials.",
        ],
      },
      {
        id: "backs_the_promise",
        label: "Backs the promise",
        question: "Does the proof in `section.text` back the promise in `page.headline`?",
        levels: [
          "Unrelated to the headline's promise.",
          "Backs the business in general, not the promise.",
          "Backs part of the promise, loosely.",
          "Directly backs the main outcome the headline promises.",
          "Directly backs the headline's outcome AND its time frame or method.",
        ],
      },
    ],
  },
  {
    id: "offer",
    label: "Offer",
    skeleton: "P10 core offer + P12 value + P13 price reveal",
    freight: true,
    job: "Present the call as the offer: a named session with a clear takeaway, valued against a real paid thing, and plainly free.",
    passes: "A named session with its length or format, exactly what they walk away with even if they never buy, free with an honest reason.",
    fails: '"Contact us", "Get a quote" or "Book a call" with nothing promised; an invented value; hiding that it is a sales call.',
    dims: [
      {
        id: "named_session",
        label: "Named session",
        question: "Is the call in `section.heading` and `section.text` a named session with a length or a format?",
        levels: [
          'No session: "contact us" or "get a quote".',
          '"Book a call" with no name, length or format.',
          "A call with a length or a format, but no name.",
          "A named session, but no length or format.",
          "A named session with its length or format.",
        ],
      },
      {
        id: "concrete_takeaway",
        label: "Concrete takeaway",
        question: "Does `section.text` say exactly what the reader walks away with from the call, even if they never buy?",
        levels: [
          "Nothing promised from the call.",
          'A vague takeaway, like "ideas" or "a strategy session".',
          'A general takeaway, like "a plan" or "a review".',
          "A concrete takeaway, like a written plan or a review of their own numbers.",
          "A concrete, specific takeaway they keep either way, like a written plan they can use with anyone.",
        ],
      },
      {
        id: "food_court_test",
        label: "Food court test",
        question: "Would a busy stranger who has never heard of this business want what `section.text` offers enough to give it the time?",
        levels: [
          '"Contact us" or "get a quote": nothing promised.',
          "A free call with nothing in particular in it.",
          'A free call with a vague takeaway, like "a strategy session".',
          "A named session with a concrete takeaway, but little reason to want it now.",
          "A named session with a length and a concrete takeaway a stranger would stop for.",
        ],
      },
      {
        id: "free_with_reason",
        label: "Free with a reason",
        question: "Does `section.text` say plainly that the call costs nothing, with an honest reason why?",
        levels: [
          "Says nothing about cost.",
          "Implies it is free without saying so.",
          "Says it is free, with no reason.",
          "Says it is free, with a general reason.",
          "Says plainly it is free, with an honest reason (like earning the work only when it is a fit) and no hidden pitch.",
        ],
      },
    ],
  },
  {
    id: "cta",
    label: "Call to action",
    skeleton: "P16 vividly described call to action",
    freight: true,
    job: "Tell them exactly what happens when they click, and make it feel easy.",
    passes: "A benefit driven button label that names the offer, a plain line on what happens next, one wording family everywhere.",
    fails: 'A lone "Submit", several different CTA wordings, or nothing about after the click.',
    dims: [
      {
        id: "vivid_label",
        label: "Vivid label",
        question: "How benefit driven and named are the button labels in `section.ctas`?",
        levels: [
          'No labels, or only "Submit", "Send" or "Click here".',
          'Generic action labels, like "Book a call" or "Contact us".',
          "A label with a benefit word, but no named offer.",
          'A label that names the offer, like "Get my free plan".',
          "A label that names the offer and its benefit in the reader's own voice.",
        ],
      },
      {
        id: "what_happens_next",
        label: "What happens next",
        question: "Does `section.text` say what happens after the click: the next step, when it happens and what the reader gets from it?",
        levels: [
          "Nothing about what happens after the click.",
          'A vague line, like "we will be in touch".',
          "Names the next step, but not when it happens or what they get.",
          "Names the next step and either when it happens or what they get.",
          "Names the next step, when it happens and exactly what they get from it.",
        ],
      },
      {
        id: "one_wording_family",
        label: "One wording family",
        question: "Do the labels in `section.ctas` all name the same offer the same way?",
        levels: [
          "No labels, or every label says something different.",
          "Several different offers or actions across the labels.",
          "Mostly one action, worded several different ways.",
          "One offer, with small wording changes.",
          "One offer, named the same way on every label.",
        ],
      },
    ],
  },
  {
    id: "ps",
    label: "P.S.",
    skeleton: "P17 close with a P.S.",
    freight: true,
    job: "The short version for readers who jump to the bottom: the offer, the next step, the cost of doing nothing.",
    passes: "Restates the named offer, the single next step and what doing nothing costs.",
    fails: "Missing, or a sign off with no offer.",
    dims: [
      {
        id: "restates_offer",
        label: "Restates the offer",
        question: "Does `section.text` (the P.S.) restate the page's offer?",
        levels: [
          "No offer mentioned.",
          'A vague mention, like "reach out".',
          "Mentions a call or a consultation, unnamed.",
          "Restates the offer with its name or its takeaway.",
          "Restates the named offer with its takeaway and that it is free.",
        ],
      },
      {
        id: "next_step",
        label: "Next step",
        question: "Does `section.text` (the P.S.) give one single next step?",
        levels: [
          "No next step.",
          "Several competing next steps.",
          "A next step, worded vaguely.",
          "One clear next step.",
          "One clear next step that says exactly what to do and how easy it is.",
        ],
      },
      {
        id: "cost_of_inaction",
        label: "Cost of inaction",
        question: "Does `section.text` (the P.S.) say what doing nothing costs the reader?",
        levels: [
          "Nothing about waiting.",
          'Generic urgency only, like "do not wait" or "act now".',
          'A general cost of waiting, like "you are losing money".',
          "A concrete cost of waiting, from the reader's own situation.",
          "A concrete cost of waiting from the reader's situation, tied to something true on the page, with no fake urgency.",
        ],
      },
    ],
  },
  {
    id: "story",
    label: "Story test",
    skeleton: "The story test (headline + section headings only)",
    freight: false,
    job: "Read only the headline and the section headings, top to bottom: alone they tell the whole story and could make someone act.",
    passes: "They cover who it is for, the promise, the problem, why the alternatives fail, the method, the proof, the offer and the next step, and each heading is a hook.",
    fails: 'Labels instead of hooks ("About us", "Our services", "FAQ"), gaps in the story, the offer never appears.',
    dims: [
      {
        id: "story_complete",
        label: "Story complete",
        question:
          "`section.text` lists the page's headline and section headings, one per line, top to bottom. How many of these beats do they tell, in order: who it is for, the promise, the problem, why the alternatives fail, the method, the proof, the offer, the next step?",
        levels: [
          "One beat or none.",
          "Two or three beats.",
          "Four or five beats.",
          "Six or seven beats.",
          "All eight beats, in an order that reads as one story.",
        ],
      },
      {
        id: "hooks_not_labels",
        label: "Hooks, not labels",
        question:
          'How many of the lines in `section.text` (the headline and section headings) are hooks (a big benefit, a big negative or an open question) rather than labels like "About us", "Our services" or "FAQ"?',
        levels: ["All or nearly all are labels.", "Most are labels.", "About half are hooks.", "Most are hooks.", "Every line is a hook."],
      },
    ],
  },
];

/**
 * Every page rubric version, by number, as a builder over the profile's two examples. Never edit a version in place:
 * append a new one (a profile that keeps its examples reads exactly the text it always read).
 */
export const PAGE_RUBRICS: Readonly<Record<number, (ex: PageExamples) => PageRubric>> = Object.freeze({
  1: (ex: PageExamples) => ({
    version: 1,
    note: "Landing page Phase 2 slice 2 (2026-10-07): 9 skeleton parts + the story test, 28 dimensions.",
    parts: v1Parts(ex),
  }),
});

export const CURRENT_PAGE_RUBRIC = 1;

/** A page rubric version (its examples from the active profile, server only), or null when there is no such version. */
export function pageRubric(version: number, ex: PageExamples = profile().pages): PageRubric | null {
  return Object.hasOwn(PAGE_RUBRICS, version) ? PAGE_RUBRICS[version](ex) : null;
}

/** The part with this id in a version, or null. */
export function pagePart(rubric: PageRubric, id: string): PagePart | null {
  return rubric.parts.find((p) => p.id === id) ?? null;
}
