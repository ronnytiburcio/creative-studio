# Screenshot list

Every screenshot in the docs, what it shows and how it is taken. The images live in this folder as `<name>.png` and
each one is shown exactly once, on the page the table names.

All of them come from the demo, so no real brand, client or number ever appears. `scripts/capture-shots.ts` takes them:
it opens each page in headless Google Chrome, does the steps in the last column (clicks, keys, scrolling), waits for the
page to settle and saves a light mode PNG, 1440 px wide (the phone shot: 375 px wide at 2x), recompressed to at most
400 KB.

## Retake them

Start a fresh demo in one Terminal window and leave it running:

```bash
npm run demo -- --reset
```

When it says it is running, take every screenshot from a second window:

```bash
npx tsx scripts/capture-shots.ts --url http://127.0.0.1:4750
```

To retake only some, name them with `--only`:

```bash
npx tsx scripts/capture-shots.ts --url http://127.0.0.1:4750 --only hooks-tab,rubric-page
```

The steps for each slot live in the script (`SLOTS`); it refuses a slot name this table does not list. Some steps
change the demo's data (the Cut reel slot keeps an Idea card first), which is why a fresh demo gives the same pictures.
Look at every image before you commit it.

## Format

One table. `scripts/smoke-manual.ts` reads it and checks that every name here has its `<name>.png` in this folder and is
shown as an image exactly once, on its page, and that no image is left out of the table.

- **name**: the image name, kebab case. Each name is listed once.
- **page**: the page that shows it, relative to this manual's folder (`guide/library.md`; a root file is
  `../README.md`).
- **what it shows** and **demo page and state**: what the image holds and how the script gets there. The window is
  1440 x 900 unless the row says otherwise.

## Slots

| name | page | what it shows | demo page and state |
|---|---|---|---|
| `readme-library` | ../README.md | The Library grid of the Brand lane with thumbnails, the filter bar and the detail drawer open on one video | `/rtm/library`: click `intro-take-3.mp4` so the drawer opens on the right |
| `readme-library-phone` | ../README.md | The Brand lane Library at phone width (375 px): the bottom of the filter bar and the first cards | `/rtm/library` on a 375 x 812 window at 2x (phone emulation), scrolled so the Sort button sits in the middle |
| `install-settings-paths` | install.md | The bottom of the Settings page: the end of the API keys card, the Tag rules card and the Paths card (database, cache, logs, config file and address) | `/settings`, scrolled to the bottom |
| `config-settings-lanes-clients` | configuration.md | The Lanes card (three lanes with names, colors and on or off) and the Clients card (the three demo clients with code, ad account, campaigns and leads) | `/settings`, both cards cut out of the page |
| `library-grid` | guide/library.md | A client channel's Library: the filter bar, a page of cards with client chips and the Meaning switch | `/fkbpros/crumb/library` |
| `library-drawer` | guide/library.md | A landscape video's drawer: preview, AI description, Jev tags, the Hook section, the Meta ad button, the File buttons, Quick tools and Clients | `/fkbpros/ironleaf/library`, open `class-broll.mp4`; the drawer alone, from a 1310 px tall window |
| `generate-panel` | guide/generate.md | The Generate panel: engine tabs, a typed prompt, the Brand guard and two cards in the tray. Engines are off in the demo, so the model list says unavailable and the tray cards say Not used | `/fkbpros/crumb/library`: click Generate, type a prompt, click Use as reference on the two static ads |
| `review-queue` | guide/describe-classify-review.md | The Review page with "Nothing to review", the key strip and the Review keys dialog | `/review`, press ? |
| `hooks-tab` | guide/hooks.md | A client's Hooks tab, Text view: state line, coverage strip, filters and scored rows | `/fkbpros/crumb/hooks` |
| `rubric-page` | guide/hooks.md | The top of the Rubric page: version line, per section line, Edit rubric and the first dimension | `/rubric` |
| `client-tab` | guide/hooks.md | The bakery's Client tab: brand notes, Jev hint, test order, What works here with the pinned hook, account and folders | `/fkbpros/crumb/client`, a 1300 px tall window |
| `running-tab` | guide/running.md | All clients Running: window panels, the client table, controls and the first row of ad cards, one with a Fatiguing chip | `/fkbpros/all/running`, a 1518 px tall window |
| `new-paused-ad` | guide/running.md | The New PAUSED ad sheet: channel, the picked image, the hook in headline 1, the Draft the rest strip and Stage | `/fkbpros/ironleaf/hooks`: New ad on the row "Six weeks to your first real pull up", Pick an image, `static-six-week-reset.jpg`; a 1300 px tall window |
| `shorts-board` | guide/shorts.md | The Shorts board on a wide window: five columns, cards in Idea, Cutting and Review, hook words and cold opens | `/rtm/shorts`, scrolled to the Shorts board heading |
| `cut-reel-dialog` | guide/shorts.md | The Cut reel dialog: the episode, kept ideas ticked, the kit format selected | `/rtm/shorts`: Keep the first Idea card, then Cut reel |
| `jobs-page` | guide/jobs.md | The top of the Jobs page: the describe, classify and hook scoring table, the Meta sync row, the YouTube Shorts sync row and the start of the Hook variants list | `/jobs` |
| `settings-top` | guide/settings.md | The status tiles plus the Lanes and Clients cards | `/settings` |
| `settings-ai-jev` | integrations/typesafe-jev.md | Settings > AI, the Classify (Jev) section: the Jev check rows (No, as the demo has no key), spend, confidence threshold, daily cap, and the Hooks section below | `/settings`, scrolled to the Classify (Jev) heading |
| `settings-meta-card` | integrations/meta.md | Settings > Meta and GHL: presence lines, the state line with Resume and Sync now, the per account table and the flag thresholds | `/settings`, the card alone (two made-up accounts), from a 1300 px tall window |
| `settings-youtube-card` | integrations/youtube.md | Settings > YouTube before connecting: client and Connected lines, Not connected, the Connect YouTube button | `/settings`, the card alone |
| `settings-ai-describe` | integrations/ollama.md | The top of Settings > AI: the Ollama and whisper.cpp checks (Not ready in the demo), the Described bar and the state line | `/settings`, scrolled to the AI card |
| `settings-engines-higgsfield` | integrations/higgsfield.md | Settings > Generation engines: the Higgsfield check next to ChatGPT (Codex), both Unavailable because engines are off in the demo | `/settings`, the card alone |
| `settings-claude-card` | integrations/claude-cli.md | Settings > Claude as the demo shows it: CLI found and Signed in both No, "claude CLI not found" and Check again (Sign in appears once the CLI is found) | `/settings`, the card alone |
