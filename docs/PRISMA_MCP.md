# Prisma MCP Integration

## Local MCP server (SQLite – this repo)

You can run a local Prisma MCP server for this project so MCP-aware AI tools (Codex, ChatGPT, Claude, Cursor, etc.) can manage the database via natural language.

### CLI

From the repo root:

```bash
pnpm prisma mcp
```

This starts a local MCP server using the Prisma CLI version pinned in this repository. It will use the `DATABASE_URL` from your `.env` file by default.

**Important**: Ensure your `DATABASE_URL` is consistent across the root `.env`, `apps/purrmission-bot/.env`, and this MCP config to ensure all tools work on the same database file.

### Example MCP config (local)

See [`docs/mcp/prisma-local.json`](./mcp/prisma-local.json) for an example `mcpServers` entry that many MCP clients recognize. You can adapt it into your tool’s configuration.

```json
{
  "mcpServers": {
    "prisma-local": {
      "command": "pnpm",
      "args": ["prisma", "mcp"],
      "cwd": "/absolute/path/to/purrmission",
      "env": {
        "DATABASE_URL": "file:./data/dev.db"
      }
    }
  }
}
```

## Remote / Global Prisma MCP server (Prisma Postgres)

Prisma also offers a hosted MCP server that connects your AI tools to **Prisma Postgres** and the Prisma Console. This is ideal for “global” database management across projects and environments (not just this local SQLite file).

High-level flow:

1. Set up a Prisma Postgres project in the Prisma Console.
2. Configure the Prisma MCP server as described in the official docs.
3. Add an MCP configuration to your AI tool that points to a Prisma CLI version compatible with your project schema, for example `pnpm prisma mcp` inside this repo.

This repository includes a template at:

- [`docs/mcp/prisma-remote.json`](./mcp/prisma-remote.json)

Use this as a starting point and adjust values (project URL, API keys, etc.) according to Prisma’s MCP server documentation.

## Codex in this repo

This repository can generate a project-scoped Codex MCP configuration into `.codex/config.toml` via `pnpm mcp:sync`.

- It renders Prisma MCP directly into Codex's native `command` / `args` / `cwd` / `env` config format.
- `pnpm mcp:sync` reads the shared root `mcp.json`, optional `mcp.local.json`, and the repo-root `.env` before generating the local Codex config.
- It is additive to the existing MCP docs and templates in this repository; other clients can keep using the JSON-based configurations.
- `.codex/config.toml` is treated as a local generated artifact and is gitignored.
- `pnpm mcp:sync` also marks the repository as trusted in `~/.codex/config.toml` so Codex can load the generated project config automatically.
- No extra `codex mcp add` step is required for this repository unless you want personal overrides in your global `~/.codex/config.toml`.
