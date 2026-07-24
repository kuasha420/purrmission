import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import type { Client } from 'discord.js';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../domain/services.js';
import { ForbiddenError } from '../domain/auth.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import { createHttpServer } from '../http/server.js';

// Minimal mock Discord client
const mockDiscordClient = {
  isReady: () => true,
  user: { tag: 'TestBot#0000' },
  channels: { fetch: async () => null },
  users: { fetch: async () => null },
  login: async () => 'token',
  destroy: () => {},
  on: () => {},
  once: () => {},
} as unknown as Client;

describe('System API E2E Tests', () => {
  let server: FastifyInstance;

  // Shared mock implementations that tests can override
  const mockVerifyApiKey = { fn: async (_apiKey: string): Promise<unknown> => null };
  const mockCreateApprovalRequest = {
    fn: async (_input: unknown): Promise<unknown> => ({ success: false }),
  };
  const mockGetApprovalRequest = { fn: async (_id: string): Promise<unknown> => null };
  const mockFindActiveApproval = {
    fn: async (_resourceId: string, _userId: string): Promise<unknown> => null,
  };
  const mockValidateToken = { fn: async (_token: string): Promise<unknown> => null };
  const mockGetProject = { fn: async (_projectId: string): Promise<unknown> => null };
  const mockGetEnvironmentById = {
    fn: async (_projectId: string, _envId: string): Promise<unknown> => null,
  };
  const mockGetMemberRole = {
    fn: async (_projectId: string, _userId: string): Promise<unknown> => null,
  };
  const mockIsGuardian = {
    fn: async (_resourceId: string, _userId: string): Promise<boolean> => false,
  };
  const mockListFields = { fn: async (_resourceId: string): Promise<unknown[]> => [] };
  const mockUpsertField = {
    fn: async (_resourceId: string, _key: string, _value: string): Promise<void> => {},
  };
  const mockSetSecrets = {
    fn: async (
      _resourceId: string,
      _secrets: Record<string, string>,
      _principal: any
    ): Promise<void> => {},
  };

  const servicesMock = {
    resource: {
      verifyApiKey: (apiKey: string) => mockVerifyApiKey.fn(apiKey),
      isGuardian: (resourceId: string, userId: string) => mockIsGuardian.fn(resourceId, userId),
      listFields: (resourceId: string) => mockListFields.fn(resourceId),
      upsertField: (resourceId: string, key: string, value: string) =>
        mockUpsertField.fn(resourceId, key, value),
      setSecrets: (resourceId: string, secrets: Record<string, string>, principal: any) =>
        mockSetSecrets.fn(resourceId, secrets, principal),
    },
    approval: {
      createApprovalRequest: (input: unknown) => mockCreateApprovalRequest.fn(input),
      getApprovalRequest: (id: string) => mockGetApprovalRequest.fn(id),
      findActiveApproval: (resourceId: string, userId: string) =>
        mockFindActiveApproval.fn(resourceId, userId),
      findActiveUnconsumedGrant: async (resourceId: string, userId: string) => {
        const approval = await mockFindActiveApproval.fn(resourceId, userId);
        if (approval && approval.status === 'APPROVED') {
          return { id: 'mock-grant-id', resourceId, userId };
        }
        return null;
      },
      consumeGrant: async () => true,
    },
    auth: {
      validateToken: (token: string) => mockValidateToken.fn(token),
    },
    project: {
      getProject: (projectId: string) => mockGetProject.fn(projectId),
      getEnvironmentById: (projectId: string, envId: string) =>
        mockGetEnvironmentById.fn(projectId, envId),
      getMemberRole: (projectId: string, userId: string) => mockGetMemberRole.fn(projectId, userId),
    },
    ports: {
      getSecrets: async (principal: any, projectId: string, envId: string, grantId?: string) => {
        const userId = principal.id;
        const project = await mockGetProject.fn(projectId);
        if (!project) throw new ResourceNotFoundError('Project not found');
        const env = await mockGetEnvironmentById.fn(projectId, envId);
        if (!env) throw new ResourceNotFoundError('Environment not found');

        // 1. Owner access
        if (project.ownerId === userId) {
          const fields = await mockListFields.fn(env.resourceId);
          return Object.fromEntries((fields as any[]).map((f) => [f.name, f.value]));
        }

        // 2. Member role access
        const role = await mockGetMemberRole.fn(projectId, userId);
        if (role === 'READER' || role === 'WRITER') {
          const fields = await mockListFields.fn(env.resourceId);
          return Object.fromEntries((fields as any[]).map((f) => [f.name, f.value]));
        }

        // 3. Guardian access
        const isGuardian = await mockIsGuardian.fn(env.resourceId, userId);
        if (isGuardian) {
          const fields = await mockListFields.fn(env.resourceId);
          return Object.fromEntries((fields as any[]).map((f) => [f.name, f.value]));
        }

        // 4. Grant access
        if (grantId) {
          const fields = await mockListFields.fn(env.resourceId);
          return Object.fromEntries((fields as any[]).map((f) => [f.name, f.value]));
        }

        // Fallback: throw ForbiddenError
        throw new ForbiddenError('Access denied: Secrets access not approved');
      },
      createApprovalRequest: async (principal: any, resourceId: string, action: string) => {
        const result = await mockCreateApprovalRequest.fn({
          resourceId,
          requesterId: principal.id,
          requesterType: principal.type,
          authKind: principal.authKind,
          action,
        });
        return result;
      },
      getApprovalRequest: async (principal: any, requestId: string) => {
        return mockGetApprovalRequest.fn(requestId);
      },
    },
  } as unknown as Services;

  beforeEach(async () => {
    // Reset mocks to default behavior
    mockVerifyApiKey.fn = async () => null;
    mockCreateApprovalRequest.fn = async () => ({ success: false });
    mockGetApprovalRequest.fn = async () => null;
    mockFindActiveApproval.fn = async () => null;
    mockValidateToken.fn = async () => null;
    mockGetProject.fn = async () => null;
    mockGetEnvironmentById.fn = async () => null;
    mockGetMemberRole.fn = async () => null;
    mockIsGuardian.fn = async () => false;
    mockListFields.fn = async () => [];
    mockUpsertField.fn = async () => {};

    server = createHttpServer({
      services: servicesMock,
      discordClient: mockDiscordClient,
    });
    await server.ready();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  describe('POST /api/requests', () => {
    it('should return 400 when body validation fails', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/requests',
        payload: {
          // missing required apiKey and resourceId
        },
      });
      assert.strictEqual(response.statusCode, 400);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.error, 'Invalid request body');
    });

    it('should return 401 when API key is invalid', async () => {
      mockVerifyApiKey.fn = async () => null;

      const response = await server.inject({
        method: 'POST',
        url: '/api/requests',
        payload: {
          resourceId: 'res-1',
          apiKey: 'invalid-key',
        },
      });
      assert.strictEqual(response.statusCode, 401);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.error, 'Invalid API key');
    });

    it('should return 401 when resourceId does not match API key resource', async () => {
      mockVerifyApiKey.fn = async () => ({
        id: 'res-correct',
        name: 'Correct Resource',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/requests',
        payload: {
          resourceId: 'res-incorrect',
          apiKey: 'valid-key',
        },
      });
      assert.strictEqual(response.statusCode, 401);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.error, 'Resource ID does not match API key');
    });

    it('should return 201 when request is created successfully', async () => {
      const mockResource = {
        id: 'res-1',
        name: 'Test Resource',
      };
      mockVerifyApiKey.fn = async () => mockResource;
      mockCreateApprovalRequest.fn = async () => ({
        success: true,
        request: {
          id: 'req-1',
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 60000),
        },
        resource: mockResource,
        guardians: [{ discordUserId: 'g-1', role: 'GUARDIAN' }],
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/requests',
        payload: {
          resourceId: 'res-1',
          apiKey: 'valid-key',
        },
      });
      assert.strictEqual(response.statusCode, 201);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.requestId, 'req-1');
      assert.strictEqual(data.status, 'PENDING');
      assert.strictEqual(data.resourceId, 'res-1');
      assert.strictEqual(data.resourceName, 'Test Resource');
    });
  });

  describe('GET /api/projects/:projectId/environments/:envId/secrets', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
      });
      assert.strictEqual(response.statusCode, 401);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.error, 'unauthorized');
    });

    it('should return 401 when Bearer token is invalid', async () => {
      mockValidateToken.fn = async () => null;

      const response = await server.inject({
        method: 'GET',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
        headers: {
          Authorization: 'Bearer invalid-token',
        },
      });
      assert.strictEqual(response.statusCode, 401);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.error, 'unauthorized');
    });

    it('should return 200 with secrets when requester is the project owner', async () => {
      mockValidateToken.fn = async () => ({ userId: 'user-owner' });
      mockGetProject.fn = async () => ({ ownerId: 'user-owner', name: 'MyProject' });
      mockGetEnvironmentById.fn = async () => ({ name: 'Production', resourceId: 'res-1' });
      mockListFields.fn = async () => [
        { name: 'DB_PASS', value: 'my-pass' },
        { name: 'API_SECRET', value: 'my-secret' },
      ];

      const response = await server.inject({
        method: 'GET',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
        headers: {
          Authorization: 'Bearer valid-token',
        },
      });
      assert.strictEqual(response.statusCode, 200);
      const data = JSON.parse(response.payload);
      assert.deepStrictEqual(data.secrets, {
        DB_PASS: 'my-pass',
        API_SECRET: 'my-secret',
      });
    });

    it('should return 202 pending when approval is required and is currently pending', async () => {
      mockValidateToken.fn = async () => ({ userId: 'user-requester' });
      mockGetProject.fn = async () => ({ ownerId: 'user-owner', name: 'MyProject' });
      mockGetEnvironmentById.fn = async () => ({ name: 'Production', resourceId: 'res-1' });
      mockGetMemberRole.fn = async () => null; // not a project member
      mockIsGuardian.fn = async () => false; // not a guardian
      mockFindActiveApproval.fn = async () => ({
        id: 'req-1',
        status: 'PENDING',
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
        headers: {
          Authorization: 'Bearer valid-token',
        },
      });
      assert.strictEqual(response.statusCode, 202);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.status, 'pending');
      assert.strictEqual(data.requestId, 'req-1');
    });

    it('should return 200 with secrets when approval has been approved', async () => {
      mockValidateToken.fn = async () => ({ userId: 'user-requester' });
      mockGetProject.fn = async () => ({ ownerId: 'user-owner', name: 'MyProject' });
      mockGetEnvironmentById.fn = async () => ({ name: 'Production', resourceId: 'res-1' });
      mockGetMemberRole.fn = async () => null;
      mockIsGuardian.fn = async () => false;
      mockFindActiveApproval.fn = async () => ({
        id: 'req-1',
        status: 'APPROVED',
      });
      mockListFields.fn = async () => [{ name: 'SECRET_KEY', value: 'approved-value' }];

      const response = await server.inject({
        method: 'GET',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
        headers: {
          Authorization: 'Bearer valid-token',
        },
      });
      assert.strictEqual(response.statusCode, 200);
      const data = JSON.parse(response.payload);
      assert.deepStrictEqual(data.secrets, {
        SECRET_KEY: 'approved-value',
      });
    });

    it('should automatically trigger a new approval request and return 202 when no active request exists', async () => {
      mockValidateToken.fn = async () => ({ userId: 'user-requester' });
      mockGetProject.fn = async () => ({ ownerId: 'user-owner', name: 'MyProject' });
      mockGetEnvironmentById.fn = async () => ({ name: 'Production', resourceId: 'res-1' });
      mockGetMemberRole.fn = async () => null;
      mockIsGuardian.fn = async () => false;
      mockFindActiveApproval.fn = async () => null; // none exists yet

      let createdRequest = false;
      mockCreateApprovalRequest.fn = async (input: unknown) => {
        createdRequest = true;
        assert.strictEqual((input as { resourceId: string }).resourceId, 'res-1');
        return {
          success: true,
          request: {
            id: 'req-new',
            status: 'PENDING',
          },
          resource: { id: 'res-1', name: 'MyProject:Production' },
          guardians: [{ discordUserId: 'g-1', role: 'OWNER' }],
        };
      };

      const response = await server.inject({
        method: 'GET',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
        headers: {
          Authorization: 'Bearer valid-token',
        },
      });
      assert.strictEqual(response.statusCode, 202);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.status, 'pending');
      assert.strictEqual(data.requestId, 'req-new');
      assert.strictEqual(createdRequest, true);
    });

    it('should return 401 when access is explicitly denied', async () => {
      mockValidateToken.fn = async () => ({ userId: 'user-requester' });
      mockGetProject.fn = async () => ({ ownerId: 'user-owner', name: 'MyProject' });
      mockGetEnvironmentById.fn = async () => ({ name: 'Production', resourceId: 'res-1' });
      mockGetMemberRole.fn = async () => null;
      mockIsGuardian.fn = async () => false;
      mockFindActiveApproval.fn = async () => ({
        id: 'req-1',
        status: 'DENIED',
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
        headers: {
          Authorization: 'Bearer valid-token',
        },
      });
      assert.strictEqual(response.statusCode, 401);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.error, 'unauthorized');
    });
  });

  describe('PUT /api/projects/:projectId/environments/:envId/secrets', () => {
    it('should return 403 Forbidden when authenticated user lacks write permissions', async () => {
      mockValidateToken.fn = async () => ({ userId: 'user-reader' });
      mockGetProject.fn = async () => ({ id: 'p-1', ownerId: 'user-owner', name: 'MyProject' });
      mockGetMemberRole.fn = async () => 'READER'; // READER is read-only, lacks WRITER/OWNER

      const response = await server.inject({
        method: 'PUT',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
        headers: {
          Authorization: 'Bearer valid-token',
        },
        payload: {
          secrets: { FOO: 'bar' },
        },
      });

      assert.strictEqual(response.statusCode, 403);
      const data = JSON.parse(response.payload);
      assert.strictEqual(data.error, 'INSUFFICIENT_PERMISSIONS');
      assert.strictEqual(data.message, 'Write permission required');
    });

    it('should return 200 OK when authenticated user is project owner or writer', async () => {
      mockValidateToken.fn = async () => ({ userId: 'user-owner' });
      mockGetProject.fn = async () => ({ id: 'p-1', ownerId: 'user-owner', name: 'MyProject' });
      mockGetEnvironmentById.fn = async () => ({ name: 'Production', resourceId: 'res-1' });

      let setSecretsCalled = false;
      let setSecretsPayload: Record<string, string> = {};
      mockSetSecrets.fn = async (_resourceId, secrets, _principal) => {
        setSecretsCalled = true;
        setSecretsPayload = secrets;
      };

      const response = await server.inject({
        method: 'PUT',
        url: '/api/projects/b0f19c99-d41c-43be-82a8-9d7a96df3222/environments/e0f19c99-d41c-43be-82a8-9d7a96df3222/secrets',
        headers: {
          Authorization: 'Bearer valid-token',
        },
        payload: {
          secrets: { FOO: 'bar', BAZ: 'qux' },
        },
      });

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(setSecretsCalled, true);
      assert.deepStrictEqual(setSecretsPayload, { FOO: 'bar', BAZ: 'qux' });
    });
  });
});
