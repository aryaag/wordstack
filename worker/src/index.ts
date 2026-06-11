import { enforce, type RateLimiter } from "./ratelimit";
import { lookupDefinition } from "./define";
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

const ROOM_CODE = /^[A-Z0-9]{4,8}$/;

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
    // taps "Define" on a played word. When a room code is supplied the lookup is
    // routed through that room's Durable Object, which holds a short-TTL (5 min)
    // in-memory cache so the same word defined by several players in a turn is
    // fetched once. The MW response is parsed and only ever held transiently in
    // memory — never written to D1, DO storage, KV, or a log.
    if (url.pathname === "/define") {
      const limited = await enforce(request, env.DEFINE_LIMITER);
      if (limited) return limited;
      const word = (url.searchParams.get("word") ?? "").trim().toLowerCase();
      if (!/^[a-z]{2,}$/.test(word)) {
        return Response.json({ word, error: "word must be 2+ letters a-z" } satisfies DefineResult, {
          status: 400,
        });
      }
      const room = (url.searchParams.get("room") ?? "").toUpperCase();
      if (ROOM_CODE.test(room)) {
        // Per-room cache lives in the DO (shared by everyone in the room).
        const id = env.ROOM.idFromName(room);
        return env.ROOM.get(id).fetch(new Request(`https://do/define?word=${word}`));
      }
      // No room context (e.g. a direct probe) → uncached one-off lookup.
      const result = await lookupDefinition(word, env.MW_KEY);
      const status = "error" in result ? (env.MW_KEY ? 502 : 503) : 200;
      return Response.json(result satisfies DefineResult, { status });
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
