# Deploying Purrmission

## Prerequisites
- Node.js v24.10.1+
- PNPM (v9+) via Corepack
- PM2 installed globally on the server

## Setup
1. **Clone/Copy Project**: Ensure the project files are on the server (usually via CI/CD `deploy.yml`).
2. **Environment Variables**:
   - Create a `.env` file in the **project root directory** (where `package.json` is).
   - This file must contain `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `DATABASE_URL`.
   - *Note*: If `ecosystem.config.cjs` sets `cwd: "./"`, the `.env` must be in the root.

## Data Persistence
The deployment script **flushes** the directory on each deploy, **EXCEPT** for:
- `.env*` files
- `*.db` / `*.sqlite` / `*.sqlite3` files
- `data/` directory

**Recommendation**: Set your `DATABASE_URL` to point to a file in the project root (e.g., `file:./prod.db`) or a path outside the deployment directory. If using SQLite, `production.db` in the root is safe.

## Running in Production
You can use the provided script or PM2.

### Using Script
```bash
pnpm install
pnpm build
pnpm prod:purrmission
```

### Using PM2 (Recommended)
```bash
# Ensure deps are installed first
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:deploy
pm2 startOrRestart ecosystem.config.cjs
```

## Troubleshooting
- **`MODULE_NOT_FOUND` (dotenv)**: Ensure `dotenv` is installed in the root `node_modules`.
- **`Prisma Client` errors**: Run `pnpm prisma:generate`.
- **Deployment fails silently**: Check `pm2 logs Purrmission`.
