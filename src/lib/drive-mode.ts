/**
 * STUDIO_DRIVE_MODE (client safe): how "the drive is there" is decided and worded.
 *  - `external`: STUDIO_DRIVE is a removable drive. Mounted = a directory on another device than its parent
 *    (src/lib/fsguard.ts isDriveMounted); the unplugged banner says "plug it in".
 *  - `folder` (default): STUDIO_DRIVE is any folder. Mounted = it exists, is a directory and is readable.
 * Either way the drive stays read only except `<drive>/Studio Generated/` through the WriteGuard.
 */
export const DRIVE_MODES = ["external", "folder"] as const;
export type DriveMode = (typeof DRIVE_MODES)[number];

export type DriveWords = {
  /** "mounted" / "available" (status pill, Settings). */
  up: string;
  /** "not mounted" / "not available". */
  down: string;
  /** Tooltip for anything that needs it: "Needs <label> mounted" / "Needs the <label> folder". */
  needs: (label: string) => string;
  /** How it comes back: "when the drive is plugged in" / "when the folder is available again". */
  back: string;
  /** Imperative: "Plug in <label>" / "Make <label> available". */
  bringBack: (label: string) => string;
};

const WORDS: Record<DriveMode, DriveWords> = {
  external: {
    up: "mounted",
    down: "not mounted",
    needs: (label) => `Needs ${label} mounted`,
    back: "when the drive is plugged in",
    bringBack: (label) => `Plug in ${label}`,
  },
  folder: {
    up: "available",
    down: "not available",
    needs: (label) => `Needs the ${label} folder`,
    back: "when the folder is available again",
    bringBack: (label) => `Make ${label} available`,
  },
};

/** The words for a mode (required: the config's STUDIO_DRIVE_MODE, also in /api/status `drive.mode`). */
export function driveWords(mode: DriveMode): DriveWords {
  return WORDS[mode];
}
