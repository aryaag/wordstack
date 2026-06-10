import type { Config, FormedWord, PlacedTile } from "./types";

export interface WordScore {
  word: string;
  points: number; // includes the Qu bonus for this word
  quBonus: number;
  flat: boolean;
}

export interface TurnScore {
  total: number;
  perWord: WordScore[];
  bingoBonus: number;
}

/**
 * Scores every word formed/modified this turn.
 * - Flat word (all cells height 1): `flatPointsPerLetter × tile count`.
 * - Stacked word (any cell height ≥ 2): `1 × sum of every cell's height`.
 * - Qu bonus: +`quBonus` per FLAT word that contains the qu tile (so a qu at the
 *   intersection of two flat words scores the bonus twice → +4 total).
 * - Bingo: +`bingoBonus` once if exactly `rackSize` tiles were placed this turn.
 */
export function scoreTurn(
  words: FormedWord[],
  placed: PlacedTile[],
  config: Config,
): TurnScore {
  const perWord: WordScore[] = [];
  let total = 0;

  for (const w of words) {
    const flat = w.cells.every((c) => c.height === 1);
    const base = flat
      ? config.flatPointsPerLetter * w.cells.length
      : w.cells.reduce((sum, c) => sum + c.height, 0);
    const quBonus = flat && w.cells.some((c) => c.letter === "qu") ? config.quBonus : 0;
    const points = base + quBonus;
    perWord.push({ word: w.word, points, quBonus, flat });
    total += points;
  }

  const bingoBonus = placed.length === config.rackSize ? config.bingoBonus : 0;
  total += bingoBonus;

  return { total, perWord, bingoBonus };
}
