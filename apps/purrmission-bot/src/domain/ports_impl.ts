import type {
  DomainPorts,
  CreateProjectDTO,
  AddMemberDTO,
  CreateEnvironmentDTO,
  BatchSetSecretsDTO,
  CallbackDestinationDTO,
} from './ports.js';
import { ForbiddenError, NotFoundError } from './ports.js';
import type { Principal, Project, Environment, ApprovalRequest } from './models.js';
import { ProjectService } from './project.js';
import { ResourceService, ApprovalService } from './services.js';

export class DomainPortsImpl implements DomainPorts {
  constructor(
    private readonly projectService: ProjectService,
    private readonly resourceService: ResourceService,
    private readonly approvalService: ApprovalService
  ) {}

  // Projects
  async createProject(principal: Principal, dto: CreateProjectDTO): Promise<Project> {
    if (principal.type === 'SERVICE') {
      throw new ForbiddenError('Service principals cannot create projects');
    }
    return this.projectService.createProject({
      name: dto.name,
      ownerId: principal.id,
    });
  }

  async listProjects(principal: Principal): Promise<Project[]> {
    return this.projectService.listProjects(principal.id);
  }

  async getProject(principal: Principal, projectId: string): Promise<Project | null> {
    const project = await this.projectService.getProject(projectId);
    if (!project) return null;

    // Check membership/owner
    const isOwner = project.ownerId === principal.id;
    const role = await this.projectService.getMemberRole(projectId, principal.id);
    if (!isOwner && !role) {
      throw new ForbiddenError('Not a member of the project');
    }
    return project;
  }

  async addProjectMember(principal: Principal, dto: AddMemberDTO): Promise<void> {
    const project = await this.getProject(principal, dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    if (project.ownerId !== principal.id) {
      throw new ForbiddenError('Only the project owner can add members');
    }

    await this.projectService.addMember(dto.projectId, dto.memberUserId, dto.role, principal.id);
  }

  async removeProjectMember(
    principal: Principal,
    projectId: string,
    memberUserId: string
  ): Promise<void> {
    const project = await this.getProject(principal, projectId);
    if (!project) throw new NotFoundError('Project not found');

    if (project.ownerId !== principal.id) {
      throw new ForbiddenError('Only the project owner can remove members');
    }

    await this.projectService.removeMember(projectId, memberUserId);
  }

  async listProjectMembers(principal: Principal, projectId: string): Promise<any[]> {
    await this.getProject(principal, projectId);
    return this.projectService.listMembers(projectId);
  }

  // Environments
  async createEnvironment(principal: Principal, dto: CreateEnvironmentDTO): Promise<Environment> {
    const project = await this.getProject(principal, dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    if (project.ownerId !== principal.id) {
      throw new ForbiddenError('Only the project owner can create environments');
    }

    return this.projectService.createEnvironment({
      projectId: dto.projectId,
      name: dto.name,
      slug: dto.slug,
    });
  }

  async listEnvironments(principal: Principal, projectId: string): Promise<Environment[]> {
    await this.getProject(principal, projectId);
    return this.projectService.listEnvironments(projectId);
  }

  async getEnvironment(
    principal: Principal,
    projectId: string,
    envSlug: string
  ): Promise<Environment | null> {
    await this.getProject(principal, projectId);
    return this.projectService.getEnvironment(projectId, envSlug);
  }

  // Secrets & Reveal Operations
  async getSecrets(
    principal: Principal,
    projectId: string,
    envId: string,
    grantId?: string
  ): Promise<Record<string, string>> {
    const project = await this.getProject(principal, projectId);
    if (!project) throw new NotFoundError('Project not found');

    const env = await this.projectService.getEnvironmentById(projectId, envId);
    if (!env || !env.resourceId) throw new NotFoundError('Environment not found');

    // Access check: Owner/Writer can view directly.
    let authorized = project.ownerId === principal.id;
    if (!authorized) {
      const role = await this.projectService.getMemberRole(projectId, principal.id);
      authorized = role === 'WRITER' || role === 'READER';
    }

    if (!authorized && grantId) {
      // Validate and consume the approval grant
      const consumed = await this.approvalService.consumeGrant(
        grantId,
        principal,
        'secrets.read',
        env.resourceId
      );
      if (consumed) {
        authorized = true;
      }
    }

    if (!authorized) {
      throw new ForbiddenError('Secrets read access denied');
    }

    // Load and return secrets
    const fields = await this.resourceService.deps.repositories.resourceFields.findByResourceId(
      env.resourceId
    );
    const result: Record<string, string> = {};
    for (const f of fields) {
      result[f.name] = f.value;
    }
    return result;
  }

  async setSecrets(principal: Principal, dto: BatchSetSecretsDTO): Promise<void> {
    const project = await this.getProject(principal, dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    const env = await this.projectService.getEnvironmentById(dto.projectId, dto.envId);
    if (!env || !env.resourceId) throw new NotFoundError('Environment not found');

    // Write access check: Owner/Writer
    let authorized = project.ownerId === principal.id;
    if (!authorized) {
      const role = await this.projectService.getMemberRole(dto.projectId, principal.id);
      authorized = role === 'WRITER';
    }

    if (!authorized) {
      throw new ForbiddenError('Write permission required');
    }

    await this.resourceService.setSecrets(env.resourceId, dto.secrets, principal);
  }

  async revealTOTP(
    principal: Principal,
    resourceId: string,
    grantId?: string,
    consentId?: string
  ): Promise<string> {
    return this.resourceService.revealTOTPCode(resourceId, principal, grantId, consentId);
  }

  // Webhooks
  async registerCallback(
    principal: Principal,
    resourceId: string,
    url: string,
    secret: string
  ): Promise<CallbackDestinationDTO> {
    const resource = await this.resourceService.deps.repositories.resources.findById(resourceId);
    if (!resource) throw new NotFoundError('Resource not found');

    const env =
      await this.resourceService.deps.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    const project = await this.projectService.getProject(env.projectId);
    if (!project || project.ownerId !== principal.id) {
      throw new ForbiddenError('Only the project owner can register callbacks');
    }

    const created = await this.resourceService.deps.repositories.callbackDestinations.create({
      resourceId,
      url,
      secret,
    });

    return {
      id: created.id,
      resourceId: created.resourceId,
      url: created.url,
      enabled: created.enabled,
      createdAt: created.createdAt,
    };
  }

  async listCallbacks(principal: Principal, resourceId: string): Promise<CallbackDestinationDTO[]> {
    const env =
      await this.resourceService.deps.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    await this.getProject(principal, env.projectId);

    const dests =
      await this.resourceService.deps.repositories.callbackDestinations.findByResourceId(
        resourceId
      );
    return dests.map((d) => ({
      id: d.id,
      resourceId: d.resourceId,
      url: d.url,
      enabled: d.enabled,
      createdAt: d.createdAt,
    }));
  }

  async deleteCallback(
    principal: Principal,
    resourceId: string,
    callbackId: string
  ): Promise<void> {
    const env =
      await this.resourceService.deps.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    const project = await this.projectService.getProject(env.projectId);
    if (!project || project.ownerId !== principal.id) {
      throw new ForbiddenError('Only the project owner can delete callbacks');
    }

    const callback =
      await this.resourceService.deps.repositories.callbackDestinations.findById(callbackId);
    if (!callback) {
      throw new NotFoundError('Callback destination not found');
    }
    if (callback.resourceId !== resourceId) {
      throw new ForbiddenError('Callback destination does not belong to the requested resource');
    }

    await this.resourceService.deps.repositories.callbackDestinations.delete(callbackId);
  }

  // Approvals & Grants
  async createApprovalRequest(
    principal: Principal,
    resourceId: string,
    action: string,
    targetKey?: string | null
  ): Promise<{ success: boolean; request?: ApprovalRequest }> {
    return this.approvalService.createApprovalRequest({
      resourceId,
      requesterId: principal.id,
      requesterType: principal.type === 'SERVICE' ? 'SERVICE_PRINCIPAL' : 'DISCORD_USER',
      authKind: principal.authKind as any,
      action,
      targetKey: targetKey ?? null,
    });
  }

  async recordApprovalDecision(
    principal: Principal,
    requestId: string,
    decision: 'APPROVE' | 'DENY'
  ): Promise<{ success: boolean }> {
    if (principal.type === 'SERVICE') {
      throw new ForbiddenError('Service principals cannot resolve approval requests');
    }

    return this.approvalService.recordDecision(requestId, decision, principal.id);
  }

  async getApprovalRequest(
    principal: Principal,
    requestId: string
  ): Promise<ApprovalRequest | null> {
    const request = await this.approvalService.getApprovalRequest(requestId);
    if (!request) return null;

    const env = await this.resourceService.deps.repositories.projects.findEnvironmentByResourceId(
      request.resourceId
    );
    if (!env) return null;

    const project = await this.projectService.getProject(env.projectId);
    if (!project) return null;

    const isMember =
      project.ownerId === principal.id ||
      (await this.projectService.getMemberRole(env.projectId, principal.id)) !== null;
    const isRequester = request.requesterId === principal.id;
    const guardians = await this.resourceService.deps.repositories.guardians.findByResourceId(
      request.resourceId
    );
    const isGuardian = guardians.some((g) => g.discordUserId === principal.id);

    if (!isMember && !isRequester && !isGuardian) {
      throw new ForbiddenError('Permission denied');
    }

    return request;
  }
}
