# Scoring

Implemented by `scoreTurn(words, placedTiles, config)` and
`endgamePenalty(leftoverTiles, config)` in
[`worker/src/engine/scoring.ts`](../worker/src/engine/scoring.ts) — fully
unit-tested ([`scoring.test.ts`](../worker/src/engine/scoring.test.ts)). This doc
is the intent; the engine is the source of truth. Tunable knobs live in
[`config.ts`](../worker/src/engine/config.ts).

## Per-word base score
For each word **formed or modified** this turn:
- If **all** tiles in the word are height 1: `2 × number of letters`
  (`flatPointsPerLetter`).
- If the word contains **any** stacked tile (height ≥ 2): `1 × sum of heights of
  every tile in the word` — height includes all tiles underneath, so a stack of 3
  contributes 3 points for that cell.

Sum across all words formed/modified in the turn. A tile shared by two scored
words is counted in **each** word.

## Bonus scoring
- **Qu bonus** (`quBonus`, default +2): if you use the Qu tile in a word where
  **all** tiles are height 1, that word scores **+2**. The bonus is per word — if
  Qu sits at the intersection of two flat words, both get +2 (total +4). In any
  stacked combination, Qu is just 1 point per height with no bonus.
- **Bingo bonus** (`bingoBonus`, default +20): using **all 7 tiles from your rack
  in a single turn** scores **+20**. Only triggers at exactly 7 — using all tiles
  when you have fewer than 7 (near endgame) does not qualify.

## Endgame tile penalty
`endgamePenalty()` — when the game ends naturally, **deduct 5 points**
(`endgameTilePenaltyPoints`) per leftover tile on a player's rack. Default on
(`endgameTilePenalty: true`); a host-cancel ends the game with **no** penalty.
The end screen shows the per-player penalty breakdown only when the game's
`scored` flag is set. Highest total score wins; trophies go to all top-score ties.

## Test coverage (required)
Flat (2/letter) vs stacked (sum-of-heights), multi-word turns, shared tiles,
illegal stacks, first-move center requirement, Qu bonus (including +4 at an
intersection), bingo bonus, endgame tile penalty, and the
cannot-overwrite-entire-word rule.
