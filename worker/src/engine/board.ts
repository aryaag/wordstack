import type { Board, Cell, PlacedTile, Position, Tile } from "./types";

export function makeEmptyBoard(size: number): Board {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => [] as Cell));
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.map((cell) => cell.slice()));
}

export function inBounds(board: Board, row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < board.length && col < board.length;
}

export function height(board: Board, row: number, col: number): number {
  return board[row][col].length;
}

export function topTile(board: Board, row: number, col: number): Tile | null {
  const cell = board[row][col];
  return cell.length ? cell[cell.length - 1] : null;
}

export function isOccupied(board: Board, row: number, col: number): boolean {
  return board[row][col].length > 0;
}

export function boardIsEmpty(board: Board): boolean {
  return board.every((row) => row.every((cell) => cell.length === 0));
}

/** Returns a new board with `placed` tiles pushed onto their cells (does not mutate input). */
export function applyPlacement(board: Board, placed: PlacedTile[]): Board {
  const next = cloneBoard(board);
  for (const p of placed) next[p.row][p.col].push(p.letter);
  return next;
}

export interface Run {
  orientation: "across" | "down";
  positions: Position[];
}

/** All maximal horizontal + vertical runs of occupied cells with length ≥ 2. */
export function maximalRuns(board: Board): Run[] {
  const size = board.length;
  const runs: Run[] = [];

  const collect = (orientation: "across" | "down", at: (i: number, j: number) => Position) => {
    for (let i = 0; i < size; i++) {
      let start = -1;
      for (let j = 0; j <= size; j++) {
        const occupied = j < size && isOccupied(board, at(i, j).row, at(i, j).col);
        if (occupied && start === -1) start = j;
        if (!occupied && start !== -1) {
          if (j - start >= 2) {
            const positions: Position[] = [];
            for (let k = start; k < j; k++) positions.push(at(i, k));
            runs.push({ orientation, positions });
          }
          start = -1;
        }
      }
    }
  };

  collect("across", (r, c) => ({ row: r, col: c }));
  collect("down", (c, r) => ({ row: r, col: c }));
  return runs;
}
