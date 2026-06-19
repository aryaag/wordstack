# Wordstack docs

Deep reference for the Wordstack game. `CLAUDE.md` at
the repo root stays lean — stack, structure, commands, conventions, gotchas — and
links here for the detail.

| Doc | Covers |
|-----|--------|
| [game-rules.md](game-rules.md) | Board, setup, placing/stacking rules, tile bag, actions, illegal words, endgame, Qu representation, rack privacy |
| [scoring.md](scoring.md) | Flat vs stacked scoring, Qu & bingo bonuses, endgame tile penalty |
| [challenge-flow.md](challenge-flow.md) | Validation mode + the two-stage human-consensus challenge/vote flow |
| [architecture.md](architecture.md) | Word-validity model, Merriam-Webster definitions (compliance), live state in the DO, engine + WS-protocol pointers to code |

**Source-of-truth code** (describe intent in docs, don't duplicate these):
- Engine: [`worker/src/engine/`](../worker/src/engine/) — pure, unit-tested rules.
- Engine config (all tunable values): [`worker/src/engine/config.ts`](../worker/src/engine/config.ts).
- WS + state types: [`worker/src/protocol.ts`](../worker/src/protocol.ts).
- Room (authoritative state, WS fan-out, challenge/alarm logic): [`worker/src/room.ts`](../worker/src/room.ts).
