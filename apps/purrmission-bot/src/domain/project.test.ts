
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { ProjectService } from './project.js';
import { ProjectRepository } from './repositories.js';
import { Project, Environment } from './models.js';

describe('ProjectService', () => {
    let projectRepo: ProjectRepository;
    let projectService: ProjectService;

    beforeEach(() => {
        projectRepo = {
            createProject: mock.fn(),
            listProjectsByOwner: mock.fn(),
            findById: mock.fn(),
            createEnvironment: mock.fn(),
            listEnvironments: mock.fn(),
            findEnvironment: mock.fn(),
        } as unknown as ProjectRepository;

        projectService = new ProjectService(projectRepo);
    });

    it('should create a project', async () => {
        const input = { name: 'My Project', ownerId: 'user-1' };
        const created: Project = { ...input, id: 'p-1', description: null, createdAt: new Date() };
        (projectRepo.createProject as any).mock.mockImplementation(async () => created);

        const result = await projectService.createProject(input);

        assert.deepStrictEqual(result, created);
        assert.strictEqual((projectRepo.createProject as any).mock.callCount(), 1);
        assert.deepStrictEqual((projectRepo.createProject as any).mock.calls[0].arguments, [input]);
    });

    it('should list projects by owner', async () => {
        const userId = 'user-1';
        const projects: Project[] = [{ id: 'p-1', name: 'P1', ownerId: userId, description: null, createdAt: new Date() }];
        (projectRepo.listProjectsByOwner as any).mock.mockImplementation(async () => projects);

        const result = await projectService.listProjects(userId);

        assert.deepStrictEqual(result, projects);
        assert.strictEqual((projectRepo.listProjectsByOwner as any).mock.callCount(), 1);
        assert.deepStrictEqual((projectRepo.listProjectsByOwner as any).mock.calls[0].arguments, [userId]);
    });

    it('should get project by id', async () => {
        const projectId = 'p-1';
        const project: Project = { id: projectId, name: 'P1', ownerId: 'user-1', description: null, createdAt: new Date() };
        (projectRepo.findById as any).mock.mockImplementation(async () => project);

        const result = await projectService.getProject(projectId);

        assert.deepStrictEqual(result, project);
        assert.strictEqual((projectRepo.findById as any).mock.callCount(), 1);
        assert.deepStrictEqual((projectRepo.findById as any).mock.calls[0].arguments, [projectId]);
    });

    it('should create an environment', async () => {
        const input = { name: 'Production', slug: 'prod', projectId: 'p-1' };
        const created: Environment = { ...input, id: 'e-1', createdAt: new Date() };
        (projectRepo.createEnvironment as any).mock.mockImplementation(async () => created);

        const result = await projectService.createEnvironment(input);

        assert.deepStrictEqual(result, created);
        assert.strictEqual((projectRepo.createEnvironment as any).mock.callCount(), 1);
        assert.deepStrictEqual((projectRepo.createEnvironment as any).mock.calls[0].arguments, [input]);
    });
});
