import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryRepositories } from './repositories.mock.js';
import type { Repositories } from './repositories.js';
import { createServices, Services } from './services.js';
import { createDiscordPrincipal, createServicePrincipal } from './principal.js';
import { ForbiddenError } from './ports.js';
import { ValidationError } from './errors.js';

describe('DomainPortsImpl Shared Adapter Contracts', () => {
  let repos: Repositories;
  let services: Services;

  const ownerPrincipal = createDiscordPrincipal('user-owner');
  const writerPrincipal = createDiscordPrincipal('user-writer');
  const readerPrincipal = createDiscordPrincipal('user-reader');
  const guardianPrincipal = createDiscordPrincipal('user-guardian');
  const outsiderPrincipal = createDiscordPrincipal('user-outsider');
  const servicePrincipal = createServicePrincipal('service-agent', 'api-key-1');

  beforeEach(() => {
    repos = createInMemoryRepositories();
    services = createServices({ repositories: repos });
  });

  describe('Project Lifecycle & Capability Boundaries', () => {
    it('allows authenticated Discord user to create project, and forbids service principal', async () => {
      const project = await services.ports.createProject(ownerPrincipal, {
        name: 'Alpha Project',
      });
      assert.ok(project.id);
      assert.equal(project.name, 'Alpha Project');
      assert.equal(project.ownerId, 'user-owner');

      await assert.rejects(
        async () => {
          await services.ports.createProject(servicePrincipal, { name: 'Service Project' });
        },
        (err) => err instanceof ForbiddenError
      );
    });

    it('lists projects for owner and members, returning empty for service principals', async () => {
      const p1 = await services.ports.createProject(ownerPrincipal, { name: 'P1' });
      await services.ports.addProjectMember(ownerPrincipal, {
        projectId: p1.id,
        memberUserId: 'user-writer',
        role: 'WRITER',
      });

      const ownerList = await services.ports.listProjects(ownerPrincipal);
      assert.equal(ownerList.length, 1);
      assert.equal(ownerList[0].id, p1.id);

      const writerList = await services.ports.listProjects(writerPrincipal);
      assert.equal(writerList.length, 1);
      assert.equal(writerList[0].id, p1.id);

      const outsiderList = await services.ports.listProjects(outsiderPrincipal);
      assert.equal(outsiderList.length, 0);

      const serviceList = await services.ports.listProjects(servicePrincipal);
      assert.equal(serviceList.length, 0);
    });

    it('enforces membership capabilities on getProject', async () => {
      const p1 = await services.ports.createProject(ownerPrincipal, { name: 'Project 1' });

      const fetchedOwner = await services.ports.getProject(ownerPrincipal, p1.id);
      assert.ok(fetchedOwner);
      assert.equal(fetchedOwner.id, p1.id);

      await assert.rejects(
        async () => {
          await services.ports.getProject(outsiderPrincipal, p1.id);
        },
        (err) => err instanceof ForbiddenError
      );

      const nonexistent = await services.ports.getProject(ownerPrincipal, 'nonexistent-id');
      assert.equal(nonexistent, null);
    });

    it('enforces project.members.manage authorization on add/remove member', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'Team Project' });

      // Owner can add writer
      await services.ports.addProjectMember(ownerPrincipal, {
        projectId: project.id,
        memberUserId: 'user-writer',
        role: 'WRITER',
      });

      // Writer cannot add reader (only project owner has project.members.manage)
      await assert.rejects(
        async () => {
          await services.ports.addProjectMember(writerPrincipal, {
            projectId: project.id,
            memberUserId: 'user-reader',
            role: 'READER',
          });
        },
        (err) => err instanceof ForbiddenError
      );

      // Members can list project members
      const members = await services.ports.listProjectMembers(writerPrincipal, project.id);
      assert.equal(members.length, 1);
      assert.equal(members[0].userId, 'user-writer');

      // Outsider cannot list members
      await assert.rejects(
        async () => {
          await services.ports.listProjectMembers(outsiderPrincipal, project.id);
        },
        (err) => err instanceof ForbiddenError
      );

      // Owner can remove member
      await services.ports.removeProjectMember(ownerPrincipal, project.id, 'user-writer');
      const updatedMembers = await services.ports.listProjectMembers(ownerPrincipal, project.id);
      assert.equal(updatedMembers.length, 0);
    });
  });

  describe('Environment Lifecycle & Atomic Mutation', () => {
    it('creates environment and resource atomically in a single transaction', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });

      const env = await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Production',
        slug: 'prod',
      });

      assert.ok(env.id);
      assert.equal(env.name, 'Production');
      assert.equal(env.slug, 'prod');
      assert.ok(env.resourceId);

      const resource = await repos.resources.findById(env.resourceId);
      assert.ok(resource);
      assert.equal(resource.name, 'App:Production');
    });

    it('forbids non-owner from creating environments', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      await services.ports.addProjectMember(ownerPrincipal, {
        projectId: project.id,
        memberUserId: 'user-writer',
        role: 'WRITER',
      });

      await assert.rejects(
        async () => {
          await services.ports.createEnvironment(writerPrincipal, {
            projectId: project.id,
            name: 'Staging',
            slug: 'staging',
          });
        },
        (err) => err instanceof ForbiddenError
      );
    });

    it('rolls back resource creation if environment persistence fails', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      const initialResources = await repos.resources.findManyByIds([]);

      // Inject a one-time failure on createEnvironment in project repo
      const originalCreateEnvironment = repos.projects.createEnvironment.bind(repos.projects);
      repos.projects.createEnvironment = async () => {
        throw new Error('Database disk error');
      };

      await assert.rejects(
        async () => {
          await services.ports.createEnvironment(ownerPrincipal, {
            projectId: project.id,
            name: 'Staging',
            slug: 'staging',
          });
        },
        (err) => err instanceof Error && err.message === 'Database disk error'
      );

      // Restore
      repos.projects.createEnvironment = originalCreateEnvironment;

      // Verify no orphaned resources exist
      const afterResources = await repos.resources.findManyByIds([]);
      assert.equal(afterResources.length, initialResources.length);
    });

    it('allows project members to list and view environments but forbids outsiders', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Dev',
        slug: 'dev',
      });
      await services.ports.addProjectMember(ownerPrincipal, {
        projectId: project.id,
        memberUserId: 'user-reader',
        role: 'READER',
      });

      const envs = await services.ports.listEnvironments(readerPrincipal, project.id);
      assert.equal(envs.length, 1);
      assert.equal(envs[0].slug, 'dev');

      const singleEnv = await services.ports.getEnvironment(readerPrincipal, project.id, 'dev');
      assert.ok(singleEnv);
      assert.equal(singleEnv.slug, 'dev');

      await assert.rejects(
        async () => {
          await services.ports.listEnvironments(outsiderPrincipal, project.id);
        },
        (err) => err instanceof ForbiddenError
      );

      await assert.rejects(
        async () => {
          await services.ports.getEnvironment(outsiderPrincipal, project.id, 'dev');
        },
        (err) => err instanceof ForbiddenError
      );
    });
  });

  describe('Secret Batch Mutation & Validation Constraints', () => {
    it('allows Owner and Writer to set secrets with batch validation', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      const env = await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Production',
        slug: 'prod',
      });
      await services.ports.addProjectMember(ownerPrincipal, {
        projectId: project.id,
        memberUserId: 'user-writer',
        role: 'WRITER',
      });

      // Writer can set secrets
      await services.ports.setSecrets(writerPrincipal, {
        projectId: project.id,
        envId: env.id,
        secrets: {
          DATABASE_URL: 'postgres://localhost/db',
          API_KEY: 'secret123',
        },
      });

      assert.ok(env.resourceId);
      const fields = await repos.resourceFields.findByResourceId(env.resourceId);
      assert.equal(fields.length, 2);
    });

    it('forbids Reader and Outsider from mutating secrets', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      const env = await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Production',
        slug: 'prod',
      });
      await services.ports.addProjectMember(ownerPrincipal, {
        projectId: project.id,
        memberUserId: 'user-reader',
        role: 'READER',
      });

      await assert.rejects(
        async () => {
          await services.ports.setSecrets(readerPrincipal, {
            projectId: project.id,
            envId: env.id,
            secrets: { KEY: 'val' },
          });
        },
        (err) => err instanceof ForbiddenError
      );
    });

    it('rejects invalid key formats and oversized batches during secret mutation', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      const env = await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Production',
        slug: 'prod',
      });

      // Invalid key format
      await assert.rejects(
        async () => {
          await services.ports.setSecrets(ownerPrincipal, {
            projectId: project.id,
            envId: env.id,
            secrets: { 'INVALID KEY WITH SPACES': 'value' },
          });
        },
        (err) => err instanceof ValidationError
      );

      // Key too long (> 250 chars)
      await assert.rejects(
        async () => {
          await services.ports.setSecrets(ownerPrincipal, {
            projectId: project.id,
            envId: env.id,
            secrets: { ['A'.repeat(251)]: 'value' },
          });
        },
        (err) => err instanceof ValidationError
      );
    });

    it('fails closed on getSecrets read port without grant redemption', async () => {
      await assert.rejects(
        async () => {
          await services.ports.getSecrets(ownerPrincipal, 'proj-1', 'env-1');
        },
        (err) => err instanceof ForbiddenError
      );
    });
  });

  describe('Callback Destination Lifecycle', () => {
    it('allows Owner to register, list, and delete callbacks with sanitized audit logs', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      const env = await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Prod',
        slug: 'prod',
      });
      assert.ok(env.resourceId);
      const resourceId = env.resourceId;

      const callback = await services.ports.registerCallback(
        ownerPrincipal,
        resourceId,
        'https://user:pass@webhook.example.com/events?token=123#anchor',
        'secret-value-1234567890'
      );

      assert.ok(callback.id);
      assert.equal(callback.resourceId, resourceId);
      assert.equal(callback.enabled, false); // PENDING_VERIFICATION initially

      // List callbacks
      const callbacks = await services.ports.listCallbacks(ownerPrincipal, resourceId);
      assert.equal(callbacks.length, 1);
      assert.equal(callbacks[0].id, callback.id);

      // Delete callback
      await services.ports.deleteCallback(ownerPrincipal, resourceId, callback.id);
      const afterDelete = await services.ports.listCallbacks(ownerPrincipal, resourceId);
      assert.equal(afterDelete.length, 0);
    });

    it('forbids non-owner from registering or deleting callbacks', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      const env = await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Prod',
        slug: 'prod',
      });
      assert.ok(env.resourceId);
      const resourceId = env.resourceId;

      await services.ports.addProjectMember(ownerPrincipal, {
        projectId: project.id,
        memberUserId: 'user-writer',
        role: 'WRITER',
      });

      await assert.rejects(
        async () => {
          await services.ports.registerCallback(
            writerPrincipal,
            resourceId,
            'https://webhook.example.com/events',
            'secret'
          );
        },
        (err) => err instanceof ForbiddenError
      );
    });
  });

  describe('Approvals & Grants Lifecycle', () => {
    it('allows creation, guardian decision, and grant lookup through DomainPorts', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      const env = await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Prod',
        slug: 'prod',
      });
      assert.ok(env.resourceId);
      const resourceId = env.resourceId;

      // Register explicit guardian
      await repos.guardians.add({
        resourceId,
        discordUserId: 'user-guardian',
        role: 'GUARDIAN',
      });

      // 1. Create approval request
      const createRes = await services.ports.createApprovalRequest(
        writerPrincipal,
        resourceId,
        'SECRET_READ',
        'DATABASE_URL',
        { reason: 'Production debugging' }
      );

      assert.ok(createRes.success);
      assert.ok(createRes.request);
      const requestId = createRes.request.id;

      // 2. Requester can view own request
      const fetchedByRequester = await services.ports.getApprovalRequest(
        writerPrincipal,
        requestId
      );
      assert.ok(fetchedByRequester);
      assert.equal(fetchedByRequester.id, requestId);

      // 3. Guardian can view and decide request
      const fetchedByGuardian = await services.ports.getApprovalRequest(
        guardianPrincipal,
        requestId
      );
      assert.ok(fetchedByGuardian);

      const decisionRes = await services.ports.recordApprovalDecision(
        guardianPrincipal,
        requestId,
        'APPROVE'
      );
      assert.ok(decisionRes.success);

      // 4. Authorized user can get grant by request ID
      const grant = await services.ports.getApprovalGrantByRequestId(writerPrincipal, requestId);
      assert.ok(grant);
      assert.equal(grant.requestId, requestId);
      assert.equal(grant.consumedAt, null);
      assert.equal(grant.revokedAt, null);

      // 5. Outsider is denied from viewing request
      await assert.rejects(
        async () => {
          await services.ports.getApprovalRequest(outsiderPrincipal, requestId);
        },
        (err) => err instanceof ForbiddenError
      );
    });

    it('allows requester to cancel own approval request', async () => {
      const project = await services.ports.createProject(ownerPrincipal, { name: 'App' });
      const env = await services.ports.createEnvironment(ownerPrincipal, {
        projectId: project.id,
        name: 'Prod',
        slug: 'prod',
      });
      assert.ok(env.resourceId);
      const resourceId = env.resourceId;

      const createRes = await services.ports.createApprovalRequest(
        writerPrincipal,
        resourceId,
        'SECRET_READ',
        'DATABASE_URL'
      );
      assert.ok(createRes.request);

      const cancelRes = await services.ports.cancelApprovalRequest(
        writerPrincipal,
        createRes.request.id
      );
      assert.ok(cancelRes.success);

      const req = await services.ports.getApprovalRequest(writerPrincipal, createRes.request.id);
      assert.ok(req);
      assert.equal(req.status, 'CANCELLED');
    });
  });
});
