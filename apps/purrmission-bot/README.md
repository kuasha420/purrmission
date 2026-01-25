# Purrmission Bot

> The Discord bot and HTTP API layer for the Purrmission system.

## Overview

This application runs as a Discord bot and an HTTP server simultaneously, providing:
- Credential sync API for the Pawthy CLI
- 2FA/TOTP code management
- Approval gate for protected resources

---

## Features

### 🔑 Credential Sync (Pawthy CLI Backend)

Provides the API for secure secret synchronization:
- Project and environment management
- Guardian-based access control
- Approval workflows for non-guardian access

### 🔐 2FA / TOTP Management

Manage shared and personal 2FA accounts directly from Discord.

| Command | Description |
|---------|-------------|
| `/purrmission 2fa add` | Add account via URI, secret, or QR |
| `/purrmission 2fa list` | View personal/shared accounts |
| `/purrmission 2fa get` | Get current TOTP code |
| `/purrmission 2fa update` | Update backup key (owner only) |

### 🛡️ Guardian Management

| Command | Description |
|---------|-------------|
| `/purrmission guardian add` | Add a guardian to a resource |
| `/purrmission guardian remove` | Remove a guardian |
| `/purrmission guardian list` | List resource guardians |

### 🔗 CLI Authentication

| Command | Description |
|---------|-------------|
| `/purrmission cli-login` | Approve CLI device flow login |

---

## Local Development

### Prerequisites

- Node.js v24.10.1
- PNPM (`corepack enable`)

### Quickstart

All commands below should be run from the **workspace root** (`/purrmission`):

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env with your Discord credentials

# 2. Generate Prisma Client (from workspace root)
pnpm prisma:generate

# 3. Run development server (from workspace root)
pnpm dev:purrmission

# 4. Deploy commands (if changed)
pnpm discord:deploy-commands
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | ✅ | Discord bot token |
| `DISCORD_CLIENT_ID` | ✅ | Discord application ID |
| `DISCORD_GUILD_ID` | ✅ | Guild for command deployment |
| `DATABASE_URL` | ✅ | SQLite/PostgreSQL connection |
| `ENCRYPTION_KEY` | ✅ | 32-byte hex for at-rest encryption |
| `APP_PORT` | | HTTP port (default: 3001) |
| `EXTERNAL_API_URL` | | Public API URL for CLI |

### Database

Uses Prisma with SQLite by default. From project root:

```bash
pnpm prisma:studio    # View data
pnpm prisma:deploy    # Apply migrations
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/auth/device/code` | POST | Initiate CLI device flow |
| `/api/auth/token` | POST | Exchange device code for token |
| `/api/projects` | GET/POST | Project management |
| `/api/projects/:id/environments` | GET/POST | Environment management |
| `/api/projects/:id/environments/:envId/secrets` | GET/PUT | Secret sync |
| `/api/requests` | POST | Create approval request |
| `/api/requests/:id` | GET | Check request status |

---

## Documentation

- [Main Project README](../../README.md)
- [Pawthy CLI](../pawthy/README.md)
- [2FA Guide](../../docs/purrmission-2fa.md)
- [Deployment Guide](../../DEPLOY.md)
