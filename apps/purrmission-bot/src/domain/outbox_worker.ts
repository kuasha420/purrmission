import type { Client } from 'discord.js';
import { Repositories } from './repositories.js';
import { SSRFSafeWebhookClient } from './webhook.js';
import { logger } from '../logging/logger.js';

export class OutboxWorker {
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly repos: Repositories,
    private readonly discordClient?: Client,
    private readonly maxAttempts = 5
  ) {}

  start(intervalMs = 3000): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.processEvents(), intervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async processEvents(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const pending = await this.repos.outbox.findPending();
      for (const event of pending) {
        try {
          await this.processEvent(event);
        } catch (err: any) {
          const nextAttempts = event.attempts + 1;
          const status = nextAttempts >= this.maxAttempts ? 'FAILED' : 'PENDING';
          await this.repos.outbox.updateStatus(event.id, status, nextAttempts, err.message);
          logger.error('Failed to process outbox event', {
            eventId: event.id,
            eventType: event.eventType,
            attempts: nextAttempts,
            status,
            error: err.message,
          });
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processEvent(event: any): Promise<void> {
    // 1. Calculate exponential backoff delay (2^attempts seconds)
    if (event.attempts > 0) {
      const delayMs = Math.pow(2, event.attempts) * 1000;
      const elapsedMs = Date.now() - new Date(event.updatedAt || event.createdAt).getTime();
      if (elapsedMs < delayMs) {
        // Skip for now, wait for backoff window
        return;
      }
    }

    // 2. Dispatch event based on type
    if (event.eventType === 'REQUEST_CREATED') {
      await this.handleRequestCreated(event.payload);
    } else if (event.eventType === 'APPROVAL_CALLBACK') {
      await this.handleApprovalCallback(event.payload);
    } else {
      throw new Error(`Unknown outbox event type: ${event.eventType}`);
    }

    // 3. Mark processed on success
    await this.repos.outbox.updateStatus(event.id, 'PROCESSED', event.attempts + 1);
  }

  private async handleRequestCreated(payload: any): Promise<void> {
    const { requestId, resourceId } = payload;

    if (!this.discordClient) {
      logger.warn('Skipping Discord notification: Discord client not available');
      return;
    }

    const request = await this.repos.approvalRequests.findById(requestId);
    if (!request) throw new Error(`ApprovalRequest not found: ${requestId}`);

    const guardians = await this.repos.guardians.findByResourceId(resourceId);
    if (guardians.length === 0) {
      throw new Error('No guardians registered to receive notification');
    }

    // DM the owner/first guardian
    const owner = guardians.find((g) => g.role === 'OWNER') ?? guardians[0];
    const user = await this.discordClient.users.fetch(owner.discordUserId);
    const dm = await user.createDM();

    // Mention remaining guardians
    const mentions = guardians
      .filter((g) => g.discordUserId !== owner.discordUserId)
      .map((g) => `<@${g.discordUserId}>`)
      .join(' ');

    const content = mentions.length > 0 ? `Guardians: ${mentions}` : '🔐 Approval request created';

    const sentMsg = await dm.send({
      content,
    });

    // Update message reference inside transaction
    await this.repos.approvalRequests.update(requestId, {
      status: request.status,
      discordMessageId: sentMsg.id,
      discordChannelId: sentMsg.channelId,
    });

    logger.info('Outbox worker delivered Guardian notification', {
      requestId,
      messageId: sentMsg.id,
    });
  }

  private async handleApprovalCallback(payload: any): Promise<void> {
    const { requestId, status } = payload;

    const request = await this.repos.approvalRequests.findById(requestId);
    if (!request) throw new Error(`ApprovalRequest not found: ${requestId}`);

    // Load registered callback destinations
    const destinations = await this.repos.callbackDestinations.findByResourceId(request.resourceId);
    const enabledDests = destinations.filter((d) => d.enabled);

    if (enabledDests.length === 0) {
      logger.info('No registered callback destinations for resource', {
        resourceId: request.resourceId,
      });
      return;
    }

    for (const dest of enabledDests) {
      logger.info('Worker executing secure webhook delivery', { url: dest.url, requestId });

      // Trigger SSRF-safe HTTP POST request
      await SSRFSafeWebhookClient.send(dest.url, dest.secret, {
        eventType: 'APPROVAL_CALLBACK',
        requestId,
        resourceId: request.resourceId,
        status,
        targetVersion: request.targetVersion,
      });
    }
  }
}
