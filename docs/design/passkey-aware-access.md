# Design Doc: Passkey-Aware Access

Status: Experimental planning  
Last updated: 2026-06-22  
Target development track: private `purrfectsoft/purrmission` soft-fork before OSS merge-back

## 1. Overview

Purrmission currently gives teams a Discord-centered control plane for shared
credentials, TOTP-based 2FA, approval workflows, audit logs, and Pawthy secret
sync. That works well for secrets that can be represented as server-readable
values. WebAuthn and passkeys are different: the useful secret is a private key
that should be bound to an authenticator, scoped to a relying party, mediated by
the browser or OS, and released only after local user consent.

The feature we want is therefore not "store WebAuthn like TOTP." The healthier
shape is **Passkey-Aware Access**:

- Purrmission remains the account ledger, approval policy engine, audit trail,
  and sync broker.
- A companion surface, such as a browser extension, native desktop app, or
  mobile app, owns WebAuthn ceremonies and local signing.
- Private keys stay at the edge, either device-bound or wrapped in
  end-to-end-encrypted credential envelopes that Purrmission cannot use alone.
- Guardians approve short-lived signing leases before a companion can satisfy a
  protected WebAuthn challenge for a shared account.

This keeps the Purrmission philosophy intact: human-in-the-loop access,
least-exposed secrets, Discord-native approvals, and ergonomic team workflows.

## 2. Why This Matters

More sites are offering or requiring passkeys/security keys for second-factor or
passwordless login. Some flows reduce or remove TOTP support once WebAuthn is
enabled. Shared operational accounts are especially exposed to this shift:

- A single hardware key does not match distributed teams.
- Sharing a synced passkey through a consumer password manager may bypass
  Purrmission's guardian model and audit trail.
- Reverting to backup codes loses the daily-use ergonomics that TOTP currently
  provides.
- Fully server-side signing would undermine WebAuthn's security model and may
  fail because the browser, OS, authenticator, and relying party all participate
  in the ceremony.

The goal is to keep Purrmission complete as websites move from TOTP to WebAuthn
while respecting why WebAuthn exists.

## 3. Standards Reality

WebAuthn is an API for creating and using public-key credentials. The W3C model
has three practical consequences for Purrmission:

- Credentials are scoped to a relying party, commonly identified by `rpId`, and
  are not reusable across arbitrary origins.
- The browser/user agent mediates access to authenticators, and authenticators
  are expected to require user consent before performing operations.
- Authentication is an assertion over a challenge. There is no six-digit code
  equivalent that Purrmission can safely compute on the server.

FIDO passkeys can be synced across devices or bound to one device. Password
managers such as Bitwarden and 1Password demonstrate that passkey storage and
autofill can be built into browser extensions and mobile apps, but that pushes
real product work into client surfaces rather than the server alone.

Chrome exposes `chrome.webAuthenticationProxy` for extensions to proxy WebAuthn
requests, but the API is documented around remote desktop use cases and requires
the extension to become the active WebAuthn request proxy. We should treat
browser integration as a spike, not an assumption, and validate Chrome, Firefox,
Safari, and app-store constraints separately.

Android Credential Manager and Apple Authentication Services both point toward
native OS credential-provider integrations for mobile/passkey experiences. These
will likely be necessary for first-class mobile support, but they are a later
phase than a controlled desktop/Chromium proof of concept.

## 4. Product Principles

- **Edge signing, core governance**: Purrmission Core should never be able to
  sign a WebAuthn assertion by itself.
- **Member-isolated first**: Prefer one credential per accountable member when
  the relying party supports multiple passkeys/security keys.
- **Shared only when necessary**: A shared managed passkey is allowed for sites
  that cannot model team access, but it must be labeled higher risk.
- **Approval leases, not blind autofill**: Guardian approval grants a
  short-lived use permission; the companion still requires local unlock.
- **Audit without over-collection**: Store the relying party, credential
  reference, approver, requester, device, outcome, and timing. Avoid logging
  private key material, raw challenges beyond what is needed for debugging, or
  sensitive page data.
- **Graceful fallback**: Some sites require physical hardware attestation or
  reject synced/software passkeys. Purrmission must track backup methods and
  recovery status rather than pretending every WebAuthn flow is automatable.

## 5. Non-Goals for the First Experimental Track

- Building a general password manager.
- Bypassing hardware-key-only or enterprise-attested relying party policies.
- Headless login automation that signs without local user verification.
- Cross-browser production support in the first sprint.
- Import/export parity with all password managers before the core ceremony and
  approval model works.

## 6. Proposed Architecture

### 6.1 Components

| Component             | Responsibility                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purrmission Core      | Resource ledger, guardian policy, approval requests, audit logs, device registration, encrypted metadata, and short-lived signing leases.                         |
| Pawthy/Auth API       | Existing machine-facing API surface, extended later for companion login, device enrollment, credential metadata sync, and approval polling.                       |
| Browser Extension     | Detects or proxies WebAuthn create/get ceremonies, maps `rpId` to Purrmission resources, prompts for account/credential selection, and talks to the local signer. |
| Native Desktop Signer | Owns local keystore integration, biometric/PIN unlock where available, WebAuthn signing implementation, and native messaging with the extension.                  |
| Mobile Companion      | Provides push approval, local biometric/PIN unlock, member/device identity, and eventually OS credential-provider support.                                        |
| Discord Bot           | Continues to deliver guardian approval requests, denials, status updates, and recovery/admin commands.                                                            |

### 6.2 Custody Modes

| Mode                   | Use Case                                                                                             | Security Notes                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Member passkey         | Preferred for GitHub-style accounts that support multiple passkeys/security keys.                    | Strong accountability and easy revocation. Requires per-member enrollment at the relying party.           |
| Shared managed passkey | Shared accounts that only allow one usable passkey or where team migration needs TOTP-like behavior. | Higher risk. Needs explicit policy labels, stricter approval, shorter leases, and recovery codes.         |
| Hardware-key reference | Sites requiring a real security key or trusted attestation.                                          | Purrmission stores ownership, custody, backup, and approval ledger only; it cannot complete the ceremony. |
| External provider link | Organizations already storing passkeys in Bitwarden, 1Password, iCloud Keychain, or similar.         | Purrmission can track governance and recovery but cannot enforce signing unless integrated.               |

### 6.3 Data Model Sketch

This is a planning sketch, not a committed Prisma migration.

| Model                       | Key Fields                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PasskeyCredential`         | `id`, `resourceId`, `rpId`, `originPattern`, `label`, `credentialId`, `userHandle`, `publicKeyCose`, `custodyMode`, `attestationFormat`, `backupEligible`, `backupState`, `createdBy`, `status` |
| `PasskeyDevice`             | `id`, `memberDiscordUserId`, `devicePublicKey`, `platform`, `name`, `lastSeenAt`, `status`, `localVerificationCapabilities`                                                                     |
| `PasskeyCredentialEnvelope` | `id`, `credentialId`, `wrappedForDeviceId` or `wrappedForMemberId`, `ciphertext`, `kdfParams`, `version`, `rotatedAt`                                                                           |
| `PasskeyApprovalLease`      | `id`, `credentialId`, `requesterDiscordUserId`, `deviceId`, `rpId`, `expiresAt`, `approvedBy`, `approvalRequestId`, `status`                                                                    |
| `PasskeyAuditEvent`         | `id`, `credentialId`, `resourceId`, `actorDiscordUserId`, `deviceId`, `eventType`, `rpId`, `result`, `createdAt`, `metadataJson`                                                                |

The private key should not be stored as a server-decryptable field. If synced
managed passkeys are supported, the server stores only encrypted envelopes that
are useless without member/device-held key material.

### 6.4 Ceremony Flow: Registration

1. User opens the target site's "add passkey" or "add security key" flow.
2. The extension/native signer receives the `navigator.credentials.create()`
   request or the equivalent platform credential-provider request.
3. The user selects a Purrmission resource and custody mode.
4. If policy requires it, Purrmission creates an approval request in Discord.
5. Once approved, the companion unlocks locally and creates the credential.
6. Purrmission records metadata, credential ownership, custody mode, recovery
   notes, and audit events.
7. The target site receives a normal WebAuthn attestation response.

### 6.5 Ceremony Flow: Authentication

1. User signs in to the target site and chooses passkey/security key.
2. The extension/native signer receives the `navigator.credentials.get()`
   request, including the challenge and allowed credential IDs when present.
3. The companion maps `rpId` and credential IDs to Purrmission metadata.
4. If no current lease exists, Purrmission opens a guardian approval request.
5. Guardian approval creates a short-lived lease scoped to requester, device,
   credential, relying party, and time.
6. The requester unlocks the companion locally with biometric/PIN/password.
7. The signer validates `rpId`, origin expectations, lease scope, and local
   device authorization.
8. The signer returns a normal WebAuthn assertion to the browser/site.
9. Purrmission records the request, approval, signing outcome, and expiration.

## 7. Sprint Plan

### Sprint 0: Soft-Fork and Discovery

- Seed the private `purrfectsoft/purrmission` repo from the OSS checkout.
- Keep this design doc and the epic tracker as the initial source of truth.
- Build a minimal WebAuthn test relying party for local ceremonies.
- Spike Chromium extension feasibility with `chrome.webAuthenticationProxy` and
  native messaging.
- Decide whether the first signer PoC is browser-extension-only, native desktop
  plus extension, or mobile-paired.

Exit criteria: a documented, reproducible local create/get ceremony that proves
where interception and signing can happen.

### Sprint 1: Core Ledger and Policy

- Add passkey resource metadata models behind an experimental feature flag.
- Add device enrollment and member-device binding.
- Add approval leases scoped to credential, device, `rpId`, and expiration.
- Add audit event types for passkey create/get/deny/revoke/recover.
- Keep Discord commands minimal: list, status, revoke, and approval buttons.

Exit criteria: Purrmission can track passkey credentials and approve/deny use
without yet signing real production websites.

### Sprint 2: Desktop Companion PoC

- Implement a Chromium extension proof of concept.
- Implement native messaging to a local signer process.
- Store a test credential in OS-backed or locally encrypted storage.
- Complete create/get ceremonies against the local test relying party.
- Add origin and `rpId` validation tests.

Exit criteria: a developer can register and authenticate with a Purrmission-held
test credential from a desktop browser.

### Sprint 3: Guardian-Gated Signing

- Wire signing attempts to Purrmission approval leases.
- Add Discord approval notifications with enough context for guardians.
- Require local unlock after guardian approval.
- Add rate limits, timeout handling, cancellation, and audit review commands.

Exit criteria: a WebAuthn assertion is produced only after both guardian
approval and local user verification.

### Sprint 4: Recovery, Revocation, and Hardening

- Add device revocation and credential rotation workflows.
- Add backup code/hardware-key tracking for high-risk accounts.
- Add encrypted envelope rotation if synced custody is enabled.
- Add threat-model review and failure-mode tests.
- Document sites that reject managed/software passkeys.

Exit criteria: losing a device, removing a member, or rotating a shared account
has an operator-safe workflow.

### Sprint 5: Mobile Companion

- Add mobile approval and local verification flow.
- Spike Android Credential Manager provider support.
- Spike Apple Authentication Services/passkey provider support.
- Decide whether mobile signs directly, unlocks desktop signing, or both.

Exit criteria: mobile materially improves usability or coverage rather than
being a second notification UI.

### Sprint 6: OSS Graduation

- Finalize public docs, setup guide, and threat model.
- Remove or clearly bound experimental flags.
- Add integration tests and compatibility matrix.
- Merge back with a migration path and honest limitations.

Exit criteria: the feature is useful for at least one real shared-account
WebAuthn workflow without weakening Purrmission's governance model.

## 8. Draft Issue Breakdown

- Epic: Passkey-Aware Access and Custody.
- Issue: Seed private soft-fork and protect it from accidental public release.
- Issue: Build local WebAuthn test relying party.
- Issue: Spike Chromium WebAuthn proxy and native messaging.
- Issue: Define Prisma schema for passkey metadata, devices, leases, and audit.
- Issue: Add experimental API routes for device enrollment and lease polling.
- Issue: Add Discord approval cards for passkey signing requests.
- Issue: Implement local signer PoC with local encrypted storage.
- Issue: Validate `rpId`, origin, challenge, and credential ID matching.
- Issue: Add credential/device revocation and member offboarding.
- Issue: Document recovery-code and hardware-key fallback workflows.
- Issue: Build compatibility matrix for GitHub, Google, AWS, Cloudflare, and
  other high-priority relying parties.
- Issue: Mobile companion feasibility spike for Android and iOS.
- Issue: Threat-model review before OSS merge-back.

## 9. Open Questions

- Which target site should be the first real compatibility milestone after the
  local relying party?
- Does the first release require shared managed passkeys, or can we ship
  member-isolated passkeys plus a custody ledger first?
- How much cross-browser support is required before leaving experimental status?
- Should mobile sign directly, authorize desktop signing, or both?
- What exact recovery policy should be mandatory for shared managed passkeys?
- Can we safely support importing/exporting passkeys, or should we wait for
  FIDO Credential Exchange maturity?
- Should attestation be stored and surfaced to guardians, or treated as an
  advanced diagnostic until relying parties force it?

## 10. Research References

- W3C Web Authentication Level 3: https://www.w3.org/TR/webauthn-3/
- MDN Web Authentication API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API
- FIDO passkeys overview: https://fidoalliance.org/passkeys/
- FIDO Credential Exchange specifications: https://fidoalliance.org/specifications-credential-exchange-specifications/
- Chrome `webAuthenticationProxy` extension API: https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy
- Android Credential Manager: https://developer.android.com/identity/credential-manager
- Apple passkeys overview: https://developer.apple.com/passkeys/
- Bitwarden passkey autofill docs: https://bitwarden.com/help/storing-passkeys/
- 1Password passkey browser docs: https://support.1password.com/save-use-passkeys/
