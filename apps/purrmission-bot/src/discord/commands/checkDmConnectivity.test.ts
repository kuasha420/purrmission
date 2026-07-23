import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handleCheckDmConnectivityCommand } from './checkDmConnectivity.js';
import type { ChatInputCommandInteraction } from 'discord.js';

describe('handleCheckDmConnectivityCommand', () => {
  let mockInteraction: ChatInputCommandInteraction;
  let replyCalls: unknown[] = [];
  let editReplyCalls: unknown[] = [];
  let sendCalls: unknown[] = [];
  let shouldFailDM = false;

  beforeEach(() => {
    replyCalls = [];
    editReplyCalls = [];
    sendCalls = [];
    shouldFailDM = false;

    mockInteraction = {
      user: {
        id: 'test-user-id',
        createDM: async () => {
          if (shouldFailDM) {
            throw new Error('Cannot send messages to this user');
          }
          return {
            send: async (payload: unknown) => {
              sendCalls.push(payload);
              return {};
            },
          };
        },
      },
      deferReply: async (options: unknown) => {
        replyCalls.push(options);
        return {};
      },
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
        return {};
      },
    } as unknown as ChatInputCommandInteraction;
  });

  it('should send test DM and reply with success message', async () => {
    await handleCheckDmConnectivityCommand(mockInteraction);

    // Verify reply deferred ephemerally
    assert.strictEqual(replyCalls.length, 1);
    assert.deepStrictEqual(replyCalls[0], { ephemeral: true });

    // Verify test DM was sent
    assert.strictEqual(sendCalls.length, 1);
    assert.ok((sendCalls[0] as { content: string }).content.includes('Connectivity Test'));

    // Verify slash command response indicates success
    assert.strictEqual(editReplyCalls.length, 1);
    assert.ok((editReplyCalls[0] as { content: string }).content.includes('Succeeded'));
  });

  it('should reply with troubleshooting instructions on DM failure', async () => {
    shouldFailDM = true;

    await handleCheckDmConnectivityCommand(mockInteraction);

    // Verify reply deferred ephemerally
    assert.strictEqual(replyCalls.length, 1);
    assert.deepStrictEqual(replyCalls[0], { ephemeral: true });

    // Verify no test DM was sent
    assert.strictEqual(sendCalls.length, 0);

    // Verify slash command response contains troubleshooting guide
    assert.strictEqual(editReplyCalls.length, 1);
    assert.ok((editReplyCalls[0] as { content: string }).content.includes('Failed'));
    assert.ok((editReplyCalls[0] as { content: string }).content.includes('Allow direct messages'));
  });
});
