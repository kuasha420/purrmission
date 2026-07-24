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
} from './models.js';
import type { Repositories } from './repositories.js';
import { logger } from '../logging/logger.js';
import { AuditService } from './audit.js';
import { AuthService } from './auth.js';
import { ProjectService } from './project.js';
import { ResourceNotFoundError, DuplicateError } from './errors.js';
import { getEffectiveGuardians, isEffectiveGuardian, isEffectiveOwner } from './policy.js';
import { getPrismaClient } from '../infra/prismaClient.js';

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
    return this.deps.repositories.resources.findByApiKey(apiKey);
  }

  /**
   * Get guardians for a resource.
   */
  async getGuardians(resourceId: string): Promise<Guardian[]> {
    return getEffectiveGuardians(this.deps.repositories, resourceId);
  }

  /**
   * Link a TOTP account to a resource.
   * Note: Uses repository methods that may need Prisma for persistence.
   */
  async linkTOTPAccount(resourceId: string, totpAccountId: string, actorId: string): Promise<void> {
    const { repositories } = this.deps;

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

    // Check if TOTP account is already linked to another resource
    // Since totpAccountId is unique in schema, attempting to link will fail with DB error
    // But we provide a better error message by checking first if resource already has one
    if (resource.totpAccountId && resource.totpAccountId !== totpAccountId) {
      throw new Error('Resource already has a linked 2FA account. Unlink it first.');
    }

    // Update the resource with the linked TOTP account ID
    const prisma = getPrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await repositories.resources.update(resourceId, { totpAccountId }, tx);

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'TOTP_LINK',
              outcomeCode: 'SUCCESS',
              actorType: 'DISCORD_USER',
              actorId,
              authKind: 'DISCORD',
              resourceId,
              payload: { totpAccountId },
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
  async unlinkTOTPAccount(resourceId: string, actorId?: string): Promise<void> {
    const { repositories } = this.deps;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource not found: ${resourceId}`);
    }

    // Update the resource to remove the linked TOTP account
    const prisma = getPrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await repositories.resources.update(resourceId, { totpAccountId: null }, tx);

        if (this.deps.audit) {
          await this.deps.audit.log(
            {
              eventType: 'TOTP_UNLINK',
              outcomeCode: 'SUCCESS',
              actorType: actorId ? 'DISCORD_USER' : 'SERVICE',
              actorId: actorId ?? 'system',
              authKind: actorId ? 'DISCORD' : 'SERVICE',
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
    auth: new AuthService(baseDeps.repositories.auth),
    project: new ProjectService(baseDeps.repositories.projects, new ResourceService(fullDeps)),
  };
}
