
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handleResourceAutocomplete } from './resource.js';
import type { CommandContext } from './context.js';
import type { AutocompleteInteraction } from 'discord.js';

// Simple mock function helper
function createMockFn(impl: (...args: any[]) => any = () => { }) {
    const fn = (...args: any[]) => {
        fn.calls.push(args);
        return impl(...args);
    };
    fn.calls = [] as any[][];
    fn.mockResolvedValue = (val: any) => {
        fn.impl = () => Promise.resolve(val); // Update implementation
        return fn;
    };
    fn.mockReturnValue = (val: any) => {
        fn.impl = () => val;
        return fn;
    };
    // To allow changing implementation
    fn.impl = impl;

    // Proxy to run the current implementation
    const proxy = (...args: any[]) => {
        fn.calls.push(args);
        return fn.impl(...args);
    };
    proxy.calls = fn.calls;
    proxy.mockResolvedValue = (val: any) => {
        fn.impl = () => Promise.resolve(val);
    };
    proxy.mockReturnValue = (val: any) => {
        fn.impl = () => val;
    };
    proxy.mockImplementation = (newImpl: (...args: any[]) => any) => {
        fn.impl = newImpl;
    };

    return proxy;
}


describe('handleResourceAutocomplete', () => {
    let mockInteraction: any;
    let mockContext: any;

    beforeEach(() => {
        mockInteraction = {
            user: { id: 'user-1' },
            options: {
                getFocused: createMockFn(),
                getString: createMockFn(),
            },
            respond: createMockFn(),
        };

        mockContext = {
            repositories: {
                guardians: {
                    findByUserId: createMockFn(),
                },
                resources: {
                    findById: createMockFn(),
                },
                resourceFields: {
                    findByResourceId: createMockFn(),
                },
                totp: {
                    findByOwnerDiscordUserId: createMockFn(() => Promise.resolve([])),
                    findSharedVisibleTo: createMockFn(() => Promise.resolve([])),
                }
            },
        };
    });

    it('should return matching resources for resource-id autocomplete', async () => {
        // Setup
        mockInteraction.options.getFocused.mockReturnValue({
            name: 'resource-id',
            value: 'cool',
        });

        // User is guardian of 2 resources
        mockContext.repositories.guardians.findByUserId.mockResolvedValue([
            { resourceId: 'res-1', discordUserId: 'user-1', id: 'g1', createdAt: new Date() },
            { resourceId: 'res-2', discordUserId: 'user-1', id: 'g2', createdAt: new Date() },
        ]);

        // Resource details
        mockContext.repositories.resources.findById.mockImplementation(async (id: string) => {
            if (id === 'res-1') return { id: 'res-1', name: 'My Cool Resource', mode: 'ONE_OF_N' };
            if (id === 'res-2') return { id: 'res-2', name: 'Other Resource', mode: 'ONE_OF_N' };
            return null;
        });

        // Execute
        await handleResourceAutocomplete(mockInteraction, mockContext);

        // Verify
        const findByUserIdCalls = mockContext.repositories.guardians.findByUserId.calls;
        assert.strictEqual(findByUserIdCalls.length, 1);
        assert.strictEqual(findByUserIdCalls[0][0], 'user-1');

        const respondCalls = mockInteraction.respond.calls;
        assert.strictEqual(respondCalls.length, 1);
        assert.deepStrictEqual(respondCalls[0][0], [
            { name: 'My Cool Resource', value: 'res-1' },
        ]);
    });

    it('should return nothing if user has no guardianships', async () => {
        // Setup
        mockInteraction.options.getFocused.mockReturnValue({
            name: 'resource-id',
            value: '',
        });

        mockContext.repositories.guardians.findByUserId.mockResolvedValue([]);

        // Execute
        await handleResourceAutocomplete(mockInteraction, mockContext);

        // Verify
        assert.strictEqual(mockInteraction.respond.calls.length, 1);
        assert.deepStrictEqual(mockInteraction.respond.calls[0][0], []);
    });

    it('should autocomplete fields for a given resource-id', async () => {
        // Setup
        mockInteraction.options.getFocused.mockReturnValue({
            name: 'name', // field name option
            value: 'pass',
        });

        mockInteraction.options.getString.mockReturnValue('res-1');

        mockContext.repositories.resourceFields.findByResourceId.mockResolvedValue([
            { name: 'password', id: 'f1', value: 'enc', resourceId: 'res-1' },
            { name: 'username', id: 'f2', value: 'enc', resourceId: 'res-1' },
        ]);

        // Execute
        await handleResourceAutocomplete(mockInteraction, mockContext);

        // Verify
        const findCalls = mockContext.repositories.resourceFields.findByResourceId.calls;
        assert.strictEqual(findCalls.length, 1);
        assert.strictEqual(findCalls[0][0], 'res-1');

        const respondCalls = mockInteraction.respond.calls;
        assert.strictEqual(respondCalls.length, 1);
        assert.deepStrictEqual(respondCalls[0][0], [
            { name: 'password', value: 'password' }
        ]);
    });
});
