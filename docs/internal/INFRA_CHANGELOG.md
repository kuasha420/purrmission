# 🔒 Internal Infrastructure Guide

> **CONFIDENTIAL**: For Engineering Team Only.
> **Drive Link**: [Google Drive: Purrmission Infra Docs](PLACEHOLDER_LINK_TO_DRIVE)

## 🚨 Critical Architecture Changes (Jan 2026)

Following Incident #40 (DB Reset), the production server file structure was overhauled to guarantee data persistence.

### 1. Directory Structure
The application now enforces a strict separation between **stateless code** (flushed on deploy) and **stateful data** (preserved).

```text
/home/purrfecthq-purrmission-infra/htdocs/purrmission/
├── apps/                 # Application code (FLUSHED on deploy)
├── ecosystem.config.cjs  # PM2 Config
├── .env                  # Single Source of Truth (PRESERVED)
├── data/                 # PERSISTENT STORAGE (PRESERVED)
│   └── purrmission.db    # Production SQLite Database
└── backups/              # AUTOMATED BACKUPS (PRESERVED)
    ├── purrmission.db.20260120120000.bak
    └── ...
```

### 2. Database Persistence
- **Old Location**: `prisma/purrmission.db` (Deleted on deploy)
- **New Location**: `data/purrmission.db` (Preserved)
- **Config**: `.env` MUST point to this location:
  ```env
  DATABASE_URL="file:../data/purrmission.db"
  ```
  *(Note: relative to `apps/purrmission-bot/`, hence `../data`)*

### 3. Automated Backups
The `deploy.yml` workflow now performs a safety backup **before** touching any files.
- **Trigger**: Every push to `deploy` branch.
- **Action**: Copies `data/purrmission.db` to `backups/` with a timestamp.
- **Retention**: Currently unlimited (manual cleanup required periodically).

### 4. Environment Variables
- **Consolidation**: Nested `.env` files in `apps/` are **forbidden** and deleted during deployment.
- **Root .env**: The repository root `.env` is the ONLY valid config file.
- **Validation**: Deployment runs a two-tier validation:
  1. **Pre-flight (Shell)**: Strictly checks for "volatile" `DATABASE_URL` patterns (e.g. `prisma/`, `dev.db`). Fails BEFORE any data is deleted.
  2. **Post-copy (Node)**: Runs `scripts/validate-env.cjs` to ensure all keys like `ENCRYPTION_KEY` are present and valid.

### 5. Failure Recovery
If the deployment fails during "Pre-flight persistence check":
1. Connect via SSH.
2. Verify the location of your `.db` file (should be in root `data/`).
3. If it's in `prisma/data/`, move it to `data/` manually.
4. Update `.env` to `DATABASE_URL="file:../data/purrmission.db"`.
5. Retrigger the deployment.
