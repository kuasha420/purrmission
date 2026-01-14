
import { ProjectRepository } from './repositories.js';
import { Project, Environment, CreateProjectInput, CreateEnvironmentInput } from './models.js';

export class ProjectService {
    constructor(private readonly projectRepo: ProjectRepository) { }

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
        return this.projectRepo.createEnvironment(input);
    }

    async listEnvironments(projectId: string): Promise<Environment[]> {
        return this.projectRepo.listEnvironments(projectId);
    }

    async getEnvironment(projectId: string, slug: string): Promise<Environment | null> {
        return this.projectRepo.findEnvironment(projectId, slug);
    }
}
