/**
 * The one secret scrubber shared by the Meta Graph, GHL and YouTube adapters (pure): every known secret value is replaced
 * by the mask, then any `Bearer <value>` left over. Each adapter adds its own provider-specific patterns on top
 * (Graph: access_token= values; Google: ya29. access tokens).
 */
export function scrubSecrets(text: unknown, secrets: readonly (string | null | undefined)[] = [], mask = "<token>"): string {
  let s = typeof text === "string" ? text : String(text ?? "");
  for (const v of secrets) if (v) s = s.split(v).join(mask);
  return s.replace(/(Bearer\s+)[A-Za-z0-9_\-.]{8,}/gi, `$1${mask}`);
}
