/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handlePurrmissionCommand } from './twoFa.js';
import type { CommandContext } from './context.js';
import type { ChatInputCommandInteraction } from 'discord.js';

describe('handlePurrmissionCommand - Guardian Routing', () => {
    let mockInteraction: ChatInputCommandInteraction;
    let mockContext: CommandContext;
    let addGuardianCalls: any[] = [];
    let replyCalls: any[] = [];

    beforeEach(() => {
        addGuardianCalls = [];
        replyCalls = [];

        mockInteraction = {
            commandName: 'purrmission',
            user: { id: 'caller-id' } as any,
            options: {
                getSubcommandGroup: ((_required: boolean) => {
                    return null; // overridden
                }) as any,
                getSubcommand: ((_required: boolean) => {
                    return null; // overridden
                }) as any,
                getString: ((name: string) => {
                    if (name === 'resource-id') return 'res-123';
                    return null;
                }) as any,
                getUser: ((name: string) => {
                    if (name === 'user') return { id: 'target-user-id' };
                    return null;
                }) as any,
            } as any,
            reply: ((options: any) => {
                replyCalls.push(options);
                return Promise.resolve();
            }) as any,
        } as unknown as ChatInputCommandInteraction;

        mockContext = {
            services: {
                resource: {
                    addGuardian: async (resourceId: string, userId: string) => {
                        addGuardianCalls.push({ resourceId, userId });
                        // simulate success so handleAddGuardian completes
                        return { success: true, guardian: { id: 'g-1', role: 'GUARDIAN' } };
                    },
                } as any,
            } as any,
            repositories: {} as any,
        } as unknown as CommandContext;
    });

    it('should route /purrmission guardian add to handleAddGuardian logic', async () => {
        // Setup
        mockInteraction.options.getSubcommandGroup = () => 'guardian';
        mockInteraction.options.getSubcommand = () => 'add';

        // Execute
        await handlePurrmissionCommand(mockInteraction, mockContext);

        // Verify that the service method invoked by handleAddGuardian was called
        assert.strictEqual(addGuardianCalls.length, 1);
        assert.deepStrictEqual(addGuardianCalls[0], { resourceId: 'res-123', userId: 'target-user-id' });

        // Also verify the success reply from handleAddGuardian to be sure
        assert.ok(replyCalls.length > 0);
        assert.ok(replyCalls[0].content.includes('Guardian added successfully'));
    });

    it('should NOT route to guardian logic if group is unrelated', async () => {
        // Setup
        mockInteraction.options.getSubcommandGroup = () => 'other';
        mockInteraction.options.getSubcommand = () => 'foo';

        // Execute
        await handlePurrmissionCommand(mockInteraction, mockContext);

        // Verify service not called
        assert.strictEqual(addGuardianCalls.length, 0);

        // Verify unsupported group reply
        assert.ok(replyCalls.length > 0);
        assert.ok(replyCalls[0].content.includes('Unsupported subcommand group'));
    });
});
