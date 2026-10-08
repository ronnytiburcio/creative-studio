# Ad order files (new PAUSED ads)

Studio never writes to Meta. When you click **Stage** in the New PAUSED ad dialog, Studio checks the copy and the media
again on the server and writes ONE order file. An outside **ad apply script** (for example one you run in a Claude Code
session after you approve the copy) reads that file, creates the ad PAUSED in Meta, and writes the outcome back into
the same file. The Studio worker reads the file back every 60 seconds and shows the status on the Jobs page, on hook
rows and on Running cards.

This page is for developers who build or adapt the apply side. For the dialog, see
[../guide/running.md](../guide/running.md).

Code: `src/lib/meta/orders.ts` (the writer, the read back, Cancel), `src/lib/privatefile.ts` (the private file writer
and the order lock), `src/lib/meta/ad-copy-rules.ts` (the copy checks and `AD_RULES_VERSION`), `src/lib/meta/new-ad.ts`
(channels, media checks, the next ad number).

## Contents

- [Folders and file names](#folders-and-file-names)
- [The order file (schema 1)](#the-order-file-schema-1)
- [Example](#example)
- [Statuses and who writes them](#statuses-and-who-writes-them)
- [The order lock](#the-order-lock)
- [What an apply script must do](#what-an-apply-script-must-do)
- [Versioning: checks.rules_version](#versioning-checksrules_version)
- [What Studio reads back](#what-studio-reads-back)
- [Failure handling](#failure-handling)

## Folders and file names

| Lane | Folder setting | Default |
|---|---|---|
| Clients lane | `META_PENDING_DIR` | `~/Studio-Data/pending-clients` |
| Company lane | `META_FKB_PENDING_DIR` | `~/Studio-Data/pending-company` |

Both folders must be absolute, not `/`, not on the media drive (by lexical or real path), not inside a git working tree
(order files never belong in a repo), and the two must differ. The config checks these rules at startup and fails fast.
The writer checks them again before every write, and only then also checks that the folder is a plain folder, not a
symlink (the startup check does not look at symlinks), and checks the folder's real path once more. Only the folder
itself is created (mode 0700), on the first Stage; its parent must exist.

File names: `STUDIO-<yyyy-mm-dd>-<code>-<shortid>.json`

- `<yyyy-mm-dd>` is the day in America/New_York when the order was staged.
- `<code>` is the client code for the Clients lane, `fkb` for the Company lane.
- `<shortid>` is the order's `studio_order_id` (12 lowercase hex characters from Studio).
- Studio only accepts names matching `^STUDIO-\d{4}-\d{2}-\d{2}-[a-z0-9]+-[a-z0-9]{6,}\.json$`.

Each file is created with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, fsynced, at most 64 KB, a JSON object. An existing
file is never overwritten.

An apply script that lives outside the app can read the two folder paths from Studio's env file (only the keys
`META_PENDING_DIR` and `META_FKB_PENDING_DIR`, with the process env winning and the same defaults), so it always looks
where Studio writes.

## The order file (schema 1)

Studio writes every field below with `status: "staged"`. The apply script adds its own fields (next sections) and keeps
every field it does not own.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"studio_ad"` | always this value |
| `schema` | `1` | the file format version |
| `status` | string | `"staged"` when Studio writes it; see [statuses](#statuses-and-who-writes-them) |
| `studio_order_id` | string | 12 hex characters; also in the file name and in Studio's `ad_orders` row |
| `created_at` | string | ISO 8601 time of staging (UTC) |
| `channel` | object | `{ "section": "fkbpros" \| "fkb", "code": "<client code>" \| "fkb" }`: the Clients lane (`fkbpros`) with a client code, or the Company lane (`fkb`) |
| `act` | string | the Meta ad account id, `act_<digits>` |
| `media` | object | `{ kind: "video" \| "image", path, file_name, bytes, fingerprint }`. `path` is the real absolute path of the original, checked through `originalFileFor()`. `fingerprint` is Studio's sampled sha256 (or null). |
| `angle_key` | string or null | the angle slug (letters, digits, `:`, `_`, `-`, up to 80) from the hook or a matched ad |
| `concept` | string or null | Clients lane only: 1 to 48 characters of lowercase letters, digits and `_`; the first and last character must be a letter or digit, and `__` (two in a row) is refused (`CONCEPT_RE` plus `conceptProblem` in `ad-copy-rules.ts`). No `-`: the ad name is hyphen delimited. `null` for the Company lane. |
| `ps_obj` | `"ps"`, `"obj"` or null | Clients lane only: `ps` = problem / solution, `obj` = objection. `null` for the Company lane. |
| `name_preview` | string | the planned ad name. Clients lane: `[<ads.clientPrefix>-]<code>-<concept>-<ps\|obj>-<nn>`. Company lane: `<ads.companyPrefix> <n>` (neutral prefix `Ad`). The apply script assigns the real number when it creates the ad. |
| `headlines` | string[] | 3 to 5 |
| `primaries` | string[] | 2 to 3 (primary texts; may hold line breaks) |
| `description` | string | exactly one |
| `cta` | `"LEARN_MORE"` | the call to action type |
| `landing` | string | the landing page URL from the business profile (`adCopy.landing.client`, where `{code}` is replaced, or `adCopy.landing.company`). Stage refuses a channel without one. |
| `hook_ids` | number[] | Studio hook ids this ad carries (up to 20) |
| `source` | object | `{ "from": "hook" \| "winner" \| "library", "ref": string \| null }`: where the dialog was opened. `ref` is clipped to 40 characters. |
| `checks` | object | `{ "passed": true, "rules_version": <AD_RULES_VERSION> }` |
| `notes` | string or null | your note to the apply session, up to 500 characters |

### Copy rules Studio enforced before writing

Studio cleans the copy first (line endings to LF, trailing spaces and outer blank lines removed; a line break inside a
headline or the description becomes a space), then runs every rule below. Any problem blocks Stage. An apply script that
re-checks the copy must mirror all of them for the same `checks.rules_version`.

Every line (each headline, each primary, the description):

- Not empty (a line of only spaces counts as empty).
- The profile's ad dash policy (`copyRules.dashes.ads`). `punctuation`: no unicode dash (em, en, figure, horizontal bar,
  minus and similar), no `" - "` and no `--`, and no line that starts with `- ` (a hyphen bullet). `none`: also no hyphen
  at all. `allowed`: not checked.
- None of the ad map's `forbidden_terms`, matched as whole words, case-insensitive (Python `\b` semantics).
- No client name when the lane bans names (`copyRules.banClientNames`): for a Clients lane ad, the client's own name
  parts; for a Company lane ad, every client's name parts and "Never name" items. A Clients lane ad also always refuses
  its client notes' "Never name ..." and "Never speak as ..." items.
- None of the notes' "Never say ..." phrases (the client's notes; the Company lane's own notes for a Company lane ad).
- The notes' "Claims not allowed:" lines: licensed, insured, bonded, a warranty, a star rating, a founding year or years
  in business, each refused only when that line names it.
- The price and financing bans. A ban comes from the channel's fixed bans (`copyRules.bans[code]`) or from a "Claims not
  allowed:" line that mentions a price (`price`, `prices`, `price range`, `dollar price`, `any price`) or financing
  (`financ...`, `payment plan`, `monthly payment`). These are regex bans, not phrase matches:
  - price: `/\$|\b\d[\d,]*\s*(dollars|bucks)\b/i`
  - financing: `/\bfinanc(e|ed|es|ing)\b|\d\s*(\/|a|per)\s*mo(nth)?\b|\bper month\b|\bmonthly payments?\b|\bpayment plans?\b|\bno money down\b|\b0% apr\b/i`
- No AI tell phrase (the `AI_TELLS` list in `src/lib/hooks/variant-rules.ts`, case-insensitive).

Per field:

| Field | Rules |
|---|---|
| Headline | one line; no emoji; at most 255 characters (a warning, not a problem, over 40) |
| Primary | no URL (`http://`, `https://` or `www.`); emoji only from the profile's `adCopy.emojiPalette`; at most 2,000 characters (a warning when a multi-line primary's first line is over 125 characters, the "See more" fold) |
| Description | one line; no emoji; at most 255 characters (a warning over 30) |

The set:

- 3 to 5 headlines, 2 to 3 primaries, exactly one description, and no empty slot left in either list.
- No two headlines and no two primaries the same (compared case-insensitively with spaces collapsed).
- When the channel has no price ban, a `$` may appear in the headlines or in the primaries, not in both.

Emoji means a character in U+1F300 to U+1FAFF, U+2600 to U+27BF or U+2B00 to U+2BFF.

Media: videos must be MP4, MOV or M4V and at most 100 MB (a warning above 45 MB); images JPG or PNG up to 30 MB.

## Example

An order for the demo bakery client, staged on 2026-10-08, file
`~/Studio-Data/pending-clients/STUDIO-2026-10-08-crumb-3f9a1c2b7d4e.json`. The profile in this example sets
`adCopy.landing.client` to `https://example.com/{code}`.

```json
{
  "kind": "studio_ad",
  "schema": 1,
  "status": "staged",
  "studio_order_id": "3f9a1c2b7d4e",
  "created_at": "2026-10-08T15:42:10.512Z",
  "channel": { "section": "fkbpros", "code": "crumb" },
  "act": "act_100000000000021",
  "media": {
    "kind": "image",
    "path": "/Users/you/Studio-Media/Clients/Crumb and Crust Bakery/static-weekend-box.jpg",
    "file_name": "static-weekend-box.jpg",
    "bytes": 184233,
    "fingerprint": "9b1d4f0e7c2a5b8d3e6f9a0c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d"
  },
  "angle_key": "weekend_box",
  "concept": "weekend_box",
  "ps_obj": "ps",
  "name_preview": "crumb-weekend_box-ps-01",
  "headlines": [
    "Saturday bread, sorted",
    "The weekend box is back",
    "Sourdough, pastries and a cake slice"
  ],
  "primaries": [
    "Tired of the 7 AM bread line? Our weekend box holds a sourdough loaf, four pastries and a slice of the cake of the week.\n\n✅ Order by Thursday\n✅ Pick up Saturday morning",
    "Forty loaves leave the oven every Saturday. Reserve yours in the weekend box and skip the line."
  ],
  "description": "Pick up Saturday",
  "cta": "LEARN_MORE",
  "landing": "https://example.com/crumb",
  "hook_ids": [14],
  "source": { "from": "hook", "ref": "14" },
  "checks": { "passed": true, "rules_version": 2 },
  "notes": "Use the warmer crop if Meta asks for 4:5."
}
```

After a successful apply the same file also carries, for example:

```json
{
  "status": "applied",
  "ad_id": "120211234567890123",
  "ad_name": "crumb-weekend_box-ps-07",
  "creative_id": "120211234567890456",
  "applied_at": "2026-10-08T16:05:33Z"
}
```

## Statuses and who writes them

The file is the source of truth; Studio's `ad_orders` row mirrors it.

| Status | Written by | When | Fields that come with it |
|---|---|---|---|
| `staged` | Studio (Stage) | the order is written | everything in [the schema](#the-order-file-schema-1) |
| `applying` | the apply script | it claimed the order (from `staged`) | `apply_step` (the current step, up to 40 characters), `apply_started_at` (ISO), `error: null`; rewrite `apply_step` at every step |
| `applied` | the apply script | the ad exists in Meta, PAUSED | `ad_id`, `ad_name`, `creative_id`, `applied_at`; drop `apply_step` and `apply_started_at` |
| `failed` | the apply script | it stopped | `failed_step` (up to 40 characters), `error` (short, with secrets scrubbed), and every id made so far (an `ad_id` when the ad step was reached) |
| `cancelled` | Studio (Cancel) | only from `staged` | `cancelled_at` (ISO) |
| `missing` | Studio's row only, never in a file | the file is gone from its folder | none |

Rules:

- Studio only ever writes `staged` (a new file) and `cancelled` (its own staged order).
- `failed` may go back to `applying` only when you explicitly ask the apply script to retry, and never when the failed
  order already has an `ad_id` (the ad exists: check Ads Manager instead).
- Cancel is refused while the row or the file says `applying`.
- An order still `applying` 30 minutes after `apply_started_at` shows "may have stopped at step X (still applying after
  30 minutes: check the Claude session)". Studio never turns it into `failed` by itself.
- After Stage, Studio shows a line to paste into the apply session:
  `Apply the Studio ad order <path>: create it PAUSED (<skill>), confirm the copy with me first, never activate.`
  `<skill>` comes from the profile's `skills.adApplyClients` or `skills.adApplyCompany`.

## The order lock

Every read, check and write of an order file, on both sides, happens while holding a lock file, so a Cancel can never
race an apply claim.

- **Name:** `.<order file name>.lock`, in the order's own folder. Example:
  `.STUDIO-2026-10-08-crumb-3f9a1c2b7d4e.json.lock`.
- **Take it:** create the file with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600. Studio writes
  `{"holder": "<app slug> cancel", "pid": <pid>, "at": "<ISO time>"}` into it; the content is informational.
- **Held:** if the file exists and its mtime is less than 2 minutes old, someone holds it. Do nothing and try again
  later (Studio's Cancel then says "The order is being applied, try again.").
- **Stale:** a lock older than 2 minutes is stale (no holder keeps it longer than one read and one write). It may be
  broken: check that the inode and mtime are still the ones you judged stale, then unlink it and take a new one.
- **Release:** remove the lock right after the write, and only if it is still yours (same inode).
- Hold it for one read, check and write at a time, never across a whole apply.

## What an apply script must do

1. Read the order file. Refuse it unless `kind` is `studio_ad`, `schema` is `1`, and `checks.rules_version` equals the
   rules version the script mirrors.
2. Under the lock, re-read the file and claim it: `staged` to `applying`, with `apply_step`, `apply_started_at` and
   `error: null`. Refuse any other status (a `failed` order only on an explicit retry, and never one with an `ad_id`).
3. Before each step, under the lock, rewrite `apply_step`.
4. Create the ad in the account `act`, PAUSED, with the order's media, headlines, primaries, description, `cta` and
   `landing`. **Never activate it.** Name it by the lane's pattern with the next free number.
5. Under the lock, end with `applied` (plus `ad_id`, `ad_name`, `creative_id`, `applied_at`; drop the apply fields) or
   `failed` (plus `failed_step`, a short scrubbed `error`, and any ids made so far).
6. Keep every other field as Studio wrote it. Write through a temp file in the same folder and rename it over the
   order, as Studio's Cancel does, so a reader never sees half a file.
7. Never put a token or a key in the file, and never write any other file in the folder.

A good apply script also defaults to a dry run (every check and read only request, printing what it would send) and
only creates the ad on an explicit flag.

## Versioning: checks.rules_version

`AD_RULES_VERSION` in `src/lib/meta/ad-copy-rules.ts` (currently 2) is written into every order as
`checks.rules_version`. An apply script that re-checks the copy must mirror the same rules and refuse any order whose
version differs from the one it mirrors, so the two rule sets cannot drift apart silently. A change to any copy rule,
in code or in the profile's ad house rules (dash policy, client name bans, fixed bans, emoji palette), means bumping
`AD_RULES_VERSION` and updating the apply script in the same change.

The file's own `schema` stays 1 until a field changes meaning. New optional fields may be added; Studio ignores fields
it does not know.

## What Studio reads back

The worker reads every order whose status may still change (`staged`, `applying`, `failed`, `missing`) every 60
seconds. A read only accepts a file whose real folder is one of the two configured folders, whose name matches the
pattern, that is not a symlink, is a regular file of at most 64 KB, and parses as JSON with this shape (extra keys are
ignored):

| Field | Accepted |
|---|---|
| `kind` | `"studio_ad"` |
| `schema` | `1` |
| `status` | `staged`, `applying`, `applied`, `failed`, `cancelled` |
| `studio_order_id` | `^[a-z0-9]{6,40}$`, and equal to Studio's row |
| `ad_id`, `creative_id` | a string of 5 to 30 digits, or null |
| `ad_name` | a string up to 300 characters, or null |
| `applied_at`, `apply_started_at` | a string up to 64 characters, or null |
| `error` | a string (stored up to 500 characters), or null |
| `failed_step`, `apply_step` | a string up to 40 characters, or null |

Once `ad_id` is known, Studio's Meta sync keeps that ad in scope even while it has no delivery, matches it to the media
file, and the Running tab lists it under Paused with "Staged in Studio".

## Failure handling

| Situation | What Studio does |
|---|---|
| The file is gone | status `missing` (shown on the Jobs page) |
| The file is not JSON, has another shape, a symlink, over 64 KB | keeps the last status and stores a short read error on the row |
| The file's `studio_order_id` does not match the row | keeps the last status, read error "The file's studio_order_id does not match this order." |
| A write at Stage fails | no row is kept (the row and the file are made in one transaction) |
| Cancel finds a fresh lock | refused: "The order is being applied, try again." |
| Cancel finds a stale lock | breaks it, cancels, and says a stale lock was cleared |
| The file says `applying` or anything but `staged` | Cancel is refused and nothing changes |
