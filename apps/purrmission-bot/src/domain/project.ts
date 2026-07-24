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

export class ProjectService {
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly resourceService: {
      createResource: (name: string, ownerId: string) => Promise<{ resource: { id: string } }>;
    }
  ) {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.projectRepo.createProject(input);
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

    // 2. Create Resource for this environment
    const resourceName = `${project.name}:${input.name}`; // e.g., web-app:dev
    const { resource } = await this.resourceService.createResource(resourceName, project.ownerId);

    // 3. Create Environment linked to Resource
    return this.projectRepo.createEnvironment({
      ...input,
      resourceId: resource.id,
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
    return this.projectRepo.addMember({
      projectId,
      userId,
      role,
      addedBy,
    });
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    return this.projectRepo.removeMember(projectId, userId);
  }

  async getMemberRole(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
    return this.projectRepo.getMemberRole(projectId, userId);
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    return this.projectRepo.listMembers(projectId);
  }
}
