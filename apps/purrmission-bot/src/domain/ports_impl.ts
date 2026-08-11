import type {
  DomainPorts,
  CreateProjectDTO,
  AddMemberDTO,
  CreateEnvironmentDTO,
  BatchSetSecretsDTO,
  CallbackDestinationDTO,
} from './ports.js';
import { ForbiddenError, NotFoundError } from './ports.js';
import type {
  Principal,
  Project,
  Environment,
  ApprovalRequest,
  ApprovalGrant,
  AuthoritySource,
  ReasonCode,
} from './models.js';
import { ProjectService } from './project.js';
import { ResourceService, ApprovalService } from './services.js';
import { AuditService } from './audit.js';
import type { Repositories } from './repositories.js';

export class DomainPortsImpl implements DomainPorts {
  constructor(
    private readonly projectService: ProjectService,
    private readonly resourceService: ResourceService,
    private readonly approvalService: ApprovalService,
    private readonly audit: AuditService,
    private readonly repositories: Repositories
  ) {
    if (!audit) throw new TypeError('DomainPortsImpl requires an audit dependency.');
  }

  // Projects
  async createProject(principal: Principal, dto: CreateProjectDTO): Promise<Project> {
    if (principal.type === 'SERVICE') {
      throw new ForbiddenError('Service principals cannot create projects');
    }
    return this.projectService.createProject(
      {
        name: dto.name,
        ownerId: principal.subjectId,
      },
      principal
    );
  }

  async listProjects(principal: Principal): Promise<Project[]> {
    return this.projectService.listProjects(principal.subjectId);
  }

  async getProject(principal: Principal, projectId: string): Promise<Project | null> {
    const project = await this.projectService.getProject(projectId);
    if (!project) return null;

    // Check membership/owner
    const isOwner = project.ownerId === principal.subjectId;
    const role = await this.projectService.getMemberRole(projectId, principal.subjectId);
    if (!isOwner && !role) {
      throw new ForbiddenError('Not a member of the project');
    }
    return project;
  }

  async addProjectMember(principal: Principal, dto: AddMemberDTO): Promise<void> {
    const project = await this.getProject(principal, dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    if (project.ownerId !== principal.subjectId) {
      throw new ForbiddenError('Only the project owner can add members');
    }

    await this.projectService.addMember(dto.projectId, dto.memberUserId, dto.role, principal);
  }

  async removeProjectMember(
    principal: Principal,
    projectId: string,
    memberUserId: string
  ): Promise<void> {
    const project = await this.getProject(principal, projectId);
    if (!project) throw new NotFoundError('Project not found');

    if (project.ownerId !== principal.subjectId) {
      throw new ForbiddenError('Only the project owner can remove members');
    }

    await this.projectService.removeMember(projectId, memberUserId, principal);
  }

  async listProjectMembers(principal: Principal, projectId: string) {
    await this.getProject(principal, projectId);
    return this.projectService.listMembers(projectId);
  }

  // Environments
  async createEnvironment(principal: Principal, dto: CreateEnvironmentDTO): Promise<Environment> {
    const project = await this.getProject(principal, dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    if (project.ownerId !== principal.subjectId) {
      throw new ForbiddenError('Only the project owner can create environments');
    }

    return this.projectService.createEnvironment(
      {
        projectId: dto.projectId,
        name: dto.name,
        slug: dto.slug,
      },
      principal
    );
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
    _principal: Principal,
    _projectId: string,
    _envId: string,
    _grantId?: string
  ): Promise<Record<string, string>> {
    // A GET must be safe and idempotent. Secret-value redemption consumes an exact grant, so it
    // cannot be implemented by this read port. Keep the legacy boundary fail-closed until the
    // dedicated authenticated, grant-consuming POST use case is introduced (#122/#128).
    throw new ForbiddenError('Secret values require the grant-consuming redemption endpoint');
  }

  async setSecrets(principal: Principal, dto: BatchSetSecretsDTO): Promise<void> {
    const project = await this.getProject(principal, dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    const env = await this.projectService.getEnvironmentById(dto.projectId, dto.envId);
    if (!env || !env.resourceId) throw new NotFoundError('Environment not found');

    // Write access check: Owner/Writer
    let authorized = project.ownerId === principal.subjectId;
    if (!authorized) {
      const role = await this.projectService.getMemberRole(dto.projectId, principal.subjectId);
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
    const resource = await this.repositories.resources.findById(resourceId);
    if (!resource) throw new NotFoundError('Resource not found');

    const env = await this.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    const project = await this.projectService.getProject(env.projectId);
    if (!project || project.ownerId !== principal.subjectId) {
      throw new ForbiddenError('Only the project owner can register callbacks');
    }

    const created = await this.repositories.transaction(async (tx) => {
      const destination = await this.repositories.callbackDestinations.create(
        { resourceId, url, secret },
        tx
      );
      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'CALLBACK_REGISTER',
          surface: 'DOMAIN',
          operation: 'callback.register',
          outcomeCode: 'SUCCESS',
          capability: 'resource.policy.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: ['PROJECT_OWNER'],
          targetType: 'RESOURCE',
          targetId: resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          projectId: env.projectId,
          resourceId,
          payload: {},
        },
        tx
      );
      return destination;
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
    const env = await this.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    await this.getProject(principal, env.projectId);

    const dests = await this.repositories.callbackDestinations.findByResourceId(resourceId);
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
    const env = await this.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    const project = await this.projectService.getProject(env.projectId);
    if (!project || project.ownerId !== principal.subjectId) {
      throw new ForbiddenError('Only the project owner can delete callbacks');
    }

    const callback = await this.repositories.callbackDestinations.findById(callbackId);
    if (!callback) {
      throw new NotFoundError('Callback destination not found');
    }
    if (callback.resourceId !== resourceId) {
      throw new ForbiddenError('Callback destination does not belong to the requested resource');
    }

    const remove = async (tx?: import('@prisma/client').Prisma.TransactionClient) => {
      await this.repositories.callbackDestinations.delete(callbackId, tx);
      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'CALLBACK_DELETE',
          surface: 'DOMAIN',
          operation: 'callback.delete',
          outcomeCode: 'SUCCESS',
          capability: 'resource.policy.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: ['PROJECT_OWNER'],
          targetType: 'RESOURCE',
          targetId: resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          projectId: env.projectId,
          resourceId,
          payload: {},
        },
        tx
      );
    };
    await this.repositories.transaction(remove);
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
      principal,
      requesterId: principal.subjectId,
      requesterType: principal.type === 'SERVICE' ? 'SERVICE_PRINCIPAL' : 'DISCORD_USER',
      authKind: principal.authKind,
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

    return this.approvalService.recordDecision(requestId, decision, principal);
  }

  async getApprovalRequest(
    principal: Principal,
    requestId: string
  ): Promise<ApprovalRequest | null> {
    const request = await this.approvalService.getApprovalRequest(requestId);
    if (!request) return null;

    const env = await this.repositories.projects.findEnvironmentByResourceId(request.resourceId);
    if (!env) return null;

    const project = await this.projectService.getProject(env.projectId);
    if (!project) return null;

    const isMember =
      project.ownerId === principal.subjectId ||
      (await this.projectService.getMemberRole(env.projectId, principal.subjectId)) !== null;
    const isRequester = request.requesterId === principal.subjectId;
    const guardians = await this.repositories.guardians.findByResourceId(request.resourceId);
    const isGuardian = guardians.some((g) => g.discordUserId === principal.subjectId);

    if (!isMember && !isRequester && !isGuardian) {
      throw new ForbiddenError('Permission denied');
    }

    return request;
  }

  async getApprovalGrantByRequestId(
    principal: Principal,
    requestId: string
  ): Promise<ApprovalGrant | null> {
    const request = await this.getApprovalRequest(principal, requestId);
    if (!request) return null;

    return this.repositories.approvalGrants.findByRequestId(requestId);
  }
}
