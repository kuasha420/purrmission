import type {
  Resource,
  Guardian,
  ApprovalRequest,
  CreateResourceInput,
  AddGuardianInput,
  CreateApprovalRequestInput,
  ApprovalStatus,
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
  ProjectMember,
  CreateProjectMemberInput,
  ProjectMemberRole,
  TOTPAccountMetadata,
  ResourceFieldMetadata,
  Credential,
  CreateCredentialInput,
  ApprovalGrant,
  CreateApprovalGrantInput,
  CallbackDestination,
  CreateCallbackDestinationInput,
} from './models.js';
import {
  ResourceRepository,
  GuardianRepository,
  ApprovalRequestRepository,
  TOTPRepository,
  ResourceFieldRepository,
  AuditRepository,
  AuthRepository,
  ProjectRepository,
  Repositories,
  CredentialRepository,
  ApprovalGrantRepository,
  CallbackDestinationRepository,
} from './repositories.js';
import crypto from 'node:crypto';

/**
 * In-memory implementation of ResourceRepository.
 * Useful for tests.
 */
export class InMemoryResourceRepository implements ResourceRepository {
  public resources: Map<string, Resource> = new Map();

  async create(input: CreateResourceInput): Promise<Resource> {
    const resource: Resource = {
      ...input,
      version: input.version || crypto.randomUUID(),
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
      if (resource.apiKey === apiKey) {
        return resource;
      }
    }
    return null;
  }

  async update(
    id: string,
    data: {
      totpAccountId?: string | null;
      totpDelegationEnvelope?: TOTPLinkEnvelope | null;
      version?: string;
    }
  ): Promise<Resource> {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new Error(`Resource not found: ${id}`);
    }
    const updated: Resource = {
      ...resource,
      totpAccountId:
        data.totpAccountId === null ? undefined : (data.totpAccountId ?? resource.totpAccountId),
      totpDelegationEnvelope:
        data.totpDelegationEnvelope === null
          ? undefined
          : (data.totpDelegationEnvelope ?? resource.totpDelegationEnvelope),
      version: data.version || crypto.randomUUID(),
    };
    this.resources.set(id, updated);
    return updated;
  }

  async findManyByIds(ids: string[], query?: string): Promise<Resource[]> {
    const normalizedQuery = query?.toLowerCase();
    const result: Resource[] = [];
    for (const id of ids) {
      const resource = this.resources.get(id);
      if (resource && (!normalizedQuery || resource.name.toLowerCase().includes(normalizedQuery))) {
        result.push(resource);
      }
    }
    return result;
  }

  rotateVersion(id: string): void {
    const resource = this.resources.get(id);
    if (resource) {
      resource.version = crypto.randomUUID();
    }
  }
}

/**
 * In-memory implementation of GuardianRepository.
 * Useful for tests.
 */
export class InMemoryGuardianRepository implements GuardianRepository {
  private guardians: Map<string, Guardian> = new Map();

  constructor(private resources?: InMemoryResourceRepository) {}

  async add(input: AddGuardianInput): Promise<Guardian> {
    const guardian: Guardian = {
      ...input,
      createdAt: new Date(),
    };
    this.guardians.set(guardian.id, guardian);
    this.resources?.rotateVersion(input.resourceId);
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

  async list(resourceId: string): Promise<Guardian[]> {
    return this.findByResourceId(resourceId);
  }

  async findByResourceAndUser(resourceId: string, discordUserId: string): Promise<Guardian | null> {
    for (const guardian of this.guardians.values()) {
      if (guardian.resourceId === resourceId && guardian.discordUserId === discordUserId) {
        return guardian;
      }
    }
    return null;
  }

  async findByUserId(discordUserId: string): Promise<Guardian[]> {
    return Array.from(this.guardians.values()).filter((g) => g.discordUserId === discordUserId);
  }

  async remove(resourceId: string, discordUserId: string): Promise<void> {
    for (const [id, guardian] of this.guardians.entries()) {
      if (guardian.resourceId === resourceId && guardian.discordUserId === discordUserId) {
        this.guardians.delete(id);
      }
    }
    this.resources?.rotateVersion(resourceId);
  }
}

/**
 * In-memory implementation of ApprovalRequestRepository.
 * Useful for tests.
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

  async findByResourceId(resourceId: string): Promise<ApprovalRequest[]> {
    return Array.from(this.requests.values()).filter((r) => r.resourceId === resourceId);
  }

  async findActiveByRequester(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalRequest | null> {
    const now = new Date();
    return (
      Array.from(this.requests.values()).find(
        (request) =>
          request.resourceId === resourceId &&
          request.requesterId === requesterId &&
          request.action === action &&
          request.targetKey === targetKey &&
          ['PENDING', 'APPROVED'].includes(request.status) &&
          request.expiresAt > now
      ) || null
    );
  }

  async findPending(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalRequest | null> {
    const now = new Date();
    return (
      Array.from(this.requests.values()).find(
        (request) =>
          request.resourceId === resourceId &&
          request.requesterId === requesterId &&
          request.action === action &&
          request.targetKey === targetKey &&
          request.status === 'PENDING' &&
          request.expiresAt > now
      ) || null
    );
  }

  async expireRequests(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.status === 'PENDING' && request.expiresAt < now) {
        request.status = 'EXPIRED';
        count++;
      }
    }
    return count;
  }
}

/**
 * In-memory implementation of TOTPRepository.
 * Useful for tests.
 */
export class InMemoryTOTPRepository implements TOTPRepository {
  private accounts: Map<string, TOTPAccount> = new Map();
  public linkConsents: Map<string, TOTPLinkConsent> = new Map();
  public delegationConsents: Map<string, TOTPDelegationConsent> = new Map();

  constructor(private resources?: InMemoryResourceRepository) {}

  async create(
    account: Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt' | 'version'>
  ): Promise<TOTPAccount> {
    const newAccount: TOTPAccount = {
      ...account,
      id: crypto.randomUUID(),
      backupKey: account.backupKey ?? undefined,
      version: crypto.randomUUID(),
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
      version: crypto.randomUUID(),
      updatedAt: new Date(),
    };
    this.accounts.set(updated.id, updated);
    if (this.resources) {
      for (const res of this.resources.resources.values()) {
        if (res.totpAccountId === account.id) {
          this.resources.rotateVersion(res.id);
        }
      }
    }
    return updated;
  }

  async deleteById(id: string): Promise<void> {
    this.accounts.delete(id);
    if (this.resources) {
      for (const res of this.resources.resources.values()) {
        if (res.totpAccountId === id) {
          res.totpAccountId = undefined;
          this.resources.rotateVersion(res.id);
        }
      }
    }
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

  async findMetadataByOwnerDiscordUserId(
    ownerDiscordUserId: string
  ): Promise<TOTPAccountMetadata[]> {
    return Array.from(this.accounts.values())
      .filter((a) => a.ownerDiscordUserId === ownerDiscordUserId)
      .map((a) => ({
        id: a.id,
        ownerDiscordUserId: a.ownerDiscordUserId,
        accountName: a.accountName,
        issuer: a.issuer,
        version: a.version,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }));
  }

  async createLinkConsent(
    input: Omit<TOTPLinkConsent, 'id' | 'createdAt' | 'usedAt'>
  ): Promise<TOTPLinkConsent> {
    const consent: TOTPLinkConsent = {
      ...input,
      id: crypto.randomUUID(),
      usedAt: null,
      createdAt: new Date(),
    };
    this.linkConsents.set(consent.id, consent);
    return consent;
  }

  async findLinkConsentById(id: string): Promise<TOTPLinkConsent | null> {
    return this.linkConsents.get(id) ?? null;
  }

  async useLinkConsent(id: string): Promise<void> {
    const found = this.linkConsents.get(id);
    if (found) {
      found.usedAt = new Date();
    }
  }

  async createDelegationConsent(
    input: Omit<TOTPDelegationConsent, 'id' | 'createdAt' | 'usedAt'>
  ): Promise<TOTPDelegationConsent> {
    const consent: TOTPDelegationConsent = {
      ...input,
      id: crypto.randomUUID(),
      usedAt: null,
      createdAt: new Date(),
    };
    this.delegationConsents.set(consent.id, consent);
    return consent;
  }

  async findDelegationConsentById(id: string): Promise<TOTPDelegationConsent | null> {
    return this.delegationConsents.get(id) ?? null;
  }

  async findActiveDelegationConsent(
    resourceId: string,
    requesterId: string,
    operation: string
  ): Promise<TOTPDelegationConsent | null> {
    const now = new Date();
    for (const consent of this.delegationConsents.values()) {
      if (
        consent.resourceId === resourceId &&
        consent.requesterId === requesterId &&
        consent.operation === operation &&
        consent.usedAt === null &&
        consent.expiresAt > now
      ) {
        return consent;
      }
    }
    return null;
  }

  async useDelegationConsent(id: string): Promise<void> {
    const found = this.delegationConsents.get(id);
    if (found) {
      found.usedAt = new Date();
    }
  }
}

/**
 * In-memory implementation of ResourceFieldRepository.
 * Useful for tests.
 */
export class InMemoryResourceFieldRepository implements ResourceFieldRepository {
  private fields: Map<string, ResourceField> = new Map();

  constructor(private resources?: InMemoryResourceRepository) {}

  async create(input: CreateResourceFieldInput): Promise<ResourceField> {
    const field: ResourceField = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.fields.set(field.id, field);
    this.resources?.rotateVersion(input.resourceId);
    return field;
  }

  async findById(id: string): Promise<ResourceField | null> {
    return this.fields.get(id) ?? null;
  }

  async findByResourceId(resourceId: string): Promise<ResourceField[]> {
    const result: ResourceField[] = [];
    for (const field of this.fields.values()) {
      if (field.resourceId === resourceId) {
        result.push(field);
      }
    }
    return result;
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
      throw new Error(`ResourceField not found: ${id}`);
    }
    const updated: ResourceField = {
      ...field,
      value,
      updatedAt: new Date(),
    };
    this.fields.set(id, updated);
    this.resources?.rotateVersion(field.resourceId);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const field = this.fields.get(id);
    if (field) {
      this.fields.delete(id);
      this.resources?.rotateVersion(field.resourceId);
    }
  }

  async findMetadataByResourceId(resourceId: string): Promise<ResourceFieldMetadata[]> {
    return Array.from(this.fields.values())
      .filter((f) => f.resourceId === resourceId)
      .map((f) => ({
        id: f.id,
        resourceId: f.resourceId,
        name: f.name,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      }));
  }

  async findMetadataByResourceAndName(
    resourceId: string,
    name: string
  ): Promise<ResourceFieldMetadata | null> {
    const field = Array.from(this.fields.values()).find(
      (f) => f.resourceId === resourceId && f.name === name
    );
    if (!field) return null;
    return {
      id: field.id,
      resourceId: field.resourceId,
      name: field.name,
      createdAt: field.createdAt,
      updatedAt: field.updatedAt,
    };
  }
}

/**
 * In-memory implementation of AuditRepository.
 * Useful for tests.
 */
export class InMemoryAuditRepository implements AuditRepository {
  private logs: AuditLog[] = [];

  async create(input: CreateAuditLogInput, _tx?: any): Promise<AuditLog> {
    const log: AuditLog = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: new Date(),
    };
    this.logs.push(log);
    return log;
  }

  async findByResourceId(resourceId: string): Promise<AuditLog[]> {
    return this.logs.filter((log) => log.resourceId === resourceId);
  }

  async findByProjectId(projectId: string): Promise<AuditLog[]> {
    return this.logs.filter((log) => log.projectId === projectId);
  }
}

/**
 * In-memory implementation of OutboxRepository.
 * Useful for tests.
 */
export class InMemoryOutboxRepository implements OutboxRepository {
  private events: OutboxEvent[] = [];

  async create(input: CreateOutboxEventInput, _tx?: any): Promise<OutboxEvent> {
    const event: OutboxEvent = {
      id: input.id || crypto.randomUUID(),
      eventType: input.eventType,
      payload: input.payload,
      status: 'PENDING',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async findPending(): Promise<OutboxEvent[]> {
    return this.events.filter((e) => e.status === 'PENDING');
  }

  async updateStatus(
    id: string,
    status: 'PENDING' | 'PROCESSED' | 'FAILED',
    attempts: number,
    lastError?: string,
    _tx?: any
  ): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (event) {
      event.status = status;
      event.attempts = attempts;
      event.lastError = lastError ?? null;
      event.updatedAt = new Date();
    }
  }
}

/**
 * In-memory implementation of AuthRepository.
 * Useful for tests.
 */
export class InMemoryAuthRepository implements AuthRepository {
  private sessions: Map<string, AuthSession> = new Map();
  private tokens: Map<string, ApiToken> = new Map();

  async createSession(input: {
    deviceCode: string;
    userCode: string;
    expiresAt: Date;
  }): Promise<AuthSession> {
    const session: AuthSession = {
      id: crypto.randomUUID(),
      deviceCode: input.deviceCode,
      userCode: input.userCode,
      status: 'PENDING',
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSessionByDeviceCode(deviceCode: string): Promise<AuthSession | null> {
    for (const session of this.sessions.values()) {
      if (session.deviceCode === deviceCode) {
        return session;
      }
    }
    return null;
  }

  async findSessionByUserCode(userCode: string): Promise<AuthSession | null> {
    for (const session of this.sessions.values()) {
      if (session.userCode === userCode) {
        return session;
      }
    }
    return null;
  }

  async updateSessionStatus(
    id: string,
    status: 'APPROVED' | 'DENIED' | 'EXPIRED',
    userId?: string
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
      if (status === 'APPROVED' && !userId) {
        throw new Error('userId is required for APPROVED status');
      }
      if (userId) {
        session.userId = userId;
      }
      session.updatedAt = new Date();
    }
  }

  async transitionSessionStatus(
    id: string,
    fromStatus: AuthSessionStatus,
    toStatus: AuthSessionStatus,
    userId?: string
  ): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.status !== fromStatus) {
      return false;
    }
    session.status = toStatus;
    if (userId !== undefined) {
      session.userId = userId;
    }
    session.updatedAt = new Date();
    return true;
  }

  async createApiToken(input: CreateApiTokenInput): Promise<ApiToken> {
    const token: ApiToken = {
      id: crypto.randomUUID(),
      token: input.token,
      userId: input.userId,
      name: input.name,
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      createdAt: new Date(),
    };
    this.tokens.set(token.id, token);
    return token;
  }

  async findApiToken(token: string): Promise<ApiToken | null> {
    for (const t of this.tokens.values()) {
      if (t.token === token) {
        return t;
      }
    }
    return null;
  }

  async updateApiTokenLastUsed(id: string): Promise<void> {
    const token = this.tokens.get(id);
    if (token) {
      token.lastUsedAt = new Date();
    }
  }

  async deleteExpiredSessions(): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const [id, session] of this.sessions.entries()) {
      if (
        session.status === 'EXPIRED' ||
        session.status === 'CONSUMED' ||
        session.expiresAt < now
      ) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }
}

export class InMemoryProjectRepository implements ProjectRepository {
  private projects: Map<string, Project> = new Map();
  private environments: Map<string, Environment> = new Map();
  private members: Map<string, ProjectMember> = new Map();

  async createProject(input: CreateProjectInput): Promise<Project> {
    const project: Project = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description ?? null,
      ownerId: input.ownerId,
      policyVersion: crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  async findById(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  async listProjectsByOwner(ownerId: string): Promise<Project[]> {
    return Array.from(this.projects.values()).filter((p) => p.ownerId === ownerId);
  }

  async getEnvironmentById(projectId: string, envId: string): Promise<Environment | null> {
    return (
      Array.from(this.environments.values()).find(
        (e) => e.projectId === projectId && e.id === envId
      ) || null
    );
  }

  async addMember(input: CreateProjectMemberInput): Promise<ProjectMember> {
    const member: ProjectMember = {
      id: 'mock-member-' + Date.now(),
      projectId: input.projectId,
      userId: input.userId,
      role: input.role || 'READER',
      addedBy: input.addedBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.members.set(`${input.projectId}::${input.userId}`, member);
    const p = this.projects.get(input.projectId);
    if (p) {
      p.policyVersion = crypto.randomUUID();
    }
    return member;
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    this.members.delete(`${projectId}::${userId}`);
    const p = this.projects.get(projectId);
    if (p) {
      p.policyVersion = crypto.randomUUID();
    }
  }

  async getMemberRole(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
    const member = this.members.get(`${projectId}::${userId}`);
    return member?.role ?? null;
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    return Array.from(this.members.values()).filter((m) => m.projectId === projectId);
  }

  async createEnvironment(
    input: CreateEnvironmentInput,
    _tx?: Prisma.TransactionClient
  ): Promise<Environment> {
    // Check uniqueness of slug within project for safety, though mock
    const existing = await this.findEnvironment(input.projectId, input.slug);
    if (existing) throw new Error('Slug already exists');

    const env: Environment = {
      id: crypto.randomUUID(),
      name: input.name,
      slug: input.slug,
      projectId: input.projectId,
      resourceId: input.resourceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.environments.set(env.id, env);
    return env;
  }

  async listEnvironments(projectId: string): Promise<Environment[]> {
    return Array.from(this.environments.values()).filter((e) => e.projectId === projectId);
  }

  async findEnvironment(projectId: string, slug: string): Promise<Environment | null> {
    for (const env of this.environments.values()) {
      if (env.projectId === projectId && env.slug === slug) {
        return env;
      }
    }
    return null;
  }

  async findEnvironmentByResourceId(resourceId: string): Promise<Environment | null> {
    for (const env of this.environments.values()) {
      if (env.resourceId === resourceId) {
        return env;
      }
    }
    return null;
  }

  async listMembershipsByUser(userId: string): Promise<ProjectMember[]> {
    return Array.from(this.members.values()).filter((m) => m.userId === userId);
  }
}

export class InMemoryCredentialRepository implements CredentialRepository {
  private credentials: Map<string, Credential> = new Map();

  async create(input: CreateCredentialInput): Promise<Credential> {
    const cred: Credential = {
      id: crypto.randomUUID(),
      type: input.type,
      subjectId: input.subjectId,
      name: input.name,
      digest: input.digest,
      prefix: input.prefix,
      scopes: input.scopes,
      audience: input.audience,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      revokedAt: input.revokedAt,
      lastUsedAt: null,
      version: crypto.randomUUID(),
    };
    this.credentials.set(cred.id, cred);
    return cred;
  }

  async findById(id: string): Promise<Credential | null> {
    return this.credentials.get(id) ?? null;
  }

  async findByDigest(digest: string): Promise<Credential | null> {
    for (const cred of this.credentials.values()) {
      if (cred.digest === digest) {
        return cred;
      }
    }
    return null;
  }

  async findBySubject(subjectId: string): Promise<Credential[]> {
    const result: Credential[] = [];
    for (const cred of this.credentials.values()) {
      if (cred.subjectId === subjectId) {
        result.push(cred);
      }
    }
    return result;
  }

  async revoke(id: string): Promise<void> {
    const cred = this.credentials.get(id);
    if (cred) {
      cred.revokedAt = new Date();
      cred.version = crypto.randomUUID();
    }
  }

  async updateLastUsed(id: string): Promise<void> {
    const cred = this.credentials.get(id);
    if (cred) {
      cred.lastUsedAt = new Date();
    }
  }
}

export class InMemoryApprovalGrantRepository implements ApprovalGrantRepository {
  private grants: Map<string, ApprovalGrant> = new Map();

  async create(
    input: CreateApprovalGrantInput,
    _tx?: Prisma.TransactionClient
  ): Promise<ApprovalGrant> {
    const grant: ApprovalGrant = {
      id: crypto.randomUUID(),
      requestId: input.requestId,
      resourceId: input.resourceId,
      requesterId: input.requesterId,
      requesterType: input.requesterType,
      authKind: input.authKind,
      action: input.action,
      targetKey: input.targetKey,
      targetVersion: input.targetVersion,
      policyVersion: input.policyVersion,
      constraints: input.constraints ?? null,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  async findById(id: string): Promise<ApprovalGrant | null> {
    return this.grants.get(id) ?? null;
  }

  async findByRequestId(requestId: string): Promise<ApprovalGrant | null> {
    for (const grant of this.grants.values()) {
      if (grant.requestId === requestId) {
        return grant;
      }
    }
    return null;
  }

  async findActiveUnconsumed(
    resourceId: string,
    requesterId: string,
    action: string,
    targetKey: string | null
  ): Promise<ApprovalGrant | null> {
    const now = new Date();
    for (const grant of this.grants.values()) {
      if (
        grant.resourceId === resourceId &&
        grant.requesterId === requesterId &&
        grant.action === action &&
        grant.targetKey === targetKey &&
        grant.consumedAt === null &&
        grant.revokedAt === null &&
        grant.expiresAt > now
      ) {
        return grant;
      }
    }
    return null;
  }

  async consume(id: string, _tx?: Prisma.TransactionClient): Promise<boolean> {
    const grant = this.grants.get(id);
    if (
      grant &&
      grant.consumedAt === null &&
      grant.revokedAt === null &&
      grant.expiresAt > new Date()
    ) {
      grant.consumedAt = new Date();
      return true;
    }
    return false;
  }

  async revoke(id: string, _tx?: Prisma.TransactionClient): Promise<void> {
    const grant = this.grants.get(id);
    if (grant) {
      grant.revokedAt = new Date();
    }
  }
}

export class InMemoryCallbackDestinationRepository implements CallbackDestinationRepository {
  private destinations: Map<string, CallbackDestination> = new Map();

  async create(
    input: CreateCallbackDestinationInput,
    _tx?: Prisma.TransactionClient
  ): Promise<CallbackDestination> {
    const dest: CallbackDestination = {
      id: crypto.randomUUID(),
      resourceId: input.resourceId,
      url: input.url,
      secret: input.secret,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.destinations.set(dest.id, dest);
    return dest;
  }

  async findById(id: string): Promise<CallbackDestination | null> {
    return this.destinations.get(id) ?? null;
  }

  async findByResourceId(resourceId: string): Promise<CallbackDestination[]> {
    const results: CallbackDestination[] = [];
    for (const dest of this.destinations.values()) {
      if (dest.resourceId === resourceId) {
        results.push(dest);
      }
    }
    return results;
  }

  async updateEnabled(id: string, enabled: boolean, _tx?: Prisma.TransactionClient): Promise<void> {
    const dest = this.destinations.get(id);
    if (dest) {
      dest.enabled = enabled;
      dest.updatedAt = new Date();
    }
  }

  async delete(id: string, _tx?: Prisma.TransactionClient): Promise<void> {
    this.destinations.delete(id);
  }
}

/**
 * Create in-memory repositories for tests.
 */
export function createInMemoryRepositories(): Repositories {
  const resources = new InMemoryResourceRepository();
  return {
    resources,
    guardians: new InMemoryGuardianRepository(resources),
    approvalRequests: new InMemoryApprovalRequestRepository(),
    totp: new InMemoryTOTPRepository(resources),
    resourceFields: new InMemoryResourceFieldRepository(resources),
    audit: new InMemoryAuditRepository(),
    auth: new InMemoryAuthRepository(),
    projects: new InMemoryProjectRepository(),
    outbox: new InMemoryOutboxRepository(),
    credentials: new InMemoryCredentialRepository(),
    approvalGrants: new InMemoryApprovalGrantRepository(),
    callbackDestinations: new InMemoryCallbackDestinationRepository(),
  };
}
