# Credential lifecycle migration

The `20260821020000_credential_lifecycle` migration is an intentional security cutover. Run it only
through `pnpm prisma:deploy`; the supported wrapper preserves populated Project, Resource, TOTP,
Guardian, and audit data while applying every published migration.

## Before deployment

1. Complete and verify an encrypted offsite backup using the repository backup workflow.
2. Configure `CREDENTIAL_HMAC_KEYS_JSON` with stable key IDs and independent secrets of at least 32
   bytes, and set `CREDENTIAL_HMAC_ACTIVE_KEY_ID` to the minting key.
3. Notify operators that all existing Resource API keys, Pawthy tokens, service credentials, and
   pending device sessions will be invalidated.

## Cutover behavior

- Legacy `Resource.apiKey` values and the `ApiToken` table are dropped and never copied.
- Provisional `Credential` rows are invalidated because they lack a trustworthy digest key ID and
  immutable target binding.
- Pending device sessions are invalidated so approval/exchange begins under the atomic contract.
- Resources and their non-credential relationships remain intact. Resource owners must mint new
  keys; Pawthy users must log in again.

Plaintext is returned exactly once by resource/environment creation and credential rotation or mint
responses. Those responses use `Cache-Control: no-store`; inventories omit the digest.

## Verification and rollback

After deployment, confirm `Resource` has no `apiKey` column, `ApiToken` is absent, the supported
credential inventory contains no `digest`, and a newly minted key is rejected after rotation or
revocation. The populated migration rehearsal in `scripts/ops.test.ts` verifies those invariants.

Rollback is restore-only: stop the service, restore the independently verified pre-deploy backup to
an isolated path, verify it, then promote it using the backup runbook. Never reverse-copy credential
data from the new schema into legacy plaintext columns.
