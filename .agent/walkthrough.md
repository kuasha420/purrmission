# Walkthrough: Security Hardening + Ops Readiness Pack v1

We have successfully implemented the security hardening pack for Purrmission. This includes encryption upgrades, audit logging, rate limiting, and centralized access policies.

## 1. Startup Encryption Guardrails
The bot now validates the `ENCRYPTION_KEY` at startup.
- **Verification**: If you remove or corrupt `ENCRYPTION_KEY` in `.env`, the bot will refuse to start and print a helpful error message.
- **Code**: `src/index.ts` calls `validateEncryptionConfig()`.

## 2. Ciphertext Versioning & Key Rotation
We introduced a `v1:` prefix for encrypted values to support future algorithm changes and key rotation.
- **Rotation Tool**: `scripts/rotate-keys.ts`
- **Features**:
  - `--dry-run`: safe testing (verified).
  - **Auto-Fix**: Detected and fixes unencrypted/plaintext secrets during rotation.
  - **Backup**: Automatically backs up SQLite DB to `backups/` before writing.
- **Usage**:
  ```bash
  # Dry run with current key (updates legacy formats to v1)
  npx tsx scripts/rotate-keys.ts --dry-run
  
  # Full rotation
  export ENCRYPTION_KEY_OLD=...
  export ENCRYPTION_KEY_NEW=...
  npx tsx scripts/rotate-keys.ts --from-key $ENCRYPTION_KEY_OLD --to-key $ENCRYPTION_KEY_NEW
  ```

## 3. Audit Logging
Sensitive actions are now logged to the database.
- **Enabled For**: Field Access, TOTP Access, 2FA Linking/Unlinking, Approval Decisions.
- **Storage**: `AuditLog` table in Prisma/SQLite.
- **Viewing Logs**: Run `npx prisma studio` to view rows.

## 4. Rate Limiting
In-memory rate limiting uses a token bucket algorithm to prevent spam.
- **Limits**:
  - Field Access: ~1 request/min per field (example logic in `resource.ts`).
  - TOTP Access: ~1 request/10s per account (example logic in `twoFa.ts`).
- **Audit**: Rate limit hits are logged as `*_THROTTLED` events in Audit Logs.

## 5. Freeze Access Semantics
Centralized policy logic (`src/domain/policy.ts`) now governs access.
- **Rules**:
  - **Guardians/Owners**: Direct access allowed.
  - **Others**: Access denied (requiring approval flow).
- **Tested**: Unit tests in `src/domain/policy.test.ts`.

## Verification Results
- **Unit Tests**: All tests passed (`npm test`).
- **Dry Run**: Key rotation confirmed working and fixed a legacy plaintext entry issue.
