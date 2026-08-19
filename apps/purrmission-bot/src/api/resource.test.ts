import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createHttpServer } from '../http/server.js';
import { createServices } from '../domain/services.js';
import { createInMemoryRepositories } from '../domain/repositories.mock.js';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../domain/services.js';
import type { Repositories } from '../domain/repositories.js';
import type { Client } from 'discord.js';
import { createDiscordPrincipal } from '../domain/principal.js';
import { computeKeyedDigest } from '../domain/crypto.js';

// Mock Discord Client (minimal)
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

describe('Resource API', () => {
  let server: FastifyInstance;
  let services: Services;
  let repositories: Repositories;
  const validToken = 'valid-token';
  const userId = 'user-123';
  let resourceId: string;

  beforeEach(async () => {
    repositories = createInMemoryRepositories();
    services = createServices({ repositories });

    // Setup Auth
    await repositories.credentials.create({
      type: 'PAWTHY_TOKEN',
      subjectId: userId,
      name: 'Test Token',
      digest: computeKeyedDigest(validToken, 'PAWTHY_TOKEN'),
      prefix: 'valid',
      scopes:
        'resource.view,secret.metadata.read,secret.value.read,secret.write,secret.delete,totp.code.read,totp.link.manage',
      audience: 'api',
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
    });

    // Setup Resource
    resourceId = '123e4567-e89b-12d3-a456-426614174000'; // valid UUID
    await repositories.resources.create({
      id: resourceId,
      name: 'Test Resource',
      mode: 'ONE_OF_N',
      apiKey: 'api-key-1',
    });

    // Setup Guardian (Owner)
    await repositories.guardians.add({
      id: 'g-' + userId,
      resourceId,
      discordUserId: userId,
      role: 'OWNER',
    });

    server = createHttpServer({
      services,
      discordClient: mockDiscordClient as Client,
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('should create and retrieve a field', async () => {
    // Create
    const createRes = await server.inject({
      method: 'POST',
      url: `/api/resources/${resourceId}/fields`,
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { name: 'DB_PASS', value: 'secret123' },
    });
    assert.strictEqual(createRes.statusCode, 201);
    const field = JSON.parse(createRes.payload);
    assert.strictEqual(field.name, 'DB_PASS');

    // Get Value
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/resources/${resourceId}/fields/DB_PASS`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(getRes.statusCode, 200);
    const getBody = JSON.parse(getRes.payload);
    assert.strictEqual(getBody.value, 'secret123');
  });

  it('should list fields', async () => {
    await services.resource.createField(resourceId, 'F1', 'V1', createDiscordPrincipal(userId));
    await services.resource.createField(resourceId, 'F2', 'V2', createDiscordPrincipal(userId));

    const listRes = await server.inject({
      method: 'GET',
      url: `/api/resources/${resourceId}/fields`,
      headers: { Authorization: `Bearer ${validToken}` },
    });

    assert.strictEqual(listRes.statusCode, 200);
    const names = JSON.parse(listRes.payload);
    assert.ok(Array.isArray(names));
    assert.strictEqual(names.length, 2);
    assert.ok(names.includes('F1'));
    assert.ok(names.includes('F2'));
  });

  it('should delete a field', async () => {
    await services.resource.createField(
      resourceId,
      'DEL_ME',
      'VAL',
      createDiscordPrincipal(userId)
    );

    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/resources/${resourceId}/fields/DEL_ME`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(delRes.statusCode, 204);

    const check = await services.resource.getField(resourceId, 'DEL_ME');
    assert.strictEqual(check, null);
  });

  it('should fail closed for provisional 2FA linking', async () => {
    // Create TOTP Account
    const account = await repositories.totp.create({
      ownerDiscordUserId: userId,
      accountName: 'Google',
      secret: 'JBSWY3DPEHPK3PXP', // Valid base32
    });

    const consent = await repositories.totp.createLinkConsent({
      accountId: account.id,
      resourceId,
      ownerDiscordUserId: userId,
      delegationPolicy: {},
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Link
    const linkRes = await server.inject({
      method: 'POST',
      url: `/api/resources/${resourceId}/2fa/link`,
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { totpAccountId: account.id, consentId: consent.id },
    });
    assert.strictEqual(linkRes.statusCode, 403);
    assert.equal((await repositories.totp.findLinkConsentById(consent.id))?.usedAt, null);
    assert.equal((await repositories.resources.findById(resourceId))?.totpAccountId, undefined);
  });

  it('should unlink 2FA', async () => {
    // Setup linked account
    const account = await repositories.totp.create({
      ownerDiscordUserId: userId,
      accountName: 'Google',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    await repositories.resources.update(resourceId, {
      totpAccountId: account.id,
      version: 'existing-link-v1',
    });

    // Unlink
    const unlinkRes = await server.inject({
      method: 'DELETE',
      url: `/api/resources/${resourceId}/2fa/link`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(unlinkRes.statusCode, 204);

    const check = await services.resource.getLinkedTOTPAccount(resourceId);
    assert.strictEqual(check, null);
  });

  it('should deny access if the authenticated user has no Resource role', async () => {
    // Create another resource where the user is NOT a guardian
    const otherResourceId = '222e4567-e89b-12d3-a456-426614174000';
    await repositories.resources.create({
      id: otherResourceId,
      name: 'Other Resource',
      mode: 'ONE_OF_N',
      apiKey: 'api-key-2',
    });

    const listRes = await server.inject({
      method: 'GET',
      url: `/api/resources/${otherResourceId}/fields`,
      headers: { Authorization: `Bearer ${validToken}` },
    });

    assert.strictEqual(listRes.statusCode, 403);
  });

  it('should deny an explicit Guardian every direct secret field operation', async () => {
    const guardianId = 'guardian-456';
    const guardianToken = 'guardian-token-with-secret-scopes';

    await repositories.guardians.add({
      id: `g-${guardianId}`,
      resourceId,
      discordUserId: guardianId,
      role: 'GUARDIAN',
    });
    await repositories.credentials.create({
      type: 'PAWTHY_TOKEN',
      subjectId: guardianId,
      name: 'Guardian negative-path token',
      digest: computeKeyedDigest(guardianToken, 'PAWTHY_TOKEN'),
      prefix: guardianToken.slice(0, 8),
      scopes: [
        'secret.metadata.read',
        'secret.value.read',
        'secret.write',
        'secret.delete',
        'totp.link.manage',
      ].join(','),
      audience: 'cli',
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
    });
    await services.resource.createField(
      resourceId,
      'EXISTING',
      'owner-created',
      createDiscordPrincipal(userId)
    );
    const custodyOwnedTotp = await repositories.totp.create({
      ownerDiscordUserId: 'separate-custody-owner',
      accountName: 'Custody-owned account',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    await repositories.resources.update(resourceId, { totpAccountId: custodyOwnedTotp.id });

    const requests = [
      server.inject({
        method: 'GET',
        url: `/api/resources/${resourceId}/fields`,
        headers: { Authorization: `Bearer ${guardianToken}` },
      }),
      server.inject({
        method: 'POST',
        url: `/api/resources/${resourceId}/fields`,
        headers: { Authorization: `Bearer ${guardianToken}` },
        payload: { name: 'CREATED_BY_GUARDIAN', value: 'must-not-write' },
      }),
      server.inject({
        method: 'GET',
        url: `/api/resources/${resourceId}/fields/EXISTING`,
        headers: { Authorization: `Bearer ${guardianToken}` },
      }),
      server.inject({
        method: 'DELETE',
        url: `/api/resources/${resourceId}/fields/EXISTING`,
        headers: { Authorization: `Bearer ${guardianToken}` },
      }),
      server.inject({
        method: 'POST',
        url: `/api/resources/${resourceId}/2fa/link`,
        headers: { Authorization: `Bearer ${guardianToken}` },
        payload: {
          totpAccountId: custodyOwnedTotp.id,
          consentId: '123e4567-e89b-12d3-a456-426614174099',
        },
      }),
      server.inject({
        method: 'DELETE',
        url: `/api/resources/${resourceId}/2fa/link`,
        headers: { Authorization: `Bearer ${guardianToken}` },
      }),
    ];

    const responses = await Promise.all(requests);
    assert.deepStrictEqual(
      responses.map((response) => response.statusCode),
      [403, 403, 403, 403, 403, 403]
    );
    assert.strictEqual(
      await repositories.resourceFields.findByResourceAndName(resourceId, 'CREATED_BY_GUARDIAN'),
      null
    );
    assert.ok(
      await repositories.resourceFields.findByResourceAndName(resourceId, 'EXISTING'),
      'Guardian delete attempt must not remove the field'
    );
  });
});
