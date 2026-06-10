import { describe, expect, it } from "vitest";
import { detectTrivialSuffixes } from "./suffixes";
import { extractWords } from "./words";
import { emptyBoard, fakeLexicon, layAcross, set } from "./testutil";

// Lexicon only needs the words used by the ED/ES secondary checks.
const lex = fakeLexicon(["pale", "foe"]);

const words = (build: (b: ReturnType<typeof emptyBoard>) => { row: number; col: number; letter: string }[]) => {
  const board = emptyBoard();
  const placed = build(board);
  return extractWords(board, placed);
};

describe("detectTrivialSuffixes — rejects bare suffixes", () => {
  it("flags CAT + S → CATS as trivial (S)", async () => {
    const w = words((b) => {
      layAcross(b, 4, 3, ["c", "a", "t"]);
      return [{ row: 4, col: 6, letter: "s" }];
    });
    const r = await detectTrivialSuffixes(w, lex);
    expect(r.allTrivial).toBe(true);
    expect(r.perWord[0].rule).toBe("S");
    expect(r.reason).toMatch(/trivial/);
  });

  it("flags DRESS + ES → DRESSES as trivial (ES)", async () => {
    const w = words((b) => {
      layAcross(b, 4, 2, ["d", "r", "e", "s", "s"]);
      return [{ row: 4, col: 7, letter: "e" }, { row: 4, col: 8, letter: "s" }];
    });
    const r = await detectTrivialSuffixes(w, lex);
    expect(r.allTrivial).toBe(true);
    expect(r.perWord[0].rule).toBe("ES");
  });

  it("flags JUMP + ED → JUMPED as trivial (ED)", async () => {
    const w = words((b) => {
      layAcross(b, 4, 3, ["j", "u", "m", "p"]);
      return [{ row: 4, col: 7, letter: "e" }, { row: 4, col: 8, letter: "d" }];
    });
    const r = await detectTrivialSuffixes(w, lex);
    expect(r.allTrivial).toBe(true);
    expect(r.perWord[0].rule).toBe("ED");
  });

  it("flags BAN + D → BAND as trivial (D, mechanical rule, no secondary check)", async () => {
    const w = words((b) => {
      layAcross(b, 4, 4, ["b", "a", "n"]);
      return [{ row: 4, col: 7, letter: "d" }];
    });
    const r = await detectTrivialSuffixes(w, lex);
    expect(r.perWord[0].rule).toBe("D");
  });
});

describe("detectTrivialSuffixes — legitimate alternatives are NOT trivial", () => {
  it("PAL pre-existing + E + D → PALED is legal (PALE is a word, E was placed)", async () => {
    const w = words((b) => {
      layAcross(b, 4, 3, ["p", "a", "l"]);
      return [{ row: 4, col: 6, letter: "e" }, { row: 4, col: 7, letter: "d" }];
    });
    const r = await detectTrivialSuffixes(w, lex);
    expect(r.allTrivial).toBe(false);
    expect(r.perWord[0].trivial).toBe(false);
  });

  it("FO pre-existing + E + S → FOES is legal (FOE is a word)", async () => {
    const w = words((b) => {
      layAcross(b, 4, 4, ["f", "o"]);
      return [{ row: 4, col: 6, letter: "e" }, { row: 4, col: 7, letter: "s" }];
    });
    const r = await detectTrivialSuffixes(w, lex);
    expect(r.allTrivial).toBe(false);
  });

  it("PUMPED → JUMPED (J stacked on P) does not fire — stem cells changed", async () => {
    const w = words((b) => {
      layAcross(b, 4, 2, ["p", "u", "m", "p", "e", "d"]);
      return [{ row: 4, col: 2, letter: "j" }]; // stack J on the first P
    });
    const r = await detectTrivialSuffixes(w, lex);
    expect(r.perWord[0].trivial).toBe(false);
    expect(r.allTrivial).toBe(false);
  });

  it("is legal if even one word in the turn is genuinely new (CATS trivial + SO genuine)", async () => {
    const w = words((b) => {
      layAcross(b, 4, 3, ["c", "a", "t"]);
      set(b, 5, 6, "o"); // existing 'o' below where the S lands
      return [{ row: 4, col: 6, letter: "s" }]; // forms across CATS and down SO
    });
    const r = await detectTrivialSuffixes(w, lex);
    const byWord = Object.fromEntries(r.perWord.map((p) => [p.word, p.trivial]));
    expect(byWord["cats"]).toBe(true);
    expect(byWord["so"]).toBe(false);
    expect(r.allTrivial).toBe(false);
  });
});
