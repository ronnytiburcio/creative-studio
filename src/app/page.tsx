import { redirect } from "next/navigation";
import { laneHome } from "@/lib/queries";

/**
 * Home: the first enabled lane's Library (laneHome; Lane A unless it is switched off). One exception (Phase 5 slice 4): Google's OAuth loopback redirect for "Connect YouTube" lands
 * here (`http://127.0.0.1:<port>/?state=...&code=...`, the documented form for Desktop clients), so the OAuth answer is
 * handed to /api/youtube/callback as is (state / code / error only; nothing is read or stored here).
 */
export default async function Home(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const state = one("state");
  if (state && (one("code") || one("error"))) {
    const q = new URLSearchParams();
    for (const k of ["state", "code", "error"]) {
      const v = one(k);
      if (v && v.length <= 4096) q.set(k, v);
    }
    redirect(`/api/youtube/callback?${q}`);
  }
  redirect(laneHome());
}
