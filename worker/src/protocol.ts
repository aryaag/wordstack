// Shared room state + WebSocket message types (the Phase 5 frontend reuses these).
import type { Board, PlacedTile, Tile } from "./engine";

export type Phase = "lobby" | "playing" | "pending" | "gameover";

export interface PlayerState {
  id: string;
  name: string;
  seat: number;
  rack: Tile[];
  score: number;
  connected: boolean;
}

export interface PendingWord {
  word: string;
  points: number;
}

/** One committed turn, for the history panel (newest first in the UI). */
export interface TurnRecord {
  playerId: string;
  name: string;
  words: PendingWord[];
  total: number;
}

export type PendingStage = "open" | "review";

export interface PendingMove {
  submitterId: string;
  placed: PlacedTile[];
  words: PendingWord[];
  totalPoints: number;
  bingoBonus: number;
  stage: PendingStage;
  deadline: number | null; // open: 30s auto-accept; review: backstop (timer paused in UI)
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
  consecutivePasses: number;
  pending: PendingMove | null;
  history: TurnRecord[];
  /** Per-cell stack of layer metadata, aligned with `board[r][c]` (cellKey "r,c"). */
  boardMeta: Record<string, LayerMeta[]>;
  /** Set when the game ends/cancels (e.g. host left); shown on the end screen. */
  endReason: string | null;
  /** Live, uncommitted tiles the current player is placing (not persisted). */
  draft: DraftPlacement | null;
}

export interface LayerMeta {
  by: string; // playerId who placed this layer
  word: string; // the (longest) word this tile was part of when played
}

/** The current player's in-progress (uncommitted) tiles, shown live to everyone. */
export interface DraftPlacement {
  by: string;
  placed: PlacedTile[];
}

/** What clients receive: full state minus the secret bag order/seed (only the count). */
export type PublicState = Omit<GameState, "bag" | "seed"> & { bagCount: number };

/** Minimal, parsed Merriam-Webster lookup result returned by GET /define.
 *  The raw MW payload is parsed in the Worker and discarded — never stored. */
export interface DefineEntry {
  fl: string; // part of speech (e.g. "noun")
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
  | { type: "leave" };

export type ServerMessage =
  | { type: "state"; game: PublicState }
  | { type: "move_pending"; words: PendingWord[]; totalPoints: number; bingoBonus: number; deadline: number }
  | { type: "challenge_update"; playerId: string; wordIndex: number }
  | { type: "challenge_result"; challenged: { word: string; by: string[] }[] }
  | { type: "move_applied"; by: string; points: number; words: PendingWord[] }
  | { type: "move_rejected"; reason: string }
  | { type: "game_over"; reason: string }
  | { type: "error"; message: string };
