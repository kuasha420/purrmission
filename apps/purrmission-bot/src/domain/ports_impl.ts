import crypto from 'node:crypto';
import type {
  DomainPorts,
  CreateProjectDTO,
  AddMemberDTO,
  CreateEnvironmentDTO,
  BatchSetSecretsDTO,
  CallbackDestinationDTO,
} from './ports.js';
import { ForbiddenError, NotFoundError, ConflictError } from './ports.js';
import type {
  Principal,
  Project,
  Environment,
  ApprovalRequest,
  ApprovalGrant,
  ProjectMember,
} from './models.js';
import type { Repositories } from './repositories.js';
import type { Prisma } from '@prisma/client';
import { validatePrincipal } from './principal.js';
import { hasCapability } from './policy.js';
import { ProjectService } from './project.js';
import { ResourceService, ApprovalService } from './services.js';
import { AuditService, sanitizeUrlForAudit } from './audit.js';
import { AccessDeniedError } from './auth.js';
import { resolveTargetVersions } from './target_versions.js';
import { encryptValue } from '../infra/crypto.js';

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

  private ensureValidPrincipal(principal: Principal): void {
    const res = validatePrincipal(principal);
    if (!res.valid) {
      throw new ForbiddenError(res.safeExplanation ?? 'Invalid principal authentication');
    }
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  async createProject(
    principal: Principal,
    dto: CreateProjectDTO,
    correlationId?: string
  ): Promise<Project> {
    this.ensureValidPrincipal(principal);
    const auth = await hasCapability(this.repositories, principal, 'project.create');
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'project.create',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'PROJECT',
        targetId: 'new',
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }
    return this.projectService.createProject(
      {
        name: dto.name,
        ownerId: principal.subjectId,
      },
      principal
    );
  }

  async listProjects(principal: Principal, _correlationId?: string): Promise<Project[]> {
    this.ensureValidPrincipal(principal);
    if (principal.type === 'SERVICE') {
      return [];
    }
    return this.projectService.listProjects(principal.subjectId);
  }

  async getProject(
    principal: Principal,
    projectId: string,
    correlationId?: string
  ): Promise<Project | null> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(projectId);
    if (!project) return null;

    const auth = await hasCapability(this.repositories, principal, 'project.view', { projectId });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'project.view',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'PROJECT',
        targetId: projectId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }
    return project;
  }

  async addProjectMember(
    principal: Principal,
    dto: AddMemberDTO,
    correlationId?: string
  ): Promise<void> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    const auth = await hasCapability(this.repositories, principal, 'project.members.manage', {
      projectId: dto.projectId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'project.member.add',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'PROJECT',
        targetId: dto.projectId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId: dto.projectId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }

    await this.projectService.addMember(dto.projectId, dto.memberUserId, dto.role, principal);
  }

  async removeProjectMember(
    principal: Principal,
    projectId: string,
    memberUserId: string,
    correlationId?: string
  ): Promise<void> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundError('Project not found');

    const auth = await hasCapability(this.repositories, principal, 'project.members.manage', {
      projectId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'project.member.remove',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'PROJECT',
        targetId: projectId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }

    await this.projectService.removeMember(projectId, memberUserId, principal);
  }

  async listProjectMembers(
    principal: Principal,
    projectId: string,
    correlationId?: string
  ): Promise<ProjectMember[]> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundError('Project not found');

    const auth = await hasCapability(this.repositories, principal, 'project.members.view', {
      projectId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'project.members.view',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'PROJECT',
        targetId: projectId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }

    return this.projectService.listMembers(projectId);
  }

  // ---------------------------------------------------------------------------
  // Environments
  // ---------------------------------------------------------------------------
  async createEnvironment(
    principal: Principal,
    dto: CreateEnvironmentDTO,
    correlationId?: string
  ): Promise<Environment> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    const auth = await hasCapability(this.repositories, principal, 'environment.create', {
      projectId: dto.projectId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'environment.create',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'PROJECT',
        targetId: dto.projectId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId: dto.projectId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
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

  async listEnvironments(
    principal: Principal,
    projectId: string,
    correlationId?: string
  ): Promise<Environment[]> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundError('Project not found');

    const auth = await hasCapability(this.repositories, principal, 'environment.view', {
      projectId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'environment.view',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'PROJECT',
        targetId: projectId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }

    return this.projectService.listEnvironments(projectId);
  }

  async getEnvironment(
    principal: Principal,
    projectId: string,
    envSlug: string,
    correlationId?: string
  ): Promise<Environment | null> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(projectId);
    if (!project) return null;

    const auth = await hasCapability(this.repositories, principal, 'environment.view', {
      projectId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'environment.view',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'PROJECT',
        targetId: projectId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }

    return this.projectService.getEnvironment(projectId, envSlug);
  }

  // ---------------------------------------------------------------------------
  // Secrets & Reveal Operations
  // ---------------------------------------------------------------------------
  async getSecrets(
    principal: Principal,
    _projectId: string,
    _envId: string,
    _grantId?: string
  ): Promise<Record<string, string>> {
    this.ensureValidPrincipal(principal);
    // A GET must be safe and idempotent. Secret-value redemption consumes an exact grant, so it
    // cannot be implemented by this read port. Keep the legacy boundary fail-closed until the
    // dedicated authenticated, grant-consuming POST use case is introduced (#122/#128).
    throw new ForbiddenError('Secret values require the grant-consuming redemption endpoint');
  }

  async revealSecrets(
    principal: Principal,
    projectId: string,
    envId: string,
    options?: { keys?: readonly string[]; grantId?: string },
    correlationId?: string
  ): Promise<Record<string, string>> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundError('Project not found');

    const env = await this.projectService.getEnvironmentById(projectId, envId);
    if (!env || !env.resourceId) throw new NotFoundError('Environment not found');

    const resourceId = env.resourceId;

    if (options?.grantId) {
      // Delegated access via grant
      const versions = await resolveTargetVersions(
        this.repositories,
        resourceId,
        'secret.value.read',
        null,
        options.keys
      );
      if (!versions) {
        throw new ForbiddenError('Failed to resolve target versions for grant consumption');
      }

      const authFamily =
        principal.type === 'PAWTHY_TOKEN'
          ? 'PAWTHY_CLI'
          : principal.type === 'RESOURCE_API_KEY'
            ? 'RESOURCE_KEY'
            : principal.type === 'SERVICE'
              ? 'SERVICE'
              : 'DISCORD';
      const audience = principal.audience || 'purrmission-bot';

      try {
        await this.approvalService.consumeGrant(
          options.grantId,
          principal,
          'secret.value.read',
          versions.targetVersion,
          versions.policyVersion,
          {
            requiredAuthFamily: authFamily,
            requiredAudience: audience,
            canonicalKeyDigest: versions.canonicalKeyDigest,
          }
        );
      } catch (err) {
        if (err instanceof AccessDeniedError || err instanceof ConflictError) {
          throw new ForbiddenError(err.message);
        }
        throw err;
      }
    } else {
      // Direct capability evaluation
      const auth = await hasCapability(this.repositories, principal, 'secret.value.read', {
        projectId,
        resourceId,
      });
      if (!auth.allowed) {
        await this.audit.log({
          eventFamily: 'AUTHORIZATION',
          eventType: 'AUTHORIZATION_DECISION',
          surface: 'DOMAIN',
          operation: 'secret.value.read',
          outcomeCode: 'DENIED',
          decisionCode: auth.decisionCode,
          reasonCode: auth.reasonCode,
          authoritySources: auth.authoritySources,
          targetType: 'RESOURCE',
          targetId: resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          projectId,
          resourceId,
          correlationId,
          payload: { reason: auth.safeExplanation },
        });
        throw new ForbiddenError(auth.safeExplanation);
      }
    }

    // Exact key selection before decryption
    const result: Record<string, string> = {};
    if (options?.keys && options.keys.length > 0) {
      for (const key of options.keys) {
        const field = await this.resourceService.revealField(resourceId, key, principal);
        if (field) {
          result[key] = field.value;
        }
      }
    } else {
      const fieldMetas =
        await this.repositories.resourceFields.findMetadataByResourceId(resourceId);
      for (const meta of fieldMetas) {
        const field = await this.resourceService.revealField(resourceId, meta.name, principal);
        if (field) {
          result[meta.name] = field.value;
        }
      }
    }

    await this.audit.log({
      eventFamily: 'AUTHORIZATION',
      eventType: 'AUTHORIZATION_DECISION',
      surface: 'DOMAIN',
      operation: 'secret.value.read',
      outcomeCode: 'SUCCESS',
      capability: 'secret.value.read',
      decisionCode: 'ALLOW',
      reasonCode: options?.grantId ? 'GRANT' : 'AUTHENTICATED_SUBJECT',
      authoritySources: options?.grantId ? ['APPROVAL_GRANT'] : ['AUTHENTICATED_SUBJECT'],
      targetType: 'RESOURCE',
      targetId: resourceId,
      actorType: principal.type,
      principalId: principal.id,
      actorId: principal.subjectId,
      authKind: principal.authKind,
      projectId,
      resourceId,
      correlationId,
    });

    return result;
  }

  async setSecrets(
    principal: Principal,
    dto: BatchSetSecretsDTO,
    correlationId?: string
  ): Promise<void> {
    this.ensureValidPrincipal(principal);
    const project = await this.projectService.getProject(dto.projectId);
    if (!project) throw new NotFoundError('Project not found');

    const env = await this.projectService.getEnvironmentById(dto.projectId, dto.envId);
    if (!env || !env.resourceId) throw new NotFoundError('Environment not found');

    const auth = await hasCapability(this.repositories, principal, 'secret.write', {
      projectId: dto.projectId,
      resourceId: env.resourceId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'secret.write',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: env.resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId: dto.projectId,
        resourceId: env.resourceId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }

    await this.resourceService.setSecrets(env.resourceId, dto.secrets, principal);
  }

  async revealTOTP(
    principal: Principal,
    resourceId: string,
    grantId?: string,
    consentId?: string
  ): Promise<string> {
    this.ensureValidPrincipal(principal);
    return this.resourceService.revealTOTPCode(resourceId, principal, grantId, consentId);
  }

  // ---------------------------------------------------------------------------
  // Webhooks & Callbacks
  // ---------------------------------------------------------------------------
  async registerCallback(
    principal: Principal,
    resourceId: string,
    url: string,
    secret: string,
    correlationId?: string
  ): Promise<CallbackDestinationDTO> {
    this.ensureValidPrincipal(principal);
    const resource = await this.repositories.resources.findById(resourceId);
    if (!resource) throw new NotFoundError('Resource not found');

    const env = await this.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    const auth = await hasCapability(this.repositories, principal, 'callback.destination.manage', {
      projectId: env.projectId,
      resourceId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'callback.register',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId: env.projectId,
        resourceId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }

    const created = await this.repositories.transaction(async (tx: Prisma.TransactionClient) => {
      const verificationToken = crypto.randomUUID();
      const challengeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const destination = await this.repositories.callbackDestinations.create(
        {
          resourceId,
          projectId: env.projectId,
          url,
          keyId: 'default',
          encryptedSecret: encryptValue(secret),
          status: 'PENDING_VERIFICATION',
          verificationToken,
          verificationChallengeExpiresAt: challengeExpiresAt,
        },
        tx
      );
      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'CALLBACK_REGISTER',
          surface: 'DOMAIN',
          operation: 'callback.register',
          outcomeCode: 'SUCCESS',
          capability: 'callback.destination.manage',
          decisionCode: 'ALLOW',
          reasonCode: auth.reasonCode,
          authoritySources: auth.authoritySources,
          targetType: 'RESOURCE',
          targetId: resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          projectId: env.projectId,
          resourceId,
          correlationId,
          payload: {
            destinationId: destination.id,
            url: sanitizeUrlForAudit(destination.url),
            status: destination.status,
          },
        },
        tx
      );
      return destination;
    });

    return {
      id: created.id,
      resourceId: created.resourceId,
      url: created.url,
      enabled: created.status === 'ACTIVE',
      createdAt: created.createdAt,
    };
  }

  async listCallbacks(
    principal: Principal,
    resourceId: string,
    correlationId?: string
  ): Promise<CallbackDestinationDTO[]> {
    this.ensureValidPrincipal(principal);
    const env = await this.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    const auth = await hasCapability(this.repositories, principal, 'callback.destination.view', {
      projectId: env.projectId,
      resourceId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'callback.view',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId: env.projectId,
        resourceId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
    }

    const dests = await this.repositories.callbackDestinations.findByResourceId(resourceId);
    return dests.map(
      (d: { id: string; resourceId: string; url: string; status: string; createdAt: Date }) => ({
        id: d.id,
        resourceId: d.resourceId,
        url: d.url,
        enabled: d.status === 'ACTIVE',
        createdAt: d.createdAt,
      })
    );
  }

  async deleteCallback(
    principal: Principal,
    resourceId: string,
    callbackId: string,
    correlationId?: string
  ): Promise<void> {
    this.ensureValidPrincipal(principal);
    const env = await this.repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!env) throw new NotFoundError('Associated environment not found');

    const auth = await hasCapability(this.repositories, principal, 'callback.destination.manage', {
      projectId: env.projectId,
      resourceId,
    });
    if (!auth.allowed) {
      await this.audit.log({
        eventFamily: 'AUTHORIZATION',
        eventType: 'AUTHORIZATION_DECISION',
        surface: 'DOMAIN',
        operation: 'callback.delete',
        outcomeCode: 'DENIED',
        decisionCode: auth.decisionCode,
        reasonCode: auth.reasonCode,
        authoritySources: auth.authoritySources,
        targetType: 'RESOURCE',
        targetId: resourceId,
        actorType: principal.type,
        principalId: principal.id,
        actorId: principal.subjectId,
        authKind: principal.authKind,
        projectId: env.projectId,
        resourceId,
        correlationId,
        payload: { reason: auth.safeExplanation },
      });
      throw new ForbiddenError(auth.safeExplanation);
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
          capability: 'callback.destination.manage',
          decisionCode: 'ALLOW',
          reasonCode: auth.reasonCode,
          authoritySources: auth.authoritySources,
          targetType: 'RESOURCE',
          targetId: resourceId,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          projectId: env.projectId,
          resourceId,
          correlationId,
          payload: {
            destinationId: callbackId,
          },
        },
        tx
      );
    };
    await this.repositories.transaction(remove);
  }

  // ---------------------------------------------------------------------------
  // Approvals & Grants
  // ---------------------------------------------------------------------------
  async createApprovalRequest(
    principal: Principal,
    resourceId: string,
    action: string,
    targetKey?: string | null,
    options?: {
      canonicalKeys?: readonly string[] | null;
      reason?: string;
      idempotencyKey?: string;
      constraints?: Record<string, unknown> | null;
      expiresInMs?: number;
      authFamily?: string;
      audience?: string;
    },
    _correlationId?: string
  ): Promise<{ success: boolean; request?: ApprovalRequest; error?: string }> {
    this.ensureValidPrincipal(principal);
    return this.approvalService.createApprovalRequest({
      resourceId,
      principal,
      requesterId: principal.subjectId,
      requesterType: principal.type === 'SERVICE' ? 'SERVICE_PRINCIPAL' : 'DISCORD_USER',
      authKind: principal.authKind,
      authFamily: options?.authFamily,
      audience: options?.audience,
      action,
      targetKey: targetKey ?? null,
      canonicalKeys: options?.canonicalKeys,
      reason: options?.reason,
      idempotencyKey: options?.idempotencyKey,
      constraints: options?.constraints,
      expiresInMs: options?.expiresInMs,
    });
  }

  async recordApprovalDecision(
    principal: Principal,
    requestId: string,
    decision: 'APPROVE' | 'DENY',
    consentId?: string,
    _correlationId?: string
  ): Promise<{ success: boolean; error?: string }> {
    this.ensureValidPrincipal(principal);
    if (principal.type === 'SERVICE') {
      throw new ForbiddenError('Service principals cannot resolve approval requests');
    }

    return this.approvalService.recordDecision(requestId, decision, principal, consentId);
  }

  async cancelApprovalRequest(
    principal: Principal,
    requestId: string,
    _correlationId?: string
  ): Promise<{ success: boolean; error?: string }> {
    this.ensureValidPrincipal(principal);
    return this.approvalService.cancelApprovalRequest(requestId, principal);
  }

  async getApprovalRequest(
    principal: Principal,
    requestId: string,
    correlationId?: string
  ): Promise<ApprovalRequest | null> {
    this.ensureValidPrincipal(principal);
    const request = await this.approvalService.getApprovalRequest(requestId);
    if (!request) return null;

    if (request.requesterId === principal.subjectId) {
      return request;
    }

    const queueAuth = await hasCapability(this.repositories, principal, 'request.queue.view', {
      requestId,
      resourceId: request.resourceId,
    });
    if (queueAuth.allowed) {
      return request;
    }

    const env = await this.repositories.projects.findEnvironmentByResourceId(request.resourceId);
    if (env) {
      const projectAuth = await hasCapability(this.repositories, principal, 'project.view', {
        projectId: env.projectId,
      });
      if (projectAuth.allowed) {
        return request;
      }
    }

    const explanation = queueAuth.safeExplanation ?? 'Permission denied';
    await this.audit.log({
      eventFamily: 'AUTHORIZATION',
      eventType: 'AUTHORIZATION_DECISION',
      surface: 'DOMAIN',
      operation: 'request.view',
      outcomeCode: 'DENIED',
      decisionCode: queueAuth.decisionCode,
      reasonCode: queueAuth.reasonCode,
      authoritySources: queueAuth.authoritySources,
      targetType: 'APPROVAL_REQUEST',
      targetId: requestId,
      actorType: principal.type,
      principalId: principal.id,
      actorId: principal.subjectId,
      authKind: principal.authKind,
      resourceId: request.resourceId,
      correlationId,
      payload: { reason: explanation },
    });
    throw new ForbiddenError(explanation);
  }

  async getApprovalGrantByRequestId(
    principal: Principal,
    requestId: string,
    correlationId?: string
  ): Promise<ApprovalGrant | null> {
    this.ensureValidPrincipal(principal);
    const request = await this.getApprovalRequest(principal, requestId, correlationId);
    if (!request) return null;

    return this.repositories.approvalGrants.findByRequestId(requestId);
  }
}
