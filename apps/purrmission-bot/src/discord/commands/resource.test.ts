import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handleResourceAutocomplete } from './resource.js';
import type { CommandContext } from './context.js';
import type { AutocompleteInteraction } from 'discord.js';

// Type-safe mock helper compatible with strict mode
function createMock<T>(impl: Partial<T> = {}): T {
    return impl as T;
}

describe('handleResourceAutocomplete', () => {
    let mockInteraction: Partial<AutocompleteInteraction>;
    let mockContext: Partial<CommandContext>;
    let respondCalls: any[] = [];
    let findByUserIdOverrides: any[] = [];
    let findManyByIdsOverrides: any[] = [];
    let findByResourceIdOverrides: any[] = [];

    beforeEach(() => {
        respondCalls = [];
        findByUserIdOverrides = [];
        findManyByIdsOverrides = [];
        findByResourceIdOverrides = [];

        mockInteraction = {
            user: { id: 'user-1' } as any,
            options: {
                getFocused: ((full: boolean) => {
                    // Default implementation, overridden in tests
                    return { name: 'unknown', value: '' };
                }) as any,
                getString: ((name: string) => {
                    return '';
                }) as any,
            } as any,
            respond: ((options: any[]) => {
                respondCalls.push(options);
                return Promise.resolve();
            }) as any,
        };

        mockContext = {
            repositories: {
                guardians: {
                    findByUserId: async (userId: string) => {
                        return findByUserIdOverrides;
                    },
                } as any,
                resources: {
                    findManyByIds: async (ids: string[]) => {
                        return findManyByIdsOverrides;
                    },
                } as any,
                resourceFields: {
                    findByResourceId: async (resourceId: string) => {
                        return findByResourceIdOverrides;
                    },
                } as any,
                totp: {} as any, // Not used in these tests
            } as any,
        };
    });

    it('should return matching resources for resource-id autocomplete', async () => {
        // Setup
        mockInteraction.options!.getFocused = () => ({ name: 'resource-id', value: 'cool' } as any);

        // User is guardian of 2 resources
        findByUserIdOverrides = [
            { resourceId: 'res-1', discordUserId: 'user-1', id: 'g1', createdAt: new Date() },
            { resourceId: 'res-2', discordUserId: 'user-1', id: 'g2', createdAt: new Date() },
        ];

        // Resource details
        findManyByIdsOverrides = [
            { id: 'res-1', name: 'My Cool Resource', mode: 'ONE_OF_N' },
            { id: 'res-2', name: 'Other Resource', mode: 'ONE_OF_N' },
        ];

        // Execute
        await handleResourceAutocomplete(mockInteraction as AutocompleteInteraction, mockContext as CommandContext);

        // Verify
        assert.strictEqual(respondCalls.length, 1);
        assert.deepStrictEqual(respondCalls[0], [
            { name: 'My Cool Resource', value: 'res-1' },
        ]);
    });

    it('should return nothing if user has no guardianships', async () => {
        // Setup
        mockInteraction.options!.getFocused = () => ({ name: 'resource-id', value: '' } as any);
        findByUserIdOverrides = [];

        // Execute
        await handleResourceAutocomplete(mockInteraction as AutocompleteInteraction, mockContext as CommandContext);

        // Verify
        assert.strictEqual(respondCalls.length, 1);
        assert.deepStrictEqual(respondCalls[0], []);
    });

    it('should handle cases where some resources are not found', async () => {
        // Setup
        mockInteraction.options!.getFocused = () => ({ name: 'resource-id', value: '' } as any);

        // User is guardian of 2 resources
        findByUserIdOverrides = [
            { resourceId: 'res-1', discordUserId: 'user-1', id: 'g1', createdAt: new Date() },
            { resourceId: 'res-2', discordUserId: 'user-1', id: 'g2', createdAt: new Date() },
        ];

        // Only one resource found (res-2 is missing/deleted)
        findManyByIdsOverrides = [
            { id: 'res-1', name: 'My Cool Resource', mode: 'ONE_OF_N' },
        ];

        // Execute
        await handleResourceAutocomplete(mockInteraction as AutocompleteInteraction, mockContext as CommandContext);

        // Verify matches only the found resource
        assert.strictEqual(respondCalls.length, 1);
        assert.deepStrictEqual(respondCalls[0], [
            { name: 'My Cool Resource', value: 'res-1' },
        ]);
    });

    it('should autocomplete fields for a given resource-id', async () => {
        // Setup
        mockInteraction.options!.getFocused = () => ({ name: 'name', value: 'pass' } as any);
        mockInteraction.options!.getString = () => 'res-1';

        findByResourceIdOverrides = [
            { name: 'password', id: 'f1', value: 'enc', resourceId: 'res-1' },
            { name: 'username', id: 'f2', value: 'enc', resourceId: 'res-1' },
        ];

        // Execute
        await handleResourceAutocomplete(mockInteraction as AutocompleteInteraction, mockContext as CommandContext);

        // Verify
        assert.strictEqual(respondCalls.length, 1);
        assert.deepStrictEqual(respondCalls[0], [
            { name: 'password', value: 'password' }
        ]);
    });
});
