import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AccessDeniedError } from './auth.js';
import { createDiscordPrincipal } from './principal.js';
import { createInMemoryRepositories } from './repositories.mock.js';
import { createServices } from './services.js';

describe('Approval decisions and provisional authority fail closed', () => {
  let repos: ReturnType<typeof createInMemoryRepositories>;
  let services: ReturnType<typeof createServices>;

  beforeEach(async () => {
    repos = createInMemoryRepositories();
    services = createServices({ repositories: repos });
    await repos.resources.create({
      id: 'res-1',
      name: 'Protected Resource',
      mode: 'ONE_OF_N',
      apiKey: null,
    });
    const account = await repos.totp.create({
      ownerDiscordUserId: 'custody-owner',
      accountName: 'Protected OTP',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    await repos.resources.update('res-1', { totpAccountId: account.id });
    await repos.guardians.add({
      id: 'guardian-row-1',
      resourceId: 'res-1',
      discordUserId: 'guardian-1',
      role: 'GUARDIAN',
    });
  });

  it('deduplicates exact pending requests', async () => {
    const input = {
      resourceId: 'res-1',
      requesterId: 'user-1',
      requesterType: 'DISCORD_USER',
      authKind: 'DISCORD',
      action: 'secrets.read',
    };
    const first = await services.approval.createApprovalRequest(input);
    const second = await services.approval.createApprovalRequest(input);
    assert.ok(first.request);
    assert.equal(second.request?.id, first.request.id);
  });

  it('prevents self approval', async () => {
    const result = await services.approval.createApprovalRequest({
      resourceId: 'res-1',
      requesterId: 'guardian-1',
      requesterType: 'DISCORD_USER',
      authKind: 'DISCORD',
      action: 'secrets.read',
    });
    assert.ok(result.request);
    const decision = await services.approval.recordDecision(
      result.request.id,
      'APPROVE',
      createDiscordPrincipal('guardian-1')
    );
    assert.equal(decision.success, false);
    assert.match(decision.error ?? '', /cannot approve their own/i);
  });

  it('records APPROVED as non-authority and mints no grant', async () => {
    const result = await services.approval.createApprovalRequest({
      resourceId: 'res-1',
      requesterId: 'user-1',
      requesterType: 'DISCORD_USER',
      authKind: 'DISCORD',
      action: 'totp.code.read',
    });
    assert.ok(result.request);
    const decision = await services.approval.recordDecision(
      result.request.id,
      'APPROVE',
      createDiscordPrincipal('guardian-1')
    );
    assert.equal(decision.success, true);
    assert.equal(decision.request?.status, 'APPROVED');
    assert.equal(await repos.approvalGrants.findByRequestId(result.request.id), null);
  });

  it('retains one-time validation for manually persisted future-model grants', async () => {
    const grant = await repos.approvalGrants.create({
      requestId: 'future-request',
      resourceId: 'res-1',
      requesterId: 'user-1',
      requesterType: 'DISCORD_USER',
      authKind: 'DISCORD',
      action: 'secrets.read',
      targetKey: null,
      targetVersion: 'v1',
      policyVersion: 'v1',
      constraints: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const principal = createDiscordPrincipal('user-1');
    await services.approval.consumeGrant(grant.id, principal, 'secrets.read', 'v1', 'v1');
    await assert.rejects(
      services.approval.consumeGrant(grant.id, principal, 'secrets.read', 'v1', 'v1'),
      (error: unknown) =>
        error instanceof AccessDeniedError && error.message.includes('already been consumed')
    );
  });

  it('denies grant A plus consent B without consuming either provisional record', async () => {
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Account B',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const resource = await repos.resources.update('res-1', {
      totpAccountId: account.id,
      version: 'link-v1',
    });
    const grantA = await repos.approvalGrants.create({
      requestId: 'request-a',
      resourceId: resource.id,
      requesterId: 'user-1',
      requesterType: 'DISCORD_USER',
      authKind: 'DISCORD',
      action: 'totp.code.read',
      targetKey: null,
      targetVersion: resource.version,
      policyVersion: resource.version,
      constraints: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const consentB = await repos.totp.createDelegationConsent({
      resourceId: resource.id,
      totpAccountId: account.id,
      operation: 'totp.code.read',
      requesterId: 'user-1',
      authFamily: 'DISCORD',
      accountVersion: account.version,
      linkVersion: resource.version,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await assert.rejects(
      services.resource.revealTOTPCode(
        resource.id,
        createDiscordPrincipal('user-1'),
        grantA.id,
        consentB.id
      ),
      (error: unknown) =>
        error instanceof AccessDeniedError && error.message.includes('request-bound')
    );
    assert.equal((await repos.approvalGrants.findById(grantA.id))?.consumedAt, null);
    assert.equal((await repos.totp.findDelegationConsentById(consentB.id))?.usedAt, null);
  });
});
