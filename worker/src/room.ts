import {
  applyPlacement,
  DEFAULT_CONFIG,
  detectTrivialSuffixes,
  draw,
  endgamePenalty,
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
import { lookupDefinition } from "./define";
import type { DefineResult } from "./protocol";

const CONFIG = DEFAULT_CONFIG;
const WINDOW_MS = 30_000; // open stage: auto-accept countdown
const REVIEW_BACKSTOP_MS = 180_000; // review stage: hard cap so voting can't hang forever
const DEFINE_TTL_MS = 5 * 60_000; // how long a cached definition stays warm in memory
const SKIP_MS = 120_000; // auto-skip a disconnected current player's turn after this
const CLEANUP_MS = 24 * 60 * 60_000; // delete a finished/abandoned room's storage after this
const CLEANUP_RECHECK_MS = 60 * 60_000; // if someone's still connected at cleanup time, recheck in 1h

type Attachment = { playerId: string };

/** One Durable Object per room: authoritative game state + hibernatable WebSocket fan-out. */
export class Room {
  private ctx: DurableObjectState;
  private env: Env;
  private state: GameState | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  // Transient, in-memory only: dedupes MW lookups for words defined this turn by
  // multiple players. Never persisted (not DO storage, D1, KV, or a log) and
  // evicted after DEFINE_TTL_MS; lost entirely on hibernation. See define.ts.
  private defCache = new Map<string, { result: DefineResult; at: number }>();

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

    // Cached MW definition lookup (shared by everyone in this room). The Worker's
    // /define route forwards here with an already-validated word.
    if (url.pathname.endsWith("/define")) {
      return Response.json(await this.define(url.searchParams.get("word") ?? ""));
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
      const s = this.state;
      const pid = this.playerIdOf(ws);
      const player = s?.players.find((p) => p.id === pid);
      if (s && player) {
        player.connected = false;
        await this.armTurnTimer(s); // if the current player just dropped, start the auto-skip clock
        await this.persistAndBroadcast();
      }
    });
  }

  /** The single DO Alarm serves three phase-exclusive purposes:
   *  - pending  → challenge-window backstop (auto-accept / tally)
   *  - playing  → auto-skip a disconnected current player's turn
   *  - gameover → delete the room's storage once everyone has left */
  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const s = this.state;
      if (!s) return;
      if (s.pending) {
        if (s.pending.stage === "open") await this.commitMove(); // no challenge → auto-accept
        else await this.finishReview(); // backstop: unvoted counts as allow
        return;
      }
      if (s.phase === "playing") {
        const cur = s.players[s.turnSeat];
        if (cur && !cur.connected) await this.doPass(s); // away player → skip their turn
        return;
      }
      if (s.phase === "gameover") {
        if (s.players.some((p) => p.connected)) {
          await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RECHECK_MS); // someone's reviewing — wait
        } else {
          await this.ctx.storage.deleteAll();
          this.state = null;
          this.defCache.clear();
        }
      }
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
      case "place_draft":
        return this.onDraft(ws, msg.placed);
      case "challenge_word":
        return this.onChallenge(ws, msg.wordIndex);
      case "acknowledge_move":
        return this.onAcknowledge(ws);
      case "vote_move":
        return this.onVote(ws, msg.vote);
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
      const cleanName = (name ?? "").trim().slice(0, 24);
      if (!cleanName) return this.send(ws, { type: "error", message: "please enter a name to join" });
      if (s.phase !== "lobby") return this.send(ws, { type: "error", message: "game already started" });
      if (s.players.length >= 4) return this.send(ws, { type: "error", message: "room is full" });
      const seat = s.players.length;
      s.players.push({
        id: playerId,
        name: cleanName,
        seat,
        rack: [],
        score: 0,
        connected: true,
      });
      if (s.players.length === 1) s.hostId = playerId;
    }
    ws.serializeAttachment({ playerId } satisfies Attachment);
    await this.armTurnTimer(s); // a returning current player cancels their pending auto-skip
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
    s.turnSeat = Math.floor(Math.random() * s.players.length); // randomize who goes first
    s.consecutivePasses = 0;
    await this.armTurnTimer(s);
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

    const deadline = Date.now() + WINDOW_MS;
    s.pending = {
      submitterId: player.id,
      placed,
      words: score.perWord.map((w) => ({ word: w.word, points: w.points })),
      totalPoints: score.total,
      bingoBonus: score.bingoBonus,
      stage: "open",
      deadline,
      stances,
      challenges: {},
      votes: {},
      challengerId: null,
    };
    s.draft = null;
    s.phase = "pending";
    await this.ctx.storage.setAlarm(deadline);
    await this.persist();
    this.broadcast({
      type: "move_pending",
      words: s.pending.words,
      totalPoints: s.pending.totalPoints,
      bingoBonus: s.pending.bingoBonus,
      deadline,
    });
    this.broadcastState();
    await this.maybeCloseOpen();
  }

  /** Live placement: rebroadcast the current player's in-progress tiles (not persisted). */
  private async onDraft(ws: WebSocket, placed: PlacedTile[]): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== "playing") return;
    const pid = this.playerIdOf(ws);
    if (!pid || s.players[s.turnSeat]?.id !== pid) return; // only the current player drafts
    if (!Array.isArray(placed)) return;
    s.draft = placed.length ? { by: pid, placed } : null;
    this.broadcastState(); // transient: deliberately not persisted (per-keystroke)
  }

  /** Open stage only: a challenge pauses the timer and moves the table into review/voting. */
  private async onChallenge(ws: WebSocket, wordIndex: number): Promise<void> {
    const s = this.requireState(ws);
    if (!s || !this.requirePending(ws, s)) return;
    const pending = s.pending!;
    if (pending.stage !== "open") {
      return this.send(ws, { type: "error", message: "the move is already under review" });
    }
    const pid = this.playerIdOf(ws);
    if (!pid || pid === pending.submitterId) {
      return this.send(ws, { type: "error", message: "you cannot challenge your own move" });
    }
    if (!(pid in pending.stances)) return this.send(ws, { type: "error", message: "not in this game" });
    if (wordIndex < 0 || wordIndex >= pending.words.length) {
      return this.send(ws, { type: "error", message: "bad word index" });
    }
    (pending.challenges[pid] ??= []).push(wordIndex);
    // Enter review: pause the auto-accept timer; the challenge counts as the
    // challenger's "not valid" vote. Everyone else now votes on the word.
    pending.stage = "review";
    pending.challengerId = pid;
    pending.votes = { [pid]: "reject" };
    pending.deadline = Date.now() + REVIEW_BACKSTOP_MS;
    await this.ctx.storage.setAlarm(pending.deadline);
    this.broadcast({ type: "challenge_update", playerId: pid, wordIndex });
    await this.persistAndBroadcast();
    // With a single opponent there's no one else to deliberate with, so this
    // resolves immediately; with 3–4 players it waits for the others to vote.
    await this.checkReview();
  }

  /** Open stage: a player accepts the move without challenging. */
  private async onAcknowledge(ws: WebSocket): Promise<void> {
    const s = this.requireState(ws);
    if (!s || !this.requirePending(ws, s)) return;
    const pending = s.pending!;
    if (pending.stage !== "open") return; // in review, players vote instead
    const pid = this.playerIdOf(ws);
    if (!pid || pid === pending.submitterId) return; // submitter's popup is read-only
    if (!(pid in pending.stances)) return this.send(ws, { type: "error", message: "not in this game" });
    pending.stances[pid] = "accepted";

    await this.persist();
    this.broadcastState();
    await this.maybeCloseOpen();
  }

  /** Review stage: a non-submitter votes whether the word is valid (allow) or not (reject). */
  private async onVote(ws: WebSocket, vote: "allow" | "reject"): Promise<void> {
    const s = this.requireState(ws);
    if (!s || !this.requirePending(ws, s)) return;
    const pending = s.pending!;
    if (pending.stage !== "review") return this.send(ws, { type: "error", message: "no vote in progress" });
    const pid = this.playerIdOf(ws);
    if (!pid || pid === pending.submitterId) return; // submitter doesn't vote
    if (!(pid in pending.stances)) return this.send(ws, { type: "error", message: "not in this game" });
    if (vote !== "allow" && vote !== "reject") return;
    pending.votes[pid] = vote;

    await this.persist();
    this.broadcastState();
    await this.checkReview();
  }

  private async onPass(ws: WebSocket): Promise<void> {
    const s = this.requireState(ws);
    if (!s) return;
    if (!this.requireCurrentPlayer(ws, s)) return;
    await this.doPass(s);
  }

  /** Advance the turn with a pass — used by an explicit `pass` and by the
   *  disconnect auto-skip. Ends the game once every player has passed in
   *  succession (one full round). */
  private async doPass(s: GameState): Promise<void> {
    s.consecutivePasses++;
    s.draft = null;
    this.rotateTurn(s);
    if (s.consecutivePasses >= s.players.length) {
      return this.finishGame("Everyone passed — the game is over.", true);
    }
    await this.armTurnTimer(s);
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
    s.draft = null;
    this.rotateTurn(s);
    await this.armTurnTimer(s);
    await this.persistAndBroadcast();
  }

  private async onLeave(ws: WebSocket): Promise<void> {
    const s = this.state;
    const pid = this.playerIdOf(ws);
    if (s && pid && pid === s.hostId && s.phase !== "gameover") {
      // Host leaving cancels the game — no end-of-game tile penalty (it didn't finish).
      return this.finishGame("The host left — the game was canceled.", false);
    }
    await this.webSocketClose(ws);
  }

  /** End the game: optionally apply the −5/leftover-tile penalty, move to
   *  `gameover`, broadcast `game_over`, and arm the 24h storage-cleanup alarm.
   *  Shared by natural endings (penalty) and host-cancel (no penalty). */
  private async finishGame(reason: string, applyPenalty: boolean): Promise<void> {
    const s = this.state;
    if (!s) return;
    if (applyPenalty) {
      for (const p of s.players) p.score -= endgamePenalty(p.rack.length, CONFIG);
    }
    s.phase = "gameover";
    s.scored = applyPenalty;
    s.pending = null;
    s.draft = null;
    s.endReason = reason;
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS); // self-destruct once everyone's gone
    this.broadcast({ type: "game_over", reason });
    await this.persistAndBroadcast();
  }

  // ── Challenge window resolution ────────────────────────────────────────────
  /** Open stage: every non-submitter accepted (no challenge) → commit. */
  private async maybeCloseOpen(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== "pending" || s.pending?.stage !== "open") return;
    const pending = s.pending;
    const others = s.players.filter((p) => p.id !== pending.submitterId);
    if (others.every((p) => pending.stances[p.id] === "accepted")) await this.commitMove();
  }

  /** Review stage: every non-submitter has voted → tally. */
  private async checkReview(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== "pending" || s.pending?.stage !== "review") return;
    const pending = s.pending;
    const others = s.players.filter((p) => p.id !== pending.submitterId);
    if (others.every((p) => pending.votes[p.id] !== undefined)) await this.finishReview();
  }

  /** Any "reject" vote rejects the whole move; otherwise (all allow) it commits. */
  private async finishReview(): Promise<void> {
    const s = this.state!;
    const pending = s.pending!;
    const others = s.players.filter((p) => p.id !== pending.submitterId);
    if (others.some((p) => pending.votes[p.id] === "reject")) await this.rejectMove();
    else await this.commitMove();
  }

  private async rejectMove(): Promise<void> {
    const s = this.state!;
    const pending = s.pending!;
    await this.ctx.storage.deleteAlarm();
    const byWord = new Map<number, string[]>();
    for (const [pid, indices] of Object.entries(pending.challenges)) {
      for (const i of indices) byWord.set(i, [...(byWord.get(i) ?? []), pid]);
    }
    const challenged = [...byWord.entries()].map(([i, by]) => ({ word: pending.words[i].word, by }));
    this.broadcast({ type: "challenge_result", challenged });
    this.broadcast({ type: "move_rejected", reason: "the table did not accept the word — replay your turn" });
    s.pending = null;
    s.draft = null;
    s.phase = "playing"; // board/rack untouched; same player's turn (replay)
    await this.armTurnTimer(s);
    await this.persistAndBroadcast();
  }

  private async commitMove(): Promise<void> {
    const s = this.state!;
    const pending = s.pending!;
    await this.ctx.storage.deleteAlarm();
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
    s.draft = null;
    this.rotateTurn(s);
    this.broadcast({
      type: "move_applied",
      by: pending.submitterId,
      points: pending.totalPoints,
      words: pending.words,
    });
    // Endgame: a player goes out (empties their rack) with an empty bag.
    if (submitter.rack.length === 0 && s.bag.length === 0) {
      return this.finishGame(`${submitter.name} used all their tiles — the game is over.`, true);
    }
    await this.armTurnTimer(s);
    await this.persistAndBroadcast();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private isValidWord = async (word: string): Promise<boolean> => {
    const row = await this.env.DB.prepare("SELECT 1 FROM words WHERE word = ? LIMIT 1").bind(word).first();
    return row !== null;
  };

  /** MW lookup with a short-TTL in-memory cache. Errors are not cached so a
   *  transient network/key failure can be retried immediately. */
  private async define(word: string): Promise<DefineResult> {
    word = word.trim().toLowerCase();
    if (!/^[a-z]{2,}$/.test(word)) return { word, error: "word must be 2+ letters a-z" };
    const now = Date.now();
    const hit = this.defCache.get(word);
    if (hit && now - hit.at < DEFINE_TTL_MS) return hit.result;
    const result = await lookupDefinition(word, this.env.MW_KEY);
    if (!("error" in result)) {
      this.defCache.set(word, { result, at: now });
      if (this.defCache.size > 256) {
        for (const [k, v] of this.defCache) if (now - v.at >= DEFINE_TTL_MS) this.defCache.delete(k);
      }
    }
    return result;
  }

  private rotateTurn(s: GameState): void {
    s.turnSeat = (s.turnSeat + 1) % s.players.length;
  }

  /** Arm (or clear) the disconnect auto-skip alarm for the current turn. Only
   *  active during `playing`; the challenge window and cleanup own the alarm in
   *  their own phases. */
  private async armTurnTimer(s: GameState): Promise<void> {
    if (s.phase !== "playing") return;
    const cur = s.players[s.turnSeat];
    if (cur && !cur.connected) await this.ctx.storage.setAlarm(Date.now() + SKIP_MS);
    else await this.ctx.storage.deleteAlarm();
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
    endReason: null,
    scored: false,
    draft: null,
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
