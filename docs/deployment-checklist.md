# Deployment Checklist

## Pre-Deployment Verification

- [ ] **Environment Variables**:
  - [ ] `DATABASE_URL` is set in `.env`.
    - _Critical_: For SQLite, verify the path points to a persistent volume/location outside the ephemeral build directories.
    - **Example**:
      - BAD: `file:./dev.db` (Relative to app, deleted on deploy)
      - GOOD: `file:/home/user/purrmission_data/prod.db` (Absolute path, outside deploy folder)
  - [ ] `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` are set.
  - [ ] `PORT` is set (default 3000).

- [ ] **Database & Migrations**:
  - [ ] **Verified backup configuration**: Configure the dedicated backup key ring, active key,
        retention, and a separately mounted `BACKUP_OFFSITE_DIR` described in
        [Verified production backup and restore](operations/verified-backup-restore.md).
  - [ ] **Restore proof**: Confirm the workflow uploaded, downloaded, authenticated, and restored
        the current package in isolation before migration began.
  - [ ] **Artifact Check**: Ensure `prisma/` directory (containing `schema.prisma`) is included in the deployment artifact.
    - _Current Status_: `deploy.yml` includes Prisma plus the supported migration wrapper and its Guardian reconciliation dependency.
  - [ ] **Migration Check**: Run `pnpm prisma:deploy` on the server after deployment. This supported wrapper performs the required RBAC reconciliation before invoking Prisma.
  - [ ] **Persistence Check**: Verify SQLite database file is not overwritten/deleted during deployment cleanup.

- [ ] **Dependencies**:
  - [ ] Verify `pnpm install --immutable` runs successfully.
  - [ ] Ensure `openssl` is installed on the server (required for Prisma Engine).

## Deployment Steps

1.  **Merge to `deploy` branch**: Triggers GitHub Action.
2.  **Monitor Action**: Confirm the verified offsite backup step succeeds before cleanup and
    migration, then watch the remaining deploy job.
3.  **Post-Deployment Server Checks**:
    - SSH into server.
    - Navigate to deployment directory.
    - Run Migrations: `pnpm prisma:deploy`.
    - Check PM2 status: `pm2 status`.
    - View Logs: `pm2 logs Purrmission`.

## Troubleshooting

- **"Schema not found"**: The `prisma` directory was not uploaded. Copy it manually or update `deploy.yml`.
- **"Database is locked"**: Common with SQLite if multiple processes access it. Restart PM2.
- **Backup step failed**: Keep the deployment stopped. Verify the offsite mount, dedicated key ring,
  retention policy, and package age; never bypass it with a plaintext local copy.
- **Missing Dependencies**: If `pnpm` or Prisma is not found, ensure project dependencies were installed with `pnpm install`.

> [!WARNING]
> Direct Prisma migration CLI invocation is unsupported because it bypasses the required Guardian/owner reconciliation preflight. Operators must use `pnpm prisma:deploy`.
