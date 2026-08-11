/**
 * Application services for the Purrmission approval system.
 *
 * These services contain the core business logic for:
 * - Creating approval requests
 * - Recording approval/denial decisions
 * - Managing resources and guardians
 */

import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  ApprovalRequest,
  Resource,
  Guardian,
  TOTPAccount,
  ResourceField,
  ResourceFieldMetadata,
  TOTPLinkConsent,
  TOTPDelegationConsent,
  Credential,
  ApprovalGrant,
  Principal,
  ApprovalDecision,
  DecisionResult,
  Capability,
  CapabilityContext,
  EvaluationResult,
} from './models.js';
import type { Repositories } from './repositories.js';
import { logger } from '../logging/logger.js';
import { AuditService, buildOutboxEvent } from './audit.js';
import { AuthService, AccessDeniedError, ForbiddenError } from './auth.js';
import { ProjectService } from './project.js';
import { ResourceNotFoundError, DuplicateError, ValidationError } from './errors.js';
import {
  getEffectiveGuardians,
  isEffectiveGuardian,
  isEffectiveOwner,
  hasCapability,
} from './policy.js';
import { createDiscordPrincipal, validatePrincipal } from './principal.js';
import { generateTOTPCode } from './totp.js';
import { computeKeyedDigest, deterministicUUID } from './crypto.js';
import { DomainPorts } from './ports.js';
import { DomainPortsImpl } from './ports_impl.js';
import { correlationStorage } from '../logging/correlationContext.js';

/**
 * Service dependencies.
 */
export interface ServiceDependencies {
  repositories: Repositories;
  audit: AuditService;
  approval?: ApprovalService;
}

/**
 * Input for creating an approval request.
 */
/**
 * Input for creating an approval request.
 */
export interface CreateApprovalRequestInput {
  resourceId: string;
  principal?: Principal;
  context?: Record<string, unknown>;
  callbackUrl?: string;
  expiresInMs?: number;
  // V2 fields:
  requesterId?: string;
  requesterType?: string;
  authKind?: string;
  action?: string;
  targetKey?: string | null;
  targetVersion?: string;
  policyVersion?: string;
  constraints?: Record<string, unknown> | null;
}

/**
 * Result of creating an approval request.
 */
export interface CreateApprovalRequestResult {
  success: boolean;
  request?: ApprovalRequest;
  resource?: Resource;
  guardians?: Guardian[];
  error?: string;
}

/**
 * Application services for the Purrmission system.
 */
export class ApprovalService {
  readonly deps: ServiceDependencies;
  private readonly audit: AuditService;

  constructor(deps: ServiceDependencies) {
    if (!deps.audit) throw new TypeError('ApprovalService requires an audit dependency.');
    this.deps = deps;
    this.audit = deps.audit;
  }

  private async runTransaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.deps.repositories.transaction(callback);
  }

  /**
   * Create a new approval request.
   *
   * @param input - The request input
   * @returns The created request and related entities
   */
  async createApprovalRequest(
    input: CreateApprovalRequestInput
  ): Promise<CreateApprovalRequestResult> {
    const { repositories } = this.deps;

    // Verify resource exists
    const resource = await repositories.resources.findById(input.resourceId);
    if (!resource) {
      return {
        success: false,
        error: `Resource not found: ${input.resourceId}`,
      };
    }

    // Resolve V2 properties with fallback/legacy defaults
    const requesterId =
      input.requesterId ||
      (input.context?.requesterId ? String(input.context.requesterId) : 'legacy');
    const requesterType = input.requesterType || 'DISCORD_USER';
    const authKind = input.authKind || 'DISCORD';
    const action = input.action || 'resource.view';
    const targetKey = input.targetKey || null;
    const targetVersion = input.targetVersion || resource.version;
    const policyVersion = input.policyVersion || resource.version;

    // Deduplication check: check if a PENDING request already exists for this exact signature
    let existingPending = null;
    if (typeof repositories.approvalRequests.findPending === 'function') {
      existingPending = await repositories.approvalRequests.findPending(
        input.resourceId,
        requesterId,
        action,
        targetKey
      );
    }
    if (existingPending) {
      return {
        success: true,
        request: existingPending,
        resource,
        guardians: await getEffectiveGuardians(repositories, input.resourceId),
      };
    }

    // Get guardians for the resource
    const guardians = await getEffectiveGuardians(repositories, input.resourceId);
    if (guardians.length === 0) {
      return {
        success: false,
        error: 'Resource has no guardians configured',
      };
    }

    if (input.expiresInMs !== undefined && input.expiresInMs <= 0) {
      return {
        success: false,
        error: 'expiresInMs must be a positive number',
      };
    }

    // Calculate expiration time (default to 24 hours if not provided)
    const defaultExpiresInMs = 24 * 60 * 60 * 1000; // 24 hours
    const expiresAt = new Date(Date.now() + (input.expiresInMs ?? defaultExpiresInMs));

    // Create the request atomically in transaction
    try {
      const request = await this.runTransaction(async (tx) => {
        const req = await repositories.approvalRequests.create(
          {
            id: crypto.randomUUID(),
            resourceId: input.resourceId,
            status: 'PENDING',
            context: input.context || null,
            requesterId,
            requesterType,
            authKind,
            action,
            targetKey,
            targetVersion,
            policyVersion,
            constraints: input.constraints || null,
            callbackUrl: input.callbackUrl,
            expiresAt,
          },
          tx
        );

        await this.audit.log(
          {
            eventFamily: 'REQUEST_GRANT_LIFECYCLE',
            eventType: 'REQUEST_CREATE',
            surface: 'DOMAIN',
            operation: 'request.create',
            outcomeCode: 'SUCCESS',
            capability: 'request.create',
            decisionCode: 'ALLOW',
            reasonCode: 'AUTHENTICATED_SUBJECT',
            authoritySources: ['AUTHENTICATED_SUBJECT'],
            targetType: 'APPROVAL_REQUEST',
            targetId: req.id,
            actorType:
              input.principal?.type ??
              (authKind === 'API_KEY'
                ? 'RESOURCE_API_KEY'
                : requesterType === 'PAWTHY_TOKEN'
                  ? 'PAWTHY_TOKEN'
                  : requesterType === 'SERVICE'
                    ? 'SERVICE'
                    : 'DISCORD_USER'),
            principalId: input.principal?.id ?? `legacy-${authKind}:${requesterId}`,
            actorId: input.principal?.subjectId ?? requesterId,
            authKind:
              input.principal?.authKind ??
              (authKind === 'PAWTHY'
                ? 'PAWTHY'
                : authKind === 'API_KEY'
                  ? 'API_KEY'
                  : authKind === 'SERVICE'
                    ? 'SERVICE'
                    : 'DISCORD'),
            resourceId: input.resourceId,
            requestId: req.id,
            correlationId: input.principal?.correlationId,
            payload: {
              action,
              targetKey,
              targetVersion,
              policyVersion,
              expiresAt: expiresAt.toISOString(),
            },
          },
          tx
        );

        // Enqueue Outbox event to notify guardians deterministically
        const delivery = buildOutboxEvent({
          id: deterministicUUID(req.id + '_REQUEST_CREATED'),
          eventType: 'REQUEST_CREATED',
          resourceId: input.resourceId,
          requestId: req.id,
          causationId: req.id,
          payload: {
            requestId: req.id,
            resourceId: input.resourceId,
          },
        });
        await repositories.outbox.create(delivery, tx);
        await this.audit.log(
          {
            eventFamily: 'DELIVERY',
            eventType: 'DELIVERY_ENQUEUE',
            surface: 'DOMAIN',
            operation: 'delivery.guardian.enqueue',
            outcomeCode: 'QUEUED',
            decisionCode: 'ALLOW',
            reasonCode: 'AUTHENTICATED_SUBJECT',
            authoritySources: ['AUTHENTICATED_SUBJECT'],
            targetType: 'DELIVERY',
            targetId: delivery.id,
            actorType: input.principal?.type ?? 'DISCORD_USER',
            principalId: input.principal?.id ?? `legacy-${authKind}:${requesterId}`,
            actorId: input.principal?.subjectId ?? requesterId,
            authKind: input.principal?.authKind ?? 'DISCORD',
            resourceId: input.resourceId,
            requestId: req.id,
            correlationId: delivery.correlationId,
            causationId: delivery.causationId,
            payload: { deliveryType: 'REQUEST_CREATED' },
          },
          tx
        );

        return req;
      });

      logger.info('Created approval request', {
        requestId: request.id,
        resourceId: resource.id,
        resourceName: resource.name,
        guardianCount: guardians.length,
      });

      return {
        success: true,
        request,
        resource,
        guardians,
      };
    } catch (err) {
      logger.error('Failed to create approval request atomically', {
        resourceId: input.resourceId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err; // Fail closed
    }
  }

  /**
   * Record a decision (approve/deny) on an approval request.
   *
   * @param requestId - The ID of the request
   * @param decision - The decision (APPROVE or DENY)
   * @param principal - Authenticated principal making the decision
   * @returns The result of recording the decision
   */
  async recordDecision(
    requestId: string,
    decision: ApprovalDecision,
    principal: Principal
  ): Promise<DecisionResult> {
    const { repositories } = this.deps;
    const byGuardianDiscordId = principal.subjectId;

    // Find the request
    const request = await repositories.approvalRequests.findById(requestId);
    if (!request) {
      return {
        success: false,
        error: `Request not found: ${requestId}`,
      };
    }

    // Check if request is still pending
    if (request.status !== 'PENDING') {
      return {
        success: false,
        error: `Request is no longer pending (status: ${request.status})`,
        request,
      };
    }

    // Check if request has expired
    if (request.expiresAt < new Date()) {
      await this.runTransaction(async (tx) => {
        await repositories.approvalRequests.updateStatus(requestId, 'EXPIRED', undefined, tx);
        await this.audit.log(
          {
            eventFamily: 'REQUEST_GRANT_LIFECYCLE',
            eventType: 'REQUEST_EXPIRE',
            surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
            operation: 'request.expire',
            outcomeCode: 'SUCCESS',
            decisionCode: 'ALLOW',
            reasonCode: 'SERVICE',
            authoritySources: [],
            targetType: 'APPROVAL_REQUEST',
            targetId: request.id,
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
            resourceId: request.resourceId,
            requestId: request.id,
            payload: {},
          },
          tx
        );
      });
      return {
        success: false,
        error: 'Request has expired',
        request: { ...request, status: 'EXPIRED' },
      };
    }

    const authorization = await hasCapability(repositories, principal, 'request.decide', {
      requestId,
      resourceId: request.resourceId,
    });
    if (!authorization.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'request.decide.authorize',
        outcomeCode: 'DENIED',
        capability: 'request.decide',
        decisionCode: authorization.decisionCode,
        reasonCode: authorization.reasonCode,
        authoritySources: authorization.authoritySources,
        targetType: 'APPROVAL_REQUEST',
        targetId: request.id,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId: request.resourceId,
        requestId: request.id,
        payload: {},
      });
      if (authorization.reasonCode === 'SELF_APPROVAL_FORBIDDEN') {
        logger.warn('Self-approval rejected', {
          requestId,
          guardianId: byGuardianDiscordId,
        });
        return {
          success: false,
          error: 'Requesters cannot approve their own requests.',
        };
      }

      logger.warn('Decision made without request.decide capability', {
        requestId,
        discordUserId: byGuardianDiscordId,
        resourceId: request.resourceId,
        reasonCode: authorization.reasonCode,
      });
      return {
        success: false,
        error: 'User cannot decide requests for this resource',
      };
    }

    // Update the request status
    const newStatus = decision === 'APPROVE' ? 'APPROVED' : 'DENIED';

    try {
      await this.runTransaction(async (tx) => {
        await this.audit.log(
          {
            eventFamily: 'AUTHORIZATION',
            eventType: 'AUTHORIZATION_DECISION',
            surface: 'DOMAIN',
            operation: 'request.decide.authorize',
            outcomeCode: 'SUCCESS',
            capability: 'request.decide',
            decisionCode: authorization.decisionCode,
            reasonCode: authorization.reasonCode,
            authoritySources: authorization.authoritySources,
            targetType: 'APPROVAL_REQUEST',
            targetId: request.id,
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
            resourceId: request.resourceId,
            requestId: request.id,
            payload: {},
          },
          tx
        );
        await repositories.approvalRequests.updateStatus(
          requestId,
          newStatus,
          byGuardianDiscordId,
          tx
        );

        // APPROVED is decision state, not reveal authority. The conditional transition and
        // request-bound immutable grant model lands in #122; #117 deliberately mints no grant.

        await this.audit.log(
          {
            eventFamily: 'REQUEST_GRANT_LIFECYCLE',
            eventType: 'APPROVAL_DECISION',
            surface: 'DOMAIN',
            operation: 'request.decide',
            outcomeCode: newStatus === 'APPROVED' ? 'SUCCESS' : 'DENIED',
            capability: 'request.decide',
            decisionCode: 'ALLOW',
            reasonCode: authorization.reasonCode,
            authoritySources: authorization.authoritySources,
            targetType: 'APPROVAL_REQUEST',
            targetId: request.id,
            actorType: principal.type,
            principalId: principal.id,
            actorId: byGuardianDiscordId,
            authKind: principal.authKind,
            resolverType: principal.type,
            resolverId: principal.subjectId,
            resourceId: request.resourceId,
            requestId: request.id,
            payload: {
              decision,
              requesterId: request.requesterId,
            },
          },
          tx
        );

        // Always enqueue a callback delivery event deterministically
        const delivery = buildOutboxEvent({
          id: deterministicUUID(request.id + '_APPROVAL_CALLBACK'),
          eventType: 'APPROVAL_CALLBACK',
          resourceId: request.resourceId,
          requestId: request.id,
          causationId: request.id,
          payload: {
            requestId: request.id,
            status: newStatus,
          },
        });
        await repositories.outbox.create(delivery, tx);
        await this.audit.log(
          {
            eventFamily: 'DELIVERY',
            eventType: 'DELIVERY_ENQUEUE',
            surface: 'DOMAIN',
            operation: 'delivery.callback.enqueue',
            outcomeCode: 'QUEUED',
            decisionCode: 'ALLOW',
            reasonCode: authorization.reasonCode,
            authoritySources: authorization.authoritySources,
            targetType: 'DELIVERY',
            targetId: delivery.id,
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
            resourceId: request.resourceId,
            requestId: request.id,
            correlationId: delivery.correlationId,
            causationId: delivery.causationId,
            payload: { deliveryType: 'APPROVAL_CALLBACK' },
          },
          tx
        );
      });

      const updatedRequest: ApprovalRequest = {
        ...request,
        status: newStatus,
        resolvedBy: byGuardianDiscordId,
        resolvedAt: new Date(),
      };

      logger.info('Recorded decision on approval request', {
        requestId,
        decision,
        byGuardianDiscordId,
        newStatus,
      });

      // Prepare callback action if URL is configured
      const result: DecisionResult = {
        success: true,
        request: updatedRequest,
      };

      if (request.callbackUrl) {
        result.action = {
          type: 'CALL_CALLBACK_URL',
          url: request.callbackUrl,
          status: newStatus,
        };
      }

      return result;
    } catch (err) {
      logger.error('Failed to record decision atomically', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err; // Fail closed
    }
  }

  /**
   * Get an approval request by ID.
   */
  async getApprovalRequest(id: string): Promise<ApprovalRequest | null> {
    return this.deps.repositories.approvalRequests.findById(id);
  }

  /**
   * Find an active (PENDING or APPROVED) approval request for a resource and requester.
   */
  async findActiveApproval(
    resourceId: string,
    requesterId: string,
    action: string = 'resource.view',
    targetKey: string | null = null
  ): Promise<ApprovalRequest | null> {
    return this.deps.repositories.approvalRequests.findActiveByRequester(
      resourceId,
      requesterId,
      action,
      targetKey
    );
  }

  /**
   * Find an active, unconsumed approval grant.
   */
  async findActiveUnconsumedGrant(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalGrant | null> {
    if (!this.deps.repositories.approvalGrants) {
      return null;
    }
    return this.deps.repositories.approvalGrants.findActiveUnconsumed(
      resourceId,
      requesterId,
      action,
      targetKey
    );
  }

  /**
   * Atomically validate and consume an approval grant.
   */
  async consumeGrant(
    grantId: string,
    principal: Principal,
    action: string,
    currentTargetVersion: string,
    currentPolicyVersion: string,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const { repositories } = this.deps;
    if (!repositories.approvalGrants) {
      return;
    }

    const grant = await repositories.approvalGrants.findById(grantId);
    if (!grant) {
      throw new AccessDeniedError('Approval grant not found.');
    }

    if (grant.consumedAt) {
      throw new AccessDeniedError('Approval grant has already been consumed.');
    }

    if (grant.revokedAt) {
      throw new AccessDeniedError('Approval grant has been revoked.');
    }

    if (grant.expiresAt < new Date()) {
      throw new AccessDeniedError('Approval grant has expired.');
    }

    // Revalidate requester
    if (
      grant.requesterId !== principal.subjectId ||
      grant.requesterType !== principal.type ||
      grant.authKind !== principal.authKind
    ) {
      throw new AccessDeniedError('Principal mismatch on approval grant.');
    }

    // Revalidate action
    if (grant.action !== action) {
      throw new AccessDeniedError('Action mismatch on approval grant.');
    }

    // Revalidate target version
    if (grant.targetVersion !== currentTargetVersion) {
      throw new AccessDeniedError('Target state version mismatch. Consent has been invalidated.');
    }

    // Revalidate policy version
    if (grant.policyVersion !== currentPolicyVersion) {
      throw new AccessDeniedError('Policy version mismatch. Consent has been invalidated.');
    }

    // Atomically consume
    const consumed = await repositories.approvalGrants.consume(grant.id, tx);
    if (!consumed) {
      throw new AccessDeniedError('Failed to consume approval grant atomically.');
    }

    await this.audit.log(
      {
        eventFamily: 'REQUEST_GRANT_LIFECYCLE',
        eventType: 'GRANT_CONSUME',
        surface: 'DOMAIN',
        operation: 'grant.consume',
        outcomeCode: 'SUCCESS',
        capability: 'grant.consume',
        decisionCode: 'ALLOW',
        reasonCode: 'GRANT',
        authoritySources: ['APPROVAL_GRANT'],
        targetType: 'APPROVAL_GRANT',
        targetId: grant.id,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId: grant.resourceId,
        requestId: grant.requestId,
        grantId: grant.id,
        payload: {},
      },
      tx
    );

    logger.info('Consumed approval grant', {
      grantId: grant.id,
      requestId: grant.requestId,
      requesterId: grant.requesterId,
    });
  }

  /**
   * Automatically expire pending approval requests that have passed their expiration time.
   * @returns The number of expired requests
   */
  async cleanupExpiredRequests(): Promise<number> {
    const count = await this.runTransaction(async (tx) => {
      const expired = await this.deps.repositories.approvalRequests.expireRequests(tx);
      if (expired > 0) {
        await this.audit.log(
          {
            eventFamily: 'REQUEST_GRANT_LIFECYCLE',
            eventType: 'REQUEST_EXPIRY_SWEEP',
            surface: correlationStorage.getStore()?.surface ?? 'SYSTEM',
            operation: 'request.expiry.sweep',
            outcomeCode: 'SUCCESS',
            decisionCode: 'ALLOW',
            reasonCode: 'SERVICE',
            authoritySources: [],
            targetType: 'SYSTEM',
            actorType: 'SERVICE',
            principalId: 'service:request-expiry',
            authKind: 'SERVICE',
            payload: { expiredCount: expired },
          },
          tx
        );
      }
      return expired;
    });
    if (count > 0) {
      logger.info(`Cleaned up expired approval requests`, { count });
    }
    return count;
  }
}

/**
 * Service for managing resources.
 */
export class ResourceService {
  readonly deps: ServiceDependencies;
  private readonly audit: AuditService;

  constructor(deps: ServiceDependencies) {
    if (!deps.audit) throw new TypeError('ResourceService requires an audit dependency.');
    this.deps = deps;
    this.audit = deps.audit;
  }

  private async runTransaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.deps.repositories.transaction(callback);
  }

  /**
   * Get a resource by ID.
   */
  async getResource(id: string): Promise<Resource | null> {
    return this.deps.repositories.resources.findById(id);
  }

  /**
   * Check if a user is a guardian (or owner) of a resource.
   */
  async isGuardian(resourceId: string, userId: string): Promise<boolean> {
    return isEffectiveGuardian(this.deps.repositories, resourceId, userId);
  }

  /**
   * Evaluate one exact capability against the authenticated principal and target.
   *
   * Legacy adapters use this narrow bridge while their full #128/#129 cutovers remain deferred.
   * It keeps role interpretation in the domain evaluator instead of recreating broad Guardian
   * booleans at each transport boundary.
   */
  async evaluateCapability(
    principal: Principal,
    capability: Capability,
    context: CapabilityContext
  ): Promise<EvaluationResult> {
    return hasCapability(this.deps.repositories, principal, capability, context);
  }

  /**
   * Create a new resource.
   *
   * @param name - Name of the resource
   * @param ownerDiscordId - Discord user ID of the owner
   * @returns The created resource
   */
  async createResource(
    name: string,
    principal: Principal,
    tx?: Prisma.TransactionClient
  ): Promise<{ resource: Resource; guardian: Guardian }> {
    if (!tx) {
      return this.runTransaction((transaction) =>
        this.createResource(name, principal, transaction)
      );
    }
    const { repositories } = this.deps;
    const ownerDiscordId = principal.subjectId;

    // Generate a random API key
    const apiKey = crypto.randomBytes(32).toString('hex');

    // Create the resource
    const resource = await repositories.resources.create(
      {
        id: crypto.randomUUID(),
        name,
        mode: 'ONE_OF_N',
        apiKey,
      },
      tx
    );

    // Add the creator as owner
    const guardian = await repositories.guardians.add(
      {
        id: crypto.randomUUID(),
        resourceId: resource.id,
        discordUserId: ownerDiscordId,
        role: 'OWNER',
      },
      tx
    );

    await this.audit.log(
      {
        eventFamily: 'RESOURCE_CONFIGURATION',
        eventType: 'RESOURCE_CREATE',
        surface: 'DOMAIN',
        operation: 'resource.create',
        outcomeCode: 'SUCCESS',
        capability: 'resource.create',
        decisionCode: 'ALLOW',
        reasonCode: 'AUTHENTICATED_SUBJECT',
        authoritySources: ['AUTHENTICATED_SUBJECT'],
        targetType: 'RESOURCE',
        targetId: resource.id,
        actorType: principal.type,
        principalId: principal.id,
        actorId: ownerDiscordId,
        authKind: principal.authKind,
        resourceId: resource.id,
        payload: {},
      },
      tx
    );

    logger.info('Created resource', {
      resourceId: resource.id,
      name: resource.name,
      ownerId: ownerDiscordId,
    });

    return { resource, guardian };
  }

  /**
   * Add a guardian to a resource.
   *
   * @param resourceId - ID of the resource
   * @param discordUserId - Discord user ID to add as guardian
   * @returns The created guardian
   */
  async addGuardian(
    resourceId: string,
    discordUserId: string,
    actorId: string
  ): Promise<{ success: boolean; guardian?: Guardian; error?: string }> {
    const { repositories } = this.deps;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      return {
        success: false,
        error: `Resource not found: ${resourceId}`,
      };
    }

    // Verify Actor is Owner
    const hasOwnerAccess = await isEffectiveOwner(repositories, resourceId, actorId);
    if (!hasOwnerAccess) {
      return { success: false, error: 'Only the resource owner can add guardians.' };
    }

    // Check if user is already a guardian
    const existing = await repositories.guardians.findByResourceAndUser(resourceId, discordUserId);
    if (existing) {
      return {
        success: false,
        error: 'User is already a guardian for this resource',
      };
    }

    const guardian = await this.runTransaction(async (tx) => {
      const created = await repositories.guardians.add(
        {
          id: crypto.randomUUID(),
          resourceId,
          discordUserId,
          role: 'GUARDIAN',
        },
        tx
      );
      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'RESOURCE_UPDATE',
          surface: 'DOMAIN',
          operation: 'resource.guardian.add',
          outcomeCode: 'SUCCESS',
          capability: 'guardian.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: ['RESOURCE_OWNER'],
          targetType: 'RESOURCE',
          targetId: resourceId,
          actorType: 'DISCORD_USER',
          principalId: `discord:${actorId}`,
          actorId,
          authKind: 'DISCORD',
          resourceId,
          payload: { guardianId: created.id, memberUserId: discordUserId },
        },
        tx
      );
      return created;
    });

    logger.info('Added guardian to resource', {
      resourceId,
      guardianId: guardian.id,
      discordUserId,
    });

    return { success: true, guardian };
  }

  /**
   * Remove a guardian from a resource.
   */
  async removeGuardian(
    resourceId: string,
    actorId: string,
    targetUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    const { repositories } = this.deps;

    // Verify Actor is Owner
    const hasOwnerAccess = await isEffectiveOwner(repositories, resourceId, actorId);
    if (!hasOwnerAccess) {
      return { success: false, error: 'Only the resource owner can remove guardians.' };
    }

    // Verify Target is a Guardian
    const targetGuardian = await repositories.guardians.findByResourceAndUser(
      resourceId,
      targetUserId
    );
    if (!targetGuardian) {
      return { success: false, error: 'User is not a guardian of this resource.' };
    }
    if (targetGuardian.role === 'OWNER') {
      return { success: false, error: 'Cannot remove the resource owner.' };
    }

    await this.runTransaction(async (tx) => {
      await repositories.guardians.remove(resourceId, targetUserId, tx);
      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'RESOURCE_UPDATE',
          surface: 'DOMAIN',
          operation: 'resource.guardian.remove',
          outcomeCode: 'SUCCESS',
          capability: 'guardian.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: ['RESOURCE_OWNER'],
          targetType: 'RESOURCE',
          targetId: resourceId,
          actorType: 'DISCORD_USER',
          principalId: `discord:${actorId}`,
          actorId,
          authKind: 'DISCORD',
          resourceId,
          payload: { memberUserId: targetUserId },
        },
        tx
      );
    });

    logger.info('Removed guardian from resource', {
      resourceId,
      actorId,
      targetUserId,
    });

    return { success: true };
  }

  /**
   * List confirmed guardians for a resource.
   */
  async listGuardians(
    resourceId: string,
    actorId: string
  ): Promise<{ success: boolean; guardians?: Guardian[]; error?: string }> {
    const decision = await this.evaluateCapability(
      createDiscordPrincipal(actorId),
      'guardian.view',
      { resourceId }
    );
    if (!decision.allowed) {
      return {
        success: false,
        error: 'Access denied. Only the resource owner may list Guardian assignments.',
      };
    }

    const guardians = await getEffectiveGuardians(this.deps.repositories, resourceId);
    return { success: true, guardians };
  }

  /**
   * Remove a guardian from a resource (alias for removeGuardian).
   */
  async remove(
    resourceId: string,
    actorId: string,
    targetUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.removeGuardian(resourceId, actorId, targetUserId);
  }

  /**
   * List confirmed guardians for a resource (alias for listGuardians).
   */
  async list(
    resourceId: string,
    actorId: string
  ): Promise<{ success: boolean; guardians?: Guardian[]; error?: string }> {
    return this.listGuardians(resourceId, actorId);
  }

  /**
   * Verify an API key and return the resource.
   */
  async verifyApiKey(apiKey: string): Promise<Resource | null> {
    const { repositories } = this.deps;

    // 1. Try new digested credentials lookup
    const digest = computeKeyedDigest(apiKey, 'RESOURCE_API_KEY');
    const credential = await repositories.credentials.findByDigest(digest);

    if (
      credential &&
      credential.type === 'RESOURCE_API_KEY' &&
      !credential.revokedAt &&
      (!credential.expiresAt || credential.expiresAt > new Date())
    ) {
      // Update last used time
      await repositories.credentials.updateLastUsed(credential.id);
      const resource = await repositories.resources.findById(credential.subjectId);
      await this.audit.log({
        eventFamily: 'AUTHENTICATION',
        eventType: 'CREDENTIAL_USE',
        surface: 'DOMAIN',
        operation: 'resource.api-key.validate',
        outcomeCode: resource ? 'SUCCESS' : 'DENIED',
        decisionCode: resource ? 'ALLOW' : 'DENY',
        reasonCode: resource ? 'AUTHENTICATED_SUBJECT' : 'INVALID_AUTH',
        authoritySources: resource ? ['SCOPED_CREDENTIAL'] : [],
        targetType: 'CREDENTIAL',
        targetId: credential.id,
        actorType: 'RESOURCE_API_KEY',
        principalId: credential.id,
        actorId: credential.subjectId,
        authKind: 'API_KEY',
        resourceId: resource?.id ?? credential.subjectId,
        payload: {},
      });
      return resource;
    }

    await this.audit.log({
      eventFamily: 'AUTHENTICATION',
      eventType: 'CREDENTIAL_USE',
      surface: 'DOMAIN',
      operation: 'resource.api-key.validate',
      outcomeCode: 'DENIED',
      decisionCode: 'DENY',
      reasonCode: 'INVALID_AUTH',
      authoritySources: [],
      targetType: 'CREDENTIAL',
      actorType: 'SERVICE',
      principalId: 'anonymous:resource-api-key',
      authKind: 'SERVICE',
      payload: {},
    });

    return null;
  }

  /**
   * Mint a new API key for a resource.
   */
  async mintApiKey(
    resourceId: string,
    actorId: string,
    name: string,
    expiresInMs?: number
  ): Promise<{ plaintext: string; credential: Credential }> {
    const { repositories } = this.deps;

    // Verify Resource Authority (actor must be resource owner)
    const hasOwnerAccess = await isEffectiveOwner(repositories, resourceId, actorId);
    if (!hasOwnerAccess) {
      throw new Error('Only the resource owner can mint API keys.');
    }

    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(`Resource not found: ${resourceId}`);
    }

    const plaintext = 'pur_' + crypto.randomBytes(32).toString('hex');
    const digest = computeKeyedDigest(plaintext, 'RESOURCE_API_KEY');
    const prefix = plaintext.substring(0, 12);

    const expiresAt = expiresInMs ? new Date(Date.now() + expiresInMs) : null;

    let credential!: Credential;

    try {
      await this.runTransaction(async (tx) => {
        credential = await repositories.credentials.create(
          {
            type: 'RESOURCE_API_KEY',
            subjectId: resourceId,
            name,
            digest,
            prefix,
            scopes: 'resource.view,request.create', // Default scopes for resource API keys
            audience: 'api',
            expiresAt,
            revokedAt: null,
          },
          tx
        );

        // Update resource version to rotate it
        await repositories.resources.update(resourceId, { version: crypto.randomUUID() }, tx);

        await this.audit.log(
          {
            eventFamily: 'AUTHENTICATION',
            eventType: 'API_KEY_MINT',
            surface: 'DOMAIN',
            operation: 'resource.api-key.mint',
            outcomeCode: 'SUCCESS',
            capability: 'resource.api-key.mint',
            decisionCode: 'ALLOW',
            reasonCode: 'OWNER',
            authoritySources: ['RESOURCE_OWNER'],
            targetType: 'CREDENTIAL',
            targetId: credential.id,
            actorType: 'DISCORD_USER',
            principalId: `discord:${actorId}`,
            actorId,
            authKind: 'DISCORD',
            resourceId,
            payload: { credentialId: credential.id },
          },
          tx
        );
      });
    } catch (err) {
      logger.error('Failed to mint API key atomically', {
        resourceId,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    return { plaintext, credential };
  }

  /**
   * Revoke an API key.
   */
  async revokeApiKey(resourceId: string, credentialId: string, actorId: string): Promise<void> {
    const { repositories } = this.deps;

    // Verify Resource Authority (actor must be resource owner)
    const hasOwnerAccess = await isEffectiveOwner(repositories, resourceId, actorId);
    if (!hasOwnerAccess) {
      throw new Error('Only the resource owner can revoke API keys.');
    }

    const credential = await repositories.credentials.findById(credentialId);
    if (!credential || credential.subjectId !== resourceId) {
      throw new Error('Credential not found or mismatch.');
    }

    try {
      await this.runTransaction(async (tx) => {
        await repositories.credentials.revoke(credentialId, tx);

        // Update resource version
        await repositories.resources.update(resourceId, { version: crypto.randomUUID() }, tx);

        await this.audit.log(
          {
            eventFamily: 'AUTHENTICATION',
            eventType: 'API_KEY_REVOKE',
            surface: 'DOMAIN',
            operation: 'resource.api-key.revoke',
            outcomeCode: 'SUCCESS',
            capability: 'resource.api-key.revoke',
            decisionCode: 'ALLOW',
            reasonCode: 'OWNER',
            authoritySources: ['RESOURCE_OWNER'],
            targetType: 'CREDENTIAL',
            targetId: credentialId,
            actorType: 'DISCORD_USER',
            principalId: `discord:${actorId}`,
            actorId,
            authKind: 'DISCORD',
            resourceId,
            payload: { credentialId },
          },
          tx
        );
      });
    } catch (err) {
      logger.error('Failed to revoke API key atomically', {
        resourceId,
        credentialId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * List API keys/credentials for a resource.
   */
  async listApiKeys(resourceId: string, actorId: string): Promise<Credential[]> {
    const { repositories } = this.deps;

    const decision = await this.evaluateCapability(
      createDiscordPrincipal(actorId),
      'resource.api-key.list',
      { resourceId }
    );
    if (!decision.allowed) {
      throw new Error('Access denied. Only the resource owner may list API keys.');
    }

    const creds = await repositories.credentials.findBySubject(resourceId);
    return creds.filter((c) => c.type === 'RESOURCE_API_KEY');
  }

  /**
   * Get guardians for a resource.
   */
  async getGuardians(resourceId: string): Promise<Guardian[]> {
    return getEffectiveGuardians(this.deps.repositories, resourceId);
  }

  /**
   * Link a TOTP account to a resource using a one-time consent token.
   */
  async linkTOTPAccount(
    _resourceId: string,
    _totpAccountId: string,
    _principal: Principal | string,
    _consentId: string
  ): Promise<void> {
    throw new ForbiddenError(
      'TOTP linking is deferred until authenticated, seed-version-bound custody consent lands in #120.'
    );
  }

  /**
   * Unlink TOTP account from a resource.
   */
  async unlinkTOTPAccount(resourceId: string, principal: Principal | string): Promise<void> {
    const { repositories } = this.deps;
    const actorPrincipal =
      typeof principal === 'string' ? createDiscordPrincipal(principal) : principal;
    const actorId = actorPrincipal.subjectId;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource not found: ${resourceId}`);
    }

    if (!resource.totpAccountId) {
      throw new Error('Resource is not linked to any TOTP account.');
    }

    const unlinkDecision = await this.evaluateCapability(actorPrincipal, 'totp.link.manage', {
      resourceId,
      totpAccountId: resource.totpAccountId,
      totpLinkOperation: 'UNLINK',
    });
    if (!unlinkDecision.allowed) {
      throw new ForbiddenError(unlinkDecision.safeExplanation);
    }

    // Update the resource to remove the linked TOTP account
    try {
      await this.runTransaction(async (tx) => {
        await repositories.resources.update(
          resourceId,
          { totpAccountId: null, totpDelegationEnvelope: null },
          tx
        );

        await this.audit.log(
          {
            eventFamily: 'TOTP_LIFECYCLE',
            eventType: 'TOTP_UNLINK',
            surface: 'DOMAIN',
            operation: 'totp.unlink',
            outcomeCode: 'SUCCESS',
            capability: 'totp.link.manage',
            decisionCode: 'ALLOW',
            reasonCode: isResourceOwner ? 'OWNER' : 'AUTHENTICATED_SUBJECT',
            authoritySources: [isResourceOwner ? 'RESOURCE_OWNER' : 'AUTHENTICATED_SUBJECT'],
            targetType: 'TOTP_ACCOUNT',
            targetId: resource.totpAccountId,
            actorType: actorPrincipal.type,
            principalId: actorPrincipal.id,
            actorId,
            authKind: actorPrincipal.authKind,
            resourceId,
            payload: {},
          },
          tx
        );
      });
    } catch (err) {
      logger.error('Failed to unlink TOTP account atomically', {
        resourceId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err; // Fail closed
    }

    logger.info('Unlinked TOTP account from resource', {
      resourceId,
    });
  }

  /**
   * Get the linked TOTP account for a resource.
   */
  async getLinkedTOTPAccount(resourceId: string): Promise<TOTPAccount | null> {
    const { repositories } = this.deps;

    const resource = await repositories.resources.findById(resourceId);
    if (!resource || !resource.totpAccountId) {
      return null;
    }

    return repositories.totp.findById(resource.totpAccountId);
  }

  /**
   * Create a link consent for a TOTP account.
   */
  async createTOTPLinkConsent(
    _accountId: string,
    _resourceId: string,
    _ownerDiscordUserId: string,
    _delegationPolicy: Record<string, unknown>
  ): Promise<TOTPLinkConsent> {
    throw new ForbiddenError(
      'TOTP link consent is deferred until authenticated, seed-version-bound custody consent lands in #120.'
    );
  }

  /**
   * Create a personal TOTP account and its required audit event in one transaction.
   * Secret and recovery material are deliberately excluded from the event envelope.
   */
  async createTOTPAccount(
    input: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    principal: Principal
  ): Promise<TOTPAccount> {
    if (input.ownerDiscordUserId !== principal.subjectId) {
      throw new AccessDeniedError('A TOTP account can only be created for the authenticated user.');
    }

    return this.runTransaction(async (tx) => {
      const account = await this.deps.repositories.totp.create(input, tx);
      await this.audit.log(
        {
          eventFamily: 'TOTP_LIFECYCLE',
          eventType: 'TOTP_ACCOUNT_CREATE',
          surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
          operation: 'totp.account.create',
          outcomeCode: 'SUCCESS',
          capability: 'totp.account.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['AUTHENTICATED_SUBJECT'],
          targetType: 'TOTP_ACCOUNT',
          targetId: account.id,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          payload: { accountName: account.accountName, issuerPresent: Boolean(account.issuer) },
        },
        tx
      );
      return account;
    });
  }

  /** Update personal TOTP metadata without ever putting recovery material in audit or logs. */
  async updateTOTPAccount(account: TOTPAccount, principal: Principal): Promise<TOTPAccount> {
    if (account.ownerDiscordUserId !== principal.subjectId) {
      throw new AccessDeniedError('Only the TOTP account owner can update the account.');
    }

    return this.runTransaction(async (tx) => {
      const updated = await this.deps.repositories.totp.update(account, tx);
      await this.audit.log(
        {
          eventFamily: 'TOTP_LIFECYCLE',
          eventType: 'TOTP_ACCOUNT_UPDATE',
          surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
          operation: 'totp.account.update',
          outcomeCode: 'SUCCESS',
          capability: 'totp.account.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['AUTHENTICATED_SUBJECT'],
          targetType: 'TOTP_ACCOUNT',
          targetId: updated.id,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          payload: {
            accountName: updated.accountName,
            backupKeyConfigured: Boolean(updated.backupKey),
          },
        },
        tx
      );
      return updated;
    });
  }

  /**
   * Create a delegation consent token.
   */
  async createTOTPDelegationConsent(
    _resourceId: string,
    _totpAccountId: string,
    _requesterId: string,
    _operation: string,
    _authFamily: string
  ): Promise<TOTPDelegationConsent> {
    throw new ForbiddenError(
      'TOTP delegation consent is deferred until request-bound authenticated custody consent lands in #120/#122.'
    );
  }

  /**
   * Generate and reveal a TOTP code if authorized.
   */
  async revealTOTPCode(
    resourceId: string,
    principal: Principal | string,
    grantId?: string,
    consentId?: string
  ): Promise<string> {
    const { repositories } = this.deps;
    const userPrincipal: Principal =
      typeof principal === 'string' ? createDiscordPrincipal(principal) : principal;

    const actorId = userPrincipal.subjectId;

    // Check capability 'totp.code.read'
    const evalResult = await hasCapability(repositories, userPrincipal, 'totp.code.read', {
      resourceId,
    });

    const authorized = evalResult.allowed;

    const resource = await repositories.resources.findById(resourceId);
    if (!resource || !resource.totpAccountId) {
      throw new Error('No 2FA account linked to this resource.');
    }

    const accountMetadata = await repositories.totp.findMetadataById(resource.totpAccountId);
    if (!accountMetadata) {
      throw new Error('TOTP account not found.');
    }

    if (!authorized) {
      void grantId;
      void consentId;
      throw new AccessDeniedError(
        'Delegated TOTP reveal is deferred until request-bound consent and grant authority lands in #120/#122.'
      );
    }

    // Load value-bearing custody data only after authorization and, for delegated access, after
    // both exact one-time authorities have been consumed atomically.
    const account = await repositories.totp.findById(resource.totpAccountId);
    if (!account || account.version !== accountMetadata.version) {
      throw new AccessDeniedError('TOTP account changed during authorization.');
    }

    // Persist the authorized reveal record before materializing the code.
    await this.audit.log({
      eventFamily: 'TOTP_LIFECYCLE',
      eventType: 'TOTP_CODE_REVEAL',
      surface: 'DOMAIN',
      operation: 'totp.code.reveal',
      outcomeCode: 'SUCCESS',
      capability: 'totp.code.read',
      decisionCode: 'ALLOW',
      reasonCode: authorized ? evalResult.reasonCode : 'GRANT',
      authoritySources: authorized ? evalResult.authoritySources : ['APPROVAL_GRANT'],
      targetType: 'TOTP_ACCOUNT',
      targetId: account.id,
      actorType: userPrincipal.type,
      principalId: userPrincipal.id,
      actorId,
      authKind: userPrincipal.authKind,
      resourceId,
      grantId: authorized ? null : grantId,
      payload: { totpAccountId: account.id },
    });

    const code = generateTOTPCode(account);

    return code;
  }

  /**
   * Reveal recovery key if authorized.
   */
  async revealTOTPRecoveryKey(totpAccountId: string, actorId: string): Promise<string> {
    const { repositories } = this.deps;

    // Check capability 'totp.recovery.read'
    const principal = createDiscordPrincipal(actorId);
    const evalResult = await hasCapability(repositories, principal, 'totp.recovery.read', {
      totpAccountId,
    });

    if (!evalResult.allowed) {
      throw new Error(
        'Access denied. Only the personal owner of the TOTP account can view the recovery key.'
      );
    }

    const account = await repositories.totp.findById(totpAccountId);
    if (!account) {
      throw new Error('TOTP account not found.');
    }

    if (!account.backupKey) {
      throw new Error('No recovery key/backup key configured for this account.');
    }

    // Persist the authorized reveal record before returning recovery material.
    await this.audit.log({
      eventFamily: 'TOTP_LIFECYCLE',
      eventType: 'TOTP_RECOVERY_REVEAL',
      surface: 'DOMAIN',
      operation: 'totp.recovery.reveal',
      outcomeCode: 'SUCCESS',
      capability: 'totp.recovery.read',
      decisionCode: 'ALLOW',
      reasonCode: evalResult.reasonCode,
      authoritySources: evalResult.authoritySources,
      targetType: 'TOTP_ACCOUNT',
      targetId: totpAccountId,
      actorType: principal.type,
      principalId: principal.id,
      actorId,
      authKind: principal.authKind,
      payload: { totpAccountId },
    });

    return account.backupKey;
  }

  /**
   * Create a new field for a resource.
   */
  async createField(
    resourceId: string,
    name: string,
    value: string,
    principal: Principal
  ): Promise<ResourceField> {
    const { repositories } = this.deps;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(`Resource not found: ${resourceId}`);
    }

    // Check if field already exists
    const existing = await repositories.resourceFields.findByResourceAndName(resourceId, name);
    if (existing) {
      throw new DuplicateError(`Field '${name}' already exists for this resource`);
    }

    try {
      const field = await this.runTransaction(async (tx) => {
        const createdField = await repositories.resourceFields.create(
          {
            resourceId,
            name,
            value,
          },
          tx
        );

        await this.audit.log(
          {
            eventFamily: 'SECRET_LIFECYCLE',
            eventType: 'SECRET_CREATE',
            surface: 'DOMAIN',
            operation: 'secret.create',
            outcomeCode: 'SUCCESS',
            capability: 'secret.write',
            decisionCode: 'ALLOW',
            reasonCode: 'OWNER',
            authoritySources: ['RESOURCE_OWNER'],
            targetType: 'SECRET',
            targetId: `${resourceId}:${name}`,
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
            resourceId,
            payload: { fieldName: name }, // Redacted value!
          },
          tx
        );
        return createdField;
      });

      logger.info('Created resource field', {
        resourceId,
        fieldName: name,
      });

      return field;
    } catch (err) {
      logger.error('Failed to create field atomically', {
        resourceId,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * List all fields for a resource.
   * Note: This method returns full field objects, including their values.
   * Access control must be handled by the caller to ensure only authorized users can see these values.
   */
  async listFields(resourceId: string): Promise<ResourceField[]> {
    const { repositories } = this.deps;
    return repositories.resourceFields.findByResourceId(resourceId);
  }

  async listFieldsMetadata(resourceId: string): Promise<ResourceFieldMetadata[]> {
    const { repositories } = this.deps;
    return repositories.resourceFields.findMetadataByResourceId(resourceId);
  }

  /**
   * Get a specific field for a resource.
   */
  async getField(resourceId: string, name: string): Promise<ResourceField | null> {
    const { repositories } = this.deps;
    return repositories.resourceFields.findByResourceAndName(resourceId, name);
  }

  async revealField(
    resourceId: string,
    name: string,
    principal: Principal
  ): Promise<ResourceField | null> {
    const decision = await hasCapability(this.deps.repositories, principal, 'secret.value.read', {
      resourceId,
      fieldName: name,
    });
    await this.audit.log({
      eventFamily: 'AUTHORIZATION',
      eventType: 'AUTHORIZATION_DECISION',
      surface: 'HTTP',
      operation: 'secret.value.read.authorize',
      outcomeCode: decision.allowed ? 'SUCCESS' : 'DENIED',
      capability: 'secret.value.read',
      decisionCode: decision.decisionCode,
      reasonCode: decision.reasonCode,
      authoritySources: decision.authoritySources,
      targetType: 'SECRET',
      targetId: `${resourceId}:${name}`,
      actorType: principal.type,
      principalId: principal.id,
      actorId: principal.subjectId,
      authKind: principal.authKind,
      resourceId,
      payload: { fieldName: name },
    });
    if (!decision.allowed) return null;
    await this.audit.log({
      eventFamily: 'SECRET_LIFECYCLE',
      eventType: 'SECRET_REVEAL',
      surface: 'HTTP',
      operation: 'secret.value.reveal',
      outcomeCode: 'SUCCESS',
      capability: 'secret.value.read',
      decisionCode: 'ALLOW',
      reasonCode: decision.reasonCode,
      authoritySources: decision.authoritySources,
      targetType: 'SECRET',
      targetId: `${resourceId}:${name}`,
      actorType: principal.type,
      principalId: principal.id,
      actorId: principal.subjectId,
      authKind: principal.authKind,
      resourceId,
      payload: { fieldName: name },
    });
    return this.deps.repositories.resourceFields.findByResourceAndName(resourceId, name);
  }

  async getFieldMetadata(resourceId: string, name: string): Promise<ResourceFieldMetadata | null> {
    const { repositories } = this.deps;
    return repositories.resourceFields.findMetadataByResourceAndName(resourceId, name);
  }

  /**
   * Delete a field from a resource.
   */
  async deleteField(resourceId: string, name: string, principal: Principal): Promise<void> {
    const { repositories } = this.deps;

    const field = await repositories.resourceFields.findByResourceAndName(resourceId, name);
    if (!field) {
      // Idempotent success or throw? Let's verify standard behavior.
      // Usually idempotent is safer for APIs.
      return;
    }

    try {
      await this.runTransaction(async (tx) => {
        await repositories.resourceFields.delete(field.id, tx);

        await this.audit.log(
          {
            eventFamily: 'SECRET_LIFECYCLE',
            eventType: 'SECRET_DELETE',
            surface: 'DOMAIN',
            operation: 'secret.delete',
            outcomeCode: 'SUCCESS',
            capability: 'secret.delete',
            decisionCode: 'ALLOW',
            reasonCode: 'OWNER',
            authoritySources: ['RESOURCE_OWNER'],
            targetType: 'SECRET',
            targetId: `${resourceId}:${name}`,
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
            resourceId,
            payload: { fieldName: name },
          },
          tx
        );
      });

      logger.info('Deleted resource field', {
        resourceId,
        fieldName: name,
      });
    } catch (err) {
      logger.error('Failed to delete field atomically', {
        resourceId,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Create or update a resource field.
   *
   * If a field with the given name already exists for the resource, its value is updated.
   * Otherwise, a new field is created.
   *
   * @param resourceId - The identifier of the resource to which the field belongs.
   * @param name - The name of the field to create or update.
   * @param value - The value to set for the field.
   * @returns A promise that resolves to the created or updated {@link ResourceField}.
   * @throws ResourceNotFoundError If the specified resource does not exist.
   */
  /**
   * Set secrets in batch with strict validation constraints and transactional execution.
   */
  async setSecrets(
    resourceId: string,
    secrets: Record<string, string>,
    actorPrincipal: Principal
  ): Promise<void> {
    const { repositories } = this.deps;

    // 1. Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(`Resource not found: ${resourceId}`);
    }

    // 2. Validate batch constraints
    const entries = Object.entries(secrets);
    if (entries.length > 100) {
      throw new ValidationError('Secret batch count exceeds maximum of 100.');
    }

    let totalSize = 0;
    const keyPattern = /^[a-zA-Z0-9_-]+$/;

    for (const [key, value] of entries) {
      if (!keyPattern.test(key)) {
        throw new ValidationError(
          `Invalid secret key format: "${key}". Only alphanumeric, underscores, and hyphens are allowed.`
        );
      }
      if (key.length > 250) {
        throw new ValidationError(`Secret key "${key}" exceeds maximum length of 250 characters.`);
      }
      if (value.length > 65536) {
        throw new ValidationError(`Secret value for "${key}" exceeds maximum size of 64KB.`);
      }
      totalSize += key.length + value.length;
    }

    if (totalSize > 524288) {
      throw new ValidationError('Total secret batch size exceeds maximum of 512KB.');
    }

    // 3. Perform batch mutation inside a single database transaction
    await this.runTransaction(async (tx) => {
      for (const [key, value] of entries) {
        const existing = await repositories.resourceFields.findByResourceAndName(resourceId, key);
        let eventType: 'SECRET_CREATE' | 'SECRET_UPDATE' = 'SECRET_CREATE';

        if (existing) {
          await repositories.resourceFields.update(existing.id, value, tx);
          eventType = 'SECRET_UPDATE';
        } else {
          await repositories.resourceFields.create(
            {
              resourceId,
              name: key,
              value,
            },
            tx
          );
        }

        await this.audit.log(
          {
            eventFamily: 'SECRET_LIFECYCLE',
            eventType,
            surface: 'DOMAIN',
            operation: existing ? 'secret.update' : 'secret.create',
            outcomeCode: 'SUCCESS',
            capability: 'secret.write',
            decisionCode: 'ALLOW',
            reasonCode: actorPrincipal.type === 'SERVICE' ? 'SERVICE' : 'AUTHENTICATED_SUBJECT',
            authoritySources:
              actorPrincipal.type === 'SERVICE' ? ['SCOPED_CREDENTIAL'] : ['AUTHENTICATED_SUBJECT'],
            targetType: 'SECRET',
            targetId: `${resourceId}:${key}`,
            actorType: actorPrincipal.type === 'SERVICE' ? 'SERVICE' : 'DISCORD_USER',
            principalId: actorPrincipal.id,
            actorId: actorPrincipal.subjectId,
            authKind: actorPrincipal.authKind,
            resourceId,
            payload: { fieldName: key },
          },
          tx
        );
      }
    });
  }

  async upsertField(resourceId: string, name: string, value: string): Promise<ResourceField> {
    const { repositories } = this.deps;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(`Resource not found: ${resourceId}`);
    }

    try {
      const field = await this.runTransaction(async (tx) => {
        const existing = await repositories.resourceFields.findByResourceAndName(resourceId, name);
        let resultField;
        let eventType: 'SECRET_CREATE' | 'SECRET_UPDATE' = 'SECRET_CREATE';

        if (existing) {
          resultField = await repositories.resourceFields.update(existing.id, value, tx);
          eventType = 'SECRET_UPDATE';
        } else {
          resultField = await repositories.resourceFields.create(
            {
              resourceId,
              name,
              value,
            },
            tx
          );
        }

        await this.audit.log(
          {
            eventFamily: 'SECRET_LIFECYCLE',
            eventType,
            surface: 'DOMAIN',
            operation: existing ? 'secret.update' : 'secret.create',
            outcomeCode: 'SUCCESS',
            capability: 'secret.write',
            decisionCode: 'ALLOW',
            reasonCode: 'SERVICE',
            authoritySources: ['SCOPED_CREDENTIAL'],
            targetType: 'SECRET',
            targetId: `${resourceId}:${name}`,
            actorType: 'SERVICE',
            principalId: 'service:system',
            actorId: 'system',
            authKind: 'SERVICE',
            resourceId,
            payload: { fieldName: name },
          },
          tx
        );
        return resultField;
      });

      logger.info('Upserted resource field', { resourceId, fieldName: name });
      return field;
    } catch (err) {
      logger.error('Failed to upsert field atomically', {
        resourceId,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/**
 * Container for all services.
 */
export interface Services {
  approval: ApprovalService;
  resource: ResourceService;
  audit: AuditService;
  auth: AuthService;
  project: ProjectService;
  ports: DomainPorts;
}

/**
 * Create all services with the given dependencies.
 */
export function createServices(baseDeps: { repositories: Repositories }): Services {
  const audit = new AuditService(baseDeps);
  const fullDeps: ServiceDependencies = {
    ...baseDeps,
    audit,
  };

  const approval = new ApprovalService(fullDeps);
  fullDeps.approval = approval;
  const resource = new ResourceService(fullDeps);
  const project = new ProjectService(
    baseDeps.repositories.projects,
    resource,
    audit,
    baseDeps.repositories.transaction
  );

  return {
    approval,
    resource,
    audit,
    auth: new AuthService(
      baseDeps.repositories.auth,
      baseDeps.repositories.credentials,
      audit,
      baseDeps.repositories.transaction
    ),
    project,
    ports: new DomainPortsImpl(project, resource, approval, audit, baseDeps.repositories),
  };
}
