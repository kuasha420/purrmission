import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { handleRequestAccess } from './requestAccess.js';
import type { CommandContext } from './context.js';
import type { ChatInputCommandInteraction } from 'discord.js';

describe('handleRequestAccess', () => {
  const resourceId = 'res-123';
  const userId = 'user-456';
  const mockResource = {
    id: resourceId,
    name: 'Production Database',
    mode: 'ONE_OF_N' as const,
    createdAt: new Date(),
  };

  function createMockInteraction() {
    const mockReply = mock.fn(async () => {});
    const mockFollowUp = mock.fn(async () => {});
    const interaction = {
      id: 'interaction-123',
      options: {
        getString: mock.fn((name: string, _required?: boolean) => {
          if (name === 'resource-id') return resourceId;
          return null;
        }),
      },
      user: { id: userId },
      reply: mockReply,
      followUp: mockFollowUp,
      replied: false,
      deferred: false,
    } as unknown as ChatInputCommandInteraction;

    return { interaction, mockReply, mockFollowUp };
  }

  it('Branch 1: should reply with error when resource is not found', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => null),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockReply.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '❌ Resource not found.',
        ephemeral: true,
      }
    );
  });

  it('Branch 2a: should handle creation failure with custom error message', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({
            success: false,
            error: 'No active guardians configured for this resource',
          })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockReply.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content:
          '❌ Failed to create access request: No active guardians configured for this resource',
        ephemeral: true,
      }
    );
  });

  it('Branch 2b: should handle creation failure with missing error string (default to Unknown error)', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({
            success: false,
          })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockReply.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '❌ Failed to create access request: Unknown error',
        ephemeral: true,
      }
    );
  });

  it('Branch 2c: should handle creation response with success=true but request=undefined', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({
            success: true,
            request: undefined,
          })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockReply.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '❌ Failed to create access request: Unknown error',
        ephemeral: true,
      }
    );
  });

  it('Branch 3: should successfully create approval request via DomainPorts and notify user', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const createdRequest = {
      id: 'req-success-100',
      resourceId,
      status: 'PENDING' as const,
      context: {
        requesterId: userId,
        action: 'MANUAL_REQUEST',
        reason: `Requested via Discord command by <@${userId}>`,
      },
      createdAt: new Date(),
      expiresAt: null,
    };

    const createApprovalRequestMock = mock.fn(async () => ({
      success: true,
      request: createdRequest,
    }));

    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        ports: {
          createApprovalRequest: createApprovalRequestMock,
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    // Verify service call arguments
    assert.strictEqual(createApprovalRequestMock.mock.calls.length, 1);
    const callArgs = (
      createApprovalRequestMock.mock.calls[0] as unknown as { arguments: unknown[] }
    ).arguments;
    assert.strictEqual((callArgs[0] as { subjectId: string }).subjectId, userId);
    assert.strictEqual(callArgs[1], resourceId);
    assert.strictEqual(callArgs[2], 'MANUAL_REQUEST');
    assert.strictEqual(callArgs[3], null);
    assert.deepStrictEqual(callArgs[4], {
      reason: `Requested via Discord command by <@${userId}>`,
    });

    // Verify interaction reply
    assert.strictEqual(mockReply.mock.calls.length, 1);
    const replyArg = (
      mockReply.mock.calls[0] as unknown as {
        arguments: Array<{ content: string; ephemeral?: boolean }>;
      }
    ).arguments[0];
    assert.strictEqual(replyArg.ephemeral, true);
    assert.match(replyArg.content, /📝 \*\*Access request submitted for Production Database\*\*/);
    assert.match(replyArg.content, /Request ID: `req-success-100`/);
  });

  it('Error handling: should reply with generic error when findById throws an exception', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => {
            throw new Error('Database error');
          }),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockReply.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '❌ An unexpected error occurred while requesting access.',
        ephemeral: true,
      }
    );
  });

  it('Error handling: should reply with generic error when createApprovalRequest throws an exception', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => {
            throw new Error('Creation unexpected error');
          }),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockReply.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '❌ An unexpected error occurred while requesting access.',
        ephemeral: true,
      }
    );
  });

  it('Error handling: should call followUp when interaction is already deferred', async () => {
    const { interaction, mockReply, mockFollowUp } = createMockInteraction();
    interaction.deferred = true;
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => {
            throw new Error('Database error');
          }),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 0);
    assert.strictEqual(mockFollowUp.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockFollowUp.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '❌ An unexpected error occurred while requesting access.',
        ephemeral: true,
      }
    );
  });

  it('Error handling: should call followUp when interaction is already replied', async () => {
    const { interaction, mockReply, mockFollowUp } = createMockInteraction();
    interaction.replied = true;
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => {
            throw new Error('Database error');
          }),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 0);
    assert.strictEqual(mockFollowUp.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockFollowUp.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '❌ An unexpected error occurred while requesting access.',
        ephemeral: true,
      }
    );
  });

  it('Error handling: should catch replyError without throwing when interaction.reply throws an exception', async () => {
    const { interaction } = createMockInteraction();
    interaction.reply = mock.fn(async () => {
      throw new Error('Discord API error on reply');
    });
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => {
            throw new Error('Database error');
          }),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await assert.doesNotReject(async () => {
      await handleRequestAccess(interaction, context);
    });
  });

  it('Error handling: should catch replyError without throwing when interaction.followUp throws an exception', async () => {
    const { interaction } = createMockInteraction();
    interaction.deferred = true;
    interaction.followUp = mock.fn(async () => {
      throw new Error('Discord API error on followUp');
    });
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => {
            throw new Error('Database error');
          }),
        },
      },
      services: {
        ports: {
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await assert.doesNotReject(async () => {
      await handleRequestAccess(interaction, context);
    });
  });
});
