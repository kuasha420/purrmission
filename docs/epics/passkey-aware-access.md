# Epic Tracker: Passkey-Aware Access

Status: Draft  
Source design: [Passkey-Aware Access](../design/passkey-aware-access.md)  
Target private track: `purrfectsoft/purrmission`

## Epic Statement

Enable Purrmission to govern, approve, audit, and eventually satisfy WebAuthn
2FA/passkey ceremonies for shared operational accounts, while keeping private
keys at the edge and preserving local user verification.

## Current Private Repo State

`purrfectsoft/purrmission` is reachable through the GitHub connector and appears
empty. The local `gh` token is currently invalid, so the repo still needs a real
authenticated git seed from the OSS checkout before sprint implementation starts.

Recommended seed command once GitHub auth is repaired:

```bash
gh auth login -h github.com
git remote add purrfectsoft git@github.com:purrfectsoft/purrmission.git
git push purrfectsoft master:master
```

If SSH auth is not available, use the HTTPS remote shown by GitHub for the
private repository.

## Milestones

| Milestone | Goal                                                    | Exit Criteria                                                                      |
| --------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Sprint 0  | Soft-fork, discovery, local WebAuthn test relying party | Private repo seeded; local create/get ceremony documented.                         |
| Sprint 1  | Core ledger, devices, leases, audit                     | Purrmission can approve and audit passkey use attempts without production signing. |
| Sprint 2  | Desktop companion PoC                                   | Chromium extension/native signer completes test ceremonies.                        |
| Sprint 3  | Guardian-gated signing                                  | Signing requires guardian lease plus local unlock.                                 |
| Sprint 4  | Recovery and hardening                                  | Device loss, member removal, and credential rotation workflows exist.              |
| Sprint 5  | Mobile companion spike                                  | Android/iOS feasibility known; role of mobile decided.                             |
| Sprint 6  | OSS graduation                                          | Docs, tests, threat model, compatibility matrix, and migration path are ready.     |

## Initial Issues

| ID      | Title                                       | Sprint | Notes                                                                                  |
| ------- | ------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| PAA-001 | Seed private soft-fork                      | 0      | Requires valid GitHub auth with `purrfectsoft` write access.                           |
| PAA-002 | Create local WebAuthn relying-party harness | 0      | Use for deterministic create/get tests before touching real websites.                  |
| PAA-003 | Spike Chromium WebAuthn proxy feasibility   | 0      | Validate `chrome.webAuthenticationProxy`, native messaging, and cancellation behavior. |
| PAA-004 | Define passkey metadata schema              | 1      | Cover credentials, devices, envelopes, approval leases, and audit.                     |
| PAA-005 | Add experimental feature flag               | 1      | Keep all passkey work opt-in until OSS graduation.                                     |
| PAA-006 | Add device enrollment API                   | 1      | Bind member identity to device public keys and local capabilities.                     |
| PAA-007 | Add passkey approval lease API              | 1      | Scope leases by requester, device, credential, `rpId`, and expiration.                 |
| PAA-008 | Add Discord approval cards                  | 1      | Show relying party, account/resource, requester, device, and timeout.                  |
| PAA-009 | Implement desktop signer PoC                | 2      | Local encrypted storage first; OS-backed storage if practical.                         |
| PAA-010 | Implement browser extension PoC             | 2      | Minimal UI: credential chooser, pending approval, success/failure.                     |
| PAA-011 | Validate ceremony security invariants       | 2      | Tests for origin, `rpId`, credential ID, challenge, replay, timeout.                   |
| PAA-012 | Wire guardian approval to signing           | 3      | No assertion without approved lease and local unlock.                                  |
| PAA-013 | Add revocation/offboarding workflows        | 4      | Device revoke, credential revoke, member removal, audit visibility.                    |
| PAA-014 | Track recovery methods                      | 4      | Backup codes, hardware keys, alternate passkeys, owner runbook.                        |
| PAA-015 | Build relying-party compatibility matrix    | 4      | Start with GitHub, Google, AWS, Cloudflare, and one Discord-adjacent service.          |
| PAA-016 | Spike Android companion support             | 5      | Credential Manager provider/signing feasibility.                                       |
| PAA-017 | Spike iOS companion support                 | 5      | Authentication Services/passkey provider feasibility.                                  |
| PAA-018 | Write public threat model                   | 6      | Required before merge-back to OSS.                                                     |

## Experimental Graduation Criteria

- At least one real relying party works end to end in a documented workflow.
- Purrmission Core cannot sign WebAuthn assertions without a companion device.
- Guardian approval and local user verification are both enforced.
- Member/device revocation is tested.
- Recovery and backup workflows are documented.
- Unsupported relying-party policies are visible to users instead of silent.
- The compatibility matrix is explicit about browser, OS, and site constraints.
