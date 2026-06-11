// Merriam-Webster Collegiate lookup — fetch, parse to a minimal shape, discard
// the raw payload. Shared by the Worker route (worker/src/index.ts) and the room
// Durable Object's short-TTL in-memory cache (worker/src/room.ts).
//
// COMMERCIAL NOTE: MW free tier is non-commercial (1,000 req/day). If this app
// ever gets ads or a paid tier, a commercial MW agreement is required.
import type { DefineResult } from "./protocol";

const MW_BASE = "https://www.dictionaryapi.com/api/v3/references/collegiate/json";

/** Parse the raw MW array into a minimal shape. Real entries are objects with
 *  `shortdef` (string[]) + `fl`; a not-found word yields an array of plain
 *  suggestion strings. The raw payload is never returned or stored. */
export function parseMW(data: unknown, word: string): DefineResult {
  if (!Array.isArray(data) || data.length === 0) return { word, found: false };
  if (typeof data[0] === "string") {
    return { word, found: false, suggestions: (data as string[]).slice(0, 6) };
  }
  const entries: { fl: string; defs: string[] }[] = [];
  for (const e of data) {
    if (e && typeof e === "object") {
      const sd = (e as { shortdef?: unknown }).shortdef;
      if (Array.isArray(sd) && sd.length) {
        entries.push({
          fl: typeof (e as { fl?: unknown }).fl === "string" ? (e as { fl: string }).fl : "",
          defs: (sd as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3),
        });
      }
    }
    if (entries.length >= 3) break;
  }
  return entries.length ? { word, found: true, entries } : { word, found: false };
}

/** Look a word up against MW. `word` must already be validated (^[a-z]{2,}$). */
export async function lookupDefinition(word: string, mwKey: string | undefined): Promise<DefineResult> {
  if (!mwKey) return { word, error: "Definitions are unavailable right now." };
  try {
    const mw = await fetch(`${MW_BASE}/${encodeURIComponent(word)}?key=${mwKey}`);
    if (!mw.ok) return { word, error: "Dictionary lookup failed." };
    return parseMW(await mw.json(), word);
  } catch {
    return { word, error: "Could not reach the dictionary." };
  }
}
