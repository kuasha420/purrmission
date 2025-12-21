# Deploying Purrmission

## Prerequisites
- Node.js v24.10.1+
- Yarn Berry (v4+)
- PM2 installed globally on the server

## Setup
1. **Clone/Copy Project**: Ensure the project files are on the server (usually via CI/CD `deploy.yml`).
2. **Environment Variables**:
   - Create a `.env` file in the **project root directory** (where `package.json` is).
   - This file must contain `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `DATABASE_URL`.
   - *Note*: If `ecosystem.config.cjs` sets `cwd: "./"`, the `.env` must be in the root.

## Running in Production
You can use the provided script or PM2.

### Using Script
```bash
yarn prod:purrmission
```

### Using PM2 (Recommended)
```bash
pm2 startOrRestart ecosystem.config.cjs
```

## Troubleshooting
- **`MODULE_NOT_FOUND` (dotenv)**: Ensure `dotenv` is installed in the root `node_modules` (`yarn add dotenv` in root). Ensure your `.env` file exists in the root.
