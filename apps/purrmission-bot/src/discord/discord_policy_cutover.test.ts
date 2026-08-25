import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from './commands/context.js';
import { handleResourceCommand } from './commands/resource.js';
import { handleDecisionCommand } from './commands/decision.js';
import { handleApprovalButton } from './interactions/approvalButtons.js';
import { createInMemoryRepositories } from '../domain/repositories.mock.js';
import type { Principal } from '../domain/models.js';
import type { Services } from '../domain/services.js';
import type { Repositories } from '../domain/repositories.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RecordedCreateApprovalRequestArgs {
  principal: Principal;
  resourceId: string;
  action: string;
  targetKey: string | null;
  options?: {
    reason?: string;
    constraints?: Record<string, unknown> | null;
    expiresInMs?: number;
  };
  correlationId?: string;
}

interface RecordedDecisionArgs {
  principal: Principal;
  requestId: string;
  decision: string;
  consentId?: string;
  correlationId?: string;
}

describe('Discord Policy & DomainPorts Cutover Verification', () => {
  it('Static Reachability: proves legacy authorization functions are unreachable from discord/', () => {
    const discordDir = path.resolve(__dirname, '.');
    const forbiddenPatterns = [
      /\bcheckAccessPolicy\b/,
      /\bgetEffectiveGuardians\b/,
      /\bisEffectiveGuardian\b/,
      /\bisEffectiveOwner\b/,
      /\bgetGuardedResourcesForUser\b/,
    ];

    function scanDir(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...scanDir(fullPath));
        } else if (
          (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) &&
          !entry.name.includes('discord_policy_cutover.test.ts')
        ) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const allDiscordFiles = scanDir(discordDir);
    assert.ok(allDiscordFiles.length > 5, 'Should have scanned discord directory files');

    const violations: Array<{ file: string; pattern: string }> = [];

    for (const file of allDiscordFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          violations.push({ file, pattern: pattern.toString() });
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found forbidden legacy authorization helper references in discord layer: ${JSON.stringify(violations, null, 2)}`
    );
  });

  it('Field Access Request: emits outbox approval request via DomainPorts without synchronous guardian DMs', async () => {
    let dmCreated = false;
    let portsCreateApprovalRequestCalled = false;
    let recordedArgs: RecordedCreateApprovalRequestArgs | null = null;

    const repositories = createInMemoryRepositories();
    const createdResource = await repositories.resources.create({
      name: 'Prod Res',
      mode: 'ONE_OF_N',
    });
    await repositories.resourceFields.create({
      resourceId: createdResource.id,
      name: 'DATABASE_URL',
      value: 'encrypted-secret',
    });

    const mockReply = mock.fn(async () => {});
    const interaction = {
      id: 'interaction-corr-1',
      options: {
        getSubcommandGroup: () => 'fields',
        getSubcommand: () => 'get',
        getString: (name: string) => {
          if (name === 'resource-id') return createdResource.id;
          if (name === 'name') return 'DATABASE_URL';
          return null;
        },
      },
      user: {
        id: 'requester-user-1',
        createDM: async () => {
          dmCreated = true;
          return { send: async () => {} };
        },
      },
      reply: mockReply,
    } as unknown as ChatInputCommandInteraction;

    const context = {
      repositories,
      services: {
        ports: {
          createApprovalRequest: async (
            principal: Principal,
            resourceId: string,
            action: string,
            targetKey: string | null,
            options?: {
              reason?: string;
              constraints?: Record<string, unknown> | null;
              expiresInMs?: number;
            },
            correlationId?: string
          ) => {
            portsCreateApprovalRequestCalled = true;
            recordedArgs = { principal, resourceId, action, targetKey, options, correlationId };
            return {
              success: true,
              request: {
                id: 'req-outbox-123',
                resourceId,
                status: 'PENDING',
                context: {},
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 900000),
              },
            };
          },
        },
      },
    } as unknown as CommandContext;

    await handleResourceCommand(interaction, context);

    assert.equal(dmCreated, false, 'Must NOT directly DM anyone during approval creation');
    assert.equal(
      portsCreateApprovalRequestCalled,
      true,
      'Must call services.ports.createApprovalRequest'
    );
    if (!recordedArgs) {
      throw new Error('recordedArgs is null');
    }
    const finalArgs: RecordedCreateApprovalRequestArgs = recordedArgs;
    assert.equal(finalArgs.principal.subjectId, 'requester-user-1');
    assert.equal(finalArgs.principal.authKind, 'DISCORD');
    assert.equal(finalArgs.resourceId, createdResource.id);
    assert.equal(finalArgs.action, 'FIELD_ACCESS');
    assert.equal(finalArgs.targetKey, 'DATABASE_URL');
    assert.equal(finalArgs.correlationId, 'interaction-corr-1');

    assert.equal(mockReply.mock.calls.length, 1);
    const firstCall = mockReply.mock.calls[0] as unknown as { arguments: [{ content: string }] };
    const replyContent = firstCall.arguments[0].content;
    assert.match(replyContent, /Access request sent/);
    assert.match(replyContent, /req-outbox-123/);
  });

  it('2FA Code Access Request: emits outbox approval request via DomainPorts without synchronous guardian DMs', async () => {
    let dmCreated = false;
    let portsCreateApprovalRequestCalled = false;
    let recordedArgs: RecordedCreateApprovalRequestArgs | null = null;

    const repositories = createInMemoryRepositories();
    const createdResource = await repositories.resources.create({
      name: 'Prod TOTP Res',
      mode: 'ONE_OF_N',
    });

    const mockReply = mock.fn(async () => {});
    const interaction = {
      id: 'interaction-corr-2',
      options: {
        getSubcommandGroup: () => '2fa',
        getSubcommand: () => 'get',
        getString: (name: string) => {
          if (name === 'resource-id') return createdResource.id;
          return null;
        },
      },
      user: {
        id: 'requester-user-2',
        createDM: async () => {
          dmCreated = true;
          return { send: async () => {} };
        },
      },
      reply: mockReply,
    } as unknown as ChatInputCommandInteraction;

    const context = {
      repositories,
      services: {
        resource: {
          hasLinkedTOTP: async () => true,
        },
        ports: {
          createApprovalRequest: async (
            principal: Principal,
            resourceId: string,
            action: string,
            targetKey: string | null,
            options?: {
              reason?: string;
              constraints?: Record<string, unknown> | null;
              expiresInMs?: number;
            },
            correlationId?: string
          ) => {
            portsCreateApprovalRequestCalled = true;
            recordedArgs = { principal, resourceId, action, targetKey, options, correlationId };
            return {
              success: true,
              request: {
                id: 'req-totp-999',
                resourceId,
                status: 'PENDING',
                context: {},
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 300000),
              },
            };
          },
        },
      },
    } as unknown as CommandContext;

    await handleResourceCommand(interaction, context);

    assert.equal(dmCreated, false, 'Must NOT directly DM anyone during 2FA approval creation');
    assert.equal(
      portsCreateApprovalRequestCalled,
      true,
      'Must call services.ports.createApprovalRequest'
    );
    if (!recordedArgs) {
      throw new Error('recordedArgs is null');
    }
    const finalArgs: RecordedCreateApprovalRequestArgs = recordedArgs;
    assert.equal(finalArgs.principal.subjectId, 'requester-user-2');
    assert.equal(finalArgs.resourceId, createdResource.id);
    assert.equal(finalArgs.action, 'TOTP_ACCESS');
    assert.equal(finalArgs.correlationId, 'interaction-corr-2');

    assert.equal(mockReply.mock.calls.length, 1);
    const firstCall = mockReply.mock.calls[0] as unknown as { arguments: [{ content: string }] };
    const replyContent = firstCall.arguments[0].content;
    assert.match(replyContent, /Access request sent/);
    assert.match(replyContent, /req-totp-999/);
  });

  it('Decision Parity: slash /access approve and button interaction both execute recordApprovalDecision with correlationId', async () => {
    const slashRecorded: RecordedDecisionArgs[] = [];
    const buttonRecorded: RecordedDecisionArgs[] = [];

    const mockSlashReply = mock.fn(async () => {});
    const slashInteraction = {
      id: 'slash-corr-1',
      options: {
        getString: (name: string) => {
          if (name === 'request-id') return 'req-parity-1';
          return null;
        },
      },
      user: { id: 'guardian-user-1' },
      reply: mockSlashReply,
      client: { channels: { fetch: async () => null } },
    } as unknown as ChatInputCommandInteraction;

    const slashServices = {
      ports: {
        recordApprovalDecision: async (
          principal: Principal,
          requestId: string,
          decision: string,
          consentId?: string,
          correlationId?: string
        ) => {
          slashRecorded.push({ principal, requestId, decision, consentId, correlationId });
          return { success: true };
        },
        getApprovalRequest: async () => null,
      },
    } as unknown as Services;

    await handleDecisionCommand(slashInteraction, slashServices, 'APPROVE');

    const buttonInteraction = {
      id: 'button-corr-1',
      customId: 'purrmission:approve:req-parity-1',
      user: { id: 'guardian-user-1' },
      message: { embeds: [] },
      deferUpdate: async () => {},
      editReply: async () => {},
      followUp: async () => {},
    } as unknown as Parameters<typeof handleApprovalButton>[0];

    const buttonServices = {
      ports: {
        recordApprovalDecision: async (
          principal: Principal,
          requestId: string,
          decision: string,
          consentId?: string,
          correlationId?: string
        ) => {
          buttonRecorded.push({ principal, requestId, decision, consentId, correlationId });
          return { success: true };
        },
        getApprovalRequest: async () => null,
      },
    } as unknown as Services;

    const dummyRepositories = {} as unknown as Repositories;
    const dummyClient = {} as unknown as Parameters<typeof handleApprovalButton>[3];

    await handleApprovalButton(buttonInteraction, buttonServices, dummyRepositories, dummyClient);

    assert.equal(slashRecorded.length, 1);
    assert.equal(buttonRecorded.length, 1);
    assert.equal(slashRecorded[0]?.requestId, 'req-parity-1');
    assert.equal(buttonRecorded[0]?.requestId, 'req-parity-1');
    assert.equal(slashRecorded[0]?.decision, 'APPROVE');
    assert.equal(buttonRecorded[0]?.decision, 'APPROVE');
    assert.equal(slashRecorded[0]?.correlationId, 'slash-corr-1');
    assert.equal(buttonRecorded[0]?.correlationId, 'button-corr-1');
  });
});
