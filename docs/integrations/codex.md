# ChatGPT images (Codex CLI)

If you pay for ChatGPT, Studio can make images with ChatGPT's image model through OpenAI's Codex command line tool, signed in with your ChatGPT account. There is no per image price in Studio: it uses what your ChatGPT plan includes.

## What it powers

- The **ChatGPT image** option in the **Generate** panel (images only, no video and no quick tools).
- **Remix** of a ChatGPT image.

See [Generate](../guide/generate.md) for the panel itself.

## What it costs

No credits and no quote: Studio shows "ChatGPT plan" instead of a price. Your ChatGPT plan's own limits apply, and OpenAI decides what happens when you reach them.

Measured on the original install: about 50 seconds per image.

## Install and connect

1. Install the Codex CLI with npm (you already have Node for Studio):

```bash
npm install -g @openai/codex
```

2. Sign in with your ChatGPT account (choose the ChatGPT sign in, not an API key):

```bash
codex login
```

3. Check it:

```bash
codex login status
```

It should say it is logged in using ChatGPT. Studio needs exactly that: a Codex signed in with an API key is refused ("Codex is signed in with an API key, not ChatGPT").

Studio looks for `codex` in this order: `CODEX_BIN` (a full path in your settings file `~/.studio/.env` or the process environment, which wins), `~/.local/bin/codex`, `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`. When it finds the npm wrapper, it runs the native binary inside the package with a minimal environment, so it also works under the background services.

## Check that it works

Open **Settings > Generation engines**. The **ChatGPT (Codex)** check shows **CLI found** and **Signed in with ChatGPT**, and Ready when both are yes. Otherwise it gives the reason ("Codex CLI not installed", "Codex is not signed in with ChatGPT (run codex login)").

## How a run works

- Runs happen only in the worker, up to 2 at a time.
- Studio runs `codex exec` in a temporary folder inside its cache, with `--ephemeral` (no saved session) and `--ignore-user-config` (your own Codex settings, MCP servers and plugins are skipped; your sign-in still comes from `~/.codex`). Codex may only write in that temporary folder.
- Codex gets one instruction: make exactly one image with its built-in image tool and save it as `out_1.png`. Your prompt comes last, and the reference images you added are attached.
- A run that takes longer than **10 minutes** is stopped.
- The result is checked to be a real image, then moved into your library like any generated file: `<STUDIO_DRIVE>/Studio Generated/<lane folder>/...` with a `.gen.json` sidecar. See [Higgsfield](higgsfield.md#where-results-go) for the folder and name rules; they are the same.

Codex itself also keeps a copy of each image it makes under `~/.codex/generated_images/`. That folder belongs to Codex, not Studio.

## Cancel and Retry

- **Cancel** works on a ChatGPT image at any time, also while it runs: the worker stops Codex and everything it started.
- **Retry** runs it again on your plan.
- If the worker restarts in the middle of a run, the job ends as interrupted; Retry runs it again.

## What Studio sends, and what it never does

- Only your prompt, the aspect ratio and the reference images you picked go to Codex.
- The CLI is started with an argument list, never through a shell, and stdin is closed.
- Studio never reads or shows your ChatGPT account details; it only checks `codex login status` for "ChatGPT".

## Switch it off

- Sign out of Codex or uninstall it: the ChatGPT option is greyed out with the reason, everything else works.
- `STUDIO_ENGINES=off` in the process environment hides Codex, Higgsfield and the claude CLI even when installed (the demo uses it).

## Common problems

See [troubleshooting](../troubleshooting.md#generate-says-an-engine-is-unavailable).
