import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAccessPolicy,
  requiresApproval,
  getEffectiveGuardians,
  isEffectiveGuardian,
  getGuardedResourcesForUser,
  isEffectiveOwner,
  hasCapability,
} from './policy.js';
import type {
  Resource,
  Guardian,
  ApprovalRequest,
  Principal,
  CapabilityContext,
  TOTPAccount,
} from './models.js';
import type { Repositories, ApprovalRequestRepository } from './repositories.js';

describe('Access Policy', () => {
  const mockResource: Resource = {
    id: 'res-1',
    name: 'Test Resource',
    mode: 'ONE_OF_N',
    apiKey: 'key',
    createdAt: new Date(),
  };

  const owner: Guardian = {
    id: 'g-1',
    resourceId: 'res-1',
    discordUserId: 'user-owner',
    role: 'OWNER',
    createdAt: new Date(),
  };

  const guardian: Guardian = {
    id: 'g-2',
    resourceId: 'res-1',
    discordUserId: 'user-guardian',
    role: 'GUARDIAN',
    createdAt: new Date(),
  };

  const guardians = [owner, guardian];

  // Mock Repositories
  const mockApprovalRepo = {
    findActiveByRequester: async (_resId: string, _reqId: string) => null,
  } as unknown as ApprovalRequestRepository;

  const mockRepos = {
    approvalRequests: mockApprovalRepo,
  } as unknown as Repositories;

  it('should allow direct access for owner', async () => {
    const result = await checkAccessPolicy(mockResource, guardians, 'user-owner', mockRepos);
    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, false);
    assert.match(result.reason ?? '', /guardian\/owner/);
  });

  it('should allow direct access for guardian', async () => {
    const result = await checkAccessPolicy(mockResource, guardians, 'user-guardian', mockRepos);
    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, false);
  });

  it('should require approval for non-guardian without active request', async () => {
    const result = await checkAccessPolicy(mockResource, guardians, 'user-random', mockRepos);
    assert.equal(result.allowed, false);
    assert.equal(result.requiresApproval, true);
    assert.equal(requiresApproval(result), true);
  });

  it('should handle empty guardians list safely', async () => {
    const result = await checkAccessPolicy(mockResource, [], 'user-owner', mockRepos);
    assert.equal(result.allowed, false);
    assert.equal(result.requiresApproval, true);
  });

  it('should allow access if active approved request exists', async () => {
    const activeRequest: ApprovalRequest = {
      id: 'req-1',
      resourceId: 'res-1',
      status: 'APPROVED',
      context: { requesterId: 'user-approved' },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10000), // Future
    };

    const reposWithApproval = {
      approvalRequests: {
        findActiveByRequester: async () => activeRequest,
      },
    } as unknown as Repositories;

    const result = await checkAccessPolicy(
      mockResource,
      guardians,
      'user-approved',
      reposWithApproval
    );
    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, false);
    assert.match(result.reason ?? '', /Active approval granted/);
  });

  it('should deny access if approved request is expired', async () => {
    const expiredRequest: ApprovalRequest = {
      id: 'req-1',
      resourceId: 'res-1',
      status: 'APPROVED',
      context: { requesterId: 'user-expired' },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 10000), // Past
    };

    const reposWithExpired = {
      approvalRequests: {
        findActiveByRequester: async () => expiredRequest,
      },
    } as unknown as Repositories;

    const result = await checkAccessPolicy(
      mockResource,
      guardians,
      'user-expired',
      reposWithExpired
    );
    assert.equal(result.allowed, false);
    assert.equal(result.requiresApproval, true);
    assert.match(result.reason ?? '', /expired/);
  });

  it('should deny access if request is not APPROVED (e.g. PENDING)', async () => {
    const pendingRequest: ApprovalRequest = {
      id: 'req-1',
      resourceId: 'res-1',
      status: 'PENDING',
      context: { requesterId: 'user-pending' },
      createdAt: new Date(),
      expiresAt: null,
    };

    const reposWithPending = {
      approvalRequests: {
        findActiveByRequester: async () => pendingRequest,
      },
    } as unknown as Repositories;

    const result = await checkAccessPolicy(
      mockResource,
      guardians,
      'user-pending',
      reposWithPending
    );
    assert.equal(result.allowed, false);
    assert.equal(result.requiresApproval, true);
  });

  describe('Effective Guardians and Unified Permissions', () => {
    const mockRes1: Resource = {
      id: 'env-res-1',
      name: 'Project1:dev',
      mode: 'ONE_OF_N',
      apiKey: 'key1',
      createdAt: new Date(),
    };

    const mockRes2: Resource = {
      id: 'standalone-res-1',
      name: 'Standalone Res',
      mode: 'ONE_OF_N',
      apiKey: 'key2',
      createdAt: new Date(),
    };

    const projectOwnerId = 'user-project-owner';
    const writerMemberId = 'user-project-writer';
    const readerMemberId = 'user-project-reader';
    const explicitGuardianId = 'user-explicit-guardian';

    const mockProject = {
      id: 'project-1',
      name: 'Project 1',
      ownerId: projectOwnerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockEnv = {
      id: 'env-1',
      name: 'Dev',
      slug: 'dev',
      projectId: 'project-1',
      resourceId: 'env-res-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockExplicitGuardian: Guardian = {
      id: 'g-explicit',
      resourceId: 'env-res-1',
      discordUserId: explicitGuardianId,
      role: 'GUARDIAN',
      createdAt: new Date(),
    };

    const mockRepos = {
      guardians: {
        findByResourceId: async (resId: string) => {
          if (resId === 'env-res-1') return [mockExplicitGuardian];
          return [];
        },
        findByUserId: async (userId: string) => {
          if (userId === explicitGuardianId) return [mockExplicitGuardian];
          return [];
        },
        findByResourceAndUser: async (resId: string, userId: string) => {
          if (resId === 'env-res-1' && userId === explicitGuardianId) return mockExplicitGuardian;
          return null;
        },
      },
      projects: {
        findEnvironmentByResourceId: async (resId: string) => {
          if (resId === 'env-res-1') return mockEnv;
          return null;
        },
        findById: async (projId: string) => {
          if (projId === 'project-1') return mockProject;
          return null;
        },
        listMembers: async (projId: string) => {
          if (projId === 'project-1') {
            return [
              {
                id: 'm-writer',
                projectId: 'project-1',
                userId: writerMemberId,
                role: 'WRITER',
                addedBy: 'owner',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              {
                id: 'm-reader',
                projectId: 'project-1',
                userId: readerMemberId,
                role: 'READER',
                addedBy: 'owner',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ];
          }
          return [];
        },
        listEnvironments: async (projId: string) => {
          if (projId === 'project-1') return [mockEnv];
          return [];
        },
        listProjectsByOwner: async (ownerId: string) => {
          if (ownerId === projectOwnerId) return [mockProject];
          return [];
        },
        listMembershipsByUser: async (userId: string) => {
          if (userId === writerMemberId) {
            return [
              {
                id: 'm-writer',
                projectId: 'project-1',
                userId: writerMemberId,
                role: 'WRITER',
                addedBy: 'owner',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ];
          }
          if (userId === readerMemberId) {
            return [
              {
                id: 'm-reader',
                projectId: 'project-1',
                userId: readerMemberId,
                role: 'READER',
                addedBy: 'owner',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ];
          }
          return [];
        },
        getMemberRole: async (projId: string, userId: string) => {
          if (projId === 'project-1') {
            if (userId === writerMemberId) return 'WRITER';
            if (userId === readerMemberId) return 'READER';
          }
          return null;
        },
      },
      resources: {
        findManyByIds: async (ids: string[]) => {
          const resList = [];
          if (ids.includes('env-res-1')) resList.push(mockRes1);
          if (ids.includes('standalone-res-1')) resList.push(mockRes2);
          return resList;
        },
        findById: async (id: string) => {
          if (id === 'env-res-1') return mockRes1;
          if (id === 'standalone-res-1') return mockRes2;
          return null;
        },
      },
    } as unknown as Repositories;

    it('should resolve effective guardians containing explicit, project owner, and writer member', async () => {
      const guardians = await getEffectiveGuardians(mockRepos, 'env-res-1');
      assert.equal(guardians.length, 3);

      const explicit = guardians.find((g) => g.discordUserId === explicitGuardianId);
      assert.ok(explicit);
      assert.equal(explicit.role, 'GUARDIAN');

      const owner = guardians.find((g) => g.discordUserId === projectOwnerId);
      assert.ok(owner);
      assert.equal(owner.role, 'OWNER');

      const writer = guardians.find((g) => g.discordUserId === writerMemberId);
      assert.ok(writer);
      assert.equal(writer.role, 'GUARDIAN');

      const reader = guardians.find((g) => g.discordUserId === readerMemberId);
      assert.equal(reader, undefined);
    });

    it('should correctly evaluate isEffectiveGuardian', async () => {
      assert.equal(await isEffectiveGuardian(mockRepos, 'env-res-1', projectOwnerId), true);
      assert.equal(await isEffectiveGuardian(mockRepos, 'env-res-1', writerMemberId), true);
      assert.equal(await isEffectiveGuardian(mockRepos, 'env-res-1', explicitGuardianId), true);
      assert.equal(await isEffectiveGuardian(mockRepos, 'env-res-1', readerMemberId), false);
      assert.equal(await isEffectiveGuardian(mockRepos, 'env-res-1', 'random-user'), false);
    });

    it('should retrieve correctly guarded resources for users', async () => {
      const ownerResources = await getGuardedResourcesForUser(mockRepos, projectOwnerId);
      assert.equal(ownerResources.length, 1);
      assert.equal(ownerResources[0].id, 'env-res-1');

      const writerResources = await getGuardedResourcesForUser(mockRepos, writerMemberId);
      assert.equal(writerResources.length, 1);
      assert.equal(writerResources[0].id, 'env-res-1');

      const explicitResources = await getGuardedResourcesForUser(mockRepos, explicitGuardianId);
      assert.equal(explicitResources.length, 1);
      assert.equal(explicitResources[0].id, 'env-res-1');

      const readerResources = await getGuardedResourcesForUser(mockRepos, readerMemberId);
      assert.equal(readerResources.length, 0);
    });

    it('should upgrade project owner to OWNER role even if explicitly registered as GUARDIAN', async () => {
      const explicitGuardianWithOwnerId: Guardian = {
        id: 'g-owner-explicit',
        resourceId: 'env-res-1',
        discordUserId: projectOwnerId,
        role: 'GUARDIAN', // Lower privilege role
        createdAt: new Date(),
      };

      const customRepos = {
        ...mockRepos,
        guardians: {
          ...mockRepos.guardians,
          findByResourceId: async () => [explicitGuardianWithOwnerId],
        },
      } as unknown as Repositories;

      const guardians = await getEffectiveGuardians(customRepos, 'env-res-1');
      const owner = guardians.find((g) => g.discordUserId === projectOwnerId);
      assert.ok(owner);
      assert.equal(owner.role, 'OWNER', 'Should be upgraded to OWNER role');
    });

    it('should correctly evaluate isEffectiveOwner', async () => {
      assert.equal(await isEffectiveOwner(mockRepos, 'env-res-1', projectOwnerId), true);
      assert.equal(await isEffectiveOwner(mockRepos, 'env-res-1', explicitGuardianId), false); // explicit but role is GUARDIAN
      assert.equal(await isEffectiveOwner(mockRepos, 'env-res-1', writerMemberId), false);
      assert.equal(await isEffectiveOwner(mockRepos, 'env-res-1', readerMemberId), false);
    });
  });

  describe('hasCapability Evaluator', () => {
    const projectOwnerId = 'user-project-owner';
    const writerMemberId = 'user-project-writer';
    const readerMemberId = 'user-project-reader';
    const explicitGuardianId = 'user-explicit-guardian';
    const randomUserId = 'user-random';

    const mockProject = {
      id: 'project-1',
      name: 'Project 1',
      ownerId: projectOwnerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockEnv = {
      id: 'env-1',
      name: 'Dev',
      slug: 'dev',
      projectId: 'project-1',
      resourceId: 'env-res-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockExplicitGuardian: Guardian = {
      id: 'g-explicit',
      resourceId: 'env-res-1',
      discordUserId: explicitGuardianId,
      role: 'GUARDIAN',
      createdAt: new Date(),
    };

    const mockTotpAccount: TOTPAccount = {
      id: 'totp-1',
      ownerDiscordUserId: projectOwnerId,
      accountName: 'Test Account',
      secret: 'SECRET',
      shared: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockActiveRequest: ApprovalRequest = {
      id: 'req-active',
      resourceId: 'env-res-1',
      status: 'APPROVED',
      context: { requesterId: randomUserId },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10000),
    };

    const mockReposForEval = {
      guardians: {
        findByResourceAndUser: async (resId: string, userId: string) => {
          if (resId === 'env-res-1' && userId === explicitGuardianId) return mockExplicitGuardian;
          return null;
        },
      },
      projects: {
        findEnvironmentByResourceId: async (resId: string) => {
          if (resId === 'env-res-1') return mockEnv;
          return null;
        },
        findEnvironmentById: async (envId: string) => {
          if (envId === 'env-1') return mockEnv;
          return null;
        },
        findById: async (projId: string) => {
          if (projId === 'project-1') return mockProject;
          return null;
        },
        getMemberRole: async (projId: string, userId: string) => {
          if (projId === 'project-1') {
            if (userId === writerMemberId) return 'WRITER';
            if (userId === readerMemberId) return 'READER';
          }
          return null;
        },
      },
      totp: {
        findById: async (id: string) => {
          if (id === 'totp-1') return mockTotpAccount;
          return null;
        },
      },
      approvalRequests: {
        findById: async (id: string) => {
          if (id === 'req-active') return mockActiveRequest;
          return null;
        },
        findActiveByRequester: async (resId: string, reqId: string) => {
          if (resId === 'env-res-1' && reqId === randomUserId) return mockActiveRequest;
          return null;
        },
      },
    } as unknown as Repositories;

    it('should allow project creation for human principals and deny for API keys', async () => {
      const human: Principal = { type: 'DISCORD_USER', id: randomUserId, authKind: 'DISCORD' };
      const apiKey: Principal = { type: 'RESOURCE_API_KEY', id: 'key', authKind: 'API_KEY' };

      const resHuman = await hasCapability(mockReposForEval, human, 'project.create', {});
      assert.equal(resHuman.allowed, true);

      const resKey = await hasCapability(mockReposForEval, apiKey, 'project.create', {});
      assert.equal(resKey.allowed, false);
      assert.equal(resKey.reasonCode, 'INVALID_AUTH');
    });

    it('should correctly authorize Project Owner', async () => {
      const principal: Principal = {
        type: 'DISCORD_USER',
        id: projectOwnerId,
        authKind: 'DISCORD',
      };
      const ctx: CapabilityContext = { projectId: 'project-1', resourceId: 'env-res-1' };

      // Project Owner has full project capabilities
      const resView = await hasCapability(mockReposForEval, principal, 'project.view', ctx);
      assert.equal(resView.allowed, true);
      assert.equal(resView.reasonCode, 'OWNER');

      const resDelete = await hasCapability(mockReposForEval, principal, 'project.delete', ctx);
      assert.equal(resDelete.allowed, true);

      // Project Owner has full resource/secret capabilities on linked resources
      const resSecretWrite = await hasCapability(mockReposForEval, principal, 'secret.write', ctx);
      assert.equal(resSecretWrite.allowed, true);

      const resSecretRead = await hasCapability(
        mockReposForEval,
        principal,
        'secret.value.read',
        ctx
      );
      assert.equal(resSecretRead.allowed, true);
    });

    it('should correctly authorize Project Writer', async () => {
      const principal: Principal = {
        type: 'DISCORD_USER',
        id: writerMemberId,
        authKind: 'DISCORD',
      };
      const ctx: CapabilityContext = { projectId: 'project-1', resourceId: 'env-res-1' };

      // Project Writer can view project and environments
      const resView = await hasCapability(mockReposForEval, principal, 'project.view', ctx);
      assert.equal(resView.allowed, true);
      assert.equal(resView.reasonCode, 'WRITER');

      // Project Writer can write secrets
      const resSecretWrite = await hasCapability(mockReposForEval, principal, 'secret.write', ctx);
      assert.equal(resSecretWrite.allowed, true);

      // Project Writer CANNOT delete project
      const resDelete = await hasCapability(mockReposForEval, principal, 'project.delete', ctx);
      assert.equal(resDelete.allowed, false);
      assert.equal(resDelete.reasonCode, 'NO_ROLE');

      // Project Writer CANNOT decide approvals
      const resDecide = await hasCapability(mockReposForEval, principal, 'request.decide', ctx);
      assert.equal(resDecide.allowed, false);
    });

    it('should correctly authorize Project Reader', async () => {
      const principal: Principal = {
        type: 'DISCORD_USER',
        id: readerMemberId,
        authKind: 'DISCORD',
      };
      const ctx: CapabilityContext = { projectId: 'project-1', resourceId: 'env-res-1' };

      // Project Reader can view project
      const resView = await hasCapability(mockReposForEval, principal, 'project.view', ctx);
      assert.equal(resView.allowed, true);
      assert.equal(resView.reasonCode, 'READER');

      // Project Reader can read secrets
      const resSecretRead = await hasCapability(
        mockReposForEval,
        principal,
        'secret.value.read',
        ctx
      );
      assert.equal(resSecretRead.allowed, true);

      // Project Reader CANNOT write secrets
      const resSecretWrite = await hasCapability(mockReposForEval, principal, 'secret.write', ctx);
      assert.equal(resSecretWrite.allowed, false);
    });

    it('should correctly authorize explicit Guardian and enforce self-approval prevention', async () => {
      const principal: Principal = {
        type: 'DISCORD_USER',
        id: explicitGuardianId,
        authKind: 'DISCORD',
      };
      const ctx: CapabilityContext = { resourceId: 'env-res-1', requestId: 'req-active' };

      // Guardian can view approval queue
      const resQueue = await hasCapability(mockReposForEval, principal, 'request.queue.view', ctx);
      assert.equal(resQueue.allowed, true);
      assert.equal(resQueue.reasonCode, 'GUARDIAN');

      // Guardian can decide requests
      const resDecide = await hasCapability(mockReposForEval, principal, 'request.decide', ctx);
      assert.equal(resDecide.allowed, true);

      // Guardian CANNOT decide request if they are the requester (self-approval)
      const selfPrincipal: Principal = {
        type: 'DISCORD_USER',
        id: randomUserId,
        authKind: 'DISCORD',
      };
      const selfApprovalRepo = {
        ...mockReposForEval,
        guardians: {
          findByResourceAndUser: async () => mockExplicitGuardian,
        },
      } as unknown as Repositories;

      const resSelfDecide = await hasCapability(
        selfApprovalRepo,
        selfPrincipal,
        'request.decide',
        ctx
      );
      assert.equal(resSelfDecide.allowed, false);
      assert.equal(resSelfDecide.reasonCode, 'SELF_APPROVAL_FORBIDDEN');
    });

    it('should authorize personal TOTP Owner and deny others for recovery keys', async () => {
      const ownerPrincipal: Principal = {
        type: 'DISCORD_USER',
        id: projectOwnerId,
        authKind: 'DISCORD',
      };
      const otherPrincipal: Principal = {
        type: 'DISCORD_USER',
        id: randomUserId,
        authKind: 'DISCORD',
      };
      const ctx: CapabilityContext = { totpAccountId: 'totp-1' };

      // Owner of the TOTP account can read recovery key
      const resOwner = await hasCapability(
        mockReposForEval,
        ownerPrincipal,
        'totp.recovery.read',
        ctx
      );
      assert.equal(resOwner.allowed, true);

      // Another user cannot read recovery key
      const resOther = await hasCapability(
        mockReposForEval,
        otherPrincipal,
        'totp.recovery.read',
        ctx
      );
      assert.equal(resOther.allowed, false);
      assert.equal(resOther.reasonCode, 'RECOVERY_KEY_OWNER_REQUIRED');
    });

    it('should authorize grant consumption if approved grant exists', async () => {
      const requesterPrincipal: Principal = {
        type: 'DISCORD_USER',
        id: randomUserId,
        authKind: 'DISCORD',
      };
      const ctx: CapabilityContext = { resourceId: 'env-res-1' };

      const res = await hasCapability(mockReposForEval, requesterPrincipal, 'grant.consume', ctx);
      assert.equal(res.allowed, true);
      assert.equal(res.reasonCode, 'GRANT');
    });
  });
});
