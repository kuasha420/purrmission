/**
 * Repository interfaces and in-memory implementations.
 *
 * This module defines the data access layer for the Purrmission system.
 * Currently uses in-memory storage for MVP; designed for easy replacement
 * with a real database implementation.
 *
 * TODO: Replace in-memory implementations with Postgres/Prisma for production.
 */

import type { PrismaClient } from '@prisma/client';
import type {
  Resource,
  Guardian,
  ApprovalRequest,
  CreateResourceInput,
  AddGuardianInput,
  CreateApprovalRequestInput,
  ApprovalStatus,
  TOTPAccount,
} from './models.js';

import crypto from 'node:crypto';

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
  updateStatus(id: string, status: ApprovalStatus, resolvedBy?: string): Promise<void>;

  /**
   * Find an approval request by its ID.
   */
  findById(id: string): Promise<ApprovalRequest | null>;

  /**
   * Find all pending requests for a resource.
   */
  findPendingByResourceId(resourceId: string): Promise<ApprovalRequest[]>;
}

/**
 * Repository for managing TOTPAccount entities.
 */
export interface TOTPRepository {
  create(account: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<TOTPAccount>;
  update(account: TOTPAccount): Promise<TOTPAccount>;
  deleteById(id: string): Promise<void>;
  findById(id: string): Promise<TOTPAccount | null>;
  findByOwnerDiscordUserId(ownerDiscordUserId: string): Promise<TOTPAccount[]>;
  findByOwnerAndName(ownerDiscordUserId: string, accountName: string): Promise<TOTPAccount | null>;
  /**
   * Find all shared accounts visible to the given user.
   * TODO: Implement fine-grained ACLs. For now, returns all shared accounts.
   */
  findSharedVisibleTo(discordUserId: string): Promise<TOTPAccount[]>;
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

  async findByResourceAndUser(resourceId: string, discordUserId: string): Promise<Guardian | null> {
    for (const guardian of this.guardians.values()) {
      if (guardian.resourceId === resourceId && guardian.discordUserId === discordUserId) {
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

  async updateStatus(id: string, status: ApprovalStatus, resolvedBy?: string): Promise<void> {
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

/**
 * In-memory implementation of TOTPRepository.
 */
export class InMemoryTOTPRepository implements TOTPRepository {
  private accounts: Map<string, TOTPAccount> = new Map();

  async create(account: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<TOTPAccount> {
    const newAccount: TOTPAccount = {
      ...account,
      id: crypto.randomUUID(),
      backupKey: account.backupKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.accounts.set(newAccount.id, newAccount);
    return newAccount;
  }

  async update(account: TOTPAccount): Promise<TOTPAccount> {
    const existing = this.accounts.get(account.id);
    if (!existing) {
      throw new Error(`TOTPAccount with ID ${account.id} not found`);
    }
    const updated: TOTPAccount = {
      ...account,
      backupKey: account.backupKey,
      updatedAt: new Date(),
    };
    this.accounts.set(updated.id, updated);
    return updated;
  }

  async deleteById(id: string): Promise<void> {
    this.accounts.delete(id);
  }

  async findById(id: string): Promise<TOTPAccount | null> {
    return this.accounts.get(id) ?? null;
  }

  async findByOwnerDiscordUserId(ownerDiscordUserId: string): Promise<TOTPAccount[]> {
    const results: TOTPAccount[] = [];
    for (const account of this.accounts.values()) {
      if (account.ownerDiscordUserId === ownerDiscordUserId) {
        results.push(account);
      }
    }
    return results;
  }

  async findByOwnerAndName(
    ownerDiscordUserId: string,
    accountName: string
  ): Promise<TOTPAccount | null> {
    for (const account of this.accounts.values()) {
      if (
        account.ownerDiscordUserId === ownerDiscordUserId &&
        account.accountName === accountName
      ) {
        return account;
      }
    }
    return null;
  }

  async findSharedVisibleTo(_discordUserId: string): Promise<TOTPAccount[]> {
    // TODO: Implement fine-grained ACLs
    const results: TOTPAccount[] = [];
    for (const account of this.accounts.values()) {
      if (account.shared) {
        results.push(account);
      }
    }
    return results;
  }
}

export class PrismaTOTPRepository implements TOTPRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(account: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<TOTPAccount> {
    const created = await this.prisma.tOTPAccount.create({
      data: {
        ownerDiscordUserId: account.ownerDiscordUserId,
        accountName: account.accountName,
        secret: account.secret,
        issuer: account.issuer ?? null,
        shared: account.shared,
      },
    });

    return this.mapPrismaToDomain(created);
  }

  async update(account: TOTPAccount): Promise<TOTPAccount> {
    const updated = await this.prisma.tOTPAccount.update({
      where: { id: account.id },
      data: {
        ownerDiscordUserId: account.ownerDiscordUserId,
        accountName: account.accountName,
        secret: account.secret,
        issuer: account.issuer ?? null,
        shared: account.shared,
      },
    });

    return this.mapPrismaToDomain(updated);
  }

  async deleteById(id: string): Promise<void> {
    // If record doesn't exist, Prisma will throw; swallow "not found" errors for idempotency.
    try {
      await this.prisma.tOTPAccount.delete({
        where: { id },
      });
    } catch {
      // TODO: optionally check for Prisma.PrismaClientKnownRequestError and ignore P2025 (record not found)
    }
  }

  async findById(id: string): Promise<TOTPAccount | null> {
    const row = await this.prisma.tOTPAccount.findUnique({
      where: { id },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async findByOwnerDiscordUserId(ownerDiscordUserId: string): Promise<TOTPAccount[]> {
    const rows = await this.prisma.tOTPAccount.findMany({
      where: { ownerDiscordUserId },
      orderBy: { accountName: 'asc' },
    });

    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  async findByOwnerAndName(
    ownerDiscordUserId: string,
    accountName: string
  ): Promise<TOTPAccount | null> {
    const row = await this.prisma.tOTPAccount.findUnique({
      where: {
        ownerDiscordUserId_accountName: {
          ownerDiscordUserId,
          accountName,
        },
      },
    });

    return row ? this.mapPrismaToDomain(row) : null;
  }

  async findSharedVisibleTo(_discordUserId: string): Promise<TOTPAccount[]> {
    // MVP: all shared accounts are visible to everyone.
    const rows = await this.prisma.tOTPAccount.findMany({
      where: { shared: true },
      orderBy: { accountName: 'asc' },
    });

    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  private mapPrismaToDomain(row: {
    id: string;
    ownerDiscordUserId: string;
    accountName: string;
    secret: string;
    issuer: string | null;
    shared: boolean;
    backupKey?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): TOTPAccount {
    return {
      id: row.id,
      ownerDiscordUserId: row.ownerDiscordUserId,
      accountName: row.accountName,
      secret: row.secret,
      issuer: row.issuer ?? undefined,
      shared: row.shared,
      backupKey: row.backupKey ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
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
  totp: TOTPRepository;
}

/**
 * Create in-memory repositories for MVP.
 */
export function createInMemoryRepositories(): Repositories {
  return {
    resources: new InMemoryResourceRepository(),
    guardians: new InMemoryGuardianRepository(),
    approvalRequests: new InMemoryApprovalRequestRepository(),
    totp: new InMemoryTOTPRepository(),
  };
}
