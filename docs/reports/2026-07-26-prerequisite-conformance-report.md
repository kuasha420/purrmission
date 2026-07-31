# Prerequisite Conformance Report (Issue #126)

- Candidate revision: `e4269cea4d6f` (`master`)
- Review date: 2026-07-26
- Runtime: Node `v24.12.0`, pnpm `9.15.9`
- Schema: 15 migrations through `20260724113000_add_callback_destinations`
- Reviewer: independent Codex verification requested by the repository owner; no authorship in
  prerequisite implementation PRs #132-#137
- Decision: **No-go**

> **Historical evidence notice:** This report is the immutable No-go baseline for
> `e4269cea4d6f`, not the live remediation tracker. #117 implementation later merged through #139
> at `edd9c3497909bb71b265300ffa201038edea54ef`, but independent verification against
> `a1f2004141f90376c0084b7b2156297de92dd6f7` returned No-go on 2026-07-31 and reopened #117. See the
> [execution graph](../epics/rbac-prerequisite-execution-graph.md) for current progress. The findings
> below remain unchanged until #126 performs a fresh pinned-`master` reassessment.

This report supersedes the earlier Go report at this path. That report pinned pre-merge commit
`19eea3b`, linked to local Windows files, claimed zero lint warnings, and did not trace the complete
prerequisite contract. Verification of merged `master` does not support its conclusion.

## Executive result

The prerequisite epic is incomplete. New typed principals, capability vocabulary, approval grants,
metadata projections, credential records, TOTP consent records, audit fields, and an outbox have
been introduced, but the existing surfaces have not been coherently cut over to them. The candidate
does not compile, a populated database cannot apply the hardening migration, the full test command
does not complete, and live Discord/HTTP/Pawthy paths retain contract-breaking authorization and
sensitive-data behavior.

Per #126's No-go procedure, #116, #124, and #126 must be reopened. Contract-owning implementation
issues must be reopened or replaced with blocking remediation issues before #124 and #126 are run
again. No OAuth/session or Web Dashboard implementation phase should be filed yet.

## Reproduction and repository gates

| Gate                             | Result               | Evidence                                                                                                                                                                                      |
| -------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote sync                      | Pass                 | Clean `master` fast-forwarded from `3059777` to `e4269cea4d6f` before verification.                                                                                                           |
| `pnpm install --frozen-lockfile` | Pass                 | Dependencies installed without changing the lockfile.                                                                                                                                         |
| `pnpm prisma:generate`           | Pass                 | Prisma client generation completed.                                                                                                                                                           |
| `pnpm lint`                      | Conditional pass     | Exit 0 with 77 warnings, including production `any` and non-null assertions; the prior “0 warnings” claim is false.                                                                           |
| `pnpm format:check`              | Fail                 | `pnpm-lock.yaml` is not formatted. This is not a #126 Go criterion but confirms the candidate is not clean under all repository checks.                                                       |
| `pnpm build`                     | **Fail**             | Bot TypeScript fails across policy/model drift, audit call shapes, principal identity fields, repository contracts, private dependency access, grant-consumption signatures, and stale mocks. |
| Bot tests                        | Partial pass         | 28/28 bot test files pass under the runtime-transpiling test runner despite the TypeScript build failure.                                                                                     |
| Pawthy tests                     | **Fail/incomplete**  | The full suite stalls; isolated `pull.test.ts` times out while polling a pending response. Other isolated Pawthy suites pass except an environment-sensitive config fixture.                  |
| `pnpm dev:ops:test`              | Pass                 | Operational script tests complete.                                                                                                                                                            |
| Fresh migration SQL              | Pass with limitation | All migration SQL applies to an empty SQLite database when rehearsed directly. `prisma migrate deploy` returned a generic schema-engine error in this verification environment.               |
| Populated upgrade migration      | **Fail**             | Representative legacy rows fail the hardening migration on required `AuditLog.eventType`, `Project.policyVersion`, `Resource.version`, and `TOTPAccount.version` columns.                     |
| GitHub evidence gate             | **Fail**             | PR #137 has no reviews or status checks. Earlier implementation PRs retain unresolved review threads, and the closed child issues contain no post-merge verification comments.                |

Because `pnpm build`, `pnpm test`, and the populated upgrade path do not pass, #126's start and Go
criteria are not met even before contract-level findings are considered.

## Requirement-to-evidence trace

| Contract area                                          | Implementation evidence                                                        | Verification evidence                                                                                                                                                                                                                                                                         | Result        | Owning node      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------- |
| Typed principal and exact-object capability evaluation | `domain/models.ts:475-601`, `domain/policy.ts`                                 | Adapters and `DomainPortsImpl` frequently authorize with role booleans and use credential `Principal.id` where human `subjectId` is required. Required own-session/token capabilities and decision context are absent.                                                                        | **Fail (P1)** | #117, #127       |
| Writer/Guardian separation                             | `domain/policy.ts:36-180`, `domain/services.ts:601-605`                        | `getEffectiveGuardians` still synthesizes Writers as Guardians; explicit Guardians and Writers retain direct protected access through legacy checks.                                                                                                                                          | **Fail (P1)** | #117             |
| Approval Request V2 and one-time grants                | `domain/services.ts:260-440`, `domain/repositories.ts:1232-1251`               | Decision remains read-then-update-by-ID rather than a conditional `PENDING` transition; legacy approved requests remain reusable authorization. Requests/grants omit required exact target, canonical set/digest, idempotency, lifecycle, and resolver bindings.                              | **Fail (P1)** | #122             |
| Secret metadata/reveal boundary                        | `domain/ports_impl.ts:110-156`, `http/server.ts:556-656`                       | Reveal is GET, grant ID is in the URL, filtering occurs after all values are loaded, and no durable reveal audit is queued before decryption/return. Legacy field routes still reveal and mutate under broad Guardian checks.                                                                 | **Fail (P1)** | #119, #127, #129 |
| TOTP custody and delegated reveal                      | `domain/services.ts:1161-1365`                                                 | Consent records and version checks exist, but delegation-consent creation does not authenticate the seed owner, optional policy arrays default allow, and consent is consumed during reveal rather than matching grant issuance. Legacy resource adapters still grant Writer/Guardian access. | **Fail (P1)** | #120, #128, #129 |
| Resource and Pawthy credential lifecycle               | `domain/services.ts:615-634,799-817`, `prisma/schema.prisma:310-333`           | Resource creation still persists and returns a plaintext `Resource.apiKey` without a matching Credential; verification only reads Credential digests. Resource-key HMAC lookup does not honor the configured rotation key ring. CLI token inventory/revocation is absent.                     | **Fail (P1)** | #121, #130       |
| Durable audit and correlation                          | `domain/models.ts:329-369`, audit call sites                                   | The envelope lacks required surface/route/capability/decision/target/source fields, event coverage and scoped read/export APIs are incomplete, audit is optional on sensitive paths, and correlation is not propagated end-to-end.                                                            | **Fail (P1)** | #118             |
| Transactional outbox and callback delivery             | `domain/outbox_worker.ts`, `domain/webhook.ts`, `prisma/schema.prisma:335-347` | Events have no atomic claim/lease, retry envelopes receive a new nonce, non-2xx responses are accepted as success, signing secrets are plaintext, destinations start enabled without verification, and missing Discord delivery can be marked processed.                                      | **Fail (P1)** | #123             |
| Discord command cutover                                | `discord/commands/resource.ts:350,631-636,946-951,1039-1214`                   | Resource commands still call legacy effective-Guardian/access policy, synchronously DM Guardians, expose plaintext API keys, and contain stale TOTP metadata calls that contribute to build failure.                                                                                          | **Fail (P1)** | #128             |
| Fastify cutover                                        | `http/server.ts:556-815`                                                       | Project/field/TOTP routes retain adapter-local authorization; field values are exposed to effective Guardians; reveal semantics, no-store coverage, server-side selection, error mapping, and approval throttling do not meet the contract.                                                   | **Fail (P1)** | #129             |
| Pawthy cutover                                         | `pawthy/src/commands/pull.ts:83-181`                                           | Pull uses GET plus a query-string grant, does not propagate correlation IDs, and the pending polling path leaves its test unresolved. Token lifecycle commands are absent.                                                                                                                    | **Fail (P1)** | #130             |
| Migration and legacy-data preservation                 | `20260724110200_rbac_dashboard_hardening_remediations/migration.sql:76-179`    | Table-copy statements omit required new columns and fail when legacy tables contain rows. Plaintext Resource keys are copied rather than migrated to digested credentials; legacy audit meaning is not preserved.                                                                             | **Fail (P1)** | #118, #121, #124 |

## Positive evidence retained

The verification found useful substrate that should be repaired rather than discarded:

- metadata-only Resource field and TOTP projections exist;
- the Guardian resource/user uniqueness constraint exists;
- resource-owner checks exist for API-key minting;
- TOTP link consent and seed/link version fields exist;
- approval decisions group grant, audit, callback-outbox writes in a transaction;
- batch secret writes use a shared transactional service path;
- callback dispatch pins validated DNS results, rejects redirects, and signs value-free payloads;
- the outbox worker is wired into bot startup;
- bot and operations tests provide a base to extend once compilation and contract tests are fixed.

These are partial implementations, not evidence that the complete contract is enforced.

## Required recovery sequence

1. Reopen #116, #124, and #126 and change their checked completion claims back to open work.
2. Reopen or file blockers under #117-#123 and #127-#130 using the P1 rows above; restore native
   dependencies from those issues into #124.
3. Repair the populated upgrade migration first and add representative legacy-data fixtures plus
   backup/restore evidence. Keep production rollout blocked until this passes.
4. Make the repository compile, then converge every adapter on the typed policy-aware use cases.
   Remove or fail closed all legacy effective-Guardian, reusable-approved-request, plaintext-key,
   metadata-decryption, and adapter-local authorization paths.
5. Complete credential, approval/grant, TOTP-consent, audit/correlation, and outbox-delivery contracts
   with concurrency, replay, rotation, redaction, failure-injection, and cross-object negative tests.
6. Cut over Pawthy to POST-style exact-key reveal and complete its token lifecycle and bounded polling
   tests.
7. Rerun #124 on a new clean pinned `master`: install, generate, lint, build, full tests, fresh and
   populated migrations, rollback/restore, and the full cross-surface role/action matrix.
8. Assign a reviewer who authored none of the remediation implementation to rerun #126. Only a
   fully evidenced Go may restore the knowledgebase completion banner and authorize filing the
   OAuth/session and Web Dashboard phases.

## Sign-off

**No-go at `e4269cea4d6f`.** The prerequisite contract is not implemented consistently enough to
serve as the stable backend specification for Discord OAuth sessions or the Web Dashboard. The next
phase is remediation and re-verification, not dashboard issue definition.
