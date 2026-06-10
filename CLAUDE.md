# Upwords Online — Claude Code Guide

> **TODO (after Phase 7, once live & stable):** split this file — move the deep
> reference (game rules, scoring, tile distribution, challenge flow, WS protocol)
> into a repo `docs/` folder and keep this CLAUDE.md lean (stack, conventions,
> commands, gotchas, links to docs/). Where code is already the source of truth
> (engine, `protocol.ts`), describe intent and point at the code, don't duplicate.

## Project overview

Real-time multiplayer web implementation of **Upwords** — the Scrabble-like board game where tiles can be stacked on top of each other to change words. 2–4 players share a room and take turns. Stack height determines scoring. Everything runs on Cloudflare.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite + TypeScript, served via Workers Assets |
| Worker | Cloudflare Workers — HTTP API + static asset serving |
| Game room | Cloudflare Durable Objects — one DO per room, authoritative state + WebSockets |
| Lexicon DB | Cloudflare D1 (SQLite) — word validity only (`words` table) |
| CLI / deploy | Wrangler v3 |

All infrastructure is Cloudflare-only — no separate server, no Docker, no external DB.

## Project structure

```
upwords/
├── frontend/              # React + Vite + TS
│   ├── src/
│   └── vite.config.ts
├── worker/                # Cloudflare Worker entry + Durable Object
│   ├── src/
│   │   ├── index.ts       # Worker: routing, MW proxy, static assets
│   │   ├── room.ts        # Durable Object: game state, WebSocket fan-out
│   │   └── engine/        # Pure game engine (no I/O, fully unit-tested)
│   └── wrangler.toml
├── scripts/
│   └── build-wordlist.ts  # Reproducible lexicon pipeline (download→filter→seed)
├── migrations/
│   └── 0001_words.sql     # D1 schema: words(word TEXT PRIMARY KEY)
└── CLAUDE.md
```

## Key commands

```bash
# local dev
wrangler dev                                          # worker + DO on http://localhost:8787
npx vite --config frontend/vite.config.ts             # frontend dev server

# lexicon
npx ts-node scripts/build-wordlist.ts                 # rebuild word list
wrangler d1 execute upwords-db --local --file migrations/0001_words.sql
wrangler d1 execute upwords-db --file migrations/0001_words.sql  # remote

# secrets
wrangler secret put MW_KEY                            # Merriam-Webster API key

# deploy
wrangler deploy                                       # worker + assets
```

## Git conventions

- Branch names: `<type>/<short-slug>` — e.g. `feat/tile-scoring`, `fix/ws-reconnect`
- Commit format: `<type>: <what changed>` — e.g. `feat: add word validation endpoint`
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`
- PRs go against `main`; squash-merge preferred for small changes
- Commit at each phase boundary (see Phases below) so each phase is reviewable

## Architecture decisions (already made — implement exactly these)

### Word validity: local, instant, D1-only
- Validation against `words(word TEXT PRIMARY KEY)` in D1 — pure set membership
- Never call an external API to validate a word
- Lexicon: ~50,000–70,000 entries, SCOWL size 50–70 buckets, **must include inflected forms** (`cats`, `running`, `taller`) — SCOWL at these sizes is lemma-heavy; verify inflection coverage and add a step if needed
- `scripts/build-wordlist.ts` must be reproducible: download source → lowercase → dedup → filter → emit seed SQL. Document source + license in the repo.
- Expose the frequency cutoff as a tunable knob in config

### Definitions: Merriam-Webster, live, never stored
- MW Collegiate Dictionary API: `https://www.dictionaryapi.com/api/v3/references/collegiate/json/{word}?key={MW_KEY}`
- Called **only** when a player explicitly taps "Define / Challenge" on a played word — not on normal plays
- **Hard compliance rule: never cache, persist, log, or store the MW response anywhere** — not D1, not DO storage, not KV, not a file. Flow is strictly: `fetch → parse → return to client → render → discard`
- The MW key is a Worker secret (`wrangler secret put MW_KEY`). Never expose it to the frontend; browser calls our Worker endpoint, Worker calls MW.
- Response parsing: real entries are objects with `shortdef` (string[]) and `fl` (part of speech). If the word isn't found, MW returns an array of plain strings (suggestions) — treat as "not found". Render `fl` + first 1–3 `shortdef` strings. Handle loading, not-found, and network-error states.
- `// COMMERCIAL NOTE: MW free tier is non-commercial (1,000 req/day). If this app ever gets ads or a paid tier, a commercial MW agreement is required.` — leave this comment at the call site.

### Validation mode and challenge flow

Default mode: `"challenge"`. Server config: `VALIDATION_MODE: "auto" | "challenge"` + `challengePenalty: boolean` (default `false`).

**Challenge resolution is by HUMAN CONSENSUS — not the dictionary.** D1 is never consulted to decide a challenged word (it is only used for the trivial-suffix check). A challenge does **not** reject instantly — it pauses the game into a **review/vote**, and the move plays only if **every** non-submitter allows it. Any single upheld challenge (a "not valid" vote) rejects the whole move.

**Two-stage post-submit flow (confirmed design):**

On submit, the DO hard-validates placement + trivial-suffix (immediate `error` if broken, no popup), extracts words + tentative scores, enters `pending` with **stage `"open"`**, sets a 30s **DO Alarm** (alarms survive hibernation; never `setTimeout`), and broadcasts `move_pending`.

**Open stage** — all players see the words + tentative points. Non-submitters can **Accept** or **Challenge** (the submitter's popup is read-only). A 30s countdown auto-accepts the unresolved. If every non-submitter accepts, or the timer fires with no challenge → the move commits (`move_applied`).

**Review stage** — the moment any non-submitter challenges a word, the move enters **stage `"review"`**: the auto-accept timer **pauses** (a long DO-Alarm backstop only prevents a permanent hang), the table deliberates out loud, and every non-submitter casts a **vote on the word's validity** — framed as *"Is WORD a valid word? Yes (valid) / No (not valid)"*, explicitly **not** a vote on whether the challenge was fair. One clarifying sentence sits directly above the Yes/No buttons. The challenge itself counts as the challenger's **No** vote (they may switch to Yes to withdraw).

**Resolution** (when all non-submitters have voted, or the backstop fires with unvoted = allow):
- **All allow** → `move_applied` (committed, scored, rack refilled).
- **Any reject** → the entire move is rejected: the submitter takes the tiles back and replays. The DO broadcasts `challenge_result` then `move_rejected`. No D1 check, no turn skip for the challenger.

With a single opponent there is no one else to deliberate with, so a challenge resolves immediately (the lone challenger's No stands). A move is always accepted or rejected as a unit — no partial acceptance.

The **View definition** action (MW lookup, Phase 6) is a separate, informational button and never counts as a vote.

### Live game state lives in the Durable Object, NOT D1
- D1 holds only the word lexicon. All board/rack/bag/score/turn state lives in DO storage.
- One DO per room, keyed by a short room code (e.g. 6 chars). Worker routes `/room/:code/ws` → that DO.
- DO uses the **hibernatable WebSocket API**. DO persists to DO storage so rooms survive eviction.

## Game rules (from physical edition — all tuneable via `config.ts`)

### Board & setup
- **Board:** 10×10 grid
- **Rack:** 7 tiles per player; refill to 7 after each turn
- **Max stack height:** 5 tiles
- **First move:** word of length ≥ 2; must cover **at least 1 of the 4 central start squares** (the 2×2 center of the board, rows 4–5 / cols 4–5 in 0-indexed terms). Config: `firstMoveMustCoverCenter: true`.

### Placing tiles
- All tiles in a turn must be placed in **a single row or column** (across or down; never diagonally, never right-to-left or bottom-to-top).
- After the first move, every play must build on or connect to existing tiles — every maximal run of ≥ 2 letters through a newly placed tile must be a valid word.
- **Only 1 tile may be placed on any given cell per turn** — you cannot stack two tiles on the same cell in a single turn.

### Stacking rules
- May place on an empty cell or on top of an existing stack (if height < 5).
- **Cannot place the same letter on top of itself** (no `A` on `A`).
- **Cannot stack over an entire existing word in one turn** — at least 1 letter from the previous word must remain unmodified. You cannot change every tile of an existing word in a single play.

### Trivial suffixes (special rule — easy to get wrong)
The following plays are **not considered forming a new word** and are illegal as standalone plays:
- Adding **S** to make a word plural (CATS on CAT)
- Adding **ES** to pluralise or conjugate (DRESSES on DRESS, BUZZES on BUZZ)
- Adding **D** or **ED** to make a word past tense (JUMPED on JUMP, BAKED on BAKE)

A move is only illegal on this basis if **all** words formed/modified by the turn are trivially derived. If even one word is genuinely new, the move is legal.

**Detection algorithm (board-state diff + one lexicon lookup per 2-char suffix):**

All "pre-existing" checks below are **position-specific**: compare what the **same cells** that form the current word spelled before the move, not whether the stem exists anywhere else on the board. If JUMP exists elsewhere on the board and a player changes PUMPED → JUMPED by stacking J on P, those cells previously spelled PUMP — not JUMP — so the check correctly does not fire.

Check suffixes longest-first. For each word formed/modified this turn:

1. If `word` ends in `ED` and the cells for `word[:-2]` spelled that same string before the move:
   - Secondary check: is `word[:-1]` (the D-only stem) a valid lexicon word **and** does it contain at least one tile placed this turn?
   - If yes → legitimate alternative decomposition (e.g. PAL pre-existing + E+D placed → PALE+D; PALE is in lexicon and E was placed) → **not trivial**
   - If no → **trivially derived** (e.g. JUMP+ED; JUMPE is not a word)
2. If `word` ends in `ES` and the cells for `word[:-2]` spelled that same string before the move:
   - Secondary check: is `word[:-1]` (the S-only stem) a valid lexicon word **and** does it contain at least one tile placed this turn?
   - If yes → legitimate alternative (e.g. FO pre-existing + E+S placed → FOE+S; FOE is in lexicon and E was placed) → **not trivial**
   - If no → **trivially derived** (e.g. DRESS+ES; DRESSE is not a word)
3. If `word` ends in `D` (not already caught by check 1) and the cells for `word[:-1]` spelled that same string before the move → **trivially derived**
4. If `word` ends in `S` (not already caught by check 2) and the cells for `word[:-1]` spelled that same string before the move → **trivially derived**
5. Otherwise → **genuinely new word**

If **all** words formed this turn are trivially derived → reject with a specific error message naming the suffix rule.

### Scoring (critical — unit-test all cases)
- For each word **formed or modified** this turn:
  - If **all** tiles in the word are height 1: `2 × number of letters in the word`
  - If the word contains **any** stacked tile (height ≥ 2): `1 × sum of heights of every tile in the word` (height includes all tiles underneath — a stack of 3 contributes 3 points for that cell)
- Sum across all words formed/modified in the turn. A tile shared by two scored words is counted in each.

### Bonus scoring
- **Qu bonus:** if you use the Qu tile in a word where all tiles are height 1, score **+2 extra bonus points for that word**. The bonus applies per word — if Qu sits at the intersection of two flat words, both words get +2 (total +4). In any stacked combination, Qu is worth the usual 1 point per height with no bonus.
- **Bingo bonus:** if you use **all 7 tiles from your rack in a single turn**, score **+20 extra bonus points**. Only triggers at exactly 7; using all tiles when you have fewer than 7 (near endgame) does not qualify.

### Tile bag (confirmed from physical edition)
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

### Actions per turn (pick exactly one)
- **Play:** place tiles, score words, refill rack to 7.
- **Pass:** end turn without playing. Tactical — can open better opportunities.
- **Exchange:** swap exactly **1 tile** — put your unwanted tile aside, draw a new one, return the unwanted tile to the bag. Turn ends. (Physical rules allow only 1 tile exchange, not multiple.)

### Illegal words (from physical rulebook)
The following are always invalid regardless of lexicon:
- Proper nouns (names of places or people)
- Hyphenated words
- Words requiring an apostrophe
- Abbreviations, acronyms, and symbols
- Prefixes and suffixes that cannot stand alone
- Foreign words unless they appear in the dictionary

### Endgame
The game ends when either:
- A player uses all their tiles **and no tiles remain in the bag**, OR
- All players pass consecutively (no one can form a word)

After the game ends:
- **Deduct 5 points** for each leftover tile on a player's rack (this is a physical-edition rule, not optional — default on, config flag `endgameTilePenalty: true`)
- Highest total score wins

### Qu tile string representation
The Qu tile occupies one cell but represents two characters. When extracting a word string for D1 lookup or display, expand the Qu cell to `"qu"`. Example: Qu+E+E+N on 4 cells → lookup string `"queen"`. The D1 lexicon stores normal ASCII words (`queen`, `quest`, etc.) — no special entries needed. The board data model stores the tile value as `"qu"` (lowercase two-char string) to distinguish it from separate Q and U tiles.

### Rack privacy
The DO sends the full game state to every connected client. Each player's rack data reaches all browsers — the UI is responsible for hiding other players' racks and showing only tile counts for opponents. No server-side personalisation of the state payload is required.

## Game engine (pure module — `worker/src/engine/`)

- No I/O, no imports from Cloudflare runtime — fully unit-testable in Node/Vitest
- `validatePlacement(board, placedTiles, rack, config)` → `{ ok: true } | { ok: false, reason: string }`
  - Checks: single line, adjacency after first move, height ≤ 5, no same-letter-on-top, only 1 tile per cell per turn, cannot overwrite entire existing word
- `extractWords(board, placedTiles)` → distinct horizontal + vertical runs of length ≥ 2 through newly placed/modified tiles, with per-tile heights
- `scoreTurn(words, placedTiles, config)` → flat-vs-stacked rule + Qu bonus + bingo bonus
- Word validity injected as `isValidWord(word: string) => Promise<boolean>` — engine stays pure, DO supplies the D1-backed implementation
- Tests must cover: flat (2/letter) vs stacked (sum-of-heights), multi-word turns, shared tiles, illegal stacks, first-move center requirement, Qu bonus (including +4 at intersection), bingo bonus, trivial-suffix rejection (S / ES / D / ED alone), the PAL→PALED false-positive case, cannot-overwrite-entire-word rule

## WebSocket message protocol

**Client → Server:**
- `join` / `leave`
- `submit_move` — placed tiles; triggers placement validation then the post-submit popup
- `challenge_word` — word index; in the open stage this opens the review/vote
- `acknowledge_move` — open stage: accept the move (no challenge)
- `vote_move` — review stage: `{ vote: "allow" | "reject" }` (is the word valid?)
- `pass`
- `swap_tiles` — 1 tile index to exchange
- `define` — word + board coords; triggers MW lookup (popup "View definition" button)
- `chat` (optional)

**Server → Client:**
- `state` — full snapshot (sent on connect and after every committed change)
- `move_pending` — `{ words, tentativePoints, windowMs }` — opens the 30-second post-submit popup
- `challenge_update` — `{ playerId, wordIndex }` — broadcast in real time when any player challenges a word
- `challenge_result` — `{ challenged: [{word, by}] }` — which words were challenged and by whom; sent when window closes
- `move_applied` — move committed, includes updated board + scores
- `move_rejected` — the review vote rejected the move; player replays their turn
- `definition_result` — MW response for a `define` request
- `error`
- `game_over` — `{ reason }` — game ended/canceled (e.g. host left)

On reconnect, DO sends the full current `state` snapshot. If a post-submit popup is in progress, the snapshot includes the pending move, the current per-player accept/challenge state, and the rejoining player's remaining countdown so they can render the popup correctly.

## Phases

1. **Scaffold** — wrangler project, TS, Vite frontend, D1 + DO + Assets bindings, hello-world deploy
2. **Lexicon pipeline** — build script, seed D1, `GET /validate?word=` test endpoint; show source + count + sample lookups
3. **Engine** — pure module + unit tests (no network)
4. **Durable Object room** — WebSocket protocol, wire in engine + D1 validity; 2-player game end to end
5. **Frontend** — board/rack/play UI, room create/join, live sync
6. **Define/Challenge** — Worker MW proxy (secret key, zero storage) + modal UI
7. **Polish** — reconnection, endgame, swap/pass, edge cases, live deploy

## Confirmed config

| Setting | Value |
|---------|-------|
| Board | 10×10 |
| Stack height | 5 |
| Rack size | 7 |
| Players | 2–4 |
| Validation mode | `"challenge"` + `challengePenalty: false` |
| Challenge resolution | Human consensus (no dictionary arbiter). Challenge → review/vote; move plays only if every non-submitter allows it; any "not valid" vote rejects it |
| Challenge window | 30s auto-accept in the open stage; a challenge pauses the timer and opens the vote |
| Join | A non-empty name is required (no anonymous players); enforced client + server |
| Host leaves | The game is canceled for everyone (`game_over`, end screen) |
| Lexicon | SCOWL size 50–70 buckets |
| Q tile | Combined `Qu` |
| Tile distribution | Confirmed from physical edition (see table above) |
| First move center | Required (4 central squares) |
| Endgame tile penalty | 5 pts per leftover tile, default on |
| Exchange | 1 tile only per turn |
| UI target | **Mobile-first** — primarily accessed from mobile web browsers; design for small touch screens first, scale up to desktop |

## D1 / Wrangler notes

- D1 is SQLite — avoid Postgres-specific SQL
- `wrangler.toml` is safe to commit (no secrets); secrets go via `wrangler secret put`
- Always verify current Cloudflare docs for DO WebSocket hibernation, D1 bindings, and Workers Assets config — wrangler syntax evolves

## Cloudflare access

Cloudflare API key is available as `$CLOUDFLARE_API_TOKEN` in the shell — pass it to wrangler or curl calls via that variable, never hard-code it.
