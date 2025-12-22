/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { handleResourceCommand } from './resource.js';
import type { CommandContext } from './context.js';
import type { ChatInputCommandInteraction } from 'discord.js';

describe('handleResourceCommand - list', () => {
    let mockInteraction: ChatInputCommandInteraction;
    let mockContext: CommandContext;
    let replyCalls: any[] = [];
    let findByUserIdOverrides: any[] = [];
    let findManyByIdsOverrides: any[] = [];

    beforeEach(() => {
        replyCalls = [];
        findByUserIdOverrides = [];
        findManyByIdsOverrides = [];

        mockInteraction = {
            user: { id: 'user-1' } as any,
            options: {
                getSubcommand: () => 'list',
            } as any,
            reply: ((options: any) => {
                replyCalls.push(options);
                return Promise.resolve();
            }) as any,
        } as unknown as ChatInputCommandInteraction;

        mockContext = {
            repositories: {
                guardians: {
                    findByUserId: async (_userId: string) => {
                        return findByUserIdOverrides;
                    },
                } as any,
                resources: {
                    findManyByIds: async (_ids: string[]) => {
                        return findManyByIdsOverrides;
                    },
                } as any,
            } as any,
        } as unknown as CommandContext;
    });

    it('should list resources where user is OWNER or GUARDIAN', async () => {
        // Setup
        findByUserIdOverrides = [
            { resourceId: 'res-1', discordUserId: 'user-1', id: 'g1', role: 'OWNER' },
            { resourceId: 'res-2', discordUserId: 'user-1', id: 'g2', role: 'GUARDIAN' },
        ];

        findManyByIdsOverrides = [
            { id: 'res-1', name: 'Alpha Resource', mode: 'ONE_OF_N' },
            { id: 'res-2', name: 'Beta Resource', mode: 'ONE_OF_N' },
        ];

        // Execute
        await handleResourceCommand(mockInteraction, mockContext);

        // Verify
        assert.strictEqual(replyCalls.length, 1);
        const content = replyCalls[0].content;

        assert.ok(content.includes('**📋 Your Resources:**'));
        assert.ok(content.includes('**Alpha Resource** (`res-1`) — 👑 Owner'));
        assert.ok(content.includes('**Beta Resource** (`res-2`) — 🛡️ Guardian'));
    });

    it('should handle message when user has no resources', async () => {
        // Setup
        findByUserIdOverrides = [];

        // Execute
        await handleResourceCommand(mockInteraction, mockContext);

        // Verify
        assert.strictEqual(replyCalls.length, 1);
        assert.strictEqual(replyCalls[0].content, 'You do not own or guard any resources yet.');
    });

    it('should handle orphaned guardianships (resource deleted)', async () => {
        // Setup
        findByUserIdOverrides = [
            { resourceId: 'res-1', discordUserId: 'user-1', id: 'g1', role: 'OWNER' },
        ];

        // Resources return empty list (orphan)
        findManyByIdsOverrides = [];

        // Execute
        await handleResourceCommand(mockInteraction, mockContext);

        // Verify
        assert.strictEqual(replyCalls.length, 1);
        assert.strictEqual(replyCalls[0].content, 'You do not own or guard any resources (orphaned records found).');
    });
});
