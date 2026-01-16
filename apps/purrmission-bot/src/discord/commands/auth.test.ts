import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { handleAuthLogin } from './auth.js';
import { ChatInputCommandInteraction } from 'discord.js';
import { CommandContext } from './context.js';

describe('Discord Command: handleAuthLogin', () => {
    let mockInteraction: any;
    let mockContext: any;

    beforeEach(() => {
        mockInteraction = {
            options: {
                getString: mock.fn(),
            },
            user: {
                id: 'user-123',
            },
            reply: mock.fn(),
        };

        mockContext = {
            services: {
                auth: {
                    approveSession: mock.fn(),
                },
            },
        };
    });

    test('should reply with success when session is approved', async () => {
        // Redefine methods with implementations
        mockInteraction.options.getString = mock.fn(() => 'ABCD-1234');
        mockContext.services.auth.approveSession = mock.fn(async () => true);

        await handleAuthLogin(mockInteraction as ChatInputCommandInteraction, mockContext as CommandContext);

        assert.strictEqual(mockContext.services.auth.approveSession.mock.callCount(), 1);
        assert.deepStrictEqual(mockContext.services.auth.approveSession.mock.calls[0].arguments, ['ABCD-1234', 'user-123']);

        assert.strictEqual(mockInteraction.reply.mock.callCount(), 1);
        const replyArg = mockInteraction.reply.mock.calls[0].arguments[0];
        assert.ok(replyArg.content.includes('Successfully authenticated'));
    });

    test('should reply with error when session is not approved', async () => {
        mockInteraction.options.getString = mock.fn(() => 'INVALID');
        mockContext.services.auth.approveSession = mock.fn(async () => false);

        await handleAuthLogin(mockInteraction as ChatInputCommandInteraction, mockContext as CommandContext);

        assert.strictEqual(mockInteraction.reply.mock.callCount(), 1);
        const replyArg = mockInteraction.reply.mock.calls[0].arguments[0];
        assert.ok(replyArg.content.includes('Failed to approve session'));
    });

    test('should handle internal errors gracefully', async () => {
        mockInteraction.options.getString = mock.fn(() => 'ERROR');
        mockContext.services.auth.approveSession = mock.fn(async () => { throw new Error('Internal Boom'); });

        await handleAuthLogin(mockInteraction as ChatInputCommandInteraction, mockContext as CommandContext);

        assert.strictEqual(mockInteraction.reply.mock.callCount(), 1);
        const replyArg = mockInteraction.reply.mock.calls[0].arguments[0];
        assert.ok(replyArg.content.includes('internal error occurred'));
    });
});
