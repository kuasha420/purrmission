# Security Design & Standards

This document outlines the security architecture and standards for the Purrmission project.

## Encryption Standards

Purrmission uses **AES-256-GCM** for authenticated encryption of sensitive data at rest.

- **Algorithm**: `aes-256-gcm`
- **Key Derivation**: Keys are expected to be 32-byte (256-bit) cryptographically secure random values, provided as 64-character hexadecimal strings.
- **Ciphertext Format (v1)**: `v1:base64(iv):base64(authTag):base64(ciphertext)`
- **Legacy Support**: The system recognizes and can decrypt the older `base64(iv):base64(authTag):base64(ciphertext)` format without the version prefix.

### Key Management
- **Environment**: Keys MUST be stored in the `ENCRYPTION_KEY` environment variable.
- **Rotation**: Keys can be rotated using `scripts/rotate-keys.ts`.
- **Loss**: Loss of the `ENCRYPTION_KEY` results in permanent loss of access to encrypted secrets (TOTP keys, etc.).

## Threat Model

### Mitigated Threats
1. **Database Leak**: If the SQLite database is leaked, sensitive values (TOTP secrets, API keys) remain protected by AES-256-GCM encryption.
2. **Access Token Spam**: Rate limiting prevents brute-forcing of TOTP codes or field values via Discord commands.
3. **Misconfiguration**: The application fails to start if the `ENCRYPTION_KEY` is missing or invalid, preventing "silent failures" where data is written unencrypted.
4. **Malformatted Secrets**: TOTP secrets are automatically sanitized (whitespace removal) upon entry to prevent copy-paste errors from causing generation failures.

### Operational Guardrails
- **Audit Logging**: All sensitive access is logged to the `AuditLog` table, providing a trail for forensic analysis.
- **Atomic Rotation**: The key rotation tool performs a backup before writing and verifies every record immediately after update.

## Best Practices for Operators
- **Backups**: Regularly backup the `.db` files and the `.env` file (containing the encryption key).
- **Least Privilege**: Only authorized users should have access to the server environment where the encryption key is stored.
- **Rate Limits**: The bot implements default rate limits (e.g., 10 per minute for sensitive code retrieval). Monitor audit logs for `*_THROTTLED` events as an indicator of potential abuse.
