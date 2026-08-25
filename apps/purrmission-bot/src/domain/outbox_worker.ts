import type { Client } from 'discord.js';
import crypto from 'node:crypto';
import { Repositories } from './repositories.js';
import { SSRFSafeWebhookClient } from './webhook.js';
import { logger } from '../logging/logger.js';
import { AuditService, verifyOutboxIntegrity } from './audit.js';
import type { OutboxEvent } from './models.js';
import { correlationStorage } from '../logging/correlationContext.js';
import { decryptValue } from '../infra/crypto.js';
import { hasCapability } from './policy.js';
import { createDiscordPrincipal } from './principal.js';

export class OutboxIntegrityError extends Error {
  constructor() {
    super('Outbox envelope integrity verification failed.');
    this.name = 'OutboxIntegrityError';
  }
}

export class DeliverySideEffectError extends Error {
  constructor(readonly safeCode: string) {
    super(`Delivery side effect requires operator reconciliation: ${safeCode}`);
    this.name = 'DeliverySideEffectError';
  }
}

export class DiscordClientUnavailableError extends Error {
  constructor() {
    super('Discord client is unavailable or not connected.');
    this.name = 'DiscordClientUnavailableError';
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
  readonly workerId: string;

  constructor(
    private readonly repos: Repositories,
    private readonly audit: AuditService,
    private readonly discordClient?: Client,
    private readonly maxAttempts = 5,
    private readonly leaseDurationMs = 30000,
    private readonly batchSize = 20
  ) {
    if (!audit) throw new TypeError('OutboxWorker requires an audit dependency.');
    this.workerId = `worker:${crypto.randomUUID()}`;
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

  async processEvents(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    let processedCount = 0;
    try {
      const claimed = await this.repos.outbox.claimEvents(
        this.workerId,
        this.batchSize,
        this.leaseDurationMs
      );

      for (const event of claimed) {
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
              processedCount++;
            } catch (err: unknown) {
              const isTerminal =
                err instanceof OutboxIntegrityError ||
                (err instanceof DeliverySideEffectError && err.safeCode === 'TERMINAL_FAILURE') ||
                attempt >= this.maxAttempts;

              const errorCode =
                err instanceof DeliverySideEffectError
                  ? err.safeCode
                  : err instanceof DiscordClientUnavailableError
                    ? 'DISCORD_CLIENT_UNAVAILABLE'
                    : err instanceof OutboxIntegrityError
                      ? 'INTEGRITY_VERIFICATION_FAILED'
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
                targetId: event.deliveryId ?? event.id,
                actorType: 'SERVICE',
                principalId: `service:${this.workerId}`,
                actorId: this.workerId,
                authKind: 'SERVICE',
                resourceId: event.resourceId,
                requestId: event.requestId,
                payload: {
                  deliveryId: event.deliveryId,
                  attempt,
                  errorCode,
                  terminal: isTerminal,
                },
              });

              if (isTerminal) {
                await this.repos.outbox.markFailed(event.id, errorCode, attempt);
                logger.error('Outbox event reached terminal failure', {
                  eventId: event.id,
                  eventType: event.eventType,
                  attempts: attempt,
                  errorType: errorCode,
                });
              } else {
                const backoffMs = Math.pow(2, attempt) * 1000;
                const nextRetryAt = new Date(Date.now() + backoffMs);
                await this.repos.outbox.releaseClaim(event.id, nextRetryAt, errorCode, attempt);
                logger.warn('Outbox event released for retry after failure', {
                  eventId: event.id,
                  eventType: event.eventType,
                  attempts: attempt,
                  nextRetryAt: nextRetryAt.toISOString(),
                  errorType: errorCode,
                });
              }
            }
          }
        );
      }
    } finally {
      this.isProcessing = false;
    }

    return processedCount;
  }

  private async processEvent(event: OutboxEvent, attempt: number): Promise<void> {
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
      targetId: event.deliveryId ?? event.id,
      actorType: 'SERVICE',
      principalId: `service:${this.workerId}`,
      actorId: this.workerId,
      authKind: 'SERVICE',
      resourceId: event.resourceId,
      requestId: event.requestId,
      payload: {
        deliveryId: event.deliveryId,
        attempt,
        deliveryType: event.eventType,
        recipientId: event.recipientId,
        destinationId: event.destinationId,
      },
    });

    let result: 'DELIVERED' | 'NOOP';
    try {
      if (
        event.eventType === 'REQUEST_CREATED_GUARDIAN_NOTIFICATION' ||
        event.eventType === 'REQUEST_CREATED' ||
        event.eventType === 'DELIVERY_DISCORD_MESSAGE'
      ) {
        result = await this.handleGuardianNotification(event);
      } else if (
        event.eventType === 'APPROVAL_CALLBACK' ||
        event.eventType === 'DELIVERY_WEBHOOK'
      ) {
        result = await this.handleApprovalCallback(event);
      } else {
        throw new Error(`Unknown outbox event type: ${event.eventType}`);
      }
    } catch (error) {
      if (error instanceof DiscordClientUnavailableError) {
        throw error;
      }
      if (error instanceof DeliverySideEffectError) {
        throw error;
      }
      let safeError: string;
      if (error instanceof Error) {
        safeError = error.name && error.name !== 'Error' ? error.name : error.message;
      } else {
        safeError = String(error);
      }
      throw new DeliverySideEffectError(safeError || 'DELIVERY_UNKNOWN');
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
        targetId: event.deliveryId ?? event.id,
        actorType: 'SERVICE',
        principalId: `service:${this.workerId}`,
        actorId: this.workerId,
        authKind: 'SERVICE',
        resourceId: event.resourceId,
        requestId: event.requestId,
        payload: {
          deliveryId: event.deliveryId,
          attempt,
          deliveryType: event.eventType,
          result,
          recipientId: event.recipientId,
          destinationId: event.destinationId,
        },
      });
    } catch (error) {
      logger.error('Delivery completed but outcome audit failed', {
        eventId: event.id,
        eventType: event.eventType,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    await this.repos.outbox.markProcessed(event.id, attempt);
  }

  private async handleGuardianNotification(event: OutboxEvent): Promise<'DELIVERED' | 'NOOP'> {
    const requestId = event.requestId || requirePayloadString(event.payload, 'requestId');
    const resourceId = event.resourceId || requirePayloadString(event.payload, 'resourceId');
    const recipientId = event.recipientId || (event.payload.recipientId as string | undefined);

    if (!this.discordClient) {
      throw new DiscordClientUnavailableError();
    }

    const request = await this.repos.approvalRequests.findById(requestId);
    if (!request) {
      throw new Error(`ApprovalRequest not found: ${requestId}`);
    }

    if (recipientId) {
      // Re-evaluate eligibility for the target guardian at delivery time
      const guardianPrincipal = createDiscordPrincipal(recipientId);
      const authResult = await hasCapability(this.repos, guardianPrincipal, 'request.decide', {
        resourceId,
        requestId,
      });

      if (!authResult.allowed) {
        logger.info('Recipient is no longer an eligible guardian for request, skipping delivery', {
          recipientId,
          requestId,
          resourceId,
        });
        return 'NOOP';
      }

      const user = await this.discordClient.users.fetch(recipientId).catch((err) => {
        throw new Error(`Failed to fetch Discord user ${recipientId}: ${err.message}`);
      });
      const dm = await user.createDM().catch((err) => {
        throw new Error(
          `Failed to create DM channel for Discord user ${recipientId}: ${err.message}`
        );
      });

      await dm.send({
        content: `🔐 Approval request for resource: ${resourceId}`,
      });

      return 'DELIVERED';
    }

    // Legacy fan-out fallback if event was not bound to a specific recipient
    const guardians = await this.repos.guardians.findByResourceId(resourceId);
    if (guardians.length === 0) {
      logger.warn('No guardians registered to receive notification', { resourceId });
      return 'NOOP';
    }

    let anyDelivered = false;
    for (const guardian of guardians) {
      try {
        const user = await this.discordClient.users.fetch(guardian.discordUserId);
        const dm = await user.createDM();
        await dm.send({
          content: `🔐 Approval request for resource: ${resourceId}`,
        });
        anyDelivered = true;
      } catch (err) {
        logger.warn('Failed to deliver DM to individual guardian in fan-out fallback', {
          guardianId: guardian.discordUserId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return anyDelivered ? 'DELIVERED' : 'NOOP';
  }

  private async handleApprovalCallback(event: OutboxEvent): Promise<'DELIVERED' | 'NOOP'> {
    const requestId = event.requestId || requirePayloadString(event.payload, 'requestId');
    const status = (event.payload.status as string) || 'UNKNOWN';

    const request = await this.repos.approvalRequests.findById(requestId);
    if (!request) throw new Error(`ApprovalRequest not found: ${requestId}`);

    if (event.destinationId) {
      const dest = await this.repos.callbackDestinations.findById(event.destinationId);
      if (!dest) {
        logger.warn('Registered callback destination not found', {
          destinationId: event.destinationId,
        });
        return 'NOOP';
      }

      if (dest.status !== 'ACTIVE') {
        logger.info('Callback destination is not ACTIVE, skipping delivery', {
          destinationId: dest.id,
          status: dest.status,
        });
        return 'NOOP';
      }

      const secret = decryptValue(dest.encryptedSecret);
      const response = await SSRFSafeWebhookClient.send(dest.url, secret, {
        deliveryId: event.deliveryId ?? event.id,
        idempotencyKey: (event.payload.idempotencyKey as string) ?? event.id,
        eventType: 'APPROVAL_CALLBACK',
        requestId,
        resourceId: request.resourceId,
        status,
        targetVersion: request.targetVersion,
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new DeliverySideEffectError(`HTTP_${response.statusCode}`);
      }

      return 'DELIVERED';
    }

    // Fallback: active destinations on resource
    const destinations = await this.repos.callbackDestinations.findByResourceId(
      request.resourceId,
      'ACTIVE'
    );
    if (destinations.length === 0) {
      return 'NOOP';
    }

    for (const dest of destinations) {
      const secret = decryptValue(dest.encryptedSecret);
      const response = await SSRFSafeWebhookClient.send(dest.url, secret, {
        deliveryId: event.deliveryId ?? event.id,
        idempotencyKey: (event.payload.idempotencyKey as string) ?? event.id,
        eventType: 'APPROVAL_CALLBACK',
        requestId,
        resourceId: request.resourceId,
        status,
        targetVersion: request.targetVersion,
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new DeliverySideEffectError(`HTTP_${response.statusCode}`);
      }
    }

    return 'DELIVERED';
  }
}
