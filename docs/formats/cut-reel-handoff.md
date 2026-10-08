# Cut reel hand-off list

Studio never renders a reel. When you pick kept moments on the Shorts board and click **Cut reel**, Studio writes the
approved moments as one JSON list into its own hand-off folder and shows a line you paste into a reel cutting tool
(for example a Claude Code session that runs your own reel skill). The tool copies the list into the episode folder,
cuts the reels, and Studio finds the finished files by name.

This page documents that list for developers who want to build or adapt the reel cutting side. For the board itself,
see [../guide/shorts.md](../guide/shorts.md).

Code: `src/lib/shorts/handoff.ts` (`buildHandoff`, `writeHandoffFile`, `cutReel`), `src/lib/shorts/handoff-text.ts`
(formats and the paste line), `src/lib/shorts/naming.ts` (file names).

## Contents

- [Who writes and who reads](#who-writes-and-who-reads)
- [File name and folder](#file-name-and-folder)
- [The list](#the-list)
- [Formats](#formats)
- [Example](#example)
- [The paste line](#the-paste-line)
- [What Studio expects back](#what-studio-expects-back)
- [Failure handling](#failure-handling)

## Who writes and who reads

| Step | Who |
|---|---|
| Builds the list from kept Idea cards of one episode and writes it as a NEW file | Studio, the Cut reel server action, through `writeHandoffFile()` only |
| Moves those cards to Cutting and remembers the file, the format and the kit version | Studio, in the same database transaction |
| Reads the list, copies it into the episode folder as `<prefix>N reels.json`, cuts the reels | your reel cutting tool, after you paste the line |
| Finds the reel files and captions, moves cards to Review | the Studio worker, every 15 seconds |

Studio never runs the reel tool, never writes into an episode folder and never copies the list there.

## File name and folder

- **Folder:** `STUDIO_HANDOFFS` (default `~/Studio-Data/handoffs`). Set an absolute path (or one starting with `~/`):
  a relative value is not refused, it is resolved against the folder the app was started from, which is rarely what
  you want. The folder must not be `/` and not on the media drive (checked by the config at startup, and again on the
  lexical and the real path before every write). It is created (with any missing parents) with mode 0700 when missing,
  and must be a plain folder, not a symlink.
- **Name:** `<prefix>N reels.json`, where `<prefix>` is the business profile's `episodes.prefix` (neutral default
  `Episode `, with the trailing space) and `N` is the episode number. Example: `Episode 1 reels.json`.
- **Never overwritten.** When that name exists, Studio uses `<prefix>N reels <yyyy-mm-dd-hhmm>.json` (local time), then
  `... <yyyy-mm-dd-hhmm>-2.json` up to `-21`. More than that in one minute is refused.
- The file is created with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, and fsynced. It must be valid JSON and at most
  64 KB.

The episode prefix also names the files the rest of the flow uses:

| File | Pattern | Written by |
|---|---|---|
| The prepped transcript | `<prefix>N.srt` next to the episode's master video | your episode prep tool |
| The reel list in the episode folder | `<prefix>N reels.json` | your reel cutting tool (a copy of Studio's list) |
| A reel | `<prefix>N Reel K.mp4` or `<prefix>N Reel K vV.mp4` | your reel cutting tool |
| A reel's caption | `<prefix>N Reel K caption.md`, next to the reel | your reel cutting tool |
| A reel's kit note | see [kit-notes.md](kit-notes.md) | your reel cutting tool |

## The list

Top level object:

| Field | Type | Meaning |
|---|---|---|
| `episode` | string | `<prefix>N`, the stem of the episode's SRT, e.g. `"Episode 1"` |
| `master` | string | absolute path of the episode's master video: the longest visible Brand lane video classified `episode` in the SRT's folder |
| `status` | string | a human readable approval line: `APPROVED[ by <owner>] <yyyy-mm-dd> in <app name> for a <format> cut (<format label>); not cut yet`. `<owner>` is the profile's `owner.name` (left out when empty); the date is UTC. For the kit format `<format>` reads `<kit name> v<N>`. |
| `clips` | array | one object per moment, ordered by `k` |
| `kit_version` | integer or null | the reel kit's version for the `kit` format; `null` for `v2`, `v3` and `v1` |

Each clip:

| Field | Type | Meaning |
|---|---|---|
| `k` | integer | the card's number in this episode. Your tool must use it as the reel number (`<prefix>N Reel K`). Never reused within an episode. |
| `start`, `end` | number | the moment in master seconds, 2 decimals. Snapped to whole sentences of the word timed transcript (SRT cues for an episode without one) and padded 0.2 s on each side; 30 to 90 seconds long. |
| `layout` | string | `stack`, `center`, `blurfill` or `pip` |
| `hook` | string | the hook words: 2 to 6 words in capitals, counted without the marker. At most one `*...*` pair marks the words that sit in the highlighted block of the opening headline, e.g. `"LIGHT BEATS *GEAR*"`. |
| `first_line` | string | the transcript's first sentence at `start` |
| `why` | string | why the moment works (from the moments job); `""` when there is none |
| `cold_start`, `cold_end` | number | the cold open in master seconds, 2 decimals: one or two whole sentences inside the moment, 2 to 6 seconds after padding, played first under the hook words |

`cold_start` and `cold_end` are present in every format. Cut reel refuses a card that has no cold open yet.

### Versioning

The list has no schema number. The shape changes by adding keys at the end: `kit_version` (top level) and
`cold_start` / `cold_end` (per clip) were added after the first version, and a tool that ignores unknown keys keeps
working. The `kit` format names the reel kit's version from its `VERSION` file (see [kit-notes.md](kit-notes.md)); a
missing or odd file reads as 1.

## Formats

The Cut reel dialog offers four formats. The format changes `status`, `kit_version` and the paste line, not the clip
fields.

| Format | Label in the dialog | Meant for |
|---|---|---|
| `kit` (default) | the profile's `episodes.kitLabel` plus `v<N>` (neutral: `Reel kit v1`) | the one versioned reel look: hook headline over the cold open, then the moment |
| `v2` | narrated motion graphics | a cloned voice reads an approved script over motion graphics |
| `v3` | footage + graphics, fast cut | real footage cut fast with graphics |
| `v1` | plain cut | the original plain ffmpeg cut with captions (re-rendering an old reel) |

## Example

A list for the demo brand's first episode, two kept moments, kit format, written as
`~/Studio-Data/handoffs/Episode 1 reels.json`:

```json
{
  "episode": "Episode 1",
  "master": "/Users/you/Studio-Media/Harbor and Pine/Episodes/Episode 1 Shooting on a Budget/Episode 1.mp4",
  "status": "APPROVED by Mira 2026-10-08 in Creative Studio (demo) for a reel-kit v1 cut (Reel kit v1); not cut yet",
  "clips": [
    {
      "k": 2,
      "start": 12.3,
      "end": 51.8,
      "layout": "stack",
      "hook": "LIGHT BEATS *GEAR*",
      "first_line": "A window gives you better light than a two hundred dollar lamp.",
      "why": "One clear claim, shown on screen in the first seconds.",
      "cold_start": 12.3,
      "cold_end": 16.1
    },
    {
      "k": 3,
      "start": 64.9,
      "end": 108.4,
      "layout": "center",
      "hook": "*FIX* YOUR SOUND FIRST",
      "first_line": "People forgive soft video, they never forgive bad sound.",
      "why": "",
      "cold_start": 70.2,
      "cold_end": 74.6
    }
  ],
  "kit_version": 1
}
```

The same list in `v2` would have `"kit_version": null` and a status ending `for a v2 cut (narrated motion graphics); not
cut yet`.

## The paste line

After writing the file, Studio shows one line to copy. Its wording comes from the business profile (`skills.reelCut`,
`skills.reelKit`, `episodes.prefix`, `owner.name`):

```text
Run reel-cut on Ep1 (Episode 1 Shooting on a Budget) on reel-kit v1. These moments are already approved by Mira, skip step 2 picking: /Users/you/Studio-Data/handoffs/Episode 1 reels.json. Copy the list into the episode folder as "Episode 1 reels.json" (if one is already there, ask me before replacing it) and keep each moment's k as its reel number. Open each reel on its cold open (cold_start to cold_end) under its hook words.
```

- The title in brackets is the episode folder's name.
- For `v2`, `v3` and `v1` the line says `in v2` (and so on) instead of `on <kit> v<N>`, and leaves out the last
  sentence.
- Explainer idea cards (made with Send to Shorts or Make explainer) write no file. Their line is
  `Run <skills.explainer> on this idea[ from <prefix>N at m:ss]: <line>. Use <skills.reelKit>.` Dashes used as
  punctuation are turned into commas.

## What Studio expects back

The worker matches reel files to cards by name, inside the episode's folder and any sibling folder that holds a
`<prefix>N reels.json`:

| File (relative to that folder) | Rank |
|---|---|
| `<prefix>N Reel K vV.mp4` | V (the highest version wins) |
| `<prefix>N Reel K.mp4` | 1 |
| `reels/reelK/out/reelK.mp4` | 0 |

Names are case insensitive. "Reel 3B" or "Reel 31" are not reel 3. Only files written after the card entered Cutting
(less one minute of slack) count, so an old reel never moves a new card. The file must be inside an enabled root to be
indexed at all. A matched reel moves the card from Cutting to Review; a newer version replaces an automatic match in
Review. The caption is read (`.md` only, through the guarded text reader) and shown on the card; **Approve** needs
it. Studio looks for it in this order and takes the first it finds:

1. `<prefix>N Reel K caption.md` next to the reel file;
2. the same name in the episode folder or in any reel folder (a sibling that holds `<prefix>N reels.json`);
3. any file whose name contains `caption` and ends in `.md` (case insensitive), in `reels/reelK/` or
   `reels/reelK/out/` of the episode folder or a reel folder.

If your tool names files another way, use **Link a file** on the card instead.

## Failure handling

| Situation | Result |
|---|---|
| A card is no longer a kept Idea, is from another episode, has no hook words or no cold open | Cut reel refuses with a short message; nothing changes |
| A card's number is already used by an existing reel file of that episode | the card gets the next free number first (shown after the cut) |
| The file cannot be written (folder refused, over 64 KB, too many names in one minute) | the whole action rolls back: no renumbering, no cards in Cutting |
| The database commit fails after the file was written | the file is deleted again |
| No reel shows up | the card stays in Cutting; after 10 minutes it offers "Reel already made? Link a file" |
