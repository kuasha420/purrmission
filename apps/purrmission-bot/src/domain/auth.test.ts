import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryRepositories } from './repositories.mock.js';
import { createServices } from './services.js';
import { AccessDeniedError, InvalidGrantError } from './auth.js';

describe('AuthService credential lifecycle', () => {
  test('creates an unpredictable, bounded device flow', async () => {
    const services = createServices({ repositories: createInMemoryRepositories() });
    const flow = await services.auth.initiateDeviceFlow();
    assert.match(flow.deviceCode, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(flow.userCode, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
    assert.equal(flow.expiresIn, 600);
  });

  test('atomically approves and exchanges a session exactly once', async () => {
    const repositories = createInMemoryRepositories();
    const services = createServices({ repositories });
    const flow = await services.auth.initiateDeviceFlow();
    assert.equal(await services.auth.approveSession(flow.userCode, 'user-1'), true);
    const exchange = await services.auth.exchangeCodeForToken(flow.deviceCode);
    assert.ok(exchange);
    assert.match(exchange.token, /^paw_/);
    assert.equal(exchange.apiToken.subjectId, 'user-1');
    assert.deepEqual(exchange.apiToken.scopes, [
      'project.view',
      'environment.view',
      'resource.view',
      'request.create',
    ]);
    assert.deepEqual(
      { type: exchange.apiToken.targetType, id: exchange.apiToken.targetId },
      { type: 'ACCOUNT', id: 'user-1' }
    );
    await assert.rejects(services.auth.exchangeCodeForToken(flow.deviceCode), InvalidGrantError);
    assert.equal((await repositories.credentials.findBySubject('user-1')).length, 1);
  });

  test('validates only matching audience and scope without storing plaintext', async () => {
    const repositories = createInMemoryRepositories();
    const services = createServices({ repositories });
    const flow = await services.auth.initiateDeviceFlow();
    await services.auth.approveSession(flow.userCode, 'user-2');
    const exchange = await services.auth.exchangeCodeForToken(flow.deviceCode);
    assert.ok(exchange);
    const principal = await services.auth.validateToken(exchange.token, {
      audience: 'cli',
      requiredScopes: ['project.view'],
    });
    assert.equal(principal?.subjectId, 'user-2');
    assert.equal(principal?.credentialTarget?.type, 'ACCOUNT');
    assert.notEqual(exchange.apiToken.digest, exchange.token);
    assert.equal(await services.auth.validateToken(exchange.token, { audience: 'service' }), null);
    assert.equal(
      await services.auth.validateToken(exchange.token, { requiredScopes: ['project.delete'] }),
      null
    );
  });

  test('denied sessions never mint credentials', async () => {
    const repositories = createInMemoryRepositories();
    const services = createServices({ repositories });
    const flow = await services.auth.initiateDeviceFlow();
    const session = await repositories.auth.findSessionByDeviceCode(flow.deviceCode);
    assert.ok(session);
    await repositories.auth.updateSessionStatus(session.id, 'DENIED');
    await assert.rejects(services.auth.exchangeCodeForToken(flow.deviceCode), AccessDeniedError);
    assert.equal((await repositories.credentials.findBySubject('user-unknown')).length, 0);
  });

  test('lists redacted metadata and atomically rotates and revokes own credentials', async () => {
    const repositories = createInMemoryRepositories();
    const services = createServices({ repositories });
    const flow = await services.auth.initiateDeviceFlow();
    await services.auth.approveSession(flow.userCode, 'user-3');
    const exchange = await services.auth.exchangeCodeForToken(flow.deviceCode);
    assert.ok(exchange);
    const principal = await services.auth.validateToken(exchange.token);
    assert.ok(principal);

    const inventory = await services.auth.listOwnCredentials(principal);
    assert.equal(inventory.length, 1);
    assert.equal('digest' in inventory[0], false);
    const rotated = await services.auth.rotateOwnCredential(principal, exchange.apiToken.id);
    assert.equal('digest' in rotated.credential, false);
    assert.equal(await services.auth.validateToken(exchange.token), null);
    const rotatedPrincipal = await services.auth.validateToken(rotated.plaintext);
    assert.ok(rotatedPrincipal);

    await services.auth.revokeOwnCredential(rotatedPrincipal, rotated.credential.id);
    assert.equal(await services.auth.validateToken(rotated.plaintext), null);
  });
});
