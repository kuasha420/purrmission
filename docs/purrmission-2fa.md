# Purrmission 2FA - Overview

Purrmission is a Discord-based approval gate system. The **2FA / TOTP** module allows users to store TOTP secrets (like those for GitHub, AWS, Google) directly in Purrmission and retrieve time-based codes via Discord commands.

This is particularly useful for **shared accounts** (e.g., `opensource@purrfecthq.com`), where multiple team members need access to the same 2FA codes without sharing a single physical device or passing QR codes around insecurely.

## Domain Concepts

### TOTPAccount
A `TOTPAccount` represents a stored 2FA credential.

- **Owner**: The Discord user who created the account.
- **Account Name**: A user-defined label (e.g., "GitHub", "AWS-Root").
- **Secret**: The Base32 secret key used to generate codes. (Stored via specific mode).
- **Shared**: A boolean flag. If `true`, this account is visible to other users (current MVP: visible to everyone; future: ACLs).
- **Backup Key**: An optional recovery code stored with the account (added via `update` command).

## Usage Examples

### 1. Add a Personal Account (URI Mode)
Most services provide an `otpauth://` URI when setting up 2FA. You can copy this URI and use it directly.

```
/purrmission 2fa add account:"GitHub" mode:uri uri:otpauth://totp/GitHub:user?secret=JBSWY3DPEHPK3PXP
```

### 2. Add a Shared Account (Secret Mode)
If you only have the Base32 secret (e.g., `JBSWY3DPEHPK3PXP`), you can use secret mode. Use `shared:True` to make it accessible to the team.

```
/purrmission 2fa add account:"Team AWS" mode:secret secret:JBSWY3DPEHPK3PXP shared:True
```

### 3. Retrieve a Code
To get a code, use the `get` command. You can use autocomplete to find the account name.

```
/purrmission 2fa get account:"Team AWS"
```

**Result:** The bot will DM you the current 6-digit code.

> **Note:** There is a 10-second rate limit per account per user to prevent abuse.

### 4. Update Backup Key
As an owner, you can attach a backup key (recovery code) to an account.

```
/purrmission 2fa update account:"GitHub" backup_key:"1234-5678-9012"
```

### 5. List Accounts
See all accounts you have access to.

```
/purrmission 2fa list
# Optional: include shared accounts
/purrmission 2fa list shared:True
```

## Security Notes (MVP)

> [!WARNING]
> **MVP Status**: This is an initial release (v0.0.1).

- **Encryption**: Secrets are currently stored in **plaintext** in the SQLite database. Encryption at rest is planned for a future release.
- **Delivery**: Codes are delivered via Direct Message (DM). Ensure your Discord account is secure.
- **Access Control**: Currently, `shared:True` accounts are visible to **all** users who can use the bot. Granular ACLs are coming soon.

## Environment

TOTP accounts are stored in the Prisma SQLite database. The location is configured via `DATABASE_URL` in your `.env` file. See the root `README.md` for setup instructions.
