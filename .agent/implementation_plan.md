# Security Hardening + Ops Readiness Pack v1

## User Review Required

> [!IMPORTANT]
> **Encryption Key Rotation**: The key rotation script is a sensitive operation. It is recommended to back up the database before running it in production.
> **Ciphertext Format**: New encrypted values will use the format `v1:iv:tag:ciphertext`. Legacy values will still be decryptable.

## Proposed Changes

### Encryption & Security Hardening

#### [MODIFY] [apps/purrmission-bot/src/infra/crypto.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/src/infra/crypto.ts)
- Update `encryptValue` to prepend `v1:` to the output.
- Update `decryptValue` to detect `v1:` prefix.
    - If present, parse as v1.
    - If absent, attempt legacy parsing (3 parts).
- Add `validateEncryptionConfig()` function to check key validity and perform a test encrypt/decrypt cycle.

#### [MODIFY] [apps/purrmission-bot/src/index.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/src/index.ts)
- Call `validateEncryptionConfig()` at the very start of `main()`. Fail fast if it throws.

### Key Rotation

#### [NEW] [apps/purrmission-bot/scripts/backup-db.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/scripts/backup-db.ts)
- Utility to backup the database.
- For SQLite: Copies the `.db` file to a `backups/` directory with timestamp.
- Exports a function `backupDatabase()` that returns the backup path.

#### [NEW] [apps/purrmission-bot/scripts/rotate-keys.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/scripts/rotate-keys.ts)
- CLI script to rotate encryption keys.
- **Pre-flight**: Calls `backupDatabase()` before any writes (unless `--dry-run`).
- Accepts `--dry-run`, `--batch-size`.
- Reads `ENCRYPTION_KEY` (new) and `ENCRYPTION_KEY_OLD` (current).
- Iterates `TOTPAccount` and `ResourceField`.
- Decrypts with old key, encrypts with new key, updates DB.

### Audit Logging

#### [MODIFY] [apps/purrmission-bot/prisma/schema.prisma](file:///home/deck/Dev/purrmission/apps/purrmission-bot/prisma/schema.prisma)
- Add `AuditLog` model.
  ```prisma
  model AuditLog {
    id          String   @id @default(uuid())
    action      String
    resourceId  String?
    actorId     String?
    resolverId  String?
    status      String
    context     String? // JSON string
    createdAt   DateTime @default(now())
    
    @@index([resourceId])
    @@index([actorId])
    @@index([createdAt])
  }
  ```

#### [NEW] [apps/purrmission-bot/src/domain/audit.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/src/domain/audit.ts)
- `AuditService` to log events to Prisma.
- `logEvent(event: AuditEvent)`

### Access Control & Rate Limiting

#### [NEW] [apps/purrmission-bot/src/domain/policy.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/src/domain/policy.ts)
- `canDirectAccess(actor, resource, actionType)`
- `requiresApproval(actor, resource, actionType)`

#### [NEW] [apps/purrmission-bot/src/infra/rateLimit.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/src/infra/rateLimit.ts)
- In-memory rate limiter `RateLimiter`.
- `checkLimit(key: string, limit: number, window: number): boolean`

#### [MODIFY] [apps/purrmission-bot/src/discord/commands/resource.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/src/discord/commands/resource.ts)
- Integrate `policy.canDirectAccess` and `rateLimit`.
- Log audit events.

#### [MODIFY] [apps/purrmission-bot/src/discord/commands/twoFa.ts](file:///home/deck/Dev/purrmission/apps/purrmission-bot/src/discord/commands/twoFa.ts)
- Integrate `policy.canDirectAccess` and `rateLimit`.
- Log audit events.

## Verification Plan

### Automated Tests
- **Unit Tests**:
    - `crypto.test.ts`: Test v1 encrypt/decrypt, legacy decrypt, key validation.
    - `policy.test.ts`: Test access rules for owners/guardians/others.
    - `rateLimit.test.ts`: Test throttling logic.
- **Run Tests**: `pnpm test`

### Manual Verification
1. **Startup Check**:
   - Set invalid `ENCRYPTION_KEY` in `.env`.
   - Run `pnpm start`. Verify bot exits with error.
2. **Access Policy**:
   - As owner: `/purrmission resource get-field` (should work directly).
   - As non-guardian: `/purrmission resource get-field` (should trigger approval).
3. **Audit Logs**:
   - Perform actions.
   - check DB: `npx prisma studio` -> `AuditLog`.
4. **Key Rotation**:
   - Backup DB.
   - Run `pnpm tsx scripts/rotate-keys.ts --dry-run`.
   - Set `ENCRYPTION_KEY_OLD` and new `ENCRYPTION_KEY`.
   - Run rotation.
   - Verify bot can still read secrets (with new key).
