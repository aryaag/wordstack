// Shared room state + WebSocket message types (the Phase 5 frontend reuses these).
import type { Board, PlacedTile, Tile } from "./engine";

export type Phase = "lobby" | "playing" | "pending" | "gameover" | "rematch_pending";

export interface PlayerState {
  id: string;
  name: string;
  seat: number;
  rack: Tile[];
  score: number;
  connected: boolean;
  /** True if the player explicitly left for good (vs. a transient disconnect,
   *  which only flips `connected`). Left players are skipped and don't block
   *  challenge resolution; cleared if they later rejoin. */
  left?: boolean;
}

export interface PendingWord {
  word: string;
  points: number;
  /** True if this exact word was already played earlier this game — it scores 0. */
  duplicate?: boolean;
  /** Name of the player who first played a duplicate word. */
  firstBy?: string;
}

/** One committed turn, for the history panel (newest first in the UI). */
export interface TurnRecord {
  playerId: string;
  name: string;
  words: PendingWord[];
  total: number;
  /** How many tiles were placed this turn (drives the "highest 1-tile play" stat). */
  tiles: number;
  /** The letters placed this turn (e.g. to show the tile of a top 1-tile play). */
  placed?: string[];
}

export type PendingStage = "open" | "review";

export interface PendingMove {
  submitterId: string;
  placed: PlacedTile[];
  words: PendingWord[];
  totalPoints: number;
  bingoBonus: number;
  stage: PendingStage;
  deadline: number | null; // open: null (commits on explicit acceptance, no timer); review: backstop
  stances: Record<string, "pending" | "accepted">; // open stage: per non-submitter
  challenges: Record<string, number[]>; // who challenged which word(s)
  votes: Record<string, "allow" | "reject">; // review stage: per non-submitter ("is the word valid?")
  challengerId: string | null; // first challenger (triggered review)
}

/** Authoritative state held in DO storage. `bag` and `seed` never leave the server. */
export interface GameState {
  code: string;
  phase: Phase;
  hostId: string;
  players: PlayerState[]; // seat order
  board: Board;
  bag: Tile[];
  seed: number;
  turnSeat: number;
  /** Seat that took the first turn this game — fixes the player-strip order so it
   *  doesn't rotate each turn (the starter stays leftmost). */
  firstSeat: number;
  /** Epoch ms when the current turn began — drives the soft turn-timer ring. */
  turnStartedAt: number;
  /** Upheld challenges against the current player this turn — at 2 they're skipped. */
  rejectsThisTurn: number;
  consecutivePasses: number;
  pending: PendingMove | null;
  history: TurnRecord[];
  /** Per-cell stack of layer metadata, aligned with `board[r][c]` (cellKey "r,c"). */
  boardMeta: Record<string, LayerMeta[]>;
  /** Set when the game ends/cancels (e.g. host left); shown on the end screen. */
  endReason: string | null;
  /** True once the game ended naturally and end-of-game tile penalties were
   *  applied to scores (false for a host-cancel). Drives the end-screen breakdown. */
  scored: boolean;
  /** Live, uncommitted tiles the current player is placing (not persisted). */
  draft: DraftPlacement | null;
  /** Epoch ms when play began (this game / rematch) — for the end-screen duration. */
  gameStartedAt: number;
  /** Epoch ms when the game ended/cancelled. */
  gameEndedAt: number;
  /** Active 15s rematch vote (phase === "rematch_pending"), else null. */
  rematch: RematchVote | null;
  /** Server-only snapshot of the state at the start of the most recently
   *  completed turn (set before each commit/pass/swap). The host can restore it
   *  to undo that turn; cleared on restore, so two undos can't run back-to-back.
   *  Never sent to clients (see `toPublic` → exposed as `canUndo`). */
  undoSnapshot: GameState | null;
}

/** An in-progress rematch offer: the prompter, each player's vote, and the deadline. */
export interface RematchVote {
  by: string; // playerId who offered the rematch
  votes: Record<string, "yes" | "no">;
  deadline: number; // epoch ms when the vote auto-tallies
}

export interface LayerMeta {
  by: string; // playerId who placed this layer
  /** The across/down word this tile was part of when played (each ≥2 letters).
   *  Legacy layers may instead carry `word`; the client falls back to it. */
  across?: string;
  down?: string;
  word?: string; // legacy single-word field (pre-both-words layers)
}

/** The current player's in-progress (uncommitted) tiles, shown live to everyone. */
export interface DraftPlacement {
  by: string;
  placed: PlacedTile[];
}

/** What clients receive: full state minus the secret bag order/seed (only the
 *  count) and the server-only undo snapshot (exposed as a `canUndo` flag). */
export type PublicState = Omit<GameState, "bag" | "seed" | "undoSnapshot"> & {
  bagCount: number;
  canUndo: boolean;
};

/** Minimal, parsed Merriam-Webster lookup result returned by GET /define.
 *  The raw MW payload is parsed in the Worker and discarded — never stored. */
export interface DefineEntry {
  fl: string; // part of speech / functional label (e.g. "noun", "abbreviation")
  labels: string[]; // status/subject labels from MW (e.g. "informal", "US slang")
  defs: string[]; // 1–3 shortdef strings
}
export type DefineResult =
  | { word: string; found: true; entries: DefineEntry[] }
  | { word: string; found: false; suggestions?: string[] }
  | { word: string; error: string };

export type ClientMessage =
  | { type: "join"; playerId: string; name: string }
  | { type: "start_game" }
  | { type: "submit_move"; placed: PlacedTile[] }
  | { type: "place_draft"; placed: PlacedTile[] }
  | { type: "challenge_word"; wordIndex: number }
  | { type: "acknowledge_move" }
  | { type: "vote_move"; vote: "allow" | "reject" }
  | { type: "pass" }
  | { type: "swap_tiles"; index: number }
  | { type: "undo_move" }
  | { type: "rematch" }
  | { type: "rematch_vote"; vote: "yes" | "no" }
  | { type: "leave" };

export type ServerMessage =
  | { type: "state"; game: PublicState }
  | { type: "move_pending"; words: PendingWord[]; totalPoints: number; bingoBonus: number }
  | { type: "challenge_update"; playerId: string; wordIndex: number }
  | { type: "challenge_result"; challenged: { word: string; by: string[] }[] }
  | { type: "move_applied"; by: string; points: number; words: PendingWord[]; bingo: boolean; qu: boolean }
  | { type: "move_rejected"; reason: string }
  | { type: "undo_applied"; reason: string }
  | { type: "game_over"; reason: string }
  | { type: "rematch_cancelled"; reason: string }
  | { type: "error"; message: string };
