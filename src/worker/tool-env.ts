/**
 * The worker entry's FIRST import (src/worker/index.ts): copies the tool paths set in the env file (FFMPEG_PATH,
 * FFPROBE_PATH, HIGGSFIELD_BIN, CODEX_BIN, CLAUDE_BIN; config.ts TOOL_PATH_KEYS) into the process environment before any
 * module that reads one at load (src/worker/proc.ts FFMPEG / FFPROBE). The process environment still wins. A bad config
 * is left to main() to report (it loads the config again and exits with the message).
 */
import { applyToolEnv, getConfig } from "../lib/config";

try {
  applyToolEnv(getConfig());
} catch {
  // main() prints the config error and exits
}
