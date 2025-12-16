# Deployment Guide

This guide explains how to deploy the Purrmission bot using GitHub Actions and PM2.

## Prerequisites

The target server must have the following installed:

1.  **Node.js**: Version 24.10.1 or higher (as specified in `.nvmrc`).
    -   **Important**: If using `nvm` to manage Node.js, ensure it's properly configured in your shell's `.bashrc` or `.bash_profile`.
2.  **Yarn**: Package manager (via Corepack). To enable manually:
    ```bash
    corepack enable
    ```
3.  **PM2**: Process manager for Node.js. Install globally:
    ```bash
    yarn global add pm2
    ```
4.  **Git**: For cloning repository (if needed).

## Server Setup

1.  Ensure you can SSH into the server.
2.  Create a directory for the bot (e.g., `/home/user/purrmission-bot`).
3.  Ensure the user has write permissions to this directory.
4.  Create a `.env` file in the deployment directory with required environment variables.

## GitHub Secrets

Configure the following secrets in your GitHub repository settings (Settings > Secrets and variables > Actions):

| Secret Name | Description |
| :--- | :--- |
| `DISCORD_TOKEN` | The Discord bot token for production command deployment. |
| `DISCORD_CLIENT_ID` | The Discord application client ID for production command deployment. |
| `SSH_HOST` | The IP address or hostname of your server. |
| `SSH_USERNAME` | The SSH username. |
| `SSH_KEY` | The SSH private key (contents of your `.pem` or `id_rsa` file). |
| `SSH_PORT` | (Optional) The SSH port. Defaults to `22`. |
| `SSH_TARGET` | The absolute path to the deployment directory on the server (e.g., `/home/user/purrmission-bot`). |

### SSH Key Setup (Quick Reference)

Generate a dedicated deployment key:

```bash
# Generate Ed25519 key (recommended)
ssh-keygen -t ed25519 -C "purrmission-deploy" -f ~/.ssh/purrmission_deploy

# Or RSA if Ed25519 is unsupported
ssh-keygen -t rsa -b 4096 -C "purrmission-deploy" -f ~/.ssh/purrmission_deploy
```

Copy public key to server:

```bash
ssh-copy-id -i ~/.ssh/purrmission_deploy.pub user@your-server
```

Add the **private key** contents to GitHub Secrets as `SSH_KEY`:

```bash
cat ~/.ssh/purrmission_deploy
```

> [!TIP]
> Use a passphrase-less key for automation, or configure ssh-agent if needed.

## Configuration Files

### ecosystem.config.cjs

This file configures PM2 to manage the bot process. It uses the `.cjs` extension because the project uses ES modules (`"type": "module"` in package.json), but PM2 requires CommonJS format.

-   **Name**: `Purrmission`
-   **Script**: `./apps/purrmission-bot/dist/index.js` (The compiled entry point)
-   **Environment**: Production mode

## Deployment Process

The deployment is handled automatically by GitHub Actions when you push to the `deploy` branch.

1.  **Build**: 
    -   The workflow installs dependencies with Yarn Berry
    -   Runs `yarn build` to compile TypeScript
    -   Generates SHA256 checksums for:
        -   All files in `apps/purrmission-bot/dist/` (compiled bot code)
        -   Top-level config files (`package.json`, `yarn.lock`, `.yarnrc.yml`, `ecosystem.config.cjs`)
2.  **Upload**: The compiled `apps` folder, configuration files, and checksums are uploaded as an artifact.
3.  **Deploy**:
    -   The artifact is downloaded and its integrity is verified using the checksums.
    -   The existing bot process is stopped via PM2 (if running).
    -   Old files are cleaned from the deployment directory.
    -   Files are copied to the server via SCP.
    -   The integrity of the copied files on the server is verified again.
    -   `yarn install --immutable` is run on the server to install production dependencies.
    -   `pm2 startOrRestart ecosystem.config.cjs` is executed to start or reload the bot.
    -   **Note**: Discord slash commands are deployed during the build phase, not on the server.

### Important Notes

-   **nvm Support**: The deployment scripts automatically source nvm if it's installed, ensuring node/yarn/pm2 are available.
-   **Checksums**: SHA256 verification ensures deployment integrity at multiple stages.
-   **Yarn Berry**: The project uses Yarn Berry (v4+). Ensure corepack is enabled on the server.

## Troubleshooting

### Node Version Mismatch
If you encounter errors related to native modules, ensure that the Node.js version used to run the bot matches the version used to build dependencies.
- Recommended Node Version: **v24.10.1** (as specified in `.nvmrc`)
- To rebuild dependencies: `yarn rebuild`

### Command Registration Issues
- Ensure `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` are set in GitHub Secrets
- Commands are deployed during the GitHub Actions build phase
- Check the Actions log for command deployment errors

### PM2 Issues
- **Restart**: `pm2 restart Purrmission`
- **Stop**: `pm2 stop Purrmission`
- **Status**: `pm2 status`
- **Logs**: `pm2 logs Purrmission`

## Manual Deployment

If you need to deploy manually:

1. SSH into the server
2. Navigate to the deployment directory
3. Pull the latest changes: `git pull origin deploy`
4. Install dependencies: `yarn install --immutable`
5. Build: `yarn build`
6. Deploy commands: `yarn workspace purrmission-bot run deploy:commands`
7. Restart PM2: `pm2 restart Purrmission`

## Environment Variables

Ensure the following environment variables are set in `.env` on the server:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_guild_id  # For testing
PORT=3000  # Optional, for HTTP API
NODE_ENV=production
```

See `.env.example` for a complete list of available environment variables.

## High Level Verification

> [!WARNING]
> **Critical Missing Artifact**: The current `deploy.yml` does **not** upload the `prisma/` directory. 
> This means `npx prisma migrate deploy` will **FAIL** on the server because `schema.prisma` is missing.
> 
> **Workaround**: You must manually copy the `prisma/` directory to the server or update `deploy.yml`.

### Database Persistence
If using SQLite, ensure `DATABASE_URL` points to a persistent location (e.g., `/home/user/purrmission_data/dev.db`) rather than inside the deployment folder, as cleanup scripts may delete it.

## Checklist

Refer to [Deployment Checklist](docs/deployment-checklist.md) for a comprehensive step-by-step verified procedure.
