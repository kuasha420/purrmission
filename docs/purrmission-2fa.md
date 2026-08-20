# Purrmission 2FA - Overview

Purrmission is a Discord-based approval gate system. The **2FA / TOTP** module allows users to store TOTP secrets (like those for GitHub, AWS, Google) directly in Purrmission and retrieve time-based codes via Discord commands.

Each account remains in the authenticated creator's personal custody. Team use is represented by
an explicit Resource link and narrowly bound consent, never by a global visibility flag.

WebAuthn/passkey support is not a TOTP variant and is not implemented in this
module yet. The current design track for that work lives in
[Passkey-Aware Access](design/passkey-aware-access.md) with the draft epic in
[docs/epics/passkey-aware-access.md](epics/passkey-aware-access.md).

## Domain Concepts

### TOTPAccount

A `TOTPAccount` represents a stored 2FA credential.

- **Owner**: The Discord user who created the account.
- **Account Name**: A user-defined label (e.g., "GitHub", "AWS-Root").
- **Secret**: The Base32 secret key used to generate codes. Stored encrypted at rest.
- **Backup Key**: An optional recovery code stored with the account (added via `update` command).

## Usage Examples

### 1. Add a Personal Account (URI Mode)

Most services provide an `otpauth://` URI when setting up 2FA. You can copy this URI and use it directly.

```
/2fa add account:"GitHub" mode:uri
```

When `mode:uri` is selected, submit the `otpauth://...` value through the Discord modal prompt.

### 2. Add an Account (Secret Mode)

If you only have the Base32 secret (e.g., `JBSWY3DPEHPK3PXP`), use secret mode.

```
/2fa add account:"Team AWS" mode:secret secret:JBSWY3DPEHPK3PXP
```

### 3. Retrieve a Code

To get a code, use the `get` command. You can use autocomplete to find the account name.

```
/2fa get account:"Team AWS"
```

**Result:** The bot will DM you the current 6-digit code.

> **Note:** There is a 10-second rate limit per account per user to prevent abuse.

### 4. Update Backup Key

As an owner, you can attach a backup key (recovery code) to an account.

```
/2fa update account:"GitHub" backup_key:"1234-5678-9012"
```

### 5. List Accounts

See all accounts you have access to.

```
/2fa list
```

## Related Resource Commands

Resources can also reference stored 2FA accounts:

- `/resource 2fa link resource-id:<id> account:<id> consent-id:<id>`
- `/resource 2fa unlink resource-id:<id>`
- `/resource 2fa get resource-id:<id>`

Before linking, the authenticated account owner creates the one-time consent through
`POST /api/totp/:accountId/link-consents`, naming the Resource, the initiating Resource Owner, and
an optional fail-closed delegation policy. The returned consent ID is authority-bearing metadata:
do not log or persist it in client storage. Code and recovery responses use POST and
`Cache-Control: no-store`.

The #120 migration intentionally unlinks every pre-consent Resource association and discards old
incomplete consent rows. TOTP accounts and encrypted custody material remain intact, but operators
must obtain a new account-owner consent before relinking. Complete the #105 offsite backup/restore
rehearsal before applying this migration to production.

## WebAuthn and Passkey Roadmap

TOTP secrets behave like shared symmetric secrets: once Purrmission stores the
secret, it can generate a current code on demand. WebAuthn credentials behave
differently. A browser or OS asks an authenticator to sign a relying-party
challenge with a private key that should stay at the edge and require local user
verification.

For that reason, future passkey support should be implemented through a
companion browser extension, native app, or mobile app that performs WebAuthn
ceremonies locally while Purrmission handles account metadata, guardian
approvals, audit logs, and short-lived approval leases.

## Security Notes

> [!WARNING]
> **Delegated 2FA Status**: TOTP support is useful today, but delegated use is a
> sensitive workflow. A link or consent record alone never authorizes code reveal.

- **Encryption**: TOTP secrets and backup keys are encrypted at rest with the
  repository's AES-256-GCM encryption helper.
- **Delivery**: Codes are delivered via Direct Message (DM). Ensure your Discord account is secure.
- **Access Control**: Account metadata is personal-custody scoped. Resource linking requires a
  one-time consent bound to the account version, Resource, initiating owner, and link policy.
- **Recovery**: Backup/recovery material is personal-owner-only and cannot be delegated.
- **Passkeys**: WebAuthn/passkey credentials must not be treated as
  server-generated codes. See the design doc before adding implementation.

## Environment

TOTP accounts are stored in the Prisma SQLite database. The location is configured via `DATABASE_URL` in your `.env` file. See the root `README.md` for setup instructions.
