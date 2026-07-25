import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
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
    } as unknown as ChatInputCommandInteraction;

    const services = {
      ports: {
        recordApprovalDecision: mock.fn(async () => ({ success: true })),
        getApprovalRequest: mock.fn(async () => ({ id: 'req-123', resourceId: 'res-1' })),
      },
    } as unknown as Services;

    await execute(interaction, services);

    assert.strictEqual(
      (interaction.options.getString as unknown as ReturnType<typeof mock.fn>).mock.calls.length,
      1
    );
    assert.strictEqual(
      (services.ports.recordApprovalDecision as unknown as ReturnType<typeof mock.fn>).mock.calls
        .length,
      1
    );
    assert.deepStrictEqual(
      (services.ports.recordApprovalDecision as unknown as ReturnType<typeof mock.fn>).mock.calls[0]
        .arguments[1],
      'req-123'
    );
    assert.deepStrictEqual(
      (services.ports.recordApprovalDecision as unknown as ReturnType<typeof mock.fn>).mock.calls[0]
        .arguments[2],
      'DENY'
    );
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
    } as unknown as ChatInputCommandInteraction;

    const services = {
      ports: {
        recordApprovalDecision: mock.fn(async () => ({ success: false, error: 'Not found' })),
      },
    } as unknown as Services;

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
    } as unknown as ChatInputCommandInteraction;

    const services = {
      ports: {
        recordApprovalDecision: mock.fn(async () => {
          throw new Error('Database error');
        }),
      },
    } as unknown as Services;

    await execute(interaction, services);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.match(mockReply.mock.calls[0].arguments[0].content, /An unexpected error occurred/);
  });
});
