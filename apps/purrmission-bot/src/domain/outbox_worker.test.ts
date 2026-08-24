import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Client } from 'discord.js';
import { createInMemoryRepositories, InMemoryOutboxRepository } from './repositories.mock.js';
import type { Repositories } from './repositories.js';
import { AuditService, buildOutboxEvent } from './audit.js';
import { OutboxWorker } from './outbox_worker.js';
import { createServices, Services } from './services.js';
import { createDiscordPrincipal } from './principal.js';
import { SSRFSafeWebhookClient } from './webhook.js';
import { DomainAuthorizationError, ValidationError } from './errors.js';
import type { OutboxEvent } from './models.js';

describe('OutboxWorker & Callback State Machine', () => {
  let repos: Repositories;
  let auditService: AuditService;
  let services: Services;

  beforeEach(() => {
    repos = createInMemoryRepositories();
    auditService = new AuditService({ repositories: repos });
    services = createServices({ repositories: repos });
  });

  describe('Multi-worker concurrent lease claiming', () => {
    it('claims and processes batches across concurrent workers without overlap', async () => {
      const outboxRepo = repos.outbox as InMemoryOutboxRepository;

      // Mock resource & guardian & request for each
      for (let i = 0; i < 30; i++) {
        await repos.resources.create({ id: `res-${i}`, name: `res-${i}`, mode: 'ONE_OF_N' });
        await repos.guardians.add({
          id: `g-${i}`,
          resourceId: `res-${i}`,
          discordUserId: `guardian-${i}`,
          role: 'OWNER',
        });
        await repos.approvalRequests.create({
          id: `req-${i}`,
          resourceId: `res-${i}`,
          status: 'PENDING',
          requesterId: `requester-${i}`,
          requesterType: 'DISCORD_USER',
          authKind: 'DISCORD',
          authFamily: 'DISCORD',
          audience: 'purrmission-bot',
          action: 'resource.view',
          targetType: 'RESOURCE',
          targetKey: null,
          targetVersion: 'v1',
          policyVersion: 'v1',
          constraints: null,
          deliveryState: 'PENDING',
          expiresAt: new Date(Date.now() + 60000),
        });

        await outboxRepo.create(
          buildOutboxEvent({
            eventType: 'REQUEST_CREATED_GUARDIAN_NOTIFICATION',
            resourceId: `res-${i}`,
            requestId: `req-${i}`,
            recipientId: `guardian-${i}`,
            payload: {
              requestId: `req-${i}`,
              resourceId: `res-${i}`,
              recipientId: `guardian-${i}`,
            },
          })
        );
      }

      // Create 5 workers with small batch sizes
      const deliveredDMs: string[] = [];
      const mockDiscord = {
        users: {
          fetch: async (userId: string) => ({
            createDM: async () => ({
              send: async () => {
                deliveredDMs.push(userId);
                return { id: `msg-${userId}`, channelId: `ch-${userId}` };
              },
            }),
          }),
        },
      } as unknown as Client;

      const workers = [
        new OutboxWorker(repos, auditService, mockDiscord, 5, 30000, 6),
        new OutboxWorker(repos, auditService, mockDiscord, 5, 30000, 6),
        new OutboxWorker(repos, auditService, mockDiscord, 5, 30000, 6),
        new OutboxWorker(repos, auditService, mockDiscord, 5, 30000, 6),
        new OutboxWorker(repos, auditService, mockDiscord, 5, 30000, 6),
      ];

      // Run all 5 workers concurrently
      const results = await Promise.all(workers.map((w) => w.processEvents()));
      const totalProcessed = results.reduce((a, b) => a + b, 0);

      assert.equal(totalProcessed, 30);
      assert.equal(deliveredDMs.length, 30);
      // Ensure all 30 unique guardians received their notification
      const uniqueGuardians = new Set(deliveredDMs);
      assert.equal(uniqueGuardians.size, 30);

      // Verify all events are marked PROCESSED
      const pending = await outboxRepo.findPending();
      assert.equal(pending.length, 0);
    });

    it('reclaims and processes abandoned expired leases', async () => {
      const outboxRepo = repos.outbox as InMemoryOutboxRepository;

      await repos.resources.create({ id: 'res-lease', name: 'res-lease', mode: 'ONE_OF_N' });
      await repos.guardians.add({
        id: 'g-lease',
        resourceId: 'res-lease',
        discordUserId: 'guardian-lease',
        role: 'OWNER',
      });
      await repos.approvalRequests.create({
        id: 'req-lease',
        resourceId: 'res-lease',
        status: 'PENDING',
        requesterId: 'requester-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        authFamily: 'DISCORD',
        audience: 'purrmission-bot',
        action: 'resource.view',
        targetType: 'RESOURCE',
        targetKey: null,
        targetVersion: 'v1',
        policyVersion: 'v1',
        constraints: null,
        deliveryState: 'PENDING',
        expiresAt: new Date(Date.now() + 60000),
      });

      const event = await outboxRepo.create(
        buildOutboxEvent({
          eventType: 'REQUEST_CREATED_GUARDIAN_NOTIFICATION',
          resourceId: 'res-lease',
          requestId: 'req-lease',
          recipientId: 'guardian-lease',
          payload: {
            requestId: 'req-lease',
            resourceId: 'res-lease',
            recipientId: 'guardian-lease',
          },
        })
      );

      // Simulate a crashed worker that claimed the event with an expired lease
      const inMemoryEvents = (outboxRepo as unknown as { events: OutboxEvent[] }).events;
      const inMemoryEvent = inMemoryEvents.find((e) => e.id === event.id);
      assert.ok(inMemoryEvent);
      inMemoryEvent.status = 'DELIVERY_IN_PROGRESS';
      inMemoryEvent.claimedBy = 'worker:crashed';
      inMemoryEvent.claimedAt = new Date(Date.now() - 60000);
      inMemoryEvent.claimExpiresAt = new Date(Date.now() - 10000);

      let sendCalled = false;
      const mockDiscord = {
        users: {
          fetch: async () => ({
            createDM: async () => ({
              send: async () => {
                sendCalled = true;
                return { id: 'msg-recovered', channelId: 'ch-recovered' };
              },
            }),
          }),
        },
      } as unknown as Client;

      // Active worker should reclaim expired lease and process
      const activeWorker = new OutboxWorker(repos, auditService, mockDiscord);
      const processed = await activeWorker.processEvents();

      assert.equal(processed, 1);
      assert.equal(sendCalled, true);
      const updated = await outboxRepo.findById(event.id);
      assert.equal(updated?.status, 'PROCESSED');
    });
  });

  describe('Independent Per-Guardian Notification & Isolation', () => {
    it('creates independent outbox records for each eligible guardian and delivers private DMs', async () => {
      const ownerPrincipal = createDiscordPrincipal('owner-1');
      const project = await services.project.createProject(
        { name: 'multi-guardian-proj', ownerId: 'owner-1' },
        ownerPrincipal
      );
      const env = await services.project.createEnvironment(
        { name: 'Production', slug: 'prod', projectId: project.id },
        ownerPrincipal
      );
      assert.ok(env.resourceId);

      // Add a second guardian
      await services.resource.addGuardian(env.resourceId, 'guardian-2', 'owner-1');

      // Create an approval request
      const reqRes = await services.approval.createApprovalRequest({
        resourceId: env.resourceId,
        context: { requesterId: 'requester-x', reason: 'Deployment access' },
      });
      assert.equal(reqRes.success, true);

      // Check that 2 distinct outbox events were generated (one for owner-1, one for guardian-2)
      const outboxRepo = repos.outbox as InMemoryOutboxRepository;
      const events = await outboxRepo.findPending();
      assert.equal(events.length, 2);

      const recipients = events.map((e) => e.recipientId).sort();
      assert.deepEqual(recipients, ['guardian-2', 'owner-1']);

      // Deliver via worker
      const dmsDelivered: { recipient: string; content: string }[] = [];
      const mockDiscord = {
        users: {
          fetch: async (userId: string) => ({
            createDM: async () => ({
              send: async (options: { content: string }) => {
                dmsDelivered.push({ recipient: userId, content: options.content });
                return { id: `msg-${userId}`, channelId: `ch-${userId}` };
              },
            }),
          }),
        },
      } as unknown as Client;

      const worker = new OutboxWorker(repos, auditService, mockDiscord);
      await worker.processEvents();

      assert.equal(dmsDelivered.length, 2);
      // Ensure each DM is sent to the individual user without mentions of other guardians
      for (const dm of dmsDelivered) {
        assert.ok(!dm.content.includes('<@guardian-2>') || dm.recipient === 'guardian-2');
        assert.ok(!dm.content.includes('<@owner-1>') || dm.recipient === 'owner-1');
      }
    });

    it('re-evaluates guardian eligibility at delivery time and skips ineligible recipients with NOOP', async () => {
      const ownerPrincipal = createDiscordPrincipal('owner-1');
      const project = await services.project.createProject(
        { name: 'eligibility-proj', ownerId: 'owner-1' },
        ownerPrincipal
      );
      const env = await services.project.createEnvironment(
        { name: 'Staging', slug: 'staging', projectId: project.id },
        ownerPrincipal
      );
      assert.ok(env.resourceId);
      await services.resource.addGuardian(env.resourceId, 'guardian-temp', 'owner-1');

      const reqRes = await services.approval.createApprovalRequest({
        resourceId: env.resourceId,
        context: { requesterId: 'requester-y', reason: 'Staging access' },
      });
      assert.equal(reqRes.success, true);

      // Now remove guardian-temp before the worker runs
      await services.resource.removeGuardian(env.resourceId, 'owner-1', 'guardian-temp');

      const deliveredUsers: string[] = [];
      const mockDiscord = {
        users: {
          fetch: async (userId: string) => ({
            createDM: async () => ({
              send: async () => {
                deliveredUsers.push(userId);
                return { id: `msg-${userId}`, channelId: `ch-${userId}` };
              },
            }),
          }),
        },
      } as unknown as Client;

      const worker = new OutboxWorker(repos, auditService, mockDiscord);
      await worker.processEvents();

      // Only owner-1 should have received DM; guardian-temp was skipped as NOOP
      assert.deepEqual(deliveredUsers, ['owner-1']);
      const pending = await (repos.outbox as InMemoryOutboxRepository).findPending();
      assert.equal(pending.length, 0);
    });

    it('fails transiently with backoff when Discord client is missing/disconnected', async () => {
      const outboxRepo = repos.outbox as InMemoryOutboxRepository;
      const event = await outboxRepo.create(
        buildOutboxEvent({
          eventType: 'REQUEST_CREATED_GUARDIAN_NOTIFICATION',
          resourceId: 'res-nodiscord',
          requestId: 'req-nodiscord',
          recipientId: 'guardian-nodiscord',
          payload: {
            requestId: 'req-nodiscord',
            resourceId: 'res-nodiscord',
            recipientId: 'guardian-nodiscord',
          },
        })
      );

      // Worker created WITHOUT discordClient
      const worker = new OutboxWorker(repos, auditService, undefined);
      await worker.processEvents();

      const updated = await outboxRepo.findById(event.id);
      assert.equal(updated?.status, 'PENDING');
      assert.equal(updated?.lastErrorCode, 'DISCORD_CLIENT_UNAVAILABLE');
      assert.ok(updated?.nextRetryAt !== null);
    });
  });

  describe('CallbackDestination Lifecycle & Challenge Verification', () => {
    it('supports full destination management lifecycle with owner verification', async () => {
      const ownerPrincipal = createDiscordPrincipal('owner-dest');
      const attackerPrincipal = createDiscordPrincipal('attacker');

      const project = await services.project.createProject(
        { name: 'dest-proj', ownerId: 'owner-dest' },
        ownerPrincipal
      );
      const env = await services.project.createEnvironment(
        { name: 'Prod', slug: 'prod', projectId: project.id },
        ownerPrincipal
      );
      assert.ok(env.resourceId);

      // 1. Attacker cannot create callback destination
      await assert.rejects(
        async () => {
          assert.ok(env.resourceId);
          await services.callbackDestinations.createDestination(
            {
              resourceId: env.resourceId,
              projectId: project.id,
              name: 'Prod Webhook',
              url: 'https://webhook.example.com/events',
            },
            attackerPrincipal
          );
        },
        (err) => err instanceof DomainAuthorizationError
      );

      // 2. Owner creates callback destination (starts in PENDING_VERIFICATION)
      const createRes = await services.callbackDestinations.createDestination(
        {
          resourceId: env.resourceId,
          projectId: project.id,
          name: 'Prod Webhook',
          url: 'https://webhook.example.com/events',
        },
        ownerPrincipal
      );

      assert.ok(createRes.destination.id);
      assert.equal(createRes.destination.status, 'PENDING_VERIFICATION');
      assert.ok(createRes.secret.length > 20);
      assert.ok(createRes.verificationToken.length > 10);

      // 3. List destinations does not expose secret or encryptedSecret
      const destList = await services.callbackDestinations.listDestinations(
        env.resourceId,
        ownerPrincipal
      );
      assert.equal(destList.length, 1);
      assert.equal('secret' in (destList[0] as unknown as Record<string, unknown>), false);
      assert.equal('encryptedSecret' in (destList[0] as unknown as Record<string, unknown>), false);

      // 4. Invalid challenge verification token fails
      await assert.rejects(
        async () => {
          await services.callbackDestinations.verifyDestination(
            createRes.destination.id,
            'wrong-token',
            ownerPrincipal
          );
        },
        (err) => err instanceof ValidationError
      );

      // 5. Valid verification challenge activates destination
      const verified = await services.callbackDestinations.verifyDestination(
        createRes.destination.id,
        createRes.verificationToken,
        ownerPrincipal
      );
      assert.equal(verified.status, 'ACTIVE');
      assert.ok(verified.verifiedAt !== null);

      // 5b. Single-use: Re-using the challenge token now fails as it was cleared on activation
      await assert.rejects(
        async () => {
          await services.callbackDestinations.verifyDestination(
            createRes.destination.id,
            createRes.verificationToken,
            ownerPrincipal
          );
        },
        (err) => err instanceof ValidationError
      );

      // 6. Rotate signing secret
      const rotation = await services.callbackDestinations.rotateSecret(
        createRes.destination.id,
        ownerPrincipal
      );
      assert.ok(rotation.secret.length > 20);
      assert.notEqual(rotation.secret, createRes.secret);

      // 7. Disable destination
      const disabled = await services.callbackDestinations.disableDestination(
        createRes.destination.id,
        ownerPrincipal
      );
      assert.equal(disabled.status, 'DISABLED');

      // 8. Delete destination
      await services.callbackDestinations.deleteDestination(
        createRes.destination.id,
        ownerPrincipal
      );
      const afterDelete = await services.callbackDestinations.listDestinations(
        env.resourceId,
        ownerPrincipal
      );
      assert.equal(afterDelete.length, 0);
    });
  });

  describe('Webhook SSRF & HTTP Response Validation', () => {
    it('rejects ALLOW_PRIVATE_WEBHOOKS outside NODE_ENV=test', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalAllow = process.env.ALLOW_PRIVATE_WEBHOOKS;
      try {
        process.env.NODE_ENV = 'production';
        process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';

        await assert.rejects(async () => {
          await SSRFSafeWebhookClient.send('https://127.0.0.1/hook', 'secret', {
            eventType: 'APPROVAL_CALLBACK',
            requestId: 'req-1',
            resourceId: 'res-1',
            status: 'APPROVED',
            targetVersion: 'v1',
          });
        }, /ALLOW_PRIVATE_WEBHOOKS is only permitted when NODE_ENV=test/);
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.ALLOW_PRIVATE_WEBHOOKS = originalAllow;
      }
    });

    it('treats non-2xx HTTP responses as delivery failures subject to backoff retry', async () => {
      // Start a local test HTTP server returning 500
      let receivedHeaders: http.IncomingHttpHeaders | null = null;
      let receivedBody: Record<string, unknown> | null = null;
      const server = http.createServer((req, res) => {
        receivedHeaders = req.headers;
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
          receivedBody = JSON.parse(data);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/webhook`;

      const prevAllow = process.env.ALLOW_PRIVATE_WEBHOOKS;
      try {
        process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
        const ownerPrincipal = createDiscordPrincipal('owner-hook');
        const project = await services.project.createProject(
          { name: 'hook-proj', ownerId: 'owner-hook' },
          ownerPrincipal
        );
        const env = await services.project.createEnvironment(
          { name: 'Prod', slug: 'prod', projectId: project.id },
          ownerPrincipal
        );
        assert.ok(env.resourceId);

        const destRes = await services.callbackDestinations.createDestination(
          { resourceId: env.resourceId, projectId: project.id, url },
          ownerPrincipal
        );
        await services.callbackDestinations.verifyDestination(
          destRes.destination.id,
          destRes.verificationToken,
          ownerPrincipal
        );

        // Enqueue approval callback
        const reqRes = await services.approval.createApprovalRequest({
          resourceId: env.resourceId,
          context: { requesterId: 'requester-hook', reason: 'Test hook' },
        });
        assert.ok(reqRes.request);

        // Record decision -> enqueues callback
        await services.approval.recordDecision(reqRes.request.id, 'APPROVE', ownerPrincipal);

        const outboxRepo = repos.outbox as InMemoryOutboxRepository;
        const worker = new OutboxWorker(repos, auditService);
        await worker.processEvents();

        // Ensure payload and signatures were sent with stable deliveryId & idempotencyKey
        assert.ok(receivedHeaders);
        assert.ok(receivedBody);
        assert.ok(receivedHeaders['x-purrmission-signature-256']);
        assert.ok(receivedHeaders['x-purrmission-delivery-id']);
        assert.ok(receivedHeaders['x-purrmission-idempotency-key']);
        assert.equal((receivedBody as Record<string, unknown>).requestId, reqRes.request.id);
        assert.equal((receivedBody as Record<string, unknown>).status, 'APPROVED');

        // Since server returned 500, event should be marked for retry
        const callbackEvent = (outboxRepo as unknown as { events: OutboxEvent[] }).events.find(
          (e) => e.eventType === 'APPROVAL_CALLBACK'
        );
        assert.ok(callbackEvent);
        assert.equal(callbackEvent.status, 'PENDING');
        assert.equal(callbackEvent.lastErrorCode, 'HTTP_500');
        assert.ok(callbackEvent.nextRetryAt !== null);
      } finally {
        process.env.ALLOW_PRIVATE_WEBHOOKS = prevAllow;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
