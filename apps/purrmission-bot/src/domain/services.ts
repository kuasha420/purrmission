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
} from './models.js';
import type { Repositories } from './repositories.js';
import { logger } from '../logging/logger.js';

/**
 * Service dependencies.
 */
export interface ServiceDependencies {
  repositories: Repositories;
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
    const guardians = await repositories.guardians.findByResourceId(input.resourceId);
    if (guardians.length === 0) {
      return {
        success: false,
        error: 'Resource has no guardians configured',
      };
    }

    // Calculate expiration time
    const expiresAt = input.expiresInMs ? new Date(Date.now() + input.expiresInMs) : null;

    // Create the request
    const request = await repositories.approvalRequests.create({
      id: crypto.randomUUID(),
      resourceId: input.resourceId,
      status: 'PENDING',
      context: input.context ?? {},
      callbackUrl: input.callbackUrl,
      expiresAt,
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

    // TODO: Verify that the user is actually a guardian for this resource
    // For MVP, we accept any user but log a warning
    const guardian = await repositories.guardians.findByResourceAndUser(
      request.resourceId,
      byGuardianDiscordId
    );
    if (!guardian) {
      logger.warn('Decision made by non-guardian user', {
        requestId,
        discordUserId: byGuardianDiscordId,
        resourceId: request.resourceId,
      });
      // TODO: In production, reject decisions from non-guardians
      // return {
      //   success: false,
      //   error: 'User is not a guardian for this resource',
      // };
    }

    // Update the request status
    const newStatus = decision === 'APPROVE' ? 'APPROVED' : 'DENIED';
    await repositories.approvalRequests.updateStatus(requestId, newStatus, byGuardianDiscordId);

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
  }

  /**
   * Get an approval request by ID.
   */
  async getApprovalRequest(id: string): Promise<ApprovalRequest | null> {
    return this.deps.repositories.approvalRequests.findById(id);
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
    discordUserId: string
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
   * Verify an API key and return the resource.
   */
  async verifyApiKey(apiKey: string): Promise<Resource | null> {
    return this.deps.repositories.resources.findByApiKey(apiKey);
  }

  /**
   * Get guardians for a resource.
   */
  async getGuardians(resourceId: string): Promise<Guardian[]> {
    return this.deps.repositories.guardians.findByResourceId(resourceId);
  }

  /**
   * Link a TOTP account to a resource.
   * Note: Uses repository methods that may need Prisma for persistence.
   */
  async linkTOTPAccount(resourceId: string, totpAccountId: string): Promise<void> {
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
    await repositories.resources.update(resourceId, { totpAccountId });

    logger.info('Linked TOTP account to resource', {
      resourceId,
      totpAccountId,
    });
  }

  /**
   * Unlink TOTP account from a resource.
   */
  async unlinkTOTPAccount(resourceId: string): Promise<void> {
    const { repositories } = this.deps;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource not found: ${resourceId}`);
    }

    // Update the resource to remove the linked TOTP account
    await repositories.resources.update(resourceId, { totpAccountId: null });

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
}

/**
 * Container for all services.
 */
export interface Services {
  approval: ApprovalService;
  resource: ResourceService;
}

/**
 * Create all services with the given dependencies.
 */
export function createServices(deps: ServiceDependencies): Services {
  return {
    approval: new ApprovalService(deps),
    resource: new ResourceService(deps),
  };
}
