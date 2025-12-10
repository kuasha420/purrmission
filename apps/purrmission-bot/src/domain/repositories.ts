/**
 * Repository interfaces and in-memory implementations.
 *
 * This module defines the data access layer for the Purrmission system.
 * Currently uses in-memory storage for MVP; designed for easy replacement
 * with a real database implementation.
 *
 * TODO: Replace in-memory implementations with Postgres/Prisma for production.
 */

import type {
    Resource,
    Guardian,
    ApprovalRequest,
    CreateResourceInput,
    AddGuardianInput,
    CreateApprovalRequestInput,
    ApprovalStatus,
} from './models.js';

// =============================================================================
// Repository Interfaces
// =============================================================================

/**
 * Repository for managing Resource entities.
 */
export interface ResourceRepository {
    /**
     * Create a new resource.
     */
    create(resource: CreateResourceInput): Promise<Resource>;

    /**
     * Find a resource by its ID.
     */
    findById(id: string): Promise<Resource | null>;

    /**
     * Find a resource by its API key.
     */
    findByApiKey(apiKey: string): Promise<Resource | null>;
}

/**
 * Repository for managing Guardian entities.
 */
export interface GuardianRepository {
    /**
     * Add a new guardian to a resource.
     */
    add(guardian: AddGuardianInput): Promise<Guardian>;

    /**
     * Find all guardians for a specific resource.
     */
    findByResourceId(resourceId: string): Promise<Guardian[]>;

    /**
     * Find a specific guardian by resource and Discord user ID.
     */
    findByResourceAndUser(resourceId: string, discordUserId: string): Promise<Guardian | null>;
}

/**
 * Repository for managing ApprovalRequest entities.
 */
export interface ApprovalRequestRepository {
    /**
     * Create a new approval request.
     */
    create(request: CreateApprovalRequestInput): Promise<ApprovalRequest>;

    /**
     * Update the status of an approval request.
     */
    updateStatus(
        id: string,
        status: ApprovalStatus,
        resolvedBy?: string
    ): Promise<void>;

    /**
     * Find an approval request by its ID.
     */
    findById(id: string): Promise<ApprovalRequest | null>;

    /**
     * Find all pending requests for a resource.
     */
    findPendingByResourceId(resourceId: string): Promise<ApprovalRequest[]>;
}

// =============================================================================
// In-Memory Implementations
// =============================================================================

/**
 * In-memory implementation of ResourceRepository.
 *
 * TODO: Replace with Prisma/Postgres implementation for production.
 * This implementation stores all data in memory and is lost on restart.
 */
export class InMemoryResourceRepository implements ResourceRepository {
    private resources: Map<string, Resource> = new Map();

    async create(input: CreateResourceInput): Promise<Resource> {
        const resource: Resource = {
            ...input,
            createdAt: new Date(),
        };
        this.resources.set(resource.id, resource);
        return resource;
    }

    async findById(id: string): Promise<Resource | null> {
        return this.resources.get(id) ?? null;
    }

    async findByApiKey(apiKey: string): Promise<Resource | null> {
        for (const resource of this.resources.values()) {
            // TODO: Use constant-time comparison for security
            if (resource.apiKey === apiKey) {
                return resource;
            }
        }
        return null;
    }
}

/**
 * In-memory implementation of GuardianRepository.
 *
 * TODO: Replace with Prisma/Postgres implementation for production.
 * This implementation stores all data in memory and is lost on restart.
 */
export class InMemoryGuardianRepository implements GuardianRepository {
    private guardians: Map<string, Guardian> = new Map();

    async add(input: AddGuardianInput): Promise<Guardian> {
        const guardian: Guardian = {
            ...input,
            createdAt: new Date(),
        };
        this.guardians.set(guardian.id, guardian);
        return guardian;
    }

    async findByResourceId(resourceId: string): Promise<Guardian[]> {
        const result: Guardian[] = [];
        for (const guardian of this.guardians.values()) {
            if (guardian.resourceId === resourceId) {
                result.push(guardian);
            }
        }
        return result;
    }

    async findByResourceAndUser(
        resourceId: string,
        discordUserId: string
    ): Promise<Guardian | null> {
        for (const guardian of this.guardians.values()) {
            if (
                guardian.resourceId === resourceId &&
                guardian.discordUserId === discordUserId
            ) {
                return guardian;
            }
        }
        return null;
    }
}

/**
 * In-memory implementation of ApprovalRequestRepository.
 *
 * TODO: Replace with Prisma/Postgres implementation for production.
 * This implementation stores all data in memory and is lost on restart.
 */
export class InMemoryApprovalRequestRepository implements ApprovalRequestRepository {
    private requests: Map<string, ApprovalRequest> = new Map();

    async create(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
        const request: ApprovalRequest = {
            ...input,
            createdAt: new Date(),
        };
        this.requests.set(request.id, request);
        return request;
    }

    async updateStatus(
        id: string,
        status: ApprovalStatus,
        resolvedBy?: string
    ): Promise<void> {
        const request = this.requests.get(id);
        if (request) {
            request.status = status;
            if (resolvedBy) {
                request.resolvedBy = resolvedBy;
                request.resolvedAt = new Date();
            }
        }
    }

    async findById(id: string): Promise<ApprovalRequest | null> {
        return this.requests.get(id) ?? null;
    }

    async findPendingByResourceId(resourceId: string): Promise<ApprovalRequest[]> {
        const result: ApprovalRequest[] = [];
        for (const request of this.requests.values()) {
            if (request.resourceId === resourceId && request.status === 'PENDING') {
                result.push(request);
            }
        }
        return result;
    }
}

// =============================================================================
// Repository Container
// =============================================================================

/**
 * Container for all repositories.
 * Used for dependency injection throughout the application.
 */
export interface Repositories {
    resources: ResourceRepository;
    guardians: GuardianRepository;
    approvalRequests: ApprovalRequestRepository;
}

/**
 * Create in-memory repositories for MVP.
 */
export function createInMemoryRepositories(): Repositories {
    return {
        resources: new InMemoryResourceRepository(),
        guardians: new InMemoryGuardianRepository(),
        approvalRequests: new InMemoryApprovalRequestRepository(),
    };
}
