/**
 * Repository interfaces and in-memory implementations.
 *
 * This module defines the data access layer for the Purrmission system.
 * Currently uses in-memory storage for MVP; designed for easy replacement
 * with a real database implementation.
 *
 * TODO: Replace in-memory implementations with Postgres/Prisma for production.
 */
import { type PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { decryptValue, encryptValue } from '../infra/crypto.js';
import { logger } from '../logging/logger.js';
import { DuplicateError } from './errors.js';
import type {
  AddGuardianInput,
  ApiToken,
  ApprovalMode,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalGrant,
  CreateApprovalGrantInput,
  AuditLog,
  AuthSession,
  AuthSessionStatus,
  CreateApiTokenInput,
  CreateApprovalRequestInput,
  CreateAuditLogInput,
  CreateEnvironmentInput,
  CreateProjectInput,
  CreateProjectMemberInput,
  CreateResourceFieldInput,
  CreateResourceInput,
  Environment,
  Guardian,
  GuardianRole,
  Project,
  ProjectMember,
  ProjectMemberRole,
  Resource,
  ResourceField,
  TOTPAccount,
  Credential,
  CredentialType,
  CreateCredentialInput,
  OutboxEvent,
  CreateOutboxEventInput,
  TOTPAccountMetadata,
  ResourceFieldMetadata,
} from './models.js';

export interface ResourceRepository {
  create(resource: CreateResourceInput, tx?: Prisma.TransactionClient): Promise<Resource>;

  findById(id: string): Promise<Resource | null>;

  findByApiKey(apiKey: string): Promise<Resource | null>;

  update(
    id: string,
    data: { totpAccountId?: string | null; totpDelegationEnvelope?: TOTPLinkEnvelope | null },
    tx?: Prisma.TransactionClient
  ): Promise<Resource>;

  findManyByIds(ids: string[], query?: string): Promise<Resource[]>;
}

/**
 * Repository for managing Guardian entities.
 */
export interface GuardianRepository {
  /**
   * Add a new guardian to a resource.
   */
  add(guardian: AddGuardianInput, tx?: Prisma.TransactionClient): Promise<Guardian>;

  /**
   * Find all guardians for a specific resource.
   */
  findByResourceId(resourceId: string): Promise<Guardian[]>;

  /**
   * List all guardians for a specific resource (alias for findByResourceId).
   */
  list(resourceId: string): Promise<Guardian[]>;

  /**
   * Find a specific guardian by resource and Discord user ID.
   */
  findByResourceAndUser(resourceId: string, discordUserId: string): Promise<Guardian | null>;

  /**
   * Find all guardianships for a specific user.
   */
  findByUserId(discordUserId: string): Promise<Guardian[]>;

  /**
   * Remove a guardian from a resource.
   */
  remove(resourceId: string, discordUserId: string, tx?: Prisma.TransactionClient): Promise<void>;
}

/**
 * Repository for managing ApprovalRequest entities.
 */
export interface ApprovalRequestRepository {
  /**
   * Create a new approval request.
   */
  create(
    request: CreateApprovalRequestInput,
    tx?: Prisma.TransactionClient
  ): Promise<ApprovalRequest>;

  /**
   * Update the status of an approval request.
   */
  updateStatus(
    id: string,
    status: ApprovalStatus,
    resolvedBy?: string,
    tx?: Prisma.TransactionClient
  ): Promise<void>;

  /**
   * Find an approval request by its ID.
   */
  findById(id: string): Promise<ApprovalRequest | null>;

  /**
   * Find all pending requests for a resource.
   */
  findPendingByResourceId(resourceId: string): Promise<ApprovalRequest[]>;

  /**
   * Find all requests for a resource.
   */
  findByResourceId(resourceId: string): Promise<ApprovalRequest[]>;

  /**
   * Find an active approval request by resource, requester, action and targetKey.
   */
  findActiveByRequester(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalRequest | null>;

  /**
   * Find a pending request by resource, requester, action, and targetKey.
   */
  findPending(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalRequest | null>;

  /**
   * Mark all pending requests that have passed their expiresAt time as EXPIRED.
   * @returns The number of requests updated.
   */
  expireRequests(tx?: Prisma.TransactionClient): Promise<number>;
}

export interface ApprovalGrantRepository {
  create(input: CreateApprovalGrantInput, tx?: Prisma.TransactionClient): Promise<ApprovalGrant>;

  findById(id: string): Promise<ApprovalGrant | null>;

  findByRequestId(requestId: string): Promise<ApprovalGrant | null>;

  findActiveUnconsumed(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalGrant | null>;

  consume(id: string, tx?: Prisma.TransactionClient): Promise<boolean>;

  revoke(id: string, tx?: Prisma.TransactionClient): Promise<void>;
}

/**
 * Repository for managing TOTPAccount entities.
 */
export interface TOTPRepository {
  create(
    account: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    tx?: Prisma.TransactionClient
  ): Promise<TOTPAccount>;
  update(account: TOTPAccount, tx?: Prisma.TransactionClient): Promise<TOTPAccount>;
  deleteById(id: string, tx?: Prisma.TransactionClient): Promise<void>;
  findById(id: string): Promise<TOTPAccount | null>;
  findByOwnerDiscordUserId(ownerDiscordUserId: string): Promise<TOTPAccount[]>;
  findByOwnerAndName(ownerDiscordUserId: string, accountName: string): Promise<TOTPAccount | null>;
  findMetadataByOwnerDiscordUserId(ownerDiscordUserId: string): Promise<TOTPAccountMetadata[]>;

  createLinkConsent(
    input: Omit<TOTPLinkConsent, 'id' | 'createdAt' | 'usedAt'>,
    tx?: Prisma.TransactionClient
  ): Promise<TOTPLinkConsent>;
  findLinkConsentById(id: string): Promise<TOTPLinkConsent | null>;
  useLinkConsent(id: string, tx?: Prisma.TransactionClient): Promise<void>;

  createDelegationConsent(
    input: Omit<TOTPDelegationConsent, 'id' | 'createdAt' | 'usedAt'>,
    tx?: Prisma.TransactionClient
  ): Promise<TOTPDelegationConsent>;
  findDelegationConsentById(id: string): Promise<TOTPDelegationConsent | null>;
  findActiveDelegationConsent(
    resourceId: string,
    requesterId: string,
    operation: string
  ): Promise<TOTPDelegationConsent | null>;
  useDelegationConsent(id: string, tx?: Prisma.TransactionClient): Promise<void>;
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
  create(input: CreateResourceFieldInput, tx?: Prisma.TransactionClient): Promise<ResourceField>;

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
  update(id: string, value: string, tx?: Prisma.TransactionClient): Promise<ResourceField>;

  /**
   * Delete a field by ID.
   */
  delete(id: string, tx?: Prisma.TransactionClient): Promise<void>;

  findMetadataByResourceId(resourceId: string): Promise<ResourceFieldMetadata[]>;
  findMetadataByResourceAndName(
    resourceId: string,
    name: string
  ): Promise<ResourceFieldMetadata | null>;
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

  async create(input: CreateResourceInput, tx?: Prisma.TransactionClient): Promise<Resource> {
    const client = tx || this.prisma;
    const created = await client.resource.create({
      data: {
        id: input.id,
        name: input.name,
        mode: input.mode,
        apiKey: input.apiKey,
        totpAccountId: input.totpAccountId ?? null,
        version: input.version || randomUUID(),
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

  async update(
    id: string,
    data: { totpAccountId?: string | null; totpDelegationEnvelope?: TOTPLinkEnvelope | null },
    tx?: Prisma.TransactionClient
  ): Promise<Resource> {
    const client = tx || this.prisma;
    const updated = await client.resource.update({
      where: { id },
      data: {
        totpAccountId: data.totpAccountId,
        totpDelegationEnvelope: data.totpDelegationEnvelope as any,
        version: randomUUID(),
      },
    });
    return this.mapPrismaToDomain(updated);
  }

  async findManyByIds(ids: string[], query?: string): Promise<Resource[]> {
    const where: Prisma.ResourceWhereInput = {
      id: { in: ids },
    };
    if (query) {
      where.name = {
        contains: query,
        mode: 'insensitive',
      } as unknown as Prisma.StringFilter;
    }
    const rows = await this.prisma.resource.findMany({ where });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  private mapPrismaToDomain(row: {
    id: string;
    name: string;
    mode: string;
    apiKey: string;
    totpAccountId: string | null;
    totpDelegationEnvelope: any;
    version: string;
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
      totpDelegationEnvelope: row.totpDelegationEnvelope
        ? (row.totpDelegationEnvelope as unknown as TOTPLinkEnvelope)
        : undefined,
      version: row.version,
      createdAt: row.createdAt,
    };
  }
}

export class PrismaTOTPRepository implements TOTPRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Encrypt secret and optional backupKey for storage.
   * @param secret - The TOTP secret to encrypt
   * @param backupKey - Optional backup key to encrypt
   * @param context - Context for logging (e.g., 'creation', 'update')
   * @param accountId - Optional account ID for update context
   */
  private encryptAccountData(
    secret: string,
    backupKey: string | undefined,
    context: string,
    accountId?: string
  ): { encryptedSecret: string; encryptedBackupKey: string | null } {
    try {
      const encryptedSecret = encryptValue(secret);
      const encryptedBackupKey = backupKey ? encryptValue(backupKey) : null;
      return { encryptedSecret, encryptedBackupKey };
    } catch (error) {
      logger.error(`Failed to encrypt TOTP data during ${context}`, {
        ...(accountId && { accountId }),
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to encrypt TOTP data. Check encryption key configuration.');
    }
  }

  /**
   * Decrypt a field value with context-aware error handling.
   * @param encryptedValue - The encrypted value to decrypt
   * @param fieldName - Name of the field for error messages
   * @param accountId - Account ID for logging
   * @param accountName - Account name for logging
   */
  private decryptField(
    encryptedValue: string,
    fieldName: string,
    accountId: string,
    accountName: string
  ): string {
    try {
      return decryptValue(encryptedValue);
    } catch (error) {
      logger.error(`Failed to decrypt TOTP ${fieldName}`, {
        accountId,
        accountName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to decrypt TOTP ${fieldName}. Check encryption key configuration.`);
    }
  }

  async create(
    account: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    tx?: Prisma.TransactionClient
  ): Promise<TOTPAccount> {
    const client = tx || this.prisma;
    const { encryptedSecret, encryptedBackupKey } = this.encryptAccountData(
      account.secret,
      account.backupKey,
      'creation'
    );

    const created = await client.tOTPAccount.create({
      data: {
        ownerDiscordUserId: account.ownerDiscordUserId,
        accountName: account.accountName,
        secret: encryptedSecret,
        issuer: account.issuer ?? null,
        backupKey: encryptedBackupKey,
        version: randomUUID(),
      },
    });

    return this.mapPrismaToDomain(created);
  }

  async update(account: TOTPAccount, tx?: Prisma.TransactionClient): Promise<TOTPAccount> {
    const client = tx || this.prisma;
    const { encryptedSecret, encryptedBackupKey } = this.encryptAccountData(
      account.secret,
      account.backupKey,
      'update',
      account.id
    );

    const updated = await client.tOTPAccount.update({
      where: { id: account.id },
      data: {
        ownerDiscordUserId: account.ownerDiscordUserId,
        accountName: account.accountName,
        secret: encryptedSecret,
        issuer: account.issuer ?? null,
        backupKey: encryptedBackupKey,
        version: randomUUID(),
      },
    });

    // Rotate version on parent/linked Resource if exists
    const linkedResource = await client.resource.findUnique({
      where: { totpAccountId: account.id },
    });
    if (linkedResource) {
      await client.resource.update({
        where: { id: linkedResource.id },
        data: { version: randomUUID() },
      });
    }

    return this.mapPrismaToDomain(updated);
  }

  async deleteById(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx || this.prisma;
    // Find linked resource first
    const linkedResource = await client.resource.findUnique({
      where: { totpAccountId: id },
    });

    try {
      await client.tOTPAccount.delete({
        where: { id },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') {
        return;
      }
      throw e;
    }

    if (linkedResource) {
      await client.resource.update({
        where: { id: linkedResource.id },
        data: { version: randomUUID() },
      });
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

  async findMetadataByOwnerDiscordUserId(
    ownerDiscordUserId: string
  ): Promise<TOTPAccountMetadata[]> {
    const rows = await this.prisma.tOTPAccount.findMany({
      where: { ownerDiscordUserId },
      select: {
        id: true,
        ownerDiscordUserId: true,
        accountName: true,
        issuer: true,
        version: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { accountName: 'asc' },
    });
    return rows;
  }

  async createLinkConsent(
    input: Omit<TOTPLinkConsent, 'id' | 'createdAt' | 'usedAt'>,
    tx?: Prisma.TransactionClient
  ): Promise<TOTPLinkConsent> {
    const client = tx || this.prisma;
    const created = await client.tOTPLinkConsent.create({
      data: {
        accountId: input.accountId,
        resourceId: input.resourceId,
        ownerDiscordUserId: input.ownerDiscordUserId,
        delegationPolicy: input.delegationPolicy as any,
        expiresAt: input.expiresAt,
      },
    });
    return {
      id: created.id,
      accountId: created.accountId,
      resourceId: created.resourceId,
      ownerDiscordUserId: created.ownerDiscordUserId,
      delegationPolicy: created.delegationPolicy as any,
      expiresAt: created.expiresAt,
      usedAt: created.usedAt,
      createdAt: created.createdAt,
    };
  }

  async findLinkConsentById(id: string): Promise<TOTPLinkConsent | null> {
    const found = await this.prisma.tOTPLinkConsent.findUnique({
      where: { id },
    });
    if (!found) return null;
    return {
      id: found.id,
      accountId: found.accountId,
      resourceId: found.resourceId,
      ownerDiscordUserId: found.ownerDiscordUserId,
      delegationPolicy: found.delegationPolicy as any,
      expiresAt: found.expiresAt,
      usedAt: found.usedAt,
      createdAt: found.createdAt,
    };
  }

  async useLinkConsent(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx || this.prisma;
    await client.tOTPLinkConsent.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }

  async createDelegationConsent(
    input: Omit<TOTPDelegationConsent, 'id' | 'createdAt' | 'usedAt'>,
    tx?: Prisma.TransactionClient
  ): Promise<TOTPDelegationConsent> {
    const client = tx || this.prisma;
    const created = await client.tOTPDelegationConsent.create({
      data: {
        resourceId: input.resourceId,
        totpAccountId: input.totpAccountId,
        operation: input.operation,
        requesterId: input.requesterId,
        authFamily: input.authFamily,
        accountVersion: input.accountVersion,
        linkVersion: input.linkVersion,
        expiresAt: input.expiresAt,
      },
    });
    return {
      id: created.id,
      resourceId: created.resourceId,
      totpAccountId: created.totpAccountId,
      operation: created.operation,
      requesterId: created.requesterId,
      authFamily: created.authFamily,
      accountVersion: created.accountVersion,
      linkVersion: created.linkVersion,
      expiresAt: created.expiresAt,
      usedAt: created.usedAt,
      createdAt: created.createdAt,
    };
  }

  async findDelegationConsentById(id: string): Promise<TOTPDelegationConsent | null> {
    const found = await this.prisma.tOTPDelegationConsent.findUnique({
      where: { id },
    });
    if (!found) return null;
    return {
      id: found.id,
      resourceId: found.resourceId,
      totpAccountId: found.totpAccountId,
      operation: found.operation,
      requesterId: found.requesterId,
      authFamily: found.authFamily,
      accountVersion: found.accountVersion,
      linkVersion: found.linkVersion,
      expiresAt: found.expiresAt,
      usedAt: found.usedAt,
      createdAt: found.createdAt,
    };
  }

  async findActiveDelegationConsent(
    resourceId: string,
    requesterId: string,
    operation: string
  ): Promise<TOTPDelegationConsent | null> {
    const now = new Date();
    const found = await this.prisma.tOTPDelegationConsent.findFirst({
      where: {
        resourceId,
        requesterId,
        operation,
        usedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    return found ? this.mapDelegationConsent(found) : null;
  }

  async useDelegationConsent(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx || this.prisma;
    await client.tOTPDelegationConsent.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }

  private mapPrismaToDomain(row: {
    id: string;
    ownerDiscordUserId: string;
    accountName: string;
    secret: string;
    issuer: string | null;
    backupKey?: string | null;
    version: string;
    createdAt: Date;
    updatedAt: Date;
  }): TOTPAccount {
    const decryptedSecret = this.decryptField(row.secret, 'secret', row.id, row.accountName);
    const decryptedBackupKey = row.backupKey
      ? this.decryptField(row.backupKey, 'backup key', row.id, row.accountName)
      : undefined;

    return {
      id: row.id,
      ownerDiscordUserId: row.ownerDiscordUserId,
      accountName: row.accountName,
      secret: decryptedSecret,
      issuer: row.issuer ?? undefined,
      backupKey: decryptedBackupKey,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
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

  async create(
    input: CreateResourceFieldInput,
    tx?: Prisma.TransactionClient
  ): Promise<ResourceField> {
    const client = tx || this.prisma;
    const encryptedValue = encryptValue(input.value);
    const created = await client.resourceField.create({
      data: {
        resourceId: input.resourceId,
        name: input.name,
        value: encryptedValue,
      },
    });
    // Rotate version on parent Resource
    await client.resource.update({
      where: { id: input.resourceId },
      data: { version: randomUUID() },
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

  async update(id: string, value: string, tx?: Prisma.TransactionClient): Promise<ResourceField> {
    const client = tx || this.prisma;
    const encryptedValue = encryptValue(value);
    const updated = await client.resourceField.update({
      where: { id },
      data: { value: encryptedValue },
    });
    // Rotate version on parent Resource
    await client.resource.update({
      where: { id: updated.resourceId },
      data: { version: randomUUID() },
    });
    return this.mapPrismaToDomain(updated);
  }

  async delete(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx || this.prisma;
    // Find record first
    const field = await client.resourceField.findUnique({
      where: { id },
    });
    if (!field) return;

    try {
      await client.resourceField.delete({
        where: { id },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') {
        return; // Already deleted
      }
      throw e;
    }

    // Rotate version on parent Resource
    await client.resource.update({
      where: { id: field.resourceId },
      data: { version: randomUUID() },
    });
  }

  async findMetadataByResourceId(resourceId: string): Promise<ResourceFieldMetadata[]> {
    const rows = await this.prisma.resourceField.findMany({
      where: { resourceId },
      select: {
        id: true,
        resourceId: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { name: 'asc' },
    });
    return rows;
  }

  async findMetadataByResourceAndName(
    resourceId: string,
    name: string
  ): Promise<ResourceFieldMetadata | null> {
    const row = await this.prisma.resourceField.findUnique({
      where: {
        resourceId_name: {
          resourceId,
          name,
        },
      },
      select: {
        id: true,
        resourceId: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return row;
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
  audit: AuditRepository;
  auth: AuthRepository;
  projects: ProjectRepository;
  outbox: OutboxRepository;
  credentials: CredentialRepository;
  approvalGrants: ApprovalGrantRepository;
}

/**
 * Repository for logging audit events.
 */
export interface AuditRepository {
  create(input: CreateAuditLogInput, tx?: Prisma.TransactionClient): Promise<AuditLog>;
  findByResourceId(resourceId: string): Promise<AuditLog[]>;
  findByProjectId(projectId: string): Promise<AuditLog[]>;
}

/**
 * Repository for transactional outbox.
 */
export interface OutboxRepository {
  create(input: CreateOutboxEventInput, tx?: Prisma.TransactionClient): Promise<OutboxEvent>;
  findPending(): Promise<OutboxEvent[]>;
  updateStatus(
    id: string,
    status: 'PENDING' | 'PROCESSED' | 'FAILED',
    attempts: number,
    lastError?: string,
    tx?: Prisma.TransactionClient
  ): Promise<void>;
}

/**
 * Prisma implementation of AuditRepository.
 */
export class PrismaAuditRepository implements AuditRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(input: CreateAuditLogInput, tx?: Prisma.TransactionClient): Promise<AuditLog> {
    const client = tx || this.prisma;
    const created = await client.auditLog.create({
      data: {
        schemaVersion: input.schemaVersion,
        eventType: input.eventType,
        outcomeCode: input.outcomeCode,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        authKind: input.authKind ?? null,
        resourceId: input.resourceId ?? null,
        projectId: input.projectId ?? null,
        environmentId: input.environmentId ?? null,
        requestId: input.requestId ?? null,
        grantId: input.grantId ?? null,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
        payload: input.payload ? (input.payload as Prisma.InputJsonValue) : null,
      },
    });
    return this.mapPrismaToDomain(created);
  }

  async findByResourceId(resourceId: string): Promise<AuditLog[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { resourceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  async findByProjectId(projectId: string): Promise<AuditLog[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  private mapPrismaToDomain(row: {
    id: string;
    schemaVersion: number;
    eventType: string;
    outcomeCode: string;
    actorType: string;
    actorId: string | null;
    authKind: string | null;
    resourceId: string | null;
    projectId: string | null;
    environmentId: string | null;
    requestId: string | null;
    grantId: string | null;
    correlationId: string | null;
    causationId: string | null;
    payload: Prisma.JsonValue;
    createdAt: Date;
  }): AuditLog {
    return {
      id: row.id,
      schemaVersion: row.schemaVersion,
      eventType: row.eventType,
      outcomeCode: row.outcomeCode,
      actorType: row.actorType,
      actorId: row.actorId,
      authKind: row.authKind,
      resourceId: row.resourceId,
      projectId: row.projectId,
      environmentId: row.environmentId,
      requestId: row.requestId,
      grantId: row.grantId,
      correlationId: row.correlationId,
      causationId: row.causationId,
      payload: row.payload as Record<string, unknown> | null,
      createdAt: row.createdAt,
    };
  }
}

/**
 * Prisma implementation of OutboxRepository.
 */
export class PrismaOutboxRepository implements OutboxRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(input: CreateOutboxEventInput, tx?: Prisma.TransactionClient): Promise<OutboxEvent> {
    const client = tx || this.prisma;
    const created = await client.outboxEvent.create({
      data: {
        eventType: input.eventType,
        payload: input.payload as Prisma.InputJsonValue,
      },
    });
    return this.mapPrismaToDomain(created);
  }

  async findPending(): Promise<OutboxEvent[]> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  async updateStatus(
    id: string,
    status: 'PENDING' | 'PROCESSED' | 'FAILED',
    attempts: number,
    lastError?: string,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const client = tx || this.prisma;
    await client.outboxEvent.update({
      where: { id },
      data: {
        status,
        attempts,
        lastError: lastError ?? null,
      },
    });
  }

  private mapPrismaToDomain(row: {
    id: string;
    eventType: string;
    payload: Prisma.JsonValue;
    status: string;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): OutboxEvent {
    return {
      id: row.id,
      eventType: row.eventType,
      payload: row.payload as Record<string, unknown>,
      status: row.status as 'PENDING' | 'PROCESSED' | 'FAILED',
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/**
 * Prisma implementation of GuardianRepository.
 */
export class PrismaGuardianRepository implements GuardianRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async add(input: AddGuardianInput, tx?: Prisma.TransactionClient): Promise<Guardian> {
    const client = tx || this.prisma;
    const created = await client.guardian.create({
      data: {
        id: input.id,
        resourceId: input.resourceId,
        discordUserId: input.discordUserId,
        role: input.role,
      },
    });
    // Rotate version on parent Resource
    await client.resource.update({
      where: { id: input.resourceId },
      data: { version: randomUUID() },
    });
    return this.mapPrismaToDomain(created);
  }

  async findByResourceId(resourceId: string): Promise<Guardian[]> {
    const rows = await this.prisma.guardian.findMany({
      where: { resourceId },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  async list(resourceId: string): Promise<Guardian[]> {
    return this.findByResourceId(resourceId);
  }

  async findByResourceAndUser(resourceId: string, discordUserId: string): Promise<Guardian | null> {
    const row = await this.prisma.guardian.findFirst({
      where: {
        resourceId,
        discordUserId,
      },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async findByUserId(discordUserId: string): Promise<Guardian[]> {
    const rows = await this.prisma.guardian.findMany({
      where: { discordUserId },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  async remove(
    resourceId: string,
    discordUserId: string,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const client = tx || this.prisma;
    // Using deleteMany is safe and idempotent-ish (won't fail if not found).
    await client.guardian.deleteMany({
      where: {
        resourceId,
        discordUserId,
      },
    });
    // Rotate version on parent Resource
    await client.resource.update({
      where: { id: resourceId },
      data: { version: randomUUID() },
    });
  }

  private mapPrismaToDomain(row: {
    id: string;
    resourceId: string;
    discordUserId: string;
    role: string; // Prisma returns string for enums by default unless typed
    createdAt: Date;
  }): Guardian {
    return {
      id: row.id,
      resourceId: row.resourceId,
      discordUserId: row.discordUserId,
      role: row.role as GuardianRole,
      createdAt: row.createdAt,
    };
  }
}

/**
 * Prisma implementation of ApprovalRequestRepository.
 */
export class PrismaApprovalRequestRepository implements ApprovalRequestRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(
    input: CreateApprovalRequestInput,
    tx?: Prisma.TransactionClient
  ): Promise<ApprovalRequest> {
    const client = tx || this.prisma;
    const created = await client.approvalRequest.create({
      data: {
        id: input.id,
        resourceId: input.resourceId,
        status: input.status,
        context: input.context ? (input.context as Prisma.InputJsonValue) : null,
        requesterId: input.requesterId,
        requesterType: input.requesterType,
        authKind: input.authKind,
        action: input.action,
        targetKey: input.targetKey,
        targetVersion: input.targetVersion,
        policyVersion: input.policyVersion,
        constraints: input.constraints ? JSON.stringify(input.constraints) : null,
        callbackUrl: input.callbackUrl,
        expiresAt: input.expiresAt,
        discordMessageId: input.discordMessageId,
        discordChannelId: input.discordChannelId,
      },
    });
    return this.mapPrismaToDomain(created);
  }

  async updateStatus(
    id: string,
    status: ApprovalStatus,
    resolvedBy?: string,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const client = tx || this.prisma;
    const data: Prisma.ApprovalRequestUpdateInput = { status };
    if (resolvedBy) {
      data.resolvedBy = resolvedBy;
      data.resolvedAt = new Date();
    }

    await client.approvalRequest.update({
      where: { id },
      data,
    });
  }

  async findById(id: string): Promise<ApprovalRequest | null> {
    const row = await this.prisma.approvalRequest.findUnique({
      where: { id },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async findPendingByResourceId(resourceId: string): Promise<ApprovalRequest[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        resourceId,
        status: 'PENDING',
      },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  async findByResourceId(resourceId: string): Promise<ApprovalRequest[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        resourceId,
      },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
  }

  async findActiveByRequester(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalRequest | null> {
    const now = new Date();
    const row = await this.prisma.approvalRequest.findFirst({
      where: {
        resourceId,
        requesterId,
        action,
        targetKey,
        status: { in: ['PENDING', 'APPROVED'] },
        expiresAt: { gt: now },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async findPending(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalRequest | null> {
    const now = new Date();
    const row = await this.prisma.approvalRequest.findFirst({
      where: {
        resourceId,
        requesterId,
        action,
        targetKey,
        status: 'PENDING',
        expiresAt: { gt: now },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    return row ? this.mapPrismaToDomain(row) : null;
  }

  async expireRequests(tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx || this.prisma;
    const now = new Date();
    const result = await client.approvalRequest.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: now },
      },
      data: {
        status: 'EXPIRED',
      },
    });
    return result.count;
  }

  private mapPrismaToDomain(row: any): ApprovalRequest {
    return {
      id: row.id,
      resourceId: row.resourceId,
      status: row.status as ApprovalStatus,
      context: row.context as Record<string, unknown> | null,
      requesterId: row.requesterId,
      requesterType: row.requesterType,
      authKind: row.authKind,
      action: row.action,
      targetKey: row.targetKey,
      targetVersion: row.targetVersion,
      policyVersion: row.policyVersion,
      constraints: row.constraints ? JSON.parse(row.constraints) : null,
      callbackUrl: row.callbackUrl ?? undefined,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      resolvedBy: row.resolvedBy ?? undefined,
      resolvedAt: row.resolvedAt ?? undefined,
      discordMessageId: row.discordMessageId ?? undefined,
      discordChannelId: row.discordChannelId ?? undefined,
    };
  }
}

export class PrismaApprovalGrantRepository implements ApprovalGrantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    input: CreateApprovalGrantInput,
    tx?: Prisma.TransactionClient
  ): Promise<ApprovalGrant> {
    const client = tx || this.prisma;
    const row = await client.approvalGrant.create({
      data: {
        requestId: input.requestId,
        resourceId: input.resourceId,
        requesterId: input.requesterId,
        requesterType: input.requesterType,
        authKind: input.authKind,
        action: input.action,
        targetKey: input.targetKey,
        targetVersion: input.targetVersion,
        policyVersion: input.policyVersion,
        constraints: input.constraints ? JSON.stringify(input.constraints) : null,
        expiresAt: input.expiresAt,
      },
    });
    return this.mapRow(row);
  }

  async findById(id: string): Promise<ApprovalGrant | null> {
    const row = await this.prisma.approvalGrant.findUnique({ where: { id } });
    return row ? this.mapRow(row) : null;
  }

  async findByRequestId(requestId: string): Promise<ApprovalGrant | null> {
    const row = await this.prisma.approvalGrant.findUnique({ where: { requestId } });
    return row ? this.mapRow(row) : null;
  }

  async findActiveUnconsumed(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalGrant | null> {
    const now = new Date();
    const row = await this.prisma.approvalGrant.findFirst({
      where: {
        resourceId,
        requesterId,
        action,
        targetKey,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    return row ? this.mapRow(row) : null;
  }

  async consume(id: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const client = tx || this.prisma;
    const result = await client.approvalGrant.updateMany({
      where: {
        id,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        consumedAt: new Date(),
      },
    });
    return result.count === 1;
  }

  async revoke(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx || this.prisma;
    await client.approvalGrant.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  private mapRow(row: any): ApprovalGrant {
    return {
      id: row.id,
      requestId: row.requestId,
      resourceId: row.resourceId,
      requesterId: row.requesterId,
      requesterType: row.requesterType,
      authKind: row.authKind,
      action: row.action,
      targetKey: row.targetKey,
      targetVersion: row.targetVersion,
      policyVersion: row.policyVersion,
      constraints: row.constraints ? JSON.parse(row.constraints) : null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
      revokedAt: row.revokedAt,
    };
  }
}

export interface AuthRepository {
  createSession(input: {
    deviceCode: string;
    userCode: string;
    expiresAt: Date;
  }): Promise<AuthSession>;
  findSessionByDeviceCode(deviceCode: string): Promise<AuthSession | null>;
  findSessionByUserCode(userCode: string): Promise<AuthSession | null>;
  updateSessionStatus(id: string, status: AuthSessionStatus, userId?: string): Promise<void>;
  transitionSessionStatus(
    id: string,
    fromStatus: AuthSessionStatus,
    toStatus: AuthSessionStatus,
    userId?: string
  ): Promise<boolean>;
  createApiToken(input: CreateApiTokenInput): Promise<ApiToken>;
  findApiToken(token: string): Promise<ApiToken | null>;
  updateApiTokenLastUsed(id: string): Promise<void>;
  deleteExpiredSessions(): Promise<number>;
}

export interface CredentialRepository {
  create(input: CreateCredentialInput, tx?: Prisma.TransactionClient): Promise<Credential>;
  findById(id: string): Promise<Credential | null>;
  findByDigest(digest: string): Promise<Credential | null>;
  findBySubject(subjectId: string): Promise<Credential[]>;
  revoke(id: string, tx?: Prisma.TransactionClient): Promise<void>;
  updateLastUsed(id: string, tx?: Prisma.TransactionClient): Promise<void>;
}

export interface ProjectRepository {
  createProject(input: CreateProjectInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  listProjectsByOwner(ownerId: string): Promise<Project[]>;

  createEnvironment(input: CreateEnvironmentInput): Promise<Environment>;
  listEnvironments(projectId: string): Promise<Environment[]>;
  findEnvironment(projectId: string, slug: string): Promise<Environment | null>;
  getEnvironmentById(projectId: string, envId: string): Promise<Environment | null>;
  findEnvironmentByResourceId(resourceId: string): Promise<Environment | null>;

  addMember(input: CreateProjectMemberInput): Promise<ProjectMember>;
  removeMember(projectId: string, userId: string): Promise<void>;
  getMemberRole(projectId: string, userId: string): Promise<ProjectMemberRole | null>;
  listMembers(projectId: string): Promise<ProjectMember[]>;
  listMembershipsByUser(userId: string): Promise<ProjectMember[]>;
}

export class PrismaAuthRepository implements AuthRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async createSession(input: {
    deviceCode: string;
    userCode: string;
    expiresAt: Date;
  }): Promise<AuthSession> {
    const session = await this.prisma.authSession.create({
      data: {
        deviceCode: input.deviceCode,
        userCode: input.userCode,
        status: 'PENDING',
        expiresAt: input.expiresAt,
      },
    });
    return this.mapSession(session);
  }

  async findSessionByDeviceCode(deviceCode: string): Promise<AuthSession | null> {
    const session = await this.prisma.authSession.findUnique({ where: { deviceCode } });
    return session ? this.mapSession(session) : null;
  }

  async findSessionByUserCode(userCode: string): Promise<AuthSession | null> {
    const session = await this.prisma.authSession.findUnique({ where: { userCode } });
    return session ? this.mapSession(session) : null;
  }

  async updateSessionStatus(id: string, status: AuthSessionStatus, userId?: string): Promise<void> {
    if (status === 'APPROVED' && !userId) {
      throw new Error('userId is required for APPROVED status');
    }

    await this.prisma.authSession.update({
      where: { id },
      data: { status, userId: userId || null },
    });
  }

  async transitionSessionStatus(
    id: string,
    fromStatus: AuthSessionStatus,
    toStatus: AuthSessionStatus,
    userId?: string
  ): Promise<boolean> {
    const data: Prisma.AuthSessionUpdateInput = { status: toStatus };
    if (userId !== undefined) {
      data.userId = userId;
    }
    const result = await this.prisma.authSession.updateMany({
      where: {
        id,
        status: fromStatus,
      },
      data,
    });
    return result.count === 1;
  }

  async createApiToken(input: CreateApiTokenInput): Promise<ApiToken> {
    const token = await this.prisma.apiToken.create({
      data: {
        token: input.token,
        userId: input.userId,
        name: input.name,
        expiresAt: input.expiresAt,
      },
    });
    return this.mapToken(token);
  }

  async findApiToken(token: string): Promise<ApiToken | null> {
    const row = await this.prisma.apiToken.findUnique({ where: { token } });
    return row ? this.mapToken(row) : null;
  }

  async updateApiTokenLastUsed(id: string): Promise<void> {
    await this.prisma.apiToken.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }

  async deleteExpiredSessions(): Promise<number> {
    const result = await this.prisma.authSession.deleteMany({
      where: {
        OR: [{ status: 'EXPIRED' }, { status: 'CONSUMED' }, { expiresAt: { lt: new Date() } }],
      },
    });
    return result.count;
  }

  private isValidAuthSessionStatus(value: unknown): value is AuthSessionStatus {
    return (
      value === 'PENDING' ||
      value === 'APPROVED' ||
      value === 'EXPIRED' ||
      value === 'DENIED' ||
      value === 'CONSUMED'
    );
  }
  private mapSession(row: {
    id: string;
    deviceCode: string;
    userCode: string;
    status: string; // Prisma returns string for enums unless typed
    userId: string | null;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }): AuthSession {
    const status = row.status;
    if (!this.isValidAuthSessionStatus(status)) {
      throw new Error(`Invalid auth session status from database: ${String(status)}`);
    }
    return {
      id: row.id,
      deviceCode: row.deviceCode,
      userCode: row.userCode,
      status: status,
      userId: row.userId ?? undefined,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapToken(row: {
    id: string;
    token: string;
    userId: string;
    name: string;
    lastUsedAt: Date | null;
    expiresAt: Date;
    createdAt: Date;
  }): ApiToken {
    return {
      id: row.id,
      token: row.token,
      userId: row.userId,
      name: row.name,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
}

/**
 * Prisma implementation of ProjectRepository.
 */
export class PrismaProjectRepository implements ProjectRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const project = await this.prisma.project.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        ownerId: input.ownerId,
        policyVersion: randomUUID(),
      },
    });
    return {
      ...project,
      description: project.description ?? null,
      policyVersion: project.policyVersion,
    };
  }

  async findById(id: string): Promise<Project | null> {
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (!row) return null;
    return {
      ...row,
      description: row.description ?? null,
      policyVersion: row.policyVersion,
    };
  }

  async listProjectsByOwner(ownerId: string): Promise<Project[]> {
    const rows = await this.prisma.project.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      ...row,
      description: row.description ?? null,
      policyVersion: row.policyVersion,
    }));
  }

  async createEnvironment(input: CreateEnvironmentInput): Promise<Environment> {
    try {
      const env = await this.prisma.environment.create({
        data: {
          name: input.name,
          slug: input.slug,
          projectId: input.projectId,
          resourceId: input.resourceId,
        },
      });
      return {
        ...env,
        resourceId: env.resourceId ?? undefined,
      };
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        throw new DuplicateError(
          `Environment with slug "${input.slug}" already exists in this project.`
        );
      }
      throw error;
    }
  }

  async listEnvironments(projectId: string): Promise<Environment[]> {
    const rows = await this.prisma.environment.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({
      ...row,
      resourceId: row.resourceId ?? undefined,
    }));
  }

  async findEnvironment(projectId: string, slug: string): Promise<Environment | null> {
    const row = await this.prisma.environment.findUnique({
      where: {
        projectId_slug: { projectId, slug },
      },
    });
    if (!row) return null;
    return {
      ...row,
      resourceId: row.resourceId ?? undefined,
    };
  }

  async getEnvironmentById(projectId: string, envId: string): Promise<Environment | null> {
    const row = await this.prisma.environment.findFirst({
      where: {
        projectId,
        id: envId,
      },
    });
    if (!row) return null;
    return {
      ...row,
      resourceId: row.resourceId ?? undefined,
    };
  }

  async addMember(input: CreateProjectMemberInput): Promise<ProjectMember> {
    try {
      const member = await this.prisma.projectMember.create({
        data: {
          projectId: input.projectId,
          userId: input.userId,
          role: input.role ?? 'READER',
          addedBy: input.addedBy,
        },
      });
      // Rotate project policyVersion
      await this.prisma.project.update({
        where: { id: input.projectId },
        data: { policyVersion: randomUUID() },
      });
      return {
        ...member,
        role: member.role as ProjectMemberRole,
      };
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        // Already exists, try to update role? Or just throw duplicate.
        // For now, let's treat it as an update if they try to add again
        const member = await this.prisma.projectMember.update({
          where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
          data: { role: input.role ?? 'READER' },
        });
        // Rotate project policyVersion
        await this.prisma.project.update({
          where: { id: input.projectId },
          data: { policyVersion: randomUUID() },
        });
        return { ...member, role: member.role as ProjectMemberRole };
      }
      throw error;
    }
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    try {
      await this.prisma.projectMember.delete({
        where: { projectId_userId: { projectId, userId } },
      });
      // Rotate project policyVersion
      await this.prisma.project.update({
        where: { id: projectId },
        data: { policyVersion: randomUUID() },
      });
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2025')
        return; // Not found, ignore
      throw e;
    }
  }

  async getMemberRole(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    return member ? (member.role as ProjectMemberRole) : null;
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return members.map((m) => ({
      ...m,
      role: m.role as ProjectMemberRole,
    }));
  }

  async findEnvironmentByResourceId(resourceId: string): Promise<Environment | null> {
    const row = await this.prisma.environment.findUnique({
      where: { resourceId },
    });
    if (!row) return null;
    return {
      ...row,
      resourceId: row.resourceId ?? undefined,
    };
  }

  async listMembershipsByUser(userId: string): Promise<ProjectMember[]> {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return memberships.map((m) => ({
      ...m,
      role: m.role as ProjectMemberRole,
    }));
  }
}

export class PrismaCredentialRepository implements CredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateCredentialInput, tx?: Prisma.TransactionClient): Promise<Credential> {
    const client = tx || this.prisma;
    const row = await client.credential.create({
      data: {
        type: input.type,
        subjectId: input.subjectId,
        name: input.name,
        digest: input.digest,
        prefix: input.prefix,
        scopes: input.scopes,
        audience: input.audience,
        expiresAt: input.expiresAt,
        revokedAt: input.revokedAt,
      },
    });
    return this.mapRow(row);
  }

  async findById(id: string): Promise<Credential | null> {
    const row = await this.prisma.credential.findUnique({ where: { id } });
    return row ? this.mapRow(row) : null;
  }

  async findByDigest(digest: string): Promise<Credential | null> {
    const row = await this.prisma.credential.findUnique({ where: { digest } });
    return row ? this.mapRow(row) : null;
  }

  async findBySubject(subjectId: string): Promise<Credential[]> {
    const rows = await this.prisma.credential.findMany({ where: { subjectId } });
    return rows.map((r) => this.mapRow(r));
  }

  async revoke(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx || this.prisma;
    await client.credential.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  async updateLastUsed(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx || this.prisma;
    await client.credential.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }

  private mapRow(row: any): Credential {
    return {
      id: row.id,
      type: row.type as CredentialType,
      subjectId: row.subjectId,
      name: row.name,
      digest: row.digest,
      prefix: row.prefix,
      scopes: row.scopes,
      audience: row.audience,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
      version: row.version,
    };
  }
}
