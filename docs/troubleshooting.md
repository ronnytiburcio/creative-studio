# Troubleshooting

Each entry is a symptom, what usually causes it, and what to do. Commands run from the Studio folder (the repo) unless the text says otherwise.

The paths below are the defaults of a fresh install: settings and keys in `~/.studio/`, data in `~/Studio-Data/`. If you changed them, **Settings > Paths** shows yours (see [What Studio thinks its config is](#what-studio-thinks-its-config-is)).

## Where the logs are

| What | Where |
|---|---|
| Web app and worker started by hand (`npm run dev`, `npm run start`, `npm run worker`) | The Terminal window you started them in |
| Web app and worker started by the background services (LaunchAgents) | `~/Studio-Data/logs/web.log` and `~/Studio-Data/logs/worker.log` |
| One log per job (generations, hook variants, Shorts moments, ad copy drafts) | `~/Studio-Data/logs/jobs/` (`gen-<id>.log`, `hook-variants-<id>.log`, `short-moments-<id>.log`, `ad-copy-<id>.log`) |

The job logs live under `STUDIO_LOGS` (default `~/Studio-Data/logs`). The two background service logs always go to `logs` inside the data folder.

To see the last 100 lines of the worker's log:

```bash
tail -n 100 ~/Studio-Data/logs/worker.log
```

To keep watching it (press Ctrl+C to stop):

```bash
tail -f ~/Studio-Data/logs/worker.log
```

Error messages shown in the app are kept short on purpose. The full detail (file paths, ffmpeg or whisper output) is in these logs. Keys and tokens are never written to any log.

## Worker offline

**Symptom:** the sidebar says "Worker offline" (with how long ago it was last seen), the top bar shows a warning, and Settings cards say "Worker offline".

**Cause:** the worker is a separate process from the web app. It writes a heartbeat every 5 seconds; after 20 seconds without one, the app calls it offline. Either it is not running, or it stopped with an error.

**Fix:**

- Started by hand: open a second Terminal window in the Studio folder and run:

```bash
npm run worker
```

- With the background services: check both are loaded. Each line should show a number (the process id) in the first column:

```bash
launchctl list | grep com.studio
```

- If the worker is listed but keeps stopping, read the end of `~/Studio-Data/logs/worker.log`. The most common reason is an invalid setting (see [Studio will not start](#studio-will-not-start-config-is-invalid)). Restart it with:

```bash
launchctl kickstart -k gui/$(id -u)/com.studio.worker
```

The web app works without the worker (browsing, filters, the drawer), but nothing new is scanned, described, scored or synced until it is back. Never run a second worker by hand while the background one runs.

## The drive or media folder is not available

**Symptom:** a banner says "<name> is not available. Browsing from cache." (folder mode) or "<name> is not mounted. Browsing from cache." (external drive mode). Thumbnails and previews still work; Reveal in Finder, originals and Generate come back when the folder or drive is back.

**Cause and fix:**

- **The path is wrong.** `STUDIO_DRIVE` must point at the folder that holds your media (default `~/Studio-Media`). Check the value in your env file, fix it, and restart the web app and the worker.
- **External mode on a normal folder.** With `STUDIO_DRIVE_MODE=external`, Studio counts the drive as there only when the path is a real mount point (a separate disk). A normal folder is never "mounted". Use `STUDIO_DRIVE_MODE=folder` (the default) unless your media really lives on a removable drive.
- **The drive is unplugged.** Plug it in. Studio notices within seconds and rescans.
- **macOS blocks access.** Media on an external drive, or in Desktop, Documents or Downloads, can need permission. If macOS asks, allow it. If it never asked and Studio still cannot read the folder, open **System Settings > Privacy & Security > Files and Folders** (or **Full Disk Access**) and allow the app that runs Studio (Terminal, or `node` for the background services).

While the drive is away, nothing is marked missing and nothing is deleted. The worker pauses work that needs the originals and rescans when the drive is back.

To test what Studio looks like without the drive, start a second copy on another port with `STUDIO_FAKE_UNMOUNTED=1` (see [configuration](configuration.md)).

## Port 4747 is already in use

**Symptom:** `npm run dev` or `npm run start` stops with `EADDRINUSE` and `127.0.0.1:4747`.

**Cause:** something already listens on that port. Very often it is Studio itself, started by the background services.

**Fix:** see what holds the port:

```bash
lsof -nP -iTCP:4747 -sTCP:LISTEN
```

- If it is `node` and you installed the background services, Studio is already running: open `http://127.0.0.1:4747`. To work on Studio by hand instead, stop the services first (see [Background services](#background-services-launchagents)).
- If it is another program, give Studio another port: add `STUDIO_PORT=4749` to `~/.studio/.env` and restart. With the background services, restart both (see [Background services](#background-services-launchagents)). The services, the desktop app and YouTube's sign-in all follow the port by themselves: no new install and no new app build.

The demo always uses its own port, 4750, and refuses 4747 and 4748 so it never collides with a real install. To give it another one:

```bash
npm run demo -- --port 4760
```

## npm install warns about deprecated packages or vulnerabilities

`npm install` can end with lines such as "deprecated", "N vulnerabilities" or a notice that a newer npm is available. If it exits without an error, the install worked. Studio listens only on 127.0.0.1 and serves only you, so these warnings are for the project to follow up, not for you to fix. Do not run `npm audit fix --force`: it can move packages to versions Studio was never tested with. If you want to report one, open an issue.

## npm install fails on better-sqlite3 or sharp

These two packages contain native code built for your Mac.

**Check your Node first.** Studio needs Node 22 or newer, built for Apple Silicon:

```bash
node -v
```

```bash
node -p process.arch
```

The first should print `v22` or higher, the second `arm64`. If it prints `x64`, your Node runs under Rosetta: install the Apple Silicon build of Node (for example with Homebrew) and run `npm install` again.

**better-sqlite3** errors mention `gyp`, `prebuild-install` or `NODE_MODULE_VERSION`:

- Install Apple's command line tools (a window opens; follow it):

```bash
xcode-select --install
```

- Then rebuild the package for your current Node:

```bash
npm rebuild better-sqlite3
```

`NODE_MODULE_VERSION` errors after switching Node versions are fixed by the same rebuild. If you use the background services, run `scripts/install-launchd.sh` again afterwards: it records the path of the Node it was installed with.

**sharp** errors say it "Could not load the sharp module":

```bash
npm rebuild sharp
```

If that does not help, remove the installed packages and install again:

```bash
rm -rf node_modules
```

```bash
npm install
```

## Studio will not start: config is invalid

**Symptom:** `npm run dev`, `npm run start`, `npm run worker` or the worker's log stops with a message like:

```text
Creative Studio config is invalid (/Users/you/.studio/.env):
  - STUDIO_OLLAMA_URL: must be a loopback http URL, like http://127.0.0.1:11434 (Studio never sends media off this Mac)
Fix the values and restart.
```

**Fix:** the message names the key and the rule. Fix that value in the env file (or in the config file's `env` section) and start again. Common ones:

- `STUDIO_JEV_MODEL` must be a versioned id like `jev-1.13.0`, never `jev-latest` or `jev-preview`.
- `STUDIO_PORT` must be a whole number from 1 to 65535.
- `STUDIO_WHISPER_BIN` and `STUDIO_WHISPER_MODEL` must be absolute paths (or start with `~/`).
- `FFMPEG_PATH`, `FFPROBE_PATH`, `HIGGSFIELD_BIN`, `CODEX_BIN` and `CLAUDE_BIN` must be absolute paths (or start with `~/`) when set.
- `STUDIO_CACHE` must not be inside `STUDIO_DRIVE`.
- `META_PENDING_DIR` and `META_FKB_PENDING_DIR` must be absolute, must differ, must not be on the drive and must not be inside a git working tree (so not inside the Studio folder).

A problem in `studio.config.json` reads like "Creative Studio config is invalid: STUDIO_CONFIG (<path>) clients.1.code: 2 to 32 lowercase letters or digits. Fix the file and restart." It names the field and the rule, never the value you typed. "is not valid JSON" means a missing comma, quote or bracket. Unknown keys are refused, so a typo like `client` for `clients` is caught. See [configuration](configuration.md).

## Describe is waiting for Ollama

**Symptom:** Settings > AI says "Waiting: Ollama is not reachable at http://127.0.0.1:11434. Retrying on its own." or "Waiting: Model qwen3-vl:8b-instruct is not pulled in Ollama (ollama pull qwen3-vl:8b-instruct). Retrying on its own."

**Fix:**

- Not reachable: start Ollama.

```bash
brew services start ollama
```

- Model not pulled:

```bash
ollama pull qwen3-vl:8b-instruct
```

- "Ollama took longer than 180 s": the first call after a restart loads the model and is slow; on a Mac short on memory it can stay slow. Close other heavy apps. Studio checks whether Ollama is still alive and tries again.
- "Ollama is busy (HTTP 503)": another program is using Ollama. Studio waits and retries.

Describe never marks files as failed while Ollama is off; it just waits. Errors that belong to one file show in the Errors count with **Retry N errors** (Settings > AI) and on the Jobs page. More: [Ollama](integrations/ollama.md).

## Spoken openings or transcripts never appear

**Symptom:** videos have a description but no spoken opening, or Shorts moments jobs sit waiting.

**Fix:** open Settings > AI. The **whisper.cpp** check shows "Not found: <path>" for the binary or the model.

- Binary missing: `brew install whisper-cpp`, then check `which whisper-cli`. If it is not `/opt/homebrew/bin/whisper-cli`, set `STUDIO_WHISPER_BIN` to the full path.
- Model missing: download `ggml-small.en.bin` to the path shown (see [whisper](integrations/whisper.md)).
- Restart the worker after fixing either one.

A video with no audio track, or with only music, gets an empty spoken opening on purpose. An episode transcript that failed is tried again after 6 hours, or when the episode's video changes.

## Jev: no key, key refused or cap reached

| Message | Cause | Fix |
|---|---|---|
| "No Jev key (TYPESAFE_API_KEY in ~/.studio/.env)" | The env file has no key | Paste it after `TYPESAFE_API_KEY=` in the env file. No restart needed |
| "Jev refused the key (HTTP 401)" or "Jev refused the key (HTTP 403)" | The key is wrong, expired, revoked or not allowed (a 403 is handled exactly like a 401: no retry) | Make a new key in TypeSafe's API console (see [Jev](integrations/typesafe-jev.md#get-a-key)) and replace the line |
| "Daily Jev cap reached ($x of $y today)" | Today's spend hit your cap | Wait for midnight New York time, or raise **Daily cap (USD)** in Settings > AI |
| "Jev is not reachable", "Jev is overloaded (529)", "Jev rate limit (429)" | TypeSafe is down or busy | Nothing: the queues wait and retry on their own |
| "Jev refused the request (HTTP 422): ..." | Jev did not accept this one request | Stored on that file or hook; use Classify again or Score again later |

**Nothing gets classified or scored, and there is no error:** Classify and hook scoring start **paused** on a fresh install. Click **Resume classifying** and **Resume hook scoring** in Settings > AI. More: [Jev](integrations/typesafe-jev.md).

Search by meaning never blocks you: when Jev is not available it says why and shows the plain search results.

## Meta sync errors

Errors show per account in **Settings > Meta and GHL** (in orange) and on the Jobs page.

| Message | Cause | Fix |
|---|---|---|
| "No META_ACCESS_TOKEN in the META_ENV_FILE file." (or `META_FKB_ENV_FILE` for the Company lane) | The env file is missing or has no token | Add the token (see [Meta](integrations/meta.md)), then Sync now |
| `Meta 400 (#190): ...` | The token expired or was revoked | Make a new token and replace it. A system user token does not expire this way |
| `Meta 400 (#100): ...`, or the codes `#200` or `#10` | The token cannot see this ad account, or the account id is wrong | Give the token's user or system user access to the ad account with `ads_read`, and check the `act_` id |
| "could not identify the campaign in account" | Campaigns is set to **From state.json** and none of its rules found a campaign | Set Campaigns to **Every campaign** or **One campaign** in Settings > Clients > Edit |
| "no campaign id set for this account" / "the campaign id belongs to another ad account" | Campaigns is **One campaign** with a missing or wrong id | Fix the id in Settings > Clients > Edit |
| "Meta rate limit: waiting until <time>." | Meta asked Studio to slow down | Nothing. The sync waits and goes on by itself. New Meta apps have low limits at first |

**An account never syncs:** check that the worker is up, that the client has a **Meta ad account** set and is not **Hidden**, and that the sync is not **Paused** (Refresh still works while paused). The Company lane's account comes only from `studio.config.json` (`lanes.fkb.metaAdAccount`).

## GHL lead errors

| Message or symptom | Cause | Fix |
|---|---|---|
| "GHL_API_KEY or GHL_LOCATION_ID missing from the Meta env file." | A client is on **GHL leads** but the key or location id is missing | Add both to `META_ENV_FILE` (see [GHL](integrations/ghl.md)), or set the client's Leads to **Meta leads** |
| "GHL returned a partial list (N contacts): nothing removed, M stored leads kept." | GHL stopped early (or there are more than 5,000 contacts with that source) | Nothing is lost. The next sync tries again |
| Zero GHL leads for a client that has leads | The contacts' source is not the client's GHL source (default `<code>-fb-ad`) | Make your GHL forms set that source, or type the source you use in Settings > Clients > Edit > GHL source |
| Leads count for the client but not for any ad | The contacts' `utmContent` does not carry the ad name | Pass the ad name as `utm_content` on your ads |

## YouTube says Reconnect needed

**Cause:** Google refused Studio's saved sign-in. You revoked it, changed your Google password, or the consent screen of your Google Cloud project is in **Testing**, where Google can expire the sign-in after about a week.

**Fix:** Settings > YouTube, click **Reconnect**, and allow both permissions again. If it happens every week, publish your OAuth consent screen in the Google Cloud console.

Other YouTube problems:

- **"Google OAuth client (Desktop)" says No:** the client file is missing at `YOUTUBE_CLIENT_SECRET_FILE` (default `~/.studio/youtube-client-secret.json`), or it is not a **Desktop app** client.
- **"Last sync failed: YouTube 403 (accessNotConfigured)":** the YouTube Data API v3 or YouTube Analytics API is not enabled in your Google Cloud project.
- **"Google did not grant both read-only permissions":** on Google's page, allow both. Studio stores nothing until it has both.
- **A Short is missing from the list:** only uploads of 180 seconds or less count as Shorts.
- **A Short is not linked to its file:** use **Link a file** on the Shorts list.

More: [YouTube](integrations/youtube.md).

## claude jobs fail (signed out)

**Symptom:** Rewrite variants, New short or Draft the rest fail with "claude is not signed in on this Mac: Settings > Claude > Sign in (or run `claude auth login` in Terminal), then Retry."

**Fix:** Settings > Claude, click **Sign in**, finish the sign in in your browser, then click **Retry** on the failed jobs on the Jobs page. If no Terminal window opens, run it yourself:

```bash
claude auth login --claudeai
```

Other claude messages:

- "claude CLI not found": install it (see [claude CLI](integrations/claude-cli.md)) and check it is in `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`. If it lives somewhere else, set `CLAUDE_BIN` to its full path in your settings file and restart the worker.
- "claude took longer than N s and was stopped.": click Retry. Moments jobs get 15 minutes, the others 3.

## Generate says an engine is unavailable

Open **Settings > Generation engines**. Each engine says why:

- "Higgsfield CLI not installed" or "Codex CLI not installed": install it, then restart the worker. Studio looks in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. For another place, set `HIGGSFIELD_BIN` or `CODEX_BIN` to the full path in your settings file and restart the web app and the worker (see [configuration](configuration.md#programs-in-other-places)).
- "Higgsfield CLI is not signed in": sign in with the Higgsfield CLI.
- "Codex is signed in with an API key, not ChatGPT": run `codex login` and choose ChatGPT (see [Codex](integrations/codex.md)).
- In the demo, every engine is off on purpose (`STUDIO_ENGINES=off`).

**A Higgsfield job cannot be cancelled.** That is by design: once a Higgsfield job has started, its credits are spent and Higgsfield has no cancel. Cancel works only while the job still waits in Studio's queue.

## The Jobs page: Clear and Retry

- **Retry** runs a failed job or item again. For Higgsfield, the button says whether it spends credits.
- **Retry all N** retries every failed item of that kind.
- **Clear** hides one error row. It does not fix or change anything: it remembers the error text it hid, so the same error stays hidden, and a **different** error on the same item shows again. **Clear all errors (N)** does that for every row.
- Cleared errors leave the error counts and the sidebar's error badge.

See [Jobs](guide/jobs.md).

## Build warnings

`npm run build` can print a warning that dynamic filesystem access causes tracing of the whole project. It is harmless: Studio runs with `next start` on your own Mac, not on a hosting service that needs a traced bundle.

## Background services (LaunchAgents)

**"Bootstrap failed: 5: Input/output error"** from `scripts/install-launchd.sh`: the old service was still shutting down. Run the installer again:

```bash
scripts/install-launchd.sh
```

Then check both services show a process id:

```bash
launchctl list | grep com.studio
```

**You changed the code and nothing changed:** the background web app runs the last production build. Build again, then restart it:

```bash
npm run build
```

```bash
launchctl kickstart -k gui/$(id -u)/com.studio.web
```

If you changed worker code, restart the worker too:

```bash
launchctl kickstart -k gui/$(id -u)/com.studio.worker
```

**You changed your settings file** (the port, a program path, a folder): restart both services with the two
`launchctl kickstart` commands above (no `npm run build` needed). They read the file each time they start, so there is
no need to install them again.

**You want to run Studio by hand for a while:** stop the services first, so the port and the worker are free:

```bash
launchctl bootout gui/$(id -u)/com.studio.web
```

```bash
launchctl bootout gui/$(id -u)/com.studio.worker
```

Run `scripts/install-launchd.sh` again when you are done. To remove the services completely (your data stays):

```bash
scripts/uninstall-launchd.sh
```

**You switched Node versions:** run `scripts/install-launchd.sh` again. The services remember the exact Node they were installed with.

More: [install](install.md).

## Reset the demo

The demo keeps its data in `.demo-data/` inside the Studio folder. To wipe it and start fresh:

```bash
npm run demo -- --reset
```

`--reset` also wipes the demo's own build of the app (it lives in `.demo-data/next`), so the next run builds it again
by itself. To rebuild the demo's app without wiping its data:

```bash
npm run demo -- --build
```

`--reset` only deletes a folder that the demo made itself (it carries a `DEMO-DATA` marker file). It never touches a real install's data.

## What Studio thinks its config is

Open **Settings**:

- **Paths** card: the database, cache and logs folders, the env file it read ("Config"), and the address it listens on.
- **API keys** card: whether each key or token is present (never the values).
- **Settings > AI**, **Claude**, **Meta and GHL**, **YouTube** and **Generation engines**: each service's own checks.

When the app will not start at all, the error message names the env file it read. See [configuration](configuration.md) for how settings are layered.

## Known limits

- **Apple Silicon Macs only.** Studio uses macOS tools (launchd, `sips`, the Trash, Terminal, hardware video encoding) and is tested only there.
- **An empty value cannot clear a value from the config file.** An empty `KEY=` line in the env file counts as "not set", so the config file's `env` section (or the built-in default) still applies. To override it, set a different value.
- **A client's Meta ad account cannot change once it has synced numbers.** Add the new account as a new client with a new code.
- **The Company lane's ad account and its campaign and lead options come from `studio.config.json` once.** There is no Settings control for them.
- **A Higgsfield job cannot be cancelled once it started.**
- **Changing `STUDIO_VISION_MODEL` or `STUDIO_JEV_MODEL` re-runs the whole library** (Describe, then Classify, which costs money).
- **The cache is not cleaned up.** Previews of files you deleted or changed stay in the cache folder (`~/Studio-Data/cache`).
