# whisper.cpp (spoken openings and episode transcripts)

whisper.cpp turns speech into text on your own Mac. Studio uses it for two things: the **spoken opening** of every video (what is said in the first 15 seconds) and the **word-timed transcript** of long episodes for the Shorts board. It is free, needs no account, and audio never leaves your Mac.

## What it powers

- **Spoken openings**: shown in the asset drawer next to the AI description, searchable, read by Classify, and used as the hook line of video hooks (the first sentence someone says).
- **Word-timed episode transcripts**: the Shorts board snaps every proposed moment and cold open to whole sentences using them. New moments jobs **wait** until their episode has a transcript, so the Shorts board needs whisper.

Studio asks whisper for English (`-l en`) and the default model is English only.

## What it costs

Nothing.

Measured on the original install: the first run after a restart takes about 8 seconds (the GPU warms up), then about half a second for a 15 second opening. A full episode takes longer, roughly in proportion to its length.

## Install and connect

1. Install whisper.cpp with Homebrew. It provides the `whisper-cli` command:

```bash
brew install whisper-cpp
```

2. Check where it landed (Studio's default is `/opt/homebrew/bin/whisper-cli`):

```bash
which whisper-cli
```

3. Make the folder for the model, inside Studio's data folder. This is the default folder Studio looks in; any other folder works if you set `STUDIO_WHISPER_MODEL` (below):

```bash
mkdir -p ~/Studio-Data/models
```

4. Download the English "small" model (about 470 MB) from the whisper.cpp model repository:

```bash
curl -L -o ~/Studio-Data/models/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

Studio also needs `ffmpeg` (it cuts the audio before whisper hears it). The [install guide](../install.md) covers it.

### Settings you can change

| Key | Default | What it does |
|---|---|---|
| `STUDIO_WHISPER_BIN` | `/opt/homebrew/bin/whisper-cli` | The whisper command. Must be an absolute path (or start with `~/`): the background services do not get Homebrew on their PATH |
| `STUDIO_WHISPER_MODEL` | `~/Studio-Data/models/ggml-small.en.bin` (the `models` folder in Studio's data folder) | The model file. Absolute path (or `~/`) |

Set them in the env file or the config file's `env` section (see [configuration](../configuration.md)) and restart Studio and the worker. A different model makes episode transcripts due again.

## Check that it works

Open **Settings > AI**. The **whisper.cpp** check shows **Binary found** and **Model found**. When one is missing it says which path it looked at ("Not found: ..."). The facts below it count spoken openings checked and how many had speech.

## What Studio sends, and what it never does

- whisper runs only in the worker, one run at a time (openings and episode transcripts share one lock).
- It hears **only Studio's cached 480p proxies**, never your original files. Studio cuts a 16 kHz mono WAV into a temporary folder in its cache, runs whisper, and deletes the temporary files afterwards.
- Episode transcripts are used for timing only. Your own subtitle file (the episode's SRT) is read, never changed.
- No network at all.

Music, silence or room noise often come out of whisper as "you", "Thank you." or `[BLANK_AUDIO]`. Studio treats those as "no speech", not as words.

## Switch it off

Studio switches whisper off by itself when the binary or the model is missing:

- Videos are still described; their spoken opening waits until whisper is there.
- New Shorts moments jobs wait for a transcript.

There is no separate pause for whisper. Pausing Describe in **Settings > AI** also stops spoken openings (episode transcripts are not paused by it).

## Common problems

See [troubleshooting](../troubleshooting.md#spoken-openings-or-transcripts-never-appear).

Related: [Shorts](../guide/shorts.md), [Describe, Classify and Review](../guide/describe-classify-review.md).
