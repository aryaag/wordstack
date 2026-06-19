# Game rules

Modeled on the classic physical stacking word game. All values are tunable via
[`worker/src/engine/config.ts`](../worker/src/engine/config.ts) — the numbers
below are the confirmed defaults.

## Board & setup
- **Board:** 10×10 grid.
- **Rack:** 7 tiles per player; refill to 7 after each turn.
- **Max stack height:** 5 tiles.
- **First move:** word of length ≥ 2; must cover **at least 1 of the 4 central
  start squares** (the 2×2 center, rows 4–5 / cols 4–5 in 0-indexed terms).
  Config: `firstMoveMustCoverCenter: true`, `centerCells` / `CENTER_CELLS`.

## Placing tiles
- All tiles in a turn must be placed in **a single row or column** (across or
  down; never diagonally, never right-to-left or bottom-to-top).
- After the first move, every play must build on or connect to existing tiles —
  every maximal run of ≥ 2 letters through a newly placed tile must be a valid
  word.
- **Only 1 tile may be placed on any given cell per turn** — you cannot stack two
  tiles on the same cell in a single turn.

## Stacking rules
- May place on an empty cell or on top of an existing stack (if height < 5).
- **Cannot place the same letter on top of itself** (no `A` on `A`).
- **Cannot stack over an entire existing word in one turn** — at least 1 letter
  from the previous word must remain unmodified. You cannot change every tile of
  an existing word in a single play.

## Trivial suffixes (plurals / past tense) — NOT auto-enforced (removed 2026-06-12)
The physical rule disallows plays that only add a trivial **S/ES** (plural) or
**D/ED** (past tense) to an existing word (CATS on CAT, JUMPED on JUMP). We do
**not** try to detect this in code. A reliable heuristic is impossible without
real morphology: the old positional check produced false positives (it rejected
MAD because "MA" pre-existed, and SLID because "SLI" pre-existed, even though
both are genuinely new words). **All word validity — including "is this just a
trivial inflection?" — is now decided by human challenge, never by the engine**
(see [challenge-flow.md](challenge-flow.md)).

The only thing the system flags is **informational, not a block**: if a word
formed this turn was already played earlier in the game (it appears in
`history`), the UI shows a small "↻ played before" note in the live preview and
the turn-review popup. Repeating a word is legal; the note just surfaces it.

## Tile bag (confirmed from physical edition)
100 tiles total, combined `Qu` tile (not separate Q):

| Count | Letters |
|-------|---------|
| 8 | E |
| 7 | A, I, O |
| 6 | S |
| 5 | D, L, M, N, R, T, U |
| 4 | C |
| 3 | B, F, G, H, P |
| 2 | K, W, Y |
| 1 | J, Qu, V, X, Z |

Total: 8 + 21 + 6 + 35 + 4 + 15 + 6 + 5 = **100** ✓

## Actions per turn (pick exactly one)
- **Play:** place tiles, score words, refill rack to 7.
- **Pass:** end turn without playing. Tactical — can open better opportunities.
- **Exchange:** swap exactly **1 tile** — put your unwanted tile aside, draw a new
  one, return the unwanted tile to the bag. Turn ends. (Physical rules allow only
  1 tile exchange, not multiple.)

## Illegal words (from physical rulebook)
The following are always invalid (the table can reject them by challenge):
- Proper nouns (names of places or people)
- Hyphenated words
- Words requiring an apostrophe
- Abbreviations, acronyms, and symbols
- Prefixes and suffixes that cannot stand alone
- Foreign words unless they appear in the dictionary

## Endgame
The game ends when either:
- A player uses all their tiles **and no tiles remain in the bag**, OR
- All players pass consecutively (no one can form a word).

After the game ends:
- **Deduct 5 points** for each leftover tile on a player's rack (physical-edition
  rule, default on — `endgameTilePenalty: true`). See [scoring.md](scoring.md).
- Highest total score wins.

## Qu tile string representation
The Qu tile occupies one cell but represents two characters. When extracting a
word string for display, expand the Qu cell to `"qu"`. Example:
Qu+E+E+N on 4 cells → string `"queen"`. The board data model stores the tile
value as `"qu"` (lowercase two-char string) to distinguish it from separate Q and
U tiles.

## Rack privacy
The DO sends the full game state to every connected client. Each player's rack
data reaches all browsers — the UI is responsible for hiding other players' racks
and showing only tile counts for opponents. No server-side personalisation of the
state payload is required (`PublicState` strips only the secret `bag`/`seed`; see
[`worker/src/protocol.ts`](../worker/src/protocol.ts)).
