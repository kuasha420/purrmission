import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from './audit.js';
import { InMemoryAuditRepository } from './repositories.js';

describe('AuditService', () => {
    it('should log an event successfully', async () => {
        const repo = new InMemoryAuditRepository();
        const service = new AuditService({ repositories: { audit: repo } } as any);

        await service.log({
            action: 'TEST_ACTION',
            resourceId: 'res-1',
            actorId: 'user-1',
            status: 'SUCCESS',
            context: '{"foo":"bar"}',
        });

        const logs = await service.getLogsForResource('res-1');
        assert.equal(logs.length, 1);
        assert.equal(logs[0].action, 'TEST_ACTION');
        assert.equal(logs[0].resourceId, 'res-1');
        assert.equal(logs[0].actorId, 'user-1');
        assert.equal(logs[0].status, 'SUCCESS');
        assert.equal(logs[0].context, '{"foo":"bar"}');
        assert.ok(logs[0].id);
        assert.ok(logs[0].createdAt);
    });

    it('should swallow errors and not throw if logging fails', async () => {
        const brokenRepo = {
            create: async () => {
                throw new Error('Database connection failed');
            },
        };
        const service = new AuditService({ repositories: { audit: brokenRepo } } as any);

        // This should NOT throw despite the repo throwing
        await assert.doesNotReject(async () => {
            await service.log({
                action: 'FAIL_ACTION',
                resourceId: 'res-broken',
                status: 'ATTEMPT',
            });
        });
    });

    it('should retrieve logs for a specific resource', async () => {
        const repo = new InMemoryAuditRepository();
        const service = new AuditService({ repositories: { audit: repo } } as any);

        await service.log({ action: 'A', resourceId: 'res-1', status: 'S' });
        await service.log({ action: 'B', resourceId: 'res-2', status: 'S' });
        await service.log({ action: 'C', resourceId: 'res-1', status: 'S' });

        const logsRes1 = await service.getLogsForResource('res-1');
        const logsRes2 = await service.getLogsForResource('res-2');

        assert.equal(logsRes1.length, 2);
        assert.equal(logsRes1[0].action, 'A');
        assert.equal(logsRes1[1].action, 'C');
        assert.equal(logsRes2.length, 1);
        assert.equal(logsRes2[0].action, 'B');
    });
});
