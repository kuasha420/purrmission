---
trigger: always_on
---

# 📂 Project Structure

## Root
- `apps/`: Application packages.
  - `purrmission-bot/`: Main Discord bot and API.
- `prisma/`: Database schema and migrations.
- `scripts/`: Operational and maintenance scripts.
- `.agent/`: Agent configuration and rules.
- `docs/`: Project documentation.

## Key Files
- `apps/purrmission-bot/src/domain/`: Core business logic (Services, Repositories).
- `apps/purrmission-bot/src/http/`: Fastify API server.
- `apps/purrmission-bot/src/discord/`: Discord bot handlers.
- `prisma/schema.prisma`: Data model source of truth.

## Conventions
- **Monorepo**: TurboRepo handles build and dev orchestration.
- **Config**: Environment variables in `.env`.
- **Scripts**: `pnpm` commands in root `package.json` delegate to Turbo or specific scripts.
