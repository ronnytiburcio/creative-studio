# Security

Creative Studio runs only on your own Mac. There is no hosted server, no account and no telemetry from the app. This
page explains what it stores, which outside services it talks to (only the ones you configure), and how to report a
problem. The full set of rules the code follows is in [docs/architecture.md](docs/architecture.md).

## Supported versions

Only the latest commit on the default branch is supported. Please update before you report a problem.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (the "Report a vulnerability" button under the
Security tab). Please do not open a public issue for a security problem. Include what you ran, what you expected and
what happened, and leave out any real keys or tokens.

## Local only by design

- The web app binds `127.0.0.1` only (port 4747 by default, `STUDIO_PORT`), never another network interface.
- Every request passes `src/proxy.ts`:
  - the `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (this blocks DNS rebinding);
  - any request that is not GET or HEAD (form posts and server actions included) needs an `Origin` header with the same
    host; a missing or `null` Origin is refused;
  - when the browser sends `Sec-Fetch-Site`, it must be `same-origin` or `none`, except a plain page navigation.
- So another website open in your browser cannot post to Studio, and nothing outside your Mac can reach it.
- The one route that spends money from the web app, search by meaning (`GET /api/search/meaning`), also refuses
  anything but the app's own same-origin fetch, has a rate limit and stays inside your daily spending cap.

## What Studio stores, and where

| What | Default location | Notes |
|---|---|---|
| Settings and keys | `~/.studio/.env` | mode 0600 in a 0700 folder: Studio creates both that way when it writes the template on first start, and the [install guide](docs/install.md) sets the same modes when you create them yourself. Studio never writes to the file after that. |
| Optional key files you add | `~/.studio/meta.env`, `~/.studio/meta-company.env`, `~/.studio/youtube-client-secret.json` | read only; set your own paths in the env file |
| YouTube token | `~/.studio/youtube-token.json` | written only when you click Connect YouTube, mode 0600 in a 0700 folder; deleted on Disconnect |
| Database | `~/Studio-Data/studio.db` | your index, descriptions, scores, ad numbers, notes. No keys or tokens. |
| Cache | `~/Studio-Data/cache` | thumbnails, contact sheets, proxies, downloaded ad and Short thumbnails |
| Logs | `~/Studio-Data/logs` | app, worker and per job logs |
| Cut reel lists | `~/Studio-Data/handoffs` | new files only, mode 0600 |
| Ad order files | `~/Studio-Data/pending-clients`, `~/Studio-Data/pending-company` | new files only, mode 0600; never inside a git working tree |
| Generated media | `<your media folder>/Studio Generated/` | the only place Studio writes inside your media |

Every other file in your media folders is read only: Studio never writes, moves, renames or deletes it. Discard on a
generated file moves it to the macOS Trash, so it can be put back.

GHL lead data is kept to a minimum: a contact id, the date, the ad attribution keys and a test flag. No names, phone
numbers or emails.

## How secrets are handled

- Keys and tokens live only in their env or token file. Each is read by one module, fresh for each request, and sent
  in an HTTP header, never in a URL.
- They are never written to the database, logs, error messages, the status API or the browser. Settings shows only
  whether a key is present. Errors that come back from a service are shortened and scrubbed before they are stored or
  shown.
- Request logs in the database never hold a key or token. `ai_calls` (one row per Jev call) stores the purpose, the
  model, the questions and answers, token counts, the cost, the timing and any error. `meta_calls` and `yt_calls` store
  the request path (without its query string), the status, the timing and a short, scrubbed error.
- `claude -p` runs with your own subscription login (kept by the claude CLI in your keychain), with no tools, no MCP
  servers, no settings and a minimal environment that holds no API key. Studio never sees that login.
- Engine CLIs are started with argument arrays, never through a shell.
- Never commit your env files. `.gitignore` already ignores `.env` files.

## Which outside services Studio talks to

Nothing on this list is contacted until you configure it. With no keys and no CLIs installed, Studio makes no network
calls of its own while it runs.

| Service | Hosts | When | What |
|---|---|---|---|
| Jev (TypeSafe) | `api.typesafe.ai` | `TYPESAFE_API_KEY` is set and you run Classify, hook scoring, search by meaning or one of the two scoring CLIs | text only (descriptions, hook text, your notes), never media files. Every paid call is inside your daily cap and logged. Settings also makes a free model list check. |
| Meta | `graph.facebook.com`; Meta's image CDN for ad thumbnails | a Meta token is in `META_ENV_FILE` or `META_FKB_ENV_FILE` | GET requests only, once a day and on Refresh. Studio never creates, changes or deletes anything in Meta. |
| GHL (LeadConnector) | `services.leadconnectorhq.com` | `GHL_API_KEY` and `GHL_LOCATION_ID` are set and a lane or client counts GHL leads | one contacts search request (a read) |
| Google (YouTube) | `oauth2.googleapis.com`, `www.googleapis.com`, `youtubeanalytics.googleapis.com`, `i.ytimg.com` | only after you click Connect YouTube in Settings | read only scopes (`youtube.readonly`, `yt-analytics.readonly`), once a day and on Sync now |
| Ollama | your own Mac (`127.0.0.1:11434` by default) | Ollama is running | describes images and video frames locally. The URL must be a loopback address; Studio refuses anything else. |
| whisper.cpp | your own Mac | `whisper-cli` and its model are installed | local speech to text |
| Higgsfield CLI | Higgsfield's own service | the CLI is installed and you confirm a quoted run (plus free model lists, quotes and account status) | the prompt and the reference files you pick |
| Codex CLI | OpenAI, through your ChatGPT login in the CLI | the CLI is installed and you run a ChatGPT image | the prompt and the reference files you pick |
| claude CLI | Anthropic, through your own subscription login | the CLI is installed and signed in, and you run Rewrite variants, Shorts moments or Draft the rest | text only (a hook, a transcript, your notes) |

Installing and building also use the network: `npm install` downloads packages, and building the app downloads the
Outfit font from Google Fonts once (it is served locally after that). `npm run dev` and `npm run start` turn Next.js
telemetry off.

## Things to keep in mind

- Anyone who can log in to your Mac user account can open Studio and read its files. Use your Mac's own account
  password and FileVault.
- Studio trusts the media you point it at as data, not code: it never executes files from your media folders.
- Order files and hand-off lists are meant for your own tools in a live session you control. Read an order before you
  let a tool apply it.
