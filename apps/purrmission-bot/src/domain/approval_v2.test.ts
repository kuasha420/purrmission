import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AccessDeniedError } from './auth.js';
import { ConflictError } from './errors.js';
import { createDiscordPrincipal } from './principal.js';
import { createInMemoryRepositories } from './repositories.mock.js';
import { createServices } from './services.js';
import { createTOTPLinkEnvelope, parseTOTPDelegationPolicy } from './totp_custody.js';
import { RateLimiter } from '../infra/rateLimit.js';

describe('Approval Request V2, Immutable Grants, and Atomic Consumption (Issue #122)', () => {
  let repos: ReturnType<typeof createInMemoryRepositories>;
  let services: ReturnType<typeof createServices>;

  beforeEach(async () => {
    repos = createInMemoryRepositories();
    services = createServices({
      repositories: repos,
      rateLimiter: new RateLimiter(60000, 1000),
    });

    // Seed Project and Environment
    const project = await repos.projects.createProject({
      name: 'Test Project',
      ownerId: 'owner-1',
      description: 'Project for testing',
    });

    await repos.projects.createEnvironment({
      projectId: project.id,
      name: 'Production',
      slug: 'prod',
      resourceId: 'res-1',
    });

    // Seed Resource with Field and Guardian
    await repos.resources.create({
      id: 'res-1',
      name: 'Protected Resource',
      mode: 'ONE_OF_N',
    });

    await repos.resourceFields.create({
      resourceId: 'res-1',
      name: 'api_key',
      value: 'secret-token-12345',
    });

    // Seed TOTP Account & link
    const account = await repos.totp.create({
      ownerDiscordUserId: 'custody-owner',
      accountName: 'Protected OTP',
      secret: 'JBSWY3DPEHPK3PXP',
    });

    const linkPolicyVersion = 'link-v1';
    await repos.resources.update('res-1', {
      totpAccountId: account.id,
      totpLinkVersion: linkPolicyVersion,
      totpDelegationEnvelope: createTOTPLinkEnvelope({
        consentId: 'link-consent-1',
        resourceId: 'res-1',
        initiatingResourceOwnerId: 'owner-1',
        accountOwnerDiscordUserId: account.ownerDiscordUserId,
        accountVersion: account.version,
        linkPolicyVersion,
        delegationPolicy: parseTOTPDelegationPolicy({
          allowDelegation: true,
          allowedOperations: ['totp.code.read'],
          allowedAuthFamilies: ['DISCORD', 'PAWTHY_CLI'],
          allowedAudiences: ['purrmission-bot', 'discord'],
          maxGrantTtlSeconds: 300,
        }),
      }),
    });

    await repos.guardians.add({
      id: 'guardian-row-1',
      resourceId: 'res-1',
      discordUserId: 'guardian-1',
      role: 'GUARDIAN',
    });

    await repos.guardians.add({
      id: 'guardian-row-2',
      resourceId: 'res-1',
      discordUserId: 'guardian-2',
      role: 'GUARDIAN',
    });
  });

  describe('1. Typed persisted request and grant dimensions', () => {
    it('creates an approval request with all typed dimensions and canonical key set digest', async () => {
      const requester = createDiscordPrincipal('user-1');
      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
        reason: 'Deploying to prod',
        idempotencyKey: 'idem-1',
      });

      assert.equal(createRes.success, true);
      assert.ok(createRes.request);
      const req = createRes.request;

      assert.equal(req.status, 'PENDING');
      assert.ok(req.projectId);
      assert.ok(req.environmentId);
      assert.equal(req.requesterId, 'user-1');
      assert.equal(req.authFamily, 'DISCORD');
      assert.equal(req.audience, 'purrmission-bot');
      assert.equal(req.action, 'secret.value.read');
      assert.equal(req.targetType, 'SECRET');
      assert.equal(req.targetKey, 'api_key');
      assert.ok(req.canonicalKeyDigest);
      assert.deepEqual(req.canonicalKeySet, ['api_key']);
      assert.equal(req.idempotencyKey, 'idem-1');
      assert.ok(req.payloadDigest);
      assert.equal(req.deliveryState, 'PENDING');
    });

    it('replays identical request when same idempotency key is used with same payload', async () => {
      const requester = createDiscordPrincipal('user-1');
      const first = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
        idempotencyKey: 'idem-replay',
      });
      assert.equal(first.success, true);

      const second = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
        idempotencyKey: 'idem-replay',
      });
      assert.equal(second.success, true);
      assert.equal(second.request?.id, first.request?.id);
    });

    it('rejects with ConflictError when idempotency key is reused with different payload', async () => {
      const requester = createDiscordPrincipal('user-1');
      await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
        reason: 'Reason A',
        idempotencyKey: 'idem-conflict',
      });

      await assert.rejects(
        services.approval.createApprovalRequest({
          resourceId: 'res-1',
          principal: requester,
          requesterId: 'user-1',
          requesterType: 'DISCORD_USER',
          authKind: 'DISCORD',
          action: 'secret.value.read',
          targetKey: 'api_key',
          reason: 'Reason B (different!)',
          idempotencyKey: 'idem-conflict',
        }),
        (err: unknown) => err instanceof ConflictError
      );
    });
  });

  describe('2. Explicit self-approval denial', () => {
    it('denies self-approval when requester is a Guardian', async () => {
      const guardianPrincipal = createDiscordPrincipal('guardian-1');
      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: guardianPrincipal,
        requesterId: 'guardian-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.equal(createRes.success, true);
      assert.ok(createRes.request);

      const decision = await services.approval.recordDecision(
        createRes.request.id,
        'APPROVE',
        guardianPrincipal
      );
      assert.equal(decision.success, false);
      assert.match(decision.error ?? '', /cannot approve their own/i);
    });

    it('denies self-approval when requester is the Project Owner', async () => {
      const ownerPrincipal = createDiscordPrincipal('owner-1');
      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: ownerPrincipal,
        requesterId: 'owner-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.equal(createRes.success, true);
      assert.ok(createRes.request);

      const decision = await services.approval.recordDecision(
        createRes.request.id,
        'APPROVE',
        ownerPrincipal
      );
      assert.equal(decision.success, false);
      assert.match(decision.error ?? '', /cannot approve their own/i);
    });
  });

  describe('3. Immutable Grants and Atomic Consumption', () => {
    it('issues immutable grant upon valid Guardian approval, then consumes once atomically', async () => {
      const requester = createDiscordPrincipal('user-1');
      const guardian = createDiscordPrincipal('guardian-1');

      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.ok(createRes.request);
      const reqId = createRes.request.id;

      // An approved request by itself does NOT grant access without consuming the grant
      const decision = await services.approval.recordDecision(reqId, 'APPROVE', guardian);
      assert.equal(decision.success, true);
      assert.ok(decision.grant);
      const grant = decision.grant;

      assert.equal(grant.requestId, reqId);
      assert.equal(grant.requesterId, 'user-1');
      assert.equal(grant.action, 'secret.value.read');
      assert.equal(grant.targetType, 'SECRET');
      assert.equal(grant.targetKey, 'api_key');
      assert.equal(grant.resolverId, 'guardian-1');
      assert.equal(grant.consumedAt, null);

      // Attempt reveal with wrong principal fails
      const attacker = createDiscordPrincipal('attacker-999');
      const failReveal = await services.resource.revealField(
        'res-1',
        'api_key',
        attacker,
        grant.id
      );
      assert.equal(failReveal, null);

      // Reveal with valid principal and grant succeeds
      const field = await services.resource.revealField('res-1', 'api_key', requester, grant.id);
      assert.ok(field);
      assert.equal(field.value, 'secret-token-12345');

      // Grant is now consumed: second consumption attempt MUST fail
      const secondField = await services.resource.revealField(
        'res-1',
        'api_key',
        requester,
        grant.id
      );
      assert.equal(secondField, null);

      await assert.rejects(
        services.approval.consumeGrant(
          grant.id,
          requester,
          'secret.value.read',
          grant.targetVersion,
          grant.policyVersion
        ),
        (err: unknown) =>
          err instanceof AccessDeniedError &&
          (err as Error).message.includes('already been consumed')
      );
    });

    it('rejects grant consumption if target version or policy version has changed', async () => {
      const requester = createDiscordPrincipal('user-1');
      const guardian = createDiscordPrincipal('guardian-1');

      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.ok(createRes.request);

      const decision = await services.approval.recordDecision(
        createRes.request.id,
        'APPROVE',
        guardian
      );
      assert.ok(decision.grant);
      const grant = decision.grant;

      // Stale target version fails closed
      await assert.rejects(
        services.approval.consumeGrant(
          grant.id,
          requester,
          'secret.value.read',
          'stale-target-v999',
          grant.policyVersion
        ),
        (err: unknown) =>
          err instanceof AccessDeniedError &&
          (err as Error).message.includes('Target state version mismatch')
      );
    });
  });

  describe('4. Delegated TOTP custody and consent consumption', () => {
    it('requires valid TOTPDelegationConsent to approve delegated TOTP read and consumes consent in transaction', async () => {
      const requester = createDiscordPrincipal('user-1');
      const custodyOwner = createDiscordPrincipal('custody-owner');
      const guardian = createDiscordPrincipal('guardian-1');

      // 1. Create request for totp.code.read
      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'totp.code.read',
      });
      assert.ok(createRes.request);
      const reqId = createRes.request.id;

      // 2. Approving without custody consent MUST fail closed
      const failedDecision = await services.approval.recordDecision(reqId, 'APPROVE', guardian);
      assert.equal(failedDecision.success, false);
      assert.match(failedDecision.error ?? '', /delegation consent/i);

      // 3. Custody owner creates delegation consent
      const consent = await services.resource.createTOTPDelegationConsent(
        {
          resourceId: 'res-1',
          requesterId: 'user-1',
          operation: 'totp.code.read',
          authFamily: 'DISCORD',
          audience: 'purrmission-bot',
        },
        custodyOwner
      );
      assert.ok(consent);
      assert.equal(consent.usedAt, null);

      // 4. Guardian approves with consentId -> succeeds, consumes consent, issues grant
      const decision = await services.approval.recordDecision(
        reqId,
        'APPROVE',
        guardian,
        consent.id
      );
      assert.equal(decision.success, true);
      assert.ok(decision.grant);

      // Consent is now used
      const updatedConsent = await repos.totp.findDelegationConsentById(consent.id);
      assert.ok(updatedConsent?.usedAt);

      // 5. Requester reveals TOTP code using the grant
      const code = await services.resource.revealTOTPCode('res-1', requester, decision.grant.id);
      assert.match(code, /^\d{6}$/);

      // 6. Second reveal attempt with consumed grant fails
      await assert.rejects(
        services.resource.revealTOTPCode('res-1', requester, decision.grant.id),
        (err: unknown) => err instanceof AccessDeniedError
      );
    });
  });

  describe('5. Cancellation and Expiry', () => {
    it('allows requester to cancel their own pending request and prevents subsequent approval', async () => {
      const requester = createDiscordPrincipal('user-1');
      const guardian = createDiscordPrincipal('guardian-1');

      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.ok(createRes.request);
      const reqId = createRes.request.id;

      // Other user cannot cancel
      const cancelAttacker = await services.approval.cancelApprovalRequest(
        reqId,
        createDiscordPrincipal('other-user')
      );
      assert.equal(cancelAttacker.success, false);

      // Requester cancels
      const cancelRes = await services.approval.cancelApprovalRequest(reqId, requester);
      assert.equal(cancelRes.success, true);

      const reqAfter = await services.approval.getApprovalRequest(reqId);
      assert.equal(reqAfter?.status, 'CANCELLED');

      // Guardian cannot approve a cancelled request
      const approveRes = await services.approval.recordDecision(reqId, 'APPROVE', guardian);
      assert.equal(approveRes.success, false);
      assert.match(approveRes.error ?? '', /no longer pending/i);
    });
  });

  describe('6. Concurrency and Exactly-One-Winner Guarantees', () => {
    it('proves exactly one winner among concurrent approve/deny racers', async () => {
      const requester = createDiscordPrincipal('user-1');
      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.ok(createRes.request);
      const reqId = createRes.request.id;

      // 10 concurrent guardian decision racers
      const decisions = Array.from({ length: 10 }, (_, i) =>
        services.approval.recordDecision(
          reqId,
          i % 2 === 0 ? 'APPROVE' : 'DENY',
          createDiscordPrincipal(`guardian-${(i % 2) + 1}`)
        )
      );

      const results = await Promise.all(decisions);
      const successful = results.filter((r) => r.success);
      assert.equal(successful.length, 1, 'Exactly one decision racer must win');

      // Request is terminal and no duplicate grants were issued
      const finalReq = await services.approval.getApprovalRequest(reqId);
      assert.ok(['APPROVED', 'DENIED'].includes(finalReq?.status ?? ''));
    });

    it('proves exactly one winner among concurrent grant consumption racers', async () => {
      const requester = createDiscordPrincipal('user-1');
      const guardian = createDiscordPrincipal('guardian-1');

      const createRes = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.ok(createRes.request);

      const decision = await services.approval.recordDecision(
        createRes.request.id,
        'APPROVE',
        guardian
      );
      assert.ok(decision.grant);
      const grantId = decision.grant.id;

      // 10 concurrent consumption racers
      const reveals = Array.from({ length: 10 }, () =>
        services.resource.revealField('res-1', 'api_key', requester, grantId)
      );

      const results = await Promise.all(reveals);
      const successful = results.filter((r) => r !== null);
      assert.equal(successful.length, 1, 'Exactly one consumption racer must succeed');
    });

    it('proves exactly one winner for delegated TOTP consent consumption under concurrent approvals', async () => {
      const requester = createDiscordPrincipal('user-1');
      const custodyOwner = createDiscordPrincipal('custody-owner');

      // Create request 1 and request 2 for same user
      const req1 = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'totp.code.read',
      });
      assert.ok(req1.request);

      const req2 = await repos.approvalRequests.create({
        id: 'req-2',
        resourceId: 'res-1',
        projectId: 'proj-1',
        environmentId: 'env-1',
        status: 'PENDING',
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        authFamily: 'DISCORD',
        audience: 'purrmission-bot',
        action: 'totp.code.read',
        targetType: 'TOTP_ACCOUNT',
        targetId: 'totp-account-1',
        targetKey: null,
        canonicalKeySet: null,
        canonicalKeyDigest: null,
        targetVersion: 'v1',
        policyVersion: 'v1',
        constraints: null,
        deliveryState: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      });

      // Single consent created
      const consent = await services.resource.createTOTPDelegationConsent(
        {
          resourceId: 'res-1',
          requesterId: 'user-1',
          operation: 'totp.code.read',
          authFamily: 'DISCORD',
          audience: 'purrmission-bot',
        },
        custodyOwner
      );

      // Concurrent approval attempts for req1 and req2 using the same single consent
      const [res1, res2] = await Promise.all([
        services.approval.recordDecision(
          req1.request.id,
          'APPROVE',
          createDiscordPrincipal('guardian-1'),
          consent.id
        ),
        services.approval.recordDecision(
          req2.id,
          'APPROVE',
          createDiscordPrincipal('guardian-2'),
          consent.id
        ),
      ]);

      const winners = [res1, res2].filter((r) => r.success);
      assert.equal(winners.length, 1, 'Single TOTP delegation consent can only be consumed once');
    });

    it('rejects TOTP delegation consent when authFamily or audience does not match request', async () => {
      const requester = createDiscordPrincipal('user-1');
      const custodyOwner = createDiscordPrincipal('custody-owner');

      const req = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'totp.code.read',
      });
      assert.ok(req.request);

      // Consent created specifically for PAWTHY_CLI, but request is for DISCORD
      const consent = await services.resource.createTOTPDelegationConsent(
        {
          resourceId: 'res-1',
          requesterId: 'user-1',
          operation: 'totp.code.read',
          authFamily: 'PAWTHY_CLI',
          audience: 'purrmission-bot',
        },
        custodyOwner
      );

      const decisionRes = await services.approval.recordDecision(
        req.request.id,
        'APPROVE',
        createDiscordPrincipal('guardian-1'),
        consent.id
      );
      assert.equal(decisionRes.success, false);
      assert.match(decisionRes.error || '', /bindings do not match/);
    });

    it('deduplicates pending requests with same authFamily and audience, but separates different auth families', async () => {
      const requester = createDiscordPrincipal('user-1');

      const req1 = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });

      // Same authFamily/audience returns existing pending
      const req2 = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.equal(req1.request?.id, req2.request?.id);

      // Distinct authFamily (e.g. PAWTHY_TOKEN) creates distinct request
      const pawthyPrincipal = {
        id: 'token-1',
        type: 'PAWTHY_TOKEN' as const,
        subjectId: 'user-1',
        authKind: 'PAWTHY' as const,
        authFamily: 'PAWTHY_CLI' as const,
        audience: 'pawthy-cli',
      };
      const req3 = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: pawthyPrincipal,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'PAWTHY',
        action: 'secret.value.read',
        targetKey: 'api_key',
      });
      assert.notEqual(req1.request?.id, req3.request?.id);
    });

    it('consistently produces the same payload digest regardless of constraint object key ordering', async () => {
      const requester = createDiscordPrincipal('user-1');

      const req1 = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
        idempotencyKey: 'idem-sort-test-1',
        constraints: { z: 1, a: 2, m: { nestedB: true, nestedA: false } },
      });

      const req2 = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        principal: requester,
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secret.value.read',
        targetKey: 'api_key',
        idempotencyKey: 'idem-sort-test-1',
        constraints: { a: 2, m: { nestedA: false, nestedB: true }, z: 1 },
      });

      assert.equal(req1.request?.id, req2.request?.id);
      assert.equal(req1.request?.payloadDigest, req2.request?.payloadDigest);
    });
  });
});
