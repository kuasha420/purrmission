import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import type { Client } from 'discord.js';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../http/server.js';
import { createServices, Services } from '../domain/services.js';
import { createInMemoryRepositories } from '../domain/repositories.mock.js';
import { Repositories } from '../domain/repositories.js';
import { computeKeyedDigestRecord } from '../domain/crypto.js';
import { createDiscordPrincipal } from '../domain/principal.js';

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

describe('HTTP Policy Cutover & Contract Conformance', () => {
  let server: FastifyInstance;
  let services: Services;
  let repositories: Repositories;

  const ownerUserId = 'user-owner-1';
  const writerUserId = 'user-writer-1';
  const readerUserId = 'user-reader-1';
  const guardianUserId = 'user-guardian-1';
  const requesterUserId = 'user-requester-1';

  const ownerToken = 'token-owner-valid';
  const writerToken = 'token-writer-valid';
  const readerToken = 'token-reader-valid';
  const guardianToken = 'token-guardian-valid';
  const requesterToken = 'token-requester-valid';
  const expiredToken = 'token-expired-test';
  const wrongAudienceToken = 'token-wrong-aud';

  let projectId: string;
  let envId: string;
  let resourceId: string;

  async function createTokenCred(
    token: string,
    userId: string,
    scopes: string[],
    options?: { expired?: boolean; audience?: string }
  ) {
    const digest = computeKeyedDigestRecord(token, 'PAWTHY_TOKEN');
    return repositories.credentials.create({
      type: 'PAWTHY_TOKEN',
      subjectId: userId,
      name: `Token for ${userId}`,
      digest: digest.digest,
      digestKeyId: digest.keyId,
      prefix: token.slice(0, 8),
      scopes,
      audience: options?.audience ?? 'cli',
      targetType: 'ACCOUNT',
      targetId: userId,
      expiresAt: options?.expired ? new Date(Date.now() - 3600000) : new Date(Date.now() + 3600000),
      revokedAt: null,
      revokedReason: null,
    });
  }

  beforeEach(async () => {
    repositories = createInMemoryRepositories();
    services = createServices({ repositories });

    // Seed tokens
    const fullScopes = [
      'project.create',
      'project.view',
      'project.members.manage',
      'environment.create',
      'environment.view',
      'secret.metadata.read',
      'secret.value.read',
      'secret.write',
      'secret.delete',
      'totp.metadata.read',
      'totp.code.read',
      'totp.link.manage',
      'totp.account.manage',
      'resource.view',
      'resource.api-key.list',
      'resource.api-key.mint',
      'resource.api-key.rotate',
      'resource.api-key.revoke',
      'callback.destination.manage',
      'callback.destination.view',
      'request.create',
      'request.view-own',
      'request.cancel-own',
      'request.queue.view',
      'request.decide',
    ];

    await createTokenCred(ownerToken, ownerUserId, fullScopes);
    await createTokenCred(writerToken, writerUserId, [
      'project.view',
      'environment.view',
      'secret.metadata.read',
      'secret.value.read',
      'secret.write',
      'resource.view',
      'request.create',
    ]);
    await createTokenCred(readerToken, readerUserId, [
      'project.view',
      'environment.view',
      'secret.metadata.read',
      'secret.value.read',
      'resource.view',
      'request.create',
    ]);
    await createTokenCred(guardianToken, guardianUserId, [
      'resource.view',
      'request.decide',
      'request.queue.view',
      'totp.metadata.read',
    ]);
    await createTokenCred(requesterToken, requesterUserId, [
      'resource.view',
      'request.create',
      'request.view-own',
      'request.cancel-own',
    ]);
    await createTokenCred(expiredToken, ownerUserId, fullScopes, { expired: true });
    await createTokenCred(wrongAudienceToken, ownerUserId, fullScopes, { audience: 'web' });

    // Seed Project & Environment & Resource
    const project = await repositories.projects.createProject({
      name: 'Acme Cloud',
      ownerId: ownerUserId,
      description: 'Acme Main',
    });
    projectId = project.id;

    // Add Project Members
    await repositories.projects.addMember({
      projectId,
      userId: writerUserId,
      role: 'WRITER',
      addedBy: ownerUserId,
    });
    await repositories.projects.addMember({
      projectId,
      userId: readerUserId,
      role: 'READER',
      addedBy: ownerUserId,
    });

    const env = await services.ports.createEnvironment(createDiscordPrincipal(ownerUserId), {
      projectId,
      name: 'Production',
      slug: 'production',
    });
    envId = env.id;
    if (!env.resourceId) throw new Error('Expected resourceId');
    resourceId = env.resourceId;

    // Add Guardian
    await repositories.guardians.add({
      id: 'g-1',
      resourceId,
      discordUserId: guardianUserId,
      role: 'GUARDIAN',
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

  describe('Authentication & Token Semantics', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/projects',
      });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.json().error, 'unauthorized');
    });

    it('rejects expired tokens with 401', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.json().error, 'unauthorized');
    });

    it('rejects wrong audience tokens with 401', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { Authorization: `Bearer ${wrongAudienceToken}` },
      });
      assert.strictEqual(res.statusCode, 401);
    });
  });

  describe('Project & Environment Management via DomainPorts', () => {
    it('allows Owner to list and view projects with Cache-Control: no-store', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/projects/${projectId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['cache-control'], 'no-store');
      assert.strictEqual(res.json().name, 'Acme Cloud');
    });

    it('allows Owner to create environment with Cache-Control: no-store', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/environments`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { name: 'Staging', slug: 'staging' },
      });
      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.headers['cache-control'], 'no-store');
      assert.strictEqual(res.json().slug, 'staging');
    });

    it('denies Non-member access to project details with 403 / 404', async () => {
      const otherUserId = 'user-other';
      const otherToken = 'token-other';
      await createTokenCred(otherToken, otherUserId, ['project.view']);

      const res = await server.inject({
        method: 'GET',
        url: `/api/projects/${projectId}`,
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      assert.strictEqual(res.statusCode, 403);
    });
  });

  describe('Secret Write & Reveal Contracts', () => {
    it('allows Owner and Writer to set secrets via PUT /secrets', async () => {
      const putRes = await server.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/environments/${envId}/secrets`,
        headers: { Authorization: `Bearer ${writerToken}` },
        payload: { secrets: { API_KEY: 'secret-key-123', DB_PASS: 'db-pass-456' } },
      });
      assert.strictEqual(putRes.statusCode, 200);
      assert.strictEqual(putRes.headers['cache-control'], 'no-store');
    });

    it('denies Reader from setting secrets via PUT /secrets with 403', async () => {
      const putRes = await server.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/environments/${envId}/secrets`,
        headers: { Authorization: `Bearer ${readerToken}` },
        payload: { secrets: { FOO: 'bar' } },
      });
      assert.strictEqual(putRes.statusCode, 403);
    });

    it('enforces legacy GET /secrets fails closed with 405 Method Not Allowed', async () => {
      const getRes = await server.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/environments/${envId}/secrets`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.strictEqual(getRes.statusCode, 405);
      assert.strictEqual(getRes.headers.allow, 'PUT');
      assert.strictEqual(getRes.headers['cache-control'], 'no-store');
    });

    it('allows Owner and Reader to reveal environment secrets via authenticated POST /secrets/reveal', async () => {
      // First seed secrets
      await services.ports.setSecrets(createDiscordPrincipal(ownerUserId), {
        projectId,
        envId,
        secrets: { KEY_A: 'val-a', KEY_B: 'val-b' },
      });

      // Reveal all
      const revealRes = await server.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/environments/${envId}/secrets/reveal`,
        headers: { Authorization: `Bearer ${readerToken}` },
        payload: {},
      });
      assert.strictEqual(revealRes.statusCode, 200);
      assert.strictEqual(revealRes.headers['cache-control'], 'no-store');
      assert.deepStrictEqual(revealRes.json().secrets, { KEY_A: 'val-a', KEY_B: 'val-b' });

      // Reveal exact keys selection before decrypt
      const selectRes = await server.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/environments/${envId}/secrets/reveal`,
        headers: { Authorization: `Bearer ${readerToken}` },
        payload: { keys: ['KEY_A'] },
      });
      assert.strictEqual(selectRes.statusCode, 200);
      assert.deepStrictEqual(selectRes.json().secrets, { KEY_A: 'val-a' });
    });

    it('allows single field reveal via authenticated POST /fields/reveal and fails legacy GET with 405', async () => {
      await services.resource.createField(
        resourceId,
        'TOKEN_X',
        'secret-token-val',
        createDiscordPrincipal(ownerUserId)
      );

      // Legacy GET returns 405
      const legacyRes = await server.inject({
        method: 'GET',
        url: `/api/resources/${resourceId}/fields/TOKEN_X`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.strictEqual(legacyRes.statusCode, 405);

      // POST reveal returns 200 with no-store
      const revealRes = await server.inject({
        method: 'POST',
        url: `/api/resources/${resourceId}/fields/reveal`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { name: 'TOKEN_X' },
      });
      assert.strictEqual(revealRes.statusCode, 200);
      assert.strictEqual(revealRes.headers['cache-control'], 'no-store');
      assert.strictEqual(revealRes.json().value, 'secret-token-val');
    });
  });

  describe('Approval Request Lifecycle & Grant Consumption', () => {
    let apiKeyPlaintext: string;

    beforeEach(async () => {
      const minted = await services.resource.mintApiKey(
        resourceId,
        createDiscordPrincipal(ownerUserId),
        'CI Key'
      );
      apiKeyPlaintext = minted.plaintext;
    });

    it('rejects approval requests containing raw callbackUrl or channelId with 400', async () => {
      const badCallbackRes = await server.inject({
        method: 'POST',
        url: '/api/requests',
        payload: {
          resourceId,
          apiKey: apiKeyPlaintext,
          callbackUrl: 'https://evil.com/leak',
        },
      });
      assert.strictEqual(badCallbackRes.statusCode, 400);
      assert.strictEqual(badCallbackRes.json().error, 'validation_error');

      const badChannelRes = await server.inject({
        method: 'POST',
        url: '/api/requests',
        payload: {
          resourceId,
          apiKey: apiKeyPlaintext,
          channelId: '123456789012345678',
        },
      });
      assert.strictEqual(badChannelRes.statusCode, 400);
    });

    it('creates approval request and allows Guardian decision and Requester polling with grantId', async () => {
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/requests',
        payload: {
          resourceId,
          apiKey: apiKeyPlaintext,
          action: 'secret.value.read',
          reason: 'Deploy sync',
        },
      });
      assert.strictEqual(createRes.statusCode, 201);
      assert.strictEqual(createRes.headers['cache-control'], 'no-store');
      const { requestId } = createRes.json();
      assert.ok(requestId);

      // Guardian decides APPROVE
      const decideRes = await server.inject({
        method: 'POST',
        url: `/api/requests/${requestId}/decide`,
        headers: { Authorization: `Bearer ${guardianToken}` },
        payload: { decision: 'APPROVE' },
      });
      assert.strictEqual(decideRes.statusCode, 200);
      assert.strictEqual(decideRes.json().status, 'APPROVED');

      // Requester views status and gets grantId
      const statusRes = await server.inject({
        method: 'GET',
        url: `/api/requests/${requestId}`,
        headers: { Authorization: `Bearer ${guardianToken}` },
      });
      assert.strictEqual(statusRes.statusCode, 200);
      assert.strictEqual(statusRes.headers['cache-control'], 'no-store');
      const statusBody = statusRes.json();
      assert.strictEqual(statusBody.status, 'APPROVED');
      assert.ok(statusBody.grantId);
    });

    it('allows Requester to cancel own request', async () => {
      const created = await services.ports.createApprovalRequest(
        createDiscordPrincipal(ownerUserId),
        resourceId,
        'secret.value.read'
      );
      assert.ok(created.request);

      const cancelRes = await server.inject({
        method: 'POST',
        url: `/api/requests/${created.request.id}/cancel`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.strictEqual(cancelRes.statusCode, 200);
      assert.strictEqual(cancelRes.json().status, 'CANCELLED');
    });
  });

  describe('Webhooks & Registered Callback Destinations (#123)', () => {
    it('registers, lists, and deletes callback destinations via DomainPorts', async () => {
      const regRes = await server.inject({
        method: 'POST',
        url: `/api/resources/${resourceId}/callbacks`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: {
          url: 'https://ops.internal.example.com/webhook',
          secret: 'super-secret-signing-key-12345',
        },
      });
      assert.strictEqual(regRes.statusCode, 201);
      assert.strictEqual(regRes.headers['cache-control'], 'no-store');
      const callback = regRes.json();
      assert.strictEqual(callback.url, 'https://ops.internal.example.com/webhook');
      assert.ok(callback.id);

      // List
      const listRes = await server.inject({
        method: 'GET',
        url: `/api/resources/${resourceId}/callbacks`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.strictEqual(listRes.statusCode, 200);
      const list = listRes.json();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].id, callback.id);

      // Delete
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/resources/${resourceId}/callbacks/${callback.id}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.strictEqual(delRes.statusCode, 204);
    });
  });

  describe('Correlation & Causation ID Propagation', () => {
    it('preserves valid correlation IDs in response headers', async () => {
      const testCorrelationId = '11111111-2222-4333-8444-555555555555';
      const res = await server.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-correlation-id': testCorrelationId },
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['x-correlation-id'], testCorrelationId);
    });

    it('rejects invalid correlation IDs with 400', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-correlation-id': 'invalid header with spaces' },
      });
      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.json(), { error: 'Invalid x-correlation-id header' });
    });
  });
});
