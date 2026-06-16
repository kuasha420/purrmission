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

| Command       | Description                        |
| ------------- | ---------------------------------- |
| `/2fa add`    | Add account via URI, secret, or QR |
| `/2fa list`   | View personal/shared accounts      |
| `/2fa get`    | Get current TOTP code              |
| `/2fa update` | Update backup key (owner only)     |

### 📦 Resource Management

| Command                   | Description                          |
| ------------------------- | ------------------------------------ |
| `/resource register`      | Register a protected resource        |
| `/resource list`          | View resources you own or guard      |
| `/resource fields add`    | Add an encrypted field to a resource |
| `/resource fields list`   | List fields on a resource            |
| `/resource fields get`    | Retrieve a field value               |
| `/resource fields remove` | Remove a field from a resource       |
| `/resource 2fa link`      | Attach a 2FA account to a resource   |
| `/resource 2fa unlink`    | Remove a linked 2FA account          |
| `/resource 2fa get`       | Retrieve the linked 2FA code         |

### 🛡️ Guardian Management

| Command            | Description                  |
| ------------------ | ---------------------------- |
| `/guardian add`    | Add a guardian to a resource |
| `/guardian remove` | Remove a guardian            |
| `/guardian list`   | List resource guardians      |

### ✅ Access Requests

| Command           | Description                            |
| ----------------- | -------------------------------------- |
| `/access request` | Request access to a protected resource |
| `/access approve` | Approve a pending request              |
| `/access deny`    | Deny a pending request                 |

### 🔗 CLI Authentication

| Command       | Description                   |
| ------------- | ----------------------------- |
| `/auth login` | Approve CLI device flow login |

### 👥 Project Membership

| Command                  | Description               |
| ------------------------ | ------------------------- |
| `/project member add`    | Add a member to a project |
| `/project member remove` | Remove a project member   |
| `/project member list`   | List project members      |

---

## Local Development

### Prerequisites

- Node.js v24.10.1
- PNPM (`corepack enable`)

### Quickstart

All commands below should be run from the workspace root:

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

| Variable            | Required | Description                        |
| ------------------- | -------- | ---------------------------------- |
| `DISCORD_BOT_TOKEN` | ✅       | Discord bot token                  |
| `DISCORD_CLIENT_ID` | ✅       | Discord application ID             |
| `DISCORD_GUILD_ID`  | ✅       | Guild for command deployment       |
| `DATABASE_URL`      | ✅       | SQLite/PostgreSQL connection       |
| `ENCRYPTION_KEY`    | ✅       | 32-byte hex for at-rest encryption |
| `APP_PORT`          |          | HTTP port (default: 3001)          |
| `EXTERNAL_API_URL`  |          | Public API URL for CLI             |

### Database

Uses Prisma with SQLite by default. From project root:

```bash
pnpm prisma:studio    # View data
pnpm prisma:deploy    # Apply migrations
```

---

## API Endpoints

| Endpoint                                        | Method   | Description                    |
| ----------------------------------------------- | -------- | ------------------------------ |
| `/health`                                       | GET      | Health check                   |
| `/api/auth/device/code`                         | POST     | Initiate CLI device flow       |
| `/api/auth/token`                               | POST     | Exchange device code for token |
| `/api/projects`                                 | GET/POST | Project management             |
| `/api/projects/:id/environments`                | GET/POST | Environment management         |
| `/api/projects/:id/environments/:envId/secrets` | GET/PUT  | Secret sync                    |
| `/api/requests`                                 | POST     | Create approval request        |
| `/api/requests/:id`                             | GET      | Check request status           |

---

## Documentation

- [Main Project README](../../README.md)
- [Pawthy CLI](../pawthy/README.md)
- [2FA Guide](../../docs/purrmission-2fa.md)
- [Deployment Guide](../../DEPLOY.md)
