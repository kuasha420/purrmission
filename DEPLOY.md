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

The deployment workflow **aggressively flushes** the target directory on each deploy to guarantee stateless code delivery. However, persistent state is explicitly carved out and preserved.

### Preserved Files and Directories

The following are **never deleted** during deployment:

| Pattern | Description |
|---------|-------------|
| `.env*` | Environment files (`.env`, `.env.local`, etc.) |
| `*.db` | SQLite database files |
| `*.sqlite` | SQLite database files |
| `*.sqlite3` | SQLite database files |
| `*.db-*` | SQLite WAL mode sidecars (`-wal`, `-shm`) |
| `*.sqlite-*` | SQLite WAL mode sidecars |
| `*.sqlite3-*` | SQLite WAL mode sidecars |
| `data/` | Persistent data directory (recursive) |

### Recommended Database Location

Store your SQLite database in the `data/` directory:

```env
DATABASE_URL="file:./data/prod.db"
```

This provides a clear separation between code artifacts (which get flushed) and persistent state (which survives).

> [!WARNING]
> **Never store databases in build artifacts** like `dist/`, `.next/`, `apps/*/dist/`, or `node_modules/`. These directories are completely replaced on each deploy.

### External Databases

If using PostgreSQL, MySQL, or other external databases, persistence is handled by the database server itself. The `DATABASE_URL` will point to the external service, so deployment flushes have no effect on your data.

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
