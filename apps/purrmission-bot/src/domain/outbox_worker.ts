import type { Client } from 'discord.js';
import { Repositories } from './repositories.js';
import { SSRFSafeWebhookClient } from './webhook.js';
import { logger } from '../logging/logger.js';
import { AuditService, verifyOutboxIntegrity } from './audit.js';
import type { OutboxEvent } from './models.js';
import { correlationStorage } from '../logging/correlationContext.js';

class OutboxIntegrityError extends Error {
  constructor() {
    super('Outbox envelope integrity verification failed.');
    this.name = 'OutboxIntegrityError';
  }
}

class DeliverySideEffectError extends Error {
  constructor(readonly safeCode: string) {
    super('Delivery side effect requires operator reconciliation.');
    this.name = 'DeliverySideEffectError';
  }
}

function requirePayloadString(payload: OutboxEvent['payload'], key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Outbox payload is missing required string field: ${key}`);
  }
  return value;
}

export class OutboxWorker {
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly repos: Repositories,
    private readonly audit: AuditService,
    private readonly discordClient?: Client,
    private readonly maxAttempts = 5
  ) {
    if (!audit) throw new TypeError('OutboxWorker requires an audit dependency.');
  }

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
        await correlationStorage.run(
          {
            correlationId: event.correlationId,
            causationId: event.id,
            surface: 'WORKER',
            operation: `delivery.${event.eventType.toLowerCase()}`,
          },
          async () => {
            const attempt = event.attempts + 1;
            try {
              await this.processEvent(event, attempt);
            } catch (err: unknown) {
              const status =
                err instanceof DeliverySideEffectError || attempt >= this.maxAttempts
                  ? 'FAILED'
                  : 'PENDING';
              const errorCode =
                err instanceof DeliverySideEffectError
                  ? err.safeCode
                  : err instanceof Error
                    ? err.name
                    : 'UNKNOWN_DELIVERY_ERROR';
              await this.audit.log({
                eventFamily: 'DELIVERY',
                eventType: 'DELIVERY_OUTCOME',
                surface: 'WORKER',
                operation: 'delivery.outcome',
                outcomeCode: 'FAILURE',
                decisionCode: 'ALLOW',
                reasonCode: 'SERVICE',
                authoritySources: ['SCOPED_CREDENTIAL'],
                targetType: 'DELIVERY',
                targetId: event.id,
                actorType: 'SERVICE',
                principalId: 'service:outbox-worker',
                actorId: 'outbox-worker',
                authKind: 'SERVICE',
                resourceId: event.resourceId,
                requestId: event.requestId,
                payload: { attempt, errorCode, terminal: status === 'FAILED' },
              });
              await this.repos.outbox.updateStatus(event.id, status, attempt, errorCode);
              logger.error('Failed to process outbox event', {
                eventId: event.id,
                eventType: event.eventType,
                attempts: attempt,
                status,
                errorType: errorCode,
              });
            }
          }
        );
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processEvent(event: OutboxEvent, attempt: number): Promise<void> {
    // 1. Calculate exponential backoff delay (2^attempts seconds)
    if (event.attempts > 0) {
      const delayMs = Math.pow(2, event.attempts) * 1000;
      const elapsedMs = Date.now() - new Date(event.updatedAt || event.createdAt).getTime();
      if (elapsedMs < delayMs) {
        // Skip for now, wait for backoff window
        return;
      }
    }

    if (!verifyOutboxIntegrity(event)) {
      throw new OutboxIntegrityError();
    }

    await this.audit.log({
      eventFamily: 'DELIVERY',
      eventType: 'DELIVERY_ATTEMPT',
      surface: 'WORKER',
      operation: 'delivery.attempt',
      outcomeCode: 'SUCCESS',
      decisionCode: 'ALLOW',
      reasonCode: 'SERVICE',
      authoritySources: ['SCOPED_CREDENTIAL'],
      targetType: 'DELIVERY',
      targetId: event.id,
      actorType: 'SERVICE',
      principalId: 'service:outbox-worker',
      actorId: 'outbox-worker',
      authKind: 'SERVICE',
      resourceId: event.resourceId,
      requestId: event.requestId,
      payload: { attempt, deliveryType: event.eventType },
    });

    // Enter a durable non-redelivery state before any external side effect. A crash or ambiguous
    // network result is reconciled by #123 and is never returned to the normal pending queue.
    await this.repos.outbox.updateStatus(
      event.id,
      'DELIVERY_IN_PROGRESS',
      attempt,
      'DELIVERY_RECONCILIATION_REQUIRED'
    );

    // 2. Dispatch event based on type
    let result: 'DELIVERED' | 'NOOP';
    try {
      if (event.eventType === 'REQUEST_CREATED') {
        result = await this.handleRequestCreated(event.payload);
      } else if (event.eventType === 'APPROVAL_CALLBACK') {
        result = await this.handleApprovalCallback(event.payload);
      } else {
        throw new Error(`Unknown outbox event type: ${event.eventType}`);
      }

      await this.repos.outbox.updateStatus(
        event.id,
        'DELIVERED_PENDING_AUDIT',
        attempt,
        'OUTCOME_AUDIT_PENDING'
      );
    } catch (error) {
      throw new DeliverySideEffectError(error instanceof Error ? error.name : 'DELIVERY_UNKNOWN');
    }

    try {
      await this.audit.log({
        eventFamily: 'DELIVERY',
        eventType: 'DELIVERY_OUTCOME',
        surface: 'WORKER',
        operation: 'delivery.outcome',
        outcomeCode: result === 'DELIVERED' ? 'SUCCESS' : 'NOOP',
        decisionCode: 'ALLOW',
        reasonCode: 'SERVICE',
        authoritySources: ['SCOPED_CREDENTIAL'],
        targetType: 'DELIVERY',
        targetId: event.id,
        actorType: 'SERVICE',
        principalId: 'service:outbox-worker',
        actorId: 'outbox-worker',
        authKind: 'SERVICE',
        resourceId: event.resourceId,
        requestId: event.requestId,
        payload: { attempt, deliveryType: event.eventType, result },
      });
    } catch (error) {
      logger.error('Delivery completed but outcome audit is pending operator reconciliation', {
        eventId: event.id,
        eventType: event.eventType,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return;
    }

    // 3. Mark processed only after the delivery outcome is durable.
    await this.repos.outbox.updateStatus(event.id, 'PROCESSED', attempt);
  }

  private async handleRequestCreated(
    payload: OutboxEvent['payload']
  ): Promise<'DELIVERED' | 'NOOP'> {
    const requestId = requirePayloadString(payload, 'requestId');
    const resourceId = requirePayloadString(payload, 'resourceId');

    if (!this.discordClient) {
      logger.warn('Skipping Discord notification: Discord client not available');
      return 'NOOP';
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
    if (!this.repos.approvalRequests.updateDeliveryReference) {
      throw new Error('Approval request repository lacks delivery-reference persistence.');
    }
    await this.repos.approvalRequests.updateDeliveryReference(
      requestId,
      sentMsg.id,
      sentMsg.channelId
    );

    logger.info('Outbox worker delivered Guardian notification', {
      requestId,
      messageId: sentMsg.id,
    });
    return 'DELIVERED';
  }

  private async handleApprovalCallback(
    payload: OutboxEvent['payload']
  ): Promise<'DELIVERED' | 'NOOP'> {
    const requestId = requirePayloadString(payload, 'requestId');
    const status = requirePayloadString(payload, 'status');

    const request = await this.repos.approvalRequests.findById(requestId);
    if (!request) throw new Error(`ApprovalRequest not found: ${requestId}`);

    // Load registered callback destinations
    const destinations = await this.repos.callbackDestinations.findByResourceId(request.resourceId);
    const enabledDests = destinations.filter((d) => d.enabled);

    if (enabledDests.length === 0) {
      logger.info('No registered callback destinations for resource', {
        resourceId: request.resourceId,
      });
      return 'NOOP';
    }

    for (const dest of enabledDests) {
      logger.info('Worker executing secure webhook delivery', {
        destinationId: dest.id,
        requestId,
      });

      // Trigger SSRF-safe HTTP POST request
      await SSRFSafeWebhookClient.send(dest.url, dest.secret, {
        eventType: 'APPROVAL_CALLBACK',
        requestId,
        resourceId: request.resourceId,
        status,
        targetVersion: request.targetVersion,
      });
    }
    return 'DELIVERED';
  }
}
