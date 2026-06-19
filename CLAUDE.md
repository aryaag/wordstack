# Wordstack — Claude Code Guide

**Wordstack** is a real-time multiplayer, Scrabble-like stacking word game: tiles
stack on top of each other to change words. 2–4 players share a room and take
turns; stack height determines scoring. Everything runs on Cloudflare.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite + TypeScript, served via Workers Assets |
| Worker | Cloudflare Workers — HTTP API + static asset serving |
| Game room | Cloudflare Durable Objects — one DO per room, authoritative state + WebSockets |
| CLI / deploy | Wrangler v3 |

All infrastructure is Cloudflare-only — no separate server, no Docker, no external DB.

## Project structure

```
wordstack/
├── frontend/              # React + Vite + TS (mobile-first UI)
│   ├── src/
│   └── vite.config.ts
├── worker/
│   ├── src/
│   │   ├── index.ts       # Worker: routing, /define MW proxy, static assets
│   │   ├── room.ts        # Durable Object: game state, WS fan-out, challenge/alarm logic
│   │   ├── define.ts      # MW fetch + parse (shared by Worker route + DO)
│   │   ├── protocol.ts    # Shared WS message + state types (source of truth)
│   │   └── engine/        # Pure game engine (no I/O, fully unit-tested) + config.ts
│   └── wrangler.toml
├── docs/                  # Deep reference (see below)
└── CLAUDE.md
```

## Documentation

This file stays lean. The deep reference lives in [`docs/`](docs/README.md):

- [docs/game-rules.md](docs/game-rules.md) — board, placing/stacking, tile bag, actions, illegal words, endgame, Qu, rack privacy
- [docs/scoring.md](docs/scoring.md) — flat vs stacked scoring, Qu & bingo bonuses, endgame penalty
- [docs/challenge-flow.md](docs/challenge-flow.md) — validation mode + two-stage human-consensus challenge/vote
- [docs/architecture.md](docs/architecture.md) — word-validity model, MW definitions (compliance), live state in the DO, engine + WS-protocol code pointers

**Where code is the source of truth, read the code — don't trust a prose copy:**
- [`worker/src/engine/`](worker/src/engine/) — rules; [`config.ts`](worker/src/engine/config.ts) — all tunable values.
- [`worker/src/protocol.ts`](worker/src/protocol.ts) — `ClientMessage` / `ServerMessage` unions + `GameState` shapes.
- [`worker/src/room.ts`](worker/src/room.ts) — authoritative state, WS fan-out, challenge resolution, DO alarms.

## Key commands

```bash
# local dev
npx wrangler dev -c worker/wrangler.toml              # worker + DO on http://localhost:8787
npx vite --config frontend/vite.config.ts             # frontend dev server

# tests
npx vitest run                                        # engine unit tests

# secrets / deploy
CLOUDFLARE_API_TOKEN=<your-cloudflare-api-token> \
  npx wrangler secret put MW_KEY -c worker/wrangler.toml                   # Merriam-Webster key
npx wrangler deploy -c worker/wrangler.toml                                # worker + assets
```

`wrangler` is **not** installed globally — always `npx wrangler`.

## Git conventions

- Branch names: `<type>/<short-slug>` — e.g. `feat/tile-scoring`, `fix/ws-reconnect`
- Commit format: `<type>: <what changed>` — e.g. `feat: add word validation endpoint`
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`
- PRs go against `main`; squash-merge preferred for small changes

## Key config (defaults; all tunable in [`config.ts`](worker/src/engine/config.ts))

| Setting | Value |
|---------|-------|
| Board / stack / rack / players | 10×10 / max 5 / 7 / 2–4 |
| Validation mode | `"challenge"` + `challengePenalty: false` |
| Challenge resolution | Human consensus (no dictionary arbiter); any "not valid" vote rejects the whole move |
| Challenge window | 30s auto-accept in the open stage; a challenge pauses the timer and opens the vote |
| First move | Length ≥ 2, must cover a center square |
| Endgame tile penalty | −5 pts per leftover tile, default on |
| Exchange | 1 tile only per turn |
| Q tile | Combined `Qu` (stored as `"qu"`) |
| Join | Non-empty name required (client + server); host leaving cancels the game |
| UI target | **Mobile-first** — design for small touch screens, scale up to desktop |

See [docs/game-rules.md](docs/game-rules.md) for full rules and the tile distribution.

## Gotchas

**Merriam-Webster compliance.** Never *persist* the MW response (no DO/KV/file/
log). A transient in-memory `defCache` in the DO (5-min TTL, lost on hibernation)
is the only permitted exception. Full rule + rationale in
[docs/architecture.md](docs/architecture.md).

**Wrangler.** `wrangler.toml` is safe to commit (no secrets); secrets go via
`wrangler secret put`. Verify current Cloudflare docs for DO WebSocket hibernation
and Workers Assets — wrangler syntax evolves.

**DO alarms, never `setTimeout`.** A single DO alarm is multiplexed by phase
(challenge window / turn auto-skip / storage cleanup); alarms survive hibernation.

## Cloudflare access

Pass your Cloudflare API token to wrangler/curl via the `CLOUDFLARE_API_TOKEN`
environment variable — never hard-code it.

## Build history (phases)

1. Scaffold · 2. Engine · 3. Durable Object room · 4. Frontend ·
5. Define/Challenge (MW proxy) · 6. Polish (reconnection, endgame, swap/pass,
edge cases, live deploy).

All phases are **complete and deployed** at
https://wordstack.aryaadarshagautam.com.
