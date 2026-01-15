import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { ResourceService, type ServiceDependencies } from './services.js';
import {
    type GuardianRepository,
    type ResourceRepository,
    type Repositories
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
            findByResourceAndUser: mock.fn(),
            findByResourceId: mock.fn(),
            remove: mock.fn(),
            add: mock.fn(),
        };

        mockResourceRepo = {
            findById: mock.fn(),
        };

        mockRepositories = {
            guardians: mockGuardianRepo as GuardianRepository,
            resources: mockResourceRepo as ResourceRepository,
        } as Repositories;

        const deps: ServiceDependencies = { repositories: mockRepositories };
        resourceService = new ResourceService(deps);
    });

    describe('removeGuardian', () => {
        it('should remove guardian if actor is owner', async () => {
            // Mock Actor is Owner
            (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(async (_rid: string, uid: string) => {
                if (uid === ownerId) return { id: 'g1', role: 'OWNER', discordUserId: ownerId } as Guardian;
                if (uid === guardianId) return { id: 'g2', role: 'GUARDIAN', discordUserId: guardianId } as Guardian;
                return null;
            });

            const result = await resourceService.removeGuardian(resourceId, ownerId, guardianId);

            assert.strictEqual(result.success, true);
            assert.strictEqual((mockGuardianRepo.remove as any).mock.calls.length, 1);
            assert.deepStrictEqual((mockGuardianRepo.remove as any).mock.calls[0].arguments, [resourceId, guardianId]);
        });

        it('should fail if actor is not owner', async () => {
            // Mock Actor is Guardian (not Owner)
            (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(async (_rid: string, uid: string) => {
                if (uid === guardianId) return { id: 'g2', role: 'GUARDIAN', discordUserId: guardianId } as Guardian;
                return null;
            });

            const result = await resourceService.removeGuardian(resourceId, guardianId, otherId);

            assert.strictEqual(result.success, false);
            assert.match(result.error!, /Only the resource owner/);
            assert.strictEqual((mockGuardianRepo.remove as any).mock.calls.length, 0);
        });

        it('should fail if target is not a guardian', async () => {
            // Mock Actor is Owner, Target not found
            (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(async (_rid: string, uid: string) => {
                if (uid === ownerId) return { id: 'g1', role: 'OWNER', discordUserId: ownerId } as Guardian;
                return null;
            });

            const result = await resourceService.removeGuardian(resourceId, ownerId, otherId);

            assert.strictEqual(result.success, false);
            assert.match(result.error!, /not a guardian/);
            assert.strictEqual((mockGuardianRepo.remove as any).mock.calls.length, 0);
        });
    });

    describe('listGuardians', () => {
        it('should list guardians if actor is authorized', async () => {
            // Mock Actor is Guardian
            (mockGuardianRepo.findByResourceAndUser as any).mock.mockImplementation(async (_rid: string, uid: string) => {
                if (uid === guardianId) return { id: 'g2', role: 'GUARDIAN', discordUserId: guardianId } as Guardian;
                return null;
            });

            // Mock List return
            (mockGuardianRepo.findByResourceId as any).mock.mockImplementation(async () => [
                { id: 'g1', role: 'OWNER' }, { id: 'g2', role: 'GUARDIAN' }
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
});
