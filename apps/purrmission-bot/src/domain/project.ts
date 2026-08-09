import { ProjectRepository } from './repositories.js';
import {
  Project,
  Environment,
  CreateProjectInput,
  CreateEnvironmentInput,
  ResourceNotFoundError,
  ProjectMember,
  ProjectMemberRole,
} from './models.js';
import { type Prisma } from '@prisma/client';
import { AuditService } from './audit.js';

export class ProjectService {
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly resourceService: {
      createResource: (
        name: string,
        ownerId: string,
        tx?: Prisma.TransactionClient
      ) => Promise<{ resource: { id: string } }>;
    },
    private readonly audit: AuditService,
    private readonly transaction: <T>(
      callback: (tx: Prisma.TransactionClient) => Promise<T>
    ) => Promise<T>
  ) {
    if (!audit) throw new TypeError('ProjectService requires an audit dependency.');
  }

  private async runTransaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.transaction(callback);
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.runTransaction(async (tx) => {
      const project = await this.projectRepo.createProject(input, tx);
      await this.audit.log(
        {
          eventFamily: 'PROJECT_MEMBERSHIP',
          eventType: 'PROJECT_CREATE',
          surface: 'DOMAIN',
          operation: 'project.create',
          outcomeCode: 'SUCCESS',
          capability: 'project.create',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['AUTHENTICATED_SUBJECT'],
          targetType: 'PROJECT',
          targetId: project.id,
          actorType: 'DISCORD_USER',
          principalId: `discord:${input.ownerId}`,
          actorId: input.ownerId,
          authKind: 'DISCORD',
          projectId: project.id,
          payload: {},
        },
        tx
      );
      return project;
    });
  }

  async listProjects(userId: string): Promise<Project[]> {
    const owned = await this.projectRepo.listProjectsByOwner(userId);
    const memberships = await this.projectRepo.listMembershipsByUser(userId);

    const projectsMap = new Map<string, Project>();
    for (const p of owned) {
      projectsMap.set(p.id, p);
    }

    for (const m of memberships) {
      if (!projectsMap.has(m.projectId)) {
        const p = await this.projectRepo.findById(m.projectId);
        if (p) {
          projectsMap.set(p.id, p);
        }
      }
    }

    return Array.from(projectsMap.values());
  }

  async getProject(id: string): Promise<Project | null> {
    return this.projectRepo.findById(id);
  }

  async createEnvironment(input: CreateEnvironmentInput): Promise<Environment> {
    // 1. Get Project to find owner
    const project = await this.getProject(input.projectId);
    if (!project) throw new ResourceNotFoundError('Project not found');

    return this.runTransaction(async (tx) => {
      // 2. Create Resource for this environment inside the transaction
      const resourceName = `${project.name}:${input.name}`; // e.g., web-app:dev
      const { resource } = await this.resourceService.createResource(
        resourceName,
        project.ownerId,
        tx
      );

      // 3. Create Environment linked to Resource inside the transaction
      const environment = await this.projectRepo.createEnvironment(
        {
          ...input,
          resourceId: resource.id,
        },
        tx
      );
      await this.audit.log(
        {
          eventFamily: 'RESOURCE_CONFIGURATION',
          eventType: 'ENVIRONMENT_CREATE',
          surface: 'DOMAIN',
          operation: 'environment.create',
          outcomeCode: 'SUCCESS',
          capability: 'environment.create',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: ['PROJECT_OWNER'],
          targetType: 'ENVIRONMENT',
          targetId: environment.id,
          actorType: 'DISCORD_USER',
          principalId: `discord:${project.ownerId}`,
          actorId: project.ownerId,
          authKind: 'DISCORD',
          projectId: project.id,
          environmentId: environment.id,
          resourceId: resource.id,
          payload: { slug: environment.slug },
        },
        tx
      );
      return environment;
    });
  }

  async listEnvironments(projectId: string): Promise<Environment[]> {
    return this.projectRepo.listEnvironments(projectId);
  }

  async getEnvironment(projectId: string, slug: string): Promise<Environment | null> {
    return this.projectRepo.findEnvironment(projectId, slug);
  }

  async getEnvironmentById(projectId: string, envId: string): Promise<Environment | null> {
    return this.projectRepo.getEnvironmentById(projectId, envId);
  }

  async addMember(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
    addedBy: string
  ): Promise<ProjectMember> {
    return this.runTransaction(async (tx) => {
      const member = await this.projectRepo.addMember({ projectId, userId, role, addedBy }, tx);
      await this.audit.log(
        {
          eventFamily: 'PROJECT_MEMBERSHIP',
          eventType: 'PROJECT_MEMBER_ADD',
          surface: 'DOMAIN',
          operation: 'project.member.add',
          outcomeCode: 'SUCCESS',
          capability: 'project.members.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: ['PROJECT_OWNER'],
          targetType: 'PROJECT',
          targetId: projectId,
          actorType: 'DISCORD_USER',
          principalId: `discord:${addedBy}`,
          actorId: addedBy,
          authKind: 'DISCORD',
          projectId,
          payload: { memberUserId: userId, role },
        },
        tx
      );
      return member;
    });
  }

  async removeMember(projectId: string, userId: string, removedBy: string): Promise<void> {
    await this.runTransaction(async (tx) => {
      await this.projectRepo.removeMember(projectId, userId, tx);
      await this.audit.log(
        {
          eventFamily: 'PROJECT_MEMBERSHIP',
          eventType: 'PROJECT_MEMBER_REMOVE',
          surface: 'DOMAIN',
          operation: 'project.member.remove',
          outcomeCode: 'SUCCESS',
          capability: 'project.members.manage',
          decisionCode: 'ALLOW',
          reasonCode: 'OWNER',
          authoritySources: ['PROJECT_OWNER'],
          targetType: 'PROJECT',
          targetId: projectId,
          actorType: 'DISCORD_USER',
          principalId: `discord:${removedBy}`,
          actorId: removedBy,
          authKind: 'DISCORD',
          projectId,
          payload: { memberUserId: userId },
        },
        tx
      );
    });
  }

  async getMemberRole(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
    return this.projectRepo.getMemberRole(projectId, userId);
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    return this.projectRepo.listMembers(projectId);
  }
}
