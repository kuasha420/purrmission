
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
    ApiToken,
    CreateApiTokenInput,
    Project,
    Environment,
    CreateProjectInput,
    CreateEnvironmentInput,
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
} from './repositories.js';
import crypto from 'node:crypto';

export const mockRepositories = {
    approvalRequests: {
        create: jest.fn(),
        findById: jest.fn(),
        findByResourceId: jest.fn(),
        updateStatus: jest.fn(),
        findActiveByRequester: jest.fn(),
    },
};

/**
 * In-memory implementation of ResourceRepository.
 * Useful for tests.
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
            totpAccountId: data.totpAccountId === null ? undefined : (data.totpAccountId ?? resource.totpAccountId),
        };
        this.resources.set(id, updated);
        return updated;
    }

    async findManyByIds(ids: string[]): Promise<Resource[]> {
        const result: Resource[] = [];
        for (const id of ids) {
            const resource = this.resources.get(id);
            if (resource) {
                result.push(resource);
            }
        }
        return result;
    }
}

/**
 * In-memory implementation of GuardianRepository.
 * Useful for tests.
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

    async findByUserId(discordUserId: string): Promise<Guardian[]> {
        return Array.from(this.guardians.values()).filter(
            (guardian) => guardian.discordUserId === discordUserId
        );
    }

    async remove(resourceId: string, discordUserId: string): Promise<void> {
        for (const [id, guardian] of this.guardians.entries()) {
            if (guardian.resourceId === resourceId && guardian.discordUserId === discordUserId) {
                this.guardians.delete(id);
            }
        }
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
}

/**
 * In-memory implementation of TOTPRepository.
 * Useful for tests.
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
        const results: TOTPAccount[] = [];
        for (const account of this.accounts.values()) {
            if (account.shared) {
                results.push(account);
            }
        }
        return results;
    }
}

/**
 * In-memory implementation of ResourceFieldRepository.
 * Useful for tests.
 */
export class InMemoryResourceFieldRepository implements ResourceFieldRepository {
    private fields: Map<string, ResourceField> = new Map();

    async create(input: CreateResourceFieldInput): Promise<ResourceField> {
        const field: ResourceField = {
            ...input,
            id: crypto.randomUUID(),
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
        return updated;
    }

    async delete(id: string): Promise<void> {
        this.fields.delete(id);
    }
}

/**
 * In-memory implementation of AuditRepository.
 * Useful for tests.
 */
export class InMemoryAuditRepository implements AuditRepository {
    private logs: AuditLog[] = [];

    async create(input: CreateAuditLogInput): Promise<AuditLog> {
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
}

/**
 * In-memory implementation of AuthRepository.
 * Useful for tests.
 */
export class InMemoryAuthRepository implements AuthRepository {
    private sessions: Map<string, AuthSession> = new Map();
    private tokens: Map<string, ApiToken> = new Map();

    async createSession(input: { deviceCode: string; userCode: string; expiresAt: Date }): Promise<AuthSession> {
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

    async updateSessionStatus(id: string, status: 'APPROVED' | 'DENIED' | 'EXPIRED', userId?: string): Promise<void> {
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

    async createProject(input: CreateProjectInput): Promise<Project> {
        const project: Project = {
            id: crypto.randomUUID(),
            name: input.name,
            description: input.description ?? null,
            ownerId: input.ownerId,
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
        return Array.from(this.projects.values()).filter(p => p.ownerId === ownerId);
    }

    async createEnvironment(input: CreateEnvironmentInput): Promise<Environment> {
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
        return Array.from(this.environments.values()).filter(e => e.projectId === projectId);
    }

    async findEnvironment(projectId: string, slug: string): Promise<Environment | null> {
        for (const env of this.environments.values()) {
            if (env.projectId === projectId && env.slug === slug) {
                return env;
            }
        }
        return null;
    }
}

/**
 * Create in-memory repositories for tests.
 */
export function createInMemoryRepositories(): Repositories {
    return {
        resources: new InMemoryResourceRepository(),
        guardians: new InMemoryGuardianRepository(),
        approvalRequests: new InMemoryApprovalRequestRepository(),
        totp: new InMemoryTOTPRepository(),
        resourceFields: new InMemoryResourceFieldRepository(),
        audit: new InMemoryAuditRepository(),
        auth: new InMemoryAuthRepository(),
        projects: new InMemoryProjectRepository(),
    };
}
