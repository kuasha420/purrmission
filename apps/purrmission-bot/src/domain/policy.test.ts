import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccessPolicy, requiresApproval } from './policy.js';
import type { Resource, Guardian, ApprovalRequest, ApprovalStatus } from './models.js';
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
            }
        } as unknown as Repositories;

        const result = await checkAccessPolicy(mockResource, guardians, 'user-approved', reposWithApproval);
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
            }
        } as unknown as Repositories;

        const result = await checkAccessPolicy(mockResource, guardians, 'user-expired', reposWithExpired);
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
            }
        } as unknown as Repositories;

        const result = await checkAccessPolicy(mockResource, guardians, 'user-pending', reposWithPending);
        assert.equal(result.allowed, false);
        assert.equal(result.requiresApproval, true);
    });
});
