import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { AccessDeniedError } from './auth.js';
import { AuditService } from './audit.js';
import type { Principal } from './models.js';
import { createDiscordPrincipal } from './principal.js';
import { ProjectService } from './project.js';
import { createInMemoryRepositories } from './repositories.mock.js';
import { ApprovalService, ResourceService, type ServiceDependencies } from './services.js';
import { parseTOTPDelegationPolicy } from './totp_custody.js';

describe('TOTP custody boundaries', () => {
  let repos: ReturnType<typeof createInMemoryRepositories>;
  let resourceService: ResourceService;
  let projectService: ProjectService;

  beforeEach(() => {
    repos = createInMemoryRepositories();
    const audit = new AuditService({ repositories: repos });
    const deps: ServiceDependencies = { repositories: repos, audit };
    deps.approval = new ApprovalService(deps);
    resourceService = new ResourceService(deps);
    projectService = new ProjectService(repos.projects, resourceService, audit, repos.transaction);
  });

  it('defaults malformed, incomplete, and unrecognized delegation policy to deny', () => {
    for (const policy of [
      null,
      {},
      { allowDelegation: true },
      {
        allowDelegation: true,
        allowedOperations: ['totp.code.read'],
        allowedAuthFamilies: ['DISCORD'],
        allowedAudiences: ['discord'],
        maxGrantTtlSeconds: 60,
        futureAuthority: true,
      },
    ]) {
      assert.equal(parseTOTPDelegationPolicy(policy).allowDelegation, false);
    }
  });

  async function createOwnedResource(ownerId: string): Promise<string> {
    const principal = createDiscordPrincipal(ownerId);
    const project = await projectService.createProject({ name: 'Project', ownerId }, principal);
    const environment = await projectService.createEnvironment(
      {
        projectId: project.id,
        name: 'Production',
        slug: 'prod',
      },
      principal
    );
    assert.ok(environment.resourceId);
    return environment.resourceId;
  }

  it('keeps personal account lookup and recovery custody owner-scoped', async () => {
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Personal Bank',
      secret: 'JBSWY3DPEHPK3PXP',
      backupKey: 'RECOVERY',
    });
    assert.equal(
      (await repos.totp.findMetadataByOwnerAndName('seed-owner', account.accountName))?.id,
      account.id
    );
    assert.equal(
      await repos.totp.findMetadataByOwnerAndName('stranger', account.accountName),
      null
    );
    assert.equal(
      await resourceService.revealTOTPRecoveryKey(account.id, createDiscordPrincipal('seed-owner')),
      'RECOVERY'
    );
    await assert.rejects(
      resourceService.revealTOTPRecoveryKey(account.id, createDiscordPrincipal('stranger')),
      /Only the personal owner/
    );
  });

  it('links cross-owner custody only with an exact one-time seed-version consent', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const consent = await resourceService.createTOTPLinkConsent(
      account.id,
      resourceId,
      createDiscordPrincipal('seed-owner'),
      'resource-owner',
      {}
    );
    await resourceService.linkTOTPAccount(
      resourceId,
      account.id,
      createDiscordPrincipal('resource-owner'),
      consent.id
    );
    assert.ok((await repos.totp.findLinkConsentById(consent.id))?.usedAt);
    assert.equal((await repos.resources.findById(resourceId))?.totpAccountId, account.id);
    await assert.rejects(
      resourceService.linkTOTPAccount(
        resourceId,
        account.id,
        createDiscordPrincipal('resource-owner'),
        consent.id
      )
    );
  });

  it('refuses link consent for a caller-supplied non-owner initiator', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Bound initiator',
      secret: 'JBSWY3DPEHPK3PXP',
    });

    await assert.rejects(
      resourceService.createTOTPLinkConsent(
        account.id,
        resourceId,
        createDiscordPrincipal('seed-owner'),
        'not-the-resource-owner',
        {}
      ),
      /must name a current Resource or Project owner/
    );
  });

  it('denies forged delegation-consent creation', async () => {
    await assert.rejects(
      resourceService.createTOTPDelegationConsent(
        {
          resourceId: 'resource-id',
          requesterId: 'forged-requester',
          operation: 'totp.code.read',
          authFamily: 'DISCORD',
          audience: 'discord',
        },
        createDiscordPrincipal('stranger')
      ),
      /No linked TOTP account/
    );
  });

  it('invalidates an unused link consent when the seed rotates', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Rotating',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const consent = await resourceService.createTOTPLinkConsent(
      account.id,
      resourceId,
      createDiscordPrincipal('seed-owner'),
      'resource-owner',
      {}
    );
    await repos.totp.update({ ...account, secret: 'KRSXG5DSNFXGOIDB' });
    await assert.rejects(
      resourceService.linkTOTPAccount(
        resourceId,
        account.id,
        createDiscordPrincipal('resource-owner'),
        consent.id
      ),
      /stale, used, or does not match/
    );
    assert.equal((await repos.totp.findLinkConsentById(consent.id))?.usedAt, null);
  });

  it('allows exactly one concurrent link-consent claimant', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'One winner',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const consent = await resourceService.createTOTPLinkConsent(
      account.id,
      resourceId,
      createDiscordPrincipal('seed-owner'),
      'resource-owner',
      {}
    );
    const attempts = await Promise.allSettled([
      resourceService.linkTOTPAccount(
        resourceId,
        account.id,
        createDiscordPrincipal('resource-owner'),
        consent.id
      ),
      resourceService.linkTOTPAccount(
        resourceId,
        account.id,
        createDiscordPrincipal('resource-owner'),
        consent.id
      ),
    ]);
    assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
  });

  it('creates exact short-lived delegation consent only under an allowlisted link policy', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Delegable',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const consent = await resourceService.createTOTPLinkConsent(
      account.id,
      resourceId,
      createDiscordPrincipal('seed-owner'),
      'resource-owner',
      {
        allowDelegation: true,
        allowedOperations: ['totp.code.read'],
        allowedAuthFamilies: ['DISCORD'],
        allowedAudiences: ['discord-dashboard'],
        maxGrantTtlSeconds: 120,
      }
    );
    await resourceService.linkTOTPAccount(
      resourceId,
      account.id,
      createDiscordPrincipal('resource-owner'),
      consent.id
    );
    const delegated = await resourceService.createTOTPDelegationConsent(
      {
        resourceId,
        requesterId: 'requester',
        operation: 'totp.code.read',
        authFamily: 'DISCORD',
        audience: 'discord-dashboard',
      },
      createDiscordPrincipal('seed-owner')
    );
    assert.equal(delegated.ownerDiscordUserId, 'seed-owner');
    assert.equal(delegated.audience, 'discord-dashboard');
    assert.ok(delegated.maxGrantExpiresAt <= delegated.expiresAt);
    assert.ok(delegated.maxGrantExpiresAt.getTime() - delegated.createdAt.getTime() <= 120_000);
    await assert.rejects(
      resourceService.createTOTPDelegationConsent(
        {
          resourceId,
          requesterId: 'requester',
          operation: 'totp.code.read',
          authFamily: 'DISCORD',
          audience: 'wrong-audience',
        },
        createDiscordPrincipal('seed-owner')
      ),
      /does not permit/
    );
    const claims = await Promise.all([
      repos.totp.consumeDelegationConsent({
        ...delegated,
        grantExpiresAt: delegated.maxGrantExpiresAt,
      }),
      repos.totp.consumeDelegationConsent({
        ...delegated,
        grantExpiresAt: delegated.maxGrantExpiresAt,
      }),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);
  });

  it('gives Writer, Reader, Guardian, and Requester no direct code or link authority', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const environment = await repos.projects.findEnvironmentByResourceId(resourceId);
    assert.ok(environment);
    await repos.projects.addMember({
      projectId: environment.projectId,
      userId: 'writer',
      role: 'WRITER',
      addedBy: 'resource-owner',
    });
    await repos.projects.addMember({
      projectId: environment.projectId,
      userId: 'reader',
      role: 'READER',
      addedBy: 'resource-owner',
    });
    await repos.guardians.add({ resourceId, discordUserId: 'guardian', role: 'GUARDIAN' });
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Restricted',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const linkConsent = await resourceService.createTOTPLinkConsent(
      account.id,
      resourceId,
      createDiscordPrincipal('seed-owner'),
      'resource-owner',
      {}
    );
    await resourceService.linkTOTPAccount(
      resourceId,
      account.id,
      createDiscordPrincipal('resource-owner'),
      linkConsent.id
    );
    for (const subject of ['writer', 'reader', 'guardian', 'requester']) {
      await assert.rejects(
        resourceService.revealTOTPCode(resourceId, createDiscordPrincipal(subject)),
        /deferred until request-bound/
      );
      await assert.rejects(
        resourceService.linkTOTPAccount(
          resourceId,
          account.id,
          createDiscordPrincipal(subject),
          crypto.randomUUID()
        )
      );
    }
  });

  it('allows a direct Resource owner to reveal an already-linked TOTP code', async () => {
    const ownerId = 'resource-owner';
    const resourceId = await createOwnedResource(ownerId);
    const account = await repos.totp.create({
      ownerDiscordUserId: ownerId,
      accountName: 'Existing linked seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const consent = await resourceService.createTOTPLinkConsent(
      account.id,
      resourceId,
      createDiscordPrincipal(ownerId),
      ownerId,
      {}
    );
    await resourceService.linkTOTPAccount(
      resourceId,
      account.id,
      createDiscordPrincipal(ownerId),
      consent.id
    );

    assert.match(
      await resourceService.revealTOTPCode(resourceId, createDiscordPrincipal(ownerId)),
      /^\d{6}$/
    );
  });

  it('rejects a direct owner reveal after the consent-bound account version rotates', async () => {
    const ownerId = 'resource-owner';
    const resourceId = await createOwnedResource(ownerId);
    const account = await repos.totp.create({
      ownerDiscordUserId: ownerId,
      accountName: 'Rotated linked seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const consent = await resourceService.createTOTPLinkConsent(
      account.id,
      resourceId,
      createDiscordPrincipal(ownerId),
      ownerId,
      {}
    );
    await resourceService.linkTOTPAccount(
      resourceId,
      account.id,
      createDiscordPrincipal(ownerId),
      consent.id
    );
    await repos.totp.update({ ...account, secret: 'KRSXG5DSNFXGOIDB' });

    await assert.rejects(
      resourceService.revealTOTPCode(resourceId, createDiscordPrincipal(ownerId)),
      /link consent is stale or malformed/
    );
  });

  it('rejects delegated reveal unconditionally even when generic grant and consent records exist', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Existing linked seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const linkConsent = await resourceService.createTOTPLinkConsent(
      account.id,
      resourceId,
      createDiscordPrincipal('seed-owner'),
      'resource-owner',
      {}
    );
    await resourceService.linkTOTPAccount(
      resourceId,
      account.id,
      createDiscordPrincipal('resource-owner'),
      linkConsent.id
    );
    const resource = await repos.resources.findById(resourceId);
    assert.ok(resource);
    const grant = await repos.approvalGrants.create({
      requestId: 'unrelated-request-a',
      resourceId,
      requesterId: 'requester',
      requesterType: 'DISCORD_USER',
      authKind: 'DISCORD',
      action: 'totp.code.read',
      targetKey: null,
      targetVersion: resource.version,
      policyVersion: resource.version,
      constraints: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const consent = await repos.totp.createDelegationConsent({
      resourceId,
      totpAccountId: account.id,
      operation: 'totp.code.read',
      requesterId: 'requester',
      ownerDiscordUserId: 'seed-owner',
      authFamily: 'DISCORD',
      audience: 'discord',
      accountVersion: account.version,
      linkVersion: resource.totpLinkVersion,
      maxGrantExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await assert.rejects(
      resourceService.revealTOTPCode(
        resourceId,
        createDiscordPrincipal('requester'),
        grant.id,
        consent.id
      ),
      (error: unknown) =>
        error instanceof AccessDeniedError && error.message.includes('request-bound')
    );
    assert.equal((await repos.approvalGrants.findById(grant.id))?.consumedAt, null);
    assert.equal((await repos.totp.findDelegationConsentById(consent.id))?.usedAt, null);
  });

  it('allows an owner to unlink an already-linked account', async () => {
    const ownerId = 'resource-owner';
    const resourceId = await createOwnedResource(ownerId);
    const account = await repos.totp.create({
      ownerDiscordUserId: ownerId,
      accountName: 'Existing linked seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    await repos.resources.update(resourceId, { totpAccountId: account.id, version: 'link-v1' });
    await resourceService.unlinkTOTPAccount(resourceId, createDiscordPrincipal(ownerId));
    assert.equal((await repos.resources.findById(resourceId))?.totpAccountId, undefined);
  });

  it('attributes unlink to the authenticated principal kind', async () => {
    const ownerId = 'resource-owner';
    const resourceId = await createOwnedResource(ownerId);
    const account = await repos.totp.create({
      ownerDiscordUserId: ownerId,
      accountName: 'Existing linked seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    await repos.resources.update(resourceId, { totpAccountId: account.id, version: 'link-v1' });

    const deps: ServiceDependencies = {
      repositories: repos,
      audit: new AuditService({ repositories: repos }),
    };
    const auditedResourceService = new ResourceService(deps);
    const pawthyPrincipal: Principal = {
      type: 'PAWTHY_TOKEN',
      id: 'pawthy-token-1',
      subjectId: ownerId,
      actorDiscordId: ownerId,
      authKind: 'PAWTHY',
      scopes: ['totp.link.manage'],
    };

    await auditedResourceService.unlinkTOTPAccount(resourceId, pawthyPrincipal);
    const event = (await repos.audit.findByScope({ type: 'RESOURCE', id: resourceId })).find(
      ({ eventType }) => eventType === 'TOTP_UNLINK'
    );
    assert.ok(event);
    assert.equal(event.actorType, 'PAWTHY_TOKEN');
    assert.equal(event.authKind, 'PAWTHY');
    assert.equal(event.actorId, ownerId);
  });
});
