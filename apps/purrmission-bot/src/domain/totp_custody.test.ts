import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createInMemoryRepositories } from './repositories.mock.js';
import { ResourceService, ApprovalService } from './services.js';
import { ProjectService } from './project.js';

describe('TOTP Custody, Consents, and Reveals', () => {
  let repos: ReturnType<typeof createInMemoryRepositories>;
  let resourceService: ResourceService;
  let projectService: ProjectService;

  beforeEach(() => {
    repos = createInMemoryRepositories();
    const deps: any = { repositories: repos };
    const approval = new ApprovalService(deps);
    deps.approval = approval;
    resourceService = new ResourceService(deps);
    projectService = new ProjectService(repos.projects, resourceService);
  });

  describe('Global Shared switch removal', () => {
    it('should only resolve personal accounts for the acting user', async () => {
      const ownerId = 'user-owner';
      const otherId = 'user-other';

      const acc = await repos.totp.create({
        ownerDiscordUserId: ownerId,
        accountName: 'Personal Bank',
        secret: 'BASE32SECRET3232323232323232',
        issuer: 'Bank',
      });

      // Owner can find it
      const found = await repos.totp.findByOwnerAndName(ownerId, 'Personal Bank');
      assert.ok(found);
      assert.strictEqual(found.id, acc.id);

      // Other user cannot find it
      const notFound = await repos.totp.findByOwnerAndName(otherId, 'Personal Bank');
      assert.strictEqual(notFound, null);
    });
  });

  describe('Consent-Bound Link Creation', () => {
    it('should link TOTP only with valid link consent and resource ownership', async () => {
      const ownerId = 'owner-john';
      const strangerId = 'stranger-evil';

      const project = await projectService.createProject({
        name: 'Project Alpha',
        ownerId,
      });

      const env = await projectService.createEnvironment({
        name: 'Production',
        slug: 'prod',
        projectId: project.id,
      });
      assert.ok(env.resourceId);
      const resourceId = env.resourceId;

      // Create TOTP account for owner-john
      const totpAcc = await repos.totp.create({
        ownerDiscordUserId: ownerId,
        accountName: 'My Auth',
        secret: 'BASE32SECRET3232323232323232',
      });

      // 1. Attempt link without consent -> should fail
      await assert.rejects(async () => {
        await resourceService.linkTOTPAccount(resourceId, totpAcc.id, ownerId, 'invalid-consent');
      }, /Link consent not found/);

      // 2. Create consent but attempt link by stranger -> should fail
      const consent = await resourceService.createTOTPLinkConsent(totpAcc.id, resourceId, ownerId, {
        allowedOperations: ['totp.code.read'],
      });

      await assert.rejects(async () => {
        await resourceService.linkTOTPAccount(resourceId, totpAcc.id, strangerId, consent.id);
      }, /Only the resource owner can link/);

      // 3. Link with valid consent and resource owner -> should succeed
      await resourceService.linkTOTPAccount(resourceId, totpAcc.id, ownerId, consent.id);

      // Verify delegation envelope is written on resource
      const resource = await repos.resources.findById(resourceId);
      assert.ok(resource);
      assert.strictEqual(resource.totpAccountId, totpAcc.id);
      assert.ok(resource.totpDelegationEnvelope);
      assert.strictEqual(resource.totpDelegationEnvelope.consentId, consent.id);
      assert.strictEqual(resource.totpDelegationEnvelope.accountOwnerDiscordUserId, ownerId);

      // 4. Try to reuse the consent -> should fail (one-time consumption)
      const consentAfterUse = await repos.totp.findLinkConsentById(consent.id);
      assert.ok(consentAfterUse?.usedAt);

      await assert.rejects(async () => {
        await resourceService.linkTOTPAccount(resourceId, totpAcc.id, ownerId, consent.id);
      }, /Link consent has already been used/);
    });

    it('should allow either the resource owner or the TOTP owner to unlink', async () => {
      const ownerId = 'owner-john';
      const totpOwnerId = 'totp-alice';
      const strangerId = 'stranger';

      const project = await projectService.createProject({
        name: 'Project Beta',
        ownerId,
      });

      const env = await projectService.createEnvironment({
        name: 'Prod',
        slug: 'prod',
        projectId: project.id,
      });
      const resourceId = env.resourceId!;

      const totpAcc = await repos.totp.create({
        ownerDiscordUserId: totpOwnerId,
        accountName: 'Alice Auth',
        secret: 'BASE32SECRET3232323232323232',
      });

      const consent = await resourceService.createTOTPLinkConsent(
        totpAcc.id,
        resourceId,
        totpOwnerId,
        {}
      );
      await resourceService.linkTOTPAccount(resourceId, totpAcc.id, ownerId, consent.id);

      // Stranger cannot unlink
      await assert.rejects(async () => {
        await resourceService.unlinkTOTPAccount(resourceId, strangerId);
      }, /Only the resource owner or the TOTP account owner can unlink/);

      // TOTP owner can unlink
      await resourceService.unlinkTOTPAccount(resourceId, totpOwnerId);

      const resAfterUnlink = await repos.resources.findById(resourceId);
      assert.strictEqual(resAfterUnlink?.totpAccountId, undefined);
      assert.strictEqual(resAfterUnlink?.totpDelegationEnvelope, undefined);
    });
  });

  describe('Code and Recovery Reveals', () => {
    it('should restrict recovery key reveal exclusively to the account owner', async () => {
      const ownerId = 'owner-john';
      const strangerId = 'stranger';

      const totpAcc = await repos.totp.create({
        ownerDiscordUserId: ownerId,
        accountName: 'Johns Auth',
        secret: 'BASE32SECRET3232323232323232',
        backupKey: 'BACKUP_RECOVERY_KEY',
      });

      // Owner can reveal
      const key = await resourceService.revealTOTPRecoveryKey(totpAcc.id, ownerId);
      assert.strictEqual(key, 'BACKUP_RECOVERY_KEY');

      // Stranger gets denied
      await assert.rejects(async () => {
        await resourceService.revealTOTPRecoveryKey(totpAcc.id, strangerId);
      }, /Only the personal owner of the TOTP account can view the recovery key/);
    });

    it('should allow code reveal only for authorized roles or active approved requests', async () => {
      const ownerId = 'owner-john';
      const requesterId = 'user-requester';
      const strangerId = 'stranger';

      const project = await projectService.createProject({
        name: 'Project Delta',
        ownerId,
      });

      const env = await projectService.createEnvironment({
        name: 'Prod',
        slug: 'prod',
        projectId: project.id,
      });
      const resourceId = env.resourceId!;

      const totpAcc = await repos.totp.create({
        ownerDiscordUserId: ownerId,
        accountName: 'Johns Auth',
        secret: 'BASE32SECRET3232323232323232',
      });

      const consent = await resourceService.createTOTPLinkConsent(totpAcc.id, resourceId, ownerId, {
        allowedOperations: ['totp.code.read'],
      });
      await resourceService.linkTOTPAccount(resourceId, totpAcc.id, ownerId, consent.id);

      // Owner can reveal code directly
      const code = await resourceService.revealTOTPCode(resourceId, ownerId);
      assert.match(code, /^\d{6}$/);

      // Stranger gets denied
      await assert.rejects(async () => {
        await resourceService.revealTOTPCode(resourceId, strangerId);
      }, /Access denied/);

      // Create delegation consent directly in repo
      const currentResource = await repos.resources.findById(resourceId);
      assert.ok(currentResource);
      await repos.totp.createDelegationConsent({
        resourceId,
        totpAccountId: totpAcc.id,
        operation: 'totp.code.read',
        requesterId,
        authFamily: 'DISCORD',
        accountVersion: totpAcc.version,
        linkVersion: currentResource.version,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      // Create approved request for requester (which generates ApprovalGrant)
      const reqRes = await resourceService.deps.approval.createApprovalRequest({
        resourceId,
        requesterId,
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'totp.code.read',
      });
      assert.ok(reqRes.success && reqRes.request);

      const decision = await resourceService.deps.approval.recordDecision(
        reqRes.request.id,
        'APPROVE',
        ownerId
      );
      assert.ok(decision.success);

      // Requester with active approval and consent can reveal code
      const reqCode = await resourceService.revealTOTPCode(resourceId, {
        type: 'DISCORD_USER',
        id: requesterId,
        subjectId: requesterId,
        authKind: 'DISCORD',
        actorDiscordId: requesterId,
      });
      assert.match(reqCode, /^\d{6}$/);
    });
  });

  describe('Delegation Consent and Rotations', () => {
    it('should validate delegation consent policies and check versions', async () => {
      const ownerId = 'owner-john';
      const requesterId = 'user-requester';

      const project = await projectService.createProject({
        name: 'Project Epsilon',
        ownerId,
      });

      const env = await projectService.createEnvironment({
        name: 'Prod',
        slug: 'prod',
        projectId: project.id,
      });
      const resourceId = env.resourceId!;

      const totpAcc = await repos.totp.create({
        ownerDiscordUserId: ownerId,
        accountName: 'Johns Auth',
        secret: 'BASE32SECRET3232323232323232',
      });

      // Link with strict policy (only allows 'totp.code.read' and requesterId)
      const consent = await resourceService.createTOTPLinkConsent(totpAcc.id, resourceId, ownerId, {
        allowedOperations: ['totp.code.read'],
        allowedRequesters: [requesterId],
      });
      await resourceService.linkTOTPAccount(resourceId, totpAcc.id, ownerId, consent.id);

      // 1. Request consent for allowed operation and requester -> succeeds
      const delConsent = await resourceService.createTOTPDelegationConsent(
        resourceId,
        totpAcc.id,
        requesterId,
        'totp.code.read',
        'web-session'
      );
      assert.ok(delConsent);
      assert.strictEqual(delConsent.requesterId, requesterId);

      // 2. Request consent for disallowed operation -> fails
      await assert.rejects(async () => {
        await resourceService.createTOTPDelegationConsent(
          resourceId,
          totpAcc.id,
          requesterId,
          'totp.recovery.read',
          'web-session'
        );
      }, /not permitted by the delegation policy/);

      // 3. Request consent for disallowed requester -> fails
      await assert.rejects(async () => {
        await resourceService.createTOTPDelegationConsent(
          resourceId,
          totpAcc.id,
          'stranger-requester',
          'totp.code.read',
          'web-session'
        );
      }, /not permitted by the delegation policy/);

      // 4. Seed rotation (TOTP update) -> invalidates stale delegation consent creation
      const updatedAccount = await repos.totp.update({
        ...totpAcc,
        secret: 'BASE32NEWSECRET32323232323232',
      });

      await assert.rejects(async () => {
        await resourceService.createTOTPDelegationConsent(
          resourceId,
          updatedAccount.id,
          requesterId,
          'totp.code.read',
          'web-session'
        );
      }, /Stale link delegation envelope/);
    });
  });
});
