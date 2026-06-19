# Upwords Online

Real-time multiplayer web implementation of **Upwords** — the word game where you stack tiles on top of each other to change words and score points. 2–4 players per room, everything runs on Cloudflare.

## Stack

- **Frontend** — React + Vite + TypeScript, served via Workers Assets
- **Worker** — Cloudflare Workers (HTTP API, MW definition proxy)
- **Game rooms** — Cloudflare Durable Objects (one DO per room: authoritative state + WebSocket fan-out)

## Quick start

```bash
# prerequisites
npm install -g wrangler
wrangler login

# local dev
wrangler dev                 # worker + DO on http://localhost:8787
npx vite --config frontend/vite.config.ts   # frontend dev server

# secrets (one-time)
wrangler secret put MW_KEY   # your Merriam-Webster Collegiate API key
```

## Deployment

```bash
wrangler deploy              # deploy worker + assets
```

## About Upwords

Upwords is played on a 10×10 grid. Unlike Scrabble, you can stack letter tiles on top of existing tiles to form new words — scoring is based on tile height rather than letter values. If all tiles in a word are flat (height 1), you score 2 points per letter. If any tile is stacked, you score 1 point per height unit per tile.

## Project status

Working through the build phases — see `CLAUDE.md` for architecture decisions, game rules, and the phase plan.
