import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { execute } from './deny.js';

describe('Deny Command', () => {
    it('should deny a request when service returns success', async () => {
        const mockReply = mock.fn();
        const interaction = {
            options: {
                getString: mock.fn(() => 'req-123'),
            },
            user: { id: 'guardian-1' },
            reply: mockReply,
        } as any;

        const services = {
            approval: {
                recordDecision: mock.fn(async () => ({ success: true })),
            },
        } as any;

        await execute(interaction, services);

        assert.strictEqual(interaction.options.getString.mock.calls.length, 1);
        assert.strictEqual(services.approval.recordDecision.mock.calls.length, 1);
        assert.deepStrictEqual(services.approval.recordDecision.mock.calls[0].arguments, [
            'req-123',
            'DENY',
            'guardian-1',
        ]);
        assert.strictEqual(mockReply.mock.calls.length, 1);
        assert.match(mockReply.mock.calls[0].arguments[0].content, /DENIED/);
    });

    it('should handle failure from service', async () => {
        const mockReply = mock.fn();
        const interaction = {
            options: {
                getString: mock.fn(() => 'req-123'),
            },
            user: { id: 'guardian-1' },
            reply: mockReply,
        } as any;

        const services = {
            approval: {
                recordDecision: mock.fn(async () => ({ success: false, error: 'Not found' })),
            },
        } as any;

        await execute(interaction, services);

        assert.strictEqual(mockReply.mock.calls.length, 1);
        assert.match(mockReply.mock.calls[0].arguments[0].content, /Failed to deny request/);
    });

    it('should handle exceptions from service', async () => {
        const mockReply = mock.fn();
        const interaction = {
            options: {
                getString: mock.fn(() => 'req-123'),
            },
            user: { id: 'guardian-1' },
            reply: mockReply,
            replied: false,
            deferred: false,
        } as any;

        const services = {
            approval: {
                recordDecision: mock.fn(async () => { throw new Error('Database error'); }),
            },
        } as any;

        await execute(interaction, services);

        assert.strictEqual(mockReply.mock.calls.length, 1);
        assert.match(mockReply.mock.calls[0].arguments[0].content, /An unexpected error occurred/);
    });
});
