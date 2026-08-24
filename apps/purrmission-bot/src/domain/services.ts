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
  TOTPAccountMetadata,
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
  CallbackDestinationMetadataProjection,
} from './models.js';
import type { Repositories } from './repositories.js';
import { logger } from '../logging/logger.js';
import { AuditService, buildOutboxEvent } from './audit.js';
import { AuthService, AccessDeniedError, ForbiddenError } from './auth.js';
import { ProjectService } from './project.js';
import {
  ResourceNotFoundError,
  DuplicateError,
  ValidationError,
  ConflictError,
  NotFoundError,
  DomainAuthorizationError,
} from './errors.js';
import {
  getEffectiveGuardians,
  isEffectiveGuardian,
  isEffectiveOwner,
  hasCapability,
} from './policy.js';
import { createDiscordPrincipal, validatePrincipal } from './principal.js';
import { generateTOTPCode } from './totp.js';
import { encryptValue } from '../infra/crypto.js';
import {
  computeAllKeyedDigestCandidates,
  computeKeyedDigestRecord,
  deterministicUUID,
  KeyManager,
} from './crypto.js';
import { DomainPorts } from './ports.js';
import { resolveTargetVersions } from './target_versions.js';
import { createRepositoryMetadataQueryService } from './metadata_persistence.js';
import type { MetadataQueryService } from './metadata_queries.js';
import { DomainPortsImpl } from './ports_impl.js';
import { correlationStorage } from '../logging/correlationContext.js';
import {
  boundedConsentExpiry,
  CODE_OPERATION,
  createTOTPLinkEnvelope,
  parseTOTPDelegationPolicy,
  validateTOTPLinkEnvelope,
} from './totp_custody.js';
import { rateLimiter } from '../infra/rateLimit.js';

/**
 * Recursively canonicalize JSON values with sorted object keys.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([k1], [k2]) =>
    k1.localeCompare(k2)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`).join(',')}}`;
}

/**
 * Helper to compute canonical payload digest for idempotency.
 */
function computeRequestPayloadDigest(fields: {
  resourceId: string;
  action: string;
  targetKey: string | null;
  canonicalKeyDigest: string | null;
  reason: string | null;
  constraints: Record<string, unknown> | null;
  authFamily: string;
  audience: string;
}): string {
  const normalized = canonicalJsonStringify({
    resourceId: fields.resourceId,
    action: fields.action,
    targetKey: fields.targetKey,
    canonicalKeyDigest: fields.canonicalKeyDigest,
    reason: fields.reason,
    constraints: fields.constraints,
    authFamily: fields.authFamily,
    audience: fields.audience,
  });
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Service dependencies.
 */
export interface ServiceDependencies {
  repositories: Repositories;
  audit: AuditService;
  approval?: ApprovalService;
  rateLimiter?: import('../infra/rateLimit.js').RateLimiter;
}

/**
 * Input for creating an approval request.
 */
export interface CreateApprovalRequestInput {
  resourceId: string;
  principal?: Principal;
  context?: Record<string, unknown>;
  callbackUrl?: string;
  expiresInMs?: number;
  // V2 typed fields:
  requesterId?: string;
  requesterType?: string;
  authKind?: string;
  authFamily?: string;
  audience?: string;
  action?: string;
  targetType?: string;
  targetId?: string | null;
  targetKey?: string | null;
  canonicalKeys?: readonly string[] | null;
  reason?: string;
  constraints?: Record<string, unknown> | null;
  idempotencyKey?: string;
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
  private readonly rateLimiter: import('../infra/rateLimit.js').RateLimiter;

  constructor(deps: ServiceDependencies) {
    if (!deps.audit) throw new TypeError('ApprovalService requires an audit dependency.');
    this.deps = deps;
    this.audit = deps.audit;
    this.rateLimiter = deps.rateLimiter ?? rateLimiter;
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

    if (input.expiresInMs !== undefined && input.expiresInMs <= 0) {
      return {
        success: false,
        error: 'expiresInMs must be a positive number',
      };
    }

    // Resolve principal / requester provenance
    const principal =
      input.principal ||
      createDiscordPrincipal(
        input.requesterId ||
          (input.context?.requesterId ? String(input.context.requesterId) : 'legacy')
      );
    const requesterId = principal.subjectId;
    const requesterType = principal.type;
    const authKind = principal.authKind;
    const authFamily =
      input.authFamily ||
      (principal.type === 'PAWTHY_TOKEN'
        ? 'PAWTHY_CLI'
        : principal.type === 'RESOURCE_API_KEY'
          ? 'RESOURCE_KEY'
          : principal.type === 'SERVICE'
            ? 'SERVICE'
            : 'DISCORD');
    const audience = input.audience || principal.audience || 'purrmission-bot';
    const action = input.action || 'resource.view';
    const reason = input.reason || null;
    const constraints = input.constraints || null;
    const idempotencyKey = input.idempotencyKey || null;

    // Actor/target rate limit check
    const rateLimitKey = `${requesterId}:${input.resourceId}:approval-create`;
    if (!this.rateLimiter.check(rateLimitKey)) {
      return {
        success: false,
        error: 'Rate limit exceeded for approval request creation',
      };
    }

    // Target and version resolution
    const suppliedTargetKey = input.targetKey || null;
    const versions = await resolveTargetVersions(
      repositories,
      input.resourceId,
      action,
      suppliedTargetKey,
      input.canonicalKeys
    );
    if (!versions) {
      return { success: false, error: 'The exact request target does not exist.' };
    }
    const {
      targetType,
      targetId,
      targetKey,
      canonicalKeySet,
      canonicalKeyDigest,
      targetVersion,
      policyVersion,
      projectId,
      environmentId,
    } = versions;

    // Compute canonical payload digest
    const payloadDigest = computeRequestPayloadDigest({
      resourceId: input.resourceId,
      action,
      targetKey,
      canonicalKeyDigest,
      reason,
      constraints,
      authFamily,
      audience,
    });

    // Idempotency Key Handling
    if (idempotencyKey) {
      const existingByIdempotency = await repositories.approvalRequests.findByIdempotencyKey(
        requesterId,
        idempotencyKey
      );
      if (existingByIdempotency) {
        if (existingByIdempotency.payloadDigest === payloadDigest) {
          return {
            success: true,
            request: existingByIdempotency,
            resource,
            guardians: await getEffectiveGuardians(repositories, input.resourceId),
          };
        }
        throw new ConflictError(
          'Idempotency key reuse with different request parameters is forbidden (409 Conflict).'
        );
      }
    }

    // Active Pending Deduplication
    const existingPending = await repositories.approvalRequests.findPendingSignature(
      input.resourceId,
      requesterId,
      action,
      authFamily,
      audience,
      canonicalKeyDigest,
      targetKey
    );
    if (existingPending) {
      return {
        success: true,
        request: existingPending,
        resource,
        guardians: await getEffectiveGuardians(repositories, input.resourceId),
      };
    }

    // Verify guardians exist
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
            projectId,
            environmentId,
            status: 'PENDING',
            context: input.context || null,
            requesterId,
            requesterType,
            authKind,
            authFamily,
            audience,
            action,
            targetType,
            targetId,
            targetKey,
            canonicalKeySet,
            canonicalKeyDigest,
            targetVersion,
            policyVersion,
            reason,
            constraints,
            callbackUrl: input.callbackUrl,
            idempotencyKey,
            payloadDigest,
            deliveryState: 'PENDING',
            createdAt: new Date(),
            expiresAt,
          },
          tx
        );

        await this.audit.log(
          {
            eventFamily: 'REQUEST_GRANT_LIFECYCLE',
            eventType: 'REQUEST_CREATE',
            surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
            operation: 'request.create',
            outcomeCode: 'SUCCESS',
            capability: 'request.create',
            decisionCode: 'ALLOW',
            reasonCode: 'AUTHENTICATED_SUBJECT',
            authoritySources: ['AUTHENTICATED_SUBJECT'],
            targetType: 'APPROVAL_REQUEST',
            targetId: req.id,
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
            projectId: projectId ?? undefined,
            environmentId: environmentId ?? undefined,
            resourceId: input.resourceId,
            requestId: req.id,
            correlationId: principal.correlationId,
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

        // Enqueue Outbox event to notify each guardian independently and deterministically
        if (guardians.length > 0) {
          for (const guardian of guardians) {
            const deliveryId = deterministicUUID(req.id + '_GUARDIAN_' + guardian.discordUserId);
            const delivery = buildOutboxEvent({
              id: deliveryId,
              deliveryId,
              recipientId: guardian.discordUserId,
              eventType: 'REQUEST_CREATED_GUARDIAN_NOTIFICATION',
              resourceId: input.resourceId,
              requestId: req.id,
              causationId: req.id,
              payload: {
                requestId: req.id,
                resourceId: input.resourceId,
                recipientId: guardian.discordUserId,
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
                actorType: principal.type,
                principalId: principal.id,
                actorId: principal.subjectId,
                authKind: principal.authKind,
                resourceId: input.resourceId,
                requestId: req.id,
                correlationId: delivery.correlationId,
                causationId: delivery.causationId,
                payload: {
                  deliveryId: delivery.id,
                  deliveryType: 'REQUEST_CREATED_GUARDIAN_NOTIFICATION',
                  recipientId: guardian.discordUserId,
                },
              },
              tx
            );
          }
        } else {
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
              actorType: principal.type,
              principalId: principal.id,
              actorId: principal.subjectId,
              authKind: principal.authKind,
              resourceId: input.resourceId,
              requestId: req.id,
              correlationId: delivery.correlationId,
              causationId: delivery.causationId,
              payload: { deliveryType: 'REQUEST_CREATED' },
            },
            tx
          );
        }

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
      if (idempotencyKey) {
        const concurrentReq = await repositories.approvalRequests.findByIdempotencyKey(
          requesterId,
          idempotencyKey
        );
        if (concurrentReq) {
          if (concurrentReq.payloadDigest === payloadDigest) {
            return {
              success: true,
              request: concurrentReq,
              resource,
              guardians: await getEffectiveGuardians(repositories, input.resourceId),
            };
          }
          throw new ConflictError(
            'Idempotency key reuse with different request parameters is forbidden (409 Conflict).'
          );
        }
      }
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
   * @param consentId - Optional TOTP delegation consent ID for delegated TOTP approvals
   * @returns The result of recording the decision
   */
  async recordDecision(
    requestId: string,
    decision: ApprovalDecision,
    principal: Principal,
    consentId?: string
  ): Promise<DecisionResult> {
    const { repositories } = this.deps;
    const resolverId = principal.subjectId;
    const resolverType = principal.type;

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
        await repositories.approvalRequests.expire(requestId, tx);
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
          guardianId: resolverId,
        });
        return {
          success: false,
          error: 'Requesters cannot approve their own requests.',
        };
      }

      logger.warn('Decision made without request.decide capability', {
        requestId,
        discordUserId: resolverId,
        resourceId: request.resourceId,
        reasonCode: authorization.reasonCode,
      });
      return {
        success: false,
        error: 'User cannot decide requests for this resource',
      };
    }

    const newStatus = decision === 'APPROVE' ? 'APPROVED' : 'DENIED';

    try {
      const { updatedRequest, grant } = await this.runTransaction(async (tx) => {
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

        let issuedGrant: ApprovalGrant | undefined;
        let grantExpiresAt: Date = new Date(Date.now() + 15 * 60 * 1000);
        let consumedConsentRecord: TOTPDelegationConsent | null = null;

        if (decision === 'APPROVE') {
          if (request.action === 'totp.code.read') {
            // TOTP grants expire in 5 minutes (300 seconds) max
            grantExpiresAt = new Date(Date.now() + 5 * 60 * 1000);

            // Check if requester is TOTP custody owner:
            const resource = await repositories.resources.findById(request.resourceId, tx);
            if (resource && resource.totpAccountId) {
              const accountMetadata = await repositories.totp.findMetadataById(
                resource.totpAccountId
              );
              if (accountMetadata && accountMetadata.ownerDiscordUserId !== request.requesterId) {
                // Delegated TOTP access: consent consumption is MANDATORY
                let consent: TOTPDelegationConsent | null = null;
                if (consentId) {
                  consent = await repositories.totp.findDelegationConsentById(consentId);
                }
                if (!consent) {
                  throw new AccessDeniedError(
                    'Delegated TOTP approval requires an active, unconsumed TOTP delegation consent from the custody owner.'
                  );
                }

                if (
                  consent.authFamily !== request.authFamily ||
                  consent.audience !== request.audience ||
                  consent.operation !== request.action ||
                  consent.requesterId !== request.requesterId ||
                  consent.resourceId !== request.resourceId
                ) {
                  throw new AccessDeniedError(
                    'TOTP delegation consent bindings do not match the requested operation, auth family, audience, or subject.'
                  );
                }

                grantExpiresAt = new Date(
                  Math.min(Date.now() + 5 * 60 * 1000, consent.maxGrantExpiresAt.getTime())
                );

                const consumedConsent = await repositories.totp.consumeDelegationConsent(
                  {
                    id: consent.id,
                    resourceId: request.resourceId,
                    totpAccountId: consent.totpAccountId,
                    operation: request.action,
                    requesterId: request.requesterId,
                    ownerDiscordUserId: consent.ownerDiscordUserId,
                    authFamily: request.authFamily,
                    audience: request.audience,
                    accountVersion: consent.accountVersion,
                    linkVersion: consent.linkVersion,
                    grantExpiresAt,
                  },
                  tx
                );
                if (!consumedConsent) {
                  throw new AccessDeniedError(
                    'TOTP delegation consent is invalid, expired, or was already consumed.'
                  );
                }
                consumedConsentRecord = consent;
              }
            }
          }
        }

        // Atomic conditional transition
        const transitioned = await repositories.approvalRequests.transitionDecision(
          requestId,
          newStatus,
          resolverId,
          resolverType,
          tx
        );
        if (!transitioned) {
          throw new ConflictError(
            'Request is no longer pending or was decided/cancelled/expired concurrently.'
          );
        }

        if (decision === 'APPROVE') {
          if (consumedConsentRecord) {
            await this.audit.log(
              {
                eventFamily: 'TOTP_LIFECYCLE',
                eventType: 'TOTP_DELEGATION_CONSENT_CONSUME',
                surface: 'DOMAIN',
                operation: 'totp.delegation-consent.consume',
                outcomeCode: 'SUCCESS',
                decisionCode: 'ALLOW',
                reasonCode: 'AUTHENTICATED_SUBJECT',
                authoritySources: ['TOTP_OWNER'],
                targetType: 'TOTP_ACCOUNT',
                targetId: consumedConsentRecord.totpAccountId,
                actorType: principal.type,
                principalId: principal.id,
                actorId: principal.subjectId,
                authKind: principal.authKind,
                resourceId: request.resourceId,
                requestId: request.id,
                payload: { totpAccountId: consumedConsentRecord.totpAccountId },
              },
              tx
            );
          }

          issuedGrant = await repositories.approvalGrants.create(
            {
              id: crypto.randomUUID(),
              requestId: request.id,
              resourceId: request.resourceId,
              projectId: request.projectId,
              environmentId: request.environmentId,
              requesterId: request.requesterId,
              requesterType: request.requesterType,
              authKind: request.authKind,
              authFamily: request.authFamily,
              audience: request.audience,
              action: request.action,
              targetType: request.targetType,
              targetId: request.targetId,
              targetKey: request.targetKey,
              canonicalKeySet: request.canonicalKeySet,
              canonicalKeyDigest: request.canonicalKeyDigest,
              targetVersion: request.targetVersion,
              policyVersion: request.policyVersion,
              constraints: request.constraints,
              resolverId,
              resolverType,
              resolverEvidence: {
                decision,
                resolvedAt: new Date().toISOString(),
                authoritySources: authorization.authoritySources,
                reasonCode: authorization.reasonCode,
              },
              createdAt: new Date(),
              expiresAt: grantExpiresAt,
            },
            tx
          );

          await this.audit.log(
            {
              eventFamily: 'REQUEST_GRANT_LIFECYCLE',
              eventType: 'GRANT_ISSUE',
              surface: 'DOMAIN',
              operation: 'grant.issue',
              outcomeCode: 'SUCCESS',
              capability: 'request.decide',
              decisionCode: 'ALLOW',
              reasonCode: authorization.reasonCode,
              authoritySources: authorization.authoritySources,
              targetType: 'APPROVAL_GRANT',
              targetId: issuedGrant.id,
              actorType: principal.type,
              principalId: principal.id,
              actorId: resolverId,
              authKind: principal.authKind,
              resourceId: request.resourceId,
              requestId: request.id,
              grantId: issuedGrant.id,
              payload: {
                action: issuedGrant.action,
                targetKey: issuedGrant.targetKey,
                expiresAt: issuedGrant.expiresAt.toISOString(),
              },
            },
            tx
          );
        }

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
            actorId: resolverId,
            authKind: principal.authKind,
            resolverType: principal.type,
            resolverId: principal.subjectId,
            resourceId: request.resourceId,
            requestId: request.id,
            grantId: issuedGrant ? issuedGrant.id : null,
            payload: {
              decision,
              requesterId: request.requesterId,
            },
          },
          tx
        );

        // Enqueue callback delivery events for all active registered destinations
        const activeDestinations = await repositories.callbackDestinations.findByResourceId(
          request.resourceId,
          'ACTIVE',
          tx
        );

        if (activeDestinations.length > 0) {
          for (const dest of activeDestinations) {
            const deliveryId = deterministicUUID(
              request.id + '_CALLBACK_' + dest.id + '_' + newStatus
            );
            const delivery = buildOutboxEvent({
              id: deliveryId,
              deliveryId,
              destinationId: dest.id,
              eventType: 'APPROVAL_CALLBACK',
              resourceId: request.resourceId,
              requestId: request.id,
              causationId: request.id,
              payload: {
                requestId: request.id,
                destinationId: dest.id,
                status: newStatus,
                targetVersion: request.targetVersion,
                grantId: issuedGrant ? issuedGrant.id : null,
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
                payload: {
                  deliveryId: delivery.id,
                  destinationId: dest.id,
                  deliveryType: 'APPROVAL_CALLBACK',
                },
              },
              tx
            );
          }
        } else {
          // Enqueue single fallback callback delivery event deterministically
          const delivery = buildOutboxEvent({
            id: deterministicUUID(request.id + '_APPROVAL_CALLBACK'),
            eventType: 'APPROVAL_CALLBACK',
            resourceId: request.resourceId,
            requestId: request.id,
            causationId: request.id,
            payload: {
              requestId: request.id,
              status: newStatus,
              targetVersion: request.targetVersion,
              grantId: issuedGrant ? issuedGrant.id : null,
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
        }

        const updReq: ApprovalRequest = {
          ...request,
          status: newStatus,
          resolvedBy: resolverId,
          resolvedByType: resolverType,
          resolvedAt: new Date(),
        };

        return { updatedRequest: updReq, grant: issuedGrant };
      });

      logger.info('Recorded decision on approval request', {
        requestId,
        decision,
        byGuardianDiscordId: resolverId,
        newStatus,
      });

      const result: DecisionResult = {
        success: true,
        request: updatedRequest,
        grant,
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
      if (err instanceof AccessDeniedError || err instanceof ConflictError) {
        return {
          success: false,
          error: err.message,
        };
      }
      logger.error('Failed to record decision atomically', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Cancel an approval request by its requester.
   */
  async cancelApprovalRequest(
    requestId: string,
    principal: Principal
  ): Promise<{ success: boolean; error?: string }> {
    const { repositories } = this.deps;
    const request = await repositories.approvalRequests.findById(requestId);
    if (!request) {
      return { success: false, error: `Request not found: ${requestId}` };
    }

    const authorization = await hasCapability(repositories, principal, 'request.cancel-own', {
      requestId,
      resourceId: request.resourceId,
    });
    if (!authorization.allowed) {
      return { success: false, error: 'Only the requester may cancel their own approval request.' };
    }

    try {
      await this.runTransaction(async (tx) => {
        const cancelled = await repositories.approvalRequests.cancel(
          requestId,
          principal.subjectId,
          tx
        );
        if (!cancelled) {
          throw new ConflictError(
            'Request is no longer pending or was cancelled/decided/expired concurrently.'
          );
        }

        await this.audit.log(
          {
            eventFamily: 'REQUEST_GRANT_LIFECYCLE',
            eventType: 'REQUEST_CANCEL',
            surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
            operation: 'request.cancel-own',
            outcomeCode: 'SUCCESS',
            capability: 'request.cancel-own',
            decisionCode: 'ALLOW',
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
      });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
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
    targetKey: string | null,
    canonicalKeyDigest?: string | null
  ): Promise<ApprovalGrant | null> {
    if (!this.deps.repositories.approvalGrants) {
      return null;
    }
    return this.deps.repositories.approvalGrants.findActiveUnconsumed(
      resourceId,
      requesterId,
      action,
      targetKey,
      canonicalKeyDigest
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
    options?: {
      requiredAuthFamily?: string;
      requiredAudience?: string;
      canonicalKeyDigest?: string | null;
    },
    tx?: Prisma.TransactionClient
  ): Promise<ApprovalGrant> {
    const { repositories } = this.deps;
    if (!repositories.approvalGrants) {
      throw new AccessDeniedError('Approval grants repository not available.');
    }

    const grant = await repositories.approvalGrants.findById(grantId, tx);
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

    // Revalidate authFamily and audience
    if (options?.requiredAuthFamily && grant.authFamily !== options.requiredAuthFamily) {
      throw new AccessDeniedError('Auth family mismatch on approval grant.');
    }
    if (options?.requiredAudience && grant.audience !== options.requiredAudience) {
      throw new AccessDeniedError('Audience mismatch on approval grant.');
    }

    // Revalidate action
    if (grant.action !== action) {
      throw new AccessDeniedError('Action mismatch on approval grant.');
    }

    // Revalidate canonicalKeyDigest
    if (
      options?.canonicalKeyDigest !== undefined &&
      grant.canonicalKeyDigest !== options.canonicalKeyDigest
    ) {
      throw new AccessDeniedError('Canonical key set digest mismatch on approval grant.');
    }

    // Revalidate target version
    if (grant.targetVersion !== currentTargetVersion) {
      throw new AccessDeniedError('Target state version mismatch. Consent has been invalidated.');
    }

    // Revalidate policy version
    if (grant.policyVersion !== currentPolicyVersion) {
      throw new AccessDeniedError('Policy version mismatch. Consent has been invalidated.');
    }

    const consumeFn = async (clientTx: Prisma.TransactionClient) => {
      const consumed = await repositories.approvalGrants.consume(grant.id, clientTx);
      if (!consumed) {
        throw new AccessDeniedError('Failed to consume approval grant atomically.');
      }

      await this.audit.log(
        {
          eventFamily: 'REQUEST_GRANT_LIFECYCLE',
          eventType: 'GRANT_CONSUME',
          surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
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
          payload: {
            action,
            targetKey: grant.targetKey,
            expiresAt: grant.expiresAt.toISOString(),
          },
        },
        clientTx
      );

      return { ...grant, consumedAt: new Date() };
    };

    if (tx) {
      return consumeFn(tx);
    } else {
      return this.runTransaction(consumeFn);
    }
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
  ): Promise<{
    resource: Resource;
    guardian: Guardian;
    plaintextApiKey: string;
    credential: Credential;
  }> {
    if (!tx) {
      return this.runTransaction((transaction) =>
        this.createResource(name, principal, transaction)
      );
    }
    const { repositories } = this.deps;
    const ownerDiscordId = principal.subjectId;

    const plaintextApiKey = 'pur_' + crypto.randomBytes(32).toString('base64url');
    const digestRecord = computeKeyedDigestRecord(plaintextApiKey, 'RESOURCE_API_KEY');

    // Create the resource
    const resource = await repositories.resources.create(
      {
        id: crypto.randomUUID(),
        name,
        mode: 'ONE_OF_N',
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

    const credential = await repositories.credentials.create(
      {
        type: 'RESOURCE_API_KEY',
        subjectId: resource.id,
        name: 'Initial resource API key',
        digest: digestRecord.digest,
        digestKeyId: digestRecord.keyId,
        prefix: plaintextApiKey.substring(0, 12),
        scopes: ['resource.view', 'request.create'],
        audience: 'api',
        targetType: 'RESOURCE',
        targetId: resource.id,
        expiresAt: null,
        revokedAt: null,
        revokedReason: null,
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

    return { resource, guardian, plaintextApiKey, credential };
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
  async verifyApiKey(
    apiKey: string,
    clientIp?: string
  ): Promise<{ resource: Resource; principal: Principal } | null> {
    const { repositories } = this.deps;
    const limiterKey = clientIp ? `resource-credential-validation-failure-check:${clientIp}` : null;

    if (limiterKey && rateLimiter.isLimited(limiterKey)) {
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
        payload: { throttled: true },
      });
      return null;
    }

    // 1. Try new digested credentials lookup
    let credential: Credential | null = null;
    let matchedKeyId: string | null = null;
    for (const candidate of computeAllKeyedDigestCandidates(apiKey, 'RESOURCE_API_KEY')) {
      credential = await repositories.credentials.findByDigest(candidate.digest);
      if (credential) {
        matchedKeyId = candidate.keyId;
        break;
      }
    }

    if (
      credential &&
      credential.type === 'RESOURCE_API_KEY' &&
      credential.digestKeyId === matchedKeyId &&
      credential.audience === 'api' &&
      credential.targetType === 'RESOURCE' &&
      credential.targetId === credential.subjectId &&
      credential.scopes.includes('request.create') &&
      !credential.revokedAt &&
      (!credential.expiresAt || credential.expiresAt > new Date())
    ) {
      const resource = await repositories.resources.findById(credential.targetId);
      if (!resource) return null;
      const acceptedCredential = credential;
      const principal: Principal = {
        type: 'RESOURCE_API_KEY',
        id: credential.id,
        subjectId: resource.id,
        authKind: 'API_KEY',
        scopes: credential.scopes,
        audience: credential.audience,
        credentialTarget: { type: 'RESOURCE', id: resource.id },
        expiresAt: credential.expiresAt,
        createdAt: credential.createdAt,
        lastUsedAt: new Date(),
      };
      await this.runTransaction(async (tx) => {
        if (matchedKeyId !== KeyManager.getActiveKeyId('RESOURCE_API_KEY')) {
          const active = computeKeyedDigestRecord(apiKey, 'RESOURCE_API_KEY');
          await repositories.credentials.updateDigest(
            acceptedCredential.id,
            active.digest,
            active.keyId,
            tx
          );
        }
        await repositories.credentials.updateLastUsed(acceptedCredential.id, tx);
        await this.audit.log(
          {
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
          },
          tx
        );
      });
      return { resource, principal };
    }

    if (limiterKey) {
      rateLimiter.check(limiterKey);
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
    principal: Principal,
    name: string,
    expiresInMs?: number
  ): Promise<{ plaintext: string; credential: Credential }> {
    const { repositories } = this.deps;

    // Verify Resource Authority (actor must be resource owner)
    const decision = await this.evaluateCapability(principal, 'resource.api-key.mint', {
      resourceId,
    });
    const hasOwnerAccess = decision.allowed && decision.decisionCode === 'ALLOW';
    if (!hasOwnerAccess) {
      throw new ForbiddenError('Only the Resource Owner can mint API keys.');
    }

    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(`Resource not found: ${resourceId}`);
    }

    const plaintext = 'pur_' + crypto.randomBytes(32).toString('base64url');
    const digest = computeKeyedDigestRecord(plaintext, 'RESOURCE_API_KEY');
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
            digest: digest.digest,
            digestKeyId: digest.keyId,
            prefix,
            scopes: ['resource.view', 'request.create'],
            audience: 'api',
            targetType: 'RESOURCE',
            targetId: resourceId,
            expiresAt,
            revokedAt: null,
            revokedReason: null,
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
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
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

  async mintServiceCredential(
    resourceId: string,
    principal: Principal,
    serviceName: string,
    name: string,
    scopes: Capability[],
    expiresInMs?: number
  ): Promise<{ plaintext: string; credential: Credential }> {
    const decision = await this.evaluateCapability(principal, 'resource.api-key.mint', {
      resourceId,
    });
    if (!decision.allowed || decision.decisionCode !== 'ALLOW') {
      throw new ForbiddenError('Only the Resource Owner can mint service credentials.');
    }
    if (!(await this.deps.repositories.resources.findById(resourceId))) {
      throw new ResourceNotFoundError(`Resource not found: ${resourceId}`);
    }
    const plaintext = 'pur_svc_' + crypto.randomBytes(32).toString('base64url');
    const digest = computeKeyedDigestRecord(plaintext, 'SERVICE_CREDENTIAL');
    const expiresAt = expiresInMs ? new Date(Date.now() + expiresInMs) : null;
    return this.runTransaction(async (tx) => {
      const credential = await this.deps.repositories.credentials.create(
        {
          type: 'SERVICE_CREDENTIAL',
          subjectId: serviceName,
          name,
          digest: digest.digest,
          digestKeyId: digest.keyId,
          prefix: plaintext.substring(0, 16),
          scopes,
          audience: 'service',
          targetType: 'RESOURCE',
          targetId: resourceId,
          expiresAt,
          revokedAt: null,
          revokedReason: null,
        },
        tx
      );
      await this.audit.log(
        {
          eventFamily: 'AUTHENTICATION',
          eventType: 'SERVICE_CREDENTIAL_MINT',
          surface: 'DOMAIN',
          operation: 'resource.service-credential.mint',
          outcomeCode: 'SUCCESS',
          capability: 'resource.api-key.mint',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: decision.authoritySources,
          targetType: 'CREDENTIAL',
          targetId: credential.id,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId,
          payload: { credentialId: credential.id },
        },
        tx
      );
      return { plaintext, credential };
    });
  }

  async rotateApiKey(
    resourceId: string,
    credentialId: string,
    principal: Principal
  ): Promise<{ plaintext: string; credential: Credential }> {
    const { repositories } = this.deps;
    const decision = await this.evaluateCapability(principal, 'resource.api-key.rotate', {
      resourceId,
    });
    if (!decision.allowed || decision.decisionCode !== 'ALLOW') {
      throw new ForbiddenError('Only the Resource Owner can rotate API keys.');
    }
    return this.runTransaction(async (tx) => {
      const current = await repositories.credentials.findById(credentialId, tx);
      if (
        !current ||
        (current.type !== 'RESOURCE_API_KEY' && current.type !== 'SERVICE_CREDENTIAL') ||
        current.targetType !== 'RESOURCE' ||
        current.targetId !== resourceId ||
        current.revokedAt
      ) {
        throw new ForbiddenError('Credential is not eligible for rotation.');
      }
      const purpose =
        current.type === 'SERVICE_CREDENTIAL' ? 'SERVICE_CREDENTIAL' : 'RESOURCE_API_KEY';
      const plaintext =
        (current.type === 'SERVICE_CREDENTIAL' ? 'pur_svc_' : 'pur_') +
        crypto.randomBytes(32).toString('base64url');
      const digest = computeKeyedDigestRecord(plaintext, purpose);
      const credential = await repositories.credentials.create(
        {
          type: current.type,
          subjectId: current.subjectId,
          name: current.name,
          digest: digest.digest,
          digestKeyId: digest.keyId,
          prefix: plaintext.substring(0, current.type === 'SERVICE_CREDENTIAL' ? 16 : 12),
          scopes: current.scopes,
          audience: current.audience,
          targetType: current.targetType,
          targetId: current.targetId,
          expiresAt: current.expiresAt,
          revokedAt: null,
          revokedReason: null,
        },
        tx
      );
      await repositories.credentials.revoke(current.id, 'rotated', tx);
      await repositories.resources.update(resourceId, { version: crypto.randomUUID() }, tx);
      await this.audit.log(
        {
          eventFamily: 'AUTHENTICATION',
          eventType: 'CREDENTIAL_ROTATE',
          surface: 'DOMAIN',
          operation: 'resource.api-key.rotate',
          outcomeCode: 'SUCCESS',
          capability: 'resource.api-key.rotate',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: ['RESOURCE_OWNER'],
          targetType: 'CREDENTIAL',
          targetId: credential.id,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId,
          payload: { credentialId: credential.id },
        },
        tx
      );
      return { plaintext, credential };
    });
  }

  /**
   * Revoke an API key.
   */
  async revokeApiKey(
    resourceId: string,
    credentialId: string,
    principal: Principal
  ): Promise<void> {
    const { repositories } = this.deps;

    // Verify Resource Authority (actor must be resource owner)
    const decision = await this.evaluateCapability(principal, 'resource.api-key.revoke', {
      resourceId,
    });
    const hasOwnerAccess = decision.allowed && decision.decisionCode === 'ALLOW';
    if (!hasOwnerAccess) {
      throw new ForbiddenError('Only the Resource Owner can revoke credentials.');
    }

    const credential = await repositories.credentials.findById(credentialId);
    if (!credential || credential.targetType !== 'RESOURCE' || credential.targetId !== resourceId) {
      throw new ForbiddenError('Credential is not bound to this Resource.');
    }

    try {
      await this.runTransaction(async (tx) => {
        await repositories.credentials.revoke(credentialId, 'owner-revoked', tx);

        // Update resource version
        await repositories.resources.update(resourceId, { version: crypto.randomUUID() }, tx);

        await this.audit.log(
          {
            eventFamily: 'AUTHENTICATION',
            eventType:
              credential.type === 'SERVICE_CREDENTIAL' ? 'CREDENTIAL_REVOKE' : 'API_KEY_REVOKE',
            surface: 'DOMAIN',
            operation: 'resource.api-key.revoke',
            outcomeCode: 'SUCCESS',
            capability: 'resource.api-key.revoke',
            decisionCode: 'ALLOW',
            reasonCode: 'OWNER',
            authoritySources: ['RESOURCE_OWNER'],
            targetType: 'CREDENTIAL',
            targetId: credentialId,
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
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
  async listApiKeys(resourceId: string, principal: Principal): Promise<Credential[]> {
    const { repositories } = this.deps;

    const decision = await this.evaluateCapability(principal, 'resource.api-key.list', {
      resourceId,
    });
    if (!decision.allowed) {
      throw new Error('Access denied. Only the resource owner may list API keys.');
    }

    return repositories.credentials.findByTarget('RESOURCE', resourceId);
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
    resourceId: string,
    totpAccountId: string,
    principal: Principal,
    consentId: string
  ): Promise<void> {
    const { repositories } = this.deps;
    const decision = await this.evaluateCapability(principal, 'totp.link.manage', {
      resourceId,
      totpAccountId,
      totpLinkOperation: 'LINK',
    });
    if (!decision.allowed || decision.decisionCode !== 'ALLOW') {
      throw new ForbiddenError(decision.safeExplanation);
    }
    await this.runTransaction(async (tx) => {
      const [resource, account, consent] = await Promise.all([
        repositories.resources.findById(resourceId, tx),
        repositories.totp.findMetadataById(totpAccountId, tx),
        repositories.totp.findLinkConsentById(consentId, tx),
      ]);
      if (!resource || !account || !consent) {
        throw new AccessDeniedError('Invalid TOTP link consent.');
      }
      if (
        resource.totpAccountId ||
        consent.usedAt ||
        consent.expiresAt <= new Date() ||
        consent.resourceId !== resourceId ||
        consent.accountId !== totpAccountId ||
        consent.accountVersion !== account.version ||
        consent.ownerDiscordUserId !== account.ownerDiscordUserId ||
        consent.initiatingResourceOwnerId !== principal.subjectId
      ) {
        throw new AccessDeniedError(
          'TOTP link consent is stale, used, or does not match the link.'
        );
      }
      const envelope = createTOTPLinkEnvelope({
        consentId,
        resourceId,
        initiatingResourceOwnerId: principal.subjectId,
        accountOwnerDiscordUserId: account.ownerDiscordUserId,
        accountVersion: account.version,
        linkPolicyVersion: consent.linkPolicyVersion,
        delegationPolicy: parseTOTPDelegationPolicy(consent.delegationPolicy),
      });
      if (!(await repositories.totp.useLinkConsent(consentId, tx))) {
        throw new AccessDeniedError('TOTP link consent was already consumed or expired.');
      }
      await repositories.resources.update(
        resourceId,
        {
          totpAccountId,
          totpDelegationEnvelope: envelope,
          totpLinkVersion: envelope.linkPolicyVersion,
        },
        tx
      );
      await this.audit.log(
        {
          eventFamily: 'TOTP_LIFECYCLE',
          eventType: 'TOTP_LINK',
          surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
          operation: 'totp.link',
          outcomeCode: 'SUCCESS',
          capability: 'totp.link.manage',
          decisionCode: 'ALLOW',
          reasonCode: decision.reasonCode,
          authoritySources: decision.authoritySources,
          targetType: 'TOTP_ACCOUNT',
          targetId: totpAccountId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId,
          payload: { totpAccountId, consentId },
        },
        tx
      );
    });
  }

  /**
   * Unlink TOTP account from a resource.
   */
  async unlinkTOTPAccount(resourceId: string, principal: Principal): Promise<void> {
    const { repositories } = this.deps;
    const actorPrincipal = principal;
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
    if (!unlinkDecision.allowed || unlinkDecision.decisionCode !== 'ALLOW') {
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
            surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
            operation: 'totp.unlink',
            outcomeCode: 'SUCCESS',
            capability: 'totp.link.manage',
            decisionCode: 'ALLOW',
            reasonCode: unlinkDecision.reasonCode,
            authoritySources: unlinkDecision.authoritySources,
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
  async hasLinkedTOTP(resourceId: string): Promise<boolean> {
    const { repositories } = this.deps;

    const resource = await repositories.resources.findById(resourceId);
    if (!resource || !resource.totpAccountId) {
      return false;
    }
    return Boolean(await repositories.totp.findMetadataById(resource.totpAccountId));
  }

  /**
   * Create a link consent for a TOTP account.
   */
  async createTOTPLinkConsent(
    accountId: string,
    resourceId: string,
    principal: Principal,
    initiatingResourceOwnerId: string,
    delegationPolicyInput: Record<string, unknown>
  ): Promise<TOTPLinkConsent> {
    const authority = await hasCapability(
      this.deps.repositories,
      principal,
      'totp.account.manage',
      { totpAccountId: accountId }
    );
    if (!authority.allowed || authority.decisionCode !== 'ALLOW') {
      throw new AccessDeniedError(authority.safeExplanation);
    }
    const [account, resource] = await Promise.all([
      this.deps.repositories.totp.findMetadataById(accountId),
      this.deps.repositories.resources.findMetadataById(resourceId),
    ]);
    if (!account || !resource || account.ownerDiscordUserId !== principal.subjectId) {
      throw new AccessDeniedError(
        'Only the authenticated TOTP custody owner can consent to linking.'
      );
    }
    const initiatingOwnerAuthority = await hasCapability(
      this.deps.repositories,
      createDiscordPrincipal(initiatingResourceOwnerId),
      'totp.link.manage',
      {
        resourceId,
        totpAccountId: accountId,
        totpLinkOperation: 'LINK',
      }
    );
    if (!initiatingOwnerAuthority.allowed || initiatingOwnerAuthority.decisionCode !== 'ALLOW') {
      throw new AccessDeniedError(
        'Link consent must name a current Resource or Project owner as its initiator.'
      );
    }
    const delegationPolicy = parseTOTPDelegationPolicy(delegationPolicyInput);
    return this.runTransaction(async (tx) => {
      const consent = await this.deps.repositories.totp.createLinkConsent(
        {
          accountId,
          resourceId,
          ownerDiscordUserId: principal.subjectId,
          initiatingResourceOwnerId,
          accountVersion: account.version,
          linkPolicyVersion: crypto.randomUUID(),
          delegationPolicy,
          expiresAt: boundedConsentExpiry(),
        },
        tx
      );
      await this.audit.log(
        {
          eventFamily: 'TOTP_LIFECYCLE',
          eventType: 'TOTP_LINK_CONSENT_CREATE',
          surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
          operation: 'totp.link-consent.create',
          outcomeCode: 'SUCCESS',
          capability: 'totp.account.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['TOTP_OWNER'],
          targetType: 'TOTP_ACCOUNT',
          targetId: accountId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId,
          payload: { delegationEnabled: delegationPolicy.allowDelegation },
        },
        tx
      );
      return consent;
    });
  }

  /**
   * Create a personal TOTP account and its required audit event in one transaction.
   * Secret and recovery material are deliberately excluded from the event envelope.
   */
  async createTOTPAccount(
    input: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    principal: Principal
  ): Promise<TOTPAccount> {
    if (!validatePrincipal(principal).valid) {
      throw new AccessDeniedError('Authenticated TOTP custody principal is invalid.');
    }
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
    if (!validatePrincipal(principal).valid) {
      throw new AccessDeniedError('Authenticated TOTP custody principal is invalid.');
    }
    const current = await this.deps.repositories.totp.findMetadataById(account.id);
    if (
      !current ||
      current.ownerDiscordUserId !== principal.subjectId ||
      account.ownerDiscordUserId !== current.ownerDiscordUserId
    ) {
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

  async updateTOTPBackupKey(
    accountName: string,
    backupKey: string,
    principal: Principal
  ): Promise<TOTPAccountMetadata> {
    const account = await this.deps.repositories.totp.findMetadataByOwnerAndName(
      principal.subjectId,
      accountName
    );
    if (!account || account.ownerDiscordUserId !== principal.subjectId) {
      throw new AccessDeniedError('Only the TOTP account owner can update the backup key.');
    }
    const authority = await hasCapability(
      this.deps.repositories,
      principal,
      'totp.account.manage',
      { totpAccountId: account.id }
    );
    if (!authority.allowed || authority.decisionCode !== 'ALLOW') {
      throw new AccessDeniedError(authority.safeExplanation);
    }
    return this.runTransaction(async (tx) => {
      const updated = await this.deps.repositories.totp.updateBackupKey(account.id, backupKey, tx);
      await this.audit.log(
        {
          eventFamily: 'TOTP_LIFECYCLE',
          eventType: 'TOTP_ACCOUNT_UPDATE',
          surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
          operation: 'totp.backup-key.update',
          outcomeCode: 'SUCCESS',
          capability: 'totp.account.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['TOTP_OWNER'],
          targetType: 'TOTP_ACCOUNT',
          targetId: updated.id,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          payload: { accountName: updated.accountName, backupKeyConfigured: true },
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
    input: {
      resourceId: string;
      requesterId: string;
      operation: string;
      authFamily: string;
      audience: string;
    },
    principal: Principal
  ): Promise<TOTPDelegationConsent> {
    return this.runTransaction(async (tx) => {
      const resource = await this.deps.repositories.resources.findById(input.resourceId, tx);
      if (!resource?.totpAccountId) throw new AccessDeniedError('No linked TOTP account.');
      const account = await this.deps.repositories.totp.findMetadataById(
        resource.totpAccountId,
        tx
      );
      if (account) {
        const authority = await hasCapability(
          this.deps.repositories,
          principal,
          'totp.account.manage',
          { totpAccountId: account.id }
        );
        if (!authority.allowed || authority.decisionCode !== 'ALLOW') {
          throw new AccessDeniedError(authority.safeExplanation);
        }
      }
      const envelope = validateTOTPLinkEnvelope(resource.totpDelegationEnvelope);
      if (
        !account ||
        !envelope ||
        account.ownerDiscordUserId !== principal.subjectId ||
        envelope.accountOwnerDiscordUserId !== principal.subjectId ||
        envelope.accountVersion !== account.version ||
        envelope.resourceId !== resource.id ||
        envelope.linkPolicyVersion !== resource.totpLinkVersion
      )
        throw new AccessDeniedError('Only the current authenticated custody owner may delegate.');
      const policy = envelope.delegationPolicy;
      if (
        !policy.allowDelegation ||
        input.operation !== CODE_OPERATION ||
        !policy.allowedOperations.includes(CODE_OPERATION) ||
        !policy.allowedAuthFamilies.includes(input.authFamily) ||
        !policy.allowedAudiences.includes(input.audience)
      )
        throw new AccessDeniedError(
          'The current TOTP link policy does not permit this delegation.'
        );
      const expiresAt = boundedConsentExpiry();
      const maxGrantExpiresAt = new Date(
        Math.min(expiresAt.getTime(), Date.now() + policy.maxGrantTtlSeconds * 1000)
      );
      const consent = await this.deps.repositories.totp.createDelegationConsent(
        {
          resourceId: resource.id,
          totpAccountId: account.id,
          operation: CODE_OPERATION,
          requesterId: input.requesterId,
          ownerDiscordUserId: principal.subjectId,
          authFamily: input.authFamily,
          audience: input.audience,
          accountVersion: account.version,
          linkVersion: resource.totpLinkVersion,
          maxGrantExpiresAt,
          expiresAt,
        },
        tx
      );
      await this.audit.log(
        {
          eventFamily: 'TOTP_LIFECYCLE',
          eventType: 'TOTP_DELEGATION_CONSENT_CREATE',
          surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
          operation: 'totp.delegation-consent.create',
          outcomeCode: 'SUCCESS',
          capability: 'totp.account.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['TOTP_OWNER'],
          targetType: 'TOTP_ACCOUNT',
          targetId: account.id,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId: resource.id,
          payload: {
            action: CODE_OPERATION,
            authFamily: input.authFamily,
            audience: input.audience,
          },
        },
        tx
      );
      return consent;
    });
  }

  /**
   * Generate and reveal a TOTP code if authorized.
   */
  async revealTOTPCode(
    resourceId: string,
    principal: Principal,
    grantId?: string,
    consentId?: string
  ): Promise<string> {
    const { repositories } = this.deps;
    const userPrincipal = principal;

    const actorId = userPrincipal.subjectId;

    // Check capability 'totp.code.read'
    const evalResult = await hasCapability(repositories, userPrincipal, 'totp.code.read', {
      resourceId,
    });

    const resource = await repositories.resources.findById(resourceId);
    if (!resource || !resource.totpAccountId) {
      throw new Error('No 2FA account linked to this resource.');
    }

    const accountMetadata = await repositories.totp.findMetadataById(resource.totpAccountId);
    if (!accountMetadata) {
      throw new Error('TOTP account not found.');
    }

    const linkEnvelope = validateTOTPLinkEnvelope(resource.totpDelegationEnvelope);
    const linkIsCurrent = Boolean(
      linkEnvelope &&
      linkEnvelope.resourceId === resource.id &&
      linkEnvelope.accountOwnerDiscordUserId === accountMetadata.ownerDiscordUserId &&
      linkEnvelope.accountVersion === accountMetadata.version &&
      linkEnvelope.linkPolicyVersion === resource.totpLinkVersion
    );
    let consumedGrantId: string | null = null;

    if (evalResult.allowed && evalResult.decisionCode === 'ALLOW' && linkIsCurrent) {
      // Direct access allowed (Resource Owner or Custody Owner)
    } else if (grantId && linkIsCurrent) {
      // Delegated access via Approval Grant
      const targetVersions = await resolveTargetVersions(
        repositories,
        resourceId,
        'totp.code.read'
      );
      if (!targetVersions) {
        throw new AccessDeniedError('Resource target versions could not be resolved.');
      }

      const authFamily =
        userPrincipal.type === 'PAWTHY_TOKEN'
          ? 'PAWTHY_CLI'
          : userPrincipal.type === 'RESOURCE_API_KEY'
            ? 'RESOURCE_KEY'
            : userPrincipal.type === 'SERVICE'
              ? 'SERVICE'
              : 'DISCORD';
      const audience = userPrincipal.audience || 'purrmission-bot';

      if (!this.deps.approval) {
        throw new AccessDeniedError(
          'Approval service dependency not available for grant consumption.'
        );
      }

      await this.runTransaction(async (tx) => {
        await this.deps.approval!.consumeGrant(
          grantId,
          userPrincipal,
          'totp.code.read',
          targetVersions.targetVersion,
          targetVersions.policyVersion,
          {
            requiredAuthFamily: authFamily,
            requiredAudience: audience,
          },
          tx
        );
      });
      consumedGrantId = grantId;
    } else {
      void consentId;
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'TOTP_REVEAL_DENIED',
        surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
        operation: 'totp.code.reveal',
        outcomeCode: 'DENIED',
        capability: 'totp.code.read',
        decisionCode: 'DENY',
        reasonCode: linkIsCurrent ? evalResult.reasonCode : 'TARGET_SCOPE_MISMATCH',
        authoritySources: evalResult.authoritySources,
        targetType: 'TOTP_ACCOUNT',
        targetId: accountMetadata.id,
        actorType: userPrincipal.type,
        principalId: userPrincipal.id,
        actorId,
        authKind: userPrincipal.authKind,
        resourceId,
        payload: {
          reason: !linkIsCurrent
            ? 'Stale TOTP link'
            : grantId
              ? 'Invalid or unauthorized approval grant'
              : 'No direct TOTP code authority or approval grant',
        },
      });
      if (!linkIsCurrent) {
        throw new AccessDeniedError(
          'The TOTP link consent is stale or malformed; relink before revealing codes.'
        );
      }
      throw new AccessDeniedError(
        'Delegated TOTP reveal requires a valid, unconsumed approval grant.'
      );
    }

    // Load value-bearing custody data only after authorization and atomic consumption.
    const account = await repositories.totp.findById(resource.totpAccountId);
    if (!account || account.version !== accountMetadata.version) {
      throw new AccessDeniedError('TOTP account changed during authorization.');
    }

    // Persist the authorized reveal record before materializing the code.
    await this.audit.log({
      eventFamily: 'TOTP_LIFECYCLE',
      eventType: 'TOTP_CODE_REVEAL',
      surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
      operation: 'totp.code.reveal',
      outcomeCode: 'SUCCESS',
      capability: 'totp.code.read',
      decisionCode: 'ALLOW',
      reasonCode: consumedGrantId ? 'GRANT' : evalResult.reasonCode,
      authoritySources: consumedGrantId ? ['APPROVAL_GRANT'] : evalResult.authoritySources,
      targetType: 'TOTP_ACCOUNT',
      targetId: account.id,
      actorType: userPrincipal.type,
      principalId: userPrincipal.id,
      actorId,
      authKind: userPrincipal.authKind,
      resourceId,
      grantId: consumedGrantId,
      payload: { totpAccountId: account.id },
    });

    const code = generateTOTPCode(account);

    return code;
  }

  /** Reveal a personal current code. This path never accepts Resource or grant authority. */
  async revealPersonalTOTPCode(totpAccountId: string, principal: Principal): Promise<string> {
    const decision = await hasCapability(this.deps.repositories, principal, 'totp.code.read', {
      totpAccountId,
    });
    if (!decision.allowed || decision.decisionCode !== 'ALLOW') {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'TOTP_REVEAL_DENIED',
        surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
        operation: 'totp.personal-code.reveal',
        outcomeCode: 'DENIED',
        capability: 'totp.code.read',
        decisionCode: 'DENY',
        reasonCode: decision.reasonCode,
        authoritySources: decision.authoritySources,
        targetType: 'TOTP_ACCOUNT',
        targetId: totpAccountId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        payload: { reason: 'Personal TOTP owner required' },
      });
      throw new AccessDeniedError(decision.safeExplanation);
    }
    const account = await this.deps.repositories.totp.findById(totpAccountId);
    if (!account || account.ownerDiscordUserId !== principal.subjectId) {
      throw new AccessDeniedError('Only the personal TOTP owner may reveal this code.');
    }
    await this.audit.log({
      eventFamily: 'TOTP_LIFECYCLE',
      eventType: 'TOTP_PERSONAL_CODE_REVEAL',
      surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
      operation: 'totp.personal-code.reveal',
      outcomeCode: 'SUCCESS',
      capability: 'totp.code.read',
      decisionCode: 'ALLOW',
      reasonCode: decision.reasonCode,
      authoritySources: decision.authoritySources,
      targetType: 'TOTP_ACCOUNT',
      targetId: account.id,
      actorType: principal.type,
      principalId: principal.id,
      actorId: principal.subjectId,
      authKind: principal.authKind,
      payload: { totpAccountId: account.id },
    });
    return generateTOTPCode(account);
  }

  /**
   * Reveal recovery key if authorized.
   */
  async revealTOTPRecoveryKey(totpAccountId: string, principal: Principal): Promise<string> {
    const { repositories } = this.deps;

    // Check capability 'totp.recovery.read'
    const evalResult = await hasCapability(repositories, principal, 'totp.recovery.read', {
      totpAccountId,
    });

    if (!evalResult.allowed || evalResult.decisionCode !== 'ALLOW') {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'TOTP_REVEAL_DENIED',
        surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
        operation: 'totp.recovery.reveal',
        outcomeCode: 'DENIED',
        capability: 'totp.recovery.read',
        decisionCode: 'DENY',
        reasonCode: evalResult.reasonCode,
        authoritySources: evalResult.authoritySources,
        targetType: 'TOTP_ACCOUNT',
        targetId: totpAccountId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        payload: { reason: 'Personal TOTP owner required' },
      });
      throw new ForbiddenError(
        'Access denied. Only the personal owner of the TOTP account can view the recovery key.'
      );
    }

    const account = await repositories.totp.findById(totpAccountId);
    if (!account) {
      throw new ResourceNotFoundError('TOTP account not found.');
    }

    if (!account.backupKey) {
      throw new ResourceNotFoundError('No recovery key/backup key configured for this account.');
    }

    // Persist the authorized reveal record before returning recovery material.
    await this.audit.log({
      eventFamily: 'TOTP_LIFECYCLE',
      eventType: 'TOTP_RECOVERY_REVEAL',
      surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
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
      actorId: principal.subjectId,
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
    principal: Principal,
    grantId?: string
  ): Promise<ResourceField | null> {
    const decision = await hasCapability(this.deps.repositories, principal, 'secret.value.read', {
      resourceId,
      fieldName: name,
    });

    let consumedGrantId: string | null = null;

    if (decision.allowed) {
      // Direct access allowed
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'HTTP',
        operation: 'secret.value.read.authorize',
        outcomeCode: 'SUCCESS',
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
    } else if (grantId && this.deps.approval) {
      // Delegated access via grant
      const versions = await resolveTargetVersions(
        this.deps.repositories,
        resourceId,
        'secret.value.read',
        name
      );
      if (!versions) return null;

      const authFamily =
        principal.type === 'PAWTHY_TOKEN'
          ? 'PAWTHY_CLI'
          : principal.type === 'RESOURCE_API_KEY'
            ? 'RESOURCE_KEY'
            : principal.type === 'SERVICE'
              ? 'SERVICE'
              : 'DISCORD';
      const audience = principal.audience || 'purrmission-bot';

      try {
        await this.runTransaction(async (tx) => {
          await this.deps.approval!.consumeGrant(
            grantId,
            principal,
            'secret.value.read',
            versions.targetVersion,
            versions.policyVersion,
            {
              requiredAuthFamily: authFamily,
              requiredAudience: audience,
              canonicalKeyDigest: versions.canonicalKeyDigest,
            },
            tx
          );
        });
        consumedGrantId = grantId;
      } catch (err) {
        if (err instanceof AccessDeniedError || err instanceof ConflictError) {
          return null;
        }
        logger.error('Failed to consume grant in revealField', {
          error: err instanceof Error ? err.message : String(err),
          resourceId,
          fieldName: name,
        });
        throw err;
      }
    } else {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'HTTP',
        operation: 'secret.value.read.authorize',
        outcomeCode: 'DENIED',
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
      return null;
    }

    await this.audit.log({
      eventFamily: 'SECRET_LIFECYCLE',
      eventType: 'SECRET_REVEAL',
      surface: 'HTTP',
      operation: 'secret.value.reveal',
      outcomeCode: 'SUCCESS',
      capability: 'secret.value.read',
      decisionCode: 'ALLOW',
      reasonCode: consumedGrantId ? 'GRANT' : decision.reasonCode,
      authoritySources: consumedGrantId ? ['APPROVAL_GRANT'] : decision.authoritySources,
      targetType: 'SECRET',
      targetId: `${resourceId}:${name}`,
      actorType: principal.type,
      principalId: principal.id,
      actorId: principal.subjectId,
      authKind: principal.authKind,
      resourceId,
      grantId: consumedGrantId,
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
 * Service managing Owner-controlled callback destinations.
 */
export class CallbackDestinationService {
  constructor(
    private readonly repos: Repositories,
    private readonly audit: AuditService,
    private readonly transaction: Repositories['transaction']
  ) {}

  async createDestination(
    input: {
      resourceId: string;
      projectId?: string;
      name?: string;
      url: string;
    },
    principal: Principal
  ): Promise<{
    destination: CallbackDestinationMetadataProjection;
    secret: string;
    verificationToken: string;
  }> {
    validatePrincipal(principal);

    const auth = await hasCapability(this.repos, principal, 'callback.destination.manage', {
      resourceId: input.resourceId,
      projectId: input.projectId,
    });

    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'RESOURCE_CONFIGURATION',
        eventType: 'CALLBACK_REGISTER',
        surface: 'DOMAIN',
        operation: 'callback.destination.create',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: input.resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId: input.resourceId,
        projectId: input.projectId,
        payload: { name: input.name ?? null, url: input.url },
      });
      throw new DomainAuthorizationError(auth.safeExplanation);
    }

    // Validate URL scheme and format
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.url);
    } catch {
      throw new ValidationError('Invalid callback destination URL.');
    }

    const isTestEnv = process.env.NODE_ENV === 'test';
    const allowPrivate = isTestEnv && process.env.ALLOW_PRIVATE_WEBHOOKS === 'true';
    if (parsedUrl.protocol !== 'https:' && !(allowPrivate && parsedUrl.protocol === 'http:')) {
      throw new ValidationError('Callback destination URL must use HTTPS protocol.');
    }

    const port = parsedUrl.port
      ? Number(parsedUrl.port)
      : parsedUrl.protocol === 'https:'
        ? 443
        : 80;
    if (port !== 443 && port !== 8443 && !(allowPrivate && (port === 80 || port > 1024))) {
      throw new ValidationError(`Callback destination port ${port} is not allowed.`);
    }

    const plaintextSecret = crypto.randomBytes(32).toString('hex');
    const encryptedSecret = encryptValue(plaintextSecret);
    const verificationToken = crypto.randomUUID();
    const challengeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const created = await this.transaction(async (tx) => {
      const dest = await this.repos.callbackDestinations.create(
        {
          resourceId: input.resourceId,
          projectId: input.projectId ?? null,
          name: input.name ?? null,
          url: input.url,
          keyId: 'default',
          encryptedSecret,
          status: 'PENDING_VERIFICATION',
          verificationToken,
          verificationChallengeExpiresAt: challengeExpiresAt,
        },
        tx
      );

      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'CALLBACK_REGISTER',
          surface: 'DOMAIN',
          operation: 'callback.destination.create',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: auth.reasonCode,
          authoritySources: auth.authoritySources,
          targetType: 'RESOURCE',
          targetId: input.resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId: input.resourceId,
          projectId: input.projectId,
          payload: {
            destinationId: dest.id,
            name: input.name ?? null,
            url: input.url,
            status: dest.status,
          },
        },
        tx
      );

      return dest;
    });

    return {
      destination: {
        id: created.id,
        resourceId: created.resourceId,
        projectId: created.projectId,
        name: created.name,
        url: created.url,
        status: created.status,
        verifiedAt: created.verifiedAt,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
      secret: plaintextSecret,
      verificationToken,
    };
  }

  async verifyDestination(
    destinationId: string,
    token: string,
    principal: Principal
  ): Promise<CallbackDestinationMetadataProjection> {
    validatePrincipal(principal);

    const destination = await this.repos.callbackDestinations.findById(destinationId);
    if (!destination) {
      throw new NotFoundError('Callback destination not found.');
    }

    const auth = await hasCapability(this.repos, principal, 'callback.destination.verify', {
      resourceId: destination.resourceId,
      projectId: destination.projectId ?? undefined,
    });

    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'RESOURCE_CONFIGURATION',
        eventType: 'CALLBACK_VERIFY',
        surface: 'DOMAIN',
        operation: 'callback.destination.verify',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: destination.resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId: destination.resourceId,
        projectId: destination.projectId,
        payload: { destinationId },
      });
      throw new DomainAuthorizationError(auth.safeExplanation);
    }

    if (
      !destination.verificationToken ||
      destination.verificationToken !== token ||
      !destination.verificationChallengeExpiresAt ||
      destination.verificationChallengeExpiresAt < new Date()
    ) {
      await this.audit.log({
        eventFamily: 'RESOURCE_CONFIGURATION',
        eventType: 'CALLBACK_VERIFY',
        surface: 'DOMAIN',
        operation: 'callback.destination.verify',
        outcomeCode: 'FAILURE',
        decisionCode: 'ALLOW',
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: destination.resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId: destination.resourceId,
        projectId: destination.projectId,
        payload: { destinationId, error: 'INVALID_OR_EXPIRED_TOKEN' },
      });
      throw new ValidationError('Invalid or expired destination verification challenge token.');
    }

    const now = new Date();
    await this.transaction(async (tx) => {
      await this.repos.callbackDestinations.updateStatus(destinationId, 'ACTIVE', now, tx);

      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'CALLBACK_VERIFY',
          surface: 'DOMAIN',
          operation: 'callback.destination.verify',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: auth.reasonCode,
          authoritySources: auth.authoritySources,
          targetType: 'RESOURCE',
          targetId: destination.resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId: destination.resourceId,
          projectId: destination.projectId,
          payload: { destinationId, status: 'ACTIVE' },
        },
        tx
      );
    });

    const updated = await this.repos.callbackDestinations.findMetadataById(destinationId);
    if (!updated) throw new NotFoundError('Destination not found after verification.');
    return updated;
  }

  async rotateSecret(destinationId: string, principal: Principal): Promise<{ secret: string }> {
    validatePrincipal(principal);

    const destination = await this.repos.callbackDestinations.findById(destinationId);
    if (!destination) {
      throw new NotFoundError('Callback destination not found.');
    }

    const auth = await hasCapability(this.repos, principal, 'callback.destination.manage', {
      resourceId: destination.resourceId,
      projectId: destination.projectId ?? undefined,
    });

    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'RESOURCE_CONFIGURATION',
        eventType: 'CALLBACK_ROTATE_SECRET',
        surface: 'DOMAIN',
        operation: 'callback.destination.rotate-secret',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: destination.resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId: destination.resourceId,
        projectId: destination.projectId,
        payload: { destinationId },
      });
      throw new DomainAuthorizationError(auth.safeExplanation);
    }

    const plaintextSecret = crypto.randomBytes(32).toString('hex');
    const encryptedSecret = encryptValue(plaintextSecret);

    await this.transaction(async (tx) => {
      await this.repos.callbackDestinations.rotateSecret(
        destinationId,
        'default',
        encryptedSecret,
        tx
      );

      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'CALLBACK_ROTATE_SECRET',
          surface: 'DOMAIN',
          operation: 'callback.destination.rotate-secret',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: auth.reasonCode,
          authoritySources: auth.authoritySources,
          targetType: 'RESOURCE',
          targetId: destination.resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId: destination.resourceId,
          projectId: destination.projectId,
          payload: { destinationId },
        },
        tx
      );
    });

    return { secret: plaintextSecret };
  }

  async disableDestination(
    destinationId: string,
    principal: Principal
  ): Promise<CallbackDestinationMetadataProjection> {
    validatePrincipal(principal);

    const destination = await this.repos.callbackDestinations.findById(destinationId);
    if (!destination) {
      throw new NotFoundError('Callback destination not found.');
    }

    const auth = await hasCapability(this.repos, principal, 'callback.destination.manage', {
      resourceId: destination.resourceId,
      projectId: destination.projectId ?? undefined,
    });

    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'RESOURCE_CONFIGURATION',
        eventType: 'CALLBACK_DISABLE',
        surface: 'DOMAIN',
        operation: 'callback.destination.disable',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: destination.resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId: destination.resourceId,
        projectId: destination.projectId,
        payload: { destinationId },
      });
      throw new DomainAuthorizationError(auth.safeExplanation);
    }

    await this.transaction(async (tx) => {
      await this.repos.callbackDestinations.updateStatus(destinationId, 'DISABLED', undefined, tx);

      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'CALLBACK_DISABLE',
          surface: 'DOMAIN',
          operation: 'callback.destination.disable',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: auth.reasonCode,
          authoritySources: auth.authoritySources,
          targetType: 'RESOURCE',
          targetId: destination.resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId: destination.resourceId,
          projectId: destination.projectId,
          payload: { destinationId, status: 'DISABLED' },
        },
        tx
      );
    });

    const updated = await this.repos.callbackDestinations.findMetadataById(destinationId);
    if (!updated) throw new NotFoundError('Destination not found after disabling.');
    return updated;
  }

  async deleteDestination(destinationId: string, principal: Principal): Promise<void> {
    validatePrincipal(principal);

    const destination = await this.repos.callbackDestinations.findById(destinationId);
    if (!destination) {
      throw new NotFoundError('Callback destination not found.');
    }

    const auth = await hasCapability(this.repos, principal, 'callback.destination.manage', {
      resourceId: destination.resourceId,
      projectId: destination.projectId ?? undefined,
    });

    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'RESOURCE_CONFIGURATION',
        eventType: 'CALLBACK_DELETE',
        surface: 'DOMAIN',
        operation: 'callback.destination.delete',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: destination.resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId: destination.resourceId,
        projectId: destination.projectId,
        payload: { destinationId },
      });
      throw new DomainAuthorizationError(auth.safeExplanation);
    }

    await this.transaction(async (tx) => {
      await this.repos.callbackDestinations.delete(destinationId, tx);

      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'CALLBACK_DELETE',
          surface: 'DOMAIN',
          operation: 'callback.destination.delete',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: auth.reasonCode,
          authoritySources: auth.authoritySources,
          targetType: 'RESOURCE',
          targetId: destination.resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          resourceId: destination.resourceId,
          projectId: destination.projectId,
          payload: { destinationId },
        },
        tx
      );
    });
  }

  async listDestinations(
    resourceId: string,
    principal: Principal
  ): Promise<CallbackDestinationMetadataProjection[]> {
    validatePrincipal(principal);

    const auth = await hasCapability(this.repos, principal, 'callback.destination.view', {
      resourceId,
    });

    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'RESOURCE_CONFIGURATION',
        eventType: 'CALLBACK_LIST',
        surface: 'DOMAIN',
        operation: 'callback.destination.list',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        resourceId,
        payload: { resourceId },
      });
      throw new DomainAuthorizationError(auth.safeExplanation);
    }

    return this.repos.callbackDestinations.findMetadataByResourceId(resourceId);
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
  metadata: MetadataQueryService;
  callbackDestinations: CallbackDestinationService;
}

/**
 * Create all services with the given dependencies.
 */
export function createServices(baseDeps: {
  repositories: Repositories;
  rateLimiter?: import('../infra/rateLimit.js').RateLimiter;
}): Services {
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
    metadata: createRepositoryMetadataQueryService(baseDeps.repositories),
    callbackDestinations: new CallbackDestinationService(
      baseDeps.repositories,
      audit,
      baseDeps.repositories.transaction
    ),
  };
}
