import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ButtonInteraction, Client } from 'discord.js';
import type { Services } from '../../domain/services.js';
import type { Repositories } from '../../domain/repositories.js';
import { createApprovalEmbed, handleApprovalButton } from './approvalButtons.js';

describe('approval buttons', () => {
  it('records APPROVE without treating the decision as reveal authority', async () => {
    let discordFetches = 0;
    let repositoryReads = 0;
    const interaction = {
      customId: 'purrmission:approve:req-1',
      user: { id: 'guardian-1' },
      message: { embeds: [createApprovalEmbed('resource', {}, null)] },
      deferUpdate: async () => {},
      editReply: async () => {},
      followUp: async () => {},
    } as unknown as ButtonInteraction;
    const services = {
      ports: {
        recordApprovalDecision: async () => ({ success: true }),
        getApprovalRequest: async () => ({
          id: 'req-1',
          resourceId: 'resource-1',
          status: 'APPROVED',
          context: {
            type: 'FIELD_ACCESS',
            requesterId: 'requester-1',
            description: 'need it',
            fieldName: 'SECRET',
          },
        }),
      },
    } as unknown as Services;
    const repositories = new Proxy(
      {},
      {
        get() {
          repositoryReads += 1;
          throw new Error('approval must not read value-bearing repositories');
        },
      }
    ) as Repositories;
    const discordClient = {
      users: {
        fetch: async () => {
          discordFetches += 1;
          throw new Error('approval must not DM or reveal to the requester');
        },
      },
    } as unknown as Client;

    await handleApprovalButton(interaction, services, repositories, discordClient);

    assert.equal(repositoryReads, 0);
    assert.equal(discordFetches, 0);
  });
});
