import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { ResourceService, ApprovalService, type ServiceDependencies } from './services.js';
import {
  type GuardianRepository,
  type ResourceRepository,
  type ApprovalRequestRepository,
  type Repositories,
} from './repositories.js';
import type { Guardian } from './models.js';

describe('ResourceService', () => {
  let resourceService: ResourceService;
  let mockRepositories: Repositories;
  let mockGuardianRepo: Partial<GuardianRepository>;
  let mockResourceRepo: Partial<ResourceRepository>;

  const resourceId = 'res-1';
  const ownerId = 'owner-1';
  const guardianId = 'guardian-1';
  const otherId = 'other-1';

  beforeEach(() => {
    mockGuardianRepo = {
      findByResourceAndUser: mock.fn() as any,
      findByResourceId: mock.fn() as any,
      remove: mock.fn() as any,
      add: mock.fn() as any,
    };

    mockResourceRepo = {
      findById: mock.fn() as any,
    };

    mockRepositories = {
      guardians: mockGuardianRepo as GuardianRepository,
      resources: mockResourceRepo as ResourceRepository,
      projects: {
        findEnvironmentByResourceId: mock.fn(async () => null),
      } as any,
    } as Repositories;

    const deps: ServiceDependencies = { repositories: mockRepositories };
    resourceService = new ResourceService(deps);
  });

  describe('removeGuardian', () => {
    it('should remove guardian if actor is owner', async () => {
      // Mock Actor is Owner
      (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(
        async (_rid: string, uid: string) => {
          if (uid === ownerId)
            return { id: 'g1', role: 'OWNER', discordUserId: ownerId } as Guardian;
          if (uid === guardianId)
            return { id: 'g2', role: 'GUARDIAN', discordUserId: guardianId } as Guardian;
          return null;
        }
      );

      const result = await resourceService.removeGuardian(resourceId, ownerId, guardianId);

      assert.strictEqual(result.success, true);
      assert.strictEqual((mockGuardianRepo.remove as any).mock.calls.length, 1);
      assert.deepStrictEqual((mockGuardianRepo.remove as any).mock.calls[0].arguments, [
        resourceId,
        guardianId,
      ]);
    });

    it('should fail if actor is not owner', async () => {
      // Mock Actor is Guardian (not Owner)
      (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(
        async (_rid: string, uid: string) => {
          if (uid === guardianId)
            return { id: 'g2', role: 'GUARDIAN', discordUserId: guardianId } as Guardian;
          return null;
        }
      );

      const result = await resourceService.removeGuardian(resourceId, guardianId, otherId);

      assert.strictEqual(result.success, false);
      assert.match(result.error!, /Only the resource owner/);
      assert.strictEqual((mockGuardianRepo.remove as any).mock.calls.length, 0);
    });

    it('should fail if target is not a guardian', async () => {
      // Mock Actor is Owner, Target not found
      (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(
        async (_rid: string, uid: string) => {
          if (uid === ownerId)
            return { id: 'g1', role: 'OWNER', discordUserId: ownerId } as Guardian;
          return null;
        }
      );

      const result = await resourceService.removeGuardian(resourceId, ownerId, otherId);

      assert.strictEqual(result.success, false);
      assert.match(result.error!, /not a guardian/);
      assert.strictEqual((mockGuardianRepo.remove as any).mock.calls.length, 0);
    });

    it('should fail if target is owner', async () => {
      // Mock Actor is Owner, Target is Owner
      (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(
        async (_rid: string, uid: string) => {
          if (uid === ownerId)
            return { id: 'g1', role: 'OWNER', discordUserId: ownerId } as Guardian;
          if (uid === guardianId)
            return { id: 'g2', role: 'OWNER', discordUserId: guardianId } as Guardian; // Simulate target as another owner or same owner
          return null;
        }
      );

      const result = await resourceService.removeGuardian(resourceId, ownerId, guardianId);

      assert.strictEqual(result.success, false);
      assert.match(result.error!, /Cannot remove the resource owner/);
      assert.strictEqual((mockGuardianRepo.remove as any).mock.calls.length, 0);
    });
  });

  describe('listGuardians', () => {
    it('should list guardians if actor is authorized', async () => {
      // Mock Actor is Guardian
      (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(
        async (_rid: string, uid: string) => {
          if (uid === guardianId)
            return { id: 'g2', role: 'GUARDIAN', discordUserId: guardianId } as Guardian;
          return null;
        }
      );

      // Mock List return
      (mockGuardianRepo.findByResourceId as any).mock.mockImplementation(async () => [
        { id: 'g1', role: 'OWNER' },
        { id: 'g2', role: 'GUARDIAN' },
      ]);

      const result = await resourceService.listGuardians(resourceId, guardianId);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.guardians!.length, 2);
    });

    it('should fail if actor is unauthorized', async () => {
      // Mock Actor not found
      (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(async () => null);

      const result = await resourceService.listGuardians(resourceId, otherId);

      assert.strictEqual(result.success, false);
      assert.match(result.error!, /Access denied/);
    });
  });

  describe('linkTOTPAccount', () => {
    it('should succeed even if audit logging throws an error', async () => {
      const mockResource = { id: resourceId, totpAccountId: null };
      const mockTotpAccount = { id: 'totp-1' };
      const mockTotpRepo = {
        findById: mock.fn(async () => mockTotpAccount),
      };
      mockResourceRepo.findById = mock.fn(async () => mockResource) as any;
      mockResourceRepo.update = mock.fn(async () => mockResource) as any;

      const failingAuditService = {
        log: mock.fn(async () => {
          throw new Error('Audit service unavailable');
        }),
      };

      const deps: ServiceDependencies = {
        repositories: {
          ...mockRepositories,
          totp: mockTotpRepo as any,
        },
        audit: failingAuditService as any,
      };
      const svc = new ResourceService(deps);

      // Should complete successfully without throwing
      await svc.linkTOTPAccount(resourceId, 'totp-1', ownerId);

      assert.strictEqual((mockResourceRepo.update as any).mock.calls.length, 1);
      assert.strictEqual(failingAuditService.log.mock.calls.length, 1);
    });
  });
});

describe('ApprovalService', () => {
  let approvalService: ApprovalService;
  let mockRepositories: Repositories;
  let mockApprovalRepo: Partial<ApprovalRequestRepository>;
  let mockResourceRepo: Partial<ResourceRepository>;
  let mockGuardianRepo: Partial<GuardianRepository>;

  beforeEach(() => {
    mockApprovalRepo = {
      create: mock.fn() as any,
      findById: mock.fn() as any,
      updateStatus: mock.fn() as any,
      findActiveByRequester: mock.fn() as any,
    };
    mockResourceRepo = {
      findById: mock.fn() as any,
    };
    mockGuardianRepo = {
      findByResourceId: mock.fn() as any,
    };

    mockRepositories = {
      approvalRequests: mockApprovalRepo as ApprovalRequestRepository,
      resources: mockResourceRepo as ResourceRepository,
      guardians: mockGuardianRepo as GuardianRepository,
      projects: {
        findEnvironmentByResourceId: mock.fn(async () => null),
      } as any,
    } as Repositories;

    const deps: ServiceDependencies = { repositories: mockRepositories };
    approvalService = new ApprovalService(deps);
  });

  describe('findActiveApproval', () => {
    it('should call repository.findActiveByRequester', async () => {
      const resourceId = 'res-1';
      const requesterId = 'user-1';
      const mockRequest = { id: 'req-1', status: 'PENDING' };

      (mockApprovalRepo.findActiveByRequester as any).mock.mockImplementation(
        async () => mockRequest
      );

      const result = await approvalService.findActiveApproval(resourceId, requesterId);

      assert.strictEqual(result, mockRequest);
      assert.strictEqual((mockApprovalRepo.findActiveByRequester as any).mock.calls.length, 1);
      assert.deepStrictEqual(
        (mockApprovalRepo.findActiveByRequester as any).mock.calls[0].arguments,
        [resourceId, requesterId]
      );
    });
  });

  describe('recordDecision', () => {
    it('should succeed even if audit logging throws an error', async () => {
      const mockRequest = {
        id: 'req-1',
        status: 'PENDING',
        resourceId: 'res-1',
        context: { requesterId: 'requester-1' },
      };
      mockApprovalRepo.findById = mock.fn(async () => mockRequest) as any;
      mockApprovalRepo.updateStatus = mock.fn(async () => {}) as any;
      mockGuardianRepo.findByResourceAndUser = mock.fn(async () => ({
        id: 'g-1',
        role: 'OWNER',
      })) as any;

      const failingAuditService = {
        log: mock.fn(async () => {
          throw new Error('Audit service unavailable');
        }),
      };

      const deps: ServiceDependencies = {
        repositories: mockRepositories,
        audit: failingAuditService as any,
      };
      const svc = new ApprovalService(deps);

      const result = await svc.recordDecision('req-1', 'APPROVE', 'guardian-1');

      assert.strictEqual(result.success, true);
      assert.strictEqual((mockApprovalRepo.updateStatus as any).mock.calls.length, 1);
      assert.strictEqual(failingAuditService.log.mock.calls.length, 1);
    });
  });
});
