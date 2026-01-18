
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createServices, Services } from '../domain/services.js';
import {
    ProjectRepository,
    ResourceRepository,
    GuardianRepository,
    ResourceFieldRepository,
    ApprovalRequestRepository,
    Repositories,
    AuthRepository, TOTPRepository,
} from '../domain/repositories.js';
import {
    Project, Environment, Resource, Guardian, ResourceField, ApprovalRequest,
    CreateProjectInput, CreateEnvironmentInput, CreateResourceInput, AddGuardianInput, CreateResourceFieldInput, CreateApprovalRequestInput
} from '../domain/models.js';
import { randomUUID } from 'crypto';

// --- In-Memory Repository Implementations ---

class MemProjectRepo implements ProjectRepository {
    projects: Project[] = [];
    environments: Environment[] = [];

    async createProject(input: CreateProjectInput): Promise<Project> {
        const p: Project = {
            id: randomUUID(),
            ...input,
            description: input.description || null,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        this.projects.push(p);
        return p;
    }
    async listProjectsByOwner(ownerId: string): Promise<Project[]> {
        return this.projects.filter(p => p.ownerId === ownerId);
    }
    async findById(id: string): Promise<Project | null> {
        return this.projects.find(p => p.id === id) || null;
    }
    async createEnvironment(input: CreateEnvironmentInput & { resourceId: string }): Promise<Environment> {
        const e: Environment = {
            id: randomUUID(),
            ...input,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        this.environments.push(e);
        return e;
    }
    async listEnvironments(projectId: string): Promise<Environment[]> {
        return this.environments.filter(e => e.projectId === projectId);
    }
    async findEnvironment(projectId: string, slug: string): Promise<Environment | null> {
        return this.environments.find(e => e.projectId === projectId && e.slug === slug) || null;
    }
}

class MemResourceRepo implements ResourceRepository {
    resources: Resource[] = [];

    async create(input: CreateResourceInput): Promise<Resource> {
        const r: Resource = { id: input.id, name: input.name, mode: input.mode, apiKey: input.apiKey, createdAt: new Date() };
        this.resources.push(r);
        return r;
    }
    async findById(id: string): Promise<Resource | null> {
        return this.resources.find(r => r.id === id) || null;
    }
    async update(id: string, data: Partial<Resource>): Promise<Resource> { throw new Error('Not implemented'); }
    async findByApiKey(apiKey: string): Promise<Resource | null> { throw new Error('Not implemented'); }
    async findManyByIds(ids: string[]): Promise<Resource[]> { return this.resources.filter(r => ids.includes(r.id)); }
}

class MemGuardianRepo implements GuardianRepository {
    guardians: Guardian[] = [];

    async add(input: AddGuardianInput): Promise<Guardian> {
        const g: Guardian = { ...input, createdAt: new Date() };
        this.guardians.push(g);
        return g;
    }
    async findByResourceId(resourceId: string): Promise<Guardian[]> {
        return this.guardians.filter(g => g.resourceId === resourceId);
    }
    async findByResourceAndUser(resourceId: string, userId: string): Promise<Guardian | null> {
        return this.guardians.find(g => g.resourceId === resourceId && g.discordUserId === userId) || null;
    }
    async remove(resourceId: string, userId: string): Promise<void> {
        this.guardians = this.guardians.filter(g => !(g.resourceId === resourceId && g.discordUserId === userId));
    }
    async findByUserId(discordUserId: string): Promise<Guardian[]> {
        return this.guardians.filter(g => g.discordUserId === discordUserId);
    }
}

class MemFieldRepo implements ResourceFieldRepository {
    fields: ResourceField[] = [];

    async create(input: CreateResourceFieldInput): Promise<ResourceField> {
        const f: ResourceField = {
            id: randomUUID(),
            ...input,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        this.fields.push(f);
        return f;
    }
    async findByResourceId(resourceId: string): Promise<ResourceField[]> {
        return this.fields.filter(f => f.resourceId === resourceId);
    }
    async findByResourceAndName(resourceId: string, name: string): Promise<ResourceField | null> {
        return this.fields.find(f => f.resourceId === resourceId && f.name === name) || null;
    }
    async update(id: string, value: string): Promise<ResourceField> {
        const f = this.fields.find(f => f.id === id);
        if (!f) throw new Error('Not found');
        f.value = value;
        return f;
    }
    async delete(id: string): Promise<void> {
        this.fields = this.fields.filter(f => f.id !== id);
    }
    async findById(id: string): Promise<ResourceField | null> {
        return this.fields.find(f => f.id === id) || null;
    }
}

class MemApprovalRepo implements ApprovalRequestRepository {
    requests: ApprovalRequest[] = [];

    async create(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
        const r: ApprovalRequest = {
            ...input,
            id: input.id || randomUUID(),
            createdAt: new Date(),
            status: 'PENDING',
            expiresAt: input.expiresAt || null
        };
        this.requests.push(r);
        return r;
    }
    async findById(id: string): Promise<ApprovalRequest | null> {
        return this.requests.find(r => r.id === id) || null;
    }
    async updateStatus(id: string, status: any, resolvedBy?: string): Promise<void> {
        const r = this.requests.find(r => r.id === id);
        if (!r) throw new Error('Not found');
        r.status = status;
        if (resolvedBy) {
            r.resolvedBy = resolvedBy;
            r.resolvedAt = new Date();
        }
    }
    async findActiveByRequester(resourceId: string, requesterId: string): Promise<ApprovalRequest | null> {
        // Simple logic: find PENDING or APPROVED req where context.requesterId == requesterId
        // Assuming context is simple object
        return this.requests.find(r =>
            r.resourceId === resourceId &&
            ['PENDING', 'APPROVED'].includes(r.status) &&
            (r.context as any)?.requesterId === requesterId
        ) || null;
    }
    async findByResourceId(resourceId: string): Promise<ApprovalRequest[]> {
        return this.requests.filter(r => r.resourceId === resourceId);
    }
    async findPendingByResourceId(resourceId: string): Promise<ApprovalRequest[]> {
        return this.requests.filter(r => r.resourceId === resourceId && r.status === 'PENDING');
    }
}

// --- Smoke Test ---

describe('Credential Sync Logic Smoke Test', () => {
    let services: Services;

    // Repos
    const projectRepo = new MemProjectRepo();
    const resourceRepo = new MemResourceRepo();
    const guardianRepo = new MemGuardianRepo();
    const fieldRepo = new MemFieldRepo();
    const approvalRepo = new MemApprovalRepo();

    // Mock unnecessary repos
    const authRepo = {} as AuthRepository;
    const totpRepo = {} as TOTPRepository;
    const auditRepo = { create: async () => ({}) as any, findByResourceId: async () => [] } as any;

    const repositories: Repositories = {
        projects: projectRepo,
        resources: resourceRepo,
        guardians: guardianRepo,
        resourceFields: fieldRepo,
        approvalRequests: approvalRepo,
        auth: authRepo,
        totp: totpRepo,
        audit: auditRepo
    };

    beforeEach(() => {
        // Reset state
        projectRepo.projects = []; projectRepo.environments = [];
        resourceRepo.resources = [];
        guardianRepo.guardians = [];
        fieldRepo.fields = [];
        approvalRepo.requests = [];

        services = createServices({ repositories });
    });

    it('should handle full credential sync flow: Project -> Env -> Secret -> Approval -> Access', async () => {
        const ownerId = 'owner-123';
        const guardianId = 'guardian-456';

        // 1. Create Project
        const project = await services.project.createProject({
            name: 'smoke-test-proj',
            ownerId,
            description: 'A test project'
        });
        assert.ok(project);
        assert.strictEqual(project.name, 'smoke-test-proj');

        // 2. Create Environment
        const env = await services.project.createEnvironment({
            name: 'Development',
            slug: 'dev',
            projectId: project.id
        });
        assert.ok(env);
        assert.ok(env.resourceId);

        // Verify Resource was created and Owner assigned
        const resource = await services.resource.getResource(env.resourceId!);
        assert.ok(resource);
        assert.strictEqual(resource.name, 'smoke-test-proj:Development'); // Check naming convention

        const ownerGuardian = await services.resource.isGuardian(resource.id, ownerId);
        assert.strictEqual(ownerGuardian, true, 'Project owner should be Resource owner');

        // 3. Upsert Secret (as Owner)
        await services.resource.upsertField(resource.id, 'API_KEY', 'secret-val-123');
        const fields = await services.resource.listFields(resource.id);
        assert.strictEqual(fields.length, 1);
        assert.strictEqual(fields[0].name, 'API_KEY');
        assert.strictEqual(fields[0].value, 'secret-val-123'); // value is technically encrypted in real repo, here plain

        // 4. Guardian Access Flow
        // 4a. Add Guardian
        await services.resource.addGuardian(resource.id, guardianId);
        const isGuardian = await services.resource.isGuardian(resource.id, guardianId);
        assert.strictEqual(isGuardian, true);

        // 4b. Guardian attempts to access (Simulate API Logic: call approval.findActiveApproval)
        let activeApproval = await services.approval.findActiveApproval(resource.id, guardianId);
        assert.strictEqual(activeApproval, null, 'Should be no active approval initially');

        // 4c. Create Request (Simulate API Logic)
        const requestResult = await services.approval.createApprovalRequest({
            resourceId: resource.id,
            context: { requesterId: guardianId, reason: 'Test Access' }
        });
        assert.strictEqual(requestResult.success, true);
        const reqId = requestResult.request!.id;

        // Verify Pending State
        activeApproval = await services.approval.findActiveApproval(resource.id, guardianId);
        assert.ok(activeApproval);
        assert.strictEqual(activeApproval.status, 'PENDING');

        // 4d. Owner Approves
        await services.approval.recordDecision(reqId, 'APPROVE', ownerId);

        // Verify Approved State
        activeApproval = await services.approval.findActiveApproval(resource.id, guardianId);
        assert.ok(activeApproval);
        assert.strictEqual(activeApproval.status, 'APPROVED');

        // 5. Cleanup / Remove Guardian
        await services.resource.removeGuardian(resource.id, ownerId, guardianId);
        const isGuardianAfter = await services.resource.isGuardian(resource.id, guardianId);
        assert.strictEqual(isGuardianAfter, false);
    });
});
