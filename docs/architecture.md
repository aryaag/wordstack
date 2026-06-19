# Architecture decisions

These were decided up front — implement exactly these.

## Word validity: human-consensus only (no lexicon)
Word validity — including trivial plurals/past-tense — is decided entirely by
human challenge (see [challenge-flow.md](challenge-flow.md)). There is **no
dictionary arbiter**: the engine never judges validity, and the app no longer
ships a word lexicon. (A dead D1 lexicon + `GET /validate` endpoint existed
historically but were removed once gameplay stopped using them.)

## Definitions: Merriam-Webster, live, never persisted
- MW Collegiate Dictionary API:
  `https://www.dictionaryapi.com/api/v3/references/collegiate/json/{word}?key={MW_KEY}`.
- Called **only** when a player explicitly taps "Define / Challenge" on a played
  word — not on normal plays.
- **Hard compliance rule: never *persist* the MW response** — not D1, not DO
  storage, not KV, not a file, not a log. Base flow: `fetch → parse → return to
  client → render → discard`.
- **Narrow exception (2026-06-11): a transient, in-memory-only cache is
  permitted** to dedupe redundant lookups (several players defining the same word
  in one turn). It lives only in the room DO's heap (`defCache` in `room.ts`), has
  a short TTL (`DEFINE_TTL_MS`, 5 min), is bounded, is never written to any
  durable store, and is lost on hibernation/eviction. Only successful results are
  cached; errors are not. MW's public ToS has no anti-caching clause; short-lived
  in-memory caching is the legally defensible line, *persistent* storage is not —
  so "never persist" still stands absolutely. The Worker's `/define?word=&room=`
  route forwards to the room DO so the cache is shared per-room. MW fetch+parse is
  in [`worker/src/define.ts`](../worker/src/define.ts) (shared by the Worker route
  + DO).
- The MW key is a Worker secret (`wrangler secret put MW_KEY`) — never exposed to
  the frontend. Browser → our Worker endpoint → MW. Registered as non-commercial
  (1,000 req/day); a `DEFINE_LIMITER` rate-limit (8/10s) guards the quota.
- Parsing: real entries are objects with `shortdef` (string[]) and `fl` (part of
  speech). If the word isn't found, MW returns an array of plain strings
  (suggestions) — treat as "not found". Render `fl` + first 1–3 `shortdef`
  strings; handle loading / not-found / network-error states. Parsed shape is
  `DefineResult` in [`protocol.ts`](../worker/src/protocol.ts).
- Leave this comment at the call site: `// COMMERCIAL NOTE: MW free tier is
  non-commercial (1,000 req/day). If this app ever gets ads or a paid tier, a
  commercial MW agreement is required.`

> **Note:** Define is implemented as a stateless HTTP `GET /define` Worker
> endpoint (following "browser calls our Worker, Worker calls MW"), **not** a WS
> message — the early `protocol.ts` sketch that listed a `define` WS message is
> superseded.

## Live game state lives in the Durable Object
- All board/rack/bag/score/turn state lives in DO storage. Authoritative
  `GameState` shape is in [`worker/src/protocol.ts`](../worker/src/protocol.ts).
- One DO per room, keyed by a short room code (6 chars). Worker routes
  `/room/:code/ws` → that DO.
- DO uses the **hibernatable WebSocket API** and persists to DO storage so rooms
  survive eviction. A single DO alarm is multiplexed by phase: `pending` =
  challenge window, `playing` = turn auto-skip, `gameover`/`lobby` = storage
  cleanup (`deleteAll()` once nobody's connected, preventing unbounded room-storage
  growth).

## Game engine — pure module, point at the code
[`worker/src/engine/`](../worker/src/engine/) is pure (no I/O, no Cloudflare
runtime imports) and fully unit-tested in Node/Vitest. The engine **never** judges
word validity — that's human-consensus via the challenge flow in the DO. Key
entry points (see the source, don't duplicate it here):
- `validatePlacement(board, placedTiles, rack, config)` → `{ ok }` / `{ ok:false,
  reason }` — single line, adjacency after first move, height ≤ 5, no
  same-letter-on-top, 1 tile/cell/turn, cannot overwrite an entire existing word.
- `extractWords(board, placedTiles)` → distinct horizontal + vertical runs of
  length ≥ 2 through newly placed/modified tiles, with per-tile heights.
- `scoreTurn` / `endgamePenalty` — see [scoring.md](scoring.md).

## WebSocket protocol — point at the code
[`worker/src/protocol.ts`](../worker/src/protocol.ts) is the source of truth for
wire messages: the `ClientMessage` and `ServerMessage` discriminated unions (and
the `GameState` / `PublicState` / `PendingMove` shapes the frontend reuses). Don't
maintain a separate hand-written message list here — read the unions.

Flow intent: client `submit_move` → server validates placement → `move_pending`
opens the popup → `challenge_word` / `acknowledge_move` / `vote_move` drive the
[challenge flow](challenge-flow.md) → `move_applied` or `move_rejected`. The
current player's in-progress tiles are broadcast live via `place_draft` →
`state.draft` (transient, not persisted). On connect/reconnect the DO sends a full
`state` snapshot.

## Naming
Everything — UI, Worker script, the Room DO, `wordstack:*` localStorage keys, the
repo, and the custom domain `wordstack.aryaadarshagautam.com` — uses the
**Wordstack** name. (The project was historically named `upwords`; that legacy
name has been retired across the codebase and infra.)
