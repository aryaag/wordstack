# Shared project guidance

This is a hobby Cloudflare-based app for the word game Upwords. The stack is:
- **Frontend**: Cloudflare Pages (static site)
- **Backend**: Cloudflare Workers (API)
- **Database**: Cloudflare D1 (SQLite-compatible)

All infra is managed via `wrangler`. See `wrangler.toml` for project config. Before running wrangler commands, ensure you're logged in (`wrangler whoami`).

When in doubt about a project-specific convention or decision, check `CLAUDE.md` before guessing.
