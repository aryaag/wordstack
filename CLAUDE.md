# Upwords Online — Claude Code Guide

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

**Challenge resolution is by HUMAN CONSENSUS — not the dictionary.** In `"challenge"` mode the D1 lexicon is **not** consulted to decide a challenged word; the non-submitting players decide. A move is accepted only if **every** non-submitting player agrees (explicitly or by timeout) that the words are valid. If even one non-submitter challenges **any** word, the **entire move is rejected**. (D1 is still used for the trivial-suffix secondary check, and for `"auto"` mode if ever enabled.)

**Post-submit popup UX (the confirmed design):**

When a player submits a move, the DO immediately:
1. Validates placement rules (line, adjacency, height, stacking, trivial-suffix) — hard reject if broken, no popup needed.
2. Extracts words formed + tentative scores.
3. Enters `pending` state and sets a **DO Alarm** at submission + 30 seconds as the backstop (alarms survive hibernation; do NOT use `setTimeout`).
4. Broadcasts `move_pending` to all players: words formed + tentative points per word.

All players see a popup containing a **table, one row per word formed, sorted alphabetically by word**, with columns:
- **Word**
- **Points** (tentative)
- **Actions** — a **View definition** button (on-demand MW lookup for that word) and a **Challenge** button.

At the bottom of the popup: an **Accept** button and a **30-second countdown**.

- **Submitting player:** the popup is read-only / informational (no Accept or Challenge).
- **Each non-submitting player** behaves independently:
  - If they do nothing, their countdown runs and at 0s their stance is **auto-accepted**.
  - **Any interaction cancels that player's countdown** — including merely opening **View definition**. Once cancelled, that player must explicitly click **Accept** or **Challenge**; they no longer auto-accept.
  - Each non-submitter's countdown is **independent** of the others'.
- **Challenge** is per-word and one-way (unchallenged → challenged; cannot undo). When a player challenges a word, the DO broadcasts `challenge_update` so everyone sees it in real time.
- **View definition** triggers a live MW lookup (see Definitions), shown only to the requesting player; it is informational and never counts as a vote.

The window closes when every non-submitter has resolved (Accepted, auto-accepted by timeout, or Challenged), with the 30s DO Alarm as a **hard backstop**: when it fires, the window closes regardless, and any non-submitter who has **not** explicitly Challenged counts as Accept — including a player who interacted (cancelling their early auto-accept) but then went idle. This guarantees the window can never hang.

Outcome:
- If **no** non-submitter challenged any word → `move_applied` (committed, scored, rack refilled).
- If **any** non-submitter challenged **any** word → the entire move is rejected: the submitter takes all placed tiles back and replays the turn. **No D1 check, no turn skip for the challenger.** The DO broadcasts `challenge_result` (which words were challenged, by whom), then `move_rejected`.

Note: the entire move is accepted or rejected as a unit — there is no partial acceptance.

The **View definition** action (MW lookup) is a separate part of the same popup from the **Challenge** action; tapping it does not challenge, and it can be used any time the popup is open.

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
- `challenge_word` — word index in the pending move (one-way; sent from the popup's Challenge button)
- `acknowledge_move` — player clicked "Accept" in the post-submit popup (no challenge)
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
- `move_rejected` — a non-submitter challenged a word; player must replay their turn
- `definition_result` — MW response for a `define` request
- `error`
- `game_over`

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
| Challenge resolution | Human consensus (no dictionary arbiter); any 1 challenge rejects the move |
| Challenge window | 30s per-player auto-accept; any interaction cancels that player's countdown |
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
