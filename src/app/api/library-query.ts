/** Shared by /api/assets and /api/search/meaning (not a route itself): the Library's scope + filter query, zod-validated. */
import { z } from "zod";
import { ORIENTATIONS } from "@/lib/media";
import { SORTS, SOURCES, type Scope } from "@/lib/queries";
import { CATEGORY_IDS, ENERGY_BUCKET_IDS } from "@/lib/ai/classes";

const code = z.string().regex(/^[a-z0-9]{2,32}$/);

export const LibraryQuery = z.object({
  scope: z.enum(["rtm", "fkbpros", "fkb", "client", "all"]),
  client: code.optional(),
  kind: z.enum(["video", "image", "audio"]).optional(),
  orient: z.enum(ORIENTATIONS as [string, ...string[]]).optional(),
  folder: z.string().regex(/^r\d+(\/.{1,300})?$/).optional(),
  clients: z
    .string()
    .max(400)
    .refine((v) => v.split(",").every((c) => code.safeParse(c).success))
    .optional(),
  shared: z.enum(["0", "1"]).optional(),
  sort: z.enum(SORTS as [string, ...string[]]).optional(),
  source: z.enum(SOURCES as [string, ...string[]]).optional(),
  cls: z
    .string()
    .max(400)
    .refine((v) => v.split(",").every((c) => (CATEGORY_IDS as string[]).includes(c)))
    .optional(),
  review: z.enum(["1"]).optional(),
  energy: z.enum(ENERGY_BUCKET_IDS as [string, ...string[]]).optional(),
  q: z.string().max(200).optional(),
});

export const clientRequired = (v: { scope: string; client?: string }) => v.scope !== "client" || Boolean(v.client);

export function scopeOf(v: { scope: "rtm" | "fkbpros" | "fkb" | "client" | "all"; client?: string }): Scope {
  return v.scope === "client" ? { kind: "client", code: v.client! } : { kind: v.scope };
}
