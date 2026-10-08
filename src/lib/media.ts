/** Media kinds, extensions, orientation buckets, formatting. Safe for client + server. */

export type Kind = "video" | "image" | "audio";
export type Orientation = "9:16" | "16:9" | "1:1" | "4:5" | "other";

export const VIDEO_EXT = ["mp4", "mov", "m4v"] as const;
export const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "heic", "gif"] as const;
export const AUDIO_EXT = ["m4a", "wav", "mp3", "aac"] as const;

export const ORIENTATIONS: Orientation[] = ["9:16", "16:9", "1:1", "4:5", "other"];

export function kindForExt(ext: string): Kind | null {
  const e = ext.toLowerCase().replace(/^\./, "");
  if ((VIDEO_EXT as readonly string[]).includes(e)) return "video";
  if ((IMAGE_EXT as readonly string[]).includes(e)) return "image";
  if ((AUDIO_EXT as readonly string[]).includes(e)) return "audio";
  return null;
}

const TARGETS: [Orientation, number][] = [
  ["9:16", 9 / 16],
  ["4:5", 4 / 5],
  ["1:1", 1],
  ["16:9", 16 / 9],
];

/** Bucket display dimensions (already rotation-corrected). 4% tolerance. */
export function orientationBucket(width?: number | null, height?: number | null): Orientation | null {
  if (!width || !height) return null;
  const r = width / height;
  for (const [name, target] of TARGETS) {
    if (Math.abs(r / target - 1) <= 0.04) return name;
  }
  return "other";
}

export const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  aac: "audio/aac",
};

export function mimeFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

export function formatDuration(s?: number | null): string {
  if (s == null || !isFinite(s)) return "";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatBytes(n?: number | null): string {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(ms?: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "Acme / Acme Renovations" -> "Acme". */
export function clientShortName(name: string): string {
  return name.split(" / ")[0].trim();
}

/** A root's display label: the last segment of its path ("/Volumes/Drive/Client Media" -> "Client Media"). */
export function rootLabel(rootPath: string): string {
  return rootPath.split("/").filter(Boolean).pop() ?? rootPath;
}

/**
 * The folder a file sits in, as Jev reads it: "<root label>/<dir>" (or just the root label for a file at the root).
 * Without a root: the relative dir alone ("" at the root), which is what search's compact records use.
 */
export function folderOf(relPath: string, root?: string): string {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  if (root == null) return dir;
  const label = rootLabel(root);
  return dir ? `${label}/${dir}` : label;
}

/**
 * Where a file fits by its shape (PHASE-3 B3 `orientation_use`: derived in code, never asked, not stored). Vertical
 * video = Reels / Shorts (over 3 minutes: long vertical), 4:5 and square = feed, 16:9 video = YouTube; vertical
 * images = story statics, 4:5 and square = feed statics, wide images = thumbnails / web; anything else = either.
 */
export function orientationUse(kind: Kind, orientation: string | null, durationS: number | null): string | null {
  if (kind === "audio" || !orientation) return null;
  if (kind === "video") {
    switch (orientation) {
      case "9:16":
        return durationS != null && durationS > 180 ? "Vertical (long, over 3 min)" : "Reels / Shorts";
      case "4:5":
        return "Feed (4:5)";
      case "1:1":
        return "Feed (square)";
      case "16:9":
        return "YouTube";
      default:
        return "Either";
    }
  }
  switch (orientation) {
    case "9:16":
      return "Static (story)";
    case "4:5":
    case "1:1":
      return "Static (feed)";
    case "16:9":
      return "Wide (thumbnail, web)";
    default:
      return "Either";
  }
}

/**
 * A channel tab's URL: `/rtm/<tab>`, `/fkb/<tab>`, or `/fkbpros/<code>/<tab>` (`all` when there is no client code). The
 * one place the three sections map to a channel URL.
 */
export function channelHref(sectionKey: string | null | undefined, code: string | null | undefined, tab: string): string {
  if (sectionKey === "rtm") return `/rtm/${tab}`;
  if (sectionKey === "fkb") return `/fkb/${tab}`;
  return `/fkbpros/${code ?? "all"}/${tab}`;
}

/** A section's Library (All clients (Lane B) for a Lane B file). */
export function libraryPathFor(sectionKey: string | null | undefined): string {
  return channelHref(sectionKey, null, "library");
}

/** A clock time ("Oct 1, 6:00 AM"; null = "never"), for past and future times alike. */
export function formatWhen(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
}

/** Next's searchParams object or a URLSearchParams. */
export type SearchParamsInput = Record<string, string | string[] | undefined> | URLSearchParams;

/** One search param's first value (undefined when absent). */
export function searchParam(sp: SearchParamsInput, k: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(k) ?? undefined;
  const v = sp[k];
  return Array.isArray(v) ? v[0] : v;
}
