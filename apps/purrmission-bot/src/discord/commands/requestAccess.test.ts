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
    apiKey: 'key-123',
    createdAt: new Date(),
  };

  function createMockInteraction() {
    const mockReply = mock.fn(async () => {});
    const mockFollowUp = mock.fn(async () => {});
    const interaction = {
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
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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

  it('Branch 2: should reply that user is already authorized if they are an owner/guardian', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => true),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockReply.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '✅ You are already authorized for **Production Database**. No approval needed.',
        ephemeral: true,
      }
    );
  });

  it('Branch 3a: should reply with notice if a pending approval request already exists', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const existingApproval = {
      id: 'req-789',
      resourceId,
      status: 'PENDING' as const,
      context: {},
      createdAt: new Date(),
      expiresAt: null,
    };

    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => existingApproval),
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    const replyArg = (
      mockReply.mock.calls[0] as unknown as {
        arguments: Array<{ content: string; ephemeral?: boolean }>;
      }
    ).arguments[0];
    assert.strictEqual(replyArg.ephemeral, true);
    assert.match(
      replyArg.content,
      /⏳ You already have a pending access request for \*\*Production Database\*\*/
    );
    assert.match(replyArg.content, /Request ID: `req-789`/);
  });

  it('Branch 3b: should proceed to create a new request if previous approval is EXPIRED (not PENDING)', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const expiredApproval = {
      id: 'req-expired',
      resourceId,
      status: 'EXPIRED' as const,
      context: {},
      createdAt: new Date(Date.now() - 20000),
      expiresAt: new Date(Date.now() - 10000),
    };
    const createdRequest = {
      id: 'req-new',
      resourceId,
      status: 'PENDING' as const,
      context: {},
      createdAt: new Date(),
      expiresAt: null,
    };

    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => expiredApproval),
          createApprovalRequest: mock.fn(async () => ({
            success: true,
            request: createdRequest,
          })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.match(
      (mockReply.mock.calls[0] as unknown as { arguments: Array<{ content: string }> }).arguments[0]
        .content,
      /📝 \*\*Access request submitted for Production Database\*\*/
    );
  });

  it('Branch 4a: should handle creation failure with custom error message', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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

  it('Branch 4b: should handle creation failure with missing error string (default to Unknown error)', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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

  it('Branch 4c: should handle creation response with success=true but request=undefined', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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

  it('Branch 5: should successfully create approval request and notify user', async () => {
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
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
          createApprovalRequest: createApprovalRequestMock,
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    // Verify service call arguments
    assert.strictEqual(createApprovalRequestMock.mock.calls.length, 1);
    assert.deepStrictEqual(
      (createApprovalRequestMock.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        resourceId,
        context: {
          requesterId: userId,
          action: 'MANUAL_REQUEST',
          reason: `Requested via Discord command by <@${userId}>`,
        },
      }
    );

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

  it('Branch 3c: should reply with notice if an approved access request already exists', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const approvedApproval = {
      id: 'req-approved-123',
      resourceId,
      status: 'APPROVED' as const,
      context: {},
      createdAt: new Date(),
      expiresAt: null,
    };

    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => approvedApproval),
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await handleRequestAccess(interaction, context);

    assert.strictEqual(mockReply.mock.calls.length, 1);
    assert.deepStrictEqual(
      (mockReply.mock.calls[0] as unknown as { arguments: unknown[] }).arguments[0],
      {
        content: '✅ You already have an approved access request for **Production Database**.',
        ephemeral: true,
      }
    );
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
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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

  it('Error handling: should reply with generic error when isGuardian throws an exception', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => {
            throw new Error('Resource service failure');
          }),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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

  it('Error handling: should reply with generic error when findActiveApproval throws an exception', async () => {
    const { interaction, mockReply } = createMockInteraction();
    const context = {
      repositories: {
        resources: {
          findById: mock.fn(async () => mockResource),
        },
      },
      services: {
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => {
            throw new Error('Approval query failed');
          }),
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
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
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
        resource: {
          isGuardian: mock.fn(async () => false),
        },
        approval: {
          findActiveApproval: mock.fn(async () => null),
          createApprovalRequest: mock.fn(async () => ({ success: true })),
        },
      },
    } as unknown as CommandContext;

    await assert.doesNotReject(async () => {
      await handleRequestAccess(interaction, context);
    });
  });
});
