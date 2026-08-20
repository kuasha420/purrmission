import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { isPublicIP, SSRFSafeWebhookClient } from './webhook.js';
import { createInMemoryRepositories } from './repositories.mock.js';
import { ResourceService, ApprovalService } from './services.js';
import { ProjectService } from './project.js';
import { DomainPortsImpl } from './ports_impl.js';
import { ValidationError } from './errors.js';
import { deterministicUUID } from './crypto.js';
import { AuditService, buildOutboxEvent } from './audit.js';
import { OutboxWorker } from './outbox_worker.js';
import type { Client } from 'discord.js';

describe('SSRF Protection, Idempotent Outbox, and Batch Secrets API', () => {
  let repos: ReturnType<typeof createInMemoryRepositories>;
  let resourceService: ResourceService;
  let projectService: ProjectService;
  let approvalService: ApprovalService;
  let ports: DomainPortsImpl;

  beforeEach(() => {
    repos = createInMemoryRepositories();
    const audit = new AuditService({ repositories: repos });
    const deps: any = { repositories: repos, audit };
    approvalService = new ApprovalService(deps);
    deps.approval = approvalService;
    resourceService = new ResourceService(deps);
    projectService = new ProjectService(repos.projects, resourceService, audit, repos.transaction);
    ports = new DomainPortsImpl(projectService, resourceService, approvalService, audit, repos);
  });

  describe('SSRF Protection & IP Screening', () => {
    it('should correctly classify public and private IP addresses', () => {
      // Loopback
      assert.strictEqual(isPublicIP('127.0.0.1'), false);
      assert.strictEqual(isPublicIP('::1'), false);
      assert.strictEqual(isPublicIP('0:0:0:0:0:0:0:1'), false);

      // RFC 1918 Private IPv4
      assert.strictEqual(isPublicIP('10.0.0.1'), false);
      assert.strictEqual(isPublicIP('172.16.5.1'), false);
      assert.strictEqual(isPublicIP('172.31.255.255'), false);
      assert.strictEqual(isPublicIP('192.168.1.100'), false);

      // Link local
      assert.strictEqual(isPublicIP('169.254.169.254'), false);
      assert.strictEqual(isPublicIP('fe80::1'), false);

      // Broadcast / multicast
      assert.strictEqual(isPublicIP('224.0.0.1'), false);
      assert.strictEqual(isPublicIP('255.255.255.255'), false);

      // Public IPv4 / IPv6
      assert.strictEqual(isPublicIP('8.8.8.8'), true);
      assert.strictEqual(isPublicIP('1.1.1.1'), true);
      assert.strictEqual(isPublicIP('2606:4700:4700::1111'), true);
    });

    it('should reject non-HTTPS webhook URLs by default', async () => {
      await assert.rejects(async () => {
        await SSRFSafeWebhookClient.send('http://google.com/webhook', 'sec', {
          eventType: 'test',
          requestId: 'req-1',
          resourceId: 'res-1',
          status: 'APPROVED',
          targetVersion: 'v1',
        });
      }, /Only HTTPS is allowed/);
    });
  });

  describe('Idempotency & Deterministic UUIDs', () => {
    it('should generate stable deterministic UUIDs from arbitrary inputs', () => {
      const u1 = deterministicUUID('req-1_REQUEST_CREATED');
      const u2 = deterministicUUID('req-1_REQUEST_CREATED');
      const u3 = deterministicUUID('req-2_REQUEST_CREATED');

      assert.strictEqual(u1, u2);
      assert.notStrictEqual(u1, u3);
      assert.match(u1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('does not redeliver after delivery when outcome-audit persistence fails', async () => {
      const audit = new AuditService({ repositories: repos });
      const originalLog = audit.log.bind(audit);
      audit.log = (async (event, tx) => {
        if (event.eventType === 'DELIVERY_OUTCOME') throw new Error('audit sink unavailable');
        return originalLog(event, tx);
      }) as typeof audit.log;
      await repos.outbox.create(
        buildOutboxEvent({
          eventType: 'REQUEST_CREATED',
          resourceId: 'resource-1',
          requestId: 'request-1',
          payload: { requestId: 'request-1', resourceId: 'resource-1' },
        })
      );
      const worker = new OutboxWorker(repos, audit);
      await worker.processEvents();
      assert.equal((await repos.outbox.findPending()).length, 0);
      await worker.processEvents();
      assert.equal((await repos.outbox.findPending()).length, 0);
    });

    it('durably exits the delivery queue before sending and never redelivers after marker failure', async () => {
      await repos.resources.create({ id: 'resource-1', name: 'resource', mode: 'ONE_OF_N' });
      await repos.guardians.add({
        id: 'guardian-1',
        resourceId: 'resource-1',
        discordUserId: 'owner-1',
        role: 'OWNER',
      });
      await repos.approvalRequests.create({
        id: 'request-1',
        resourceId: 'resource-1',
        status: 'PENDING',
        requesterId: 'requester-1',
        requesterType: 'DISCORD_USER',
        authKind: 'DISCORD',
        action: 'resource.view',
        targetKey: null,
        targetVersion: 'v1',
        policyVersion: 'v1',
        constraints: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const event = await repos.outbox.create(
        buildOutboxEvent({
          eventType: 'REQUEST_CREATED',
          resourceId: 'resource-1',
          requestId: 'request-1',
          payload: { requestId: 'request-1', resourceId: 'resource-1' },
        })
      );

      let sendCalls = 0;
      const discord = {
        users: {
          fetch: async () => ({
            createDM: async () => ({
              send: async () => {
                sendCalls += 1;
                return { id: 'message-1', channelId: 'channel-1' };
              },
            }),
          }),
        },
      } as unknown as Client;
      const statuses: string[] = [];
      const updateStatus = repos.outbox.updateStatus.bind(repos.outbox);
      let failDeliveredMarker = true;
      repos.outbox.updateStatus = async (id, status, attempts, errorCode, tx) => {
        statuses.push(status);
        if (status === 'DELIVERED_PENDING_AUDIT' && failDeliveredMarker) {
          failDeliveredMarker = false;
          throw new Error('marker persistence failed');
        }
        return updateStatus(id, status, attempts, errorCode, tx);
      };

      const worker = new OutboxWorker(repos, new AuditService({ repositories: repos }), discord);
      await worker.processEvents();
      await worker.processEvents();

      assert.equal(sendCalls, 1);
      assert.deepEqual(statuses.slice(0, 2), ['DELIVERY_IN_PROGRESS', 'DELIVERED_PENDING_AUDIT']);
      assert.ok(statuses.includes('FAILED'));
      assert.equal((await repos.outbox.findPending()).length, 0);
      assert.equal(event.status, 'FAILED');
      assert.equal(event.attempts, 1);
    });
  });

  describe('Secret Batch Constraints & Mutations', () => {
    it('should reject secret batch count exceeding 100', async () => {
      const largeSecrets: Record<string, string> = {};
      for (let i = 0; i < 101; i++) {
        largeSecrets[`KEY_${i}`] = 'value';
      }

      await assert.rejects(async () => {
        // Pre-populate resource to avoid resource not found error
        await repos.resources.create({
          id: 'res-1',
          name: 'resource-1',
          mode: 'ONE_OF_N',
        });

        await resourceService.setSecrets('res-1', largeSecrets, {
          id: 'actor-1',
          type: 'SERVICE',
          subjectId: 'actor-1',
          authKind: 'SERVICE',
          scopes: [],
          audience: 'api',
        });
      }, ValidationError);
    });

    it('should reject invalid key formats', async () => {
      const invalidSecrets = {
        'INVALID.KEY': 'value',
      };

      await assert.rejects(async () => {
        // Pre-populate resource
        await repos.resources.create({
          id: 'res-1',
          name: 'resource-1',
          mode: 'ONE_OF_N',
        });

        await resourceService.setSecrets('res-1', invalidSecrets, {
          id: 'actor-1',
          type: 'SERVICE',
          subjectId: 'actor-1',
          authKind: 'SERVICE',
          scopes: [],
          audience: 'api',
        });
      }, ValidationError);
    });

    it('should reject secret value size exceeding 64KB', async () => {
      const hugeValue = 'a'.repeat(65537);
      const invalidSecrets = {
        KEY: hugeValue,
      };

      await assert.rejects(async () => {
        // Pre-populate resource
        await repos.resources.create({
          id: 'res-1',
          name: 'resource-1',
          mode: 'ONE_OF_N',
        });

        await resourceService.setSecrets('res-1', invalidSecrets, {
          id: 'actor-1',
          type: 'SERVICE',
          subjectId: 'actor-1',
          authKind: 'SERVICE',
          scopes: [],
          audience: 'api',
        });
      }, /exceeds maximum size of 64KB/);
    });
  });

  describe('DomainPorts Boundary Layer', () => {
    it('should expose defined services and execute projects actions', async () => {
      assert.ok(ports);
      const proj = await ports.createProject(
        {
          id: 'owner-1',
          type: 'DISCORD_USER',
          subjectId: 'owner-1',
          authKind: 'DISCORD',
          scopes: [],
          audience: 'api',
        },
        { name: 'My Project' }
      );
      assert.strictEqual(proj.name, 'My Project');
    });
  });
});
