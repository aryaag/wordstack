import type { FormedWord } from "./types";

export type SuffixRule = "S" | "ES" | "D" | "ED";
export type IsValidWord = (word: string) => Promise<boolean>;

export interface WordTriviality {
  word: string;
  trivial: boolean;
  rule?: SuffixRule;
}

export interface TrivialityResult {
  /** True only if EVERY word formed this turn is trivially derived (→ illegal). */
  allTrivial: boolean;
  perWord: WordTriviality[];
  reason?: string;
}

/**
 * Trivial-suffix detection (S / ES / D / ED). All "pre-existing" checks are
 * position-specific: a stem cell counts as pre-existing only if it was NOT
 * touched this turn (`placedThisTurn === false`) — so PUMPED→JUMPED (J stacked
 * on P) does not fire, because the stem cells changed.
 *
 * Suffix tiles are always single-char ('s'/'e'/'d'), so trailing chars map 1:1
 * to trailing cells; the qu tile only ever appears earlier in the word.
 */
async function classifyWord(w: FormedWord, isValidWord: IsValidWord): Promise<SuffixRule | null> {
  const cells = w.cells;
  const n = cells.length;
  const letter = (i: number) => cells[i].letter;

  // Stem cells (all but the last `k`) must be untouched this turn.
  const stemUntouched = (k: number) => cells.slice(0, n - k).every((c) => !c.placedThisTurn);
  // Char string of the first `count` cells (qu expands to two chars).
  const prefix = (count: number) => cells.slice(0, count).map((c) => c.letter).join("");
  // Did this turn place a tile within the first `count` cells?
  const placedWithin = (count: number) => cells.slice(0, count).some((c) => c.placedThisTurn);

  // ED — secondary: if word[:-1] (D-only stem) is a real word containing a tile
  // placed this turn, it's a legitimate alternative decomposition (PAL→PALE+D).
  if (n >= 3 && letter(n - 2) === "e" && letter(n - 1) === "d" && stemUntouched(2)) {
    const dOnly = prefix(n - 1);
    if ((await isValidWord(dOnly)) && placedWithin(n - 1)) return null;
    return "ED";
  }

  // ES — secondary: word[:-1] (S-only stem) real + newly-touched → legit (FO→FOE+S).
  if (n >= 3 && letter(n - 2) === "e" && letter(n - 1) === "s" && stemUntouched(2)) {
    const sOnly = prefix(n - 1);
    if ((await isValidWord(sOnly)) && placedWithin(n - 1)) return null;
    return "ES";
  }

  // D (not already ED) — no secondary check.
  if (n >= 2 && letter(n - 1) === "d" && stemUntouched(1)) return "D";

  // S (not already ES) — no secondary check.
  if (n >= 2 && letter(n - 1) === "s" && stemUntouched(1)) return "S";

  return null;
}

export async function detectTrivialSuffixes(
  words: FormedWord[],
  isValidWord: IsValidWord,
): Promise<TrivialityResult> {
  const perWord: WordTriviality[] = [];
  for (const w of words) {
    const rule = await classifyWord(w, isValidWord);
    perWord.push({ word: w.word, trivial: rule !== null, rule: rule ?? undefined });
  }

  const allTrivial = words.length > 0 && perWord.every((p) => p.trivial);
  if (!allTrivial) return { allTrivial, perWord };

  const rules = [...new Set(perWord.map((p) => p.rule))].join("/");
  return {
    allTrivial,
    perWord,
    reason: `move only adds a trivial suffix (${rules}); at least one genuinely new word is required`,
  };
}
