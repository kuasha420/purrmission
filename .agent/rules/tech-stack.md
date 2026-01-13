# 🛠️ Tech Stack & Workflow

## Core Stack
- **Runtime**: Node.js v24.10.1
- **Language**: TypeScript (Strict Mode)
- **Frameworks**: 
    - **Discord Bot**: discord.js v14
    - **API**: Fastify
- **Database**: SQLite (via Prisma ORM)
- **Validation**: Zod
- **Auth**:
    - **Discord**: OAuth2 / Bot Token
    - **API**: Bearer Token (Device Flow)
    - **2FA**: TOTP (otplib)

## Key Workflows
- **Package Management**: `pnpm`
- **Monorepo**: TurboRepo
- **Dev**:
    - `pnpm dev`: Start bot and API in watch mode
    - `pnpm prisma studio`: View database
- **Database**:
    - `pnpm prisma migrate dev`: Create/Apply migrations
    - `pnpm prisma generate`: Update Prisma Client
- **Testing**:
    - `pnpm test`: Run all tests (node:test)
    - `node --import tsx --test <file>`: Run specific test

## Critical Patterns
- **Repository Pattern**: All database access MUST go through repositories in `src/domain/repositories.ts`.
- **Dependency Injection**: Services are injected via the `Services` container.
- **Configuration**: Environment variables validated in `config/env.ts` (to be implemented) or checked at startup.
- **Logging**: Use the central logger, not `console.log`.
