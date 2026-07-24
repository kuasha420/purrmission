import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from './audit.js';
import { InMemoryAuditRepository } from './repositories.mock.js';
import type { ServiceDependencies } from './services.js';
import type { AuditRepository } from './repositories.js';

describe('AuditService', () => {
  it('should log an event successfully', async () => {
    const repo = new InMemoryAuditRepository();
    const service = new AuditService({
      repositories: { audit: repo },
    } as unknown as ServiceDependencies);

    await service.log({
      eventType: 'TEST_EVENT',
      outcomeCode: 'SUCCESS',
      actorType: 'DISCORD_USER',
      actorId: 'user-1',
      resourceId: 'res-1',
      payload: { foo: 'bar' },
    });

    const logs = await service.getLogsForResource('res-1');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].eventType, 'TEST_EVENT');
    assert.equal(logs[0].resourceId, 'res-1');
    assert.equal(logs[0].actorId, 'user-1');
    assert.equal(logs[0].outcomeCode, 'SUCCESS');
    assert.deepEqual(logs[0].payload, { foo: 'bar' });
    assert.ok(logs[0].id);
    assert.ok(logs[0].createdAt);
  });

  it('should throw and fail closed if logging fails', async () => {
    const brokenRepo = {
      create: async () => {
        throw new Error('Database connection failed');
      },
    };
    const service = new AuditService({
      repositories: { audit: brokenRepo as unknown as AuditRepository },
    } as unknown as ServiceDependencies);

    // This should throw because we want to fail closed on audit failures
    await assert.rejects(async () => {
      await service.log({
        eventType: 'FAIL_EVENT',
        outcomeCode: 'FAILURE',
        actorType: 'SERVICE',
        resourceId: 'res-broken',
      });
    });
  });

  it('should retrieve logs for a specific resource', async () => {
    const repo = new InMemoryAuditRepository();
    const service = new AuditService({
      repositories: { audit: repo },
    } as unknown as ServiceDependencies);

    await service.log({
      eventType: 'A',
      outcomeCode: 'SUCCESS',
      actorType: 'SERVICE',
      resourceId: 'res-1',
    });
    await service.log({
      eventType: 'B',
      outcomeCode: 'SUCCESS',
      actorType: 'SERVICE',
      resourceId: 'res-2',
    });
    await service.log({
      eventType: 'C',
      outcomeCode: 'SUCCESS',
      actorType: 'SERVICE',
      resourceId: 'res-1',
    });

    const logsRes1 = await service.getLogsForResource('res-1');
    const logsRes2 = await service.getLogsForResource('res-2');

    assert.equal(logsRes1.length, 2);
    assert.equal(logsRes1[0].eventType, 'A');
    assert.equal(logsRes1[1].eventType, 'C');
    assert.equal(logsRes2.length, 1);
    assert.equal(logsRes2[0].eventType, 'B');
  });
});
