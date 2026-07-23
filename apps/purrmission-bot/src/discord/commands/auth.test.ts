import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import { handleAuthLogin } from './auth.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from './context.js';

describe('Discord Command: handleAuthLogin', () => {
  test('should reply with success when session is approved', async () => {
    const mockReply = mock.fn();
    const mockApproveSession = mock.fn(async () => true);
    const interaction = {
      options: {
        getString: mock.fn(() => 'ABCD-1234'),
      },
      user: {
        id: 'user-123',
      },
      reply: mockReply,
    };

    const context = {
      services: {
        auth: {
          approveSession: mockApproveSession,
        },
      },
    };

    await handleAuthLogin(
      interaction as unknown as ChatInputCommandInteraction,
      context as unknown as CommandContext
    );

    assert.strictEqual(mockApproveSession.mock.callCount(), 1);
    assert.deepStrictEqual(mockApproveSession.mock.calls[0].arguments, ['ABCD-1234', 'user-123']);

    assert.strictEqual(mockReply.mock.callCount(), 1);
    const replyArg = mockReply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('Successfully authenticated'));
  });

  test('should reply with error when session is not approved', async () => {
    const mockReply = mock.fn();
    const interaction = {
      options: {
        getString: mock.fn(() => 'INVALID'),
      },
      user: {
        id: 'user-123',
      },
      reply: mockReply,
    };

    const context = {
      services: {
        auth: {
          approveSession: mock.fn(async () => false),
        },
      },
    };

    await handleAuthLogin(
      interaction as unknown as ChatInputCommandInteraction,
      context as unknown as CommandContext
    );

    assert.strictEqual(mockReply.mock.callCount(), 1);
    const replyArg = mockReply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('Failed to approve session'));
  });

  test('should handle internal errors gracefully', async () => {
    const mockReply = mock.fn();
    const interaction = {
      options: {
        getString: mock.fn(() => 'ERROR'),
      },
      user: {
        id: 'user-123',
      },
      reply: mockReply,
    };

    const context = {
      services: {
        auth: {
          approveSession: mock.fn(async () => {
            throw new Error('Internal Boom');
          }),
        },
      },
    };

    await handleAuthLogin(
      interaction as unknown as ChatInputCommandInteraction,
      context as unknown as CommandContext
    );

    assert.strictEqual(mockReply.mock.callCount(), 1);
    const replyArg = mockReply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('internal error occurred'));
  });
});
