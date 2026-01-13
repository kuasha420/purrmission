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
pnpm prisma:deploy
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
pnpm prod:ops:rotate-keys -- --dry-run
# Then apply the changes (it uses the same key by default to migrate legacy formats)
pnpm prod:ops:rotate-keys

pm2 startOrRestart ecosystem.config.cjs
```

## Key Rotation & Format Migration

The bot supports rotating encryption keys or migrating legacy ciphertext to the new `v1:` format.

### Dry Run (Recommended)
Always run a dry run first to see how many records need updating:
```bash
pnpm prod:ops:rotate-keys -- --dry-run
```

### Rotating to a New Key
To rotate to a completely new key:
1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Run rotation:
```bash
# Pass old and new keys via CLI or ENV
export ENCRYPTION_KEY_OLD=<current-key>
export ENCRYPTION_KEY_NEW=<new-key>
pnpm prod:ops:rotate-keys -- --from-key $ENCRYPTION_KEY_OLD --to-key $ENCRYPTION_KEY_NEW
```
3. Update `.env` with the `ENCRYPTION_KEY_NEW` value as `ENCRYPTION_KEY`.
4. Restart the bot.

> [!IMPORTANT]
> **Database Backups**: The rotation script automatically creates a timestamped backup in `backups/` before performing any writes (unless in `--dry-run` mode).

## Audit Logs

Sensitive application flows (field access, TOTP code retrieval, approval decisions) emit audit events to the `AuditLog` table.
- **Viewing Logs**: Access via Prisma Studio: `pnpm prisma:studio`
- **Actions Logged**: `APPROVAL_DECISION`, `TOTP_LINKED`, `FIELD_ACCESS_THROTTLED`, `TOTP_ACCESS_THROTTLED`.

## Troubleshooting
- **`MODULE_NOT_FOUND` (dotenv)**: Ensure `dotenv` is installed in the root `node_modules`.
- **`Prisma Client` errors**: Run `pnpm prisma:generate`.
- **Deployment fails silently**: Check `pm2 logs Purrmission`.
- **`ENCRYPTION_KEY is not set` error**: Ensure `ENCRYPTION_KEY` is defined in your `.env` file with a valid 64-character hex string.
- **Decryption errors after upgrade**: Ensure you're using the same `ENCRYPTION_KEY` that was used to encrypt the data. If you lost the key, encrypted data cannot be recovered.
