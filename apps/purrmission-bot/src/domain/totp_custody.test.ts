import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AccessDeniedError } from './auth.js';
import { AuditService } from './audit.js';
import type { Principal } from './models.js';
import { createDiscordPrincipal } from './principal.js';
import { ProjectService } from './project.js';
import { createInMemoryRepositories } from './repositories.mock.js';
import { ApprovalService, ResourceService, type ServiceDependencies } from './services.js';

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
      (await repos.totp.findByOwnerAndName('seed-owner', account.accountName))?.id,
      account.id
    );
    assert.equal(await repos.totp.findByOwnerAndName('stranger', account.accountName), null);
    assert.equal(await resourceService.revealTOTPRecoveryKey(account.id, 'seed-owner'), 'RECOVERY');
    await assert.rejects(
      resourceService.revealTOTPRecoveryKey(account.id, 'stranger'),
      /Only the personal owner/
    );
  });

  it('fails closed for link-consent creation and linking until seed-version custody binding lands', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const oldConsent = await repos.totp.createLinkConsent({
      accountId: account.id,
      resourceId,
      ownerDiscordUserId: 'seed-owner',
      delegationPolicy: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repos.totp.update({ ...account, secret: 'KRSXG5DSNFXGOIDB' });

    await assert.rejects(
      resourceService.createTOTPLinkConsent(account.id, resourceId, 'seed-owner', {}),
      /#120/
    );
    await assert.rejects(
      resourceService.linkTOTPAccount(
        resourceId,
        account.id,
        createDiscordPrincipal('resource-owner'),
        oldConsent.id
      ),
      /#120/
    );
    assert.equal((await repos.totp.findLinkConsentById(oldConsent.id))?.usedAt, null);
    assert.equal((await repos.resources.findById(resourceId))?.totpAccountId, undefined);
  });

  it('denies unauthenticated delegation-consent creation', async () => {
    await assert.rejects(
      resourceService.createTOTPDelegationConsent(
        'resource-id',
        'account-id',
        'forged-requester',
        'totp.code.read',
        'forged-auth-family'
      ),
      /authenticated custody/
    );
  });

  it('allows a direct Resource owner to reveal an already-linked TOTP code', async () => {
    const ownerId = 'resource-owner';
    const resourceId = await createOwnedResource(ownerId);
    const account = await repos.totp.create({
      ownerDiscordUserId: ownerId,
      accountName: 'Existing linked seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    await repos.resources.update(resourceId, { totpAccountId: account.id, version: 'link-v1' });

    assert.match(await resourceService.revealTOTPCode(resourceId, ownerId), /^\d{6}$/);
  });

  it('rejects delegated reveal unconditionally even when generic grant and consent records exist', async () => {
    const resourceId = await createOwnedResource('resource-owner');
    const account = await repos.totp.create({
      ownerDiscordUserId: 'seed-owner',
      accountName: 'Existing linked seed',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    const resource = await repos.resources.update(resourceId, {
      totpAccountId: account.id,
      version: 'link-v1',
    });
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
      authFamily: 'DISCORD',
      accountVersion: account.version,
      linkVersion: resource.version,
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
    await resourceService.unlinkTOTPAccount(resourceId, ownerId);
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
