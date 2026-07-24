# Purrmission RBAC and Observability Knowledgebase

- Status: Phase 1 technical specification; prerequisite remediation in progress
- Preparation issue: [#107](https://github.com/kuasha420/purrmission/issues/107) (complete)
- Prerequisite epic: [#116](https://github.com/kuasha420/purrmission/issues/116)
- Execution graph:
  [Pre-Dashboard RBAC Prerequisite Execution Graph](../epics/rbac-prerequisite-execution-graph.md)
- Readiness gate: [#126](https://github.com/kuasha420/purrmission/issues/126)
- Dashboard readiness: Blocked until #126 records Go
- Baseline audited revision: `9eedd4d` (`master`, 2026-07-24)
- Applies to: Discord commands, the Fastify API, Pawthy, and the future
  `apps/purrmission-web`

## 1. Purpose and normative language

This document is the authorization and observability source of truth for the phased
Discord-authenticated Purrmission dashboard. It has two deliberately separate parts:

1. **Observed behavior** records what the current code does, including inconsistencies and unsafe
   behavior that must not become an accidental compatibility contract.
2. **Target policy** defines the least-privilege contract that future HTTP and web-dashboard work
   must implement.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative in target-policy sections.
Current-state sections are descriptive only.

### 1.1 Delivery-phase classification

Normative requirements are implemented and verified in four delivery classes. A later-phase
requirement remains authoritative design, but it is not a pass/fail criterion for the prerequisite
readiness gate in #126.

| Class               | Delivery boundary                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `PREREQUISITE`      | Existing Discord, HTTP, Pawthy, domain, persistence, credential, approval, TOTP, audit, and delivery contracts under #116       |
| `OAUTH_SESSION`     | Discord OAuth endpoints, browser sessions/cookies, CSRF/Origin, recent-auth, and web-session inventory after #126 records Go    |
| `DASHBOARD_BACKEND` | Dashboard-specific routes, web DTO composition, session-backed web transport, and dashboard data-fetch behavior after OAuth     |
| `DASHBOARD_UI`      | `apps/purrmission-web`, router/control gates, reveal/clipboard UX, and client cache behavior after backend contracts are stable |

The authoritative section mapping is:

| Knowledgebase content                    | Delivery class and #126 treatment                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sections 3-5                             | Current-state evidence and `PREREQUISITE` remediation inventory                                                    |
| Sections 6.1-6.9                         | `PREREQUISITE` domain policy, except sentences explicitly limited to browser sessions, recent-auth, or UI behavior |
| Section 7                                | `OAUTH_SESSION`; excluded from #126 implementation evidence                                                        |
| Sections 8.1 and 8.4                     | `DASHBOARD_BACKEND`; #126 verifies only their prerequisite evaluator, metadata, versioning, and DTO substrate      |
| Sections 8.2 and 8.3                     | `DASHBOARD_UI`; excluded from #126 implementation evidence                                                         |
| Section 9                                | `PREREQUISITE` for current-surface envelopes/events; OAuth/web-session event instances remain `OAUTH_SESSION`      |
| Section 10, items 1-9                    | `PREREQUISITE`; future principal variants are modeled but their authenticators are not implemented                 |
| Section 10, item 10                      | CLI token inventory/revocation is `PREREQUISITE`; web-session inventory/revocation is `OAUTH_SESSION`              |
| Section 11 prerequisite list             | Required by #126                                                                                                   |
| Section 11 deferred OAuth/dashboard list | Required only in the named later phase                                                                             |

If a clause mixes classes, #126 verifies the `PREREQUISITE` substrate and records the later-phase
behavior as deferred—not failed and not implemented. Moving a requirement between classes requires
an explicit knowledgebase change with security review; implementation issues cannot reclassify it.

The central rule is:

> Authentication establishes a Discord user ID. Authorization is evaluated from current
> server-side relationships for every object and action. A role shown in the UI is never proof of
> permission.

## 2. Executive decisions

- Discord snowflakes, stored as strings, are the canonical human identity.
- Project and resource roles are object-scoped. A user can be an Owner in one project, a Reader in
  another, a Guardian for one resource, and a Requester elsewhere.
- `REQUESTER` is not a persisted membership role. It is a relationship between an authenticated
  actor and a specific approval request or grant.
- Project Owner and Writer inheritance is resolved dynamically:
  - Project Owner receives Owner capabilities on every linked environment resource.
  - Project Writer receives environment update and secret read/write capabilities on every linked
    environment resource.
  - Project Reader receives read-only project, environment, and secret capabilities. Reader does
    not inherit approval authority.
- An explicit Resource Guardian is an **approver**, not a secret reader or resource editor, in the
  target policy. This intentionally narrows the current behavior.
- Project Writer does not inherit approval authority in the target policy. This intentionally
  removes today's synthetic-Guardian privilege and keeps Writer and Guardian responsibilities
  separate.
- Approved access is a scoped grant, not a temporary role. A grant binds actor, operation, target,
  and expiry and is consumed according to its grant type.
- Web sessions carry identity only. Roles and capabilities MUST NOT be snapshotted into a cookie,
  bearer token, or long-lived session.
- UI gating improves safety and clarity, but the API remains the enforcement boundary.
- Secret lists and TOTP lists use metadata-only queries. Sensitive values MUST NOT be decrypted,
  returned, or preloaded until an authorized reveal operation.
- Durable auditability is part of the security boundary for sensitive reads, writes, role changes,
  and approval decisions.

## 3. Domain vocabulary and current persistence model

### 3.1 Persisted roles

| Scope    | Persisted role | Current source                                              |
| -------- | -------------- | ----------------------------------------------------------- |
| Project  | Owner          | `Project.ownerId`                                           |
| Project  | Writer         | `ProjectMember.role = WRITER`                               |
| Project  | Reader         | `ProjectMember.role = READER`                               |
| Resource | Owner          | `Guardian.role = OWNER`                                     |
| Resource | Guardian       | `Guardian.role = GUARDIAN`                                  |
| Approval | Requester      | Not a role; currently `ApprovalRequest.context.requesterId` |

The schema definitions are in `prisma/schema.prisma:15-25,65-95,168-217`. Domain types are in
`apps/purrmission-bot/src/domain/models.ts:46-76,157-183,297-360`.

### 3.2 Effective role resolution today

For a resource linked to a project environment, `getEffectiveGuardians` currently unions:

1. explicit `Guardian` rows;
2. the Project Owner as a synthetic Resource Owner; and
3. every Project Writer as a synthetic Resource Guardian.

Readers are excluded. The calculation occurs on each policy call, so Writer promotion grants
authority across current and future environment resources, while demotion or removal revokes it on
the next check. See `apps/purrmission-bot/src/domain/policy.ts:85-173`.

Effective Resource Owner means either an explicit Resource Owner row or the linked Project Owner
(`policy.ts:178-207`).

Environment creation also creates a persisted Resource Owner row for the current Project Owner
(`domain/project.ts:32-45`, `domain/services.ts:313-336`). There is no ownership-transfer workflow.
A later transfer would leave the former owner with an explicit Owner grant unless data is
reconciled.

### 3.3 Target ownership rule

For a project-linked resource, `Project.ownerId` MUST be the canonical source of ownership.
Persisted Resource Owner rows created as mirrors MUST NOT independently preserve access after a
project ownership transfer. A migration or reconciliation step must remove stale mirrors before an
ownership-transfer feature ships.

For a standalone resource, an explicit Resource Owner has Owner capabilities only for that
resource; it does not confer any project capability.

## 4. Current surface audit

The following matrices describe the code at the audited revision. They are not the target
dashboard policy.

### 4.1 Discord slash commands

Legend:

- **Direct**: action succeeds without approval.
- **Approval**: actor can request a grant when they know the resource/field.
- **Own account**: governed by TOTP ownership rather than project RBAC.
- **No**: no supported path under that role alone.

| Command/action                     | Owner                            | Writer   | Reader      | Explicit Guardian     | Requester/other       |
| ---------------------------------- | -------------------------------- | -------- | ----------- | --------------------- | --------------------- |
| `/purrmission guardian add/remove` | Direct                           | No       | No          | No                    | No                    |
| `/purrmission guardian list`       | Direct                           | Direct   | No          | Direct                | No                    |
| `/resource register`               | Any Discord caller becomes Owner | Same     | Same        | Same                  | Same                  |
| `/resource list`                   | Direct                           | Direct   | No          | Assigned resources    | No                    |
| `/resource fields add/list/remove` | Direct                           | Direct   | No          | Direct                | No                    |
| `/resource fields get`             | Direct                           | Direct   | Approval    | Direct                | Approval              |
| `/resource 2fa link/unlink`        | Direct                           | Direct   | No          | Direct                | No                    |
| `/resource 2fa get`                | Direct                           | Direct   | Approval    | Direct                | Approval              |
| `/project member add/remove`       | Direct                           | No       | No          | No                    | No                    |
| `/project member list`             | Direct                           | Direct   | Direct      | Only if also a member | Only if also a member |
| `/access request`                  | Unneeded                         | Unneeded | May request | Unneeded              | May request           |
| `/access approve/deny`             | Direct                           | Direct   | No          | Direct                | No                    |
| `/auth login`                      | Code possession, no role gate    | Same     | Same        | Same                  | Same                  |
| `/2fa add uri/secret`              | Creates own account              | Same     | Same        | Same                  | Same                  |
| `/2fa add qr`                      | Stub response; creates nothing   | Same     | Same        | Same                  | Same                  |
| `/2fa list shared:false`           | Own accounts                     | Same     | Same        | Same                  | Same                  |
| `/2fa list shared:true`            | Every globally shared account    | Same     | Same        | Same                  | Same                  |
| `/2fa get`                         | Own or any globally shared entry | Same     | Same        | Same                  | Same                  |
| `/2fa update`                      | Own account only                 | Same     | Same        | Same                  | Same                  |
| DM text `status`                   | Direct                           | Direct   | No          | Direct                | No                    |

Important command details:

- `/purrmission` is only a grouped alias for Guardian add/remove/list. `/guardian` duplicates the
  same surface (`discord/commands/guardian.ts:19-140`,
  `discord/commands/index.ts:68-70`).
- `/project` exposes only member add/remove/list. It has no project or environment creation
  commands (`discord/commands/project.ts:18-101`).
- Commands are deployed to one configured guild, but no Discord role or default-member-permission
  gate is configured (`discord/registerCommands.ts:18-24`).
- `/resource register` returns the new plaintext API key in an ephemeral response
  (`discord/commands/resource.ts:353-406`).
- Resource discovery and autocomplete include Owner, Writer, and explicit Guardian assignments but
  exclude Reader and Requester (`domain/policy.ts:212-261`,
  `discord/commands/resourceAutocomplete.ts:8-40`).
- Field autocomplete plus the names-only Discord and HTTP field-list paths load full field records
  through `findByResourceId`, which decrypts every value before discarding it from the response
  (`domain/repositories.ts:494-500,536-560`).
- `/access request` therefore asks a Requester for a resource ID while its autocomplete hides every
  resource that the Requester does not already guard.
- The standalone `/2fa` model is orthogonal to project roles. Any Discord user can create an
  account. The current repository treats every account marked `shared` as visible to every user,
  including its decrypted backup key (`domain/repositories.ts:424-459`,
  `discord/commands/twoFa/subcommands/get.ts:34-83`).
- `/2fa update` changes only the backup key, and there is no `/2fa delete` action.
- The DM-only text command `status` lists effective guarded resources and their pending request
  IDs, resource IDs, status, and expiry. Its effective-Guardian lookup includes linked Project
  Owners and Writers (`discord/client.ts:166-228`). The registered `/check-dm-connectivity`
  diagnostic has no RBAC decision.

Primary command anchors:

- resource and secret fields: `discord/commands/resource.ts:39-180,412-775`
- linked TOTP: `discord/commands/resource.ts:780-1033`
- project membership: `discord/commands/project.ts:18-216`
- access decisions: `discord/commands/access.ts:18-95`, `domain/services.ts:140-250`
- CLI login approval: `discord/commands/auth.ts:12-92`
- standalone TOTP: `discord/commands/twoFa/`
- DM status: `discord/client.ts:166-228`

### 4.2 HTTP API

| Route                                                      | Current authentication   | Current authorization and exposure                                                                                  |
| ---------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                              | Public                   | Returns timestamp and Discord connection state.                                                                     |
| `POST /api/requests`                                       | Resource API key in body | API key must resolve to the supplied resource. Context, callback URL, expiry, and channel ID are caller-controlled. |
| `GET /api/requests/:id`                                    | Public                   | UUID possession reveals status, resource ID, arbitrary context, timestamps, and resolver Discord ID.                |
| `POST /api/auth/device/code`                               | Public                   | Creates a 30-minute device session. No rate limit.                                                                  |
| `POST /api/auth/token`                                     | Device-code possession   | Mints an unscoped 90-day Pawthy bearer after Discord approval.                                                      |
| `POST /api/projects`                                       | Pawthy bearer            | Any authenticated user creates a project and becomes Owner.                                                         |
| `GET /api/projects`                                        | Pawthy bearer            | Returns owned projects only; Writer and Reader projects are omitted.                                                |
| `GET /api/projects/:projectId`                             | Pawthy bearer            | Project Owner only.                                                                                                 |
| `POST /api/projects/:projectId/environments`               | Pawthy bearer            | Project Owner only.                                                                                                 |
| `GET /api/projects/:projectId/environments`                | Pawthy bearer            | Project Owner only.                                                                                                 |
| `GET /api/projects/:projectId/environments/:envId/secrets` | Pawthy bearer            | Owner, Writer, Reader, or effective Guardian receives all values. Others create/reuse approval.                     |
| `PUT /api/projects/:projectId/environments/:envId/secrets` | Pawthy bearer            | Owner or Writer. Body is not validated; parallel upserts are non-transactional.                                     |
| `GET /api/resources/:id/fields`                            | Pawthy bearer            | Any effective Guardian; returns names.                                                                              |
| `POST /api/resources/:id/fields`                           | Pawthy bearer            | Any effective Guardian; returns the newly created field including its value.                                        |
| `GET /api/resources/:id/fields/:name`                      | Pawthy bearer            | Any effective Guardian; returns plaintext value.                                                                    |
| `DELETE /api/resources/:id/fields/:name`                   | Pawthy bearer            | Any effective Guardian.                                                                                             |
| `GET /api/resources/:id/2fa`                               | Pawthy bearer            | Any effective Guardian; returns a live TOTP code.                                                                   |
| `POST /api/resources/:id/2fa/link`                         | Pawthy bearer            | Any effective Guardian; account ownership is not checked at this layer.                                             |
| `DELETE /api/resources/:id/2fa/link`                       | Pawthy bearer            | Any effective Guardian.                                                                                             |

Route implementation: `apps/purrmission-bot/src/http/server.ts:46-723`.

The route-local authentication hook recognizes only a Bearer token and attaches
`{ id: apiToken.userId }` (`http/server.ts:278-292`). The token has no audience, scopes, auth kind,
or session identifier. Most authenticated authorization failures use `AccessDeniedError` and are
reported as `401`; only secret writes use `ForbiddenError` and return `403`
(`http/server.ts:313-343,557-566`).

### 4.3 Pawthy CLI

| Pawthy action                         | HTTP route                   | Current effective access                                         |
| ------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `pawthy login` initiate               | `POST /api/auth/device/code` | Public                                                           |
| `pawthy login` approve                | Discord `/auth login`        | Any Discord user possessing a pending user code                  |
| `pawthy login` exchange               | `POST /api/auth/token`       | Device-code possession                                           |
| `pawthy init` list projects           | `GET /api/projects`          | Owner projects only                                              |
| `pawthy init` create project          | `POST /api/projects`         | Any authenticated user; becomes Owner                            |
| `pawthy init` list/create environment | Project environment routes   | Owner only                                                       |
| `pawthy pull`                         | Environment secret `GET`     | Owner, Writer, Reader, or effective Guardian; otherwise approval |
| `pawthy push`                         | Environment secret `PUT`     | Owner or Writer                                                  |

Consequences:

- Writers, Readers, and explicit Guardians cannot discover shared projects through interactive
  `pawthy init`, even though they can use direct IDs from `.pawthyrc`, flags, or environment
  variables for operations they are authorized to perform.
- `pull --keys` filters only after the API has returned every decrypted value
  (`apps/pawthy/src/commands/pull.ts:78-121`). It is data shaping, not least-privilege disclosure.
- `push --keys` is also client-side shaping. The server remains authoritative
  (`apps/pawthy/src/commands/push.ts:114-169`).
- Pawthy discards the pending response's `requestId` and tells the user to rerun the command
  (`commands/pull.ts:79-98`).
- Pawthy calls a `403` role “Manager,” although the persisted role is `WRITER`
  (`commands/push.ts:173-186`).
- Local Pawthy tokens are plaintext credentials protected with directory mode `0700`, file mode
  `0600`, and `.gitignore` assistance. Local credentials override the global token
  (`apps/pawthy/src/config.ts:109-217`).
- There is no CLI logout, token listing, token revocation, request-status, or approval-poll command.

### 4.4 Approval behavior

Current approval lookup keys only `resourceId` and `requesterId`, then accepts any unexpired
`APPROVED` row (`domain/policy.ts:28-71`, `domain/repositories.ts:762-790`). It does not compare:

- operation (`FIELD_ACCESS`, `TOTP_ACCESS`, or `SECRET_ACCESS`);
- field name;
- project or environment;
- requested key set; or
- one-time consumption.

As a result, approving one field, a TOTP request, a Pawthy pull, or a generic manual request grants
the requester every known field and linked TOTP for that resource until that request expires.

Current default windows are:

| Request source           | Current lifetime |
| ------------------------ | ---------------- |
| Manual `/access request` | 24 hours         |
| Pawthy secret pull       | 24 hours         |
| Single field             | 15 minutes       |
| Linked TOTP              | 5 minutes        |

Only overdue `PENDING` requests are rewritten to `EXPIRED`. Approved rows remain `APPROVED` in
storage and become ineffective only through lookup-time expiry.

### 4.5 Current request, decision, and delivery caveats

- Manual `/access request` says that Guardians were notified, but the handler only creates a
  database row. It does not send a notification (`discord/commands/requestAccess.ts:72-104`).
  Its context also lacks the typed fields required by `isAccessRequestContext`, so the button
  reveal/denial-notification path cannot process it
  (`discord/interactions/approvalButtons.ts:25-48`).
- Field and linked-TOTP reads create new requests without active-request deduplication or
  request-side rate limiting. If every Guardian DM fails, the pending row remains. The linked-TOTP
  rate limit is checked only after access is allowed
  (`discord/commands/resource.ts:630-637,945-979,1039-1243`).
- HTTP-created secret requests attempt to DM only the selected Owner/first Guardian and mention
  other Guardians inside that DM. They are not independently notified
  (`http/server.ts:743-812`).
- Button decisions reveal a requested field/TOTP and notify a typed Requester on denial, but leave
  callback delivery as a TODO. Slash `/access approve|deny` invokes the callback but does not
  reveal or notify the Requester (`discord/interactions/approvalButtons.ts:154-192,208-298`,
  `discord/commands/decision.ts:20-62`).
- Sent Discord message/channel IDs are not persisted after delivery, so later message-update logic
  normally has no stored message to update.
- `callbackUrl` can target any syntactically valid URL, and slash decision delivery POSTs request
  context to it without an allowlist or private-network protection. `channelId` can target any text
  channel fetchable by the bot. These are SSRF and disclosure boundaries, not merely delivery
  options.
- Decision handling reads `PENDING`, then writes by ID without a conditional status predicate.
  Concurrent Guardians can both observe `PENDING` and produce duplicate side effects
  (`domain/services.ts:147-250`, `domain/repositories.ts:723-733`).
- `Resource.mode` currently has only `ONE_OF_N`, and decision processing does not evaluate the mode.
  Any one effective Guardian resolves the request.

### 4.6 Current credential lifecycle

- CLI device flow uses a random UUID device code and an eight-hex-character user code (32 bits),
  with a 30-minute lifetime and no HTTP or `/auth login` attempt throttling
  (`domain/auth.ts:47-82`, `discord/commands/auth.ts:12-92`).
- Device exchange marks the session consumed and then creates a token in separate operations.
  Concurrent exchanges or a token-write failure can produce inconsistent state
  (`domain/auth.ts:106-149`).
- The repository clears the session's `userId` when changing it to `CONSUMED` because status
  updates without a user ID write `null`, weakening forensic linkage
  (`domain/repositories.ts:901-909`).
- Pawthy bearer tokens are random `paw_` credentials hashed with SHA-256, bound to a Discord user
  ID, and valid for 90 days. They have no scope, refresh, inventory API, or revocation API
  (`domain/auth.ts:34-40,130-172`).
- Resource API keys are stored and looked up as plaintext. They have no credential record, unique
  constraint, expiry, rotation, or revocation lifecycle (`prisma/schema.prisma:27-46`,
  `domain/repositories.ts:217-221`).
- There is no Discord web OAuth, cookie/session, CSRF, or web-origin implementation today. Current
  configuration has a Discord client ID but no client secret, callback URL, web origin, or web
  session settings (`config/env.ts:38-59`).

## 5. Audit findings and required corrections

| Priority | Finding                                                                                                              | Required target behavior                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Approval is resource-wide and cross-action.                                                                          | Persist typed, target-scoped, expiring grants and validate the full scope on reveal.                                              |
| Critical | `shared` standalone TOTP is globally readable, including recovery keys.                                              | Replace the boolean-as-ACL behavior with explicit project/resource subjects; never expose recovery keys through ordinary sharing. |
| High     | Service methods rely on each caller to authorize field, TOTP, project, request, and audit operations.                | Introduce policy-aware application use cases that accept an authenticated actor and enforce capabilities server-side.             |
| High     | Explicit Guardians and inherited Writers can mutate fields and TOTP links through generic effective-Guardian checks. | Separate `request.decide`, `secret.write`, `totp.code.read`, `totp.link.manage`, and `totp.account.manage` capabilities.          |
| High     | `GET /api/requests/:id` is public.                                                                                   | Require authentication plus requester ownership or approval-queue authority.                                                      |
| High     | Field autocomplete and names-only Discord/HTTP list routes decrypt values to render metadata.                        | Authorize metadata queries and use metadata-only repository projections.                                                          |
| High     | Generic request context, channel IDs, and callback URLs are caller-controlled.                                       | Use typed context, trusted requester columns, allowed notification destinations, and callback allowlists/SSRF protection.         |
| High     | Button and slash decisions have different callback, reveal, and notification behavior.                               | Route every decision surface through one atomic use case and one delivery/outbox pipeline.                                        |
| High     | Request and device-token transitions use read-then-write state changes.                                              | Use conditional transitions or transactions so only one decision/exchange succeeds.                                               |
| High     | Request retries can create duplicates and notification spam.                                                         | Add active-request uniqueness, requester rate limits, idempotency keys, and delivery state.                                       |
| High     | Resource API keys are plaintext, non-unique, unscoped, and non-expiring.                                             | Store hashes, enforce uniqueness, identify key records, scope them, rotate/revoke them, and audit use.                            |
| High     | Pawthy tokens are unscoped 90-day credentials with no revocation surface.                                            | Keep CLI tokens separate from web sessions; add token inventory and revocation before broader use.                                |
| High     | Fastify access logging and durable sensitive-read/write audit coverage are absent.                                   | Emit correlated request, authorization, mutation, reveal, and lifecycle events with redaction.                                    |
| Medium   | `401`, `403`, and hidden-object semantics are inconsistent.                                                          | Use `401` for missing/invalid auth, `403` for a known authenticated denial, and `404` when object existence must be hidden.       |
| Medium   | Environment creation and secret batch writes are non-transactional.                                                  | Make coupled creation and batch mutation atomic, with idempotency and aggregate audit outcome.                                    |
| Medium   | Guardian rows lack a unique resource/user constraint.                                                                | Add uniqueness and deterministic role reconciliation.                                                                             |
| Medium   | Requesters can approve their own requests after gaining Guardian/Writer status.                                      | Deny self-approval unless a separately documented emergency policy explicitly permits it.                                         |

### 5.1 Current observability inventory

`AuditLog` is a free-form, resource-centric record with optional actor/resolver IDs and string
context. It has no project, environment, request, session, token, correlation, or typed target
columns. The repository can query only by resource (`prisma/schema.prisma:117-130`,
`domain/repositories.ts:579-617`).

Durable audit events currently cover only:

- approval decisions;
- resource TOTP link;
- direct slash-command Discord field-value reveal;
- direct slash-command Discord linked-resource TOTP reveal; and
- standalone TOTP rate-limit denial.

Button-approved field and TOTP delivery logs the decision but not a distinct reveal event.

They do not comprehensively cover request creation/expiry, authentication, token mint/revocation,
project/environment/resource changes, membership/Guardian changes, secret API reads and writes,
TOTP lifecycle, authorization denials, notification delivery, callback delivery, or inherited-role
changes.

`AuditService.log` deliberately fails open when persistence fails
(`apps/purrmission-bot/src/domain/audit.ts:12-31`). Fastify's logger is disabled and the server has
no request-correlation hook (`http/server.ts:63-65`).

## 6. Target authorization model

### 6.1 Capability evaluation

Routes and application services MUST authorize named capabilities, not broad role checks. The
minimum capability vocabulary is:

| Entity        | Capabilities                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project       | `project.create`, `project.view`, `project.update`, `project.delete`, `project.transfer`, `project.members.view`, `project.members.manage`                                              |
| Environment   | `environment.view`, `environment.create`, `environment.update`, `environment.delete`                                                                                                    |
| Resource      | `resource.create`, `resource.view`, `resource.policy.manage`, `resource.delete`, `resource.api-key.list`, `resource.api-key.mint`, `resource.api-key.rotate`, `resource.api-key.revoke` |
| Secret        | `secret.metadata.read`, `secret.value.read`, `secret.write`, `secret.delete`                                                                                                            |
| TOTP          | `totp.metadata.read`, `totp.code.read`, `totp.recovery.read`, `totp.link.manage`, `totp.account.manage`                                                                                 |
| Guardian      | `guardian.view`, `guardian.context.read`, `guardian.manage`                                                                                                                             |
| Request       | `request.create`, `request.view-own`, `request.queue.view`, `request.decide`, `request.cancel-own`, `grant.consume`                                                                     |
| Audit         | `audit.full.read`, `audit.operational.read`, `audit.queue.read`, `audit.own.read`, `audit.export`                                                                                       |
| Session/token | `session.view-own`, `session.revoke-own`, `token.manage-own`                                                                                                                            |

The evaluator input MUST include:

- a typed principal containing principal type, non-secret principal-record ID, authentication
  kind, and optional actor Discord user ID;
- capability;
- project, environment, resource, and target IDs as applicable;
- approval/grant ID when grant-backed;
- current timestamp; and
- trusted request context such as session and correlation ID.

The output SHOULD include:

- `allowed`;
- stable `reasonCode`;
- effective role/capability sources;
- whether approval is available;
- applicable approval/grant ID; and
- safe UI explanation.

Denials such as `SELF_APPROVAL_FORBIDDEN`, `GRANT_SCOPE_MISMATCH`, and
`RECOVERY_KEY_OWNER_REQUIRED` override any ordinary role union.

Every capability is bound to an exact scope type and object ID. Creation capabilities are bound to
the authenticated actor's account/creation scope and quota policy because the object does not yet
exist. A capability returned with a Project DTO applies only to that project; it does not authorize
its environments, resources, secrets, or TOTP accounts. Each nested object returns its own scoped
capabilities. Where a client needs an explicit representation, use:

```json
{
  "capability": "environment.update",
  "scopeType": "environment",
  "scopeId": "environment-id"
}
```

The evaluator also returns a separately scoped `approvalAvailable` result when the actor may
request access. Neither a role name nor an unscoped capability string is an authorization token.

### 6.2 Role-to-capability summary

| Role/relationship          | Target authority                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project Owner              | Full project control; environment and secret management; linked-resource administration; direct secret/TOTP-code use; Guardian/member management; approvals; full project audit. Recovery material still follows TOTP-account custody.      |
| Project Writer             | Project and environment view; environment update; secret read/write; operational audit. No environment creation/deletion, approval, member, Guardian, API-key, TOTP-code, recovery-key, or project administration from Writer status alone. |
| Project Reader             | Project/environment view; secret metadata/value read; own request status/audit. No write, approval, linked-TOTP direct use, or administration.                                                                                              |
| Explicit Resource Guardian | Minimal resource/request context and approval queue/decision only. No secret value, TOTP code, field mutation, TOTP link, or project authority from Guardianship alone.                                                                     |
| Requester                  | Create a typed request, view/cancel own pending request, and consume only the exact approved grant. No broad resource enumeration.                                                                                                          |
| Standalone Resource Owner  | Resource policy/API-key/link-administration and direct secret/TOTP-code use for that resource only. This does not confer TOTP-account or recovery-material ownership.                                                                       |
| Personal TOTP Owner        | Full control and use of that personal TOTP account only.                                                                                                                                                                                    |

Any authenticated user MAY create a new project or standalone resource, subject to rate and quota
policy. Creation makes that user Owner of the new object; it does not expand their authority on
existing objects.

### 6.3 Projects

| Action                             | Owner                                                                     | Writer             | Reader     | Guardian                                | Requester                            |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------ | ---------- | --------------------------------------- | ------------------------------------ |
| View project metadata              | Yes                                                                       | Yes                | Yes        | No, except safe label in resource queue | No, except safe label on own request |
| Update name/description/settings   | Yes                                                                       | No                 | No         | No                                      | No                                   |
| Delete project                     | Yes, with recent-auth condition and confirmation                          | No                 | No         | No                                      | No                                   |
| Transfer ownership                 | Yes, with recent-auth condition, recipient acceptance, and reconciliation | No                 | No         | No                                      | No                                   |
| List members                       | Yes                                                                       | Yes                | Yes        | No                                      | No                                   |
| Add, remove, or change member role | Yes                                                                       | No                 | No         | No                                      | No                                   |
| View authorized audit scope        | Full                                                                      | Operational subset | Own events | Guarded-request subset                  | Own request events                   |

Project listing MUST return every project in which the actor is Owner, Writer, or Reader, not only
owned projects. Guardian-only resources belong in the approval queue/resource context, not in a
misleading project-membership list.

### 6.4 Environments

| Action                                 | Owner                                     | Writer | Reader             | Guardian                          | Requester                   |
| -------------------------------------- | ----------------------------------------- | ------ | ------------------ | --------------------------------- | --------------------------- |
| List/view environment metadata         | Yes                                       | Yes    | Yes                | Safe context for guarded resource | Safe context on own request |
| Create environment                     | Yes                                       | No     | No                 | No                                | No                          |
| Rename/update environment metadata     | Yes                                       | Yes    | No                 | No                                | No                          |
| Delete environment and linked resource | Yes, with impact preview and confirmation | No     | No                 | No                                | No                          |
| View linked resource health/counts     | Yes                                       | Yes    | Yes, non-sensitive | Request context only              | Own request only            |

Environment creation MUST atomically create/link the protected resource and its ownership
relationships. Failure must not leave an orphan resource or API key. It is Owner-only because it
creates a protected resource and mints its initial credential; Writer “environment management” is
deliberately limited to updating existing environment metadata.

### 6.5 Resources and API keys

| Action                          | Owner                              | Writer                             | Reader                             | Guardian                  | Requester                     |
| ------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ------------------------- | ----------------------------- |
| View safe resource metadata     | Yes                                | Yes                                | Yes                                | Approval DTO context only | Own request target only       |
| Change approval mode/policy     | Yes                                | No                                 | No                                 | No                        | No                            |
| List API-key metadata           | Yes                                | No                                 | No                                 | No                        | No                            |
| Mint resource API key           | Yes, with recent-auth condition    | No                                 | No                                 | No                        | No                            |
| Rotate/revoke resource API keys | Yes, with recent-auth condition    | No                                 | No                                 | No                        | No                            |
| Delete standalone resource      | Yes, with recent-auth condition    | No                                 | No                                 | No                        | No                            |
| List sensitive field names      | Through secret metadata capability | Through secret metadata capability | Through secret metadata capability | Requested target only     | Granted/requested target only |

API keys MUST be separate hashed credential records with unique IDs, labels, scopes, creation,
expiry, last-used, rotation, and revocation data. Plaintext is returned only once. Logs and API
responses MUST never include the plaintext after creation.

Only a Project Owner may administer keys for a project-linked resource. Only its standalone
Resource Owner may administer keys for a standalone resource. API-key listing returns credential
metadata, never plaintext.

### 6.6 Secrets

| Action                     | Owner  | Writer             | Reader    | Guardian                       | Requester                              |
| -------------------------- | ------ | ------------------ | --------- | ------------------------------ | -------------------------------------- |
| List secret names/versions | Yes    | Yes                | Yes       | Only target named in a request | Only target named in own request/grant |
| Reveal one secret value    | Direct | Direct             | Direct    | No, unless separately eligible | Scoped grant                           |
| Pull a secret bundle       | Direct | Direct             | Direct    | No, unless separately eligible | Scoped key-set grant                   |
| Create/update secret       | Yes    | Yes                | No        | No                             | No                                     |
| Delete secret              | Yes    | Yes                | No        | No                             | No                                     |
| View secret access history | Yes    | Operational subset | Own reads | Decisions for guarded requests | Own request/grant use                  |

Secret list responses MUST omit values. A bulk pull request MUST authorize and return an explicit
key set. Server-side filtering occurs before decryption and serialization; client-side `--keys`
filtering is not authorization.

Secret values MUST use `Cache-Control: no-store`. They MUST NOT appear in URLs, logs, audit context,
analytics, error details, server-rendered HTML, or client persistence. The dashboard SHOULD require
an explicit reveal gesture and auto-clear copied/revealed values from UI state.

### 6.7 TOTP and recovery material

| Action                                | Resource/Project Owner                                      | Writer                               | Reader                               | Guardian                   | Requester                            |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------ | -------------------------- | ------------------------------------ |
| See that linked TOTP exists           | Yes                                                         | Yes                                  | Boolean only                         | Request context            | Own request context                  |
| View linked account label/issuer      | Yes                                                         | No                                   | No                                   | Only when needed to decide | Only on own request                  |
| Generate linked TOTP code             | Direct                                                      | Scoped grant if link consent permits | Scoped grant if link consent permits | No from Guardianship alone | Scoped grant if link consent permits |
| Read backup/recovery key              | Only if also the personal TOTP Owner, recent-auth condition | No                                   | No                                   | No                         | No                                   |
| Link/unlink resource association      | Yes, subject to account-owner consent                       | No                                   | No                                   | No                         | No                                   |
| Create/update/delete personal account | Only if personal TOTP Owner                                 | Same actor rule                      | Same                                 | Same                       | Same                                 |

`shared: true` MUST NOT by itself grant access. Shared accounts require an explicit resource or
project relationship. Until that model exists, the dashboard MUST NOT expose a global shared-TOTP
catalog.

`TOTPAccount.ownerDiscordUserId` remains the credential-custody boundary. Linking an account to a
resource does not transfer custody. Creating a link requires the account owner to be the acting
resource owner or to provide an explicit, one-time consent; either the resource owner or account
owner may later unlink it. Project and Resource ownership never grants backup/recovery material or
permission to update/delete the personal account.

TOTP consent uses two deliberately separate records:

1. **Link consent** is one-time consent naming the account/seed version, resource, initiating
   resource owner, initial link-policy version, and whether third-party delegation may ever be
   requested. It is consumed atomically when the link is created. The resulting versioned
   delegation envelope persists on the link and defines maximum scope/lifetime; it grants no code
   reveal by itself.
2. **Delegation consent** is required for each third-party TOTP-code grant when the link envelope
   permits delegation. It is short-lived and bound to the account/seed version, resource,
   link-policy version, requester, authentication family/audience, operation, and maximum grant
   expiry. It is consumed atomically when Approval Request V2 issues the matching grant.

Guardian approval alone cannot override either consent layer. A seed, link, custody, or delegation
policy change invalidates outstanding delegation consent and grants and requires new link consent
when the link envelope itself changes. Third-party code use remains denied until a current
delegation consent and any required Guardian decision produce a matching one-time grant.

A TOTP-code grant is one successful reveal, bound to requester and TOTP target, with a maximum
five-minute grant lifetime. A recovery key is outside ordinary TOTP-code approval scope and cannot
be approved through a generic Guardian action.

### 6.8 Guardians

| Action                                        | Owner | Writer | Reader | Guardian           | Requester |
| --------------------------------------------- | ----- | ------ | ------ | ------------------ | --------- |
| List full Guardian assignments                | Yes   | No     | No     | No                 | No        |
| View own assignment and quorum/policy context | Yes   | No     | No     | Assigned resource  | No        |
| Add/remove explicit Guardian                  | Yes   | No     | No     | No                 | No        |
| View approval queue                           | Yes   | No     | No     | Assigned resources | No        |
| Approve/deny                                  | Yes   | No     | No     | Assigned resources | No        |
| Read protected value due only to Guardianship | N/A   | N/A    | N/A    | No                 | No        |

Project Owner approval inheritance is dynamic. Project Writer membership no longer produces
approval authority in the target policy. A Writer who should approve must receive a separate,
explicit Resource Guardian assignment, which is revoked independently.

### 6.9 Approval requests and grants

| Action                       | Owner                           | Writer               | Reader               | Guardian             | Requester            |
| ---------------------------- | ------------------------------- | -------------------- | -------------------- | -------------------- | -------------------- |
| Create request               | Eligible target/invitation only | Same                 | Same                 | Same                 | Same                 |
| View own request/status      | Yes                             | Yes                  | Yes                  | Yes                  | Yes                  |
| View resource approval queue | Yes                             | No                   | No                   | Yes                  | No                   |
| Approve/deny another actor   | Yes                             | No                   | No                   | Yes                  | No                   |
| Approve own request          | No                              | No                   | No                   | No                   | No                   |
| Cancel own pending request   | Yes                             | Yes                  | Yes                  | Yes                  | Yes                  |
| Consume approved grant       | Request subject only            | Request subject only | Request subject only | Request subject only | Request subject only |

`ApprovalRequest` MUST persist trusted typed columns rather than derive security identity from
caller-controlled JSON:

- requester Discord user ID;
- request type and capability;
- project/environment/resource IDs;
- target type, stable target/version IDs, canonical key set, and digest;
- reason and safe display context;
- status;
- created, expiry, decision, and consumption timestamps;
- resolver Discord user ID;
- idempotency key; and
- delivery state.

For human requests, requester Discord ID MUST come from the authenticated Discord, web-session, or
Pawthy principal; it is never accepted from a body or generic context object. A Resource API key
authenticates a machine/resource, not a human, and therefore cannot assert an arbitrary requester
Discord ID. Machine-originated requests require a separately modeled service principal or an
owner-issued, user-bound invitation.

Request creation requires either existing safe visibility of the exact target or an owner-issued,
unguessable invitation scoped to an operation and target. Raw UUID knowledge is insufficient. A
denied request-creation response must not disclose target existence through body shape or timing.
Actor/target rate limits and active-request deduplication are mandatory. Idempotency uniqueness is
actor plus operation plus canonical target/payload digest; reusing a key with a different payload
returns `409`.

`ApprovalGrant` MUST be a separate immutable record. It stores canonical stable target IDs, the
approved secret/TOTP version IDs, canonical key set, its canonical digest, capability, subject,
resolver, allowed authentication family/audience, policy version, creation/expiry, and consumption
state. The default authentication family is the request's family; a web session and its child web
bearer are one family. Cross-surface consumption requires an explicit policy recorded on the grant.
Grants bind to the versions reviewed by the resolver; any protected-value or policy change
invalidates the grant and requires a new request. A digest alone is never enough to enumerate or
authorize keys.

Default target lifetimes:

| Grant                            | Target lifetime and consumption                                            |
| -------------------------------- | -------------------------------------------------------------------------- |
| Single secret value              | 15 minutes, one successful reveal                                          |
| Secret bundle                    | 15 minutes, one successful response, explicit key set                      |
| TOTP code                        | 5 minutes, one successful reveal                                           |
| Non-sensitive metadata exception | At most 15 minutes; avoid approval if a direct safe projection is possible |

There is no generic resource-wide manual grant. `/access request` and its web replacement must ask
for a typed operation and target.

Decision handling MUST atomically re-authorize the resolver, reject self-approval, conditionally
transition only `PENDING`, and create the immutable grant when approved. Exactly one transition to
`APPROVED`, `DENIED`, `CANCELLED`, or `EXPIRED` wins.

Grant consumption MUST atomically check subject, authentication family/audience, capability, every
target and version, current policy state, expiry, and unused state; claim the grant; and durably
queue the reveal audit before materializing a response. Only one claimant wins. A transport failure
after the claim does not permit a second disclosure.

Notification and callback delivery use an idempotent outbox. Destinations are Owner-registered and
verified, HTTPS-only, and allowlisted by exact origin and path. Every delivery re-resolves and
rejects mixed public/private answer sets and loopback, private, link-local, and otherwise non-public
addresses. The connection is pinned to a validated public A/AAAA result while TLS hostname
verification still uses the registered host; redirects are disabled. Payloads are signed and
idempotent and never contain protected values, bearer credentials, or grant secrets. Requesters
cannot supply raw callback URLs or Discord channel IDs. Failed delivery does not silently claim
success.

## 7. Discord OAuth2 web-session design

Delivery class: `OAUTH_SESSION`. This section is a normative future contract but is not
implementation evidence required by #126.

### 7.1 Separation from Pawthy authentication

The existing Discord-command device flow remains a CLI identity flow. Its `paw_` bearer tokens are
long-lived, unscoped, and lack browser session and CSRF semantics. They MUST NOT be reused as
dashboard cookies or web bearer tokens.

The dashboard uses Discord's Authorization Code Grant with a confidential server-side client.
Discord's current OAuth2 documentation defines:

- authorization: `https://discord.com/oauth2/authorize`
- token exchange: `https://discord.com/api/oauth2/token`
- token revocation: `https://discord.com/api/oauth2/token/revoke`
- identity: `GET https://discord.com/api/v10/users/@me`

Only the `identify` scope is required. Do not request `email`, `guilds`, `connections`, bot install,
or other scopes unless a later accepted requirement needs them.

Discord's current OAuth2 page documents and strongly recommends `state`; it does not document PKCE
parameters. Phase 2 MUST use a confidential backend and one-time `state`. PKCE MAY be added only
after an implementation spike verifies Discord support; the launch design must not assume
undocumented parameters.

Reference: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2).

### 7.2 Required routes

| Route                            | Purpose                                     | Security contract                                                                                                   |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/discord/login`    | Begin OAuth authorization                   | Validate local `returnTo`; create one-time attempt and state; redirect to Discord.                                  |
| `GET /api/auth/discord/callback` | Validate callback and establish session     | Validate/consume state before token exchange; fetch Discord identity; rotate session; redirect to safe local route. |
| `GET /api/auth/session`          | Return current identity and CSRF bootstrap  | No secrets or Discord tokens; `Cache-Control: no-store`.                                                            |
| `POST /api/auth/logout`          | Revoke current session and child web tokens | CSRF and Origin protected; clear cookie with identical attributes.                                                  |
| `POST /api/auth/discord/token`   | Explicit short-lived web bearer mint        | CSRF protected, session-bound, narrow audience, maximum five-minute lifetime.                                       |

Phase 2 MUST provide `POST /api/auth/discord/token` to satisfy the epic's separate bearer-token
contract, but the same-origin dashboard SHOULD use the session cookie and mint no bearer unless a
client explicitly needs one. A web bearer is an opaque, hashed, revocable credential with:

- Discord user ID;
- parent web-session ID;
- `purrmission-web` audience;
- issued and expiry timestamps;
- token ID; and
- no embedded role snapshot.

It MUST NOT be written to `localStorage`, `sessionStorage`, URLs, or logs. Revoking the parent
session revokes every child token. Its expiry is the earlier of five minutes or the parent
session's remaining lifetime, and every use checks that the parent remains active. The token
response uses `Cache-Control: no-store`. This endpoint is distinct from the existing Pawthy
`POST /api/auth/token`.

Session and child-bearer secrets contain at least 256 bits of CSPRNG entropy. Store only a keyed
digest/hash of each presented secret, separately from its non-secret record ID. Cookie signing is
defense in depth, not a substitute for server-side credential hashing. A request presenting both
the session cookie and `Authorization` is rejected as `AMBIGUOUS_AUTHENTICATION`; there is no
credential-precedence rule.

Phase 2 startup configuration must add and validate:

- `DISCORD_CLIENT_SECRET`;
- one exact `DISCORD_OAUTH_REDIRECT_URI`;
- one exact `PURRMISSION_WEB_ORIGIN`;
- session idle and absolute lifetimes;
- OAuth-attempt lifetime; and
- separately rotatable session/child-credential digest, OAuth-attempt digest, and CSRF-HMAC keys,
  plus a cookie-signing key if cookies are also signed.

Cryptographic key material is mandatory and MUST NOT be reused across these purposes.

Secrets are never exposed to `apps/purrmission-web`. Production startup fails closed when OAuth is
enabled but its origin, HTTPS/cookie, redirect, or secret configuration is incomplete.

### 7.3 Login and callback sequence

1. `/login` normalizes `returnTo` once. It must begin with exactly one `/`, contain no scheme,
   host, backslash, or control character, and resolve to an allowlisted dashboard route; `//` is
   rejected.
2. Generate at least 32 random bytes for `state`.
3. Store `stateDigest`, `attemptCookieDigest`, safe `returnTo`, `expiresAt`, and `consumedAt` in a
   single-use server-side OAuth-attempt row with a ten-minute expiry. The opaque attempt-cookie
   secret also contains at least 256 bits of entropy.
4. Redirect to Discord with `response_type=code`, registered exact `redirect_uri`,
   `scope=identify`, and `state`.
5. Callback requires both state and the attempt cookie, compares their keyed digests to the same
   row, and rejects missing, mismatched, replayed, or expired attempts before using `code`.
6. Match and consume both bindings atomically.
7. Exchange the code using `application/x-www-form-urlencoded` and the server-held client secret.
8. Fetch `/users/@me` with the Discord access token. Validate that `id` is a decimal snowflake
   string and persist only profile fields needed by the UI.
9. Do not persist Discord access or refresh tokens for identity-only login. Discard them after
   identity resolution; optionally revoke them immediately if the selected UX is verified.
10. Create a new opaque local session, rotate any pre-auth session ID, set the session cookie, clear
    the attempt cookie, and redirect to the stored safe path.

OAuth errors return a generic UI state. Codes, state, client secrets, Discord tokens, and full
Discord error bodies MUST NOT be logged.

### 7.4 Session storage and cookie contract

The server-side web-session record requires:

- session record ID and keyed digest of the presented secret;
- Discord user ID;
- created, last-seen, idle-expiry, and absolute-expiry timestamps;
- revoked timestamp/reason;
- recent OAuth-ceremony timestamp;
- session-bound CSRF verification material and rotation version; and
- optional safe device label and last-used request metadata suitable for security review.

Default session lifetime is 30 minutes idle and 12 hours absolute, configurable downward by
deployment. There is no remember-me session in Phase 2. Membership and Guardian relationships are
loaded live for protected actions; session renewal never extends the absolute deadline.

A **recent-auth condition** means a successful OAuth ceremony established or rotated the session
within the preceding five minutes and the user explicitly confirms the exact sensitive action.
This is recent identity confirmation, not proof that Discord required a password or MFA. A new
callback or `prompt=consent` MUST NOT be described as verified step-up authentication. Any future
operation classified as requiring higher assurance remains disabled until a verified step-up
mechanism is implemented.

To refresh this condition, the client starts the same login route with an enumerated
`purpose=recent-auth`. The purpose and initiating session ID are stored in the OAuth-attempt row.
The callback succeeds only when Discord returns the same user as the initiating session, then
rotates that session; an identity mismatch terminates the attempt without switching accounts.

Production cookie:

```text
__Host-purrmission_session=<opaque random value>;
Path=/;
Secure;
HttpOnly;
SameSite=Lax
```

It has no `Domain` attribute. `SameSite=Lax` permits the top-level OAuth callback while reducing
cross-site request risk. Production refuses to start web auth without HTTPS-aware secure-cookie
configuration. Local HTTP development uses a separately named host-only development cookie so the
production contract is never weakened.

The OAuth-attempt cookie is separately named `__Host-purrmission_oauth`, has the same
`Secure`/`HttpOnly`/`SameSite=Lax`/host-only contract, and has a maximum age no longer than the
ten-minute OAuth-attempt lifetime. It is cleared after every success or terminal failure.

The cookie contains no Discord token, role, profile, secret, or serialized session. Cookie clearing
must repeat the same path and host attributes. Session IDs rotate after login, a recent-auth
ceremony, and any future verified step-up authentication.

Fastify authentication SHOULD be an encapsulated plugin/hook that decorates a typed authenticated
principal. Authorization is a separate route/use-case check. See
[Fastify hooks](https://fastify.dev/docs/latest/Reference/Hooks/) and
[`@fastify/cookie` security guidance](https://github.com/fastify/fastify-cookie/blob/main/README.md).
Adding dependencies remains a separate implementation decision under repository policy.

### 7.5 CSRF, origin, and browser controls

- OAuth callback CSRF protection uses the one-time state attempt.
- `GET /api/auth/session` returns a reproducible, session-bound CSRF token without rotating it on
  every read; the client holds it in memory. One implementation is an HMAC over the session record
  ID and CSRF rotation version using server-held key material. Rotate it on login, recent-auth
  session rotation, and revocation.
- Every cookie-authenticated unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) validates both:
  - exact `Origin` against the configured dashboard origin; and
  - a session-bound CSRF token supplied in a custom header.
- Missing or `null` Origin is rejected.
- Except for the OAuth login and callback endpoints, `GET` and `HEAD` MUST NOT perform
  domain/business mutations or consume grants. They may update session activity, rate-limit state,
  and append security/audit telemetry. The two OAuth GET endpoints may mutate only
  authentication-attempt/session state and MUST NOT perform domain mutations. Every secret, TOTP
  code, or recovery-key reveal and every grant consumption uses `POST`. Logout is also `POST`, not
  `GET`.
- Prefer a same-origin deployment for web and API. If cross-origin deployment is required, use an
  exact allowlist with credentials; never wildcard CORS.
- Auth, session, secret, TOTP, grant, and sensitive metadata responses use
  `Cache-Control: no-store`.
- Apply CSP, `frame-ancestors 'none'`, HSTS in production, `X-Content-Type-Options: nosniff`, and
  `Referrer-Policy: no-referrer`.
- Rate-limit login starts, callbacks, token minting, requests, decisions, and sensitive reveals by
  safe combinations of IP, session, actor, and target.

### 7.6 Authentication and authorization response semantics

- `401 Unauthorized`: authentication is missing, expired, revoked, or invalid.
- `403 Forbidden`: actor is authenticated and object visibility is already established, but the
  requested action is not allowed.
- `404 Not Found`: actor must not learn whether the object exists.
- `409 Conflict`: stale version, already-resolved request, duplicate membership, or idempotency
  conflict.
- `429 Too Many Requests`: rate limited, with a safe retry hint.

The client responds to `401` by returning to login. It does not treat a business authorization
denial as an expired session.

## 8. Dashboard route and UI gating specification

Delivery classes: sections 8.1 and 8.4 are `DASHBOARD_BACKEND`; sections 8.2 and 8.3 are
`DASHBOARD_UI`. #126 verifies their prerequisite capability, projection, and versioning substrate,
not these dashboard-specific routes or controls.

### 8.1 Server-provided capabilities

The web API SHOULD return safe per-object capabilities with each authorized metadata DTO, for
example:

```json
{
  "id": "project-id",
  "name": "Example",
  "effectiveRoles": ["WRITER"],
  "capabilities": [
    {
      "capability": "project.view",
      "scopeType": "project",
      "scopeId": "project-id"
    },
    {
      "capability": "project.members.view",
      "scopeType": "project",
      "scopeId": "project-id"
    },
    {
      "capability": "audit.operational.read",
      "scopeType": "project",
      "scopeId": "project-id"
    }
  ]
}
```

This is display guidance, not an authorization grant. The server recomputes authorization when an
action is submitted. The UI MUST NOT infer permissions solely from a role label, because users can
hold multiple relationships and because deny rules can override unions. Environment, resource,
secret, TOTP, request, and grant DTOs return their own exact-object capability entries; a Project
DTO never carries authority for arbitrary descendants.

### 8.2 Route gates

| Dashboard route                                    | Minimum capability/relationship                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `/projects`                                        | Authenticated; API returns only Owner/Writer/Reader projects            |
| `/projects/new`                                    | `project.create`, subject to quota/rate policy                          |
| `/projects/:projectId`                             | `project.view`                                                          |
| `/projects/:projectId/settings`                    | `project.update`                                                        |
| `/projects/:projectId/members`                     | `project.members.view`; mutations require `project.members.manage`      |
| `/projects/:projectId/environments/:envId`         | `environment.view`                                                      |
| `/projects/:projectId/environments/:envId/secrets` | `secret.metadata.read`; reveal and write checked separately             |
| `/resources`                                       | Authenticated; returns only resources with `resource.view`              |
| `/resources/new`                                   | `resource.create`, subject to quota/rate policy                         |
| `/resources/:resourceId`                           | `resource.view`                                                         |
| `/resources/:resourceId/settings`                  | `resource.policy.manage`                                                |
| `/resources/:resourceId/api-keys`                  | `resource.api-key.list`; each mutation checked separately               |
| `/resources/:resourceId/guardians`                 | `guardian.view`; mutations require `guardian.manage`                    |
| `/resources/:resourceId/secrets`                   | `secret.metadata.read`; reveal and write checked separately             |
| `/resources/:resourceId/totp`                      | `totp.metadata.read` on the linked account; use/link checked separately |
| `/resources/:resourceId/audit`                     | An exact authorized resource audit scope                                |
| `/totp`                                            | Authenticated; returns only actor-owned personal accounts               |
| `/totp/:accountId`                                 | `totp.metadata.read` on that personal account                           |
| `/approvals`                                       | `request.queue.view` on at least one resource                           |
| `/requests`                                        | Authenticated; returns actor's requests only                            |
| `/audit`                                           | At least one authorized audit scope                                     |
| `/account/sessions`                                | `session.view-own`                                                      |
| `/account/cli-tokens`                              | `token.manage-own`; returns only the actor's Pawthy token metadata      |

Direct navigation to a gated route must fetch authorization from the server. Client router state,
cached capabilities, hidden links, and guessed IDs never bypass the API check.

Guardian-only approval context belongs in the resource-scoped approval DTO, not a project-wide
Guardian route. A Guardian who lacks `guardian.view` sees only their own assignment and safe
quorum/policy context through `guardian.context.read`.

The CLI-token inventory returns token record ID, safe label, creation, expiry, last-used, and
revocation metadata only. Revocation is an unsafe method with CSRF/Origin protection for cookie
sessions and never returns the token plaintext, prefix, hash, or digest.

### 8.3 Control gates

| UI control                       | Required exact-object capability and condition                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Create project                   | `project.create`, subject to quota/rate policy                                                            |
| Edit project                     | `project.update`                                                                                          |
| Delete/transfer project          | `project.delete` or `project.transfer`, plus recent-auth condition and explicit confirmation              |
| Add/change/remove member         | `project.members.manage`                                                                                  |
| Create environment               | `environment.create`                                                                                      |
| Rename/update environment        | `environment.update`                                                                                      |
| Delete environment               | `environment.delete`, impact preview, and explicit confirmation                                           |
| Create standalone resource       | `resource.create`                                                                                         |
| Change resource approval policy  | `resource.policy.manage`                                                                                  |
| Delete standalone resource       | `resource.delete`, recent-auth condition, impact preview, and explicit confirmation                       |
| List/mint/rotate/revoke API keys | Corresponding `resource.api-key.*` capability; mint/rotate/revoke also require recent-auth condition      |
| List secret names                | `secret.metadata.read`                                                                                    |
| Reveal/pull secret               | `secret.value.read`, or `grant.consume` for the exact subject, target, version, and key set               |
| Add/update/delete/push secret    | `secret.write` or `secret.delete`, as applicable                                                          |
| Link/unlink TOTP association     | `totp.link.manage`, with account-owner consent rules                                                      |
| Manage personal TOTP account     | `totp.account.manage` on the actor-owned account                                                          |
| Reveal linked TOTP               | `totp.code.read`, or `grant.consume` for the exact subject, account/seed version, and operation           |
| Reveal recovery key              | `totp.recovery.read` for the personal TOTP Owner, recent-auth condition; never an ordinary approval grant |
| List full Guardian assignments   | `guardian.view`                                                                                           |
| Add/remove Guardian              | `guardian.manage`                                                                                         |
| View own Guardian context        | `guardian.context.read`                                                                                   |
| View approval queue              | `request.queue.view`                                                                                      |
| Approve/deny                     | `request.decide`; disabled when requester and resolver are the same actor                                 |
| View request status/cancel       | `request.view-own` or `request.cancel-own`, as applicable                                                 |
| View/export audit                | Exact `audit.*.read` scope; export additionally requires `audit.export` on the same object                |
| View/revoke own sessions         | `session.view-own` or `session.revoke-own`                                                                |
| List/revoke own Pawthy tokens    | `token.manage-own`; token plaintext and hashes are never returned                                         |

Hide controls when the exact-object capability is absent and approval is unavailable. When the
evaluator says approval is available, show a request-access control instead of the protected
action. Disable a normally permitted control with a reason when temporary state prevents it, such
as an already-resolved request, failed recent-auth condition, or stale version. Never render a
protected value and then hide it with CSS.

### 8.4 Data-fetch rules

- List endpoints return metadata DTOs, not decrypted domain objects.
- Secret value, TOTP code, and recovery-key reveals use dedicated endpoints and explicit audit
  events.
- Target HTTP shapes use `GET .../secrets` for metadata only and authenticated `POST` reveal
  endpoints such as `.../secrets/reveal`, `.../totp/code`, and `.../totp/recovery`. A reveal body
  names the canonical target/version/key set and optional grant ID; it never places protected data
  or grant credentials in a URL. Pawthy pull migrates to the bundle-reveal `POST`.
- Approval queues return only the context necessary to decide. They never contain the protected
  value.
- Requesters see only their own request, delivery, decision, expiry, and grant-consumption state.
- Unauthorized IDs do not appear in autocomplete, counts, global search, prefetch, error details,
  or client caches.
- UI caches must be cleared on logout, `401`, role change notification, and session revocation.
- Sensitive clipboard/reveal UX must warn about exposure and clear local component state promptly.

## 9. Target observability contract

Delivery class: `PREREQUISITE` for current Discord, HTTP, Pawthy, and worker behavior. OAuth and
web-session event instances in the shared event vocabulary are `OAUTH_SESSION` and are verified
when that phase is implemented.

### 9.1 Required event envelope

Every protected action produces a structured decision/outcome event containing:

- event ID and schema version;
- stable `eventType` and `outcomeCode`;
- occurred-at timestamp;
- request/correlation ID;
- surface (`discord`, `http`, `pawthy`, `web`, or `worker`);
- route, command, or use-case name;
- principal type and optional non-secret principal-record ID;
- optional actor Discord user ID and initiator/resolver IDs;
- capability, decision (`ALLOW`, `DENY`, or `APPROVAL_REQUIRED`), and reason code for authorization
  events;
- target type/ID when applicable;
- project, environment, resource, request, and grant IDs when applicable;
- effective role/capability sources for authorization events;
- outcome and HTTP/interaction status when applicable;
- duration when the event represents an operation; and
- redacted source metadata appropriate to the deployment.

Authentication failures, Resource API-key principals, background workers, lifecycle events, and
delivery events need not have a Discord actor or authorization decision. A principal-record ID is
the database record ID of the session, API key, or worker identity; it is never a token selector,
token prefix, digest, or presented credential.

Events MUST NOT contain:

- secret values;
- TOTP secrets or generated codes;
- backup/recovery keys;
- Discord access/refresh tokens;
- Pawthy, web, resource API, cookie, state, or CSRF tokens;
- OAuth authorization codes;
- raw callback bodies; or
- unrestricted caller-provided context.

Field names, account labels, reasons, IP addresses, and user agents can also be sensitive. Store
only what the security review needs and normalize/limit lengths. Before production, each deployment
MUST define an explicit retention and privacy schedule; launch is blocked when it is unset. IDs and
other unbounded values MUST NOT be metric labels.

### 9.2 Mandatory event families

| Family               | Required events                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication       | OAuth start/success/failure/replay, session created/rotated/expired/revoked/logout, CLI device approval/exchange, token mint/revoke    |
| Authorization        | Allow/deny/approval-required for protected metadata, reveal, mutation, decision, and administration                                    |
| Project              | Create/update/delete/transfer, member add/remove/role change                                                                           |
| Environment/resource | Create/update/delete/link, policy change, API-key mint/rotate/revoke/use                                                               |
| Secret               | Metadata access, value reveal/bulk pull, create/update/delete/batch outcome                                                            |
| TOTP                 | Create/update/delete/link/unlink, code reveal, recovery-key reveal, throttle                                                           |
| Approval             | Request create/dedupe/cancel/expire, delivery attempt/outcome, decision attempt/outcome, callback outcome, grant create/consume/expire |
| Guardian             | Explicit add/remove and inherited Resource Owner authority changes                                                                     |

### 9.3 Durability and consistency

Sensitive reveals; secret writes; TOTP actions; ownership, membership, Guardian, and approval-policy
changes; destructive project/environment/resource operations; approval decisions; and
session/token/API-key mint, rotation, and revocation MUST atomically persist an audit event or a
transactional outbox entry. A reveal use case durably queues a redacted authorized-reveal record
before decrypting or returning the value and records final delivery outcome separately. If the
event/outbox cannot be durably queued, the sensitive action fails closed.

Lower-risk metadata telemetry MAY use best-effort delivery, but failure must increment an alertable
bounded-cardinality metric. Audit delivery is idempotent by event ID. Correlation IDs cross HTTP,
domain, Discord notification, callback, and Pawthy output; they are server-generated or strictly
validated and are never unrestricted caller strings.

Audit records are append-only to application roles. Retention expiry/deletion is a separately
authorized and audited lifecycle. Audit reads and exports are themselves audited, and audit
backups and access controls follow the same object-level policy.

Audit readers receive redacted projections:

- Owner: complete project/resource security history, never protected values.
- Writer: operational environment/secret history for their projects and their own request events;
  no approval, session, or ownership-security administration unless they separately hold the
  required role.
- Reader: their own reads and request lifecycle.
- Guardian: queue, decision, and delivery history for guarded resources.
- Requester: their own request and grant lifecycle.

Audit endpoints must apply the same object-level policy before filtering, pagination, export, or
search.

## 10. Required backend contracts before dashboard UI

No later OAuth or dashboard phase may expose the current repositories directly to web handlers.
The minimum pre-dashboard contracts are:

1. A typed authenticated principal supporting Discord interactions, web sessions, short-lived web
   bearers, Pawthy bearers, Resource API keys, and service identities.
2. A central capability evaluator and policy-aware application use cases.
3. Accessible-project listing for Owner, Writer, and Reader.
4. Object-scoped capability DTOs and metadata-only repositories/DTOs for resources, secrets, and
   TOTP accounts.
5. Authenticated, subject-aware request list/detail endpoints.
6. Typed and scoped approval requests/grants with atomic state transitions and consumption.
7. Separation between approval authority, secret read, secret write, TOTP use, and TOTP
   administration.
8. Transactional or outbox-backed audit events and notification/callback delivery.
9. Consistent error semantics, request IDs, rate limits, response cache policy, and input schemas.
10. A CLI token inventory/revocation path (`PREREQUISITE`) and a distinct web-session
    inventory/revocation path (`OAUTH_SESSION`).

## 11. Verification and known test gaps

Existing tests establish useful pieces of current behavior:

- dynamic Owner/Writer/Guardian inheritance and Reader exclusion:
  `domain/policy.test.ts:313-386`;
- Guardian removal/list authorization: `domain/services.test.ts:55-199`;
- owner project/API flows: `src/api/project.test.ts`;
- resource field/TOTP routes for an Owner and denial for a non-Guardian:
  `src/api/resource.test.ts`;
- Pawthy pending pull and local secret shaping: `apps/pawthy/src/commands/pull.test.ts`;
- Pawthy push `403` presentation: `apps/pawthy/src/commands/push.test.ts`; and
- owner pull, synthetic requester states, Reader push denial, and owner push:
  `src/test/system_api.test.ts`.

Before prerequisite remediation is considered complete, #126 MUST verify:

- every target matrix row for Owner, Writer, Reader, explicit Guardian, and Requester;
- a user holding multiple roles and deny-rule precedence;
- accessible project/environment discovery for Writer and Reader;
- Writer secret/environment authority without implicit approval authority;
- explicit Guardian approval without project enumeration, secret read, or mutation;
- Resource Owner versus personal TOTP Owner custody and link-consent boundaries;
- default-denied TOTP third-party grant consent and seed/link-policy invalidation;
- cross-action/target grant rejection and one-time consumption;
- grant authentication-family/audience mismatch and cross-surface policy;
- grant invalidation after value, target-version, or policy changes;
- self-approval denial;
- duplicate/concurrent request and decision handling;
- notification/callback idempotency and SSRF/channel restrictions;
- public request-detail removal and object-enumeration resistance;
- metadata queries that do not decrypt values;
- Reader/Writer/Guardian direct and denied Pawthy flows;
- invalid/malformed batch payloads and atomic write failure;
- `POST`-only reveal/grant-consumption semantics;
- standalone Resource, API-key, personal TOTP, and linked-TOTP route/control gates;
- `401`/`403`/`404` semantics;
- required audit emission/redaction, same-scope export authorization, and audit-write failure
  behavior; and
- token/API-key rotation and revocation.

The deferred `OAUTH_SESSION` phase MUST add coverage for:

- OAuth state mismatch/replay/expiry, safe return paths, cookie flags, CSRF, logout, and session
  revocation;
- recent-auth same-user binding, session rotation, and ambiguous cookie/bearer rejection; and
- OAuth/session event emission, redaction, rotation, expiry, and revocation.

The deferred `DASHBOARD_BACKEND` and `DASHBOARD_UI` phases MUST add coverage for their exact route,
control, data-fetch, cache-clearing, reveal, and clipboard contracts in section 8.

## 12. Source map and external references

Repository sources:

- policy resolution: `apps/purrmission-bot/src/domain/policy.ts`
- application services: `apps/purrmission-bot/src/domain/services.ts`
- project service: `apps/purrmission-bot/src/domain/project.ts`
- CLI device authentication: `apps/purrmission-bot/src/domain/auth.ts`
- persistence: `apps/purrmission-bot/src/domain/repositories.ts`
- schema: `prisma/schema.prisma`
- Fastify API: `apps/purrmission-bot/src/http/server.ts`
- Discord commands: `apps/purrmission-bot/src/discord/commands/`
- approval buttons: `apps/purrmission-bot/src/discord/interactions/approvalButtons.ts`
- Pawthy commands: `apps/pawthy/src/commands/`
- Pawthy credential/config precedence: `apps/pawthy/src/config.ts`

External references:

- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [Discord Get Current User](https://docs.discord.com/developers/resources/user#get-current-user)
- [Fastify hooks](https://fastify.dev/docs/latest/Reference/Hooks/)
- [`@fastify/cookie`](https://github.com/fastify/fastify-cookie)
- [OAuth 2.0, RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)
- [OAuth 2.0 Security Best Current Practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)
