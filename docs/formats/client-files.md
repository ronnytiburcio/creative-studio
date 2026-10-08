# Optional client files

Studio can read a few files you (or your own tools) keep for each client. Every one of them is optional: Studio works
without all of them, and each section below says what you lose without it. Studio only reads these files. It never
edits, moves or creates them.

This page is for developers and for anyone who keeps these files by hand. The client settings themselves (code,
folder, ad account, campaigns, leads) are in [../guide/settings.md](../guide/settings.md) and
[../configuration.md](../configuration.md).

## Contents

- [Where the files live](#where-the-files-live)
- [The approved copy doc](#the-approved-copy-doc)
- [The Static Ads folder](#the-static-ads-folder)
- [The ad map: video_script_map.json](#the-ad-map-video_script_mapjson)
- [state.json and build_state.json](#statejson-and-build_statejson)
- [The universal registry](#the-universal-registry)

## Where the files live

Two folders matter:

| Folder | Setting | Default | Holds |
|---|---|---|---|
| Client docs folder | `STUDIO_CLIENT_DOCS_DIR` | `~/Studio-Data/client-docs` | one subfolder per client, named by the client's **folder** setting (Settings > Clients, or `folder` in the config file): the approved copy doc and `Static Ads/` |
| Meta env folder | the folder that holds `META_ENV_FILE` | `~/.studio/` (next to `meta.env`) | one subfolder per client **code**: `video_script_map.json`, `state.json`, `build_state.json` |

Plus one file anywhere: the universal registry (`META_UNIVERSAL_REGISTRY`).

A layout for the demo's bakery client (code `crumb`, folder `Crumb and Crust Bakery`):

```text
~/Studio-Data/client-docs/
  Crumb and Crust Bakery/
    CRUMB-ad-copy-final.md
    Static Ads/
      weekend-box-square.jpg
~/.studio/
  meta.env
  crumb/
    video_script_map.json
    state.json
```

A client's folder setting is one folder name (no slashes). Without a folder setting, the copy doc and `Static Ads/`
are simply not looked for.

## The approved copy doc

**Path:** `<STUDIO_CLIENT_DOCS_DIR>/<client folder>/<NAME>-ad-copy-final.md`. The folder must hold exactly one file
matching `<letters or digits>-ad-copy-final.md` (by convention the client code in capitals, like `CRUMB-ad-copy-final.md`). Zero
or two such files is an error you will see on the Hooks tab.

**Read by:**

- **Import approved copy** on the client's Hooks tab: turns the doc's headlines and the first sentence of each primary
  into text hooks (source `copy_doc`), each with the angle slug of the heading above it.
- **New PAUSED ad** prefill: the whole angle block (headlines, primaries, description) for the hook's angle.

**Without it:** Import approved copy says "No approved copy folder is set for this client" or "Approved copy not
found", and the New ad dialog prefills from the ad map's `angles` (if any) and the hook only.

### What Import reads

- **Headlines:** `**Headline:** text`, `- H1: text` (any number), `**H1:** text`.
- **Primaries:** the first sentence of `**Primary:** text`, `**Primary A:** text`, `- P1: text`, or
  `**P1 (structured):**` (any note in brackets) with the text on the next line.
- **Angle:** from the nearest heading above the line (any `#` level):
  - a heading containing ``angle `slug` ``, e.g. ``## Angle `weekend_box` ``;
  - else any backticked slug in the heading that contains `-` or `_`, e.g. ``### 01 `weekend-box` (offer)``;
  - else a heading that is only a slug, e.g. `## weekend_box`. A bare slug must also contain `-` or `_` (letters and
    digits joined by them): `## Weekend` is not read as an angle.
- **Ignored:** descriptions, CTAs, table rows (`|`), quotes (`>`), anything inside a fenced code block, and lines longer
  than 500 characters after cleaning.
- **Cleaning:** `**` and `__` emphasis, backticks, leading emoji and a trailing `*(note)*` are removed.
- **Duplicates:** the same line twice in the doc becomes one hook; a hook that already exists in that channel
  (archived ones included) is not added again.

### What the New ad prefill reads

For each angle slug, a block of:

- headlines: `- H1:`, `**H1:**`, `**Headline:**`, or one line `**Headlines:** a | b | c`;
- primaries: `- P1: text`, or `**P1 (...):**` / `**Primary:**` followed by lines (blank lines kept) until the next
  field, heading, table, quote or rule;
- description: `Description: text`, `**Description:** text`, `**D1:** text` or `- D: text`.

A later section with the same slug replaces only the fields it carries (so a refresh section can swap the primaries and
keep the headlines). Files over 4 MB are skipped.

### Example

```markdown
# Crumb and Crust Bakery: approved ad copy

## Angle `weekend_box`

- H1: Saturday bread, sorted
- H2: The weekend box is back
- H3: Sourdough, pastries and a cake slice
- P1: Tired of the 7 AM bread line? Our weekend box holds a sourdough loaf, four pastries and a slice of cake.
- P2: Forty loaves leave the oven every Saturday. Reserve yours and skip the line.
Description: Pick up Saturday

### Angle `static_tasting`

**H1:** Taste before you order
**P1 (structured):**
Three loaves, one weekday afternoon, no charge.

✅ 20 minutes
✅ A slice of the cake of the week
**D1:** Weekday tastings
```

Import adds seven hooks from this doc: the four headlines and the first sentence of each of the three primaries,
with the angles `weekend_box` and `static_tasting`.

## The Static Ads folder

**Path:** `<STUDIO_CLIENT_DOCS_DIR>/<client folder>/Static Ads/` (exact name, with the space).

**Read by:** when you add a client (or change its folder in Settings > Clients, or the config seeds it), Studio checks
for this folder. If it is a real folder and overlaps no existing root, Studio adds it as a root in the Clients lane and
adds a folder rule `<its real path>/**` that tags everything inside to that client. From then on it is scanned like any
other root, read only.

**Without it:** nothing is added. If you create the folder later, add it yourself in Settings (Roots and Folder rules),
or keep the client's files in another root with a folder rule.

## The ad map: video_script_map.json

**Path:** `<folder of META_ENV_FILE>/<client code>/video_script_map.json`, a JSON object. Typically written by the
script that builds and launches your ads. Clients lane only: the Company lane's ads match by their Meta media name.

The map is only read when the client code matches `^[a-z0-9]{2,32}$` (2 to 32 lowercase letters or digits); for any
other code it is ignored. The New ad prefill and Stage also skip a map file over 4 MB.

**Read by:**

- the Meta sync, to match each Meta ad to a local file (Running cards, hook links, calibration);
- the Meta sync's hook step, for each ad's angle (Meta copy becomes hooks with that angle; the test order uses it);
- the New PAUSED ad dialog and Stage: angle blocks as a prefill fallback, `forbidden_terms` in the copy checks and in
  "Draft the rest", the concept and `ps` / `obj` prefill, and the next ad number.

**Without it:** ads still match by their Meta media name (video title or image name) or by **Link a file** on the card;
there are no forbidden terms; the next ad number comes from the other sources alone.

The next ad number shown in the dialog is one past the largest of: the map's `n` values, the numbers in the account's
synced ad names, every ad name in the account's daily metrics (archived ads included), and the names of Studio's own
orders for that client (staged, applying or applied, plus any order that already got an ad id). It is a preview only;
the apply script assigns the real number.

Fields Studio uses (everything else is ignored):

| Field | Type | Used for |
|---|---|---|
| `ads` | array of objects | the rows below; without an `ads` array the file counts as empty |
| `ads[].ad_id` | string or number | match by Meta ad id (first choice) |
| `ads[].creative_id` | string or number | match by creative id |
| `ads[].video_id` | string or number | match by one of the ad's Meta video ids |
| `ads[].ad_name` | string | match by ad name (case and spacing ignored, then also ignoring Meta's `Copy` suffix) |
| `ads[].n` (or `ads[].ad`) | number or string, 1 to 3 digits | the ad's number: matches an ad named `...-Ad-06` or `<code>-...-06` when the row has a file but no `ad_id` and no `ad_name`; also counts toward the next ad number |
| `ads[].video` or `ads[].image` | string | the local file: an absolute path matches that exact file; otherwise the file name (preferring a file tagged to this client, then one in the Clients lane, then one whose path ends in this relative path) |
| `ads[].angle_key` (prefill also accepts `angle`) | string | the copy doc angle slug |
| `ads[].stage` | `"ps"` or `"obj"` | the `ps` / `obj` prefill |
| `ads[].avatar_concept` | string | the concept prefill |
| `angles` | object | slug to `{ headlines: [], primaries: [], description, stage }`: the prefill when the copy doc has no block for that angle |
| `forbidden_terms` | string[] | whole word, case insensitive bans in the ad copy checks |
| `landing_url` | string | parsed but not used; the landing page comes from the business profile's `adCopy.landing` |

Studio records how each ad matched (through the map by ad id, creative id, video id, ad name, universal registry or ad
number; by media name; or by hand). A manual link is never replaced.

### Example

```json
{
  "forbidden_terms": ["cheapest", "guaranteed"],
  "angles": {
    "weekend_box": {
      "headlines": ["Saturday bread, sorted", "The weekend box is back", "Sourdough, pastries and a cake slice"],
      "primaries": ["Tired of the 7 AM bread line? Our weekend box holds a sourdough loaf, four pastries and a slice of cake."],
      "description": "Pick up Saturday",
      "stage": "ps"
    }
  },
  "ads": [
    {
      "n": 6,
      "ad_id": "120211234567890123",
      "ad_name": "crumb-weekend_box-ps-06",
      "video": "Clients/Crumb and Crust Bakery/weekend-box-15s.mp4",
      "angle_key": "weekend_box",
      "stage": "ps",
      "avatar_concept": "weekend_box"
    },
    { "n": 7, "image": "static-sourdough-class.jpg", "angle_key": "sourdough_class", "stage": "obj" }
  ]
}
```

## state.json and build_state.json

**Path:** `<folder of META_ENV_FILE>/<client code>/state.json`, then `build_state.json` in the same folder. For the
Company lane the subfolder is `fkb/`.

**Read by:** the Meta sync, only for an account whose campaigns setting is `state_json` (`"campaigns": "state_json"` in
the config file, or the same choice in Settings). Studio reads one field:

```json
{ "campaign_id": "120219876543210987" }
```

`campaign_id` may be a string or a number of digits. The sync then reads that one campaign. When neither file gives
one, it looks at the account's first 50 campaigns and takes the first whose name contains the profile's
`ads.campaignWord` (as a whole word) or the client code (anywhere, case insensitive); else the account's only
campaign; else the account shows the error "could not identify the campaign in account".

**Without them:** use the other campaign settings instead: `all` (every campaign in the account, the default for a new
client) or one campaign id (`{ "id": "<campaign id>" }` in the config file).

## The universal registry

**Path:** `META_UNIVERSAL_REGISTRY`; empty means `<STUDIO_DRIVE>/shared-ads.json`. A missing file means no shared ads.

**Read by:** the Meta sync, for Clients lane ads you run in several client accounts with the same creative. An ad whose name
contains `universal` followed by `-`, `_` or a space and an id (case insensitive, e.g. `crumb-Universal-spring_promo`)
is matched in this order: first the client's ad map by ad id, creative id, video id and ad name (as for any ad), then
this registry by the id. A universal ad that matches neither is not matched by its ad number.

Shape:

```json
{
  "ads": [
    { "id": "spring_promo", "video": "Shared ads/spring-promo-9x16.mp4" },
    { "id": "holiday_hours", "image": "Shared ads/holiday-hours.png" }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `ads[].id` | string | the id that follows `universal` in the ad name (compared case insensitive) |
| `ads[].video` or `ads[].image` | string | the file, relative to the registry's folder; it is matched by file name, preferring a copy tagged to the ad's client |

Rows without an id or a file are skipped. A universal ad's angle (used by the test order) is `universal:<id>`, in
lower case.

**Without it:** a universal ad matches like any other ad, by its Meta media name or by Link a file.
