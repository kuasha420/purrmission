# Purrmission Codex Guide

This file adds a Codex-native entrypoint for the repository. The older `.agent/rules/*.md` files remain in place for the Antigravity-era workflow and are still useful reference material. Prefer the current source tree if any older note has drifted.

## What lives here

- `apps/purrmission-bot`: the Discord bot and Fastify API.
- `apps/pawthy`: the Pawthy CLI for credential sync.
- `prisma/schema.prisma`: source of truth for persisted models.
- `scripts/`: operational scripts, review tooling, and MCP helpers.

## Core commands

- `nvm use`
- `corepack enable`
- `pnpm install`
- `pnpm dev`
- `pnpm build`
- `pnpm lint`
- `pnpm format`
- `pnpm test`
- `pnpm prisma:generate`
- `pnpm prisma:deploy`
- `pnpm prisma:studio`
- `pnpm discord:deploy-commands`

## Working agreements

- Use `pnpm` and the Node version from `.nvmrc`.
- This repo uses TypeScript strict mode and ES modules. Keep `.js` file extensions in TypeScript imports.
- Avoid `any` unless there is a short, explicit justification.
- Prefer the existing layering:
  - domain logic in `apps/purrmission-bot/src/domain`
  - Discord handlers in `apps/purrmission-bot/src/discord`
  - HTTP handlers in `apps/purrmission-bot/src/http`
  - Prisma-backed persistence in `apps/purrmission-bot/src/domain/repositories.ts`
- Use Zod for input validation and the shared logger in the bot app instead of ad-hoc `console.log`.
- Do not add new npm dependencies without user approval.
- Update README/docs when behavior or workflows change.

## Environment and secrets

- The repo-root `.env` is the canonical local environment file.
- `apps/purrmission-bot/src/config/env.ts` will search upward for the root `.env` during development.
- Keep database files under a `data/` directory when using SQLite.
- `.pawthyrc` is meant to be committed.
- `.pawthy/`, `.codex/`, and `mcp.local.json` are local-only and must stay uncommitted.

## Testing and review

- `pnpm test` runs the app tests plus the ops test suite.
- For targeted runs:
  - `pnpm --filter @purrfecthq/purrmission-bot test`
  - `pnpm --filter @psl-oss/pawthy test`
  - `pnpm dev:ops:test`
- When the user asks to address PR review feedback, use `node scripts/gh-pr-review-comments.cjs` and write exported feedback files outside the repo.

## Codex and MCP

- Codex project instructions are layered from this file and any nested `AGENTS.md` files.
- Project-scoped Codex MCP config is generated into `.codex/config.toml` by `pnpm mcp:sync`.
- `pnpm mcp:sync` also keeps the repo trusted in `~/.codex/config.toml` so Codex is allowed to load the generated project config.
- `pnpm mcp:sync` resolves `mcp.json`, optional `mcp.local.json`, and the repo-root `.env` into Codex's native `command` / `args` / `cwd` / `env` config format.
- `scripts/sync-mcp.cjs` remains the sync path for Claude Desktop, VS Code, and Antigravity-style configs.
