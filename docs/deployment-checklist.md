# Deployment Checklist

## Pre-Deployment Verification

- [ ] **Environment Variables**:
    - [ ] `DATABASE_URL` is set in `.env`.
        - *Critical*: For SQLite, verify the path points to a persistent volume/location outside the ephemeral build directories.
        - **Example**: 
            - BAD: `file:./dev.db` (Relative to app, deleted on deploy)
            - GOOD: `file:/home/user/purrmission_data/prod.db` (Absolute path, outside deploy folder)
    - [ ] `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` are set.
    - [ ] `PORT` is set (default 3000).

- [ ] **Database & Migrations**:
    - [ ] **Artifact Check**: Ensure `prisma/` directory (containing `schema.prisma`) is included in the deployment artifact.
        - *Current Status*: **MISSING** in `deploy.yml`. Application execution might work, but migrations will fail.
    - [ ] **Migration Check**: Run `npx prisma migrate deploy` on the server after deployment.
    - [ ] **Persistence Check**: Verify SQLite database file is not overwritten/deleted during deployment cleanup.

- [ ] **Dependencies**:
    - [ ] Verify `yarn install --immutable` runs successfully.
    - [ ] Ensure `openssl` is installed on the server (required for Prisma Engine).

## Deployment Steps

1.  **Merge to `deploy` branch**: Triggers GitHub Action.
2.  **Monitor Action**: Watch for build and deploy job success.
3.  **Post-Deployment Server Checks**:
    -   SSH into server.
    -   Navigate to deployment directory.
    -   Run Migrations: `npx prisma migrate deploy` (Requires fixing artifact export first).
    -   Check PM2 status: `pm2 status`.
    -   View Logs: `pm2 logs Purrmission`.

## Troubleshooting

-   **"Schema not found"**: The `prisma` directory was not uploaded. Copy it manually or update `deploy.yml`.
-   **"Database is locked"**: Common with SQLite if multiple processes access it. Restart PM2.
-   **Missing Dependencies**: If `npx` or `prisma` not found, ensure they are in `dependencies` or `yarn install` installs dev deps (default for Yarn Berry).
