import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ApprovalGrant,
  ApprovalRequest,
  CapabilityContext,
  Environment,
  Guardian,
  Principal,
  Project,
  ProjectMemberRole,
  Resource,
  TOTPAccount,
} from './models.js';
import {
  checkAccessPolicy,
  getEffectiveGuardians,
  getGuardedResourcesForUser,
  hasCapability,
  isEffectiveGuardian,
  isEffectiveOwner,
  type CapabilityRepositories,
  type EffectiveGuardianRepositories,
} from './policy.js';
import { createDiscordPrincipal } from './principal.js';

const PROJECT_ID = 'project-1';
const ENVIRONMENT_ID = 'environment-1';
const RESOURCE_ID = 'resource-1';
const STANDALONE_RESOURCE_ID = 'standalone-resource';
const OWNER_ID = 'owner-user';
const WRITER_ID = 'writer-user';
const READER_ID = 'reader-user';
const GUARDIAN_ID = 'guardian-user';
const CUSTODY_OWNER_ID = 'custody-owner-user';
const MIXED_ID = 'mixed-user';
const REQUESTER_ID = 'requester-user';

const project: Project = {
  id: PROJECT_ID,
  name: 'Project',
  description: null,
  ownerId: OWNER_ID,
  policyVersion: 'policy-v1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const environment: Environment = {
  id: ENVIRONMENT_ID,
  name: 'Production',
  slug: 'production',
  projectId: PROJECT_ID,
  resourceId: RESOURCE_ID,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const resource: Resource = {
  id: RESOURCE_ID,
  name: 'Project Resource',
  mode: 'ONE_OF_N',
  apiKey: null,
  totpAccountId: null,
  totpDelegationEnvelope: null,
  version: 'resource-v1',
  totpLinkVersion: 'link-v1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const standaloneResource: Resource = {
  ...resource,
  id: STANDALONE_RESOURCE_ID,
  name: 'Standalone Resource',
};

const explicitGuardian: Guardian = {
  id: 'guardian-assignment',
  resourceId: RESOURCE_ID,
  discordUserId: GUARDIAN_ID,
  role: 'GUARDIAN',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const mixedGuardian: Guardian = {
  id: 'mixed-assignment',
  resourceId: RESOURCE_ID,
  discordUserId: MIXED_ID,
  role: 'GUARDIAN',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const staleOwnerMirror: Guardian = {
  id: 'stale-owner-mirror',
  resourceId: RESOURCE_ID,
  discordUserId: 'former-owner',
  role: 'OWNER',
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const standaloneOwner: Guardian = {
  id: 'standalone-owner',
  resourceId: STANDALONE_RESOURCE_ID,
  discordUserId: OWNER_ID,
  role: 'OWNER',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const totpAccount: TOTPAccount = {
  id: 'totp-1',
  ownerDiscordUserId: OWNER_ID,
  accountName: 'Account',
  secret: 'encrypted-seed',
  issuer: 'Purrmission',
  backupKey: 'encrypted-recovery',
  version: 'totp-v1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const custodyOwnedTotpAccount: TOTPAccount = {
  ...totpAccount,
  id: 'totp-custody-owned',
  ownerDiscordUserId: CUSTODY_OWNER_ID,
};

function approvalRequest(
  requesterId: string,
  overrides: Partial<ApprovalRequest> = {}
): ApprovalRequest {
  return {
    id: 'request-1',
    resourceId: RESOURCE_ID,
    status: 'PENDING',
    context: null,
    requesterId,
    requesterType: 'DISCORD_USER',
    authKind: 'DISCORD',
    action: 'secret.value.read',
    targetKey: null,
    targetVersion: 'resource-v1',
    policyVersion: 'policy-v1',
    constraints: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-01T01:00:00Z'),
    ...overrides,
  };
}

function approvalGrant(overrides: Partial<ApprovalGrant> = {}): ApprovalGrant {
  return {
    id: 'grant-1',
    requestId: 'request-1',
    resourceId: RESOURCE_ID,
    requesterId: REQUESTER_ID,
    requesterType: 'DISCORD_USER',
    authKind: 'DISCORD',
    action: 'secret.value.read',
    targetKey: null,
    targetVersion: 'resource-v1',
    policyVersion: 'policy-v1',
    constraints: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-01T01:00:00Z'),
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function memberRole(userId: string): ProjectMemberRole | null {
  if (userId === WRITER_ID || userId === MIXED_ID) return 'WRITER';
  if (userId === READER_ID) return 'READER';
  return null;
}

function capabilityRepositories(options?: {
  request?: ApprovalRequest | null;
  grant?: ApprovalGrant | null;
  approvalLookup?: () => void;
}): CapabilityRepositories {
  return {
    resources: {
      async findMetadataById(resourceId) {
        if (resourceId !== RESOURCE_ID) return null;
        return {
          id: resource.id,
          name: resource.name,
          mode: resource.mode,
          totpAccountId: custodyOwnedTotpAccount.id,
          version: resource.version,
          totpLinkVersion: resource.totpLinkVersion,
          createdAt: resource.createdAt,
        };
      },
    },
    guardians: {
      async findByResourceAndUser(resourceId, userId) {
        if (resourceId !== RESOURCE_ID) return null;
        if (userId === GUARDIAN_ID) return explicitGuardian;
        if (userId === MIXED_ID) return mixedGuardian;
        if (userId === staleOwnerMirror.discordUserId) return staleOwnerMirror;
        return null;
      },
    },
    projects: {
      async findById(projectId) {
        return projectId === PROJECT_ID ? project : null;
      },
      async getEnvironmentById(projectId, environmentId) {
        return projectId === PROJECT_ID && environmentId === ENVIRONMENT_ID ? environment : null;
      },
      async findEnvironmentByResourceId(resourceId) {
        return resourceId === RESOURCE_ID ? environment : null;
      },
      async getMemberRole(projectId, userId) {
        return projectId === PROJECT_ID ? memberRole(userId) : null;
      },
    },
    approvalRequests: {
      async findMetadataById() {
        options?.approvalLookup?.();
        return options?.request ?? null;
      },
    },
    approvalGrants: {
      async findById(grantId) {
        const grant = options?.grant ?? null;
        return grant?.id === grantId ? grant : null;
      },
    },
    totp: {
      async findById(totpAccountId) {
        if (totpAccountId === totpAccount.id) return totpAccount;
        if (totpAccountId === custodyOwnedTotpAccount.id) return custodyOwnedTotpAccount;
        return null;
      },
      async findMetadataById(totpAccountId) {
        if (totpAccountId === totpAccount.id) return totpAccount;
        if (totpAccountId === custodyOwnedTotpAccount.id) return custodyOwnedTotpAccount;
        return null;
      },
    },
  };
}

function effectiveGuardianRepositories(): EffectiveGuardianRepositories {
  const resources = [resource, standaloneResource];
  return {
    guardians: {
      async findByResourceId(resourceId) {
        if (resourceId === RESOURCE_ID) {
          return [explicitGuardian, mixedGuardian, staleOwnerMirror];
        }
        if (resourceId === STANDALONE_RESOURCE_ID) return [standaloneOwner];
        return [];
      },
      async findByResourceAndUser(resourceId, userId) {
        const guardians =
          resourceId === RESOURCE_ID
            ? [explicitGuardian, mixedGuardian, staleOwnerMirror]
            : resourceId === STANDALONE_RESOURCE_ID
              ? [standaloneOwner]
              : [];
        return guardians.find((guardian) => guardian.discordUserId === userId) ?? null;
      },
      async findByUserId(userId) {
        return [explicitGuardian, mixedGuardian, staleOwnerMirror, standaloneOwner].filter(
          (guardian) => guardian.discordUserId === userId
        );
      },
    },
    projects: {
      async findById(projectId) {
        return projectId === PROJECT_ID ? project : null;
      },
      async findEnvironmentByResourceId(resourceId) {
        return resourceId === RESOURCE_ID ? environment : null;
      },
      async listProjectsByOwner(userId) {
        return userId === OWNER_ID ? [project] : [];
      },
      async listEnvironments(projectId) {
        return projectId === PROJECT_ID ? [environment] : [];
      },
    },
    resources: {
      async findManyByIds(ids, query) {
        return resources.filter(
          (item) =>
            ids.includes(item.id) &&
            (!query || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        );
      },
    },
  };
}

describe('Principal and exact-object capability policy', () => {
  it('uses subjectId rather than credential id for role authorization', async () => {
    const ownerCredential: Principal = {
      type: 'PAWTHY_TOKEN',
      id: 'credential-record-1',
      subjectId: OWNER_ID,
      actorDiscordId: OWNER_ID,
      authKind: 'PAWTHY',
      scopes: ['project.view'],
      audience: 'cli',
    };
    const result = await hasCapability(capabilityRepositories(), ownerCredential, 'project.view', {
      projectId: PROJECT_ID,
      requiredAudience: 'cli',
    });

    assert.equal(result.allowed, true);
    assert.deepEqual(result.authoritySources, ['PROJECT_OWNER']);

    const credentialIdCollision: Principal = {
      ...ownerCredential,
      id: OWNER_ID,
      subjectId: REQUESTER_ID,
      actorDiscordId: REQUESTER_ID,
    };
    const denied = await hasCapability(
      capabilityRepositories(),
      credentialIdCollision,
      'project.view',
      { projectId: PROJECT_ID, requiredAudience: 'cli' }
    );
    assert.equal(denied.allowed, false);
    assert.equal(denied.reasonCode, 'NO_ROLE');
  });

  it('rejects mismatched actor attribution, auth provenance, and audience', async () => {
    const actorMismatch: Principal = {
      type: 'PAWTHY_TOKEN',
      id: 'credential-1',
      subjectId: OWNER_ID,
      actorDiscordId: REQUESTER_ID,
      authKind: 'PAWTHY',
      scopes: ['project.view'],
      audience: 'cli',
    };
    const mismatch = await hasCapability(capabilityRepositories(), actorMismatch, 'project.view', {
      projectId: PROJECT_ID,
    });
    assert.equal(mismatch.reasonCode, 'AUTH_SUBJECT_MISMATCH');

    const wrongKind: Principal = {
      ...actorMismatch,
      actorDiscordId: OWNER_ID,
      authKind: 'API_KEY',
    };
    const invalidAuth = await hasCapability(capabilityRepositories(), wrongKind, 'project.view', {
      projectId: PROJECT_ID,
    });
    assert.equal(invalidAuth.reasonCode, 'INVALID_AUTH');

    const wrongAudience = await hasCapability(
      capabilityRepositories(),
      { ...actorMismatch, actorDiscordId: OWNER_ID },
      'project.view',
      { projectId: PROJECT_ID, requiredAudience: 'web' }
    );
    assert.equal(wrongAudience.reasonCode, 'WRONG_AUDIENCE');
  });

  it('keeps Writer and explicit Guardian authority independent for mixed-role users', async () => {
    const principal = createDiscordPrincipal(MIXED_ID);
    const context = { projectId: PROJECT_ID, resourceId: RESOURCE_ID };

    const secretWrite = await hasCapability(
      capabilityRepositories(),
      principal,
      'secret.write',
      context
    );
    assert.equal(secretWrite.allowed, true);
    assert.deepEqual(secretWrite.authoritySources, ['PROJECT_WRITER']);

    const decision = await hasCapability(
      capabilityRepositories({ request: approvalRequest(REQUESTER_ID) }),
      principal,
      'request.decide',
      { ...context, requestId: 'request-1' }
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.approvalRequestId, 'request-1');
    assert.deepEqual(decision.authoritySources, ['EXPLICIT_GUARDIAN']);

    const selfDecision = await hasCapability(
      capabilityRepositories({ request: approvalRequest(MIXED_ID) }),
      principal,
      'request.decide',
      { ...context, requestId: 'request-1' }
    );
    assert.equal(selfDecision.allowed, false);
    assert.equal(selfDecision.reasonCode, 'SELF_APPROVAL_FORBIDDEN');
    assert.equal(selfDecision.approvalRequestId, 'request-1');
  });

  it('does not grant Writer approval authority or Guardian protected-value authority', async () => {
    const writer = createDiscordPrincipal(WRITER_ID);
    const guardian = createDiscordPrincipal(GUARDIAN_ID);
    const context = { projectId: PROJECT_ID, resourceId: RESOURCE_ID };

    const writerDecision = await hasCapability(
      capabilityRepositories({ request: approvalRequest(REQUESTER_ID) }),
      writer,
      'request.decide',
      { ...context, requestId: 'request-1' }
    );
    assert.equal(writerDecision.allowed, false);

    const guardianSecret = await hasCapability(
      capabilityRepositories(),
      guardian,
      'secret.value.read',
      context
    );
    const guardianTotp = await hasCapability(
      capabilityRepositories(),
      guardian,
      'totp.code.read',
      context
    );
    const guardianList = await hasCapability(
      capabilityRepositories(),
      guardian,
      'guardian.view',
      context
    );
    const guardianContext = await hasCapability(
      capabilityRepositories(),
      guardian,
      'guardian.context.read',
      context
    );

    assert.equal(guardianSecret.allowed, false);
    assert.equal(guardianTotp.allowed, false);
    assert.equal(guardianList.allowed, false);
    assert.equal(guardianContext.allowed, true);
  });

  it('encodes the least-privilege role matrix without broad role inheritance', async () => {
    const repositories = capabilityRepositories({
      request: approvalRequest(REQUESTER_ID),
    });
    const projectContext = { projectId: PROJECT_ID };
    const resourceContext = { projectId: PROJECT_ID, resourceId: RESOURCE_ID };
    const requestContext = {
      ...resourceContext,
      requestId: 'request-1',
    };

    const cases: Array<{
      role: string;
      principal: Principal;
      allowed: Array<[Parameters<typeof hasCapability>[2], CapabilityContext]>;
      denied: Array<[Parameters<typeof hasCapability>[2], CapabilityContext]>;
    }> = [
      {
        role: 'Owner',
        principal: createDiscordPrincipal(OWNER_ID),
        allowed: [
          ['project.update', projectContext],
          ['environment.delete', { ...projectContext, environmentId: ENVIRONMENT_ID }],
          ['secret.write', resourceContext],
          ['totp.code.read', resourceContext],
          ['request.decide', requestContext],
          ['guardian.manage', resourceContext],
          ['audit.full.read', projectContext],
        ],
        denied: [],
      },
      {
        role: 'Writer',
        principal: createDiscordPrincipal(WRITER_ID),
        allowed: [
          ['project.view', projectContext],
          ['environment.update', { ...projectContext, environmentId: ENVIRONMENT_ID }],
          ['secret.value.read', resourceContext],
          ['secret.write', resourceContext],
          ['audit.operational.read', projectContext],
        ],
        denied: [
          ['project.update', projectContext],
          ['environment.delete', { ...projectContext, environmentId: ENVIRONMENT_ID }],
          ['request.decide', requestContext],
          ['totp.code.read', resourceContext],
          ['guardian.manage', resourceContext],
        ],
      },
      {
        role: 'Reader',
        principal: createDiscordPrincipal(READER_ID),
        allowed: [
          ['project.view', projectContext],
          ['environment.view', { ...projectContext, environmentId: ENVIRONMENT_ID }],
          ['secret.metadata.read', resourceContext],
          ['secret.value.read', resourceContext],
        ],
        denied: [
          ['environment.update', { ...projectContext, environmentId: ENVIRONMENT_ID }],
          ['secret.write', resourceContext],
          ['request.decide', requestContext],
          ['totp.code.read', resourceContext],
        ],
      },
      {
        role: 'Guardian',
        principal: createDiscordPrincipal(GUARDIAN_ID),
        allowed: [
          ['resource.view', resourceContext],
          ['guardian.context.read', resourceContext],
          ['request.queue.view', resourceContext],
          ['request.decide', requestContext],
          ['audit.queue.read', resourceContext],
        ],
        denied: [
          ['secret.metadata.read', resourceContext],
          ['secret.value.read', resourceContext],
          ['secret.write', resourceContext],
          ['totp.code.read', resourceContext],
          ['totp.link.manage', resourceContext],
          ['guardian.manage', resourceContext],
        ],
      },
      {
        role: 'Requester',
        principal: createDiscordPrincipal(REQUESTER_ID),
        allowed: [
          ['request.create', resourceContext],
          ['request.view-own', requestContext],
          ['request.cancel-own', requestContext],
          ['audit.own.read', { subjectId: REQUESTER_ID }],
          ['token.manage-own', { subjectId: REQUESTER_ID }],
        ],
        denied: [
          ['project.view', projectContext],
          ['resource.view', resourceContext],
          ['request.decide', requestContext],
          ['secret.value.read', resourceContext],
        ],
      },
    ];

    for (const entry of cases) {
      for (const [capability, context] of entry.allowed) {
        const result = await hasCapability(repositories, entry.principal, capability, context);
        assert.equal(result.allowed, true, `${entry.role} should have ${capability}`);
      }
      for (const [capability, context] of entry.denied) {
        const result = await hasCapability(repositories, entry.principal, capability, context);
        assert.equal(result.allowed, false, `${entry.role} should not have ${capability}`);
      }
    }
  });

  it('allows a TOTP custody owner to unlink only, without granting link or Guardian authority', async () => {
    const repositories = capabilityRepositories();
    repositories.totp.findById = async () => {
      throw new Error('value-bearing TOTP lookup must not run during link authorization');
    };
    const unlinkContext: CapabilityContext = {
      resourceId: RESOURCE_ID,
      totpAccountId: custodyOwnedTotpAccount.id,
      totpLinkOperation: 'UNLINK',
    };

    const custodyUnlink = await hasCapability(
      repositories,
      createDiscordPrincipal(CUSTODY_OWNER_ID),
      'totp.link.manage',
      unlinkContext
    );
    const custodyLink = await hasCapability(
      repositories,
      createDiscordPrincipal(CUSTODY_OWNER_ID),
      'totp.link.manage',
      { ...unlinkContext, totpLinkOperation: 'LINK' }
    );
    const guardianUnlink = await hasCapability(
      repositories,
      createDiscordPrincipal(GUARDIAN_ID),
      'totp.link.manage',
      unlinkContext
    );
    const mismatchedResourceUnlink = await hasCapability(
      repositories,
      createDiscordPrincipal(CUSTODY_OWNER_ID),
      'totp.link.manage',
      { ...unlinkContext, resourceId: 'different-resource' }
    );

    assert.equal(custodyUnlink.allowed, true);
    assert.deepEqual(custodyUnlink.authoritySources, ['TOTP_OWNER']);
    assert.equal(custodyLink.allowed, false);
    assert.equal(guardianUnlink.allowed, false);
    assert.equal(mismatchedResourceUnlink.allowed, false);
    assert.equal(mismatchedResourceUnlink.reasonCode, 'TARGET_SCOPE_MISMATCH');
  });

  it('fails closed when an Environment does not belong to the supplied Project', async () => {
    const result = await hasCapability(
      capabilityRepositories(),
      createDiscordPrincipal(OWNER_ID),
      'environment.view',
      {
        projectId: PROJECT_ID,
        environmentId: 'environment-from-another-project',
      }
    );

    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'TARGET_SCOPE_MISMATCH');
    assert.deepEqual(result.target, {
      type: 'ENVIRONMENT',
      id: 'environment-from-another-project',
    });
  });

  it('uses typed requesterId rather than legacy JSON context for own-request checks', async () => {
    const principal = createDiscordPrincipal(REQUESTER_ID);
    const legacySpoof = approvalRequest('different-user', {
      context: { requesterId: REQUESTER_ID },
    });
    const spoofed = await hasCapability(
      capabilityRepositories({ request: legacySpoof }),
      principal,
      'request.view-own',
      { requestId: legacySpoof.id }
    );
    assert.equal(spoofed.allowed, false);

    const owned = await hasCapability(
      capabilityRepositories({ request: approvalRequest(REQUESTER_ID) }),
      principal,
      'request.view-own',
      { requestId: 'request-1' }
    );
    assert.equal(owned.allowed, true);
    assert.deepEqual(owned.authoritySources, ['AUTHENTICATED_SUBJECT']);
  });

  it('never treats an APPROVED request as a grant', async () => {
    let approvalLookups = 0;
    const principal = createDiscordPrincipal(REQUESTER_ID);
    const result = await hasCapability(
      capabilityRepositories({
        request: approvalRequest(REQUESTER_ID, { status: 'APPROVED' }),
        approvalLookup: () => {
          approvalLookups += 1;
        },
      }),
      principal,
      'grant.consume',
      {
        resourceId: RESOURCE_ID,
        action: 'secret.value.read',
        targetVersion: 'resource-v1',
        policyVersion: 'policy-v1',
      }
    );

    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'MISSING_CONTEXT');
    assert.equal(approvalLookups, 0);
  });

  it('allows only a current exact immutable grant', async () => {
    const principal = createDiscordPrincipal(REQUESTER_ID);
    const grant = approvalGrant();
    const context = {
      resourceId: RESOURCE_ID,
      grantId: grant.id,
      action: 'secret.value.read',
      targetVersion: 'resource-v1',
      policyVersion: 'policy-v1',
      currentTimestamp: new Date('2026-01-01T00:30:00Z'),
    };
    const allowed = await hasCapability(
      capabilityRepositories({ grant }),
      principal,
      'grant.consume',
      context
    );

    assert.equal(allowed.allowed, true);
    assert.equal(allowed.grantId, grant.id);
    assert.equal(allowed.target.type, 'APPROVAL_GRANT');
    assert.deepEqual(allowed.authoritySources, ['APPROVAL_GRANT']);

    const wrongSubject = await hasCapability(
      capabilityRepositories({ grant }),
      createDiscordPrincipal('other-user'),
      'grant.consume',
      context
    );
    assert.equal(wrongSubject.reasonCode, 'GRANT_SCOPE_MISMATCH');
    assert.equal(wrongSubject.grantId, grant.id);

    const consumed = await hasCapability(
      capabilityRepositories({ grant: approvalGrant({ consumedAt: new Date() }) }),
      principal,
      'grant.consume',
      context
    );
    assert.equal(consumed.reasonCode, 'GRANT_INVALID');
  });

  it('binds Resource API credentials to their Resource subject', async () => {
    const principal: Principal = {
      type: 'RESOURCE_API_KEY',
      id: 'resource-credential',
      subjectId: RESOURCE_ID,
      authKind: 'API_KEY',
      scopes: ['request.create'],
      audience: 'api',
    };
    const allowed = await hasCapability(capabilityRepositories(), principal, 'request.create', {
      resourceId: RESOURCE_ID,
      requiredAudience: 'api',
    });
    assert.equal(allowed.allowed, true);

    const denied = await hasCapability(capabilityRepositories(), principal, 'request.create', {
      resourceId: STANDALONE_RESOURCE_ID,
      requiredAudience: 'api',
    });
    assert.equal(denied.reasonCode, 'AUTH_SUBJECT_MISMATCH');
  });

  it('keeps personal TOTP recovery and own-token management subject scoped', async () => {
    const owner = createDiscordPrincipal(OWNER_ID);
    const recovery = await hasCapability(capabilityRepositories(), owner, 'totp.recovery.read', {
      totpAccountId: totpAccount.id,
    });
    assert.equal(recovery.allowed, true);
    assert.deepEqual(recovery.authoritySources, ['TOTP_OWNER']);

    const ownTokens = await hasCapability(capabilityRepositories(), owner, 'token.manage-own', {
      subjectId: OWNER_ID,
    });
    assert.equal(ownTokens.allowed, true);

    const otherTokens = await hasCapability(capabilityRepositories(), owner, 'token.manage-own', {
      subjectId: REQUESTER_ID,
    });
    assert.equal(otherTokens.reasonCode, 'AUTH_SUBJECT_MISMATCH');
  });

  it('fails closed for unbound service object scopes while retaining exact own-subject audit', async () => {
    const service: Principal = {
      type: 'SERVICE',
      id: 'service-credential',
      subjectId: 'ci-service',
      authKind: 'SERVICE',
      scopes: ['audit.export'],
      audience: 'internal',
    };
    const denied = await hasCapability(capabilityRepositories(), service, 'audit.export', {
      projectId: PROJECT_ID,
      requiredAudience: 'internal',
    });
    assert.equal(denied.reasonCode, 'TARGET_SCOPE_MISMATCH');

    const unboundProject = await hasCapability(
      capabilityRepositories(),
      { ...service, scopes: ['audit.export', 'audit.full.read'] },
      'audit.export',
      { projectId: PROJECT_ID, requiredAudience: 'internal' }
    );
    assert.equal(unboundProject.allowed, false);
    assert.equal(unboundProject.reasonCode, 'TARGET_SCOPE_MISMATCH');

    const wrongTargetReadScope = await hasCapability(
      capabilityRepositories(),
      { ...service, scopes: ['audit.export', 'audit.own.read'] },
      'audit.export',
      { projectId: PROJECT_ID, requiredAudience: 'internal' }
    );
    assert.equal(wrongTargetReadScope.allowed, false);
    assert.equal(wrongTargetReadScope.reasonCode, 'TARGET_SCOPE_MISMATCH');

    const ownTarget = await hasCapability(
      capabilityRepositories(),
      { ...service, scopes: ['audit.export', 'audit.own.read'] },
      'audit.export',
      { subjectId: service.subjectId, requiredAudience: 'internal' }
    );
    assert.equal(ownTarget.allowed, true);
    assert.deepEqual(ownTarget.target, { type: 'SUBJECT', id: service.subjectId });
  });

  it('validates Environment/Project relationships before scoped service authorization', async () => {
    const service: Principal = {
      type: 'SERVICE',
      id: 'service-credential',
      subjectId: 'ci-service',
      authKind: 'SERVICE',
      scopes: ['environment.view'],
      audience: 'internal',
    };

    const result = await hasCapability(capabilityRepositories(), service, 'environment.view', {
      projectId: PROJECT_ID,
      environmentId: 'environment-from-another-project',
      requiredAudience: 'internal',
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'TARGET_SCOPE_MISMATCH');
  });

  it('rejects contradictory Project/Resource and approval-request/Resource contexts', async () => {
    const projectResourceMismatch = await hasCapability(
      capabilityRepositories(),
      createDiscordPrincipal(OWNER_ID),
      'resource.view',
      { projectId: PROJECT_ID, resourceId: STANDALONE_RESOURCE_ID }
    );
    assert.equal(projectResourceMismatch.allowed, false);
    assert.equal(projectResourceMismatch.reasonCode, 'TARGET_SCOPE_MISMATCH');

    const requestResourceMismatch = await hasCapability(
      capabilityRepositories({
        request: approvalRequest(REQUESTER_ID, { resourceId: STANDALONE_RESOURCE_ID }),
      }),
      createDiscordPrincipal(OWNER_ID),
      'request.decide',
      { projectId: PROJECT_ID, resourceId: RESOURCE_ID, requestId: 'request-1' }
    );
    assert.equal(requestResourceMismatch.allowed, false);
    assert.equal(requestResourceMismatch.reasonCode, 'TARGET_SCOPE_MISMATCH');

    const repositories = capabilityRepositories({
      request: approvalRequest(REQUESTER_ID),
    });
    repositories.projects.getEnvironmentById = async (projectId, environmentId) =>
      projectId === PROJECT_ID && environmentId === ENVIRONMENT_ID
        ? { ...environment, resourceId: undefined }
        : null;
    const environmentRequestMismatch = await hasCapability(
      repositories,
      createDiscordPrincipal(OWNER_ID),
      'request.decide',
      { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, requestId: 'request-1' }
    );
    assert.equal(environmentRequestMismatch.allowed, false);
    assert.equal(environmentRequestMismatch.reasonCode, 'TARGET_SCOPE_MISMATCH');
  });
});

describe('Legacy RBAC compatibility helpers fail closed', () => {
  it('allows only OWNER direct access and ignores approved requests', async () => {
    const ownerResult = await checkAccessPolicy(resource, [standaloneOwner], OWNER_ID);
    assert.equal(ownerResult.allowed, true);

    const guardianResult = await checkAccessPolicy(resource, [explicitGuardian], GUARDIAN_ID);
    assert.equal(guardianResult.allowed, false);
    assert.equal(guardianResult.requiresApproval, true);
    assert.match(guardianResult.reason ?? '', /immutable grant/i);
  });

  it('does not synthesize Writers and ignores stale linked OWNER rows', async () => {
    const repositories = effectiveGuardianRepositories();
    const guardians = await getEffectiveGuardians(repositories, RESOURCE_ID);

    assert.deepEqual(guardians.map((guardian) => [guardian.discordUserId, guardian.role]).sort(), [
      [GUARDIAN_ID, 'GUARDIAN'],
      [MIXED_ID, 'GUARDIAN'],
      [OWNER_ID, 'OWNER'],
    ]);
    assert.equal(await isEffectiveGuardian(repositories, RESOURCE_ID, WRITER_ID), false);
    assert.equal(await isEffectiveGuardian(repositories, RESOURCE_ID, GUARDIAN_ID), true);
    assert.equal(
      await isEffectiveGuardian(repositories, RESOURCE_ID, staleOwnerMirror.discordUserId),
      false
    );
  });

  it('uses Project.ownerId as canonical linked ownership and explicit OWNER for standalone Resources', async () => {
    const repositories = effectiveGuardianRepositories();

    assert.equal(await isEffectiveOwner(repositories, RESOURCE_ID, OWNER_ID), true);
    assert.equal(
      await isEffectiveOwner(repositories, RESOURCE_ID, staleOwnerMirror.discordUserId),
      false
    );
    assert.equal(await isEffectiveOwner(repositories, STANDALONE_RESOURCE_ID, OWNER_ID), true);
  });

  it('discovers guarded Resources for explicit Guardians and Owners, never Writers by membership', async () => {
    const repositories = effectiveGuardianRepositories();

    const ownerResources = await getGuardedResourcesForUser(repositories, OWNER_ID);
    assert.deepEqual(
      ownerResources.map((item) => item.id).sort(),
      [RESOURCE_ID, STANDALONE_RESOURCE_ID].sort()
    );

    const guardianResources = await getGuardedResourcesForUser(repositories, GUARDIAN_ID);
    assert.deepEqual(
      guardianResources.map((item) => item.id),
      [RESOURCE_ID]
    );

    const writerResources = await getGuardedResourcesForUser(repositories, WRITER_ID);
    assert.deepEqual(writerResources, []);
  });
});
