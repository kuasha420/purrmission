
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createHttpServer } from '../http/server.js';
import { createServices } from '../domain/services.js';
import { createInMemoryRepositories } from '../domain/repositories.mock.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../domain/services.js';
import type { Repositories } from '../domain/repositories.js';
import type { Client } from 'discord.js';

// Mock Discord Client (minimal)
const mockDiscordClient = {
    isReady: () => true,
    user: { tag: 'TestBot#0000' },
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
    login: async () => 'token',
    destroy: () => { },
    on: () => { },
    once: () => { },
} as unknown as Client;

describe('Resource API', () => {
    let server: FastifyInstance;
    let services: Services;
    let repositories: Repositories;
    let validToken = 'valid-token';
    let userId = 'user-123';
    let resourceId: string;

    beforeEach(async () => {
        repositories = createInMemoryRepositories();
        services = createServices({ repositories });

        // Setup Auth
        const hashedToken = createHash('sha256').update(validToken).digest('hex');
        await repositories.auth.createApiToken({
            token: hashedToken,
            userId: userId,
            name: 'Test Token',
            expiresAt: new Date(Date.now() + 3600000),
        });

        // Setup Resource
        resourceId = '123e4567-e89b-12d3-a456-426614174000'; // valid UUID
        await repositories.resources.create({
            id: resourceId,
            name: 'Test Resource',
            mode: 'ONE_OF_N' as any,
            apiKey: 'api-key-1'
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
            discordClient: mockDiscordClient as Client
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
            payload: { name: 'DB_PASS', value: 'secret123' }
        });
        assert.strictEqual(createRes.statusCode, 201);
        const field = JSON.parse(createRes.payload);
        assert.strictEqual(field.name, 'DB_PASS');

        // Get Value
        const getRes = await server.inject({
            method: 'GET',
            url: `/api/resources/${resourceId}/fields/DB_PASS`,
            headers: { Authorization: `Bearer ${validToken}` }
        });
        assert.strictEqual(getRes.statusCode, 200);
        const getBody = JSON.parse(getRes.payload);
        assert.strictEqual(getBody.value, 'secret123');
    });

    it('should list fields', async () => {
        await services.resource.createField(resourceId, 'F1', 'V1');
        await services.resource.createField(resourceId, 'F2', 'V2');

        const listRes = await server.inject({
            method: 'GET',
            url: `/api/resources/${resourceId}/fields`,
            headers: { Authorization: `Bearer ${validToken}` }
        });

        assert.strictEqual(listRes.statusCode, 200);
        const names = JSON.parse(listRes.payload);
        assert.ok(Array.isArray(names));
        assert.strictEqual(names.length, 2);
        assert.ok(names.includes('F1'));
        assert.ok(names.includes('F2'));
    });

    it('should delete a field', async () => {
        await services.resource.createField(resourceId, 'DEL_ME', 'VAL');

        const delRes = await server.inject({
            method: 'DELETE',
            url: `/api/resources/${resourceId}/fields/DEL_ME`,
            headers: { Authorization: `Bearer ${validToken}` }
        });
        assert.strictEqual(delRes.statusCode, 204);

        const check = await services.resource.getField(resourceId, 'DEL_ME');
        assert.strictEqual(check, null);
    });

    it('should link 2FA and get code', async () => {
        // Create TOTP Account
        const account = await repositories.totp.create({
            ownerDiscordUserId: userId,
            accountName: 'Google',
            secret: 'JBSWY3DPEHPK3PXP', // Valid base32
            shared: false,
        });


        // Link
        const linkRes = await server.inject({
            method: 'POST',
            url: `/api/resources/${resourceId}/2fa/link`,
            headers: { Authorization: `Bearer ${validToken}` },
            payload: { totpAccountId: account.id }
        });
        assert.strictEqual(linkRes.statusCode, 200);

        // Get Code
        const codeRes = await server.inject({
            method: 'GET',
            url: `/api/resources/${resourceId}/2fa`,
            headers: { Authorization: `Bearer ${validToken}` }
        });
        assert.strictEqual(codeRes.statusCode, 200);
        const body = JSON.parse(codeRes.payload);
        assert.ok(body.code);
        assert.strictEqual(body.code.length, 6);
    });

    it('should unlink 2FA', async () => {
        // Setup linked account
        const account = await repositories.totp.create({
            ownerDiscordUserId: userId,
            accountName: 'Google',
            secret: 'JBSWY3DPEHPK3PXP',
            shared: false
        });
        await services.resource.linkTOTPAccount(resourceId, account.id, userId);

        // Unlink
        const unlinkRes = await server.inject({
            method: 'DELETE',
            url: `/api/resources/${resourceId}/2fa/link`,
            headers: { Authorization: `Bearer ${validToken}` }
        });
        assert.strictEqual(unlinkRes.statusCode, 204);

        const check = await services.resource.getLinkedTOTPAccount(resourceId);
        assert.strictEqual(check, null);
    });
});
