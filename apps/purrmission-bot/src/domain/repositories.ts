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
  ApprovalMode,
  TOTPAccount,
  ResourceField,
  CreateResourceFieldInput,
} from './models.js';
import { encryptValue, decryptValue } from '../infra/crypto.js';
import { logger } from '../logging/logger.js';

import crypto from 'node:crypto';



export interface ResourceRepository {
  create(resource: CreateResourceInput): Promise<Resource>;

  findById(id: string): Promise<Resource | null>;

  findByApiKey(apiKey: string): Promise<Resource | null>;

  update(id: string, data: { totpAccountId?: string | null }): Promise<Resource>;
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

/**
 * Repository for managing ResourceField entities.
 * Values are encrypted at rest using AES-256-GCM.
 */
export interface ResourceFieldRepository {
  /**
   * Create a new field for a resource.
   * The value will be encrypted before storage.
   */
  create(input: CreateResourceFieldInput): Promise<ResourceField>;

  /**
   * Find a field by its ID.
   */
  findById(id: string): Promise<ResourceField | null>;

  /**
   * Find all fields for a resource.
   */
  findByResourceId(resourceId: string): Promise<ResourceField[]>;

  /**
   * Find a field by resource ID and name.
   */
  findByResourceAndName(resourceId: string, name: string): Promise<ResourceField | null>;

  /**
   * Update a field's value.
   * The value will be encrypted before storage.
   */
  update(id: string, value: string): Promise<ResourceField>;

  /**
   * Delete a field by ID.
   */
  delete(id: string): Promise<void>;
}



/**
 * Prisma implementation of ResourceRepository.
 * Persists resources to the database for production use.
 */
export class PrismaResourceRepository implements ResourceRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(input: CreateResourceInput): Promise<Resource> {
    const created = await this.prisma.resource.create({
      data: {
        id: input.id,
        name: input.name,
        mode: input.mode,
        apiKey: input.apiKey,
        totpAccountId: input.totpAccountId ?? null,
      },
    });
    return this.mapPrismaToDomain(created);
  }

  async findById(id: string): Promise<Resource | null> {
    const row = await this.prisma.resource.findUnique({
      where: { id },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async findByApiKey(apiKey: string): Promise<Resource | null> {
    const row = await this.prisma.resource.findFirst({
      where: { apiKey },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async update(id: string, data: { totpAccountId?: string | null }): Promise<Resource> {
    const updated = await this.prisma.resource.update({
      where: { id },
      data: {
        totpAccountId: data.totpAccountId,
      },
    });
    return this.mapPrismaToDomain(updated);
  }

  private mapPrismaToDomain(row: {
    id: string;
    name: string;
    mode: string;
    apiKey: string;
    totpAccountId: string | null;
    createdAt: Date;
  }): Resource {
    // Validate mode is a valid ApprovalMode
    if (!(['ONE_OF_N'] as string[]).includes(row.mode)) {
      throw new Error(`Invalid resource mode in database: ${row.mode}`);
    }

    return {
      id: row.id,
      name: row.name,
      mode: row.mode as ApprovalMode,
      apiKey: row.apiKey,
      totpAccountId: row.totpAccountId ?? undefined,
      createdAt: row.createdAt,
    };
  }
}

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

  async update(id: string, data: { totpAccountId?: string | null }): Promise<Resource> {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new Error(`Resource not found: ${id}`);
    }
    const updated: Resource = {
      ...resource,
      // Convert null to undefined for domain model consistency
      totpAccountId: data.totpAccountId === null ? undefined : (data.totpAccountId ?? resource.totpAccountId),
    };
    this.resources.set(id, updated);
    return updated;
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
    // Encrypt secret and backupKey before storing
    let encryptedSecret: string;
    let encryptedBackupKey: string | null;

    try {
      encryptedSecret = encryptValue(account.secret);
      encryptedBackupKey = account.backupKey ? encryptValue(account.backupKey) : null;
    } catch (error) {
      logger.error('Failed to encrypt TOTP data during creation', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to encrypt TOTP data. Check encryption key configuration.');
    }

    const created = await this.prisma.tOTPAccount.create({
      data: {
        ownerDiscordUserId: account.ownerDiscordUserId,
        accountName: account.accountName,
        secret: encryptedSecret,
        issuer: account.issuer ?? null,
        shared: account.shared,
        backupKey: encryptedBackupKey,
      },
    });

    return this.mapPrismaToDomain(created);
  }

  async update(account: TOTPAccount): Promise<TOTPAccount> {
    // Encrypt secret and backupKey before storing
    let encryptedSecret: string;
    let encryptedBackupKey: string | null;

    try {
      encryptedSecret = encryptValue(account.secret);
      encryptedBackupKey = account.backupKey ? encryptValue(account.backupKey) : null;
    } catch (error) {
      logger.error('Failed to encrypt TOTP data during update', {
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to encrypt TOTP data. Check encryption key configuration.');
    }

    const updated = await this.prisma.tOTPAccount.update({
      where: { id: account.id },
      data: {
        ownerDiscordUserId: account.ownerDiscordUserId,
        accountName: account.accountName,
        secret: encryptedSecret,
        issuer: account.issuer ?? null,
        shared: account.shared,
        backupKey: encryptedBackupKey,
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
    } catch (e) {
      // Prisma's error code for "record to delete does not exist" is P2025.
      // We check for this specific error to avoid swallowing other unexpected errors.
      if ((e as { code?: string }).code === 'P2025') {
        // Record not found, which is fine for an idempotent delete.
        return;
      }
      // Re-throw any other unexpected errors.
      throw e;
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
    // Decrypt secret and backupKey when reading
    let decryptedSecret: string;
    let decryptedBackupKey: string | undefined;

    try {
      decryptedSecret = decryptValue(row.secret);
    } catch (error) {
      // Log detailed error for debugging, but throw generic error to avoid information disclosure
      logger.error('Failed to decrypt TOTP secret', {
        accountId: row.id,
        accountName: row.accountName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to decrypt TOTP secret. Check encryption key configuration.');
    }

    if (row.backupKey) {
      try {
        decryptedBackupKey = decryptValue(row.backupKey);
      } catch (error) {
        // Log detailed error for debugging, but throw generic error to avoid information disclosure
        logger.error('Failed to decrypt TOTP backup key', {
          accountId: row.id,
          accountName: row.accountName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error('Failed to decrypt TOTP backup key. Check encryption key configuration.');
      }
    }

    return {
      id: row.id,
      ownerDiscordUserId: row.ownerDiscordUserId,
      accountName: row.accountName,
      secret: decryptedSecret,
      issuer: row.issuer ?? undefined,
      shared: row.shared,
      backupKey: decryptedBackupKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}



/**
 * In-memory implementation of ResourceFieldRepository.
 */
export class InMemoryResourceFieldRepository implements ResourceFieldRepository {
  private fields: Map<string, ResourceField> = new Map();

  async create(input: CreateResourceFieldInput): Promise<ResourceField> {
    const field: ResourceField = {
      id: crypto.randomUUID(),
      resourceId: input.resourceId,
      name: input.name,
      value: input.value, // In-memory: no encryption needed
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.fields.set(field.id, field);
    return field;
  }

  async findById(id: string): Promise<ResourceField | null> {
    return this.fields.get(id) ?? null;
  }

  async findByResourceId(resourceId: string): Promise<ResourceField[]> {
    const results: ResourceField[] = [];
    for (const field of this.fields.values()) {
      if (field.resourceId === resourceId) {
        results.push(field);
      }
    }
    return results;
  }

  async findByResourceAndName(resourceId: string, name: string): Promise<ResourceField | null> {
    for (const field of this.fields.values()) {
      if (field.resourceId === resourceId && field.name === name) {
        return field;
      }
    }
    return null;
  }

  async update(id: string, value: string): Promise<ResourceField> {
    const field = this.fields.get(id);
    if (!field) {
      throw new Error(`ResourceField with ID ${id} not found`);
    }
    field.value = value;
    field.updatedAt = new Date();
    return field;
  }

  async delete(id: string): Promise<void> {
    this.fields.delete(id);
  }
}

/**
 * Prisma implementation of ResourceFieldRepository.
 * Encrypts values at rest using AES-256-GCM.
 */
export class PrismaResourceFieldRepository implements ResourceFieldRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(input: CreateResourceFieldInput): Promise<ResourceField> {
    const encryptedValue = encryptValue(input.value);
    const created = await this.prisma.resourceField.create({
      data: {
        resourceId: input.resourceId,
        name: input.name,
        value: encryptedValue,
      },
    });
    return this.mapPrismaToDomain(created);
  }

  async findById(id: string): Promise<ResourceField | null> {
    const row = await this.prisma.resourceField.findUnique({
      where: { id },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async findByResourceId(resourceId: string): Promise<ResourceField[]> {
    const rows = await this.prisma.resourceField.findMany({
      where: { resourceId },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  async findByResourceAndName(resourceId: string, name: string): Promise<ResourceField | null> {
    const row = await this.prisma.resourceField.findUnique({
      where: {
        resourceId_name: {
          resourceId,
          name,
        },
      },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async update(id: string, value: string): Promise<ResourceField> {
    const encryptedValue = encryptValue(value);
    const updated = await this.prisma.resourceField.update({
      where: { id },
      data: { value: encryptedValue },
    });
    return this.mapPrismaToDomain(updated);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.prisma.resourceField.delete({
        where: { id },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') {
        return; // Already deleted
      }
      throw e;
    }
  }

  private mapPrismaToDomain(row: {
    id: string;
    resourceId: string;
    name: string;
    value: string;
    createdAt: Date;
    updatedAt: Date;
  }): ResourceField {
    let decryptedValue: string;
    try {
      decryptedValue = decryptValue(row.value);
    } catch (error) {
      // Re-throw with context about which field failed to decrypt
      throw new Error(
        `Failed to decrypt field '${row.name}' (id: ${row.id}) on resource '${row.resourceId}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      id: row.id,
      resourceId: row.resourceId,
      name: row.name,
      value: decryptedValue,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/**
 * Container for all repositories.
 * Used for dependency injection throughout the application.
 */
export interface Repositories {
  resources: ResourceRepository;
  guardians: GuardianRepository;
  approvalRequests: ApprovalRequestRepository;
  totp: TOTPRepository;
  resourceFields: ResourceFieldRepository;
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
    resourceFields: new InMemoryResourceFieldRepository(),
  };
}
