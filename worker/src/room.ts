import {
  applyPlacement,
  DEFAULT_CONFIG,
  detectTrivialSuffixes,
  draw,
  extractWords,
  makeEmptyBoard,
  newShuffledBag,
  refill,
  scoreTurn,
  validatePlacement,
} from "./engine";
import type { PlacedTile, Tile } from "./engine";
import type {
  ClientMessage,
  GameState,
  PendingMove,
  PlayerState,
  PublicState,
  ServerMessage,
} from "./protocol";
import type { Env } from "./index";

const CONFIG = DEFAULT_CONFIG;
const WINDOW_MS = 30_000;

type Attachment = { playerId: string };

/** One Durable Object per room: authoritative game state + hibernatable WebSocket fan-out. */
export class Room {
  private ctx: DurableObjectState;
  private env: Env;
  private state: GameState | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<GameState>("state")) ?? null;
    });
  }

  // ── HTTP: room init + WebSocket upgrade ────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init")) {
      const code = url.searchParams.get("code") ?? "";
      if (!this.state) {
        this.state = freshLobby(code);
        await this.persist();
      }
      return Response.json({ ok: true });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernatable WebSocket lifecycle ───────────────────────────────────────
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.serialize(async () => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return this.send(ws, { type: "error", message: "malformed message" });
      }
      await this.handle(ws, msg);
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.serialize(async () => {
      const pid = this.playerIdOf(ws);
      const player = this.state?.players.find((p) => p.id === pid);
      if (player) {
        player.connected = false;
        await this.persistAndBroadcast();
      }
    });
  }

  /** DO Alarm = the 30s challenge-window backstop. */
  async alarm(): Promise<void> {
    await this.serialize(async () => {
      if (this.state?.phase === "pending") await this.resolve();
    });
  }

  // ── Message dispatch ───────────────────────────────────────────────────────
  private async handle(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "join":
        return this.onJoin(ws, msg.playerId, msg.name);
      case "start_game":
        return this.onStart(ws);
      case "submit_move":
        return this.onSubmit(ws, msg.placed);
      case "challenge_word":
        return this.onChallenge(ws, msg.wordIndex);
      case "acknowledge_move":
        return this.onAcknowledge(ws);
      case "pass":
        return this.onPass(ws);
      case "swap_tiles":
        return this.onSwap(ws, msg.index);
      case "leave":
        return this.onLeave(ws);
      default:
        return this.send(ws, { type: "error", message: "unknown message" });
    }
  }

  private async onJoin(ws: WebSocket, playerId: string, name: string): Promise<void> {
    const s = this.state;
    if (!s) return this.send(ws, { type: "error", message: "room not found" });

    const existing = s.players.find((p) => p.id === playerId);
    if (existing) {
      existing.connected = true; // reconnect to the same seat + rack
    } else {
      if (s.phase !== "lobby") return this.send(ws, { type: "error", message: "game already started" });
      if (s.players.length >= 4) return this.send(ws, { type: "error", message: "room is full" });
      const seat = s.players.length;
      s.players.push({
        id: playerId,
        name: name?.trim() || `Player ${seat + 1}`,
        seat,
        rack: [],
        score: 0,
        connected: true,
      });
      if (s.players.length === 1) s.hostId = playerId;
    }
    ws.serializeAttachment({ playerId } satisfies Attachment);
    await this.persistAndBroadcast();
  }

  private async onStart(ws: WebSocket): Promise<void> {
    const s = this.requireState(ws);
    if (!s) return;
    if (this.playerIdOf(ws) !== s.hostId) {
      return this.send(ws, { type: "error", message: "only the host can start the game" });
    }
    if (s.phase !== "lobby") return this.send(ws, { type: "error", message: "game already started" });
    if (s.players.length < 2) return this.send(ws, { type: "error", message: "need at least 2 players" });

    s.seed = Math.floor(Math.random() * 0xffffffff);
    let bag = newShuffledBag(s.seed);
    for (const p of s.players) {
      const dealt = refill([], bag, CONFIG.rackSize);
      p.rack = dealt.rack;
      bag = dealt.bag;
    }
    s.bag = bag;
    s.phase = "playing";
    s.turnSeat = 0;
    s.consecutivePasses = 0;
    await this.persistAndBroadcast();
  }

  private async onSubmit(ws: WebSocket, placed: PlacedTile[]): Promise<void> {
    const s = this.requireState(ws);
    if (!s) return;
    const player = this.requireCurrentPlayer(ws, s);
    if (!player) return;
    if (!Array.isArray(placed) || placed.length === 0) {
      return this.send(ws, { type: "error", message: "no tiles placed" });
    }

    const placement = validatePlacement(s.board, placed, player.rack, CONFIG);
    if (!placement.ok) return this.send(ws, { type: "error", message: placement.reason });

    const words = extractWords(s.board, placed);
    const triviality = await detectTrivialSuffixes(words, this.isValidWord);
    if (triviality.allTrivial) {
      return this.send(ws, { type: "error", message: triviality.reason ?? "trivial suffix" });
    }

    const score = scoreTurn(words, placed, CONFIG);
    const stances: PendingMove["stances"] = {};
    for (const p of s.players) if (p.id !== player.id) stances[p.id] = "pending";

    s.pending = {
      submitterId: player.id,
      placed,
      words: score.perWord.map((w) => ({ word: w.word, points: w.points })),
      totalPoints: score.total,
      bingoBonus: score.bingoBonus,
      deadline: Date.now() + WINDOW_MS,
      stances,
      challenges: {},
    };
    s.phase = "pending";
    await this.ctx.storage.setAlarm(s.pending.deadline);
    await this.persist();
    this.broadcast({
      type: "move_pending",
      words: s.pending.words,
      totalPoints: s.pending.totalPoints,
      bingoBonus: s.pending.bingoBonus,
      deadline: s.pending.deadline,
    });
    this.broadcastState();
    await this.maybeClose();
  }

  private async onChallenge(ws: WebSocket, wordIndex: number): Promise<void> {
    const s = this.requireState(ws);
    if (!s || !this.requirePending(ws, s)) return;
    const pending = s.pending!;
    const pid = this.playerIdOf(ws);
    if (!pid || pid === pending.submitterId) {
      return this.send(ws, { type: "error", message: "you cannot challenge your own move" });
    }
    if (!(pid in pending.stances)) return this.send(ws, { type: "error", message: "not in this game" });
    if (wordIndex < 0 || wordIndex >= pending.words.length) {
      return this.send(ws, { type: "error", message: "bad word index" });
    }
    const list = (pending.challenges[pid] ??= []);
    if (!list.includes(wordIndex)) list.push(wordIndex);

    await this.persist();
    this.broadcast({ type: "challenge_update", playerId: pid, wordIndex });
    this.broadcastState();
    await this.maybeClose();
  }

  private async onAcknowledge(ws: WebSocket): Promise<void> {
    const s = this.requireState(ws);
    if (!s || !this.requirePending(ws, s)) return;
    const pending = s.pending!;
    const pid = this.playerIdOf(ws);
    if (!pid || pid === pending.submitterId) return; // submitter's popup is read-only
    if (!(pid in pending.stances)) return this.send(ws, { type: "error", message: "not in this game" });
    pending.stances[pid] = "accepted";

    await this.persist();
    this.broadcastState();
    await this.maybeClose();
  }

  private async onPass(ws: WebSocket): Promise<void> {
    const s = this.requireState(ws);
    if (!s) return;
    const player = this.requireCurrentPlayer(ws, s);
    if (!player) return;
    s.consecutivePasses++;
    this.rotateTurn(s);
    await this.persistAndBroadcast();
  }

  private async onSwap(ws: WebSocket, index: number): Promise<void> {
    const s = this.requireState(ws);
    if (!s) return;
    const player = this.requireCurrentPlayer(ws, s);
    if (!player) return;
    if (s.bag.length === 0) return this.send(ws, { type: "error", message: "the bag is empty — cannot swap" });
    if (index < 0 || index >= player.rack.length) {
      return this.send(ws, { type: "error", message: "bad tile index" });
    }
    const removed = player.rack[index];
    const { drawn, bag } = draw(s.bag, 1);
    player.rack[index] = drawn[0];
    s.bag = [removed, ...bag]; // returned tile goes to the bottom of the bag
    s.consecutivePasses = 0;
    this.rotateTurn(s);
    await this.persistAndBroadcast();
  }

  private async onLeave(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ── Challenge window resolution ────────────────────────────────────────────
  private async maybeClose(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== "pending" || !s.pending) return;
    const pending = s.pending;
    const others = s.players.filter((p) => p.id !== pending.submitterId);
    const resolved = (p: PlayerState) =>
      pending.stances[p.id] === "accepted" || (pending.challenges[p.id]?.length ?? 0) > 0;
    if (others.every(resolved)) await this.resolve();
  }

  private async resolve(): Promise<void> {
    const s = this.state!;
    const pending = s.pending!;
    await this.ctx.storage.deleteAlarm();

    // Gather challenges: word index → challenger ids.
    const byWord = new Map<number, string[]>();
    for (const [pid, indices] of Object.entries(pending.challenges)) {
      for (const i of indices) byWord.set(i, [...(byWord.get(i) ?? []), pid]);
    }

    if (byWord.size > 0) {
      const challenged = [...byWord.entries()].map(([i, by]) => ({ word: pending.words[i].word, by }));
      this.broadcast({ type: "challenge_result", challenged });
      this.broadcast({
        type: "move_rejected",
        reason: "a word was challenged — the move is rejected; replay your turn",
      });
      s.pending = null;
      s.phase = "playing"; // board/rack untouched; same player's turn (replay)
      await this.persistAndBroadcast();
      return;
    }

    // Accepted: commit the move.
    const submitter = s.players.find((p) => p.id === pending.submitterId)!;
    // The (longest) word each placed tile is part of — computed on the pre-move board.
    const formed = extractWords(s.board, pending.placed);
    const wordFor = (row: number, col: number) =>
      formed
        .filter((w) => w.cells.some((c) => c.row === row && c.col === col))
        .sort((a, b) => b.word.length - a.word.length)[0]?.word ?? "";
    s.board = applyPlacement(s.board, pending.placed);
    for (const p of pending.placed) {
      const k = `${p.row},${p.col}`;
      (s.boardMeta[k] ??= []).push({ by: submitter.id, word: wordFor(p.row, p.col) });
    }
    submitter.rack = removeTiles(submitter.rack, pending.placed);
    submitter.score += pending.totalPoints;
    const dealt = refill(submitter.rack, s.bag, CONFIG.rackSize);
    submitter.rack = dealt.rack;
    s.bag = dealt.bag;
    s.consecutivePasses = 0;
    s.history.push({
      playerId: submitter.id,
      name: submitter.name,
      words: pending.words,
      total: pending.totalPoints,
    });
    s.pending = null;
    s.phase = "playing";
    this.rotateTurn(s);
    this.broadcast({
      type: "move_applied",
      by: pending.submitterId,
      points: pending.totalPoints,
      words: pending.words,
    });
    await this.persistAndBroadcast();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private isValidWord = async (word: string): Promise<boolean> => {
    const row = await this.env.DB.prepare("SELECT 1 FROM words WHERE word = ? LIMIT 1").bind(word).first();
    return row !== null;
  };

  private rotateTurn(s: GameState): void {
    s.turnSeat = (s.turnSeat + 1) % s.players.length;
  }

  private requireState(ws: WebSocket): GameState | null {
    if (!this.state) {
      this.send(ws, { type: "error", message: "room not found" });
      return null;
    }
    return this.state;
  }

  private requireCurrentPlayer(ws: WebSocket, s: GameState): PlayerState | null {
    if (s.phase !== "playing") {
      this.send(ws, { type: "error", message: "not accepting moves right now" });
      return null;
    }
    const pid = this.playerIdOf(ws);
    const current = s.players[s.turnSeat];
    if (!current || current.id !== pid) {
      this.send(ws, { type: "error", message: "it is not your turn" });
      return null;
    }
    return current;
  }

  private requirePending(ws: WebSocket, s: GameState): boolean {
    if (s.phase !== "pending" || !s.pending) {
      this.send(ws, { type: "error", message: "no move is pending" });
      return false;
    }
    return true;
  }

  private playerIdOf(ws: WebSocket): string | undefined {
    return (ws.deserializeAttachment() as Attachment | null)?.playerId;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(): Promise<void> {
    if (this.state) await this.ctx.storage.put("state", this.state);
  }

  private async persistAndBroadcast(): Promise<void> {
    await this.persist();
    this.broadcastState();
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket gone */
    }
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* socket gone */
      }
    }
  }

  private broadcastState(): void {
    if (this.state) this.broadcast({ type: "state", game: toPublic(this.state) });
  }
}

function freshLobby(code: string): GameState {
  return {
    code,
    phase: "lobby",
    hostId: "",
    players: [],
    board: makeEmptyBoard(CONFIG.boardSize),
    bag: [],
    seed: 0,
    turnSeat: 0,
    consecutivePasses: 0,
    pending: null,
    history: [],
    boardMeta: {},
  };
}

function toPublic(s: GameState): PublicState {
  const { bag, seed, ...rest } = s;
  void seed;
  return { ...rest, bagCount: bag.length };
}

function removeTiles(rack: Tile[], placed: PlacedTile[]): Tile[] {
  const next = rack.slice();
  for (const p of placed) {
    const i = next.indexOf(p.letter);
    if (i >= 0) next.splice(i, 1);
  }
  return next;
}
