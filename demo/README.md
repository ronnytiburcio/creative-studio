# Creative Studio demo

A populated Creative Studio you can click around in a minute, with no keys, no media drive, no Ollama, no paid service
and no network call (apart from what `npm install` and the first build fetch).

Install Node.js 22 (and ffmpeg) first, as described in the [install guide](../docs/install.md), and run these commands
from the Studio folder (the folder you cloned), not from this `demo` folder:

```bash
npm install
```

```bash
npm run demo
```

Then open http://127.0.0.1:4750 in your browser. Ctrl+C in Terminal stops the demo.

`npm run demo` indexes `demo/media/` into a throwaway data folder (`.demo-data/`, gitignored: DB, cache, logs), adds the
sample data, builds its own copy of the app into `.demo-data/next` the first time (never the repo's `.next/`), and
starts the web app and the worker on port 4750. The worker makes the thumbnails, posters, contact sheets and 480p proxies in the first few seconds.

| Option | What it does |
|---|---|
| `npm run demo -- --reset` | wipe `.demo-data/` first (a fresh DB and cache) |
| `npm run demo -- --build` | rebuild the demo's app even when its build exists (after pulling new code) |
| `npm run demo -- --port 4751` | another port (4747 and 4748 are refused, see [For developers](#for-developers)) |

## What is fake

Everything. The brand, the clients, the people, the numbers and every line of text are made up for this demo.

- **The Brand lane, Harbor & Pine:** an invented creator brand that posts YouTube episodes and Shorts about filming
  with little gear. One slide "episode" (2.5 minutes) with its transcript (`Episode 1.srt`), a cut reel, a Short, b-roll pans, a
  talking head stand-in (a drawn figure and a tone, not a person), a thumbnail, a brand mark and a quote card.
- **The Clients lane, three invented clients:** Crumb and Crust Bakery, Ironleaf Fitness and Spoke and Chain Cycles,
  each with static ads, a before / after pair or a short clip. The first two have made-up Meta ad accounts
  (`act_100000000000021`, `act_100000000000022`) with 30 days of made-up numbers; the bike shop has none.
- **The Company lane** is switched off (its pages answer 404), as it would be for anyone without a standalone company.

The sample data (written only into the demo DB by `scripts/demo-data.ts`, marked with `demo:seeded_at`):

- Fixed descriptions for every file, in the describe model's format, so search, the drawer and video hooks work
  without Ollama or whisper.
- About a dozen text hooks per lane plus four video hooks, every one with a stored score made of fixed answers in Jev's
  shape (scores marked with the model `demo`; no Jev call was made).
- The Shorts board: six cards from Episode 1 across Idea, Cutting and Review (one with its reel linked).
- Running: the two ad accounts' daily ad numbers, channel numbers and flags (one ad fatiguing, one winner), rebuilt
  for today's date every time the demo starts.
- Client tabs: brand notes, "What works here" items and a pinned hook.

Every queue that could spend money or reach a service starts paused (describe, classify, hook scoring, Meta, YouTube),
the env file `demo/.env` holds no key, and the demo sets `STUDIO_ENGINES=off` so Higgsfield, Codex and `claude` are
never run even when they are installed. The demo's "app name" says "(demo)" in the sidebar and the page titles.

## For developers

The rest of this page is for people who work on the code.

More `npm run demo` options:

| Option | What it does |
|---|---|
| `npm run demo -- --setup-only` | index + sample data only, print a JSON summary (used by the smoke test) |
| `npm run demo -- --setup-only --data <dir>` | the same into another empty folder (refused for an install's folders, the repo, or a folder the demo did not make) |

Ports 4747 and 4748 are refused because a real install uses them (4747 for the app, 4748 for a second test server).

### How it stays apart from a real install

`scripts/demo-env.ts` forces every config key through the process environment (the top layer of the config): the
identity file is ignored (`STUDIO_IDENTITY=neutral`), the env file is `demo/.env`, the Studio config is
`demo/studio.config.json`, the DB / cache / logs / hand-offs live in `.demo-data/`, the media folder is `demo/media`
(folder mode), and every outside file (Meta, GHL, YouTube, client docs, the reel kit) points at a path in `.demo-data/`
that does not exist. Inherited `STUDIO_*`, `META_*`, `YOUTUBE_*`, key and engine variables are dropped. The two ad
order folders sit under the OS temp folder (they may never be inside a git working tree) and are only created if you
stage an ad in the demo.

It does not share the app build either: the demo builds into `.demo-data/next` (`STUDIO_DIST_DIR`, read by
next.config.ts) and serves from there, so a real install's `.next/` is never built into, read or served. `next build`
rewrites `next-env.d.ts` (gitignored) to point at the build folder; the demo puts the previous file back right after.
tsconfig.json already lists the demo build's types, so Next leaves it alone: no tracked file changes when the demo runs.

### Remaking the media

```bash
npx tsx scripts/make-demo.ts           # redraw demo/media + demo/manifest.json (sharp + ffmpeg, about 5 s)
npx tsx scripts/make-demo.ts --check   # regenerate into a temp folder and compare with the manifest
```

The generator is deterministic (fixed drawings, single threaded bitexact ffmpeg, no clock or random input): with the
same sharp / fonts and ffmpeg / x264 versions it rewrites byte identical files. Another machine may produce slightly
different bytes (fonts, encoder versions); the committed files are what screenshots use. The whole folder stays under
5 MB (about 1 MB today).
