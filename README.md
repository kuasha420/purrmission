![Purrmission Banner](assets/banner.png)

# 🐱 Purrmission <img src="assets/logo-square.png" align="right" width="120" />

> **Discord-based multi-user approval gate** – An "Authy-clone" for shared accounts (e.g., `shared-account@example.com`), with an HTTP API for external services to request approvals.

## Overview

Purrmission provides a centralized approval workflow where:

1. **External services** send approval requests via HTTP API
2. **Guardians** (trusted users) receive approval requests in Discord
3. **Approvals/Denials** are recorded and optionally reported back via callback URL

### Architecture

```
┌─────────────────┐     HTTP POST      ┌──────────────────────┐
│ External Service│ ─────────────────► │   Purrmission Bot    │
└─────────────────┘  /api/requests     │  (Discord + Fastify) │
                                       └──────────┬───────────┘
                                                  │
                                                  │ Discord Message
                                                  ▼
                                       ┌──────────────────────┐
                                       │   Discord Guardians  │
                                       │   [Approve] [Deny]   │
                                       └──────────────────────┘
```

### Key Concepts

- **Resource**: A protected account or service requiring approval (e.g., a shared email)
- **Guardian**: A Discord user who can approve/deny requests for a resource
- **Approval Request**: A pending request from an external service

## Setup

### Prerequisites

- Node.js v24.10.1 (use `nvm use` if you have nvm)
- Corepack enabled (`corepack enable`)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))

### Installation

```bash
# 1. Use the correct Node version
nvm use 24.10.1

# 2. Enable Corepack for Yarn
corepack enable

# 3. Install dependencies
yarn install

# 4. Configure environment
cp apps/purrmission-bot/.env.example apps/purrmission-bot/.env
# Edit .env with your Discord credentials

# 5. Deploy Discord slash commands
yarn discord:deploy-commands

# 6. Start the bot
yarn dev:purrmission
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token |
| `DISCORD_CLIENT_ID` | Your Discord application client ID |
| `DISCORD_GUILD_ID` | Guild ID for development (commands deploy here) |
| `APP_PORT` | HTTP server port (default: 3000) |

## Usage

### 1. Register a Resource

Use the Discord slash command:

```
/purrmission-register-resource name:My Shared Account
```

This will:
- Create a new protected resource
- Generate an API key (save this!)
- Set you as the owner/guardian

### 2. Add Guardians

```
/purrmission-add-guardian resource-id:<resource-id> user:@someone
```

### 3. Request Approval (External Service)

Send an HTTP POST request to create an approval request:

```bash
curl -X POST http://localhost:3000/api/requests \
  -H "Content-Type: application/json" \
  -d '{
    "resourceId": "YOUR_RESOURCE_ID",
    "apiKey": "YOUR_API_KEY",
    "context": {
      "action": "login",
      "ip": "192.168.1.1",
      "from": "web-app"
    },
    "callbackUrl": "https://your-service.com/webhook/approval"
  }'
```

Response:
```json
{
  "requestId": "abc123-...",
  "status": "PENDING",
  "resourceId": "def456-...",
  "resourceName": "My Shared Account"
}
```

### 4. Check Request Status

```bash
curl http://localhost:3000/api/requests/{requestId}
```

### 5. Health Check

```bash
curl http://localhost:3000/health
```

## Development

### Project Structure

```
purrmission/
├── apps/
│   └── purrmission-bot/
│       ├── src/
│       │   ├── index.ts              # Entry point
│       │   ├── config/env.ts         # Environment config
│       │   ├── logging/logger.ts     # Logger utility
│       │   ├── domain/
│       │   │   ├── models.ts         # Type definitions
│       │   │   ├── repositories.ts   # Data access layer
│       │   │   └── services.ts       # Business logic
│       │   ├── discord/
│       │   │   ├── client.ts         # Discord.js client
│       │   │   ├── commands/         # Slash commands
│       │   │   └── interactions/     # Button handlers
│       │   └── http/
│       │       └── server.ts         # Fastify HTTP API
│       ├── package.json
│       └── tsconfig.json
├── package.json                      # Workspace root
├── tsconfig.base.json               # Shared TS config
└── README.md
```

### Scripts

| Command | Description |
|---------|-------------|
| `yarn dev:purrmission` | Start bot in development mode |
| `yarn build` | Build TypeScript to JavaScript |
| `yarn lint` | Run ESLint |
| `yarn format` | Format code with Prettier |
| `yarn discord:deploy-commands` | Register slash commands with Discord |

## MVP Limitations

This is a scaffold/MVP with the following limitations:

- **In-memory storage**: All data is lost on restart. TODO: Add Postgres/Prisma.
- **No authentication for owner operations**: Anyone can add guardians. TODO: Enforce owner-only.
- **No callback implementation**: Callback URLs are logged but not called. TODO: Implement HTTP callbacks.
- **Single channel/DM**: Messages go to guardian DMs. TODO: Configurable notification channels.

## License

MIT

---

Built with 🐱 by the Purrmission team
