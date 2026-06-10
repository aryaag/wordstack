import { applyPlacement, maximalRuns } from "./board";
import type { Board, FormedWord, PlacedTile, WordCell } from "./types";

const key = (row: number, col: number) => `${row},${col}`;

/**
 * Distinct horizontal + vertical runs of length ≥ 2 that pass through a cell
 * placed/modified this turn, with per-cell post-move heights. `board` is the
 * PRE-move board; placement is applied internally.
 */
export function extractWords(board: Board, placed: PlacedTile[]): FormedWord[] {
  const after = applyPlacement(board, placed);
  const placedSet = new Set(placed.map((p) => key(p.row, p.col)));

  const words: FormedWord[] = [];
  for (const run of maximalRuns(after)) {
    const touched = run.positions.some((p) => placedSet.has(key(p.row, p.col)));
    if (!touched) continue;

    const cells: WordCell[] = run.positions.map((p) => {
      const stack = after[p.row][p.col];
      return {
        row: p.row,
        col: p.col,
        letter: stack[stack.length - 1],
        height: stack.length,
        placedThisTurn: placedSet.has(key(p.row, p.col)),
      };
    });

    words.push({
      word: cells.map((c) => c.letter).join(""),
      orientation: run.orientation,
      cells,
    });
  }
  return words;
}
