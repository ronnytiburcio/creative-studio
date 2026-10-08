# Copy gate CLI (scripts/score-copy.ts)

The copy gate scores NEW ad copy (headlines and primary texts) with the same rubric, notes and questions the Hooks tab
uses, before you publish it. It is a command line tool, so an outside script (an ad builder, an apply script, your own
checks) can call it and read one JSON line back.

It costs money: one Jev (TypeSafe) call per line. See [../integrations/typesafe-jev.md](../integrations/typesafe-jev.md)
for prices and the daily cap.

Code: `scripts/score-copy.ts` (the CLI), `src/lib/hooks/copygate.ts` (`copyGateRequestSchema`, `scoredTextFor`,
`copyGateVerdict`, `copyGateChannel`, `scoreCopyLines`).

## Contents

- [Run it](#run-it)
- [Request (stdin)](#request-stdin)
- [Codes](#codes)
- [What is scored](#what-is-scored)
- [The pass rule](#the-pass-rule)
- [Response (stdout)](#response-stdout)
- [Example](#example)
- [Errors and exit codes](#errors-and-exit-codes)
- [What it writes](#what-it-writes)

## Run it

From the repo root, with the request in a file:

```bash
npx tsx scripts/score-copy.ts < request.json
```

- It reads the same config as the app (process env, then the env file, then the Studio config's `env`, then the
  defaults), so it finds the same database and the same Jev key.
- Studio must have been started at least once after your last update, so the database exists and is migrated. The CLI
  never creates, migrates or seeds a database.
- The app and the worker do not need to be running.
- stdout carries only the JSON line. Every log line goes to stderr.
- Lines are scored two at a time.

## Request (stdin)

One JSON object:

| Field | Type | Rules |
|---|---|---|
| `code` | string | 1 to 40 characters, trimmed. See [codes](#codes). |
| `lines` | array | 1 to 500 items, unique `id`s |
| `lines[].id` | string | 1 to 200 characters, your own id (it comes back in the result) |
| `lines[].field` | `"headline"` or `"primary"` | |
| `lines[].text` | string | not empty, at most 5,000 characters |

## Codes

| Code | Scores as |
|---|---|
| a client code of the Clients lane (for example `crumb`) | that client: its brand notes, hint, What works here, the shared notes and the Clients lane's dimensions and avatars |
| exactly `fkb` | the Company lane's own section (no client): its notes, hint, What works here and dimensions |
| exactly `rtm` | the Brand lane (no client): its notes, brief, avatars and dimensions, as a Brand lane hook is scored |

`fkb` and `rtm` are the fixed internal lane keys (see [../configuration.md](../configuration.md)); a client can never
have those codes. Any other code that is not a client code is refused (exit 1).

## What is scored

Jev reads one piece of each line, the part a reader sees before "more":

- **headline:** the whole text, trimmed.
- **primary:** the first rule that applies:
  1. everything before the first line that starts with ✅, when that line is not line 1;
  2. else, when the text has a blank line paragraph break, the first two paragraphs;
  3. else the first two sentences.

The piece that was scored comes back as `scored_text`.

## The pass rule

- Each dimension level is a number from 1 to 5 with one decimal (Jev's 0 to 4 score plus 1, rounded to 0.1, so a
  level can read 2.7, not only 3). `overall` is the mean of the levels that apply to a text hook in that channel.
- A **headline** passes when `overall` is at least 3.0. Its Three P's are reported, never required.
- A **primary** passes when `overall` is at least 3.0 AND all three P's (person, pain, promise) are clear (Jev's
  P(yes) at least 0.5).
- `why` lists the dimensions at level 2.0 or below (by label), plus `missing person` / `missing pain` /
  `missing promise` for a primary. A failing line with nothing else to name gets `overall below 3.0`.
- An unsure answer counts at its value and is listed in `unsure`. Being unsure never fails a line by itself.
- An overall that is not a finite number is not a score: `pass: null` with `error: "error: overall not computed"`.

## Response (stdout)

One JSON line:

| Field | Type | Meaning |
|---|---|---|
| `rubric_version` | integer | the code's section version of the current rubric (it only moves when that section's scoring content changed). Use it as your cache key. |
| `rubric_version_global` | integer | the current rubric version itself |
| `context_fp` | string | 16 hex characters: a fingerprint of everything Jev reads besides the line (the channel's brief, notes, hint, What works here, who's who, avatars and the questions). Same rubric and same notes give the same value; any edit Jev would see moves it. |
| `model` | string | the pinned Jev model id (`STUDIO_JEV_MODEL`) |
| `results` | array | one per line, in request order |
| `cost_usd` | number | the cost of the calls that succeeded (the `ai_calls` table is the full ledger) |

Each result:

| Field | Type | Meaning |
|---|---|---|
| `id`, `field` | | as sent |
| `scored_text` | string | what Jev read (see above) |
| `overall` | number or null | 2 decimals |
| `band` | string | `high` (3.5 to 5), `mid` (2.5 to 3.4), `low` (below 2.5) or `unscored` |
| `dims` | object | dimension id to level: a number from 1 to 5 with one decimal (not an integer), e.g. `{"specificity": 3.8, "brand_fit": 3.1}` |
| `pp` | object or null | `{person, pain, promise}` as booleans (P(yes) at least 0.5) |
| `pp_p` | object or null | the same three as probabilities |
| `avatar` | string or null | the avatar slug Jev picked from the rubric's avatars for that channel |
| `style` | string or null | the copy mechanic id (for example `lead_number`, `curiosity_loop`, `none`) |
| `stops_scroll` | number or null | P(yes) that the line stops the scroll |
| `unsure` | string[] | question ids whose answer was unsure |
| `pass` | boolean or null | `null` = not scored (see `error`) |
| `why` | string[] | see [the pass rule](#the-pass-rule) |
| `error` | string | only on an unscored line: `<kind>: <message>` |

The dimension ids, labels, mechanics and avatars come from the current rubric version (Rubric page), so they follow
your edits there.

## Example

Request (`request.json`) for the demo bakery client:

```json
{
  "code": "crumb",
  "lines": [
    { "id": "h1", "field": "headline", "text": "Saturday bread, sorted" },
    {
      "id": "p1",
      "field": "primary",
      "text": "Tired of the 7 AM bread line? Our weekend box holds a sourdough loaf and four pastries.\n✅ Order by Thursday\n✅ Pick up Saturday"
    }
  ]
}
```

Response (one line, shown wrapped):

```json
{
  "rubric_version": 1,
  "rubric_version_global": 1,
  "context_fp": "4e0c9b1a7d2f6e38",
  "model": "jev-1.13.0",
  "results": [
    {
      "id": "h1",
      "field": "headline",
      "scored_text": "Saturday bread, sorted",
      "overall": 2.6,
      "band": "mid",
      "dims": { "specificity": 3.1, "avatar_match": 2.0, "curiosity_gap": 2.9, "offer_clarity": 1.8, "brand_fit": 3.2 },
      "pp": { "person": false, "pain": false, "promise": true },
      "pp_p": { "person": 0.21, "pain": 0.18, "promise": 0.66 },
      "avatar": null,
      "style": "none",
      "stops_scroll": 0.31,
      "unsure": ["curiosity_gap"],
      "pass": false,
      "why": ["Avatar match", "Offer clarity"]
    },
    {
      "id": "p1",
      "field": "primary",
      "scored_text": "Tired of the 7 AM bread line? Our weekend box holds a sourdough loaf and four pastries.",
      "overall": 3.6,
      "band": "high",
      "dims": { "specificity": 4.2, "avatar_match": 3.1, "curiosity_gap": 2.8, "offer_clarity": 4.0, "brand_fit": 3.9 },
      "pp": { "person": true, "pain": true, "promise": true },
      "pp_p": { "person": 0.71, "pain": 0.83, "promise": 0.77 },
      "avatar": "clients_burned_before",
      "style": "negative",
      "stops_scroll": 0.64,
      "unsure": [],
      "pass": true,
      "why": []
    }
  ],
  "cost_usd": 0.00031
}
```

The numbers above are made up to show the shape.

## Errors and exit codes

| Exit code | When |
|---|---|
| 0 | the request was valid. This includes runs where Jev could not score some or all lines: those come back with `pass: null` and an `error`. |
| 1 | stdin is not JSON; the request shape is wrong (the first problem is printed on stderr, e.g. `bad request: lines.0.text: text is empty`); an unknown code; a config error; no database at the configured path; the database is behind the repo's migrations (stderr says "restart Studio first"). Nothing is written to stdout. |

A line's `error` starts with its kind:

| Kind | Meaning | Effect on the rest of the run |
|---|---|---|
| `nokey` | no `TYPESAFE_API_KEY` in the env file | every later line gets the same error, no more calls |
| `cap` | the daily Jev cap would be passed | same: the run stops calling |
| `auth` | the key was refused | same: the run stops calling |
| `unavailable` | Jev is down after the adapter's retries | only that line, until 3 lines in a row hit it; then the rest stop |
| `request` | Jev refused this request (422) | only that line |
| `error` | anything else, including an overall that could not be computed | only that line |

## What it writes

Only `ai_calls` rows (one per call that reached Jev, purpose `copy_gate`), which also count toward the daily cap. It
never writes hooks, scores, notes or anything else, and it never reads or prints the key beyond sending it in the
Authorization header.
