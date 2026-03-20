# Purrmission Bot Guide

Use these rules when you are working inside `apps/purrmission-bot`.

## Structure

- `src/index.ts`: application bootstrap.
- `src/config/env.ts`: environment loading and validation.
- `src/domain/`: business logic, models, services, repositories.
- `src/discord/commands/`: slash command implementations.
- `src/http/server.ts`: Fastify server wiring.
- `src/infra/`: Prisma client, crypto, rate limiting, infrastructure helpers.

## Local rules

- Keep business rules in `src/domain/`; do not move them into command handlers or HTTP routes.
- Route all persistence through the repository layer.
- Prefer the shared logger in `src/logging/logger.ts` over direct console calls.
- If you touch encrypted fields or TOTP secrets, keep `ENCRYPTION_KEY` handling intact and validate failure paths.
- Some legacy `.agent` docs still mention `src/commands/` and `src/api/`; the current paths are `src/discord/commands/` and `src/http/`.

## Schema and API changes

- `prisma/schema.prisma` is the persistence source of truth.
- If schema changes are required, update Prisma schema, run migrations, regenerate the client, and update repository/service code together.
- After changing slash command definitions, run `pnpm discord:deploy-commands`.

## Verification

- `pnpm --filter @purrfecthq/purrmission-bot test`
- `pnpm lint`
