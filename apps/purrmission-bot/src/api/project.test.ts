
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createHttpServer } from '../http/server.js';
import { createServices } from '../domain/services.js';
import { createInMemoryRepositories } from '../domain/repositories.mock.js';

import { createHash } from 'node:crypto';

// Mock Discord Client (minimal)
import { FastifyInstance } from 'fastify';
import { Services } from '../domain/services.js';
import { Repositories } from '../domain/repositories.js';

import { Client } from 'discord.js';

// Mock Discord Client (minimal)
const mockDiscordClient: Partial<Client> = {
    isReady: () => true,
    user: { tag: 'TestBot#0000' },
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
    login: async () => { },
    destroy: () => { },
    on: () => { },
    once: () => { },
};

describe('Project API', () => {
    let server: FastifyInstance;
    let services: Services;
    let repositories: Repositories;
    let validToken = 'valid-token';
    let userId = 'user-123';

    beforeEach(async () => {
        repositories = createInMemoryRepositories();
        services = createServices({ repositories });

        // Setup Auth for test
        const hashedToken = createHash('sha256').update(validToken).digest('hex');
        await repositories.auth.createApiToken({
            token: hashedToken,
            userId: userId,
            name: 'Test Token',
            expiresAt: new Date(Date.now() + 3600000),
        });

        server = createHttpServer({
            services,
            discordClient: mockDiscordClient
        });
        await server.ready();
    });

    afterEach(async () => {
        await server.close();
    });

    it('should create a project', async () => {
        const response = await server.inject({
            method: 'POST',
            url: '/api/projects',
            headers: { Authorization: `Bearer ${validToken}` },
            payload: { name: 'My Project', description: 'Test Project' }
        });

        assert.strictEqual(response.statusCode, 201);
        const body = JSON.parse(response.payload);
        assert.strictEqual(body.name, 'My Project');
        assert.strictEqual(body.ownerId, userId);
        assert.ok(body.id);
    });

    it('should list projects', async () => {
        // Create one first
        await server.inject({
            method: 'POST',
            url: '/api/projects',
            headers: { Authorization: `Bearer ${validToken}` },
            payload: { name: 'P1' }
        });

        const response = await server.inject({
            method: 'GET',
            url: '/api/projects',
            headers: { Authorization: `Bearer ${validToken}` }
        });

        assert.strictEqual(response.statusCode, 200);
        const body = JSON.parse(response.payload);
        assert.strictEqual(body.length, 1);
        assert.strictEqual(body[0].name, 'P1');
    });

    it('should create an environment', async () => {
        // Create project
        const pApp = await server.inject({
            method: 'POST',
            url: '/api/projects',
            headers: { Authorization: `Bearer ${validToken}` },
            payload: { name: 'P2' }
        });
        const project = JSON.parse(pApp.payload);

        // Create environment
        const response = await server.inject({
            method: 'POST',
            url: `/api/projects/${project.id}/environments`,
            headers: { Authorization: `Bearer ${validToken}` },
            payload: { name: 'Production', slug: 'prod' }
        });

        assert.strictEqual(response.statusCode, 201);
        const env = JSON.parse(response.payload);
        assert.strictEqual(env.name, 'Production');
        assert.strictEqual(env.slug, 'prod');
        assert.strictEqual(env.projectId, project.id);
    });

    it('should enforce auth', async () => {
        const response = await server.inject({
            method: 'GET',
            url: '/api/projects'
        });
        assert.strictEqual(response.statusCode, 401);
    });
});
