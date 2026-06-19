import {
  applyPlacement,
  DEFAULT_CONFIG,
  draw,
  duplicateWords,
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
const REVIEW_BACKSTOP_MS = 180_000; // review stage: hard cap so voting can't hang forever
const DEFINE_TTL_MS = 5 * 60_000; // how long a cached definition stays warm in memory
const SKIP_MS = 120_000; // auto-skip a disconnected current player's turn after this
const REMATCH_MS = 15_000; // how long a rematch offer stays open for votes
const MAX_REJECTS_PER_TURN = 2; // after this many upheld challenges in a turn, skip the player
const CLEANUP_MS = 24 * 60 * 60_000; // delete a finished/abandoned room's storage after this
const LOBBY_TTL_MS = 6 * 60 * 60_000; // delete a created-but-never-started lobby after this
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
        // Arm a self-destruct so a created-but-never-started lobby doesn't linger
        // forever. Replaced by the turn/cleanup alarms once the game starts.
        await this.ctx.storage.setAlarm(Date.now() + LOBBY_TTL_MS);
      }
      return Response.json({ ok: true });
    }

    // Lightweight room probe (no game state mutated) — lets a client landing on a
    // shared link decide whether to auto-enter (they're already a player) or show
    // the join screen. `me` is the caller's stored playerId.
    if (url.pathname.endsWith("/info")) {
      const me = url.searchParams.get("me") ?? "";
      const s = this.state;
      return Response.json({
        exists: !!s,
        phase: s?.phase ?? null,
        isPlayer: s ? s.players.some((p) => p.id === me) : false,
      });
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
        // A drop during the open stage shouldn't stall a move that was only
        // waiting on the now-gone player to accept.
        if (s.phase === "pending" && s.pending?.stage === "open") await this.maybeCloseOpen();
      }
    });
  }

  /** The single DO Alarm serves phase-exclusive purposes:
   *  - pending           → review-vote backstop (only armed once a challenge opens voting)
   *  - playing           → auto-skip a disconnected current player's turn
   *  - rematch_pending   → tally the rematch vote after 15s
   *  - lobby / gameover  → delete the room's storage once everyone has left */
  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const s = this.state;
      if (!s) return;
      if (s.pending) {
        // Only the review stage arms an alarm now (the open stage has no timer —
        // it waits for explicit acceptance). Unvoted at the backstop counts as allow.
        await this.finishReview();
        return;
      }
      if (s.phase === "rematch_pending") {
        await this.tallyRematch(s);
        return;
      }
      if (s.phase === "playing") {
        const cur = s.players[s.turnSeat];
        if (cur && !cur.connected) await this.doPass(s); // away player → skip their turn
        return;
      }
      // Abandoned lobby or finished game → reclaim storage once no one is left.
      if (s.players.some((p) => p.connected)) {
        await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RECHECK_MS); // still here — wait
      } else {
        await this.ctx.storage.deleteAll();
        this.state = null;
        this.defCache.clear();
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
      case "rematch":
        return this.onRematch(ws);
      case "rematch_vote":
        return this.onRematchVote(ws, msg.vote);
      case "swap_tiles":
        return this.onSwap(ws, msg.index);
      case "undo_move":
        return this.onUndo(ws);
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
      existing.left = false; // a returning player un-leaves
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

    // Randomize the seating completely — ignore host and join order.
    shuffle(s.players);
    s.players.forEach((p, i) => (p.seat = i));
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
    s.firstSeat = s.turnSeat; // fix the player-strip order to this game's play order
    s.turnStartedAt = Date.now();
    s.gameStartedAt = Date.now();
    s.rejectsThisTurn = 0;
    s.consecutivePasses = 0;
    await this.armTurnTimer(s);
    await this.persistAndBroadcast();
  }

  /** A player offers a rematch: open a 15s vote. The offerer is an automatic
   *  "yes"; the game restarts (with only the yes-voters) when the timer tallies. */
  private async onRematch(ws: WebSocket): Promise<void> {
    const s = this.requireState(ws);
    if (!s) return;
    if (s.phase !== "gameover") {
      return this.send(ws, { type: "error", message: "no finished game to rematch" });
    }
    const pid = this.playerIdOf(ws);
    if (!pid || !s.players.some((p) => p.id === pid && !p.left)) {
      return this.send(ws, { type: "error", message: "not in this game" });
    }
    if (s.players.filter((p) => !p.left).length < 2) {
      return this.send(ws, { type: "error", message: "need at least 2 players to rematch" });
    }
    const deadline = Date.now() + REMATCH_MS;
    s.phase = "rematch_pending";
    s.rematch = { by: pid, votes: { [pid]: "yes" }, deadline };
    await this.ctx.storage.setAlarm(deadline);
    await this.persistAndBroadcast();
  }

  /** Record a player's yes/no on an open rematch offer. */
  private async onRematchVote(ws: WebSocket, vote: "yes" | "no"): Promise<void> {
    const s = this.requireState(ws);
    if (!s) return;
    if (s.phase !== "rematch_pending" || !s.rematch) {
      return this.send(ws, { type: "error", message: "no rematch in progress" });
    }
    const pid = this.playerIdOf(ws);
    if (!pid || !s.players.some((p) => p.id === pid && !p.left)) return;
    s.rematch.votes[pid] = vote;
    await this.persistAndBroadcast();
  }

  /** Timer ran out on a rematch offer: start a fresh game with the yes-voters,
   *  or cancel and tell the table if nobody else wanted one. */
  private async tallyRematch(s: GameState): Promise<void> {
    const rematch = s.rematch;
    s.rematch = null;
    const yes = s.players.filter((p) => !p.left && rematch?.votes[p.id] === "yes");
    if (yes.length >= 2) {
      this.startFreshGame(s, yes);
      await this.armTurnTimer(s);
      await this.persistAndBroadcast();
    } else {
      s.phase = "gameover";
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
      this.broadcast({ type: "rematch_cancelled", reason: "No one else wanted a rematch." });
      await this.persistAndBroadcast();
    }
  }

  /** Reset board/scores/history and deal fresh racks for a new game with the
   *  given players (re-seated in randomized order). */
  private startFreshGame(s: GameState, players: PlayerState[]): void {
    shuffle(players);
    players.forEach((p, i) => {
      p.seat = i;
      p.score = 0;
      p.rack = [];
    });
    s.players = players;
    s.hostId = players.some((p) => p.id === s.hostId) ? s.hostId : players[0].id;
    s.board = makeEmptyBoard(CONFIG.boardSize);
    s.boardMeta = {};
    s.history = [];
    s.seed = Math.floor(Math.random() * 0xffffffff);
    let bag = newShuffledBag(s.seed);
    for (const p of s.players) {
      const dealt = refill([], bag, CONFIG.rackSize);
      p.rack = dealt.rack;
      bag = dealt.bag;
    }
    s.bag = bag;
    s.phase = "playing";
    s.turnSeat = Math.floor(Math.random() * s.players.length);
    s.firstSeat = s.turnSeat;
    s.turnStartedAt = Date.now();
    s.gameStartedAt = Date.now();
    s.gameEndedAt = 0;
    s.rejectsThisTurn = 0;
    s.consecutivePasses = 0;
    s.pending = null;
    s.draft = null;
    s.endReason = null;
    s.scored = false;
    s.undoSnapshot = null;
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

    // Word validity (including "is this just a trivial plural/past tense?") is
    // decided by human challenge, never by the engine. Words already played this
    // game (same letters) score nothing and are flagged with who first played them.
    const words = extractWords(s.board, placed);
    const score = scoreTurn(words, placed, CONFIG);

    const playedBy = new Map<string, string>(); // lowercased word → first player to play it
    for (const rec of s.history)
      for (const w of rec.words) {
        const lw = w.word.toLowerCase();
        if (!playedBy.has(lw)) playedBy.set(lw, rec.name);
      }
    const dups = duplicateWords(score.perWord, new Set(playedBy.keys()));
    const pendingWords = score.perWord.map((w) =>
      dups.has(w.word.toLowerCase())
        ? { word: w.word, points: 0, duplicate: true, firstBy: playedBy.get(w.word.toLowerCase()) }
        : { word: w.word, points: w.points },
    );

    // Every word is a repeat → reject outright (never a turn, no voting).
    if (pendingWords.length > 0 && pendingWords.every((w) => w.duplicate)) {
      s.draft = null;
      this.broadcast({ type: "move_rejected", reason: duplicateReason(pendingWords) });
      await this.persistAndBroadcast();
      return;
    }

    const dupPoints = score.perWord
      .filter((w) => dups.has(w.word.toLowerCase()))
      .reduce((sum, w) => sum + w.points, 0);
    const stances: PendingMove["stances"] = {};
    for (const p of s.players) if (p.id !== player.id) stances[p.id] = "pending";

    s.pending = {
      submitterId: player.id,
      placed,
      words: pendingWords,
      totalPoints: score.total - dupPoints,
      bingoBonus: score.bingoBonus,
      stage: "open",
      deadline: null, // open stage has no timer — it commits on explicit acceptance
      stances,
      challenges: {},
      votes: {},
      challengerId: null,
    };
    s.draft = null;
    s.phase = "pending";
    await this.ctx.storage.deleteAlarm(); // no auto-accept countdown in the open stage
    await this.persist();
    this.broadcast({
      type: "move_pending",
      words: s.pending.words,
      totalPoints: s.pending.totalPoints,
      bingoBonus: s.pending.bingoBonus,
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
    // Enter review: pause the auto-accept timer. Everyone — including the
    // challenger — starts with a NEUTRAL vote so the table can deliberate and
    // change their minds; resolution waits until every non-submitter has voted
    // (or the backstop fires). The challenger is not pre-locked to "not valid".
    pending.stage = "review";
    pending.challengerId = pid;
    pending.votes = {};
    pending.deadline = Date.now() + REVIEW_BACKSTOP_MS;
    await this.ctx.storage.setAlarm(pending.deadline);
    this.broadcast({ type: "challenge_update", playerId: pid, wordIndex });
    // With a single opponent (the challenger themselves) there's no one else to
    // deliberate with, so the challenge resolves the move immediately as a
    // rejection — skip the voting UI. With 3–4 players, broadcast the review
    // state so everyone, the challenger included, can vote and reconsider.
    const others = s.players.filter((p) => p.id !== pending.submitterId && !p.left);
    if (others.length <= 1) {
      pending.votes[pid] = "reject"; // lone challenger's "not valid" stands
      await this.finishReview();
    } else {
      await this.persistAndBroadcast();
    }
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
    this.snapshotTurnStart(s); // a pass is a completed turn the host can undo
    s.consecutivePasses++;
    s.draft = null;
    this.rotateTurn(s);
    const active = s.players.filter((p) => !p.left).length;
    if (s.consecutivePasses >= active) {
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
    this.snapshotTurnStart(s); // a swap is a completed turn the host can undo
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

  /** Host-only: roll the game back to the start of the previous turn. Allowed
   *  only during normal play (never while a move is pending/under challenge). The
   *  snapshot is consumed on restore, so two undos can't run back-to-back — a real
   *  move/pass/swap has to happen first to capture a fresh one. */
  private async onUndo(ws: WebSocket): Promise<void> {
    const s = this.requireState(ws);
    if (!s) return;
    if (this.playerIdOf(ws) !== s.hostId) {
      return this.send(ws, { type: "error", message: "only the host can undo" });
    }
    if (s.phase !== "playing") {
      return this.send(ws, { type: "error", message: "can only undo during play" });
    }
    if (!s.undoSnapshot) {
      return this.send(ws, { type: "error", message: "nothing to undo" });
    }
    const restored = s.undoSnapshot; // already normalized with undoSnapshot === null
    restored.turnStartedAt = Date.now(); // restart the turn ring from now
    this.state = restored;
    this.broadcast({ type: "undo_applied", reason: "The host undid the last move." });
    await this.armTurnTimer(restored);
    await this.persistAndBroadcast();
  }

  /** Capture the current state as the "beginning of this turn" so the host can
   *  undo back to it. Normalizes the clone to a clean turn start (no pending/draft,
   *  phase playing, reject counter reset) and drops any nested snapshot so a
   *  restore leaves nothing further to undo. Called before each turn-ending action. */
  private snapshotTurnStart(s: GameState): void {
    s.undoSnapshot = null; // don't nest the previous turn's snapshot inside this one
    const snap = structuredClone(s);
    snap.pending = null;
    snap.draft = null;
    snap.phase = "playing";
    snap.rejectsThisTurn = 0;
    s.undoSnapshot = snap;
  }

  /** An explicit, intentional departure (vs. a transient disconnect → `webSocketClose`). */
  private async onLeave(ws: WebSocket): Promise<void> {
    const s = this.state;
    const pid = this.playerIdOf(ws);
    if (!s || !pid) return;
    const player = s.players.find((p) => p.id === pid);
    if (!player) return;

    // Host leaving always cancels the game (no end-of-game penalty — it didn't finish).
    if (pid === s.hostId && s.phase !== "gameover") {
      return this.finishGame("The host left — the game was canceled.", false);
    }
    // Before the game starts, just drop them from the lobby roster.
    if (s.phase === "lobby") {
      s.players = s.players.filter((p) => p.id !== pid);
      return this.persistAndBroadcast();
    }
    if (s.phase === "gameover") {
      player.connected = false;
      return this.persistAndBroadcast();
    }

    // Mid-game: the player is gone for good.
    player.left = true;
    player.connected = false;
    if (s.players.filter((p) => !p.left).length < 2) {
      return this.finishGame(`${player.name} left — not enough players to continue.`, false);
    }
    // 3–4 player game continues without them.
    if (s.pending) {
      // They no longer count toward accept/vote resolution — re-check it.
      await this.persist();
      this.broadcastState();
      return s.pending.stage === "open" ? this.maybeCloseOpen() : this.checkReview();
    }
    if (s.players[s.turnSeat]?.id === pid) this.rotateTurn(s); // skip past them if it was their turn
    await this.armTurnTimer(s);
    await this.persistAndBroadcast();
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
    s.rematch = null;
    s.endReason = reason;
    s.gameEndedAt = Date.now();
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS); // self-destruct once everyone's gone
    this.broadcast({ type: "game_over", reason });
    await this.persistAndBroadcast();
  }

  // ── Challenge window resolution ────────────────────────────────────────────
  /** Open stage: every present non-submitter accepted (no challenge) → commit.
   *  With no auto-accept timer, a disconnected opponent must not stall the move —
   *  so only connected, non-left players are required to accept (a player who isn't
   *  watching can't challenge anyway, and reconnecting re-opens their popup). */
  private async maybeCloseOpen(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== "pending" || s.pending?.stage !== "open") return;
    const pending = s.pending;
    const others = s.players.filter((p) => p.id !== pending.submitterId && !p.left && p.connected);
    if (others.every((p) => pending.stances[p.id] === "accepted")) await this.commitMove();
  }

  /** Review stage: every non-submitter has voted → tally. */
  private async checkReview(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== "pending" || s.pending?.stage !== "review") return;
    const pending = s.pending;
    const others = s.players.filter((p) => p.id !== pending.submitterId && !p.left);
    if (others.every((p) => pending.votes[p.id] !== undefined)) await this.finishReview();
  }

  /** Any "reject" vote rejects the whole move; otherwise (all allow) it commits. */
  private async finishReview(): Promise<void> {
    const s = this.state!;
    const pending = s.pending!;
    const others = s.players.filter((p) => p.id !== pending.submitterId && !p.left);
    if (others.some((p) => pending.votes[p.id] === "reject")) await this.rejectMove();
    else await this.commitMove();
  }

  private async rejectMove(): Promise<void> {
    const s = this.state!;
    const pending = s.pending!;
    await this.ctx.storage.deleteAlarm();
    const submitter = s.players.find((p) => p.id === pending.submitterId);
    const byWord = new Map<number, string[]>();
    for (const [pid, indices] of Object.entries(pending.challenges)) {
      for (const i of indices) byWord.set(i, [...(byWord.get(i) ?? []), pid]);
    }
    const challenged = [...byWord.entries()].map(([i, by]) => ({ word: pending.words[i].word, by }));
    this.broadcast({ type: "challenge_result", challenged });
    s.rejectsThisTurn++;
    s.pending = null;
    s.draft = null;
    s.phase = "playing"; // board/rack untouched
    if (s.rejectsThisTurn >= MAX_REJECTS_PER_TURN) {
      // Two upheld challenges this turn → the player forfeits the rest of it.
      this.broadcast({
        type: "move_rejected",
        reason: `Challenged twice — ${submitter?.name ?? "that player"}'s turn is skipped`,
      });
      this.rotateTurn(s); // advances the turn and resets rejectsThisTurn
    } else {
      this.broadcast({ type: "move_rejected", reason: "the table did not accept the word — replay your turn" });
    }
    await this.armTurnTimer(s);
    await this.persistAndBroadcast();
  }

  private async commitMove(): Promise<void> {
    const s = this.state!;
    const pending = s.pending!;
    this.snapshotTurnStart(s); // capture the pre-move turn start so the host can undo it
    await this.ctx.storage.deleteAlarm();
    const submitter = s.players.find((p) => p.id === pending.submitterId)!;
    // The across + down word each placed tile is part of — on the pre-move board.
    const formed = extractWords(s.board, pending.placed);
    const wordFor = (row: number, col: number, orientation: "across" | "down") =>
      formed.find(
        (w) => w.orientation === orientation && w.cells.some((c) => c.row === row && c.col === col),
      )?.word;
    s.board = applyPlacement(s.board, pending.placed);
    for (const p of pending.placed) {
      const k = `${p.row},${p.col}`;
      (s.boardMeta[k] ??= []).push({
        by: submitter.id,
        across: wordFor(p.row, p.col, "across"),
        down: wordFor(p.row, p.col, "down"),
      });
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
      tiles: pending.placed.length,
      placed: pending.placed.map((p) => p.letter),
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
      bingo: pending.bingoBonus > 0,
      qu: pending.placed.some((p) => p.letter === "qu"),
    });
    // Endgame: a player goes out (empties their rack) with an empty bag.
    if (submitter.rack.length === 0 && s.bag.length === 0) {
      return this.finishGame(`${submitter.name} used all their tiles — the game is over.`, true);
    }
    await this.armTurnTimer(s);
    await this.persistAndBroadcast();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
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

  /** Advance to the next player who hasn't left the game. */
  private rotateTurn(s: GameState): void {
    const n = s.players.length;
    for (let i = 1; i <= n; i++) {
      const seat = (s.turnSeat + i) % n;
      if (!s.players[seat].left) {
        s.turnSeat = seat;
        s.turnStartedAt = Date.now();
        s.rejectsThisTurn = 0;
        return;
      }
    }
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
    firstSeat: 0,
    turnStartedAt: 0,
    rejectsThisTurn: 0,
    consecutivePasses: 0,
    pending: null,
    history: [],
    boardMeta: {},
    endReason: null,
    scored: false,
    draft: null,
    gameStartedAt: 0,
    gameEndedAt: 0,
    rematch: null,
    undoSnapshot: null,
  };
}

/** In-place Fisher–Yates shuffle. */
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Human-readable "already played" message for a rejected all-duplicate move. */
function duplicateReason(words: { word: string; firstBy?: string }[]): string {
  const up = (w: string) => w.toUpperCase();
  if (words.length === 1) {
    const w = words[0];
    return `${up(w.word)} has been played before${w.firstBy ? ` by ${w.firstBy}` : ""}.`;
  }
  const names = words.map((w) => up(w.word));
  const list = `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  return `The words ${list} were played before.`;
}

function toPublic(s: GameState): PublicState {
  const { bag, seed, undoSnapshot, ...rest } = s;
  void seed;
  return { ...rest, bagCount: bag.length, canUndo: undoSnapshot !== null };
}

function removeTiles(rack: Tile[], placed: PlacedTile[]): Tile[] {
  const next = rack.slice();
  for (const p of placed) {
    const i = next.indexOf(p.letter);
    if (i >= 0) next.splice(i, 1);
  }
  return next;
}
