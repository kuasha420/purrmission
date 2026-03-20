# Scripts Guide

Use these rules when you are working inside `scripts/`.

## MCP wiring

- `mcp.json` is the shared MCP source of truth for this repository.
- `scripts/sync-mcp.cjs` syncs the same definitions into Claude Desktop, VS Code, Antigravity-style configs, and the local Codex `.codex/config.toml`.
- The generated Codex config follows the native `codex mcp add` shape: direct `command`, `args`, optional `cwd`, and optional `[mcp_servers.<name>.env]`.
- `scripts/sync-mcp.cjs` also ensures the current repo is marked trusted in `~/.codex/config.toml` so Codex can load the generated project config without a manual trust step.
- Keep committed configs secret-free. Read tokens and database URLs from `.env`, `process.env`, or local overrides instead of hardcoding them.
- `.codex/` and `mcp.local.json` are per-developer local artifacts and should never be committed.

## Ops scripts

- TypeScript ops scripts build into `dist-scripts/` via `pnpm build:scripts`.
- Use `pnpm dev:ops:test` when changing backup, key rotation, or env validation flows.

## Review tooling

- Prefer `scripts/gh-pr-review-comments.cjs`; the shell script is only a thin wrapper.
- Any exported review comment files should live outside the git worktree.
