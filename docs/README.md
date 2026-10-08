# Creative Studio manual

Every page of the manual, one line each. New here? Read the [README](../README.md), try the demo, then follow
[Install](install.md).

## Getting started

- [Install](install.md): from a fresh Mac to a running Studio, LaunchAgents, the desktop app, updating and uninstalling.
- [Configuration](configuration.md): every setting and its default, the settings and data folders, the lanes, the config
  file, the business profile, folder rules and ignore patterns.
- [Troubleshooting](troubleshooting.md): symptoms, causes and fixes, where the logs are, and the known limits.

## Using it

- [Library](guide/library.md): scanning, filters, the detail drawer, search and Meaning, folder rules.
- [Generate](guide/generate.md): the Generate panel, quick tools, quotes and confirm, Discard.
- [Describe, Classify and Review](guide/describe-classify-review.md): what the AI writes and files, and the Review queue.
- [Hooks](guide/hooks.md): the Hooks tab, the Rubric page, the Client tab, variants and rescoring.
- [Running](guide/running.md): ad numbers, flags, calibration, test order and staging a new paused ad.
- [Shorts](guide/shorts.md): episodes, clip ideas, cold opens, the board, Cut reel, kit notes and the YouTube Shorts list.
- [Jobs](guide/jobs.md): every queue and error in one place.
- [Settings](guide/settings.md): every card, including Lanes and Clients.

## Integrations

- [Jev (TypeSafe)](integrations/typesafe-jev.md): Classify, hook scores and search by meaning (paid per call, daily cap).
- [Meta](integrations/meta.md): the Running tab's ad numbers (read only).
- [GHL](integrations/ghl.md): leads per ad (read only).
- [YouTube](integrations/youtube.md): your Shorts and their numbers (read only).
- [Ollama](integrations/ollama.md): Describe with a local vision model (free).
- [whisper](integrations/whisper.md): what videos say and word timing for Shorts (free, local).
- [Higgsfield](integrations/higgsfield.md): image and video generation and quick tools (credits).
- [Codex](integrations/codex.md): ChatGPT images through your ChatGPT plan.
- [claude CLI](integrations/claude-cli.md): variants, clip ideas and ad copy drafts through your Claude plan.

## Reference and for developers

- [Architecture](architecture.md): processes, queues, data, the request path and the safety rules.
- [Cut reel hand-off](formats/cut-reel-handoff.md): the clip list the Shorts board writes for a reel cutting tool.
- [Ad orders](formats/ad-orders.md): the paused ad order file, its statuses and the lock an apply script shares.
- [Kit notes](formats/kit-notes.md): the `kit.json` next to a reel and the reel kit `VERSION` file.
- [Copy gate CLI](formats/copy-gate-cli.md): score new ad copy lines with Jev from a terminal.
- [Page scorer CLI](formats/page-scorer-cli.md): score landing page sections with Jev from a terminal.
- [Client files](formats/client-files.md): the optional ad map, shared ads registry, campaign files, approved copy doc
  and `Static Ads/` folder.
- [Screenshot list](images/SHOTS.md): every screenshot slot in the docs and what it shows.
- [CLAUDE.md](../CLAUDE.md): instructions for Claude Code and other coding agents working on this repo.
- [Security](../SECURITY.md) and [Contributing](../CONTRIBUTING.md).

## Glossary

- **Jev:** the scoring model Studio uses to classify files, score hooks and run search by meaning. Each call is paid
  and counts toward your daily cap.
- **TypeSafe:** the service that runs Jev. Your Jev key (`TYPESAFE_API_KEY`) is made in TypeSafe's
  [API console](https://console.typesafe.ai/) under API Keys. New sign ups were paused when this was written (October
  2026); see [Jev](integrations/typesafe-jev.md#get-a-key).
- **GHL:** GoHighLevel, a CRM. Studio reads its contacts (read only) to count leads per ad.
- **Lane:** a group of channels. There are three: the Brand lane, the Clients lane and the Company lane. You can rename
  them in Settings > Lanes.
- **Root:** a folder you add in Settings > Roots for Studio to index, with the lane it belongs to. Studio only reads it.
- **Folder rule:** a pattern in Settings > Tag rules that tags every file in matching folders to one or more clients.
- **Proxy:** a small 480p H.264 copy of a video that Studio makes in its cache, so any video plays in the browser.
- **Hook:** the opening of an ad or video, the part meant to stop the scroll. A text hook is a line of copy; a video
  hook is a video's opening (what it says and shows first).
- **Three P's:** the Person a hook is for, their Pain and the Promise (the one outcome). Jev checks whether each is
  clear.
- **Copy mechanic:** the hook style a line uses, such as "Lead with a number", "Curiosity loop" or "Show the
  transformation". The rubric lists them, and the Hooks tab shows which ones you have not tried yet.
- **Cold open:** one or two sentences (2 to 6 seconds) from inside a Shorts clip that the reel shows first, before the
  clip plays from its start. It is the card's main hook on the Shorts board.
- **Hook rate:** for a video ad, the share of impressions that watched at least 3 seconds.
- **Hold rate:** for a video ad, the share of those 3 second views that went on to a ThruPlay (Meta's count of views
  that played to the end or for at least 15 seconds).
