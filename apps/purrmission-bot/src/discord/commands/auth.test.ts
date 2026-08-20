import assert from 'node:assert';
import { describe, mock, test } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import { authCommand, handleAuthLogin } from './auth.js';
import type { CommandContext } from './context.js';

describe('/auth command definition', () => {
  test('accepts the full 64-bit device-flow user code', () => {
    const definition = authCommand.toJSON();
    const login = definition.options?.find((option) => option.name === 'login');
    assert.ok(login && 'options' in login);
    const code = login.options?.find((option) => option.name === 'code');

    assert.ok(code && 'max_length' in code && 'min_length' in code);
    assert.strictEqual(code.min_length, 19);
    assert.strictEqual(code.max_length, 19);
  });
});

describe('Discord Command: handleAuthLogin', () => {
  test('should reply with success when session is approved', async () => {
    const mockReply = mock.fn();
    const mockApproveSession = mock.fn(async () => true);
    const interaction = {
      options: {
        getString: mock.fn(() => 'ABCD-1234-EF56-7890'),
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
    assert.deepStrictEqual(mockApproveSession.mock.calls[0].arguments, [
      'ABCD-1234-EF56-7890',
      'user-123',
    ]);

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
