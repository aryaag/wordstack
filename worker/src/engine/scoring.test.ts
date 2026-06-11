import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { endgamePenalty, scoreTurn } from "./scoring";
import type { FormedWord, PlacedTile, Tile, WordCell } from "./types";

const cfg = DEFAULT_CONFIG;
const cell = (letter: Tile, height: number): WordCell => ({
  row: 0,
  col: 0,
  letter,
  height,
  placedThisTurn: true,
});
const flatWord = (letters: Tile[]): FormedWord => ({
  word: letters.join(""),
  orientation: "across",
  cells: letters.map((l) => cell(l, 1)),
});
const placed = (n: number): PlacedTile[] =>
  Array.from({ length: n }, (_, i) => ({ row: 0, col: i, letter: "a" }));

describe("scoreTurn", () => {
  it("scores a flat word at 2 per tile", () => {
    expect(scoreTurn([flatWord(["c", "a", "t"])], placed(3), cfg).total).toBe(6);
  });

  it("scores a stacked word as the sum of cell heights", () => {
    const word: FormedWord = {
      word: "cat",
      orientation: "across",
      cells: [cell("c", 2), cell("a", 1), cell("t", 1)],
    };
    expect(scoreTurn([word], placed(2), cfg).total).toBe(4); // 2+1+1
  });

  it("adds +2 for a flat word using the qu tile (QUEEN flat = 10)", () => {
    const score = scoreTurn([flatWord(["qu", "e", "e", "n"])], placed(4), cfg);
    expect(score.perWord[0].quBonus).toBe(2);
    expect(score.total).toBe(10); // 2×4 + 2
  });

  it("gives NO qu bonus when the qu word is stacked", () => {
    const word: FormedWord = {
      word: "qua",
      orientation: "across",
      cells: [cell("qu", 2), cell("a", 1)],
    };
    const score = scoreTurn([word], placed(1), cfg);
    expect(score.perWord[0].quBonus).toBe(0);
    expect(score.total).toBe(3); // 2+1, no bonus
  });

  it("awards +4 when qu sits at the intersection of two flat words", () => {
    const across = flatWord(["qu", "a"]);
    const down = flatWord(["qu", "i"]);
    const score = scoreTurn([across, down], placed(3), cfg);
    expect(score.perWord.every((w) => w.quBonus === 2)).toBe(true);
    // (2×2+2) + (2×2+2) = 6 + 6
    expect(score.total).toBe(12);
  });

  it("adds the +20 bingo bonus only when all 7 tiles are placed", () => {
    expect(scoreTurn([flatWord(["c", "a", "t"])], placed(7), cfg).bingoBonus).toBe(20);
    expect(scoreTurn([flatWord(["c", "a", "t"])], placed(7), cfg).total).toBe(26);
    expect(scoreTurn([flatWord(["c", "a", "t"])], placed(6), cfg).bingoBonus).toBe(0);
  });

  it("counts a shared tile in both words", () => {
    const w1 = flatWord(["c", "a", "t"]); // 6
    const w2 = flatWord(["a", "t"]); // 4, shares tiles conceptually
    expect(scoreTurn([w1, w2], placed(3), cfg).total).toBe(10);
  });
});

describe("endgamePenalty", () => {
  it("deducts 5 per leftover tile when the penalty is on", () => {
    expect(endgamePenalty(3, cfg)).toBe(15);
    expect(endgamePenalty(7, cfg)).toBe(35);
  });

  it("is zero when the player went out (empty rack)", () => {
    expect(endgamePenalty(0, cfg)).toBe(0);
  });

  it("is zero when the penalty is disabled", () => {
    expect(endgamePenalty(4, { ...cfg, endgameTilePenalty: false })).toBe(0);
  });

  it("respects a custom per-tile penalty", () => {
    expect(endgamePenalty(2, { ...cfg, endgameTilePenaltyPoints: 10 })).toBe(20);
  });
});
