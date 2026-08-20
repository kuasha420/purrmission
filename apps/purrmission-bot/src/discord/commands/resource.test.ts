/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handleResourceAutocomplete, handleResourceCommand, resourceCommand } from './resource.js';
import type { CommandContext } from './context.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createInMemoryRepositories } from '../../domain/repositories.mock.js';
import { createServices } from '../../domain/services.js';

describe('handleResourceAutocomplete', () => {
  let mockInteraction: AutocompleteInteraction;
  let mockOptions: AutocompleteInteraction['options'];
  let mockContext: CommandContext;
  let respondCalls: any[] = [];
  let findByUserIdOverrides: any[] = [];
  let findManyByIdsOverrides: any[] = [];
  let findManyByIdsCalls: Array<{ ids: string[]; query?: string }> = [];
  let findByResourceIdOverrides: any[] = [];

  beforeEach(() => {
    respondCalls = [];
    findByUserIdOverrides = [];
    findManyByIdsOverrides = [];
    findManyByIdsCalls = [];
    findByResourceIdOverrides = [];

    mockOptions = {
      getSubcommandGroup: ((_required?: boolean) => {
        return null;
      }) as any,
      getSubcommand: ((_required?: boolean) => {
        return null;
      }) as any,
      getFocused: ((_full: boolean) => {
        // Default implementation, overridden in tests
        return { name: 'unknown', value: '' };
      }) as any,
      getString: ((_name: string) => {
        return '';
      }) as any,
    } as AutocompleteInteraction['options'];

    mockInteraction = {
      user: { id: 'user-1' } as any,
      options: mockOptions,
      respond: ((options: any[]) => {
        respondCalls.push(options);
        return Promise.resolve();
      }) as any,
    } as unknown as AutocompleteInteraction;

    mockContext = {
      repositories: {
        guardians: {
          findByUserId: async (_userId: string) => {
            return findByUserIdOverrides;
          },
        } as any,
        resources: {
          findManyByIds: async (ids: string[], query?: string) => {
            findManyByIdsCalls.push({ ids, query });
            return findManyByIdsOverrides;
          },
        } as any,
        resourceFields: {
          findByResourceId: async (_resourceId: string) => {
            return findByResourceIdOverrides;
          },
        } as any,
        totp: {} as any, // Not used in these tests
      } as any,
    } as unknown as CommandContext;
  });

  it('should return matching resources for resource-id autocomplete', async () => {
    // Setup
    mockOptions.getFocused = () => ({ name: 'resource-id', value: 'cool' }) as any;

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
    await handleResourceAutocomplete(
      mockInteraction as AutocompleteInteraction,
      mockContext as CommandContext
    );

    // Verify
    assert.strictEqual(respondCalls.length, 1);
    assert.deepStrictEqual(respondCalls[0], [{ name: 'My Cool Resource', value: 'res-1' }]);
    assert.deepStrictEqual(findManyByIdsCalls[0], {
      ids: ['res-1', 'res-2'],
      query: 'cool',
    });
  });

  it('should return nothing if user has no guardianships', async () => {
    // Setup
    mockOptions.getFocused = () => ({ name: 'resource-id', value: '' }) as any;
    findByUserIdOverrides = [];

    // Execute
    await handleResourceAutocomplete(
      mockInteraction as AutocompleteInteraction,
      mockContext as CommandContext
    );

    // Verify
    assert.strictEqual(respondCalls.length, 1);
    assert.deepStrictEqual(respondCalls[0], []);
  });

  it('should handle cases where some resources are not found', async () => {
    // Setup
    mockOptions.getFocused = () => ({ name: 'resource-id', value: '' }) as any;

    // User is guardian of 2 resources
    findByUserIdOverrides = [
      { resourceId: 'res-1', discordUserId: 'user-1', id: 'g1', createdAt: new Date() },
      { resourceId: 'res-2', discordUserId: 'user-1', id: 'g2', createdAt: new Date() },
    ];

    // Only one resource found (res-2 is missing/deleted)
    findManyByIdsOverrides = [{ id: 'res-1', name: 'My Cool Resource', mode: 'ONE_OF_N' }];

    // Execute
    await handleResourceAutocomplete(
      mockInteraction as AutocompleteInteraction,
      mockContext as CommandContext
    );

    // Verify matches only the found resource
    assert.strictEqual(respondCalls.length, 1);
    assert.deepStrictEqual(respondCalls[0], [{ name: 'My Cool Resource', value: 'res-1' }]);
  });

  it('should autocomplete fields for a given resource-id', async () => {
    // Setup
    mockOptions.getSubcommandGroup = () => 'fields';
    mockOptions.getSubcommand = () => 'get';
    mockOptions.getFocused = () => ({ name: 'name', value: 'pass' }) as any;
    mockOptions.getString = () => 'res-1';

    findByResourceIdOverrides = [
      { name: 'password', id: 'f1', value: 'enc', resourceId: 'res-1' },
      { name: 'username', id: 'f2', value: 'enc', resourceId: 'res-1' },
    ];

    // Execute
    await handleResourceAutocomplete(
      mockInteraction as AutocompleteInteraction,
      mockContext as CommandContext
    );

    // Verify
    assert.strictEqual(respondCalls.length, 1);
    assert.deepStrictEqual(respondCalls[0], [{ name: 'password', value: 'password' }]);
  });

  it('should cap /resource register names at 100 characters', () => {
    const registerOption = (resourceCommand.toJSON() as any).options?.find(
      (option: any) => option.name === 'register'
    );
    const nameOption = registerOption?.options?.find((option: any) => option.name === 'name');

    assert.strictEqual(nameOption?.max_length, 100);
  });

  it('requires an explicit one-time consent ID for /resource 2fa link', () => {
    const twoFaGroup = (resourceCommand.toJSON() as any).options?.find(
      (option: any) => option.name === '2fa'
    );
    const linkSubcommand = twoFaGroup?.options?.find((option: any) => option.name === 'link');
    const consentOption = linkSubcommand?.options?.find(
      (option: any) => option.name === 'consent-id'
    );

    assert.strictEqual(consentOption?.required, true);
  });

  it('does not let an explicit Guardian create, reveal, or delete secret fields directly', async () => {
    const repositories = createInMemoryRepositories();
    const services = createServices({ repositories });
    const resourceId = 'resource-guardian-negative';
    const guardianId = 'explicit-guardian';

    await repositories.resources.create({
      id: resourceId,
      name: 'Protected Resource',
      mode: 'ONE_OF_N',
    });
    await repositories.guardians.add({
      id: 'guardian-row',
      resourceId,
      discordUserId: guardianId,
      role: 'GUARDIAN',
    });
    await repositories.guardians.add({
      id: 'owner-row',
      resourceId,
      discordUserId: 'resource-owner',
      role: 'OWNER',
    });
    await repositories.resourceFields.create({
      resourceId,
      name: 'EXISTING',
      value: 'owner-created',
    });

    const commandContext = { repositories, services } as CommandContext;
    const replies: any[] = [];
    let directRevealDmCreated = false;

    const interactionFor = (subcommand: 'add' | 'get' | 'remove'): ChatInputCommandInteraction =>
      ({
        user: {
          id: guardianId,
          createDM: async () => {
            directRevealDmCreated = true;
            return { send: async () => undefined };
          },
        },
        options: {
          getSubcommandGroup: () => 'fields',
          getSubcommand: () => subcommand,
          getString: (name: string) => {
            if (name === 'resource-id') return resourceId;
            if (name === 'name') return subcommand === 'add' ? 'NEW_FIELD' : 'EXISTING';
            if (name === 'value') return 'must-not-write';
            return null;
          },
        },
        client: {
          users: {
            fetch: async () => ({
              createDM: async () => ({ send: async () => undefined }),
            }),
          },
        },
        reply: async (payload: any) => {
          replies.push(payload);
        },
      }) as unknown as ChatInputCommandInteraction;

    await handleResourceCommand(interactionFor('add'), commandContext);
    await handleResourceCommand(interactionFor('get'), commandContext);
    await handleResourceCommand(interactionFor('remove'), commandContext);

    assert.match(replies[0].content, /do not have permission to add fields/i);
    assert.match(replies[1].content, /access request sent/i);
    assert.match(replies[2].content, /do not have permission to remove fields/i);
    assert.strictEqual(directRevealDmCreated, false, 'Guardian must not receive the secret value');
    assert.strictEqual(
      await repositories.resourceFields.findByResourceAndName(resourceId, 'NEW_FIELD'),
      null
    );
    assert.ok(await repositories.resourceFields.findByResourceAndName(resourceId, 'EXISTING'));
  });
});
