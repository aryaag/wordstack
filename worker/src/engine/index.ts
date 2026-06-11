// Pure Upwords game engine — no I/O, no Cloudflare runtime. Word validity is
// decided by human challenge, not the engine; the engine never reaches the
// network or D1 itself.

export * from "./types";
export { CENTER_CELLS, DEFAULT_CONFIG } from "./config";
export {
  applyPlacement,
  boardIsEmpty,
  cloneBoard,
  height,
  inBounds,
  isOccupied,
  makeEmptyBoard,
  maximalRuns,
  topTile,
} from "./board";
export { extractWords } from "./words";
export { validatePlacement } from "./placement";
export { endgamePenalty, scoreTurn } from "./scoring";
export type { TurnScore, WordScore } from "./scoring";
export {
  createBag,
  draw,
  mulberry32,
  newShuffledBag,
  refill,
  shuffle,
  TILE_DISTRIBUTION,
} from "./bag";
