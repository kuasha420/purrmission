import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createInMemoryRepositories } from './repositories.mock.js';
import { createServices } from './services.js';
import { Principal } from './auth.js';
import { AccessDeniedError } from './auth.js';

describe('Approval Request V2, Immutable Grants, and Atomic Consumption', () => {
  let repos: ReturnType<typeof createInMemoryRepositories>;
  let services: ReturnType<typeof createServices>;

  beforeEach(async () => {
    repos = createInMemoryRepositories();
    services = createServices({ repositories: repos });

    // Seed a mock project and resource
    const project = await repos.projects.createProject({
      name: 'Test Project',
      ownerId: 'owner-1',
    });

    // Seed a mock TOTP account
    const account = await repos.totp.create({
      ownerDiscordUserId: 'owner-1',
      accountName: 'Test Account',
      secret: 'MOCKSECRET',
      issuer: 'Test',
    });

    await repos.resources.create({
      id: 'res-1',
      projectId: project.id,
      name: 'Test Resource',
      type: '2FA_SEED',
      totpAccountId: account.id,
      version: 'v1',
    });

    // Add a guardian to res-1
    await repos.guardians.add({
      resourceId: 'res-1',
      discordUserId: 'guardian-1',
      role: 'GUARDIAN',
    });
  });

  describe('Request Deduplication', () => {
    test('should return existing request when duplicate pending request is created', async () => {
      const res1 = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secrets.read',
        targetVersion: 'v1',
        policyVersion: 'v1',
      });

      assert.ok(res1.success);
      assert.ok(res1.request);

      const res2 = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secrets.read',
        targetVersion: 'v1',
        policyVersion: 'v1',
      });

      assert.ok(res2.success);
      assert.strictEqual(res2.request?.id, res1.request?.id);
    });
  });

  describe('Self-Approval Prevention', () => {
    test('should reject approval from the requester themselves', async () => {
      const res = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        requesterId: 'guardian-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secrets.read',
        targetVersion: 'v1',
        policyVersion: 'v1',
      });

      assert.ok(res.success);
      assert.ok(res.request);

      const decision = await services.approval.recordDecision(
        res.request.id,
        'APPROVE',
        'guardian-1'
      );

      assert.strictEqual(decision.success, false);
      assert.strictEqual(decision.error, 'Requesters cannot approve their own requests.');
    });
  });

  describe('Immutable Grants & One-Time Atomic Consumption', () => {
    test('should issue an immutable grant upon approval, consume it once, and block subsequent attempts', async () => {
      const res = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secrets.read',
        targetVersion: 'v1',
        policyVersion: 'v1',
      });

      assert.ok(res.success);
      assert.ok(res.request);

      // Resolve the request
      const decision = await services.approval.recordDecision(
        res.request.id,
        'APPROVE',
        'guardian-1'
      );
      assert.ok(decision.success);

      // Verify a grant exists
      const grant = await repos.approvalGrants.findByRequestId(res.request.id);
      assert.ok(grant);
      assert.strictEqual(grant.consumedAt, null);

      const principal: Principal = {
        type: 'DISCORD_USER',
        id: 'user-1',
        subjectId: 'user-1',
        authKind: 'DISCORD',
        actorDiscordId: 'user-1',
      };

      // Consume the grant
      await services.approval.consumeGrant(grant.id, principal, 'secrets.read', 'v1', 'v1');

      // Verify grant is marked consumed in DB
      const consumedGrant = await repos.approvalGrants.findById(grant.id);
      assert.ok(consumedGrant?.consumedAt);

      // Attempt to consume again should fail
      await assert.rejects(
        services.approval.consumeGrant(grant.id, principal, 'secrets.read', 'v1', 'v1'),
        (err: any) =>
          err instanceof AccessDeniedError && err.message.includes('already been consumed')
      );
    });

    test('should reject consumption if targetVersion or policyVersion has changed', async () => {
      const res = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        requesterId: 'user-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'secrets.read',
        targetVersion: 'v1',
        policyVersion: 'v1',
      });

      assert.ok(res.success);
      const decision = await services.approval.recordDecision(
        res.request!.id,
        'APPROVE',
        'guardian-1'
      );
      assert.ok(decision.success);

      const grant = await repos.approvalGrants.findByRequestId(res.request!.id);
      assert.ok(grant);

      const principal: Principal = {
        type: 'DISCORD_USER',
        id: 'user-1',
        subjectId: 'user-1',
        authKind: 'DISCORD',
        actorDiscordId: 'user-1',
      };

      // Reject consumption with mismatched targetVersion
      await assert.rejects(
        services.approval.consumeGrant(grant.id, principal, 'secrets.read', 'v2', 'v1'),
        (err: any) =>
          err instanceof AccessDeniedError && err.message.includes('Target state version mismatch')
      );

      // Reject consumption with mismatched policyVersion
      await assert.rejects(
        services.approval.consumeGrant(grant.id, principal, 'secrets.read', 'v1', 'v2'),
        (err: any) =>
          err instanceof AccessDeniedError && err.message.includes('Policy version mismatch')
      );
    });
  });

  describe('Delegated TOTP Reveal (Double-Gating)', () => {
    test('should require both a valid active ApprovalGrant and TOTPDelegationConsent for delegated access', async () => {
      const requesterId = 'user-1';

      // Create and approve request
      const res = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        requesterId,
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'totp.code.read',
      });
      assert.ok(res.request);

      const decision = await services.approval.recordDecision(
        res.request.id,
        'APPROVE',
        'guardian-1'
      );
      assert.ok(decision.success);

      // Get latest rotated resource details and create delegation consent
      const resource = await repos.resources.findById('res-1');
      assert.ok(resource);
      const totpAccountId = resource.totpAccountId!;
      const account = await repos.totp.findById(totpAccountId);
      assert.ok(account);

      // Create delegation consent directly in repo with rotated linkVersion
      const consent = await repos.totp.createDelegationConsent({
        resourceId: 'res-1',
        totpAccountId,
        operation: 'totp.code.read',
        requesterId,
        authFamily: 'DISCORD',
        accountVersion: account.version,
        linkVersion: resource.version,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const principal: Principal = {
        type: 'DISCORD_USER',
        id: requesterId,
        subjectId: requesterId,
        authKind: 'DISCORD',
        actorDiscordId: requesterId,
      };

      // Reveal should succeed
      const code = await services.resource.revealTOTPCode('res-1', principal);
      assert.ok(code);

      // Consent and Grant must be consumed now
      const consumedConsent = await repos.totp.findDelegationConsentById(consent.id);
      assert.ok(consumedConsent?.usedAt);

      const activeGrant = await repos.approvalGrants.findActiveUnconsumed(
        'res-1',
        requesterId,
        'totp.code.read',
        null
      );
      assert.strictEqual(activeGrant, null);
    });

    test('should fail reveal if delegation consent has changed seed version', async () => {
      const requesterId = 'user-1';

      // Create and approve request
      const res = await services.approval.createApprovalRequest({
        resourceId: 'res-1',
        requesterId,
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'totp.code.read',
      });
      assert.ok(res.request);

      const decision = await services.approval.recordDecision(
        res.request.id,
        'APPROVE',
        'guardian-1'
      );
      assert.ok(decision.success);

      const resource = await repos.resources.findById('res-1');
      assert.ok(resource);
      const totpAccountId = resource.totpAccountId!;

      // Create delegation consent directly in repo with stale seed version
      await repos.totp.createDelegationConsent({
        resourceId: 'res-1',
        totpAccountId,
        operation: 'totp.code.read',
        requesterId,
        authFamily: 'DISCORD',
        accountVersion: 'seed-stale',
        linkVersion: resource.version,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const principal: Principal = {
        type: 'DISCORD_USER',
        id: requesterId,
        subjectId: requesterId,
        authKind: 'DISCORD',
        actorDiscordId: requesterId,
      };

      // Reveal should fail closed
      await assert.rejects(
        services.resource.revealTOTPCode('res-1', principal),
        (err: any) =>
          err instanceof AccessDeniedError && err.message.includes('seed version has changed')
      );
    });
  });
});
