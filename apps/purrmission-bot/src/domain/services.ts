/**
 * Application services for the Purrmission approval system.
 *
 * These services contain the core business logic for:
 * - Creating approval requests
 * - Recording approval/denial decisions
 * - Managing resources and guardians
 */

import crypto from 'node:crypto';
import type {
  ApprovalRequest,
  ApprovalDecision,
  DecisionResult,
  Resource,
  Guardian,
  TOTPAccount,
  ResourceField,
  ResourceFieldMetadata,
  TOTPLinkConsent,
  TOTPDelegationConsent,
  TOTPLinkEnvelope,
  Credential,
} from './models.js';
import type { Repositories } from './repositories.js';
import { logger } from '../logging/logger.js';
import { AuditService } from './audit.js';
import { AuthService } from './auth.js';
import { ProjectService } from './project.js';
import { ResourceNotFoundError, DuplicateError } from './errors.js';
import {
  getEffectiveGuardians,
  isEffectiveGuardian,
  isEffectiveOwner,
  hasCapability,
  Principal,
} from './policy.js';
import { getPrismaClient } from '../infra/prismaClient.js';
import { generateTOTPCode } from './totp.js';
import { computeKeyedDigest } from './crypto.js';

/**
 * Service dependencies.
 */
export interface ServiceDependencies {
  repositories: Repositories;
  audit?: AuditService; // Optional to avoid circular dep during creation if not careful, but intended to be present
}

/**
 * Input for creating an approval request.
 */
export interface CreateApprovalRequestInput {
  resourceId: string;
  context?: Record<string, unknown>;
  callbackUrl?: string;
  expiresInMs?: number;
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
  private deps: ServiceDependencies;

  constructor(deps: ServiceDependencies) {
    this.deps = deps;
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
    const prisma = getPrismaClient();
    try {
      const request = await prisma.$transaction(async (tx) => {
        const req = await repositories.approvalRequests.create(
          {
            id: crypto.randomUUID(),
            resourceId: input.resourceId,
            status: 'PENDING',
            context: input.context ?? {},
            callbackUrl: input.callbackUrl,
            expiresAt,
          },
          tx
        );

        if (this.deps.audit) {
          const requesterId = input.context?.requesterId
            ? String(input.context.requesterId)
            : undefined;
          await this.deps.audit.log(
            {
              eventType: 'REQUEST_CREATE',
              outcomeCode: 'SUCCESS',
              actorType: requesterId ? 'DISCORD_USER' : 'SERVICE',
              actorId: requesterId,
              authKind: requesterId ? 'DISCORD' : 'API_KEY',
              resourceId: input.resourceId,
              requestId: req.id,
              payload: {
                context: input.context,
                expiresAt: expiresAt.toISOString(),
              },
            },
            tx
          );
        }

        // Enqueue Outbox event to notify guardians
        await repositories.outbox.create(
          {
            eventType: 'REQUEST_CREATED',
            payload: {
              requestId: req.id,
              resourceId: input.resourceId,
            },
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
   * @param byGuardianDiscordId - Discord user ID of the guardian making the decision
   * @returns The result of recording the decision
   */
  async recordDecision(
    requestId: string,
    decision: ApprovalDecision,
    byGuardianDiscordId: string
  ): Promise<DecisionResult> {
    const { repositories } = this.deps;

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
    if (request.expiresAt && request.expiresAt < new Date()) {
      await repositories.approvalRequests.updateStatus(requestId, 'EXPIRED');
      return {
        success: false,
        error: 'Request has expired',
        request: { ...request, status: 'EXPIRED' },
      };
    }

    // Verify that the user is actually a guardian for this resource
    const isGuardian = await isEffectiveGuardian(
      repositories,
      request.resourceId,
      byGuardianDiscordId
    );
    if (!isGuardian) {
      logger.warn('Decision made by non-guardian user', {
        requestId,
        discordUserId: byGuardianDiscordId,
        resourceId: request.resourceId,
      });
      return {
        success: false,
        error: 'User is not a guardian for this resource',
      };
    }

    // Update the request status
    const newStatus = decision === 'APPROVE' ? 'APPROVED' : 'DENIED';

    // Extract requester (actor) ID from the original request context, if available
    let requesterId: string | null = null;
    const requestContext = request.context as Record<string, unknown>;
    if (requestContext && typeof requestContext === 'object' && 'requesterId' in requestContext) {
      requesterId = String(requestContext.requesterId);
    }

    const prisma = getPrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await repositories.approvalRequests.updateStatus(
          requestId,
          newStatus,
          byGuardianDiscordId,
          tx
        );

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'APPROVAL_DECISION',
              outcomeCode: newStatus === 'APPROVED' ? 'SUCCESS' : 'DENIED',
              actorType: 'DISCORD_USER',
              actorId: byGuardianDiscordId,
              authKind: 'DISCORD',
              resourceId: request.resourceId,
              requestId: request.id,
              payload: {
                decision,
                requesterId,
                originalContext: request.context,
              },
            },
            tx
          );
        }

        if (request.callbackUrl) {
          await repositories.outbox.create(
            {
              eventType: 'APPROVAL_CALLBACK',
              payload: {
                requestId: request.id,
                callbackUrl: request.callbackUrl,
                status: newStatus,
              },
            },
            tx
          );
        }
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
    requesterId: string
  ): Promise<ApprovalRequest | null> {
    return this.deps.repositories.approvalRequests.findActiveByRequester(resourceId, requesterId);
  }

  /**
   * Automatically expire pending approval requests that have passed their expiration time.
   * @returns The number of expired requests
   */
  async cleanupExpiredRequests(): Promise<number> {
    const count = await this.deps.repositories.approvalRequests.expireRequests();
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
  private deps: ServiceDependencies;

  constructor(deps: ServiceDependencies) {
    this.deps = deps;
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
   * Create a new resource.
   *
   * @param name - Name of the resource
   * @param ownerDiscordId - Discord user ID of the owner
   * @returns The created resource
   */
  async createResource(
    name: string,
    ownerDiscordId: string
  ): Promise<{ resource: Resource; guardian: Guardian }> {
    const { repositories } = this.deps;

    // Generate a random API key
    const apiKey = crypto.randomBytes(32).toString('hex');

    // Create the resource
    const resource = await repositories.resources.create({
      id: crypto.randomUUID(),
      name,
      mode: 'ONE_OF_N',
      apiKey,
    });

    // Add the creator as owner
    const guardian = await repositories.guardians.add({
      id: crypto.randomUUID(),
      resourceId: resource.id,
      discordUserId: ownerDiscordId,
      role: 'OWNER',
    });

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

    // Add the guardian
    const guardian = await repositories.guardians.add({
      id: crypto.randomUUID(),
      resourceId,
      discordUserId,
      role: 'GUARDIAN',
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
      const isDynamic = await isEffectiveGuardian(repositories, resourceId, targetUserId);
      if (isDynamic) {
        return {
          success: false,
          error:
            'Cannot remove this user directly because they inherit guardian status from a project role (Project Owner or Writer member). Remove them from the project instead.',
        };
      }
      return { success: false, error: 'User is not a guardian of this resource.' };
    }
    if (targetGuardian.role === 'OWNER') {
      return { success: false, error: 'Cannot remove the resource owner.' };
    }

    await repositories.guardians.remove(resourceId, targetUserId);

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
    // Verify Access
    const hasAccess = await this.isGuardian(resourceId, actorId);
    if (!hasAccess) {
      return { success: false, error: 'Access denied. You must be a guardian to list guardians.' };
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
      return repositories.resources.findById(credential.subjectId);
    }

    // 2. Dual-read fallback: check legacy plaintext apiKey in Resources table
    const legacyResource = await repositories.resources.findByApiKey(apiKey);
    if (legacyResource) {
      return legacyResource;
    }

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

    const prisma = getPrismaClient();
    let credential!: Credential;

    try {
      await prisma.$transaction(async (tx) => {
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

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'API_KEY_MINT',
              outcomeCode: 'SUCCESS',
              actorType: 'DISCORD_USER',
              actorId,
              authKind: 'DISCORD',
              resourceId,
              payload: { credentialId: credential.id },
            },
            tx
          );
        }
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

    const prisma = getPrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await repositories.credentials.revoke(credentialId, tx);

        // Update resource version
        await repositories.resources.update(resourceId, { version: crypto.randomUUID() }, tx);

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'API_KEY_REVOKE',
              outcomeCode: 'SUCCESS',
              actorType: 'DISCORD_USER',
              actorId,
              authKind: 'DISCORD',
              resourceId,
              payload: { credentialId },
            },
            tx
          );
        }
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

    // Verify Access (actor must be resource owner or guardian)
    const hasAccess = await this.isGuardian(resourceId, actorId);
    if (!hasAccess) {
      throw new Error('Access denied. You must be a guardian or owner to list API keys.');
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
    resourceId: string,
    totpAccountId: string,
    actorId: string,
    consentId: string
  ): Promise<void> {
    const { repositories } = this.deps;

    // Verify Resource Authority (actor must be resource owner)
    const hasOwnerAccess = await isEffectiveOwner(repositories, resourceId, actorId);
    if (!hasOwnerAccess) {
      throw new Error('Only the resource owner can link a TOTP account.');
    }

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource not found: ${resourceId}`);
    }

    // Verify TOTP account exists
    const totpAccount = await repositories.totp.findById(totpAccountId);
    if (!totpAccount) {
      throw new Error(`TOTP account not found: ${totpAccountId}`);
    }

    // Retrieve and validate consent
    const consent = await repositories.totp.findLinkConsentById(consentId);
    if (!consent) {
      throw new Error(`Link consent not found: ${consentId}`);
    }
    if (consent.accountId !== totpAccountId || consent.resourceId !== resourceId) {
      throw new Error('Link consent parameters mismatch.');
    }
    if (consent.expiresAt < new Date()) {
      throw new Error('Link consent has expired.');
    }
    if (consent.usedAt) {
      throw new Error('Link consent has already been used.');
    }

    // Check if TOTP account is already linked to another resource
    if (resource.totpAccountId && resource.totpAccountId !== totpAccountId) {
      throw new Error('Resource already has a linked 2FA account. Unlink it first.');
    }

    const delegationEnvelope: TOTPLinkEnvelope = {
      consentId: consent.id,
      delegationPolicy: consent.delegationPolicy,
      accountOwnerDiscordUserId: consent.ownerDiscordUserId,
      accountVersion: totpAccount.version,
      linkVersion: crypto.randomUUID(),
      createdAt: new Date(),
    };

    // Update the resource with the linked TOTP account ID
    const prisma = getPrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await repositories.totp.useLinkConsent(consentId, tx);
        await repositories.resources.update(
          resourceId,
          { totpAccountId, totpDelegationEnvelope: delegationEnvelope },
          tx
        );

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'TOTP_LINK',
              outcomeCode: 'SUCCESS',
              actorType: 'DISCORD_USER',
              actorId,
              authKind: 'DISCORD',
              resourceId,
              payload: { totpAccountId, consentId },
            },
            tx
          );
        }
      });
    } catch (err) {
      logger.error('Failed to link TOTP account atomically', {
        resourceId,
        totpAccountId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err; // Fail closed
    }

    logger.info('Linked TOTP account to resource', {
      resourceId,
      totpAccountId,
    });
  }

  /**
   * Unlink TOTP account from a resource.
   */
  async unlinkTOTPAccount(resourceId: string, actorId: string): Promise<void> {
    const { repositories } = this.deps;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource not found: ${resourceId}`);
    }

    if (!resource.totpAccountId) {
      throw new Error('Resource is not linked to any TOTP account.');
    }

    // Verify Actor is Resource Owner or TOTP Account Custody Owner
    const isResourceOwner = await isEffectiveOwner(repositories, resourceId, actorId);
    let isTotpOwner = false;
    if (resource.totpAccountId) {
      const totpAcc = await repositories.totp.findById(resource.totpAccountId);
      if (totpAcc && totpAcc.ownerDiscordUserId === actorId) {
        isTotpOwner = true;
      }
    }

    if (!isResourceOwner && !isTotpOwner) {
      throw new Error(
        'Access denied. Only the resource owner or the TOTP account owner can unlink.'
      );
    }

    // Update the resource to remove the linked TOTP account
    const prisma = getPrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await repositories.resources.update(
          resourceId,
          { totpAccountId: null, totpDelegationEnvelope: null },
          tx
        );

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'TOTP_UNLINK',
              outcomeCode: 'SUCCESS',
              actorType: 'DISCORD_USER',
              actorId,
              authKind: 'DISCORD',
              resourceId,
              payload: {},
            },
            tx
          );
        }
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
    accountId: string,
    resourceId: string,
    ownerDiscordUserId: string,
    delegationPolicy: Record<string, unknown>
  ): Promise<TOTPLinkConsent> {
    const { repositories } = this.deps;
    const acc = await repositories.totp.findById(accountId);
    if (!acc || acc.ownerDiscordUserId !== ownerDiscordUserId) {
      throw new Error('Only the TOTP account owner can create link consent.');
    }
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry
    return repositories.totp.createLinkConsent({
      accountId,
      resourceId,
      ownerDiscordUserId,
      delegationPolicy,
      expiresAt,
    });
  }

  /**
   * Create a delegation consent token.
   */
  async createTOTPDelegationConsent(
    resourceId: string,
    totpAccountId: string,
    requesterId: string,
    operation: string,
    authFamily: string
  ): Promise<TOTPDelegationConsent> {
    const { repositories } = this.deps;

    const resource = await repositories.resources.findById(resourceId);
    if (!resource || resource.totpAccountId !== totpAccountId) {
      throw new Error('Invalid resource or linked TOTP account.');
    }

    const envelope = resource.totpDelegationEnvelope;
    if (!envelope) {
      throw new Error('No delegation policy found on this link.');
    }

    const totpAccount = await repositories.totp.findById(totpAccountId);
    if (!totpAccount || totpAccount.version !== envelope.accountVersion) {
      throw new Error('Stale link delegation envelope. Seed has rotated.');
    }

    const policy = envelope.delegationPolicy;
    if (policy.allowedOperations && Array.isArray(policy.allowedOperations)) {
      if (!policy.allowedOperations.includes(operation)) {
        throw new Error(`Operation ${operation} is not permitted by the delegation policy.`);
      }
    }
    if (policy.allowedRequesters && Array.isArray(policy.allowedRequesters)) {
      if (!policy.allowedRequesters.includes(requesterId)) {
        throw new Error(`Requester ${requesterId} is not permitted by the delegation policy.`);
      }
    }

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes short-lived
    return repositories.totp.createDelegationConsent({
      resourceId,
      totpAccountId,
      operation,
      requesterId,
      authFamily,
      accountVersion: totpAccount.version,
      linkVersion: envelope.linkVersion,
      expiresAt,
    });
  }

  /**
   * Generate and reveal a TOTP code if authorized.
   */
  async revealTOTPCode(resourceId: string, actorId: string): Promise<string> {
    const { repositories } = this.deps;

    // Check capability 'totp.code.read'
    const principal: Principal = {
      type: 'DISCORD_USER',
      id: actorId,
      authKind: 'DISCORD',
      actorDiscordId: actorId,
    };
    const evalResult = await hasCapability(repositories, principal, 'totp.code.read', {
      resourceId,
    });

    let authorized = evalResult.allowed;

    if (!authorized) {
      const activeRequest = await repositories.approvalRequests.findActiveByRequester(
        resourceId,
        actorId
      );
      if (activeRequest && activeRequest.status === 'APPROVED') {
        if (!activeRequest.expiresAt || activeRequest.expiresAt > new Date()) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      throw new Error('Access denied. You do not have permission to view this TOTP code.');
    }

    const resource = await repositories.resources.findById(resourceId);
    if (!resource || !resource.totpAccountId) {
      throw new Error('No 2FA account linked to this resource.');
    }

    const account = await repositories.totp.findById(resource.totpAccountId);
    if (!account) {
      throw new Error('TOTP account not found.');
    }

    const code = generateTOTPCode(account);

    // Audit Log reveal event
    if (this.deps.audit) {
      await this.deps.audit.log({
        eventType: 'TOTP_CODE_REVEAL',
        outcomeCode: 'SUCCESS',
        actorType: 'DISCORD_USER',
        actorId,
        authKind: 'DISCORD',
        resourceId,
        payload: { totpAccountId: account.id },
      });
    }

    return code;
  }

  /**
   * Reveal recovery key if authorized.
   */
  async revealTOTPRecoveryKey(totpAccountId: string, actorId: string): Promise<string> {
    const { repositories } = this.deps;

    // Check capability 'totp.recovery.read'
    const principal: Principal = {
      type: 'DISCORD_USER',
      id: actorId,
      authKind: 'DISCORD',
      actorDiscordId: actorId,
    };
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

    // Audit Log reveal event
    if (this.deps.audit) {
      await this.deps.audit.log({
        eventType: 'TOTP_RECOVERY_REVEAL',
        outcomeCode: 'SUCCESS',
        actorType: 'DISCORD_USER',
        actorId,
        authKind: 'DISCORD',
        payload: { totpAccountId },
      });
    }

    return account.backupKey;
  }

  /**
   * Create a new field for a resource.
   */
  async createField(resourceId: string, name: string, value: string): Promise<ResourceField> {
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

    const prisma = getPrismaClient();
    try {
      const field = await prisma.$transaction(async (tx) => {
        const createdField = await repositories.resourceFields.create(
          {
            resourceId,
            name,
            value,
          },
          tx
        );

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'SECRET_CREATE',
              outcomeCode: 'SUCCESS',
              actorType: 'SERVICE',
              actorId: 'system',
              authKind: 'SERVICE',
              resourceId,
              payload: { fieldName: name }, // Redacted value!
            },
            tx
          );
        }
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

  async getFieldMetadata(resourceId: string, name: string): Promise<ResourceFieldMetadata | null> {
    const { repositories } = this.deps;
    return repositories.resourceFields.findMetadataByResourceAndName(resourceId, name);
  }

  /**
   * Delete a field from a resource.
   */
  async deleteField(resourceId: string, name: string): Promise<void> {
    const { repositories } = this.deps;

    const field = await repositories.resourceFields.findByResourceAndName(resourceId, name);
    if (!field) {
      // Idempotent success or throw? Let's verify standard behavior.
      // Usually idempotent is safer for APIs.
      return;
    }

    const prisma = getPrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await repositories.resourceFields.delete(field.id, tx);

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'SECRET_DELETE',
              outcomeCode: 'SUCCESS',
              actorType: 'SERVICE',
              actorId: 'system',
              authKind: 'SERVICE',
              resourceId,
              payload: { fieldName: name },
            },
            tx
          );
        }
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
  async upsertField(resourceId: string, name: string, value: string): Promise<ResourceField> {
    const { repositories } = this.deps;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(`Resource not found: ${resourceId}`);
    }

    const prisma = getPrismaClient();
    try {
      const field = await prisma.$transaction(async (tx) => {
        const existing = await repositories.resourceFields.findByResourceAndName(resourceId, name);
        let resultField;
        let eventType = 'SECRET_CREATE';

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

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType,
              outcomeCode: 'SUCCESS',
              actorType: 'SERVICE',
              actorId: 'system',
              authKind: 'SERVICE',
              resourceId,
              payload: { fieldName: name },
            },
            tx
          );
        }
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

  return {
    approval: new ApprovalService(fullDeps),
    resource: new ResourceService(fullDeps),
    audit,
    auth: new AuthService(baseDeps.repositories.auth, baseDeps.repositories.credentials),
    project: new ProjectService(baseDeps.repositories.projects, new ResourceService(fullDeps)),
  };
}
