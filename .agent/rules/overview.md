---
trigger: model_decision
---

# Purrmission - Project Overview

> **Note**: This document provides a comprehensive overview of the Purrmission project for AI agents and developers.

## Project Description
**Purrmission** is a Discord-based multi-user approval gate system with an HTTP API. It manages TOTP (Time-based One-Time Password) authentication and approval workflows for access control.

## Key Technologies
- **Runtime**: Node.js (v24.10.1)
- **Language**: TypeScript (strict mode)
- **Module System**: ES Modules (`import`/`export`)
- **Package Manager**: PNPM (v9+)
- **Framework**: discord.js v14
- **Web Server**: Fastify
- **Validation**: Zod
- **Dev Tooling**: tsx for hot-reloading

## Architecture Overview

### Core Components
1. **Discord Bot**: Handles slash commands and user interactions
2. **HTTP API**: Fastify server for external integrations
3. **Repository Layer**: Pluggable in-memory data storage
4. **TOTP System**: Time-based one-time password generation and validation
5. **Approval Workflow**: Multi-guardian approval request system

### Directory Structure
```
purrmission/
├── apps/
│   └── purrmission-bot/    # Main Discord bot application
│       ├── src/
│       │   ├── commands/   # Discord slash commands
│       │   ├── domain/     # Core business logic
│       │   │   ├── models.ts        # Domain models
│       │   │   ├── repositories.ts  # Repository interfaces
│       │   │   └── totp.ts          # TOTP engine
│       │   ├── api/        # HTTP API routes
│       │   ├── config/     # Configuration
│       │   └── index.ts    # Entry point
│       ├── package.json
│       └── tsconfig.json
├── .agent/                 # Agent instructions
├── .yarn/                  # Yarn Berry files
├── package.json            # Root package
└── tsconfig.base.json      # Shared TypeScript config
```

## Development Setup

### Prerequisites
- Node.js v24.10.1 (see `.nvmrc`)
- Yarn Berry (enabled via Corepack)

### Environment Variables
Required:
- `DISCORD_TOKEN` - Discord bot token
- `DISCORD_CLIENT_ID` - Discord application ID
- `DISCORD_GUILD_ID` - Guild ID for testing

### Installation
```bash
corepack enable
pnpm install
# Create .env from .env.example and fill in values
pnpm dev
```

## Key Features
- TOTP account management (add, list, get, delete)
- Multi-user approval workflow
- Personal and shared TOTP accounts
- Discord slash command interface
- HTTP API for external integrations
- QR code support for TOTP setup
- In-memory data storage with pluggable repositories
