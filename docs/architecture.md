# Architecture

This page is for developers: how Creative Studio is put together, which process may do what, and the safety rules
every change has to keep. If you only want to run the app, start with [install.md](install.md).

Creative Studio is a Next.js 16 app (App Router, React 19) with a SQLite database, plus a separate Node worker. Both run
on your Mac only. Nothing is hosted.

## Contents

- [Two processes](#two-processes)
- [The worker's queues](#the-workers-queues)
- [Data](#data)
- [Install identity](#install-identity)
- [Version constants](#version-constants)
- [The request path](#the-request-path)
- [Hard safety rules](#hard-safety-rules)
- [No names in code](#no-names-in-code)
- [Mac only spots](#mac-only-spots)
- [Tests and the leak gate](#tests-and-the-leak-gate)
- [Next.js 16 notes](#nextjs-16-notes)
- [Where things live](#where-things-live)

## Two processes

| Process | Started by | What it does |
|---|---|---|
| Web app | `npm run dev` or `npm run start` (both go through `scripts/next.ts`) | Serves the UI, the route handlers under `src/app/api/` and the server actions in `src/app/actions.ts`. Binds `127.0.0.1` on `STUDIO_PORT` (default 4747), never another interface. |
| Worker | `npm run worker` (`src/worker/index.ts`) | Scans and watches the roots, fills the cache, and runs every queue below. All paid and network work happens here, apart from the exceptions listed under [the network rule](#paid-and-network-calls-run-in-the-worker). |

`scripts/next.ts` first creates the env file from its template when it is missing, then loads and validates the
config (a bad value stops it with a message naming the key), creates the database, cache and logs folders, and only
then starts `next dev` or `next start` with `-H 127.0.0.1 -p <port>` and `NEXT_TELEMETRY_DISABLED=1`.

The two processes share only the SQLite database (WAL mode) and the cache folder. They are independent: the UI works
without the worker (it shows "Worker offline") and without the media drive (a banner, browsing from the cache). The
worker writes a heartbeat row (`worker_status`) that the UI reads.

The server actions never run paid work themselves. They validate input with zod and insert or change rows (a job row,
a request timestamp, a pause flag). The worker picks the work up.

On a Mac you can run both as LaunchAgents (`scripts/install-launchd.sh`, see [install.md](install.md)).

## The worker's queues

Every queue lives in `src/worker/`. "Pull" queues have no job rows: they look for assets or hooks that are due, so a
restart has nothing to recover. Job queues keep rows in the `jobs` table and recover `running` rows on start.

| Queue (file) | Kind | Concurrency | May call |
|---|---|---|---|
| Ingest engine (`engine.ts`, `tags.ts`, `fingerprint.ts`, `probe.ts`) | scan + watch | n/a | the filesystem (read only toward roots), `ffprobe`, `sharp`, `/usr/bin/sips`. Applies folder tag rules and ignore patterns. |
| Derive (`queue.ts`, `derive.ts`) | jobs `derive_thumb`, `derive_proxy` | 2 (thumbnails first, then proxies shortest first) | `ffmpeg`, `sharp`, `/usr/bin/sips`. Writes only into the cache. |
| Generate (`gen.ts`) | jobs `gen_image`, `gen_video`, `gen_tool` | Higgsfield 3, Codex 2 | the Higgsfield CLI and the Codex CLI (argument arrays). Lands outputs through the WriteGuard. |
| Describe (`describe.ts`) | pull over assets | 1 | Ollama on a loopback URL, `whisper-cli`, `ffmpeg`. Reads cache files only (thumb, poster, contact sheet, proxy), never the drive. |
| Classify (`classify.ts`) | pull over described assets | 2 | Jev (TypeSafe), purpose `classify`. Starts paused. |
| Hook scores (`hooks.ts`) | pull over hooks | 2 | Jev, purpose `hook_score`. Starts paused. Also syncs video hooks with their assets every 15 seconds (SQL only). |
| Rewrite variants (`variants.ts`) | jobs `hook_variants` | 1 | `claude -p` (see [claude -p](#claude--p-has-no-tools-and-a-minimal-env)). 3 minute timeout. |
| Meta sync (`meta.ts`) | daily + Refresh | one account at a time | Meta Graph API (GET only) and the GHL contacts search. Daily at 18:00 America/New_York, plus Refresh. Also turns ad copy into hooks and refreshes test order suggestions (SQL only). |
| YouTube sync (`youtube.ts`) | daily + Sync now | 1 | the token refresh, the YouTube Data API and the YouTube Analytics API (GET only), thumbnails from `i.ytimg.com`. Daily at 06:00 America/New_York. Off until you connect. |
| Shorts (`shorts.ts`) | jobs `short_moments` + loops | 1 job at a time | episode sync every 30 seconds (guarded transcript reads), word transcripts with `whisper-cli` over the cached proxy, the board's automatic moves every 15 seconds, kit notes every 60 seconds, and `claude -p` for moments (15 minute timeout). |
| Ads (`ads.ts`) | jobs `ad_copy` + a loop | 1 job at a time | `claude -p` for "Draft the rest", and a guarded read back of every order file that may still change, every 60 seconds. Never Meta, never GHL. |

Per job logs go to `<STUDIO_LOGS>/jobs/` (for example `hook-variants-<id>.log`, `short-moments-<id>.log`,
`ad-copy-<id>.log`). The `claude -p` job rows and the word transcript errors, which the browser shows, carry only short
fixed error texts; the raw detail (which can name paths) stays in the log files.

## Data

### The database

- SQLite through `better-sqlite3`, with Drizzle as the query layer. Schema: `src/lib/db/schema.ts`.
- Migrations are SQL files in `drizzle/`, generated by `npm run db:generate` (drizzle-kit) and applied on every open by
  `openDb()` in `src/lib/db/index.ts`. Never edit a migration that has been applied; add a new one.
- Pragmas: WAL, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON`.
- The CLIs (`scripts/score-copy.ts`, `scripts/score-page.ts`) open an existing database without migrating or seeding
  it, and refuse one that is behind the repo's migrations.
- The full text index `asset_fts` (FTS5) and its three triggers on `assets` are hand written SQL in
  `drizzle/0004_describe.sql`. drizzle-kit does not know about them. If a future migration makes drizzle-kit rebuild
  the `assets` table (SQLite does some column changes as create, copy, drop, rename), that migration must re-add the
  three `asset_fts_*` triggers and rebuild `asset_fts` by hand.

### Seeding

`seed()` in `src/lib/db/seed.ts` runs on every open, inside one transaction:

1. `seedFromConfig()` reads the Studio config file (`STUDIO_CONFIG`) and inserts lanes and clients whose key is
   missing. It never updates an existing row: after the first start, Settings > Clients and Settings > Lanes own them.
   Roots, folder tag rules and the Company lane's ad account are inserted once each and remembered with a marker, so
   one you remove in Settings never comes back.
2. Versioned steps (tracked in `app_settings.seed_version`) add generic defaults: ignore patterns, the `Studio
   Generated` roots, the starter rubric, notes from the profile, and the paused flags. Each step only inserts what is
   missing. To add a default, append a step and bump `SEED_VERSION`.

See [configuration.md](configuration.md) for the config file and the business profile.

### The cache

Everything derived from a media file lives in `STUDIO_CACHE`, never next to the original.

- Each file gets a sampled fingerprint (`src/worker/fingerprint.ts`): sha256 over the size plus the first, middle and
  last 8 MB, or the whole file when it is 24 MB or smaller. It is stored in `assets.sha256`. It is not a full file hash.
- Derived files sit in `STUDIO_CACHE/<fingerprint>/`: `poster.jpg` (video), `thumb.webp` (image), `sheet.jpg` (contact
  sheet), `proxy.mp4` (480p H.264), and `ref1080.mp4` (a 1080p H.264 reference made only when a large or non H.264 video
  is sent to a generation engine). `src/lib/variants.ts` maps the first four to their asset columns; the reference
  transcode is planned in `src/lib/gen/refs.ts` and made by `src/worker/derive.ts` for `src/worker/gen.ts`. The DB
  stores these paths relative to the cache.
- Other cache folders: `meta/` and `youtube/` (downloaded thumbnails), `gen-tmp/`, `describe-tmp/`, `words-tmp/`,
  `claude-tmp/` (working folders, cleaned after each run), `claude-login/` (the Terminal script behind Settings >
  Claude > Sign in).
- The same bytes at two paths share one cache folder. A rename or move keeps the asset row (and its tags) when the
  fingerprint matches a row whose file is gone.
- There is no cache garbage collection yet: folders for deleted or changed files stay.

### Other folders Studio writes

| What | Where (default) | Writer |
|---|---|---|
| Database | `STUDIO_DB` (`~/Studio-Data/studio.db`) | the app and the worker |
| Cache | `STUDIO_CACHE` (`~/Studio-Data/cache`) | the worker (and the media route reads it) |
| Logs | `STUDIO_LOGS` (`~/Studio-Data/logs`) | both processes, the LaunchAgents |
| Env file | `~/.studio/.env`, created 0600 in a 0700 folder, only when missing | `ensureEnvFile()` |
| YouTube token | `YOUTUBE_TOKEN_FILE` (`~/.studio/youtube-token.json`), 0600 in a 0700 folder | `src/lib/youtube/auth.ts` only |
| Generated media | `<STUDIO_DRIVE>/Studio Generated/` | the WriteGuard only |
| Cut reel hand-off lists | `STUDIO_HANDOFFS` (`~/Studio-Data/handoffs`) | `src/lib/shorts/handoff.ts` only |
| Ad order files | `META_PENDING_DIR`, `META_FKB_PENDING_DIR` | `src/lib/meta/orders.ts` only |

The exact defaults and how to change them are in [configuration.md](configuration.md).

## Install identity

The identity decides the default folder and app names. It is resolved once per process by `resolveIdentity()` in
`src/lib/config.ts`; `scripts/studio-identity.sh` is its shell twin for the LaunchAgent installer, the uninstaller and
the desktop launcher (the smoke compares the two). The same shell file also reads config values for those scripts
(`studio_setting`, `studio_port`: process environment, then the env file read as text, never sourced, then the config
file's `env` through `plutil`), so the installer, `launcher/start.sh` and the desktop app use the configured port.

Without an identity file every install gets the neutral values:

| Value | Neutral default | Used for |
|---|---|---|
| Settings folder | `~/.studio` | the env file (`.env`) and Studio's YouTube token |
| Data folder | `~/Studio-Data` | the default parent of the database, cache, logs and hand-off lists |
| LaunchAgent label prefix | `com.studio` | the labels `<prefix>.web` and `<prefix>.worker` |
| App name | `Creative Studio` | page titles, messages and the desktop app (the config file's `app.name` wins for the display name) |
| Slug | `creative-studio` | a short machine name: the User-Agent of the Meta and GHL requests and the order lock owner |

An install that already runs under other names can keep them with an optional identity file in the repo's private
folder, `private/identity.env`. It is never exported. It holds `KEY=VALUE` lines (the env file parsing rules) for
`STUDIO_ID_SETTINGS`, `STUDIO_ID_DATA`, `STUDIO_ID_LABEL_PREFIX`, `STUDIO_ID_APP_NAME` and `STUDIO_ID_SLUG`. It must be
a regular file of at most 4 KB, and each value is checked against a strict pattern; a missing or bad value keeps the
neutral one. Your home folder never decides anything. The repo folder is found from the config module's own location
(the first folder up that holds a `package.json`), not from the current folder, so a script run from elsewhere still
reads the right file.

`STUDIO_IDENTITY` (process environment only) controls the file: unset, empty or `auto` reads it when present;
`neutral`, or any other value, never reads it, so a typo can only ignore the file. The demo sets `neutral`.
`STUDIO_ENV_FILE` and every explicit folder variable still win over the identity's defaults.

## Version constants

These constants in code mark what a stored result was made with. Bump one in the same change whenever you change what
it covers:

| Constant | File | Bump when | What a bump does |
|---|---|---|---|
| `CLASSIFY_VERSION` | `src/lib/ai/classes.ts` | a classify question, option description or state shape changes (the profile's `classify` texts included) | every classified file becomes due again and is classified again (paid Jev calls) |
| `DESCRIBE_PROMPT_VERSION` | `src/lib/ai/describe.ts` | the describe prompt changes (the profile's `describe` lines included) | every file is described again (local and free, but slow); a file described again is then also classified again |
| `MOMENTS_PROMPT_VERSION` | `src/lib/shorts/moments.ts` | the moments prompt changes (the profile's moments texts included) | recorded in each moments job's result; it only labels results, nothing re-runs |
| `WORDS_VERSION` | `src/lib/shorts/words.ts` | the word transcript format changes | every episode's word transcript is due again (local whisper) |
| `AD_RULES_VERSION` | `src/lib/meta/ad-copy-rules.ts` | any ad copy rule changes (the profile's ad house rules included) | written into every order as `checks.rules_version`; an apply script refuses any other version, so update it in the same change ([formats/ad-orders.md](formats/ad-orders.md)) |
| `SEED_VERSION` | `src/lib/db/seed.ts` | you add a seed default | append a step that only inserts what is missing; it runs once on the next open |

The page rubric is versioned differently: `PAGE_RUBRICS` in `src/lib/pages/rubric.ts` never changes in place; a new
wording is a new version appended there.

## The request path

Every request (except Next's static files and the built-in brand marks) passes `src/proxy.ts` (Next 16's name for
middleware) before it reaches a page, a route handler or a server action:

1. **Host:** the `Host` header's name must be `127.0.0.1`, `localhost` or `[::1]`, else 403. This blocks DNS
   rebinding.
2. **Writes:** any method other than GET or HEAD (server actions included) needs an `Origin` header whose host equals
   the request's `Host` and is local. A missing or `null` Origin is a 403.
3. **Fetch metadata:** when the browser sends `Sec-Fetch-Site`, it must be `same-origin` or `none`. The only exception
   is a plain GET page navigation (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`), so a bookmark or a link
   to the app still opens.

So a `curl` GET from the same Mac works (no Origin needed for a GET), and another website open in your browser cannot
post to Studio or read its API.

After the proxy:

- Route handler params and queries are validated with zod. Error bodies stay short and never echo paths or upstream
  error text.
- Server actions are zod validated and map unknown errors to fixed phrases.
- `GET /api/search/meaning` refuses (403) anything but the app's own same-origin fetch, so a page in another tab or
  the address bar cannot spend Jev money.

## Hard safety rules

These rules are the reason the app is safe to point at a media library you care about. A change that breaks one is a
bug, even if it works.

### Roots are read only, with one exception

- Nothing may write, move, rename or delete anything under a root. Derived files go to the cache, the database to
  `STUDIO_DB`, logs to `STUDIO_LOGS`. The config refuses a cache on the media drive.
- **The one exception** is generated media. Outputs of Generate (and their `.gen.json` sidecars) are written into
  `<STUDIO_DRIVE>/Studio Generated/`, and only through `src/lib/writeguard.ts` (`WriteGuard`). Every call checks, in
  order: the drive is mounted (`driveMounted(cfg)`, which follows `STUDIO_DRIVE_MODE`), the path is absolute with no
  NUL and no `..` segment, it is lexically inside the base, the real path of its parent is inside the real base, and
  the target is not a symlink. It never overwrites a file. Folders are created one checked segment at a time. Discard
  moves a file to the macOS Trash with `/usr/bin/trash`, also through the guard. No other module may write to a drive
  path.
- Roots may also live off the drive (for example a client's `Static Ads` folder). They are read only like every root.

### Two more folders Studio writes outside its own data

Studio writes to exactly two other places, each through one writer:

| Folder | Writer | Rules |
|---|---|---|
| `STUDIO_HANDOFFS` | `writeHandoffFile()` in `src/lib/shorts/handoff.ts`, called only by the Cut reel action | absolute, not `/`, never on the drive (lexical or real path), created 0700, never a symlink; names `<prefix>N reels[ yyyy-mm-dd-hhmm[-n]].json` only; JSON only; 64 KB cap; created with `O_CREAT \| O_EXCL \| O_NOFOLLOW`, mode 0600; an existing file is never overwritten (a dated name is used instead). |
| `META_PENDING_DIR`, `META_FKB_PENDING_DIR` | `writeOrderFile()` in `src/lib/meta/orders.ts`, called only by Stage | absolute, not `/`, never on the drive, never inside a git working tree (checked by the config at startup and again before every write), never a symlink (checked by the writer before every write); only the folder itself is created (0700); names `STUDIO-<yyyy-mm-dd>-<code>-<shortid>.json` only; JSON object only; 64 KB cap; `O_CREAT \| O_EXCL \| O_NOFOLLOW`, 0600; never overwritten. Cancel may rewrite Studio's own staged order to `cancelled`, under the order lock. |

The file formats are in [formats/cut-reel-handoff.md](formats/cut-reel-handoff.md) and
[formats/ad-orders.md](formats/ad-orders.md).

### Localhost only

The server binds `127.0.0.1`. `src/proxy.ts` enforces the host and same-origin rules above. Do not add a route that
works around them, and do not bind another interface.

### Every file is served through a guard

- Every file a request can reach goes through `src/lib/fsguard.ts`: `resolveInside()` (resolve, real path, prefix
  check against the allowed bases) or `resolveCacheFile()` (a cache relative path that must stay in the cache).
- An original media file is only ever opened through `originalFileFor()` in `src/lib/originals.ts`: the root is
  enabled, the asset is not missing or ignored, the drive is mounted when the root lives on it, and the real path is
  inside an enabled root. This covers the media route, Reveal in Finder, the drawer and generation references.
- Never open a path that came from a request directly.
- Text next to the media (episode transcripts, reel captions, kit notes) is read only through `src/lib/textread.ts`:
  inside the enabled roots, `O_RDONLY | O_NOFOLLOW`, a regular file, an extension allowlist per caller, and a size cap.

### Paid and network calls run in the worker

Paid work and calls to outside services run in the worker's queues. The web process may make free, local checks
(model lists, cost quotes and account status through the engine CLIs, Ollama's version and tags, the presence of
whisper files). The exceptions, which exist on purpose and nowhere else:

| Exception | What it does | Guard rails |
|---|---|---|
| `GET /api/search/meaning` | search by meaning: Jev ranks the described files for a plain language query (purpose `search`) | same-origin fetch only (403 otherwise), 20 paid searches a minute per process, a 10 minute in-memory cache, inside the daily cap |
| `scripts/score-copy.ts` | the copy gate CLI, run from a terminal or an outside tool (purpose `copy_gate`) | one call per line, inside the daily cap, writes nothing but `ai_calls` rows. See [formats/copy-gate-cli.md](formats/copy-gate-cli.md). |
| `scripts/score-page.ts` | the landing page scorer CLI (purpose `page_score`) | one call per section, inside the daily cap, writes nothing but `ai_calls` rows; `--resolve` is free and read only. See [formats/page-scorer-cli.md](formats/page-scorer-cli.md). |
| `/api/youtube/callback` and Disconnect | the OAuth code exchange and the token revoke, both to `oauth2.googleapis.com` | a one time state (stored as sha256), PKCE S256, 10 minutes, single use; token refresh and every API read stay in the worker |
| `GET /api/claude/status` | runs `claude auth status --json` | free and local; keeps only "signed in" and the auth method word |
| `GET /api/ai/status` | Jev's free `GET /v1/models` | no paid call, the key is sent in the header only |

### The daily Jev cap

Every Jev call goes through `Jev.ask()` in `src/lib/ai/jev.ts`: the pinned model (`STUDIO_JEV_MODEL`, a versioned id;
`jev-latest` and `jev-preview` fail startup), the daily cap checked before sending (today's logged spend, plus calls
in flight in this process, plus the estimate; America/New_York day), retries for 429, 529 and 5xx with backoff (never
for 401, 403 or 422; a 403 is treated exactly like a 401: the key was refused), and one `ai_calls` row per call that reached the network. The cap is `jev:daily_cap_usd` in
`app_settings`: default $1, at most $20, set in Settings. When it is reached the queues wait until the next day and the
CLIs return unscored lines. Tests use `FakeJev`, never the API.

### Meta, GHL and YouTube are read only

- `src/lib/meta/graph.ts` has no write path. Its transport refuses any method but GET and any host but
  `graph.facebook.com`, and both the URL builder and the transport refuse the `method`, `_method`, `batch` and
  `access_token` query parameters (no method override or batch tunnel). The token goes in the Authorization header.
- `src/lib/meta/ghl.ts` runs one request only: `POST https://services.leadconnectorhq.com/contacts/search` (a search,
  so a read). The transport refuses any other method or URL. It keeps no contact details beyond an id, the date, the
  attribution keys and a test flag. Stored leads are mirror deleted only after a complete read.
- `src/lib/youtube/auth.ts` is the only reader of the OAuth client file and Studio's own token file. Scopes are exactly
  `youtube.readonly` and `yt-analytics.readonly`. The API transports allow GET only, to `www.googleapis.com` and
  `youtubeanalytics.googleapis.com`.
- Meta thumbnails are downloaded only from Meta's CDN hosts, YouTube thumbnails only from `ytimg.com` hosts, with size
  caps and content sniffing, into the cache.
- Studio never writes to Meta or GHL. A new PAUSED ad is only staged as an order file; an outside apply script does
  the write.
- Tests use stub transports, never the network.

### Secrets never leave their file

- Keys and tokens are read from their env file by one module each, fresh per request, and sent in a header only, never
  in a URL. The Jev key: `readTypesafeKey()` for `HttpJevTransport`. Meta tokens: `graph.ts`. The GHL key: `ghl.ts`.
  YouTube: `auth.ts`.
- Keys and tokens never go into the database, logs, error texts, the browser or `/api/status`. `keyStatus()` returns
  presence booleans only. `scrubSecrets()` (`src/lib/scrub.ts`) masks known values and Bearer tokens in anything
  derived from a request.
- The call ledgers store no request bodies or query strings: `meta_calls` and `yt_calls` keep the path, status, timing
  and an error; `ai_calls` keeps the purpose, model, questions, answers, token counts, cost, timing and an error.
- Upstream error messages are stored short and scrubbed, never with a key or token in them: Meta's own error message
  (`Meta <status> (#code): <message>`, clipped), the detail of a Jev refusal such as a 422 (up to 240 characters), and
  for YouTube only Google's short error code (`YouTube <status> (<reason>)`, never Google's message). They show on the
  Jobs and Settings pages.
- Stored or shown error texts never carry an env file path.

### Engine CLIs are spawned with argument arrays

Higgsfield, Codex, ffmpeg, whisper, sips and claude are always started with an argument array, never a shell string.
Every Higgsfield run is quoted first (`generate cost`) and needs one confirm click; a job with no quote is refused.
`STUDIO_ENGINES=off` (process env) makes the Higgsfield, Codex and claude resolvers return nothing, which the demo uses.

### claude -p has no tools and a minimal env

Rewrite variants, Shorts moments and "Draft the rest" use the `claude` CLI through `src/lib/hooks/claude.ts`:

- the real binary by its real path (`CLAUDE_BIN` overrides), run in the worker only, one job at a time per queue;
- flags `-p --output-format json --tools "" --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources ""
  --safe-mode --no-session-persistence --disable-slash-commands --system-prompt <ours>`, the prompt last;
- env limited to `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`, `NODE_ENV` and `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (no
  API key: it uses your own subscription login);
- stdin `/dev/null`, a working folder under the cache, its own process group, a timeout;
- never `--dangerously-skip-permissions`, never the Anthropic API.

Tests use a stub script through `CLAUDE_BIN`.

## No names in code

Code, comments, tests and fixtures in everything that ships (`src/`, `scripts/`, `drizzle/`, `launcher/`, `public/`,
`demo/` and the root config files) use neutral wording only. No business, brand, client, person or account names or
ids, no home paths, no trade words used as someone's business.

Business wording lives in your Studio config file instead:

- lanes, clients, roots and folder rules in the top level keys;
- every text a model reads that names a business or a house rule (classify categories, lane descriptions, prompt voice
  lines, copy rules, ad naming, the starter rubric) in its `profile` section (`src/lib/profile-schema.ts` documents
  each key; `src/lib/profile-defaults.ts` holds the neutral built-ins).

Client components get labels through `useLabels()` and copy rules as data; `src/lib/profile.ts` is server only.

The repo has a leak gate for this rule, `scripts/leak-grep.sh`. It scans paths for regexes from a denylist that you
keep outside the repo (or in an ignored folder), because a denylist of your own clients would itself be a leak. The
denylist is a plain text file with one Perl regex per line, matched case-insensitively (a line starting with `c:` is
case-sensitive; blank lines and lines starting with `#` are skipped). Put in it the names, codes, ids, domains and
paths that must never ship. Pass it with `--deny`; without `--deny` the script looks for `private/leak-denylist.txt`
in the repo and exits 2 when there is none.

This is the full command. Its path list is everything an export publishes (the `EXPORTED` list in
`scripts/smoke-scrub.ts`); run it from the repo root:

```bash
bash scripts/leak-grep.sh --deny /path/to/your-denylist.txt src scripts drizzle launcher public demo package.json package-lock.json tsconfig.json next.config.ts eslint.config.mjs postcss.config.mjs drizzle.config.ts components.json studio.config.example.json .gitignore manual README.md LICENSE SECURITY.md CONTRIBUTING.md .env.example
```

Exit 0 means no hits, 1 means hits (printed as `path:line: matched text`), 2 means a usage problem or a missing
denylist. `scripts/leak-allow.txt` lists exact allowed leftovers, one per line as `<text><TAB><path>[<TAB># reason]`,
where `<text>` is the matched text in lower case or `sha256:` of it (so the allowlist never spells out a private word).

## Mac only spots

Creative Studio runs on Apple Silicon Macs only. If you want to port it, these are the places that assume macOS:

| Spot | Where | Why |
|---|---|---|
| LaunchAgents | `scripts/install-launchd.sh`, `scripts/uninstall-launchd.sh`, `launcher/` | auto start at login, KeepAlive; the desktop launcher is an AppleScript applet |
| `/usr/bin/sips` | `src/worker/derive.ts`, `probe.ts`, `gen.ts` | HEIC to JPEG (sharp's prebuilt libvips reads AVIF but not HEIC) and image size fallback |
| `/usr/bin/trash` | `src/lib/writeguard.ts` | Discard moves a generated file to the Trash, recoverable |
| `/usr/bin/open -a Terminal` | `src/lib/hooks/claude.ts` | Settings > Claude > Sign in opens a Terminal window that runs `claude auth login` |
| `/usr/bin/open -R` | `src/app/actions.ts` | Reveal in Finder |
| `h264_videotoolbox` | `src/worker/derive.ts` | hardware H.264 for proxies and reference transcodes, with a `libx264` fallback |
| chokidar 3.x with fsevents | `package.json`, `src/worker/engine.ts` | chokidar 4 and 5 drop fsevents and hold a kqueue file descriptor per watched file, which can stop you from ejecting a USB drive |
| `/opt/homebrew/bin/...` defaults | `src/worker/proc.ts` (`FFMPEG_PATH`, `FFPROBE_PATH`), `STUDIO_WHISPER_BIN` | Homebrew on Apple Silicon; LaunchAgents have no Homebrew PATH, so paths are absolute. The env file's tool paths reach both processes through `applyToolEnv` (`scripts/next.ts`, `src/worker/tool-env.ts`) |
| Drive mount check | `src/lib/fsguard.ts` | `external` mode compares the device id of `STUDIO_DRIVE` with its parent's |

## Tests and the leak gate

`npm run smoke` (`scripts/smoke.ts` plus the `scripts/smoke-*.ts` files it imports) is the test suite. It runs end to
end on a temp database, a temp cache, an ffmpeg made fixture folder and a temp folder standing in for the drive. It uses
fakes for every paid or outside service (`FakeAdapter` for generation, `FakeVision`, a stub whisper script, `FakeJev`,
stub Graph, GHL and YouTube transports, a stub `claude` through `CLAUDE_BIN`, a trapped `fetch`). It never touches your
real database, cache, env file or drive, and never calls a paid engine, Ollama, whisper or Jev. It needs ffmpeg and
ffprobe at `/opt/homebrew/bin/ffmpeg` and `/opt/homebrew/bin/ffprobe` (or `FFMPEG_PATH` and `FFPROBE_PATH` in the
process environment: the smoke runs on its own temp env file, not yours).

Some checks compare against a private snapshot of the original install. In a copy without it they print
`skipped (private)` and pass.

Before a commit:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run smoke
```

## Next.js 16 notes

- `params` and `searchParams` are Promises: `await` them in pages, layouts and route handlers.
- Middleware is now `src/proxy.ts` (the exported function is `proxy`).
- `next lint` is gone. `npm run lint` runs ESLint directly.
- Run `next typegen` before a bare `tsc`. `npm run typecheck` does both.
- Earlier routes can stay mounted but hidden for back and forward navigation, so a DOM count in a browser can see two
  copies of a page. Check visibility before you call it a duplicate render.
- The Next.js docs for this version ship in `node_modules/next/dist/docs/`. Read them before you rely on older habits.

## Where things live

| Area | Files |
|---|---|
| Config, identity, env file | `src/lib/config.ts`, `src/lib/studio-config.ts`, `src/lib/profile*.ts`, `scripts/studio-identity.sh` |
| Database | `src/lib/db/schema.ts`, `src/lib/db/index.ts`, `src/lib/db/seed.ts`, `drizzle/` |
| Guards | `src/proxy.ts`, `src/lib/fsguard.ts`, `src/lib/originals.ts`, `src/lib/writeguard.ts`, `src/lib/textread.ts`, `src/lib/privatefile.ts` |
| Generation | `src/lib/gen/`, `src/worker/gen.ts` |
| Describe, classify, search | `src/lib/ai/`, `src/worker/describe.ts`, `src/worker/classify.ts` |
| Hooks and rubric | `src/lib/hooks/`, `src/worker/hooks.ts`, `src/worker/variants.ts` |
| Meta, GHL, Running, ad orders | `src/lib/meta/`, `src/lib/calibration/`, `src/worker/meta.ts`, `src/worker/ads.ts` |
| YouTube | `src/lib/youtube/`, `src/worker/youtube.ts` |
| Shorts board, hand-offs, kit | `src/lib/shorts/`, `src/worker/shorts.ts` |
| Landing page scorer | `src/lib/pages/`, `scripts/score-page.ts` |
| UI | `src/app/(app)/`, `src/components/` |
| Demo | `demo/`, `scripts/demo.ts`, `scripts/demo-env.ts`, `scripts/demo-data.ts`, `scripts/make-demo.ts` |

The files Studio exchanges with outside tools are documented in `formats/`:
[cut-reel-handoff.md](formats/cut-reel-handoff.md), [ad-orders.md](formats/ad-orders.md),
[kit-notes.md](formats/kit-notes.md), [copy-gate-cli.md](formats/copy-gate-cli.md),
[page-scorer-cli.md](formats/page-scorer-cli.md) and [client-files.md](formats/client-files.md).
