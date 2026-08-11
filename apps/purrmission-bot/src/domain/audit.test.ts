import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AuditSecurityConfig } from '../config/auditSecurity.js';
import { createDiscordPrincipal } from './principal.js';
import {
  AuditService,
  AUDIT_EVENT_CATALOG,
  buildOutboxEvent,
  buildAuditPayload,
  verifyOutboxIntegrity,
  type AuditEventInput,
} from './audit.js';
import { createInMemoryRepositories, InMemoryAuditRepository } from './repositories.mock.js';
import type { AuditRepository } from './repositories.js';

const config: AuditSecurityConfig = {
  auditIntegrityKey: Buffer.alloc(32, 0x11),
  auditIntegrityKeyId: 'audit-test-v1',
  outboxIntegrityKey: Buffer.alloc(32, 0x22),
  outboxIntegrityKeyId: 'outbox-test-v1',
  retentionDays: 30,
  checkpointInterval: 10,
};

function event(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    eventFamily: 'AUTHORIZATION' as const,
    eventType: 'AUTHORIZATION_DECISION',
    surface: 'HTTP' as const,
    operation: 'resource.read',
    outcomeCode: 'SUCCESS' as const,
    capability: 'resource.view' as const,
    decisionCode: 'ALLOW' as const,
    reasonCode: 'OWNER' as const,
    authoritySources: ['RESOURCE_OWNER'],
    targetType: 'RESOURCE' as const,
    targetId: 'resource-1',
    actorType: 'DISCORD_USER' as const,
    principalId: 'session-1',
    actorId: 'user-1',
    authKind: 'DISCORD' as const,
    resourceId: 'resource-1',
    payload: { route: '/api/resources/:id' },
    ...overrides,
  };
}

describe('AuditService', () => {
  it('defines every required current-surface event family', () => {
    assert.deepEqual(
      new Set(Object.values(AUDIT_EVENT_CATALOG)),
      new Set([
        'AUTHENTICATION',
        'PROJECT_MEMBERSHIP',
        'RESOURCE_CONFIGURATION',
        'AUTHORIZATION',
        'SECRET_LIFECYCLE',
        'TOTP_LIFECYCLE',
        'REQUEST_GRANT_LIFECYCLE',
        'DELIVERY',
        'AUDIT_ACCESS',
      ])
    );
  });

  it('persists a complete versioned envelope and verifies its integrity', async () => {
    const repositories = createInMemoryRepositories();
    const service = new AuditService({ repositories }, config);

    const created = await service.log(event());

    assert.equal(created.schemaVersion, 2);
    assert.equal(created.eventFamily, 'AUTHORIZATION');
    assert.equal(created.surface, 'HTTP');
    assert.equal(created.operation, 'resource.read');
    assert.equal(created.targetId, 'resource-1');
    assert.deepEqual(created.authoritySources, ['RESOURCE_OWNER']);
    assert.equal(created.integrityKeyId, 'audit-test-v1');
    assert.match(created.integrityHash, /^[0-9a-f]{64}$/);
    assert.equal(service.verifyIntegrity(created), true);
    assert.equal(service.verifyIntegrity({ ...created, operation: 'tampered' }), false);
    assert.equal(service.verifyIntegrity({ ...created, id: 'tampered-id' }), false);
    assert.equal(
      service.verifyIntegrity({ ...created, createdAt: new Date(created.createdAt.getTime() + 1) }),
      false
    );
  });

  it('rejects an event registered under the wrong family', async () => {
    const repositories = createInMemoryRepositories();
    const service = new AuditService({ repositories }, config);
    await assert.rejects(service.log(event({ eventFamily: 'DELIVERY' })), /family does not match/);
  });

  it('validates correlation and causation at primitive boundaries', async () => {
    const service = new AuditService({ repositories: createInMemoryRepositories() }, config);
    await assert.rejects(
      service.log(event({ correlationId: 'unsafe correlation' })),
      /Correlation ID/
    );
    assert.throws(
      () =>
        buildOutboxEvent(
          {
            eventType: 'REQUEST_CREATED',
            causationId: 'unsafe cause',
            payload: { requestId: 'r', resourceId: 'x' },
          },
          config
        ),
      /Correlation ID/
    );
  });

  it('does not invent unrelated causation IDs for root events', async () => {
    const repositories = createInMemoryRepositories();
    const service = new AuditService({ repositories }, config);
    const first = await service.log(event({ correlationId: 'operation-1' }));
    const second = await service.log(event({ correlationId: 'operation-1' }));
    assert.equal(first.causationId, null);
    assert.equal(second.causationId, null);
  });

  it('constructs only registered scalar payloads and rejects adversarial fields', () => {
    assert.deepEqual(buildAuditPayload('SECRET_REVEAL', { fieldName: 'production' }), {
      fieldName: 'production',
    });
    for (const payload of [
      { plaintext: 'raw' },
      { rawToken: 'raw' },
      { totpSecret: 'raw' },
      { 'set-cookie': 'raw' },
      { reason: { unknownNested: 'raw' } },
    ]) {
      assert.throws(
        () => buildAuditPayload('SECRET_REVEAL', payload as never),
        /not registered|safe scalar/
      );
    }
    assert.throws(
      () =>
        buildOutboxEvent(
          { eventType: 'REQUEST_CREATED', payload: { requestId: 'req-1', rawToken: 'raw' } },
          config
        ),
      /not registered/
    );
    const outbox = buildOutboxEvent(
      { eventType: 'REQUEST_CREATED', payload: { requestId: 'req-1', resourceId: 'res-1' } },
      config
    );
    assert.deepEqual(outbox.payload, { requestId: 'req-1', resourceId: 'res-1' });
    assert.match(outbox.integrityHash, /^[0-9a-f]{64}$/);
    assert.equal(
      verifyOutboxIntegrity(
        {
          ...outbox,
          status: 'PENDING',
          attempts: 0,
          updatedAt: new Date(),
        },
        config
      ),
      true
    );
  });

  it('fails closed and emits only a redacted persistence-failure envelope', async () => {
    let createCalls = 0;
    const brokenAudit = {
      create: async () => {
        createCalls += 1;
        throw new Error('database rejected raw-secret-value');
      },
    } as unknown as AuditRepository;
    const repositories = { ...createInMemoryRepositories(), audit: brokenAudit };
    const service = new AuditService({ repositories }, config);
    const captured: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => captured.push(args.join(' '));
    try {
      await assert.rejects(
        service.log(event({ payload: { route: '/safe' } })),
        /database rejected raw-secret-value/
      );
    } finally {
      console.error = original;
    }
    assert.equal(
      captured.some((line) => line.includes('raw-secret-value')),
      false
    );
    assert.equal(createCalls, 1);
  });

  it('enforces same-object read plus export authority and audits authorized access', async () => {
    const repositories = createInMemoryRepositories();
    const project = await repositories.projects.createProject({ name: 'p', ownerId: 'owner-1' });
    await repositories.projects.addMember({
      projectId: project.id,
      userId: 'writer-1',
      role: 'WRITER',
      addedBy: 'owner-1',
    });
    const service = new AuditService({ repositories }, config);
    await service.log(
      event({
        projectId: project.id,
        resourceId: null,
        targetType: 'PROJECT',
        targetId: project.id,
      })
    );
    await service.log(
      event({
        eventFamily: 'AUTHENTICATION',
        eventType: 'CREDENTIAL_USE',
        payload: {},
        projectId: project.id,
        resourceId: null,
        targetType: 'CREDENTIAL',
        targetId: 'credential-1',
      })
    );

    const writer = createDiscordPrincipal('writer-1');
    const operational = await service.read(writer, {
      scope: { type: 'PROJECT', id: project.id },
      projection: 'OPERATIONAL',
      export: false,
    });
    assert.equal(operational.length, 1);
    assert.equal(operational[0].eventType, 'AUTHORIZATION_DECISION');
    await assert.rejects(
      service.read(writer, {
        scope: { type: 'PROJECT', id: project.id },
        projection: 'OPERATIONAL',
        export: true,
      }),
      /export is not authorized/
    );
    const afterDeniedExport = await repositories.audit.findByScope({
      type: 'PROJECT',
      id: project.id,
    });
    assert.ok(
      afterDeniedExport.some(
        ({ eventType, outcomeCode }) => eventType === 'AUDIT_EXPORT' && outcomeCode === 'DENIED'
      )
    );

    const owner = createDiscordPrincipal('owner-1');
    const exported = await service.read(owner, {
      scope: { type: 'PROJECT', id: project.id },
      projection: 'FULL',
      export: true,
    });
    assert.ok(exported.length >= 2);

    await assert.rejects(
      service.read(owner, {
        scope: { type: 'PROJECT', id: 'another-project' },
        projection: 'FULL',
        export: true,
      }),
      /not authorized/
    );
  });

  it('exposes configured retention and checkpoint behavior', () => {
    const repositories = {
      ...createInMemoryRepositories(),
      audit: new InMemoryAuditRepository(),
    };
    const service = new AuditService({ repositories }, config);
    assert.equal(
      service.getRetentionCutoff(new Date('2026-08-01T00:00:00.000Z')).toISOString(),
      '2026-07-02T00:00:00.000Z'
    );
    assert.equal(service.shouldCheckpoint(9), false);
    assert.equal(service.shouldCheckpoint(10), true);
  });

  it('persists and verifies a durable checkpoint and historical key rotation', async () => {
    const repositories = createInMemoryRepositories();
    const oldService = new AuditService({ repositories }, config);
    const created = await oldService.log(event());
    const checkpoint = await oldService.createCheckpoint();
    assert.ok(checkpoint);
    assert.equal(oldService.verifyCheckpointSink(checkpoint), true);

    const rotated: AuditSecurityConfig = {
      ...config,
      auditIntegrityKey: Buffer.alloc(32, 0x33),
      auditIntegrityKeyId: 'audit-test-v2',
      auditIntegrityKeys: new Map([
        [config.auditIntegrityKeyId, config.auditIntegrityKey],
        ['audit-test-v2', Buffer.alloc(32, 0x33)],
      ]),
    };
    const rotatedService = new AuditService({ repositories }, rotated);
    assert.equal(rotatedService.verifyIntegrity(created), true);
    assert.equal(rotatedService.verifyCheckpointSink(checkpoint), true);
    assert.equal(
      rotatedService.verifyIntegrity({ ...created, integrityKeyId: 'legacy-unverified' }),
      false
    );
  });

  it('refuses to extend a tampered durable checkpoint chain', async () => {
    const repositories = createInMemoryRepositories();
    const service = new AuditService({ repositories }, config);
    await service.log(event());
    const checkpoint = await service.createCheckpoint();
    assert.ok(checkpoint);
    checkpoint.checkpointHash = '0'.repeat(64);
    await assert.rejects(
      service.createCheckpoint(),
      /Cannot extend an unverifiable audit checkpoint chain/
    );
  });

  it('operationally checkpoints at cadence and deletes only eligible retention classes', async () => {
    const repositories = createInMemoryRepositories();
    const service = new AuditService({ repositories }, config);
    for (let index = 0; index < 10; index += 1) {
      await service.log(event({ targetId: `resource-${index}` }));
    }
    assert.deepEqual(await service.runMaintenance(), { checkpointed: true, deleted: 0 });
    assert.deepEqual(await service.runMaintenance(), { checkpointed: false, deleted: 0 });

    await service.log(event({ retentionClass: 'OPERATIONAL' }));
    await service.log(event({ retentionClass: 'PRIVACY' }));
    await service.log(event({ retentionClass: 'SECURITY' }));
    const future = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    assert.equal(await service.executeRetention(future), 2);
    const findThrough = repositories.audit.findThrough;
    assert.ok(findThrough);
    const retained = await findThrough.call(repositories.audit, future);
    assert.equal(retained.filter(({ retentionClass }) => retentionClass === 'SECURITY').length, 11);
    assert.equal(
      retained.some(({ retentionClass }) => retentionClass === 'OPERATIONAL'),
      false
    );
    assert.equal(
      retained.some(({ retentionClass }) => retentionClass === 'PRIVACY'),
      false
    );
  });

  it('checkpoints, pseudonymizes, re-signs, and audits privacy transformations', async () => {
    const repositories = createInMemoryRepositories();
    const service = new AuditService({ repositories }, config);
    await service.log(
      event({
        actorId: 'privacy-user',
        resolverId: 'privacy-user',
        targetType: 'SUBJECT',
        targetId: 'privacy-user',
        payload: { reason: 'privacy-user' },
      })
    );
    assert.equal(await service.pseudonymizeSubject('privacy-user'), 1);
    assert.equal(
      (await repositories.audit.findByScope({ type: 'SUBJECT', id: 'privacy-user' })).length,
      0
    );
    const findThrough = repositories.audit.findThrough;
    assert.ok(findThrough);
    const transformed = await findThrough.call(repositories.audit, new Date(Date.now() + 1000));
    assert.equal(JSON.stringify(transformed).includes('privacy-user'), false);
    assert.ok(transformed.every((entry) => service.verifyIntegrity(entry)));
    assert.ok(transformed.some(({ eventType }) => eventType === 'PRIVACY_PSEUDONYMIZE'));
  });
});
