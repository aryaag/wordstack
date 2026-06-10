import { describe, expect, it } from "vitest";
import { extractWords } from "./words";
import { emptyBoard, placeAcross, set } from "./testutil";

describe("extractWords", () => {
  it("extracts a single flat word on the first move", () => {
    const words = extractWords(emptyBoard(), placeAcross(4, 3, ["c", "a", "t"]));
    expect(words).toHaveLength(1);
    expect(words[0].word).toBe("cat");
    expect(words[0].orientation).toBe("across");
    expect(words[0].cells.map((c) => c.height)).toEqual([1, 1, 1]);
    expect(words[0].cells.every((c) => c.placedThisTurn)).toBe(true);
  });

  it("expands the qu tile to two characters", () => {
    const words = extractWords(emptyBoard(), placeAcross(4, 3, ["qu", "e", "e", "n"]));
    expect(words[0].word).toBe("queen");
    expect(words[0].cells).toHaveLength(4);
  });

  it("returns both words for a single tile completing an across + down word (shared tile)", () => {
    const board = emptyBoard();
    set(board, 4, 3, "c");
    set(board, 4, 5, "t");
    set(board, 3, 4, "a");
    set(board, 5, 4, "e");
    const words = extractWords(board, [{ row: 4, col: 4, letter: "o" }]);
    const strings = words.map((w) => w.word).sort();
    expect(strings).toEqual(["aoe", "cot"]);
    // the shared placed cell appears in both words
    expect(words.every((w) => w.cells.some((c) => c.row === 4 && c.col === 4))).toBe(true);
  });

  it("reports the post-move height of a stacked cell", () => {
    const board = emptyBoard();
    set(board, 4, 4, "x", "c"); // pre-existing height-2 stack, top "c"
    const words = extractWords(board, [{ row: 4, col: 5, letter: "a" }, { row: 4, col: 6, letter: "t" }]);
    // word "cat": first cell height 2, the two newly placed cells height 1
    const cat = words.find((w) => w.word === "cat")!;
    expect(cat.cells.map((c) => c.height)).toEqual([2, 1, 1]);
  });

  it("ignores runs that no placed tile passes through", () => {
    const board = emptyBoard();
    set(board, 0, 0, "h");
    set(board, 0, 1, "i"); // pre-existing "hi", untouched this turn
    const words = extractWords(board, placeAcross(4, 4, ["o", "n"]));
    expect(words.map((w) => w.word)).toEqual(["on"]);
  });
});
