/**
 * Derived outputs in STUDIO_CACHE/<fingerprint>/ and the asset column that points at each.
 * Shared by the worker (derive/queue) and the media route. Safe for client import.
 */
export const OUTPUTS = {
  poster: { column: "thumb_path", file: "poster.jpg" }, // video thumbnail
  thumb: { column: "thumb_path", file: "thumb.webp" }, // image thumbnail
  sheet: { column: "sheet_path", file: "sheet.jpg" },
  proxy: { column: "proxy_path", file: "proxy.mp4" },
} as const;

export type OutputKey = keyof typeof OUTPUTS;
export type CacheColumn = (typeof OUTPUTS)[OutputKey]["column"];

/** Variants the media route serves. `thumb` covers both poster.jpg (video) and thumb.webp (image). */
export const MEDIA_VARIANTS = ["thumb", "sheet", "proxy", "original"] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

export const VARIANT_COLUMN: Record<Exclude<MediaVariant, "original">, CacheColumn> = {
  thumb: OUTPUTS.thumb.column,
  sheet: OUTPUTS.sheet.column,
  proxy: OUTPUTS.proxy.column,
};
