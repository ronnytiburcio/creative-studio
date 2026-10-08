# Creative Studio

A local-only creative ops app for Apple Silicon Macs (Next.js 16, React 19, SQLite through better-sqlite3 and Drizzle,
plus a separate Node worker). It indexes media folders read only, makes thumbnails, contact sheets and 480p proxies in
a local cache, and adds Generate (engine CLIs), Describe (local Ollama + whisper.cpp), Classify and hook scoring (Jev,
a paid scoring API), a Running tab (Meta and GHL, read only), a Shorts board and staged PAUSED ad orders. Media is
organized in three lanes: Brand, Clients and Company.

## Docs

- [docs/README.md](docs/README.md): the index of every page.
- [docs/architecture.md](docs/architecture.md): processes, queues, data, the request path and the safety rules in
  full. Read it before you change anything that touches files, the network or money.
- [docs/configuration.md](docs/configuration.md): every env key, the Studio config file and the business profile.
- The files Studio exchanges with outside tools:
  [hand-off lists](docs/formats/cut-reel-handoff.md), [ad orders](docs/formats/ad-orders.md),
  [kit notes](docs/formats/kit-notes.md), [the copy gate CLI](docs/formats/copy-gate-cli.md),
  [the page scorer CLI](docs/formats/page-scorer-cli.md) and [optional client files](docs/formats/client-files.md).

## Commands

| Command | What it does |
|---|---|
| `npm install` | install dependencies |
| `npm run dev` | `next dev` on 127.0.0.1:`STUDIO_PORT` (default 4747; validates the config first) |
| `npm run worker` | the worker (scan, watch, every queue); a separate process |
| `npm run build` | production build |
| `npm run start` | `next start` on 127.0.0.1:`STUDIO_PORT` (default 4747) |
| `npm run demo` | the demo on 127.0.0.1:4750 with made-up data, its own data folder and build |
| `npm run typecheck` | `next typegen` + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run smoke` | the test suite (temp DB, fakes, never a paid or outside service) |
| `npm run db:generate` | a new migration after editing `src/lib/db/schema.ts` |

If the LaunchAgents are installed they already serve `STUDIO_PORT` (default 4747). Do not start a second worker or
server on the same port; set `STUDIO_PORT` in the process environment for a dev server, or unload the agents first.

## Hard rules

Follow these on every change. A change that breaks one is a bug even if it works.

1. **Roots are read only.** Never write, move, rename or delete anything under a root. Derived files go to
   `STUDIO_CACHE`, the database to `STUDIO_DB`, logs to `STUDIO_LOGS`.
2. **One exception on the drive.** Generated media and its `.gen.json` sidecar go into
   `<STUDIO_DRIVE>/Studio Generated/` and only through `src/lib/writeguard.ts`. No other module writes to a drive path.
3. **Two outside folders, one writer each.** Cut reel lists only through `writeHandoffFile()` in
   `src/lib/shorts/handoff.ts` (into `STUDIO_HANDOFFS`). Ad order files only through `writeOrderFile()` in
   `src/lib/meta/orders.ts` (into `META_PENDING_DIR` / `META_FKB_PENDING_DIR`). New files only (`O_EXCL`), 0600,
   64 KB cap, never on the drive, never overwritten. Order folders are never inside a git working tree.
4. **Localhost only.** The server binds 127.0.0.1. Keep `src/proxy.ts` rules: local Host only; every non GET/HEAD
   request needs a same-host Origin; `Sec-Fetch-Site` must be same-origin or none except plain page navigations.
5. **Guarded file access.** Serve files only through `src/lib/fsguard.ts` (`resolveInside`, `resolveCacheFile`). Open
   originals only through `originalFileFor()` in `src/lib/originals.ts`. Read text next to the media only through
   `src/lib/textread.ts`. Never open a path from a request directly. Validate route params and queries with zod and keep
   error bodies terse.
6. **Paid and network work runs in the worker.** Server actions validate (zod) and insert or update rows; queues in
   `src/worker/` do the work. The only exceptions: `GET /api/search/meaning`, the CLIs `scripts/score-copy.ts` and
   `scripts/score-page.ts`, the YouTube OAuth callback and revoke, `claude auth status`, and free status checks. Do not
   add another.
7. **Every Jev call goes through `Jev.ask()`** (`src/lib/ai/jev.ts`): pinned model, the daily cap checked first, one
   `ai_calls` row per call. Tests use `FakeJev`.
8. **Meta, GHL and YouTube are read only.** Keep `graph.ts` GET only to graph.facebook.com (and its refused params),
   `ghl.ts` to the contacts search only, the YouTube transports GET only to their two hosts. Studio never writes to
   Meta or GHL. Tests use stub transports.
9. **Secrets stay in their env file.** Read each key in its one module, fresh per request, send it in a header only.
   Never put a key or token in the DB, logs, errors, URLs, `/api/status` or the browser. `keyStatus()` returns
   booleans only.
10. **Spawn CLIs with argument arrays,** never a shell string. Every Higgsfield run is quoted and needs one confirm.
11. **`claude -p` runs with no tools and a minimal env** through `src/lib/hooks/claude.ts` only. Never
    `--dangerously-skip-permissions`, never an API key, never the Anthropic API.
12. **Rubric versions are never edited in place.** Saving makes a new version; scored hooks rescore only when the user
    clicks Rescore.

## No names in code

Code, comments, tests and fixtures in `src/`, `scripts/`, `drizzle/`, `launcher/`, `public/`, `demo/` and the root
config files carry neutral wording only: no business, brand, client, person or account names or ids, no home paths.
Business wording belongs in the user's Studio config file (`profile` for every text a model reads or a house rule;
`src/lib/profile-schema.ts` documents the keys, `src/lib/profile-defaults.ts` holds the neutral built-ins). Tests use
made-up stand-ins. `src/lib/profile.ts` is server only; client components use `useLabels()` and get rules as data.

## Version constants

Bump the constant in the same change whenever you change what it covers in the code. A user's own `profile` edit
changes new work only (nothing done re-runs by itself); bumping the constant is how a whole library is run again.

| Constant | File | Bump when | Effect |
|---|---|---|---|
| `CLASSIFY_VERSION` | `src/lib/ai/classes.ts` | a classify question, option description or state shape changes, including the neutral `classify` defaults | every classified file is due for Classify again (one Jev call each) |
| `DESCRIBE_PROMPT_VERSION` | `src/lib/ai/describe.ts` | the describe prompt changes, including the neutral `describe` defaults | every file is due for Describe again (local, free, slow), then for Classify again |
| `MOMENTS_PROMPT_VERSION` | `src/lib/shorts/moments.ts` | the moments prompt changes | recorded in each moments job result; it only labels them |
| `WORDS_VERSION` | `src/lib/shorts/words.ts` | the word transcript format changes | episodes are transcribed again |
| `AD_RULES_VERSION` | `src/lib/meta/ad-copy-rules.ts` | any ad copy check changes (also the profile's `copyRules` and `adCopy` emoji palette that feed it) | written into every order file; an apply script that mirrors the checks must accept the same version, so update it too |
| `CURRENT_PAGE_RUBRIC` | `src/lib/pages/rubric.ts` | any page rubric wording changes | append a new version to `PAGE_RUBRICS`; never edit an old one |
| `SEED_VERSION` | `src/lib/db/seed.ts` | you add a seed default | append a step that only inserts what is missing |

## Migrations

- Edit `src/lib/db/schema.ts`, then run `npm run db:generate`, and commit the new SQL in `drizzle/`.
- Never edit a migration that has been applied anywhere.
- drizzle-kit does not know the FTS5 table `asset_fts` or its three `asset_fts_*` triggers (hand written in
  `drizzle/0004_describe.sql`). If a migration makes drizzle-kit recreate the `assets` table, re-add the triggers and
  rebuild `asset_fts` in that migration by hand.

## Before a commit

Run all three and fix what they report:

- `npm run typecheck`
- `npm run lint`
- `npm run smoke`

If the user keeps a private denylist of their own names, also run the leak gate (`scripts/leak-grep.sh`, the full
command is in [docs/architecture.md](docs/architecture.md)). Never copy denylist entries into the repo.

## Next.js 16 notes

- `params` and `searchParams` are Promises: await them.
- Middleware is `src/proxy.ts`.
- `next lint` is gone; lint is plain ESLint.
- Run `next typegen` before a bare `tsc` (`npm run typecheck` does it).
- This version has breaking changes from older Next.js. Read the guide in `node_modules/next/dist/docs/` before you
  write code that depends on Next behavior.

## Conventions

- Styling: Tailwind with shadcn tokens mapped in `src/app/globals.css` (`bg-card`, `border-border`,
  `text-muted-foreground`, `bg-brand`, `text-brand-text`, `text-paper` on dark overlays). No raw grays. The orange
  accent only for markers, focus, selection and key calls to action.
- SQL is parameterized only; escape `like` inputs.
- No sideways page scroll at any width; truncating grid text needs `grid-cols-1` (minmax(0, 1fr)).
- Drive names in messages come from `notMountedMessage(cfg)` / `driveLabel(cfg)`, never a literal.
- No fixed port outside the config: the web app reads `STUDIO_PORT` through `loadConfig()`, and the shell scripts
  (installer, `launcher/start.sh`, which prints the URL the desktop app opens) through `studio_port` in
  `scripts/studio-identity.sh`, which follows the same layers and rules (the smoke compares them in bash and zsh).
- Tool paths (`FFMPEG_PATH`, `FFPROBE_PATH`, `HIGGSFIELD_BIN`, `CODEX_BIN`, `CLAUDE_BIN`) are config keys read by
  their modules from the process environment; `applyToolEnv(cfg)` copies the env file's values in first
  (`scripts/next.ts` before it spawns Next, `src/worker/tool-env.ts` as the worker entry's first import). Keep a new
  module that reads one at load behind that import.
