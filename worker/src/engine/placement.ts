import {
  applyPlacement,
  boardIsEmpty,
  inBounds,
  isOccupied,
  maximalRuns,
  topTile,
} from "./board";
import { extractWords } from "./words";
import type { Board, Config, PlacedTile, Tile, ValidationResult } from "./types";

const key = (row: number, col: number) => `${row},${col}`;
const fail = (reason: string): ValidationResult => ({ ok: false, reason });

/** Multiset check: every placed letter must be available in `rack`. */
function rackHasTiles(rack: Tile[], placed: PlacedTile[]): boolean {
  const counts = new Map<Tile, number>();
  for (const t of rack) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const p of placed) {
    const n = counts.get(p.letter) ?? 0;
    if (n === 0) return false;
    counts.set(p.letter, n - 1);
  }
  return true;
}

/**
 * Validates the structural legality of a placement (NOT word validity, which is
 * decided by human consensus / the DO). `board` is the PRE-move board.
 */
export function validatePlacement(
  board: Board,
  placed: PlacedTile[],
  rack: Tile[],
  config: Config,
): ValidationResult {
  if (placed.length === 0) return fail("no tiles placed");

  // Bounds + one-tile-per-cell-per-turn.
  const seen = new Set<string>();
  for (const p of placed) {
    if (!inBounds(board, p.row, p.col)) return fail("tile placed off the board");
    const k = key(p.row, p.col);
    if (seen.has(k)) return fail("only one tile may be placed on a cell per turn");
    seen.add(k);
  }

  if (!rackHasTiles(rack, placed)) return fail("placed tiles are not in your rack");

  // Stacking rules: height limit + no same letter on top.
  for (const p of placed) {
    if (board[p.row][p.col].length >= config.maxStackHeight) {
      return fail(`stack height cannot exceed ${config.maxStackHeight}`);
    }
    if (topTile(board, p.row, p.col) === p.letter) {
      return fail("cannot place the same letter on top of itself");
    }
  }

  // Single row or column.
  const rows = new Set(placed.map((p) => p.row));
  const cols = new Set(placed.map((p) => p.col));
  const sameRow = rows.size === 1;
  const sameCol = cols.size === 1;
  if (!sameRow && !sameCol) return fail("all tiles must be in a single row or column");

  // Contiguity: the span between the placed extremes must be fully occupied after the move.
  const after = applyPlacement(board, placed);
  if (sameRow) {
    const r = [...rows][0];
    const cs = placed.map((p) => p.col);
    for (let c = Math.min(...cs); c <= Math.max(...cs); c++) {
      if (!isOccupied(after, r, c)) return fail("placed tiles must form a continuous line");
    }
  } else {
    const c = [...cols][0];
    const rs = placed.map((p) => p.row);
    for (let r = Math.min(...rs); r <= Math.max(...rs); r++) {
      if (!isOccupied(after, r, c)) return fail("placed tiles must form a continuous line");
    }
  }

  const firstMove = boardIsEmpty(board);
  if (firstMove) {
    if (placed.length < 2) return fail("the first move must be at least 2 letters long");
    if (config.firstMoveMustCoverCenter) {
      const onCenter = placed.some((p) =>
        config.centerCells.some((cc) => cc.row === p.row && cc.col === p.col),
      );
      if (!onCenter) return fail("the first move must cover a center square");
    }
  } else {
    // Must connect: a placed tile stacks on an existing tile, or is orthogonally
    // adjacent to a pre-existing occupied cell.
    const connects = placed.some((p) => {
      if (board[p.row][p.col].length > 0) return true; // stacked on existing
      const nbrs = [
        [p.row - 1, p.col],
        [p.row + 1, p.col],
        [p.row, p.col - 1],
        [p.row, p.col + 1],
      ];
      return nbrs.some(([r, c]) => inBounds(board, r, c) && isOccupied(board, r, c));
    });
    if (!connects) return fail("each play must connect to existing tiles");
  }

  // Cannot stack over an entire existing word: every pre-existing run (≥2) must
  // keep at least one cell unmodified this turn.
  for (const run of maximalRuns(board)) {
    const allCovered = run.positions.every((p) => seen.has(key(p.row, p.col)));
    if (allCovered) return fail("cannot stack over an entire existing word in one turn");
  }

  // A legal play must form at least one word (≥2 run) through a placed tile.
  if (extractWords(board, placed).length === 0) {
    return fail("play must form at least one word");
  }

  return { ok: true };
}
