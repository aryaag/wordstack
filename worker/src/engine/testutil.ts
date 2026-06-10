// Shared helpers for engine tests (not a *.test.ts, so it is type-checked by tsc).
import { makeEmptyBoard } from "./board";
import type { Board, PlacedTile, Tile } from "./types";

export const emptyBoard = (): Board => makeEmptyBoard(10);

/** Set a cell's full stack (bottom → top). */
export function set(board: Board, row: number, col: number, ...stack: Tile[]): void {
  board[row][col] = [...stack];
}

/** Lay a flat (height-1) word horizontally. */
export function layAcross(board: Board, row: number, col: number, tiles: Tile[]): void {
  tiles.forEach((t, i) => {
    board[row][col + i] = [t];
  });
}

/** Lay a flat (height-1) word vertically. */
export function layDown(board: Board, row: number, col: number, tiles: Tile[]): void {
  tiles.forEach((t, i) => {
    board[row + i][col] = [t];
  });
}

export function placeAcross(row: number, col: number, tiles: Tile[]): PlacedTile[] {
  return tiles.map((t, i) => ({ row, col: col + i, letter: t }));
}

export function placeDown(row: number, col: number, tiles: Tile[]): PlacedTile[] {
  return tiles.map((t, i) => ({ row: row + i, col, letter: t }));
}

/** A Set-backed `isValidWord` fake. */
export function fakeLexicon(words: string[]): (w: string) => Promise<boolean> {
  const set = new Set(words);
  return (w: string) => Promise.resolve(set.has(w));
}
