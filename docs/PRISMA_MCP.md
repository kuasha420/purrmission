# Prisma MCP Integration

## Local MCP server (SQLite – this repo)

You can run a local Prisma MCP server for this project so MCP-aware AI tools (ChatGPT, Claude, Cursor, etc.) can manage the database via natural language.

### CLI

From the repo root:

```bash
yarn dlx prisma mcp
```

This starts a local MCP server using the Prisma CLI. It will use the `DATABASE_URL` from your `.env` file by default.

**Important**: Ensure your `DATABASE_URL` is consistent across the root `.env`, `apps/purrmission-bot/.env`, and this MCP config to ensuring all tools work on the same database file.

### Example MCP config (local)

See [`docs/mcp/prisma-local.json`](./mcp/prisma-local.json) for an example `mcpServers` entry that many MCP clients recognize. You can adapt it into your tool’s configuration.

```json
{
  "mcpServers": {
    "prisma-local": {
      "command": "yarn",
      "args": ["dlx", "prisma", "mcp"],
      "env": {
        "DATABASE_URL": "file:./prisma/purrmission.db"
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
3. Add an MCP configuration to your AI tool that points to `npx prisma mcp` (or `yarn dlx prisma mcp`) with the appropriate environment variables.

This repository includes a template at:

- [`docs/mcp/prisma-remote.json`](./mcp/prisma-remote.json)

Use this as a starting point and adjust values (project URL, API keys, etc.) according to Prisma’s MCP server documentation.
