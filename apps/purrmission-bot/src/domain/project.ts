
import { ProjectRepository } from './repositories.js';
import { Project, Environment, CreateProjectInput, CreateEnvironmentInput } from './models.js';

export class ProjectService {
    constructor(
        private readonly projectRepo: ProjectRepository,
        private readonly resourceService: { createResource: (name: string, ownerId: string) => Promise<{ resource: { id: string } }> }
    ) { }

    async createProject(input: CreateProjectInput): Promise<Project> {
        return this.projectRepo.createProject(input);
    }

    async listProjects(userId: string): Promise<Project[]> {
        return this.projectRepo.listProjectsByOwner(userId);
    }

    async getProject(id: string): Promise<Project | null> {
        return this.projectRepo.findById(id);
    }

    async createEnvironment(input: CreateEnvironmentInput): Promise<Environment> {
        // 1. Get Project to find owner
        const project = await this.getProject(input.projectId);
        if (!project) throw new Error('Project not found');

        // 2. Create Resource for this environment
        const resourceName = `${project.name}:${input.name}`; // e.g., web-app:dev
        const { resource } = await this.resourceService.createResource(resourceName, project.ownerId);

        // 3. Create Environment linked to Resource
        return this.projectRepo.createEnvironment({
            ...input,
            resourceId: resource.id
        });
    }

    async listEnvironments(projectId: string): Promise<Environment[]> {
        return this.projectRepo.listEnvironments(projectId);
    }

    async getEnvironment(projectId: string, slug: string): Promise<Environment | null> {
        return this.projectRepo.findEnvironment(projectId, slug);
    }
}
