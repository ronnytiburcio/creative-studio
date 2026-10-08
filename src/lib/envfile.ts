/**
 * The one env-file parser (pure: text in, key / value pairs out; dotenv's rules). It never opens a file: each module that
 * owns a secret file (config.ts for the Studio env file, meta/graph.ts for the Meta tokens, meta/ghl.ts for the GHL key)
 * reads its own file and hands the text here, so each stays the only reader of its secrets.
 */
import { parse } from "dotenv";

export function parseEnvText(text: string | Buffer): Record<string, string> {
  try {
    return parse(text);
  } catch {
    return {};
  }
}
