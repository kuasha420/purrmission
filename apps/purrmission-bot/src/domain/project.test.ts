import { describe, it, beforeEach, mock, type Mock } from 'node:test';
import assert from 'node:assert';
import { ProjectService } from './project.js';
import { ProjectRepository } from './repositories.js';
import { Project, Environment } from './models.js';

type ResourceServiceDependency = ConstructorParameters<typeof ProjectService>[1];
type MockedProjectRepository = {
  createProject: Mock<ProjectRepository['createProject']>;
  listProjectsByOwner: Mock<ProjectRepository['listProjectsByOwner']>;
  findById: Mock<ProjectRepository['findById']>;
  createEnvironment: Mock<ProjectRepository['createEnvironment']>;
  listEnvironments: Mock<ProjectRepository['listEnvironments']>;
  findEnvironment: Mock<ProjectRepository['findEnvironment']>;
};

describe('ProjectService', () => {
  let projectRepo: MockedProjectRepository;
  let projectService: ProjectService;
  let resourceService: ResourceServiceDependency;
  let createResourceMock: Mock<ResourceServiceDependency['createResource']>;

  beforeEach(() => {
    projectRepo = {
      createProject: mock.fn<ProjectRepository['createProject']>(),
      listProjectsByOwner: mock.fn<ProjectRepository['listProjectsByOwner']>(),
      findById: mock.fn<ProjectRepository['findById']>(),
      createEnvironment: mock.fn<ProjectRepository['createEnvironment']>(),
      listEnvironments: mock.fn<ProjectRepository['listEnvironments']>(),
      findEnvironment: mock.fn<ProjectRepository['findEnvironment']>(),
    };

    createResourceMock = mock.fn<ResourceServiceDependency['createResource']>(async () => ({
      resource: { id: 'res-1' },
    }));
    resourceService = {
      createResource: createResourceMock,
    };

    projectService = new ProjectService(projectRepo, resourceService);
  });

  it('should create a project', async () => {
    const input = { name: 'My Project', ownerId: 'user-1' };
    const created: Project = {
      ...input,
      id: 'p-1',
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    projectRepo.createProject.mock.mockImplementation(async () => created);

    const result = await projectService.createProject(input);

    assert.deepStrictEqual(result, created);
    assert.strictEqual(projectRepo.createProject.mock.callCount(), 1);
    assert.deepStrictEqual(projectRepo.createProject.mock.calls[0].arguments, [input]);
  });

  it('should list projects by owner', async () => {
    const userId = 'user-1';
    const projects: Project[] = [
      {
        id: 'p-1',
        name: 'P1',
        ownerId: userId,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    projectRepo.listProjectsByOwner.mock.mockImplementation(async () => projects);

    const result = await projectService.listProjects(userId);

    assert.deepStrictEqual(result, projects);
    assert.strictEqual(projectRepo.listProjectsByOwner.mock.callCount(), 1);
    assert.deepStrictEqual(projectRepo.listProjectsByOwner.mock.calls[0].arguments, [userId]);
  });

  it('should get project by id', async () => {
    const projectId = 'p-1';
    const project: Project = {
      id: projectId,
      name: 'P1',
      ownerId: 'user-1',
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    projectRepo.findById.mock.mockImplementation(async () => project);

    const result = await projectService.getProject(projectId);

    assert.deepStrictEqual(result, project);
    assert.strictEqual(projectRepo.findById.mock.callCount(), 1);
    assert.deepStrictEqual(projectRepo.findById.mock.calls[0].arguments, [projectId]);
  });

  it('should create an environment', async () => {
    const project: Project = {
      id: 'p-1',
      name: 'My Project',
      ownerId: 'user-1',
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const input = { name: 'Production', slug: 'prod', projectId: 'p-1' };
    const created: Environment = {
      ...input,
      id: 'e-1',
      resourceId: 'res-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    projectRepo.findById.mock.mockImplementation(async () => project);
    projectRepo.createEnvironment.mock.mockImplementation(async () => created);

    const result = await projectService.createEnvironment(input);

    assert.deepStrictEqual(result, created);
    assert.strictEqual(projectRepo.createEnvironment.mock.callCount(), 1);
  });
});
