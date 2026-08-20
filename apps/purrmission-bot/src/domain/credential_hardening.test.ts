import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  KeyManager,
  computeKeyedDigest,
  computeKeyedDigestRecord,
  verifyKeyedDigest,
} from './crypto.js';
import { createInMemoryRepositories } from './repositories.mock.js';
import { createServices } from './services.js';
import { AuthService, InvalidGrantError, SlowDownError } from './auth.js';
import { hasCapability } from './policy.js';
import { rateLimiter } from '../infra/rateLimit.js';
import { AuditService } from './audit.js';

describe('Credential Lifecycle Hardening', () => {
  beforeEach(() => {
    // Reset process.env for clean isolation
    delete process.env.CREDENTIAL_HMAC_KEYS;
    delete process.env.CREDENTIAL_HMAC_KEYS_JSON;
    delete process.env.CREDENTIAL_HMAC_ACTIVE_KEY_ID;
  });

  describe('Cryptographic Purpose Separation and Rotation', () => {
    test('should derive different keys for different purposes', () => {
      process.env.CREDENTIAL_HMAC_KEYS = 'test-secret-1';

      const keyApi = KeyManager.getActiveKey('RESOURCE_API_KEY');
      const keyToken = KeyManager.getActiveKey('PAWTHY_TOKEN');

      assert.notStrictEqual(keyApi, keyToken);
      assert.strictEqual(keyApi.length, 64);
    });

    test('should support key rotation matching older keys in list', () => {
      const plaintext = 'pur_test_key_123';
      const purpose = 'RESOURCE_API_KEY';

      // 1. Initial configuration with single secret
      process.env.CREDENTIAL_HMAC_KEYS = 'secret-old';
      const originalDigest = computeKeyedDigest(plaintext, purpose);

      // 2. Rotate keys (prepend new key)
      process.env.CREDENTIAL_HMAC_KEYS = 'secret-new, secret-old';
      const rotatedDigest = computeKeyedDigest(plaintext, purpose);

      assert.notStrictEqual(originalDigest, rotatedDigest);

      // 3. Verification should succeed for digests signed with either key
      assert.ok(verifyKeyedDigest(plaintext, originalDigest, purpose));
      assert.ok(verifyKeyedDigest(plaintext, rotatedDigest, purpose));

      // Should fail for invalid/unknown keys
      assert.ok(!verifyKeyedDigest(plaintext, 'wrong-digest', purpose));
    });

    test('rekeys a credential after successful validation with a historical stable key ID', async () => {
      const plaintext = 'paw_historical_token';
      process.env.CREDENTIAL_HMAC_KEYS_JSON = JSON.stringify({
        old: 'o'.repeat(32),
      });
      process.env.CREDENTIAL_HMAC_ACTIVE_KEY_ID = 'old';
      const oldDigest = computeKeyedDigestRecord(plaintext, 'PAWTHY_TOKEN');
      const repos = createInMemoryRepositories();
      const credential = await repos.credentials.create({
        type: 'PAWTHY_TOKEN',
        subjectId: 'user-rotation',
        name: 'Historical',
        digest: oldDigest.digest,
        digestKeyId: oldDigest.keyId,
        prefix: 'paw_historic',
        scopes: ['project.view'],
        audience: 'cli',
        targetType: 'ACCOUNT',
        targetId: 'user-rotation',
        expiresAt: null,
        revokedAt: null,
        revokedReason: null,
      });

      process.env.CREDENTIAL_HMAC_KEYS_JSON = JSON.stringify({
        current: 'n'.repeat(32),
        old: 'o'.repeat(32),
      });
      process.env.CREDENTIAL_HMAC_ACTIVE_KEY_ID = 'current';
      const services = createServices({ repositories: repos });
      assert.ok(await services.auth.validateToken(plaintext));
      assert.strictEqual((await repos.credentials.findById(credential.id))?.digestKeyId, 'current');
    });
  });

  describe('Resource API Key Dual-Read and Lifecycle', () => {
    test('should mint, list, and verify api keys', async () => {
      const repos = createInMemoryRepositories();
      const services = createServices({ repositories: repos });

      // Setup resource
      const resource = await repos.resources.create({
        name: 'Production Resource',
        mode: 'ONE_OF_N',
        version: 'v1',
      });

      // 1. Dual-read fallback: check legacy plaintext key fails closed (R8A/R8D cleanup)
      const foundLegacy = await services.resource.verifyApiKey('legacy_plain_key');
      assert.strictEqual(foundLegacy, null);

      // 2. Mint new hardened API key
      const ownerId = 'user-owner';
      // Mock guardian relation so owner can manage keys
      await repos.guardians.add({
        id: 'owner-g-id',
        resourceId: resource.id,
        discordUserId: ownerId,
        role: 'OWNER',
      });

      const { plaintext, credential } = await services.resource.mintApiKey(
        resource.id,
        { type: 'DISCORD_USER', id: `discord:${ownerId}`, subjectId: ownerId, authKind: 'DISCORD' },
        'Prod CLI Key'
      );

      assert.ok(plaintext.startsWith('pur_'));
      assert.strictEqual(credential.type, 'RESOURCE_API_KEY');
      assert.strictEqual(credential.subjectId, resource.id);
      assert.strictEqual(credential.targetType, 'RESOURCE');
      assert.strictEqual(credential.targetId, resource.id);

      // 3. Verify lookup works with the new hardened key
      const foundHardened = await services.resource.verifyApiKey(plaintext);
      assert.ok(foundHardened);
      assert.strictEqual(foundHardened.resource.id, resource.id);

      const ownerPrincipal = {
        type: 'DISCORD_USER' as const,
        id: `discord:${ownerId}`,
        subjectId: ownerId,
        authKind: 'DISCORD' as const,
      };
      const rotated = await services.resource.rotateApiKey(
        resource.id,
        credential.id,
        ownerPrincipal
      );
      assert.strictEqual(await services.resource.verifyApiKey(plaintext), null);
      assert.ok(await services.resource.verifyApiKey(rotated.plaintext));

      // 4. Revocation should prevent validation
      await services.resource.revokeApiKey(resource.id, rotated.credential.id, ownerPrincipal);

      const foundAfterRevocation = await services.resource.verifyApiKey(rotated.plaintext);
      assert.strictEqual(foundAfterRevocation, null);
    });

    test('should throttle repeated Resource credential failures by caller', async () => {
      const repos = createInMemoryRepositories();
      const services = createServices({ repositories: repos });
      const resource = await repos.resources.create({
        name: 'Rate-limited Resource',
        mode: 'ONE_OF_N',
        version: 'v1',
      });
      const ownerId = 'rate-limit-owner';
      const ownerPrincipal = {
        type: 'DISCORD_USER' as const,
        id: `discord:${ownerId}`,
        subjectId: ownerId,
        authKind: 'DISCORD' as const,
      };
      await repos.guardians.add({
        id: 'rate-limit-owner-assignment',
        resourceId: resource.id,
        discordUserId: ownerId,
        role: 'OWNER',
      });
      const valid = await services.resource.mintApiKey(
        resource.id,
        ownerPrincipal,
        'rate-limit-proof'
      );
      const caller = '198.51.100.121';

      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.strictEqual(
          await services.resource.verifyApiKey(`invalid-${attempt}`, caller),
          null
        );
      }

      assert.strictEqual(await services.resource.verifyApiKey(valid.plaintext, caller), null);
      assert.ok(await services.resource.verifyApiKey(valid.plaintext, '198.51.100.122'));
    });
  });

  describe('Atomic OAuth Token Exchange and Rate Limiting', () => {
    test('should exchange code atomically and fail concurrent race exchanges', async () => {
      const repos = createInMemoryRepositories();
      const authService = new AuthService(
        repos.auth,
        repos.credentials,
        new AuditService({ repositories: repos }),
        repos.transaction
      );

      // Initiate flow
      const flow = await authService.initiateDeviceFlow();
      assert.ok(flow.deviceCode);

      // Approve flow
      const approved = await authService.approveSession(flow.userCode, 'user-123');
      assert.ok(approved);

      // Force rate limiter refills for testing token exchange
      rateLimiter.check(`token-poll:${flow.deviceCode}`); // consume to establish bucket

      // Atomically exchange code
      const result = await authService.exchangeCodeForToken(flow.deviceCode);
      assert.ok(result);
      assert.ok(result.token.startsWith('paw_'));

      // Concurrent exchange should fail (session transitioned to CONSUMED)
      await assert.rejects(authService.exchangeCodeForToken(flow.deviceCode), InvalidGrantError);
    });

    test('should enforce token poll rate limiting slow-down', async () => {
      const repos = createInMemoryRepositories();
      const authService = new AuthService(
        repos.auth,
        repos.credentials,
        new AuditService({ repositories: repos }),
        repos.transaction
      );

      const flow = await authService.initiateDeviceFlow();

      // Exhaust rate limiter token bucket for this device code (10 requests window)
      for (let i = 0; i < 10; i++) {
        rateLimiter.check(`token-poll:${flow.deviceCode}`);
      }

      // 11th request must throw SlowDownError
      await assert.rejects(authService.exchangeCodeForToken(flow.deviceCode), SlowDownError);
    });
  });

  describe('Scoped Service Principals and Double-Gated Scopes', () => {
    test('should fail closed for unbound service principal object scopes', async () => {
      const repos = createInMemoryRepositories();
      const authService = new AuthService(
        repos.auth,
        repos.credentials,
        new AuditService({ repositories: repos }),
        repos.transaction
      );

      const resourceOwner = 'resource-owner';
      const resource = await repos.resources.create({ name: 'Service target', mode: 'ONE_OF_N' });
      await repos.guardians.add({
        id: 'service-target-owner',
        resourceId: resource.id,
        discordUserId: resourceOwner,
        role: 'OWNER',
      });
      const { plaintext, credential } = await createServices({
        repositories: repos,
      }).resource.mintServiceCredential(
        resource.id,
        {
          type: 'DISCORD_USER',
          id: `discord:${resourceOwner}`,
          subjectId: resourceOwner,
          authKind: 'DISCORD',
        },
        'github-actions-ci',
        'CI Deployment Pipeline',
        ['resource.view']
      );

      assert.ok(plaintext.startsWith('pur_svc_'));
      assert.strictEqual(credential.type, 'SERVICE_CREDENTIAL');

      // Validate token to build Principal
      const principal = await authService.validateToken(plaintext);
      assert.ok(principal);
      assert.strictEqual(principal.type, 'SERVICE');
      assert.strictEqual(principal.authKind, 'SERVICE');
      assert.deepStrictEqual(principal.scopes, ['resource.view']);
      assert.deepStrictEqual(principal.credentialTarget, {
        type: 'RESOURCE',
        id: resource.id,
      });

      const evalView = await hasCapability(repos, principal, 'resource.view', {
        resourceId: 'not-the-target',
      });
      assert.strictEqual(evalView.allowed, false);
      assert.strictEqual(evalView.reasonCode, 'TARGET_SCOPE_MISMATCH');

      const boundView = await hasCapability(repos, principal, 'resource.view', {
        resourceId: resource.id,
      });
      assert.strictEqual(boundView.allowed, true);
      assert.strictEqual(boundView.reasonCode, 'SERVICE');

      // Denied scope
      const evalDelete = await hasCapability(repos, principal, 'resource.delete', {
        resourceId: resource.id,
      });
      assert.strictEqual(evalDelete.allowed, false);
      assert.strictEqual(evalDelete.reasonCode, 'INSUFFICIENT_SCOPES');
    });

    test('should dual-gate user tokens with both capability roles and scopes', async () => {
      const repos = createInMemoryRepositories();
      const authService = new AuthService(
        repos.auth,
        repos.credentials,
        new AuditService({ repositories: repos }),
        repos.transaction
      );

      // 1. Mint user token with narrow scope: ['project.view'] (lacks project.delete)
      const flow = await authService.initiateDeviceFlow();
      await authService.approveSession(flow.userCode, 'user-owner');
      const result = await authService.exchangeCodeForToken(flow.deviceCode);
      assert.ok(result);

      // Retrieve principal
      const principal = await authService.validateToken(result.token);
      assert.ok(principal);

      // Setup project
      const project = await repos.projects.createProject({
        name: 'Owner Project',
        ownerId: 'user-owner', // Principal actor is the owner
      });

      // Verify owner can view project (authorized by both role and default scopes)
      const evalView = await hasCapability(repos, principal, 'project.view', {
        projectId: project.id,
      });
      assert.strictEqual(evalView.allowed, true);

      // Verify owner is denied project.delete if scope is explicitly changed to exclude it
      // Let's manually verify scopes checking logic:
      principal.scopes = ['project.view'];
      const evalDelete = await hasCapability(repos, principal, 'project.delete', {
        projectId: project.id,
      });
      assert.strictEqual(evalDelete.allowed, false);
      assert.strictEqual(evalDelete.reasonCode, 'INSUFFICIENT_SCOPES');
    });
  });
});
