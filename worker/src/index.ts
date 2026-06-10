import { enforce, type RateLimiter } from "./ratelimit";
import type { DefineResult } from "./protocol";

export { Room } from "./room";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  MW_KEY?: string; // Merriam-Webster Collegiate API key (Worker secret)
  CREATE_LIMITER?: RateLimiter;
  WS_LIMITER?: RateLimiter;
  VALIDATE_LIMITER?: RateLimiter;
  DEFINE_LIMITER?: RateLimiter;
}

const MW_BASE = "https://www.dictionaryapi.com/api/v3/references/collegiate/json";

/** Parse the raw MW array into a minimal shape. Real entries are objects with
 *  `shortdef` (string[]) + `fl`; a not-found word yields an array of plain
 *  suggestion strings. The raw payload is never returned or stored. */
function parseMW(data: unknown, word: string): DefineResult {
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

const ROOM_WS = /^\/room\/([^/]+)\/ws$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function generateCode(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check — confirms the Worker (and its bindings) are live.
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "upwords", ts: Date.now() });
    }

    // Word validity — pure D1 set membership. Caller passes the already-expanded
    // ASCII string (the Qu tile is expanded to "qu" upstream).
    if (url.pathname === "/validate") {
      const limited = await enforce(request, env.VALIDATE_LIMITER);
      if (limited) return limited;
      const word = (url.searchParams.get("word") ?? "").trim().toLowerCase();
      if (!/^[a-z]{2,}$/.test(word)) {
        return Response.json({ error: "word must be 2+ letters a-z" }, { status: 400 });
      }
      const row = await env.DB.prepare("SELECT 1 FROM words WHERE word = ? LIMIT 1")
        .bind(word)
        .first();
      return Response.json({ word, valid: row !== null });
    }

    // Definition lookup — live Merriam-Webster proxy. Called only when a player
    // taps "Define" on a played word. Flow is strictly fetch → parse → return →
    // discard: the raw MW response is never cached, persisted, or logged.
    // COMMERCIAL NOTE: MW free tier is non-commercial (1,000 req/day). If this
    // app ever gets ads or a paid tier, a commercial MW agreement is required.
    if (url.pathname === "/define") {
      const limited = await enforce(request, env.DEFINE_LIMITER);
      if (limited) return limited;
      const word = (url.searchParams.get("word") ?? "").trim().toLowerCase();
      if (!/^[a-z]{2,}$/.test(word)) {
        return Response.json({ word, error: "word must be 2+ letters a-z" } satisfies DefineResult, {
          status: 400,
        });
      }
      if (!env.MW_KEY) {
        return Response.json({ word, error: "Definitions are unavailable right now." } satisfies DefineResult, {
          status: 503,
        });
      }
      try {
        const mw = await fetch(`${MW_BASE}/${encodeURIComponent(word)}?key=${env.MW_KEY}`);
        if (!mw.ok) {
          return Response.json({ word, error: "Dictionary lookup failed." } satisfies DefineResult, { status: 502 });
        }
        const result = parseMW(await mw.json(), word);
        return Response.json(result satisfies DefineResult);
      } catch {
        return Response.json({ word, error: "Could not reach the dictionary." } satisfies DefineResult, {
          status: 502,
        });
      }
    }

    // Create a room — mints a Durable Object (rate-limited: the DoS target).
    if (url.pathname === "/room" && request.method === "POST") {
      const limited = await enforce(request, env.CREATE_LIMITER);
      if (limited) return limited;
      const code = generateCode();
      const id = env.ROOM.idFromName(code);
      await env.ROOM.get(id).fetch(new Request(`https://do/init?code=${code}`, { method: "POST" }));
      return Response.json({ code });
    }

    // /room/:code/ws — route the WebSocket to that room's Durable Object.
    const ws = ROOM_WS.exec(url.pathname);
    if (ws) {
      const limited = await enforce(request, env.WS_LIMITER);
      if (limited) return limited;
      const code = ws[1].toUpperCase();
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // Everything else → static frontend (SPA fallback handled by Assets config).
    return env.ASSETS.fetch(request);
  },
};
