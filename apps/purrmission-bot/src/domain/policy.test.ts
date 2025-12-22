import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccessPolicy, requiresApproval } from './policy.js';
import type { Resource, Guardian } from './models.js';

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

    it('should allow direct access for owner', async () => {
        const result = await checkAccessPolicy(mockResource, guardians, 'user-owner');
        assert.equal(result.allowed, true);
        assert.equal(result.requiresApproval, false);
        assert.match(result.reason ?? '', /guardian\/owner/);
    });

    it('should allow direct access for guardian', async () => {
        const result = await checkAccessPolicy(mockResource, guardians, 'user-guardian');
        assert.equal(result.allowed, true);
        assert.equal(result.requiresApproval, false);
    });

    it('should require approval for non-guardian', async () => {
        const result = await checkAccessPolicy(mockResource, guardians, 'user-random');
        assert.equal(result.allowed, false);
        assert.equal(result.requiresApproval, true);
        assert.equal(requiresApproval(result), true);
    });

    it('should handle empty guardians list safely', async () => {
        const result = await checkAccessPolicy(mockResource, [], 'user-owner');
        assert.equal(result.allowed, false);
        assert.equal(result.requiresApproval, true);
    });
});
