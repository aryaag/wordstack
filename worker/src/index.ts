export { Room } from "./room";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ROOM: DurableObjectNamespace;
}

const ROOM_WS = /^\/room\/([^/]+)\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check — confirms the Worker (and its bindings) are live.
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "upwords", ts: Date.now() });
    }

    // Word validity — pure D1 set membership. The caller passes the already-
    // expanded ASCII string (the Qu tile is expanded to "qu" upstream).
    if (url.pathname === "/validate") {
      const word = (url.searchParams.get("word") ?? "").trim().toLowerCase();
      if (!/^[a-z]{2,}$/.test(word)) {
        return Response.json({ error: "word must be 2+ letters a-z" }, { status: 400 });
      }
      const row = await env.DB.prepare("SELECT 1 FROM words WHERE word = ? LIMIT 1")
        .bind(word)
        .first();
      return Response.json({ word, valid: row !== null });
    }

    // /room/:code/ws — route the WebSocket to that room's Durable Object.
    const ws = ROOM_WS.exec(url.pathname);
    if (ws) {
      const code = ws[1].toUpperCase();
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // Everything else → static frontend (SPA fallback handled by Assets config).
    return env.ASSETS.fetch(request);
  },
};
