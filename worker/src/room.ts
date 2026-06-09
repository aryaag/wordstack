import type { Env } from "./index";

/**
 * Room — one Durable Object per game room. Phase 1 stub: it accepts a
 * hibernatable WebSocket and echoes messages, proving the Worker→DO→WS path.
 * Real game state, the engine, and the message protocol arrive in Phase 4.
 */
export class Room {
  private ctx: DurableObjectState;

  // `env` (D1, bindings) is wired in Phase 4 when the DO gains real game state.
  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    // Hibernatable API: the runtime owns the socket across DO eviction, so we
    // do NOT keep it in memory ourselves (and never use setTimeout for timing).
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", from: "room-do" }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    ws.send(
      JSON.stringify({
        type: "echo",
        message: typeof message === "string" ? message : "<binary>",
      }),
    );
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}
