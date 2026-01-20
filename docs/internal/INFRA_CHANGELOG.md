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
- **Validation**: Deployment runs `scripts/validate-env.cjs` before startup. It fails the deploy if:
  - `.env` is missing.
  - Critical keys (`DATABASE_URL`, `ENCRYPTION_KEY`, etc.) are missing.
