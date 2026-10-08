# Landing page scorer CLI (scripts/score-page.ts)

The page scorer has Jev (TypeSafe) score the sections of a landing page, one section at a time, against a fixed page
rubric. It reads the same channel context as the Hooks tab (the lane's brief, notes, who's who and avatars), so a page
for a client is judged against that client's notes.

It is **advisory**: it blocks nothing and changes nothing in Studio. Use it from a terminal or from your own page
building tool to compare a draft with a rewrite.

Scoring costs money: one Jev call per section. `--resolve` is free. See
[../integrations/typesafe-jev.md](../integrations/typesafe-jev.md) for prices and the daily cap.

Code: `scripts/score-page.ts` (the CLI), `src/lib/pages/pagegate.ts` (request schema, resolve, score),
`src/lib/pages/rubric.ts` (the page rubric), `src/lib/pages/score.ts` (state, questions, arithmetic).

## Contents

- [Run it](#run-it)
- [Request (stdin)](#request-stdin)
- [Page rubric v1](#page-rubric-v1)
- [Response (stdout)](#response-stdout)
- [Example](#example)
- [Caching your scores](#caching-your-scores)
- [Errors and exit codes](#errors-and-exit-codes)

## Run it

From the repo root:

```bash
npx tsx scripts/score-page.ts < page.json
```

Free and read only (versions, the context fingerprint and each section's key, no Jev call, the database opened read
only):

```bash
npx tsx scripts/score-page.ts --resolve < page.json
```

- `--resolve` is the only flag. Any other argument exits 1.
- It reads the same config as the app and needs a database Studio has already created and migrated. It never creates,
  migrates or seeds one. The app and the worker do not need to be running.
- stdout carries only the JSON line; logs go to stderr. Sections are scored two at a time.

## Request (stdin)

| Field | Type | Rules |
|---|---|---|
| `code` | string | 1 to 40 characters: a client code of the Clients lane, exactly `fkb` (the Company lane) or exactly `rtm` (the Brand lane). Same rule as the [copy gate](copy-gate-cli.md#codes). |
| `page_rubric_version` | integer, optional | default: the current page rubric (1). An unknown version exits 1. |
| `page` | object, optional | `{ url?, site?, stage?, headline? }`. `url` up to 2,000 characters, `site` up to 80, `stage` up to 40, `headline` up to 500 (or null). |
| `voice` | string[], optional | up to 50 verbatim snippets of how your market talks, each up to 5,000 characters (a longer one is refused, exit 1); Jev reads the first 15, each clipped to 300 characters |
| `sections` | array | 1 to 12 sections, unique `id`s, at most one section per `part` |
| `sections[].id` | string | 1 to 200 characters, your own id |
| `sections[].part` | string | one of the page rubric's parts (below) |
| `sections[].heading` | string, optional | up to 500 characters (or null) |
| `sections[].text` | string | up to 5,000 characters; Jev reads the first 1,500. May be empty only when `ctas` has items. |
| `sections[].ctas` | string[], optional | up to 20 button labels, each 1 to 200 characters after trimming (an empty or blank label is refused) |

Notes:

- `page.headline` is what every section sees as the page's headline. When it is missing, the `headline` section's text
  is used.
- `url` and `stage` are not part of what Jev reads, so the same words score the same at every stage.
- For the `story` part, put the page headline and every section heading in `text`, one per line.

## Page rubric v1

The page rubric is a versioned constant in code, not a row you edit on the Rubric page. A version never changes: any
wording change adds a new version, so an old draft can be rescored on the version a newer one used. Each dimension is
one Jev score question with five levels, reported as a number from 1 (low) to 5 (high) with one decimal (Jev's 0 to 4
score plus 1, rounded to 0.1).

| Part | Label | Freight | Dimensions (id: label) |
|---|---|---|---|
| `eyebrow` | Eyebrow | yes | `audience_callout`: Audience callout, `proof_token`: Proof token |
| `headline` | Headline | yes | `specific_person`: Specific person, `dream_outcome`: Dream outcome, `time_or_mechanism`: Time frame or method, `clear_not_clever`: Clear, not clever |
| `subheadline` | Subheadline | yes | `adds_specifics`: Adds specifics, `open_loop`: Open loop |
| `problem` | Problem | no | `intimacy`: Intimacy, `market_words`: Market words, `reader_focus`: Reader focus |
| `solution` | Solution | no | `alternatives_named`: Alternatives named, `named_mechanism`: Named method, `fix_ties_to_failure`: Fix ties to failure |
| `proof` | Proof | no | `jury_grade`: Jury grade proof, `backs_the_promise`: Backs the promise |
| `offer` | Offer | yes | `named_session`: Named session, `concrete_takeaway`: Concrete takeaway, `food_court_test`: Food court test, `free_with_reason`: Free with a reason |
| `cta` | Call to action | yes | `vivid_label`: Vivid label, `what_happens_next`: What happens next, `one_wording_family`: One wording family |
| `ps` | P.S. | yes | `restates_offer`: Restates the offer, `next_step`: Next step, `cost_of_inaction`: Cost of inaction |
| `story` | Story test | no | `story_complete`: Story complete, `hooks_not_labels`: Hooks, not labels |

10 parts, 6 freight parts, 28 dimensions. Version 1's `offer` part is written for a page whose offer is a free call or
session (a named session, a takeaway, a value, an honest reason it is free); a page with another kind of offer will
score low there. Two example phrases inside v1's wording come from the business profile's `pages` keys
(`broadGroup`, `proofExample`).

## Response (stdout)

Scoring (one JSON line):

| Field | Type | Meaning |
|---|---|---|
| `page_rubric_version` | integer | the page rubric used |
| `hook_rubric_version` | integer | the current hook rubric version (global) |
| `section_version` | integer | the code's section version on that hook rubric (what the context was built on) |
| `context_fp` | string | 16 hex characters over the page rubric version, the pinned Jev model id, the context blocks Jev reads (brief, notes, hint, who's who, What works here, avatars offered) and the voice snippets |
| `model` | string | the model id Jev answered with, else the pinned id |
| `sections` | array | one per section, in request order |
| `page_score` | number or null | mean of every scored section's score, 2 decimals |
| `freight_score` | number or null | mean over the freight parts only |
| `cost_usd` | number | cost of the calls that succeeded |

Each section:

| Field | Type | Meaning |
|---|---|---|
| `id`, `part` | string | as sent |
| `key` | string | sha256 (hex) of the request side of the section: the page's `site` and headline, the part, and the section's heading, clipped text and CTAs |
| `scored_text_chars` | integer | how many characters of `text` Jev read (at most 1,500) |
| `score` | number or null | mean of the dimension levels, 2 decimals; `null` = not scored |
| `band` | string | `high` (3.5 to 5), `mid` (2.5 to 3.4), `low` (below 2.5) or `unscored` |
| `dims` | object | dimension id to level: a number from 1 to 5 with one decimal (not an integer), e.g. `3.8` |
| `why` | string[] | labels of the dimensions at level 2.0 or below |
| `unsure` | string[] | dimension ids whose answer was unsure |
| `error` | string or null | `<kind>: <message>` on an unscored section |

`--resolve` returns `page_rubric_version`, `hook_rubric_version`, `section_version`, `context_fp` and `sections` with
only `id`, `part`, `key` and `scored_text_chars` each.

## Example

A draft headline and offer for the demo bakery client (`page.json`):

```json
{
  "code": "crumb",
  "page": { "site": "Crumb and Crust Bakery", "stage": "draft" },
  "voice": ["I never get to the bakery before the sourdough is gone"],
  "sections": [
    { "id": "S1", "part": "headline", "text": "Fresh sourdough every Saturday, saved for you" },
    {
      "id": "S5",
      "part": "offer",
      "heading": "The 20 minute tasting visit",
      "text": "Come by on a weekday afternoon, taste three loaves and leave with a slice of the cake of the week. Free, because we would rather you try before you order a weekend box.",
      "ctas": ["Pick a tasting time"]
    }
  ]
}
```

Response (shown wrapped; numbers made up to show the shape):

```json
{
  "page_rubric_version": 1,
  "hook_rubric_version": 1,
  "section_version": 1,
  "context_fp": "a3f09c6d12e47b58",
  "model": "jev-1.13.0",
  "sections": [
    {
      "id": "S1",
      "part": "headline",
      "key": "5d1e8c0f3b6a9e2d7c4f1a8b5e2d9c6f3a0b7e4d1c8f5a2b9e6d3c0f7a4b1e8d",
      "scored_text_chars": 45,
      "score": 3.25,
      "band": "mid",
      "dims": { "specific_person": 2.0, "dream_outcome": 4.1, "time_or_mechanism": 3.9, "clear_not_clever": 3.0 },
      "why": ["Specific person"],
      "unsure": [],
      "error": null
    },
    {
      "id": "S5",
      "part": "offer",
      "key": "c2a7e1f4b9d6c3a0e7b4d1f8a5c2e9b6d3a0f7c4e1b8d5a2f9c6e3b0d7a4f1c8",
      "scored_text_chars": 168,
      "score": 3.75,
      "band": "high",
      "dims": { "named_session": 4.1, "concrete_takeaway": 3.8, "food_court_test": 3.2, "free_with_reason": 3.9 },
      "why": [],
      "unsure": ["food_court_test"],
      "error": null
    }
  ],
  "page_score": 3.5,
  "freight_score": 3.5,
  "cost_usd": 0.00034
}
```

## Caching your scores

A score is safe to reuse while these five values are the same: `code`, `part`, `key`, `page_rubric_version` and
`context_fp`. Run `--resolve` (free) first, look the keys up in your cache, and only score the sections that changed.
`context_fp` moves when anything Jev reads about the channel moves (a notes edit, a rubric edit that changes the brief
or the avatars, another Jev model), and not when only the hook rubric's dimensions change.

## Errors and exit codes

| Exit code | When |
|---|---|
| 0 | the request was valid, even when Jev could not score some or all sections (they come back with `score: null` and an `error`) |
| 1 | an unknown argument; stdin is not JSON; a wrong shape (the first problem is printed on stderr); two sections with the same part; an unknown part, code or `page_rubric_version`; a config error; no database at the configured path; a database behind the repo's migrations ("restart Studio first") |

Section errors follow the copy gate's rules (see [copy-gate-cli.md](copy-gate-cli.md#errors-and-exit-codes)): `nokey`,
`cap` and `auth` stop further calls and mark the rest; `unavailable` fails its own section until 3 in a row; a 422
(`request`) fails that section only; `error: score not computed` when no score came out.

It writes nothing but `ai_calls` rows (purpose `page_score`), which count toward the daily cap. No hooks, scores,
notes, rubric versions or settings.
