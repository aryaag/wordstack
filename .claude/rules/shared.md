# Shared project guidance

This is a hobby Cloudflare-based app for a stacking word game. The stack is:
- **Frontend**: static site served via Workers Assets
- **Backend**: Cloudflare Workers (API)
- **Game rooms**: Cloudflare Durable Objects (one per room)

All infra is managed via `wrangler`. See `wrangler.toml` for project config. Before running wrangler commands, ensure you're logged in (`wrangler whoami`).

When in doubt about a project-specific convention or decision, check `CLAUDE.md` before guessing.
