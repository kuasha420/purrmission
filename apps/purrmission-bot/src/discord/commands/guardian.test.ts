import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handlePurrmissionCommand } from './twoFa.js';
import type { CommandContext } from './context.js';
import type {
    ChatInputCommandInteraction,
    CommandInteractionOptionResolver,
    User,
    CacheType
} from 'discord.js';

interface MockServices {
    resource: {
        addGuardian: (resourceId: string, userId: string) => Promise<{ success: boolean; guardian?: { id: string; role: string } }>;
    }
}

describe('handlePurrmissionCommand - Guardian Routing', () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;
    let mockContext: CommandContext;
    let addGuardianCalls: { resourceId: string; userId: string }[] = [];
    let replyCalls: unknown[] = [];

    beforeEach(() => {
        addGuardianCalls = [];
        replyCalls = [];

        mockInteraction = {
            commandName: 'purrmission',
            user: { id: 'caller-id' } as User,
            options: {
                getSubcommandGroup: ((_required?: boolean) => {
                    return null; // overridden
                }) as CommandInteractionOptionResolver['getSubcommandGroup'],
                getSubcommand: ((_required?: boolean) => {
                    return null; // overridden
                }) as CommandInteractionOptionResolver['getSubcommand'],
                getString: ((name: string) => {
                    if (name === 'resource-id') return 'res-123';
                    return null;
                }) as CommandInteractionOptionResolver['getString'],
                getUser: ((name: string) => {
                    if (name === 'user') return { id: 'target-user-id' } as User;
                    return null;
                }) as CommandInteractionOptionResolver['getUser'],
            } as CommandInteractionOptionResolver<CacheType>,
            reply: ((options: unknown) => {
                replyCalls.push(options);
                return Promise.resolve(null as unknown); // Return unknown enabling cast to InteractionCallbackResponse if needed, but for void return in test it's fine
            }) as unknown as ChatInputCommandInteraction['reply'],
        } as unknown as ChatInputCommandInteraction;

        mockContext = {
            services: {
                resource: {
                    addGuardian: async (resourceId: string, userId: string) => {
                        addGuardianCalls.push({ resourceId, userId });
                        // simulate success so handleAddGuardian completes
                        return { success: true, guardian: { id: 'g-1', role: 'GUARDIAN' } };
                    },
                },
            } as unknown as MockServices,
            repositories: {},
        } as unknown as CommandContext;
    });

    it('should route /purrmission guardian add to handleAddGuardian logic', async () => {
        // Setup
        mockInteraction.options!.getSubcommandGroup = () => 'guardian';
        mockInteraction.options!.getSubcommand = () => 'add';

        // Execute
        await handlePurrmissionCommand(mockInteraction as ChatInputCommandInteraction, mockContext);

        // Verify that the service method invoked by handleAddGuardian was called
        assert.strictEqual(addGuardianCalls.length, 1);
        assert.deepStrictEqual(addGuardianCalls[0], { resourceId: 'res-123', userId: 'target-user-id' });

        // Also verify the success reply from handleAddGuardian to be sure
        assert.ok(replyCalls.length > 0);
        assert.ok((replyCalls[0] as { content: string }).content.includes('Guardian added successfully'));
    });

    it('should show error for unknown guardian subcommand', async () => {
        // Setup
        mockInteraction.options!.getSubcommandGroup = () => 'guardian';
        mockInteraction.options!.getSubcommand = () => 'remove'; // not yet implemented

        // Execute
        await handlePurrmissionCommand(mockInteraction as ChatInputCommandInteraction, mockContext);

        // Verify service not called
        assert.strictEqual(addGuardianCalls.length, 0);

        // Verify unsupported subcommand reply
        assert.ok(replyCalls.length > 0);
        assert.ok((replyCalls[0] as { content: string }).content.includes('Unsupported subcommand for /purrmission guardian'));
    });

    it('should NOT route to guardian logic if group is unrelated', async () => {
        // Setup
        mockInteraction.options!.getSubcommandGroup = () => 'other';
        mockInteraction.options!.getSubcommand = () => 'foo';

        // Execute
        await handlePurrmissionCommand(mockInteraction as ChatInputCommandInteraction, mockContext);

        // Verify service not called
        assert.strictEqual(addGuardianCalls.length, 0);

        // Verify unsupported group reply
        assert.ok(replyCalls.length > 0);
        assert.ok((replyCalls[0] as { content: string }).content.includes('Unsupported subcommand group'));
    });
});
