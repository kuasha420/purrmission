/**
 * Repository interfaces and in-memory implementations.
 *
 * This module defines the data access layer for the Purrmission system.
 * Currently uses in-memory storage for MVP; designed for easy replacement
 * with a real database implementation.
 *
 * TODO: Replace in-memory implementations with Postgres/Prisma for production.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import type {
  Resource,
  Guardian,
  GuardianRole,
  ApprovalRequest,
  CreateResourceInput,
  AddGuardianInput,
  CreateApprovalRequestInput,
  ApprovalStatus,
  ApprovalMode,
  TOTPAccount,
  ResourceField,
  CreateResourceFieldInput,
  AuditLog,
  CreateAuditLogInput,
  AuthSession,
  AuthSessionStatus,
  ApiToken,
  CreateApiTokenInput,
  Project,
  Environment,
  CreateProjectInput,
  CreateEnvironmentInput,
} from './models.js';
import { encryptValue, decryptValue } from '../infra/crypto.js';
import { DuplicateError, ResourceNotFoundError } from './errors.js';

import crypto from 'node:crypto';
import { logger } from '../logging/logger.js';



export interface ResourceRepository {
  create(resource: CreateResourceInput): Promise<Resource>;

  findById(id: string): Promise<Resource | null>;

  findByApiKey(apiKey: string): Promise<Resource | null>;

  update(id: string, data: { totpAccountId?: string | null }): Promise<Resource>;

  findManyByIds(ids: string[]): Promise<Resource[]>;
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

  /**
   * Find all guardianships for a specific user.
   */
  findByUserId(discordUserId: string): Promise<Guardian[]>;

  /**
   * Remove a guardian from a resource.
   */
  remove(resourceId: string, discordUserId: string): Promise<void>;
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

  /**
   * Find all requests for a resource.
   */
  findByResourceId(resourceId: string): Promise<ApprovalRequest[]>;

  /**
   * Find an active approval request by resource and requester.
   */
  findActiveByRequester(resourceId: string, requesterId: string): Promise<ApprovalRequest | null>;
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

  async findManyByIds(ids: string[]): Promise<Resource[]> {
    const rows = await this.prisma.resource.findMany({
      where: {
        id: { in: ids },
      },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
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

  async create(account: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<TOTPAccount> {
    const { encryptedSecret, encryptedBackupKey } = this.encryptAccountData(
      account.secret,
      account.backupKey,
      'creation'
    );

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
    const { encryptedSecret, encryptedBackupKey } = this.encryptAccountData(
      account.secret,
      account.backupKey,
      'update',
      account.id
    );

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
      shared: row.shared,
      backupKey: decryptedBackupKey,
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
  audit: AuditRepository;
  auth: AuthRepository;
  projects: ProjectRepository;
}

/**
 * Repository for logging audit events.
 */
export interface AuditRepository {
  create(input: CreateAuditLogInput): Promise<AuditLog>;
  findByResourceId(resourceId: string): Promise<AuditLog[]>;
}

/**
 * Prisma implementation of AuditRepository.
 */
export class PrismaAuditRepository implements AuditRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(input: CreateAuditLogInput): Promise<AuditLog> {
    const created = await this.prisma.auditLog.create({
      data: {
        action: input.action,
        resourceId: input.resourceId,
        actorId: input.actorId,
        resolverId: input.resolverId,
        status: input.status,
        context: input.context,
      },
    });
    return created;
  }

  async findByResourceId(resourceId: string): Promise<AuditLog[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { resourceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
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

  async add(input: AddGuardianInput): Promise<Guardian> {
    const created = await this.prisma.guardian.create({
      data: {
        id: input.id,
        resourceId: input.resourceId,
        discordUserId: input.discordUserId,
        role: input.role,
      },
    });
    return this.mapPrismaToDomain(created);
  }

  async findByResourceId(resourceId: string): Promise<Guardian[]> {
    const rows = await this.prisma.guardian.findMany({
      where: { resourceId },
    });
    return rows.map((row) => this.mapPrismaToDomain(row));
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

  async remove(resourceId: string, discordUserId: string): Promise<void> {
    // Using deleteMany is safe and idempotent-ish (won't fail if not found).
    await this.prisma.guardian.deleteMany({
      where: {
        resourceId,
        discordUserId,
      },
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

  async create(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
    const created = await this.prisma.approvalRequest.create({
      data: {
        id: input.id,
        resourceId: input.resourceId,
        status: input.status,
        context: input.context as Prisma.InputJsonValue,
        callbackUrl: input.callbackUrl,
        expiresAt: input.expiresAt,
        discordMessageId: input.discordMessageId,
        discordChannelId: input.discordChannelId,
      },
    });
    return this.mapPrismaToDomain(created);
  }

  async updateStatus(id: string, status: ApprovalStatus, resolvedBy?: string): Promise<void> {
    const data: Prisma.ApprovalRequestUpdateInput = { status };
    if (resolvedBy) {
      data.resolvedBy = resolvedBy;
      data.resolvedAt = new Date();
    }

    await this.prisma.approvalRequest.update({
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

  async findActiveByRequester(resourceId: string, requesterId: string): Promise<ApprovalRequest | null> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        resourceId,
        status: { in: ['PENDING', 'APPROVED'] },
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // NOTE: In-memory filtering is used here as a workaround for Prisma's SQLite provider,
    // which has limitations with JSON path queries. This may have performance implications
    // for resources with a very large number of approval requests.
    const match = rows.find(row => {
      const ctx = row.context as Record<string, unknown>;
      return ctx?.requesterId === requesterId;
    });

    return match ? this.mapPrismaToDomain(match) : null;
  }

  private mapPrismaToDomain(row: {
    id: string;
    resourceId: string;
    status: string;
    context: any;
    callbackUrl: string | null;
    createdAt: Date;
    expiresAt: Date | null;
    resolvedBy: string | null;
    resolvedAt: Date | null;
    discordMessageId: string | null;
    discordChannelId: string | null;
  }): ApprovalRequest {
    return {
      id: row.id,
      resourceId: row.resourceId,
      status: row.status as ApprovalStatus,
      context: row.context,
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

export interface AuthRepository {
  createSession(input: { deviceCode: string; userCode: string; expiresAt: Date }): Promise<AuthSession>;
  findSessionByDeviceCode(deviceCode: string): Promise<AuthSession | null>;
  findSessionByUserCode(userCode: string): Promise<AuthSession | null>;
  updateSessionStatus(id: string, status: AuthSessionStatus, userId?: string): Promise<void>;
  createApiToken(input: CreateApiTokenInput): Promise<ApiToken>;
  findApiToken(token: string): Promise<ApiToken | null>;
  updateApiTokenLastUsed(id: string): Promise<void>;
  deleteExpiredSessions(): Promise<number>;
}

export interface ProjectRepository {
  createProject(input: CreateProjectInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  listProjectsByOwner(ownerId: string): Promise<Project[]>;

  createEnvironment(input: CreateEnvironmentInput): Promise<Environment>;
  listEnvironments(projectId: string): Promise<Environment[]>;
  findEnvironment(projectId: string, slug: string): Promise<Environment | null>;
}


export class PrismaAuthRepository implements AuthRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async createSession(input: { deviceCode: string; userCode: string; expiresAt: Date }): Promise<AuthSession> {
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
        OR: [
          { status: 'EXPIRED' },
          { status: 'CONSUMED' },
          { expiresAt: { lt: new Date() } },
        ],
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
      }
    });
    return {
      ...project,
    };
  }

  async findById(id: string): Promise<Project | null> {
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (!row) return null;
    return {
      ...row,
      description: row.description ?? null,
    };
  }

  async listProjectsByOwner(ownerId: string): Promise<Project[]> {
    const rows = await this.prisma.project.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' } });
    return rows.map(row => ({
      ...row,
      description: row.description ?? null,
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
        }
      });
      return {
        ...env,
        resourceId: env.resourceId ?? undefined
      };
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new DuplicateError(`Environment with slug "${input.slug}" already exists in this project.`);
      }
      throw error;
    }
  }

  async listEnvironments(projectId: string): Promise<Environment[]> {
    const rows = await this.prisma.environment.findMany({ where: { projectId }, orderBy: { name: 'asc' } });
    return rows.map(row => ({
      ...row,
      resourceId: row.resourceId ?? undefined
    }));
  }

  async findEnvironment(projectId: string, slug: string): Promise<Environment | null> {
    const row = await this.prisma.environment.findUnique({
      where: {
        projectId_slug: { projectId, slug }
      }
    });
    if (!row) return null;
    return {
      ...row,
      resourceId: row.resourceId ?? undefined
    };
  }
}
