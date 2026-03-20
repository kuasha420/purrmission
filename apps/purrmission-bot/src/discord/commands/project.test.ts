import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handleProjectCommand } from './project.js';
import type { CommandContext } from './context.js';
import type {
  CacheType,
  ChatInputCommandInteraction,
  CommandInteractionOptionResolver,
  User,
} from 'discord.js';

interface MockProjectServices {
  project: {
    getProject: (
      projectId: string
    ) => Promise<{ id: string; name: string; ownerId: string } | null>;
    addMember: (
      projectId: string,
      targetUserId: string,
      role: 'READER' | 'WRITER',
      actorId: string
    ) => Promise<void>;
    removeMember: (projectId: string, targetUserId: string) => Promise<void>;
    getMemberRole: (projectId: string, userId: string) => Promise<'READER' | 'WRITER' | null>;
    listMembers: (
      projectId: string
    ) => Promise<Array<{ userId: string; role: 'READER' | 'WRITER' }>>;
  };
}

describe('handleProjectCommand', () => {
  let mockInteraction: ChatInputCommandInteraction;
  let mockContext: CommandContext;
  let deferReplyCalls: Array<{ ephemeral?: boolean }> = [];
  let editReplyCalls: Array<string | { content: string; allowedMentions?: { users: string[] } }> =
    [];
  let addMemberCalls: Array<{
    projectId: string;
    targetUserId: string;
    role: 'READER' | 'WRITER';
    actorId: string;
  }> = [];
  let removeMemberCalls: Array<{ projectId: string; targetUserId: string }> = [];
  let listMembersCalls: string[] = [];

  beforeEach(() => {
    deferReplyCalls = [];
    editReplyCalls = [];
    addMemberCalls = [];
    removeMemberCalls = [];
    listMembersCalls = [];

    mockInteraction = {
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
        project: {
          getProject: async (projectId: string) => ({
            id: projectId,
            name: 'Project One',
            ownerId: 'owner-1',
          }),
          addMember: async (
            projectId: string,
            targetUserId: string,
            role: 'READER' | 'WRITER',
            actorId: string
          ) => {
            addMemberCalls.push({ projectId, targetUserId, role, actorId });
          },
          removeMember: async (projectId: string, targetUserId: string) => {
            removeMemberCalls.push({ projectId, targetUserId });
          },
          getMemberRole: async (_projectId: string, _userId: string) => 'WRITER',
          listMembers: async (projectId: string) => {
            listMembersCalls.push(projectId);
            return [{ userId: 'user-2', role: 'WRITER' }];
          },
        },
      } as unknown as MockProjectServices,
    } as unknown as CommandContext;
  });

  it('routes /project member add to member creation', async () => {
    await handleProjectCommand(mockInteraction, mockContext);

    assert.deepStrictEqual(deferReplyCalls, [{ ephemeral: true }]);
    assert.deepStrictEqual(addMemberCalls, [
      {
        projectId: 'project-1',
        targetUserId: 'user-2',
        role: 'WRITER',
        actorId: 'owner-1',
      },
    ]);
    assert.ok(
      typeof editReplyCalls[0] === 'string' &&
        editReplyCalls[0].includes('Added <@user-2> as a **WRITER**')
    );
  });

  it('routes /project member remove to member removal', async () => {
    mockInteraction.options.getSubcommand = () => 'remove';

    await handleProjectCommand(mockInteraction, mockContext);

    assert.deepStrictEqual(removeMemberCalls, [{ projectId: 'project-1', targetUserId: 'user-2' }]);
    assert.ok(
      typeof editReplyCalls[0] === 'string' &&
        editReplyCalls[0].includes('Removed <@user-2> from project **Project One**')
    );
  });

  it('routes /project member list to member listing', async () => {
    mockInteraction.options.getSubcommand = () => 'list';

    await handleProjectCommand(mockInteraction, mockContext);

    assert.deepStrictEqual(listMembersCalls, ['project-1']);
    assert.deepStrictEqual(editReplyCalls[0], {
      content: '**Members of Project One:**\n- <@user-2> (WRITER)',
      allowedMentions: { users: [] },
    });
  });
});
