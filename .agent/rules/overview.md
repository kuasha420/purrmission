---
trigger: model_decision
---

# 📖 Project Overview & Architecture

This document provides a cohesive reference for Purrmission's technologies, project directory structure, core architectures, and development roadmap.

## 🛠️ Technology Stack

- **Runtime**: Node.js v24.10.1 (ES Modules enabled).
- **Package Manager**: pnpm (configured with monorepo workspaces).
- **Discord Bot**: `discord.js` v14 for slash commands and interactions.
- **API Server**: Fastify (`apps/purrmission-bot/src/http/server.ts`).
- **ORM & Database**: Prisma ORM with SQLite (supports migration to PostgreSQL).
- **2FA & Validation**: TOTP engine via `otplib`, and runtime input verification via Zod.
- **Dev Tooling**: Turborepo, `tsx` for hot-reloading, `tsx --test` native runner.

## 🗺️ Workspace Structure Map

```
purrmission/
├── apps/
│   ├── purrmission-bot/       # Main Discord bot & Fastify API server
│   │   ├── src/
│   │   │   ├── commands/      # Slash command handlers
│   │   │   ├── domain/        # Core logic: models, repositories, and services
│   │   │   ├── http/          # Fastify server router & endpoints
│   │   │   └── logging/       # Shared logger instance
│   └── pawthy/                # Pawthy CLI for credential sync
├── prisma/                    # Schema definition & SQLite migrations
├── scripts/                   # Operational and PR review scripts
```

## 🏗️ Architecture Details

### 1. TOTP & Secret Encryption

- **TOTP Engine** (`totp.ts`): Parses OTPauth URIs, sanitizes secrets, and generates/validates codes using `otplib`.
- **Secret Encryption**: Sensitive credentials (e.g. `secret` in `TOTPAccount` and `value` in `ResourceField`) are encrypted at rest using AES-256-GCM.
- **Repository**: `PrismaTOTPRepository` handles SQLite storage.

### 2. Approval Request System

- **Models**:
  - **Resource**: Gated credentials or actions requiring authorization.
  - **Guardian**: Users who vote on requests (`OWNER` or `GUARDIAN`).
  - **ApprovalRequest**: Tracks approval status (`PENDING`, `APPROVED`, `DENIED`, `EXPIRED`).
- **Modes**: Supports approval modes like `REQUIRE_ALL` or `REQUIRE_ANY`.

### 3. Projects & Environments Scoping

- **Project**: Represents a security workspace owned by a Discord user.
- **ProjectMember**: Tracks access roles (`READER`, `WRITER`) for team members.
- **Environment**: Scopes credentials/resources to specific deployment targets (e.g., dev, prod) via slug mappings.

### 4. Device Flow & API Auth

- **AuthSession**: Manages device code authentication sessions (`deviceCode`, `userCode`, status checking).
- **ApiToken**: Long-lived access tokens associated with Discord users, hashed at rest, with mandatory expiration.
- **Fastify API Server**: Enforces Bearer token validation matching active `ApiToken` records.

---

## 🗺️ Roadmap & Priorities

- [x] Prisma SQLite DB schema and migrations.
- [x] Secret encryption (AES-256-GCM) at rest.
- [x] TOTP generator, validator, and rate limiting.
- [x] Discord command registration and base flow.
- [x] Native test suite (`node:test`) integration.
- [ ] Complete HTTP API endpoints implementation.
- [ ] Finalize remaining guardian and project-management slash commands.
- [ ] Add deployment automation (CI/CD) and integration test suites.
