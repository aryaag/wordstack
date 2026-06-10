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

export interface PendingMove {
  submitterId: string;
  placed: PlacedTile[];
  words: PendingWord[];
  totalPoints: number;
  bingoBonus: number;
  deadline: number; // epoch ms
  stances: Record<string, "pending" | "accepted">; // per non-submitter playerId
  challenges: Record<string, number[]>; // playerId → challenged word indices
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
}

/** What clients receive: full state minus the secret bag order/seed (only the count). */
export type PublicState = Omit<GameState, "bag" | "seed"> & { bagCount: number };

export type ClientMessage =
  | { type: "join"; playerId: string; name: string }
  | { type: "start_game" }
  | { type: "submit_move"; placed: PlacedTile[] }
  | { type: "challenge_word"; wordIndex: number }
  | { type: "acknowledge_move" }
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
  | { type: "error"; message: string };
