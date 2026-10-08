# Reel kit notes and the kit VERSION file

A "reel kit" is one versioned look for your reels (the opening headline, the cold open, the graphics), kept by your
reel cutting tool in its own folder. Studio never writes the kit, a reel folder or a kit note. It only reads:

- the kit's `VERSION` file, so a Cut reel hand-off in the `kit` format can name the version
  (see [cut-reel-handoff.md](cut-reel-handoff.md));
- one small JSON note next to each reel (`<reel stem> kit.json`), so the Shorts tab can tell which kit version made a
  reel, whether the reel tested a change, and how its YouTube "% viewed" compares.

This page is for developers who write those files from a reel tool. For the Shorts tab, see
[../guide/shorts.md](../guide/shorts.md).

Code: `src/lib/shorts/kit.ts` (`readKitVersion`, `kitNoteNameFor`, `kitNoteSchema`, `syncKitNotes`, `kitTests`),
`src/lib/textread.ts` (`statKitNote`, `readKitNote`), `src/app/api/reels/kit-tests/route.ts`.

## Contents

- [The VERSION file](#the-version-file)
- [Kit notes](#kit-notes)
- [Example](#example)
- [What Studio does with the notes](#what-studio-does-with-the-notes)
- [GET /api/reels/kit-tests](#get-apireelskit-tests)
- [Failure handling](#failure-handling)

## The VERSION file

| | |
|---|---|
| Where | `<STUDIO_REEL_KIT_DIR>/VERSION`. Default folder: `~/.studio/reel-kit`. The folder must be absolute, not `/` and not on the media drive (the config refuses anything else). |
| Who writes it | your reel tool, when the kit changes |
| Who reads it | Studio, only when Cut reel uses the `kit` format. Nothing else in that folder is ever opened. |
| Content | a whole number from 1 to 9999, optionally followed by whitespace or a newline, e.g. `3\n` |
| Limits | a regular file (a symlink is refused), at most 16 bytes, not on the media drive by lexical or real path |
| When it is missing or odd | Studio uses version 1 |

## Kit notes

| | |
|---|---|
| Name | the reel's file name without its extension and without a trailing ` vN` version, plus ` kit.json`. `Episode 1 Reel 2 v3.mp4` and `Episode 1 Reel 2.mp4` both use `Episode 1 Reel 2 kit.json`. |
| Where | in the same folder as the reel video, inside an enabled root |
| Who writes it | your reel tool, once per reel (rewrite it when the reel's kit facts change) |
| Who reads it | the Studio worker, every 60 seconds, for every visible video in the Brand lane |
| Limits | `.json`, a regular file of at most 64 KB; the requested name AND the real name (after symlinks) must end in ` kit.json`; the real path must stay inside the enabled roots |

The note is a JSON object with exactly these keys (no others):

| Key | Type | Meaning |
|---|---|---|
| `kit` | string | the kit's name. It must equal the business profile's `skills.reelKit` (neutral default `reel-kit`). |
| `version` | integer, 1 to 9999 | the kit version that made this reel |
| `test` | null or object | `null` = a plain kit reel. An object = this reel tests one change against the kit: `{ "change": string (1 to 200 characters, trimmed), "detail": string (up to 1,000 characters) }`, no other keys. |

## Example

For the demo brand's reel `Episode 1 Reel 1.mp4`, the note `Episode 1 Reel 1 kit.json` in the same folder:

```json
{
  "kit": "reel-kit",
  "version": 2,
  "test": {
    "change": "hook 170px",
    "detail": "Opening headline set at 170 px instead of 140 px, everything else as kit v2."
  }
}
```

A plain reel on the same kit:

```json
{ "kit": "reel-kit", "version": 2, "test": null }
```

And the kit folder's `VERSION` file holds:

```text
2
```

## What Studio does with the notes

Studio stores one row per reel video in `reel_kit_notes` (read again only when the note's size or mtime changes) and
uses it at read time. Nothing acts on it by itself.

- **Kit tag** on Posted cards and in the Shorts list: `Kit v2`, `Kit v2 · test: hook 170px`, or `Before kit` (no note,
  or a refused one; the refusal reason shows as the tag's tooltip).
- **% viewed vs the channel:** each Short with numbers shows its "% viewed" next to the channel median, for example
  `31% viewed · channel 24% (3)`. A Short counts toward a median when its latest snapshot has a "% viewed" and more
  than 0 views. The Shorts list can filter by group (Before kit, Kit vN) and shows each group's median.
- **Kit test winners.** A test reel wins when its Short has been up at least 7 days with at least 300 views, and its
  "% viewed" beats the median of the SAME kit version's no-test reels by at least 5 points. That needs at least 2 such
  baseline reels; with fewer the note says "not enough kit reels yet". A winner shows "Beat kit vN by X points: fold
  in?". Studio never changes the kit; folding a change in is your tool's job, after you say yes.

Matching a Short to a reel file comes from the YouTube sync (title and duration, or Link a file). Without YouTube
connected there are tags but no numbers.

## GET /api/reels/kit-tests

A read only JSON summary your reel tool can fetch at the start of a session. It takes no query parameters (any
parameter gives a 400). A plain GET from the same Mac passes the localhost guard without an Origin header:

```bash
curl -s http://127.0.0.1:4747/api/reels/kit-tests
```

Use your own `STUDIO_PORT` if you changed it. The response:

```json
{
  "kit": "reel-kit",
  "channelMedian": 24.1,
  "channelCount": 9,
  "versions": [
    { "version": 1, "baselineMedian": 22.5, "baselineCount": 4 },
    { "version": 2, "baselineMedian": 25.0, "baselineCount": 2 }
  ],
  "tests": [
    {
      "videoId": "a1B2c3D4e5F",
      "title": "Light beats gear",
      "fileName": "Episode 1 Reel 1.mp4",
      "version": 2,
      "change": "hook 170px",
      "detail": "Opening headline set at 170 px instead of 140 px, everything else as kit v2.",
      "views": 812,
      "avgViewPct": 31.4,
      "daysUp": 9,
      "beatBy": 6.4,
      "winner": true,
      "note": null
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `kit` | the profile's `skills.reelKit` |
| `channelMedian`, `channelCount` | the median "% viewed" over every live Short that counts, and how many counted (`null` median when none) |
| `versions[]` | per kit version: the median "% viewed" of its no-test reels and how many there are |
| `tests[]` | one entry per test reel (a note with a `test`) whose Short is live |
| `tests[].beatBy` | points over the version's baseline median, 1 decimal; `null` when there are not enough baseline reels or no numbers |
| `tests[].winner` | the winner rule above |
| `tests[].note` | why it is not a winner yet: `not enough kit reels yet`, `up 3 of 7 days`, `120 of 300 views`, `no numbers yet`, or `beats the kit by 2.1 of 5 points`; `null` for a winner |

On an internal error the route answers 503 with `{"error": "not available"}`.

## Failure handling

A bad note never stops the worker. It is stored as an error row and the reel counts as Before kit:

| Problem | Stored reason |
|---|---|
| Not valid JSON | `Not valid JSON.` |
| Wrong keys, wrong `kit` name, out of range values | `Not the <kit name> kit.json shape.` |
| Over 64 KB, a symlink that leaves the roots, a real name that does not end in ` kit.json` | a short reason from the guarded reader |

The same refusal is not rewritten or counted again every 60 seconds; a fixed note is read on the next pass. A note
that disappears from a readable folder drops its row (Before kit again). When the root cannot be read (for example the
drive is unplugged), nothing stored changes.
