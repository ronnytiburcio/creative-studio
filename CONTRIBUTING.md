# Contributing

Thanks for helping. Creative Studio is a local-only app for Apple Silicon Macs, so every change is tested on a Mac.
Please read [docs/architecture.md](docs/architecture.md) before you change anything that touches files, the network or
money: its [hard safety rules](docs/architecture.md#hard-safety-rules) are the part reviewers check first.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Set up

1. Install the tools and clone the repo as described in [docs/install.md](docs/install.md).
2. Try the demo first. It needs no keys, no media folder and no paid service, and it never touches a real install:

```bash
npm run demo
```

3. For development, run the app and the worker in two Terminal windows:

```bash
npm run dev
```

```bash
npm run worker
```

If you installed the LaunchAgents, they already use your `STUDIO_PORT` (default 4747). Stop them first (see
[docs/install.md](docs/install.md)) or give the dev server another port with `STUDIO_PORT` in your environment.

## Checks before you open a pull request

Run all three from the repo root. They must pass.

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run smoke
```

The smoke test runs on a temp database and temp folders with fakes for every paid or outside service. It needs ffmpeg
and ffprobe at `/opt/homebrew/bin/ffmpeg` and `/opt/homebrew/bin/ffprobe` (or set `FFMPEG_PATH` and `FFPROBE_PATH`).
Checks that need the original author's private files print `skipped (private)`; that is expected.

Add smoke checks for what you change. Use the existing fakes (`FakeJev`, `FakeAdapter`, `FakeVision`, the stub
transports, a stub `claude` through `CLAUDE_BIN`). A test must never call a paid engine, Jev, Meta, GHL, Google, Ollama
or whisper, and never read your real env file, database or media.

## No names in code

Code, comments, tests and fixtures stay neutral: no business, brand, client, person or account names or ids, no home
paths, no trade words that describe one business. This covers `src/`, `scripts/`, `drizzle/`, `launcher/`, `public/`,
`demo/` and the root config files.

Your own business wording belongs in your Studio config file, not in the code:

- lanes, clients, roots and folder rules in its top level keys;
- every text a model reads or a house copy rule in its `profile` section. `src/lib/profile-schema.ts` documents each
  key, and `src/lib/profile-defaults.ts` holds the neutral built-ins. If a new feature needs business wording, add a
  profile key with a neutral default.

See [docs/configuration.md](docs/configuration.md). Tests use made-up stand-ins (the demo's bakery, fitness studio and
bike shop are a good source).

If you keep a list of your own names, you can scan your branch with the leak gate (`scripts/leak-grep.sh`) before you
push. Keep the denylist outside the repo. The full command, with the list of folders it checks, is in
[docs/architecture.md](docs/architecture.md).

## Database migrations

1. Edit `src/lib/db/schema.ts`.
2. Generate the migration:

```bash
npm run db:generate
```

3. Commit the new SQL file in `drizzle/` and the updated `drizzle/meta/` files.

Never edit a migration that has already been applied; add a new one. drizzle-kit does not know the full text table
`asset_fts` or its triggers (hand written in `drizzle/0004_describe.sql`): if your migration makes drizzle-kit rebuild
the `assets` table, re-add the three `asset_fts_*` triggers and rebuild `asset_fts` in the same migration.

New defaults that the app should insert go in a new step in `src/lib/db/seed.ts` (bump `SEED_VERSION`); a step only
inserts what is missing, so users' settings are never overwritten.

## Version bumps

Some constants record which version of a prompt or a rule made a stored result. Bump the right one in the same change:

| Change | Bump | Effect on users |
|---|---|---|
| a classify question, option text or state shape | `CLASSIFY_VERSION` in `src/lib/ai/classes.ts` | every classified file is classified again (paid) |
| the describe prompt | `DESCRIBE_PROMPT_VERSION` in `src/lib/ai/describe.ts` | every file is described again (local, slow) |
| the Shorts moments prompt | `MOMENTS_PROMPT_VERSION` in `src/lib/shorts/moments.ts` | recorded on each moments job |
| the word transcript format | `WORDS_VERSION` in `src/lib/shorts/words.ts` | episodes are transcribed again |
| any ad copy rule | `AD_RULES_VERSION` in `src/lib/meta/ad-copy-rules.ts` | written into every ad order; apply scripts must mirror it |
| any page rubric wording | append a version to `PAGE_RUBRICS` and move `CURRENT_PAGE_RUBRIC` in `src/lib/pages/rubric.ts` | old versions stay for rescoring |

Say in your pull request which one you bumped and why, since some bumps cost users money.

## Code style

- TypeScript everywhere; zod for every server action input, route parameter and file the app reads.
- SQL is parameterized only; escape `like` inputs.
- Next.js 16: `params` and `searchParams` are Promises, middleware is `src/proxy.ts`, lint is plain ESLint.
- UI: Tailwind with the shadcn tokens mapped in `src/app/globals.css` (`bg-card`, `border-border`,
  `text-muted-foreground`, `bg-brand`, `text-brand-text`, `text-paper` on dark overlays). Never raw grays. Reuse the
  components in `src/components/ui/`. The orange accent is only for markers, focus, selection and key calls to action.
- No sideways page scroll at any width, including phone widths.
- Server only modules (`src/lib/profile.ts`, anything that reads the config or a file) never end up in a client
  component.
- Error texts that reach the browser are short and never name a path, a key or an upstream message.

## Pull requests

- Keep each pull request small and about one thing. A refactor and a feature go in separate pull requests.
- Describe what you changed, why, and how you tested it on your Mac.
- For UI changes, add screenshots taken from the demo (`npm run demo`), never from your own media or client data.
- Do not include env files, databases, cache folders, logs, real media or real account ids.
- Write docs in plain words. In the manual, avoid em and en dashes (the smoke test checks for them).
