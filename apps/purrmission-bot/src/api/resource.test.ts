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
import { computeKeyedDigestRecord } from '../domain/crypto.js';

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
    const digest = computeKeyedDigestRecord(validToken, 'PAWTHY_TOKEN');
    await repositories.credentials.create({
      type: 'PAWTHY_TOKEN',
      subjectId: userId,
      name: 'Test Token',
      digest: digest.digest,
      digestKeyId: digest.keyId,
      prefix: 'valid',
      scopes: [
        'resource.view',
        'resource.api-key.list',
        'resource.api-key.mint',
        'resource.api-key.rotate',
        'resource.api-key.revoke',
        'secret.metadata.read',
        'secret.value.read',
        'secret.write',
        'secret.delete',
        'totp.code.read',
        'totp.recovery.read',
        'totp.link.manage',
        'totp.account.manage',
      ],
      audience: 'cli',
      targetType: 'ACCOUNT',
      targetId: userId,
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
      revokedReason: null,
    });

    // Setup Resource
    resourceId = '123e4567-e89b-12d3-a456-426614174000'; // valid UUID
    await repositories.resources.create({
      id: resourceId,
      name: 'Test Resource',
      mode: 'ONE_OF_N',
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

  it('manages Resource credentials without exposing stored digests', async () => {
    const mintedResponse = await server.inject({
      method: 'POST',
      url: `/api/resources/${resourceId}/credentials`,
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { name: 'Deployment key' },
    });
    assert.strictEqual(mintedResponse.statusCode, 201);
    assert.strictEqual(mintedResponse.headers['cache-control'], 'no-store');
    const minted = JSON.parse(mintedResponse.payload);
    assert.match(minted.plaintext, /^pur_/);
    assert.strictEqual('digest' in minted.credential, false);

    const inventoryResponse = await server.inject({
      method: 'GET',
      url: `/api/resources/${resourceId}/credentials`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(inventoryResponse.statusCode, 200);
    const inventory = JSON.parse(inventoryResponse.payload);
    assert.ok(inventory.some(({ id }: { id: string }) => id === minted.credential.id));
    assert.ok(inventory.every((item: Record<string, unknown>) => !('digest' in item)));

    const serviceResponse = await server.inject({
      method: 'POST',
      url: `/api/resources/${resourceId}/service-credentials`,
      headers: { Authorization: `Bearer ${validToken}` },
      payload: {
        serviceName: 'deployment-worker',
        name: 'Deployment worker',
        scopes: ['resource.view', 'request.create'],
      },
    });
    assert.strictEqual(serviceResponse.statusCode, 201);
    assert.strictEqual(serviceResponse.headers['cache-control'], 'no-store');
    const serviceCredential = JSON.parse(serviceResponse.payload);
    assert.strictEqual('digest' in serviceCredential.credential, false);
    const servicePrincipal = await services.auth.validateToken(serviceCredential.plaintext, {
      audience: 'service',
    });
    assert.deepStrictEqual(servicePrincipal?.credentialTarget, {
      type: 'RESOURCE',
      id: resourceId,
    });
    const genericServiceHttpUse = await server.inject({
      method: 'GET',
      url: `/api/resources/${resourceId}/credentials`,
      headers: { Authorization: `Bearer ${serviceCredential.plaintext}` },
    });
    assert.strictEqual(genericServiceHttpUse.statusCode, 401);
    const serviceRotateResponse = await server.inject({
      method: 'POST',
      url: `/api/resources/${resourceId}/credentials/${serviceCredential.credential.id}/rotate`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(serviceRotateResponse.statusCode, 201);
    const rotatedService = JSON.parse(serviceRotateResponse.payload);
    assert.match(rotatedService.plaintext, /^pur_svc_/);
    assert.strictEqual(
      await services.auth.validateToken(serviceCredential.plaintext, { audience: 'service' }),
      null
    );
    assert.ok(await services.auth.validateToken(rotatedService.plaintext, { audience: 'service' }));
    const serviceRevokeResponse = await server.inject({
      method: 'DELETE',
      url: `/api/resources/${resourceId}/credentials/${rotatedService.credential.id}`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(serviceRevokeResponse.statusCode, 204);
    assert.strictEqual(
      await services.auth.validateToken(rotatedService.plaintext, { audience: 'service' }),
      null
    );

    const rotatedResponse = await server.inject({
      method: 'POST',
      url: `/api/resources/${resourceId}/credentials/${minted.credential.id}/rotate`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(rotatedResponse.statusCode, 201);
    assert.strictEqual(rotatedResponse.headers['cache-control'], 'no-store');
    const rotated = JSON.parse(rotatedResponse.payload);
    assert.strictEqual('digest' in rotated.credential, false);
    assert.strictEqual(await services.resource.verifyApiKey(minted.plaintext), null);
    assert.ok(await services.resource.verifyApiKey(rotated.plaintext));

    const revokeResponse = await server.inject({
      method: 'DELETE',
      url: `/api/resources/${resourceId}/credentials/${rotated.credential.id}`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.strictEqual(revokeResponse.statusCode, 204);
    assert.strictEqual(await services.resource.verifyApiKey(rotated.plaintext), null);
  });

  it('creates and consumes custody-bound link consent', async () => {
    // Create TOTP Account
    const account = await repositories.totp.create({
      ownerDiscordUserId: userId,
      accountName: 'Google',
      secret: 'JBSWY3DPEHPK3PXP', // Valid base32
    });

    const consentRes = await server.inject({
      method: 'POST',
      url: `/api/totp/${account.id}/link-consents`,
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { resourceId, initiatingResourceOwnerId: userId, delegationPolicy: {} },
    });
    assert.strictEqual(consentRes.statusCode, 201);
    assert.equal(consentRes.headers['cache-control'], 'no-store');
    const consent = consentRes.json();

    // Link
    const linkRes = await server.inject({
      method: 'POST',
      url: `/api/resources/${resourceId}/2fa/link`,
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { totpAccountId: account.id, consentId: consent.id },
    });
    assert.strictEqual(linkRes.statusCode, 200);
    assert.ok((await repositories.totp.findLinkConsentById(consent.id))?.usedAt);
    assert.equal((await repositories.resources.findById(resourceId))?.totpAccountId, account.id);
    const codeRes = await server.inject({
      method: 'POST',
      url: `/api/resources/${resourceId}/2fa/code`,
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.equal(codeRes.statusCode, 200);
    assert.equal(codeRes.headers['cache-control'], 'no-store');
    assert.match(codeRes.json().code, /^\d{6}$/);
  });

  it('reveals personal code and recovery only through no-store POST routes', async () => {
    const account = await repositories.totp.create({
      ownerDiscordUserId: userId,
      accountName: 'Personal',
      secret: 'JBSWY3DPEHPK3PXP',
      backupKey: 'RECOVERY-ONLY-OWNER',
    });
    for (const suffix of ['code', 'recovery']) {
      const response = await server.inject({
        method: 'POST',
        url: `/api/totp/${account.id}/${suffix}`,
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
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

    assert.strictEqual(await services.resource.hasLinkedTOTP(resourceId), false);
  });

  it('should deny access if the authenticated user has no Resource role', async () => {
    // Create another resource where the user is NOT a guardian
    const otherResourceId = '222e4567-e89b-12d3-a456-426614174000';
    await repositories.resources.create({
      id: otherResourceId,
      name: 'Other Resource',
      mode: 'ONE_OF_N',
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
    const guardianDigest = computeKeyedDigestRecord(guardianToken, 'PAWTHY_TOKEN');
    await repositories.credentials.create({
      type: 'PAWTHY_TOKEN',
      subjectId: guardianId,
      name: 'Guardian negative-path token',
      digest: guardianDigest.digest,
      digestKeyId: guardianDigest.keyId,
      prefix: guardianToken.slice(0, 8),
      scopes: [
        'secret.metadata.read',
        'secret.value.read',
        'secret.write',
        'secret.delete',
        'totp.link.manage',
      ],
      audience: 'cli',
      targetType: 'ACCOUNT',
      targetId: guardianId,
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
      revokedReason: null,
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
