// Pure engine types. No I/O, no Cloudflare runtime imports.

/** A tile value: a single letter "a".."z", or the combined "qu" tile (two chars, one cell). */
export type Tile = string;

/** A board cell is a stack of tiles, bottom → top. `[]` = empty. height = length, top = last. */
export type Cell = Tile[];

/** board[row][col]. Square, `config.boardSize` per side. */
export type Board = Cell[][];

export interface Position {
  row: number;
  col: number;
}

/** A tile placed during the current turn. */
export interface PlacedTile extends Position {
  letter: Tile;
}

/** One cell of a formed word, with post-move height and whether it was touched this turn. */
export interface WordCell extends Position {
  letter: Tile;
  height: number; // post-move stack height at this cell
  placedThisTurn: boolean; // true if a tile was placed/stacked here this turn
}

export interface FormedWord {
  word: string; // expanded ASCII string, e.g. "queen" (qu cell → "qu")
  orientation: "across" | "down";
  cells: WordCell[]; // in reading order (left→right or top→bottom)
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface Config {
  boardSize: number;
  maxStackHeight: number;
  rackSize: number;
  centerCells: Position[];
  firstMoveMustCoverCenter: boolean;
  // scoring
  flatPointsPerLetter: number; // flat word = this × tile count
  quBonus: number; // extra per flat word containing the qu tile
  bingoBonus: number; // extra for using all rackSize tiles in one turn
  // endgame
  endgameTilePenalty: boolean;
  endgameTilePenaltyPoints: number; // deducted per leftover tile
}
