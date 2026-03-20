import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handleGuardianCommand } from './guardian.js';
import type { CommandContext } from './context.js';
import type {
  ChatInputCommandInteraction,
  CommandInteractionOptionResolver,
  User,
  CacheType,
} from 'discord.js';

interface MockServices {
  resource: {
    addGuardian: (
      resourceId: string,
      userId: string
    ) => Promise<{ success: boolean; guardian?: { id: string; role: string } }>;
    removeGuardian: (
      resourceId: string,
      actorId: string,
      targetUserId: string
    ) => Promise<{ success: boolean; error?: string }>;
    listGuardians: (
      resourceId: string,
      actorId: string
    ) => Promise<{
      success: boolean;
      guardians?: { discordUserId: string; role: string }[];
      error?: string;
    }>;
  };
}

describe('handleGuardianCommand', () => {
  let mockInteraction: Partial<ChatInputCommandInteraction>;
  let mockOptions: CommandInteractionOptionResolver<CacheType>;
  let mockContext: CommandContext;
  let addGuardianCalls: { resourceId: string; userId: string }[] = [];
  let removeGuardianCalls: { resourceId: string; targetUserId: string; actorId: string }[] = [];
  let listGuardiansCalls: { resourceId: string; actorId: string }[] = [];
  let replyCalls: unknown[] = [];

  beforeEach(() => {
    addGuardianCalls = [];
    removeGuardianCalls = [];
    listGuardiansCalls = [];
    replyCalls = [];

    mockOptions = {
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
        if (name === 'user') return { id: 'target-user-id', tag: 'Tag#1234' } as User;
        return null;
      }) as CommandInteractionOptionResolver['getUser'],
    } as CommandInteractionOptionResolver<CacheType>;

    mockInteraction = {
      commandName: 'guardian',
      user: { id: 'caller-id' } as User,
      options: mockOptions,
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
          removeGuardian: async (resourceId: string, actorId: string, targetUserId: string) => {
            removeGuardianCalls.push({ resourceId, actorId, targetUserId });
            return { success: true };
          },
          listGuardians: async (resourceId: string, actorId: string) => {
            listGuardiansCalls.push({ resourceId, actorId });
            return {
              success: true,
              guardians: [
                { discordUserId: 'u1', role: 'OWNER' },
                { discordUserId: 'u2', role: 'GUARDIAN' },
              ],
            };
          },
        },
      } as unknown as MockServices,
      repositories: {},
    } as unknown as CommandContext;
  });

  it('should route /guardian add to handleAddGuardian logic', async () => {
    // Setup
    mockOptions.getSubcommand = () => 'add';

    // Execute
    await handleGuardianCommand(mockInteraction as ChatInputCommandInteraction, mockContext);

    // Verify that the service method invoked by handleAddGuardian was called
    assert.strictEqual(addGuardianCalls.length, 1);
    assert.deepStrictEqual(addGuardianCalls[0], {
      resourceId: 'res-123',
      userId: 'target-user-id',
    });

    // Also verify the success reply from handleAddGuardian to be sure
    assert.ok(replyCalls.length > 0);
    assert.ok(
      (replyCalls[0] as { content: string }).content.includes('Guardian added successfully')
    );
  });

  it('should route /guardian remove to handleRemoveGuardian logic', async () => {
    // Setup
    mockOptions.getSubcommand = () => 'remove';

    // Execute
    await handleGuardianCommand(mockInteraction as ChatInputCommandInteraction, mockContext);

    // Verify routing (service called)
    assert.strictEqual(removeGuardianCalls.length, 1);
    assert.deepStrictEqual(removeGuardianCalls[0], {
      resourceId: 'res-123',
      targetUserId: 'target-user-id',
      actorId: 'caller-id',
    });

    // Verify success reply
    assert.ok(replyCalls.length > 0);
    assert.ok((replyCalls[0] as { content: string }).content.includes('Removed'));
  });

  it('should route /guardian list to handleListGuardians logic', async () => {
    // Setup
    mockOptions.getSubcommand = () => 'list';

    // Execute
    await handleGuardianCommand(mockInteraction as ChatInputCommandInteraction, mockContext);

    // Verify routing
    assert.strictEqual(listGuardiansCalls.length, 1);
    assert.deepStrictEqual(listGuardiansCalls[0], { resourceId: 'res-123', actorId: 'caller-id' });

    // Verify success reply (list output)
    assert.ok(replyCalls.length > 0);
    assert.ok((replyCalls[0] as { content: string }).content.includes('Guardians for'));
  });

  it('should show error for unknown guardian subcommand', async () => {
    // Setup
    mockOptions.getSubcommand = () => 'unknown_cmd';

    // Execute
    await handleGuardianCommand(mockInteraction as ChatInputCommandInteraction, mockContext);

    // Verify service not called
    assert.strictEqual(addGuardianCalls.length, 0);
    assert.strictEqual(removeGuardianCalls.length, 0);

    // Verify unsupported subcommand reply
    assert.ok(replyCalls.length > 0);
    assert.ok((replyCalls[0] as { content: string }).content.includes('Unknown subcommand'));
  });
});
