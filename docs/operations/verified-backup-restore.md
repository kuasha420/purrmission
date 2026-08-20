# Verified production backup and restore

Production SQLite migrations are blocked until the deploy workflow completes an encrypted offsite
backup round trip. The supported path is `node dist-scripts/backup-db-cli.js --env-file .env`, which:

1. creates a transactionally consistent SQLite snapshot with `VACUUM INTO` while the application
   remains available; lock acquisition failure aborts the gate, and PM2 is stopped only after the
   verified round trip succeeds;
2. records a versioned, non-secret manifest containing time, size, digest, tables, and completed
   Prisma migrations;
3. encrypts the snapshot with AES-256-GCM using dedicated backup key material and authenticates the
   manifest as additional data;
4. copies and fsyncs the package to a separately mounted offsite filesystem;
5. downloads the uploaded object into a new temporary workspace;
6. authenticates and decrypts it into an isolated restore directory, never the production path;
7. verifies the plaintext digest, SQLite `quick_check`, reads every application table, and checks
   the schema table set and Prisma migration set;
8. enforces retention while preserving the configured minimum recovery-copy count.

Any failure exits nonzero before deployment cleanup or `pnpm prisma:deploy`.

## Required production configuration

Store these values in the server's protected root `.env`:

```dotenv
BACKUP_ENCRYPTION_KEYS_JSON='{"backup-2026-08":"<64 hexadecimal characters>"}'
BACKUP_ACTIVE_KEY_ID='backup-2026-08'
BACKUP_OFFSITE_DIR='/mnt/purrmission-offsite'
BACKUP_RETENTION_DAYS='30'
BACKUP_MIN_RECOVERY_COPIES='7'
BACKUP_MAX_AGE_MINUTES='30'
BACKUP_MAX_DATABASE_BYTES='268435456'
```

`BACKUP_OFFSITE_DIR` must be an access-controlled, separately mounted filesystem outside the
deployment root. A local sibling directory is rejected because it does not survive host loss. The
repository does not prescribe a cloud vendor: an encrypted block/object-store mount, managed
backup mount, or similarly independent store is acceptable when its access policy and durability
are reviewed.

`BACKUP_MAX_DATABASE_BYTES` is a fail-closed memory and package-size boundary. The current
JSON/base64 package format enforces a maximum of 256 MiB (`268435456` bytes) so it cannot exceed
Node's string representation limit. Set it above the observed production database size with
deliberate headroom, within that ceiling; a larger database requires a reviewed streaming package
format before deployment can proceed.

The active backup key must not equal the application encryption, audit-integrity, or
outbox-integrity key. Keep older backup keys in the JSON key ring until every retained package that
uses them has expired and a restore rehearsal has succeeded with the successor key. Restrict `.env`
and the offsite mount to the deployment account; packages are mode `0600` but filesystem access
control remains mandatory.

## Key rotation

1. Generate a new independent 32-byte key and add it under a new key ID.
2. Change `BACKUP_ACTIVE_KEY_ID` to the new ID without removing the previous entry.
3. Run a deployment or the round-trip command and confirm the new package verifies.
4. Retain the previous key until no retained manifest names it.
5. Exercise the manual verification command against both an old and a new package before retiring
   the old key.

## Manual disaster-restore rehearsal

Select a package from the offsite mount and restore it to a newly created directory that cannot
contain the production database:

```bash
mkdir -m 700 /tmp/purrmission-restore-rehearsal
node dist-scripts/backup-db-cli.js verify \
  --env-file .env \
  --package /mnt/purrmission-offsite/<selected>.purrbackup \
  --restore-root /tmp/purrmission-restore-rehearsal \
  --maximum-age-minutes 43200
```

The command reports the isolated database path only after authentication, digest, SQLite,
migration-state, and schema checks pass. For a real disaster recovery:

1. stop PM2 and preserve the failed production database without overwriting it;
2. verify the selected package in an isolated location as above;
3. record the selected package ID, manifest time, completed migration set, and incident ticket;
4. copy the verified database to a **new** production path, update `DATABASE_URL`, then run
   `pnpm prisma:deploy`;
5. run `node scripts/validate-env.cjs`, a read-only application smoke check, and only then restart
   PM2;
6. keep the failed database and selected encrypted package until incident closeout.

Do not point `--restore-root` at the deployment/data directory and do not overwrite the failed
database in place.

## Recovery assumptions and escalation

- RPO is the interval between successful deployments/backups; the default process creates one
  verified package before every production migration.
- RTO depends on offsite download size and operator validation; measure it during each quarterly
  restore rehearsal and record the result outside the repository.
- Authentication failure, missing historical key, stale manifest, integrity failure, migration
  mismatch, retention deletion failure, or an unavailable offsite mount blocks deployment and
  requires operator escalation. Never bypass the check with a plaintext copy.
- Alert on workflow failure and on absence of a successful verified package within the expected
  deployment/RPO window.
