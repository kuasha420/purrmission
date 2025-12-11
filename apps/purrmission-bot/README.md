# Purrmission Bot

> The Discord bot and HTTP API layer for the Purrmission system.

## Features

This application runs as a Discord bot and an HTTP server simultaneously.

### 🔐 2FA / TOTP Management (`/purrmission 2fa`)

Manage shared and personal 2FA accounts directly from Discord.

- **Add Accounts**:
    - `mode:uri`: Paste an `otpauth://` URI.
    - `mode:secret`: Paste a raw Base32 secret.
    - `mode:qr`: (Stub) Support for QR code images planned.
- **List**:
    - View personal accounts.
    - Option: `shared:True` to see accounts shared with the team.
- **Get Code**:
    - `/purrmission 2fa get`: Autocomplete search for accounts.
    - Delivers code via ephemeral DM.
    - Rate-limited to prevent abuse (1 request / 10s).
- **Update**:
    - `/purrmission 2fa update`: Attach a backup key/recovery code to an account (Owner only).

### 🛡️ Approval Gate

- **Register Resources**: Define what needs protection (`/purrmission-register-resource`).
- **Add Guardians**: Appoint users who can approve requests (`/purrmission-add-guardian`).
- **API**: External apps engage the gate via HTTP POST.

## Local Development

### Prerequisites

- Node.js v24.10.1
- Yarn (Berry)

### Quickstart

1. **Configure Environment**:
     ```bash
     cp .env.example .env
     ```
     Edit `.env` with your Discord credentials (`DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`).

2. **Run Development Server**:
     ```bash
     yarn dev
     ```
     Or from root: `yarn dev:purrmission`

3. **Deploy Commands**:
     If you added or changed commands:
     ```bash
     yarn discord:deploy-commands
     ```

### Database

This app uses the root `prisma/purrmission.db` SQLite database.
You can view data with `yarn prisma:studio` from the project root.

## Documentation

- [Project README](../../README.md)
- [2FA / TOTP Guide](../../docs/purrmission-2fa.md)
