import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { validatePlacement } from "./placement";
import { emptyBoard, layAcross, placeAcross, set } from "./testutil";
import type { ValidationResult } from "./types";

const cfg = DEFAULT_CONFIG;
const reason = (r: ValidationResult) => (r.ok ? "" : r.reason);

describe("validatePlacement — first move", () => {
  it("accepts a 2+ letter word covering the center", () => {
    const r = validatePlacement(emptyBoard(), placeAcross(4, 4, ["c", "a", "t"]), ["c", "a", "t"], cfg);
    expect(r.ok).toBe(true);
  });

  it("rejects a single-tile first move", () => {
    const r = validatePlacement(emptyBoard(), placeAcross(4, 4, ["a"]), ["a"], cfg);
    expect(reason(r)).toMatch(/2 letters/);
  });

  it("rejects a first move that misses the center", () => {
    const r = validatePlacement(emptyBoard(), placeAcross(0, 0, ["c", "a", "t"]), ["c", "a", "t"], cfg);
    expect(reason(r)).toMatch(/center/);
  });
});

describe("validatePlacement — structural rules", () => {
  it("rejects two tiles on the same cell", () => {
    const r = validatePlacement(
      emptyBoard(),
      [{ row: 4, col: 4, letter: "a" }, { row: 4, col: 4, letter: "b" }],
      ["a", "b"],
      cfg,
    );
    expect(reason(r)).toMatch(/one tile/);
  });

  it("rejects a diagonal (non-line) placement", () => {
    const r = validatePlacement(
      emptyBoard(),
      [{ row: 4, col: 4, letter: "a" }, { row: 5, col: 5, letter: "b" }],
      ["a", "b"],
      cfg,
    );
    expect(reason(r)).toMatch(/single row or column/);
  });

  it("rejects placing the same letter on top of itself", () => {
    const board = emptyBoard();
    set(board, 4, 4, "a");
    const r = validatePlacement(board, [{ row: 4, col: 4, letter: "a" }], ["a"], cfg);
    expect(reason(r)).toMatch(/same letter/);
  });

  it("rejects exceeding the max stack height", () => {
    const board = emptyBoard();
    set(board, 4, 4, "a", "b", "c", "d", "e"); // height 5
    const r = validatePlacement(board, [{ row: 4, col: 4, letter: "f" }], ["f"], cfg);
    expect(reason(r)).toMatch(/height/);
  });

  it("rejects tiles not in the rack", () => {
    const r = validatePlacement(emptyBoard(), placeAcross(4, 4, ["c", "a", "t"]), ["c", "a"], cfg);
    expect(reason(r)).toMatch(/rack/);
  });

  it("rejects a disconnected play after the first move", () => {
    const board = emptyBoard();
    layAcross(board, 4, 4, ["c", "a", "t"]);
    const r = validatePlacement(board, placeAcross(0, 0, ["o", "n"]), ["o", "n"], cfg);
    expect(reason(r)).toMatch(/connect/);
  });

  it("rejects stacking over an entire existing word", () => {
    const board = emptyBoard();
    layAcross(board, 4, 4, ["a", "t"]); // existing "at"
    const r = validatePlacement(
      board,
      [{ row: 4, col: 4, letter: "x" }, { row: 4, col: 5, letter: "y" }],
      ["x", "y"],
      cfg,
    );
    expect(reason(r)).toMatch(/entire/);
  });

  it("accepts a connected extension", () => {
    const board = emptyBoard();
    layAcross(board, 4, 4, ["c", "a", "t"]);
    const r = validatePlacement(board, [{ row: 4, col: 7, letter: "s" }], ["s"], cfg);
    expect(r.ok).toBe(true);
  });
});
