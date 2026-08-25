import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handleProjectCommand } from './project.js';
import type { CommandContext } from './context.js';
import type { Principal } from '../../domain/models.js';
import type {
  CacheType,
  ChatInputCommandInteraction,
  CommandInteractionOptionResolver,
  User,
} from 'discord.js';

describe('handleProjectCommand', () => {
  let mockInteraction: ChatInputCommandInteraction;
  let mockContext: CommandContext;
  let deferReplyCalls: Array<{ ephemeral?: boolean }> = [];
  let editReplyCalls: Array<string | { content: string; allowedMentions?: { users: string[] } }> =
    [];
  let addMemberCalls: Array<{
    principal: Principal;
    dto: { projectId: string; memberUserId: string; role: 'READER' | 'WRITER' };
  }> = [];
  let removeMemberCalls: Array<{ principal: Principal; projectId: string; memberUserId: string }> =
    [];
  let listMembersCalls: Array<{ principal: Principal; projectId: string }> = [];

  beforeEach(() => {
    deferReplyCalls = [];
    editReplyCalls = [];
    addMemberCalls = [];
    removeMemberCalls = [];
    listMembersCalls = [];

    mockInteraction = {
      id: 'interaction-999',
      user: { id: 'owner-1' } as User,
      options: {
        getSubcommandGroup: ((_required?: boolean) =>
          'member') as CommandInteractionOptionResolver['getSubcommandGroup'],
        getSubcommand: ((_required?: boolean) =>
          'add') as CommandInteractionOptionResolver['getSubcommand'],
        getString: ((name: string) => {
          if (name === 'project_id') return 'project-1';
          if (name === 'role') return 'WRITER';
          return null;
        }) as CommandInteractionOptionResolver['getString'],
        getUser: ((name: string) => {
          if (name === 'user') return { id: 'user-2' } as User;
          return null;
        }) as CommandInteractionOptionResolver['getUser'],
      } as CommandInteractionOptionResolver<CacheType>,
      deferReply: ((options?: { ephemeral?: boolean }) => {
        deferReplyCalls.push(options ?? {});
        return Promise.resolve(null as never);
      }) as ChatInputCommandInteraction['deferReply'],
      editReply: ((
        options: string | { content: string; allowedMentions?: { users: string[] } }
      ) => {
        editReplyCalls.push(options);
        return Promise.resolve(null as never);
      }) as ChatInputCommandInteraction['editReply'],
      reply: ((options: { content: string; ephemeral: boolean }) => {
        editReplyCalls.push(options);
        return Promise.resolve(null as never);
      }) as ChatInputCommandInteraction['reply'],
    } as unknown as ChatInputCommandInteraction;

    mockContext = {
      services: {
        ports: {
          getProject: async (_principal: Principal, projectId: string) => ({
            id: projectId,
            name: 'Project One',
            ownerId: 'owner-1',
            createdAt: new Date(),
          }),
          addProjectMember: async (
            principal: Principal,
            dto: { projectId: string; memberUserId: string; role: 'READER' | 'WRITER' }
          ) => {
            addMemberCalls.push({ principal, dto });
          },
          removeProjectMember: async (
            principal: Principal,
            projectId: string,
            memberUserId: string
          ) => {
            removeMemberCalls.push({ principal, projectId, memberUserId });
          },
          listProjectMembers: async (principal: Principal, projectId: string) => {
            listMembersCalls.push({ principal, projectId });
            return [
              {
                id: 'pm-1',
                projectId,
                userId: 'user-2',
                role: 'WRITER' as const,
                createdAt: new Date(),
              },
            ];
          },
        },
      },
    } as unknown as CommandContext;
  });

  it('routes /project member add to member creation', async () => {
    await handleProjectCommand(mockInteraction, mockContext);

    assert.deepStrictEqual(deferReplyCalls, [{ ephemeral: true }]);
    assert.equal(addMemberCalls.length, 1);
    assert.deepStrictEqual(addMemberCalls[0]?.dto, {
      projectId: 'project-1',
      memberUserId: 'user-2',
      role: 'WRITER',
    });
    assert.strictEqual(addMemberCalls[0]?.principal.subjectId, 'owner-1');
    assert.strictEqual(addMemberCalls[0]?.principal.authKind, 'DISCORD');
    assert.ok(
      typeof editReplyCalls[0] === 'string' &&
        editReplyCalls[0].includes('Added <@user-2> as a **WRITER**')
    );
  });

  it('routes /project member remove to member removal', async () => {
    mockInteraction.options.getSubcommand = () => 'remove';

    await handleProjectCommand(mockInteraction, mockContext);

    assert.equal(removeMemberCalls.length, 1);
    assert.strictEqual(removeMemberCalls[0]?.projectId, 'project-1');
    assert.strictEqual(removeMemberCalls[0]?.memberUserId, 'user-2');
    assert.strictEqual(removeMemberCalls[0]?.principal.subjectId, 'owner-1');
    assert.ok(
      typeof editReplyCalls[0] === 'string' &&
        editReplyCalls[0].includes('Removed <@user-2> from project **Project One**')
    );
  });

  it('routes /project member list to member listing', async () => {
    mockInteraction.options.getSubcommand = () => 'list';

    await handleProjectCommand(mockInteraction, mockContext);

    assert.equal(listMembersCalls.length, 1);
    assert.strictEqual(listMembersCalls[0]?.projectId, 'project-1');
    assert.strictEqual(listMembersCalls[0]?.principal.subjectId, 'owner-1');
    assert.deepStrictEqual(editReplyCalls[0], {
      content: '**Members of Project One:**\n- <@user-2> (WRITER)',
      allowedMentions: { users: [] },
    });
  });
});
