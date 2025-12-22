# Deploying Purrmission

## Prerequisites
- Node.js v24.10.1+
- PNPM (v9+) via Corepack
- PM2 installed globally on the server

## Setup
1. **Clone/Copy Project**: Ensure the project files are on the server (usually via CI/CD `deploy.yml`).
2. **Environment Variables**:
   - Create a `.env` file in the **project root directory** (where `package.json` is).
   - This file must contain:
     - `DISCORD_BOT_TOKEN` - Your Discord bot token
     - `DISCORD_CLIENT_ID` - Your Discord application client ID
     - `DISCORD_GUILD_ID` - Guild ID for development (commands deploy here)
     - `DATABASE_URL` - Database connection URL (e.g., `file:./data/prod.db`)
     - `ENCRYPTION_KEY` - **Required** - 32-byte hex string (64 hexadecimal characters) for encrypting TOTP secrets and resource fields at rest
   - Generate an encryption key with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - *Note*: If `ecosystem.config.cjs` sets `cwd: "./"`, the `.env` must be in the root.
   - **Security**: Keep your `ENCRYPTION_KEY` secure and backed up. Without it, encrypted data cannot be recovered.

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

# If upgrading from a version without encryption, run the migration script
# (Dry run first to see what will be encrypted)
ENCRYPTION_KEY=<your-key> tsx scripts/encrypt-totp-secrets.ts
# Then apply the changes
ENCRYPTION_KEY=<your-key> tsx scripts/encrypt-totp-secrets.ts --apply

pm2 startOrRestart ecosystem.config.cjs
```

## Migration from Pre-Encryption Versions

If you're upgrading from a version that stored TOTP secrets in plaintext, you **must** run the migration script after deploying:

```bash
# 1. Ensure ENCRYPTION_KEY is set in your .env file
# 2. Dry run to see what will be encrypted (recommended first)
ENCRYPTION_KEY=<your-key> tsx scripts/encrypt-totp-secrets.ts

# 3. Review the output, then apply the changes
ENCRYPTION_KEY=<your-key> tsx scripts/encrypt-totp-secrets.ts --apply
```

The script will:
- Detect which secrets are already encrypted
- Encrypt any plaintext secrets found
- Validate encryption/decryption before committing changes
- Provide a detailed summary of changes

## Troubleshooting
- **`MODULE_NOT_FOUND` (dotenv)**: Ensure `dotenv` is installed in the root `node_modules`.
- **`Prisma Client` errors**: Run `pnpm prisma:generate`.
- **Deployment fails silently**: Check `pm2 logs Purrmission`.
- **`ENCRYPTION_KEY is not set` error**: Ensure `ENCRYPTION_KEY` is defined in your `.env` file with a valid 64-character hex string.
- **Decryption errors after upgrade**: Ensure you're using the same `ENCRYPTION_KEY` that was used to encrypt the data. If you lost the key, encrypted data cannot be recovered.
