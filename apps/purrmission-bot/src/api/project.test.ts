import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createHttpServer } from '../http/server.js';
import { createServices } from '../domain/services.js';
import { createInMemoryRepositories } from '../domain/repositories.mock.js';

import { computeKeyedDigestRecord } from '../domain/crypto.js';

// Mock Discord Client (minimal)
import { FastifyInstance } from 'fastify';
import { Services } from '../domain/services.js';
import { Repositories } from '../domain/repositories.js';

import { Client } from 'discord.js';

// Mock Discord Client (minimal)
const mockDiscordClient = {
  isReady: () => true,
  user: { tag: 'TestBot#0000' },
  channels: { fetch: async () => null },
  users: { fetch: async () => null },
  login: async () => {},
  destroy: () => {},
  on: () => {},
  once: () => {},
} as unknown as Client;

describe('Project API', () => {
  let server: FastifyInstance;
  let services: Services;
  let repositories: Repositories;
  const validToken = 'valid-token';
  const userId = 'user-123';

  beforeEach(async () => {
    repositories = createInMemoryRepositories();
    services = createServices({ repositories });

    // Setup Auth for test
    const digest = computeKeyedDigestRecord(validToken, 'PAWTHY_TOKEN');
    await repositories.credentials.create({
      type: 'PAWTHY_TOKEN',
      subjectId: userId,
      name: 'Test Token',
      digest: digest.digest,
      digestKeyId: digest.keyId,
      prefix: validToken.slice(0, 8),
      scopes: ['project.view', 'environment.view', 'resource.view', 'request.create'],
      audience: 'cli',
      targetType: 'ACCOUNT',
      targetId: userId,
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
      revokedReason: null,
    });

    server = createHttpServer({
      services,
      discordClient: mockDiscordClient,
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('should create a project', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { name: 'My Project', description: 'Test Project' },
    });

    assert.strictEqual(response.statusCode, 201);
    const body = JSON.parse(response.payload);
    assert.strictEqual(body.name, 'My Project');
    assert.strictEqual(body.ownerId, userId);
    assert.ok(body.id);
    const events = await repositories.audit.findByScope({ type: 'PROJECT', id: body.id });
    const created = events.find(({ eventType }) => eventType === 'PROJECT_CREATE');
    assert.ok(created);
    assert.strictEqual(created.actorType, 'PAWTHY_TOKEN');
    assert.strictEqual(created.authKind, 'PAWTHY');
    assert.strictEqual(created.actorId, userId);
  });

  it('should list projects', async () => {
    // Create one first
    await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { name: 'P1' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: `Bearer ${validToken}` },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.payload);
    assert.strictEqual(body.length, 1);
    assert.strictEqual(body[0].name, 'P1');
  });

  it('lists, rotates, and revokes Pawthy credentials without exposing digests', async () => {
    const inventoryResponse = await server.inject({
      method: 'GET',
      url: '/api/auth/credentials',
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(inventoryResponse.statusCode, 200);
    assert.strictEqual(inventoryResponse.headers['cache-control'], 'no-store');
    const inventory = JSON.parse(inventoryResponse.payload);
    assert.strictEqual(inventory.length, 1);
    assert.strictEqual('digest' in inventory[0], false);

    const rotateResponse = await server.inject({
      method: 'POST',
      url: `/api/auth/credentials/${inventory[0].id}/rotate`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(rotateResponse.statusCode, 201);
    assert.strictEqual(rotateResponse.headers['cache-control'], 'no-store');
    const rotated = JSON.parse(rotateResponse.payload);
    assert.match(rotated.plaintext, /^paw_/);
    assert.strictEqual('digest' in rotated.credential, false);

    const revokeResponse = await server.inject({
      method: 'DELETE',
      url: `/api/auth/credentials/${rotated.credential.id}`,
      headers: { Authorization: `Bearer ${rotated.plaintext}` },
    });
    assert.strictEqual(revokeResponse.statusCode, 204);
    assert.strictEqual(
      await services.auth.validateToken(rotated.plaintext, { audience: 'cli' }),
      null
    );
  });

  it('should create an environment', async () => {
    // Create project
    const pApp = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { name: 'P2' },
    });
    const project = JSON.parse(pApp.payload);

    // Create environment
    const response = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/environments`,
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { name: 'Production', slug: 'prod' },
    });

    assert.strictEqual(response.statusCode, 201);
    const env = JSON.parse(response.payload);
    assert.strictEqual(env.name, 'Production');
    assert.strictEqual(env.slug, 'prod');
    assert.strictEqual(env.projectId, project.id);
  });

  it('should enforce auth', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/projects',
    });
    assert.strictEqual(response.statusCode, 401);
  });

  it('rejects unsafe correlation and causation headers before routing', async () => {
    const unsafeCorrelation = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: {
        Authorization: `Bearer ${validToken}`,
        'x-correlation-id': 'unsafe value',
      },
    });
    assert.strictEqual(unsafeCorrelation.statusCode, 400);
    assert.deepEqual(unsafeCorrelation.json(), { error: 'Invalid x-correlation-id header' });

    const unsafeCausation = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: {
        Authorization: `Bearer ${validToken}`,
        'x-causation-id': 'unsafe value',
      },
    });
    assert.strictEqual(unsafeCausation.statusCode, 400);
    assert.deepEqual(unsafeCausation.json(), { error: 'Invalid x-causation-id header' });
  });
});
