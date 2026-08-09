import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDiscordPrincipal } from './principal.js';
import { createInMemoryRepositories } from './repositories.mock.js';
import { ApprovalService, createServices, ResourceService } from './services.js';
import { OutboxWorker } from './outbox_worker.js';
import { AuthService } from './auth.js';
import { ProjectService } from './project.js';
import { DomainPortsImpl } from './ports_impl.js';

describe('required current-surface audit coverage', () => {
  it('rejects construction of fail-closed services without audit', () => {
    const repositories = createInMemoryRepositories();
    assert.throws(
      () => new ApprovalService({ repositories } as never),
      /requires an audit dependency/
    );
    assert.throws(
      () => new ResourceService({ repositories } as never),
      /requires an audit dependency/
    );
    assert.throws(
      () =>
        new AuthService(
          repositories.auth,
          repositories.credentials,
          undefined as never,
          repositories.transaction
        ),
      /requires an audit dependency/
    );
    assert.throws(
      () =>
        new ProjectService(
          repositories.projects,
          { createResource: async () => ({ resource: { id: 'resource-1' } }) },
          undefined as never,
          repositories.transaction
        ),
      /requires an audit dependency/
    );
    assert.throws(
      () => new OutboxWorker(repositories, undefined as never),
      /requires an audit dependency/
    );
    const services = createServices({ repositories });
    assert.throws(
      () =>
        new DomainPortsImpl(
          services.project,
          services.resource,
          services.approval,
          undefined as never,
          repositories
        ),
      /requires an audit dependency/
    );
  });

  it('emits every mandatory family from existing authentication and domain operations', async () => {
    const repositories = createInMemoryRepositories();
    const services = createServices({ repositories });

    const flow = await services.auth.initiateDeviceFlow();
    assert.equal(await services.auth.approveSession(flow.userCode, 'owner-1'), true);
    const exchange = await services.auth.exchangeCodeForToken(flow.deviceCode);
    assert.ok(exchange);
    assert.ok(await services.auth.validateToken(exchange.token));

    const project = await services.project.createProject({
      name: 'audit-project',
      ownerId: 'owner-1',
    });
    await services.project.addMember(project.id, 'writer-1', 'WRITER', 'owner-1');
    const environment = await services.project.createEnvironment({
      projectId: project.id,
      name: 'Production',
      slug: 'production',
    });
    assert.ok(environment.resourceId);

    const owner = createDiscordPrincipal('owner-1');
    await services.resource.setSecrets(
      environment.resourceId,
      { DATABASE_PASSWORD: 'must-never-enter-audit' },
      owner
    );
    assert.deepEqual(await services.ports.getSecrets(owner, project.id, environment.id), {
      DATABASE_PASSWORD: 'must-never-enter-audit',
    });

    const totp = await services.resource.createTOTPAccount(
      {
        ownerDiscordUserId: 'owner-1',
        accountName: 'Audit account',
        secret: 'BASE32SECRET3232323232323232',
      },
      owner
    );
    await services.resource.updateTOTPAccount(
      { ...totp, backupKey: 'must-never-enter-audit' },
      owner
    );
    const consent = await services.resource.createTOTPLinkConsent(
      totp.id,
      environment.resourceId,
      'owner-1',
      { allowedOperations: ['totp.code.read'] }
    );
    await services.resource.linkTOTPAccount(environment.resourceId, totp.id, 'owner-1', consent.id);

    const requester = createDiscordPrincipal('requester-1');
    const created = await services.approval.createApprovalRequest({
      resourceId: environment.resourceId,
      principal: requester,
      requesterId: requester.subjectId,
      requesterType: requester.type,
      authKind: requester.authKind,
      action: 'secret.value.read',
    });
    assert.ok(created.request);

    const denied = await services.approval.recordDecision(created.request.id, 'APPROVE', requester);
    assert.equal(denied.success, false);
    const approved = await services.approval.recordDecision(
      created.request.id,
      'APPROVE',
      createDiscordPrincipal('owner-1')
    );
    assert.equal(approved.success, true);
    const grant = await repositories.approvalGrants.findByRequestId(created.request.id);
    assert.ok(grant);
    await services.approval.consumeGrant(
      grant.id,
      requester,
      created.request.action,
      created.request.targetVersion,
      created.request.policyVersion
    );

    const worker = new OutboxWorker(repositories, services.audit);
    await worker.processEvents();

    const scoped = await Promise.all([
      repositories.audit.findByScope({ type: 'PROJECT', id: project.id }),
      repositories.audit.findByScope({ type: 'RESOURCE', id: environment.resourceId }),
      repositories.audit.findByScope({ type: 'REQUEST', id: created.request.id }),
      repositories.audit.findByScope({ type: 'SUBJECT', id: 'owner-1' }),
      repositories.audit.findByScope({ type: 'SUBJECT', id: 'requester-1' }),
      repositories.audit.findByScope({ type: 'SUBJECT', id: 'outbox-worker' }),
    ]);
    const events = [...new Map(scoped.flat().map((event) => [event.id, event])).values()];
    const families = new Set(events.map(({ eventFamily }) => eventFamily));
    const eventTypes = new Set(events.map(({ eventType }) => eventType));

    for (const family of [
      'AUTHENTICATION',
      'PROJECT_MEMBERSHIP',
      'RESOURCE_CONFIGURATION',
      'AUTHORIZATION',
      'SECRET_LIFECYCLE',
      'TOTP_LIFECYCLE',
      'REQUEST_GRANT_LIFECYCLE',
      'DELIVERY',
    ] as const) {
      assert.ok(families.has(family), `missing emitted audit family ${family}`);
    }

    for (const eventType of [
      'CREDENTIAL_USE',
      'PROJECT_CREATE',
      'PROJECT_MEMBER_ADD',
      'ENVIRONMENT_CREATE',
      'RESOURCE_CREATE',
      'AUTHORIZATION_DECISION',
      'SECRET_CREATE',
      'SECRET_REVEAL',
      'TOTP_ACCOUNT_CREATE',
      'TOTP_ACCOUNT_UPDATE',
      'TOTP_LINK',
      'REQUEST_CREATE',
      'GRANT_ISSUE',
      'GRANT_CONSUME',
      'DELIVERY_ENQUEUE',
      'DELIVERY_ATTEMPT',
      'DELIVERY_OUTCOME',
    ]) {
      assert.ok(eventTypes.has(eventType), `missing emitted audit event ${eventType}`);
    }

    assert.equal(
      JSON.stringify(events).includes('must-never-enter-audit'),
      false,
      'secret values must not enter audit envelopes'
    );
    const deliveries = events.filter(({ eventFamily }) => eventFamily === 'DELIVERY');
    assert.ok(deliveries.every(({ correlationId }) => typeof correlationId === 'string'));
    assert.ok(
      deliveries
        .filter(({ eventType }) => eventType !== 'DELIVERY_ENQUEUE')
        .every(({ causationId }) => typeof causationId === 'string')
    );
    assert.ok(
      deliveries
        .filter(({ eventType }) => eventType === 'DELIVERY_ENQUEUE')
        .every(({ causationId, requestId }) => causationId === requestId)
    );
    assert.ok(
      deliveries
        .filter(({ eventType }) => eventType !== 'DELIVERY_ENQUEUE')
        .every(({ causationId, targetId }) => causationId === targetId)
    );
    for (const deliveryId of new Set(deliveries.map(({ targetId }) => targetId))) {
      assert.equal(
        new Set(
          deliveries
            .filter(({ targetId }) => targetId === deliveryId)
            .map(({ correlationId }) => correlationId)
        ).size,
        1,
        `delivery ${deliveryId} must retain one correlation ID from enqueue through outcome`
      );
    }
  });
});
