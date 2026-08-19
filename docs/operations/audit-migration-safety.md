# Audit, Outbox, and Populated-Upgrade Operations

Issue #118 introduces the version 2 audit envelope, signed outbox records, and the forward-only
`20260801010000_complete_audit_envelope` migration. The published
`20260724110200_rbac_dashboard_hardening_remediations` migration is immutable: changing it would
break Prisma migration checksums on every database where it has already been recorded.

## Production migration gate

Do **not** run `pnpm exec prisma migrate deploy` directly against an existing SQLite database that
predates `20260724110200`. That published migration copies legacy `AuditLog` rows into a table with
required typed columns but does not backfill those columns. A non-empty legacy table therefore
fails part-way through deploy. Related populated-table hazards are owned by #117 and #121.

The supported `pnpm prisma:deploy` entrypoint composes the shared migration preflight with the
exported `stageLegacyAuditLogs` and `restoreLegacyAuditLogs` primitives in
`scripts/legacy-audit-upgrade.ts`. Its required order is:

1. Complete and verify the database backup/restore procedure tracked by #105.
2. Open the same SQLite database used by Prisma and acquire an immediate write transaction.
3. Stage every legacy row in-database, validate per-row and aggregate checksums, and clear source
   rows only after the staged count and checksums match.
4. Run Prisma migration deploy. A nonzero preflight or deploy result stops the release.
5. Restore transformed version 2 envelopes, validate restored counts, then and only then remove raw
   staging rows and retain the non-sensitive completion manifest.
6. Re-run the restore function after an interrupted release. It is idempotent, but an existing
   completion manifest is accepted only after source and transformed row anchors are rechecked.

The migration helper logs only state and row counts. It never logs row JSON, legacy context,
checksums tied to individual records, keys, or database contents. Corrupt or conflicting staging
fails closed and remains available for operator recovery.

## Retention, integrity, and privacy

- `AUDIT_INTEGRITY_KEY` and `OUTBOX_INTEGRITY_KEY` are distinct 32-byte HMAC keys. Their JSON key
  rings retain historical keys by ID so old audit records and pending outbox envelopes remain
  verifiable during rotation. `legacy-unverified` is never accepted as a verification key.
- `AUDIT_RETENTION_DAYS` configures the retention cutoff. `executeRetention` first persists and
  verifies an `AuditCheckpoint`, then deletes only expired `OPERATIONAL` and `PRIVACY` events;
  `SECURITY` evidence is retained.
- `AUDIT_CHECKPOINT_INTERVAL` configures cadence. Checkpoints are HMAC-protected, chain to the
  preceding checkpoint digest, and are persisted in the dedicated `AuditCheckpoint` sink. Startup
  and the 15-minute cleanup scheduler call `runMaintenance`, so both cadence and retention are
  enforced operationally rather than remaining library-only capabilities.
- `pseudonymizeSubject` checkpoints verified original evidence, replaces direct subject identifiers
  with a keyed pseudonym, re-signs each transformed envelope, and appends a
  `PRIVACY_PSEUDONYMIZE` event linked to the original-event digest. The mutation and transformation
  audit event share one repository transaction and fail closed together.
- Raw legacy context is not copied into the version 2 payload because its shape and secret status
  cannot be proven. The transformed event records that legacy context was discarded and retains
  the original-row checksum as migration evidence.

Until #105 supplies demonstrated backup/restore evidence, production migration remains blocked
even when fresh and populated-database rehearsals pass.

## Current-surface emission ownership

The event catalog is not treated as coverage by itself. Current operations emit the following
records, and `audit_event_coverage.test.ts` exercises the families together:

| Current operation                                                        | Required records                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Device authorization and Pawthy/service/resource credential validation   | auth-session lifecycle and credential-use allow/deny                             |
| Project creation and member add/remove                                   | project/member lifecycle                                                         |
| Environment creation and its backing resource creation; guardian changes | environment/resource configuration lifecycle                                     |
| Callback destination registration/deletion                               | transactionally paired configuration event with the acting principal             |
| Protected request decisions                                              | authorization allow/deny, decision, grant issue, and callback enqueue            |
| Approval grant consumption                                               | grant-consume before the protected transaction commits                           |
| Secret and TOTP mutations/reveals                                        | redacted secret/TOTP lifecycle; reveal audit must persist before materialization |
| Guardian notification and callback outbox processing                     | delivery attempt plus success, no-op, or failure outcome                         |
| Scoped audit reads/exports                                               | separately authorized and audited read/export records                            |

### Family delivery checkpoint

| Required family         | #118 emitted and tested                                                                         | Deferred adoption owner                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Authentication          | Device initiate/approve/exchange/expiry/cleanup, credential allow/deny, and credential mint/use | #121 extends final credential digest rotation and revocation paths        |
| Project/membership      | Project create and member add/remove                                                            | Later product issues add events when project update/delete surfaces exist |
| Resource/configuration  | Environment/resource create, guardian change, API-key lifecycle                                 | #119 adds target-version metadata without decrypting values               |
| Authorization           | Actual allow and deny decisions for request resolution and current protected secret reads       | Each successor must instrument any new capability surface it introduces   |
| Secret lifecycle        | Create/update/delete and Discord/HTTP reveal; payloads contain identifiers only                 | #119 owns final exact-key metadata/decryption boundary adoption           |
| TOTP lifecycle          | Account create/update, link/unlink, code/recovery reveal, and throttle/deny outcomes            | #122 owns final consent/custody lifecycle expansion                       |
| Request/grant lifecycle | Request create/expiry, decision, grant issue/consume                                            | #120 and #127 own uniqueness and final atomic decision/reveal composition |
| Delivery                | Enqueue plus existing-worker attempt/outcome instrumentation                                    | #123 owns leasing, retry, destination verification, and delivery redesign |
| Audit access            | Capability-scoped read/export attempts and outcomes                                             | #124 validates integrated projections and operator exposure               |

“Deferred” means successor-specific mechanics or new surfaces; it does not weaken the #118
requirement that the listed current operations emit durable events today.

`ApprovalService`, `ResourceService`, `ProjectService`, `AuthService`, `DomainPortsImpl`, and
`OutboxWorker` reject construction without an audit dependency. Delivery workers verify the signed
outbox envelope before dispatch, retain the enqueue correlation ID across attempts, use the outbox
ID as causation, and persist only stable error codes. The repository container requires an explicit
unit-of-work capability; audited mutations cannot silently fall back to non-transactional writes.
Before an external side effect the worker durably marks `DELIVERY_IN_PROGRESS`, removing the event
from the normal pending queue. After a known success it marks `DELIVERED_PENDING_AUDIT`; ambiguous
network outcomes, partial multi-destination delivery, marker failures after dispatch, and outcome
audit failures are therefore handed to #123 reconciliation without automatically repeating a side
effect. Leasing and complete reconciliation mechanics remain #123-owned. Later lifecycle issues can
add new mechanics and event types, but must use these required primitives rather than introducing
optional or best-effort audit paths.
