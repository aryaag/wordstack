import type { Config, Position } from "./types";

/** The 2×2 center start squares (0-indexed rows/cols 4–5 on a 10×10 board). */
export const CENTER_CELLS: Position[] = [
  { row: 4, col: 4 },
  { row: 4, col: 5 },
  { row: 5, col: 4 },
  { row: 5, col: 5 },
];

/** Confirmed config from the physical edition (see CLAUDE.md). All values are tunable. */
export const DEFAULT_CONFIG: Config = {
  boardSize: 10,
  maxStackHeight: 5,
  rackSize: 7,
  centerCells: CENTER_CELLS,
  firstMoveMustCoverCenter: true,
  flatPointsPerLetter: 2,
  quBonus: 2,
  bingoBonus: 20,
  endgameTilePenalty: true,
  endgameTilePenaltyPoints: 5,
};
