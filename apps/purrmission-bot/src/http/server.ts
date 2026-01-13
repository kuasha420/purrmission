/**
 * Fastify HTTP server setup.
 *
 * Provides the HTTP API for external services to request approvals.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { Client, TextChannel } from 'discord.js';
import { z } from 'zod';
import { logger } from '../logging/logger.js';
import type { Services } from '../domain/services.js';
import {
  createApprovalButtons,
  createApprovalEmbed,
} from '../discord/interactions/approvalButtons.js';

/**
 * Dependencies for the HTTP server.
 */
export interface HttpServerDeps {
  services: Services;
  discordClient: Client;
}

/**
 * Request body schema for creating an approval request.
 */
const createRequestSchema = z.object({
  resourceId: z.string().min(1, 'resourceId is required'),
  apiKey: z.string().min(1, 'apiKey is required'),
  context: z.record(z.unknown()).optional().default({}),
  callbackUrl: z.string().url().optional(),
  expiresInMs: z.number().positive().optional(),
  channelId: z.string().min(1).optional(), // Discord channel to send the approval message
});

type CreateRequestBody = z.infer<typeof createRequestSchema>;

/**
 * Create and configure the Fastify server.
 */
export function createHttpServer(deps: HttpServerDeps): FastifyInstance {
  const { services, discordClient } = deps;

  const server = Fastify({
    logger: false, // We use our own logger
  });

  // Health check endpoint
  server.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      discord: discordClient.isReady() ? 'connected' : 'disconnected',
    };
  });

  // Create approval request endpoint
  server.post<{ Body: CreateRequestBody }>('/api/requests', async (request, reply) => {
    // Validate request body
    const parseResult = createRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      logger.warn('Invalid request body', {
        errors: parseResult.error.flatten(),
      });
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parseResult.error.flatten(),
      });
    }

    const body = parseResult.data;

    // Verify API key
    const resource = await services.resource.verifyApiKey(body.apiKey);
    if (!resource) {
      logger.warn('Invalid API key', { resourceId: body.resourceId });
      return reply.status(401).send({
        error: 'Invalid API key',
      });
    }

    // Verify resourceId matches the API key's resource
    if (resource.id !== body.resourceId) {
      logger.warn('Resource ID mismatch', {
        providedResourceId: body.resourceId,
        apiKeyResourceId: resource.id,
      });
      return reply.status(401).send({
        error: 'Resource ID does not match API key',
      });
    }

    // Create the approval request
    const result = await services.approval.createApprovalRequest({
      resourceId: body.resourceId,
      context: body.context,
      callbackUrl: body.callbackUrl,
      expiresInMs: body.expiresInMs,
    });

    if (!result.success) {
      logger.error('Failed to create approval request', {
        error: result.error,
      });
      return reply.status(400).send({
        error: result.error,
      });
    }

    const approvalRequest = result.request!;

    // Send Discord message to guardians
    try {
      await sendApprovalMessage(deps, result, body.channelId);
    } catch (error) {
      logger.error('Failed to send Discord message', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue anyway - the request was created successfully
    }

    logger.info('Approval request created via API', {
      requestId: approvalRequest.id,
      resourceId: resource.id,
    });

    return reply.status(201).send({
      requestId: approvalRequest.id,
      status: approvalRequest.status,
      resourceId: resource.id,
      resourceName: resource.name,
      expiresAt: approvalRequest.expiresAt?.toISOString() ?? null,
    });
  });

  // Get request status endpoint
  server.get<{ Params: { id: string } }>('/api/requests/:id', async (request, reply) => {
    const { id } = request.params;

    const approvalRequest = await services.approval.getApprovalRequest(id);
    if (!approvalRequest) {
      return reply.status(404).send({
        error: 'Request not found',
      });
    }

    return {
      requestId: approvalRequest.id,
      resourceId: approvalRequest.resourceId,
      status: approvalRequest.status,
      context: approvalRequest.context,
      createdAt: approvalRequest.createdAt.toISOString(),
      expiresAt: approvalRequest.expiresAt?.toISOString() ?? null,
      resolvedBy: approvalRequest.resolvedBy ?? null,
      resolvedAt: approvalRequest.resolvedAt?.toISOString() ?? null,
    };
  });

  // Device Auth Flow: Initiate
  server.post('/api/auth/device/code', async (_request, _reply) => {
    const result = await services.auth.initiateDeviceFlow();
    return {
      device_code: result.deviceCode,
      user_code: result.userCode,
      verification_uri: result.verificationUri,
      expires_in: result.expiresIn,
      interval: result.interval,
    };
  });

  // Device Auth Flow: Exchange Token
  server.post<{ Body: { device_code: string; grant_type: string } }>(
    '/api/auth/token',
    async (request, reply) => {
      const { device_code, grant_type } = request.body || {};

      if (grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
        return reply.status(400).send({ error: 'unsupported_grant_type' });
      }

      if (!device_code) {
        return reply.status(400).send({ error: 'invalid_request' });
      }

      try {
        const token = await services.auth.exchangeCodeForToken(device_code);
        if (!token) {
          return reply.status(400).send({ error: 'authorization_pending' });
        }

        return {
          access_token: token.token,
          token_type: 'Bearer',
          expires_in: null, // Never expires currently
        };
      } catch (e: any) {
        if (e.message === 'expired_token') {
          return reply.status(400).send({ error: 'expired_token' });
        }
        if (e.message === 'access_denied') {
          return reply.status(403).send({ error: 'access_denied' });
        }
        if (e.message === 'invalid_grant') {
          return reply.status(400).send({ error: 'invalid_grant' });
        }
        throw e;
      }
    }
  );

  return server;
}

/**
 * Send the approval message to Discord.
 */
async function sendApprovalMessage(
  deps: HttpServerDeps,
  result: Awaited<ReturnType<typeof deps.services.approval.createApprovalRequest>>,
  channelId?: string
): Promise<void> {
  const { discordClient } = deps;
  const { request, resource, guardians } = result;

  if (!request || !resource || !guardians) {
    return;
  }

  // Determine which channel to use
  // Priority: explicit channelId > first guardian's DM > skip
  let channel: TextChannel | null = null;

  if (channelId) {
    const fetchedChannel = await discordClient.channels.fetch(channelId).catch(() => null);
    if (fetchedChannel?.isTextBased() && 'send' in fetchedChannel) {
      channel = fetchedChannel as TextChannel;
    }
  }

  // If no channel specified, try to DM the first guardian
  // TODO: Implement better notification strategy (e.g., dedicated channel per resource)
  if (!channel && guardians.length > 0) {
    try {
      const owner = guardians.find((g) => g.role === 'OWNER') ?? guardians[0];
      const user = await discordClient.users.fetch(owner.discordUserId);
      const dm = await user.createDM();

      // Create and send message
      const embed = createApprovalEmbed(resource.name, request.context, request.expiresAt);
      const buttons = createApprovalButtons(request.id);

      // Mention other guardians
      const mentions = guardians
        .filter((g) => g.discordUserId !== owner.discordUserId)
        .map((g) => `<@${g.discordUserId}>`)
        .join(' ');

      await dm.send({
        content: mentions.length > 0 ? `Guardians: ${mentions}` : undefined,
        embeds: [embed],
        components: [buttons],
      });

      logger.info('Sent approval DM to guardian', {
        requestId: request.id,
        guardianId: owner.discordUserId,
      });
      return;
    } catch (error) {
      logger.warn('Failed to DM guardian, trying channel', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Send to channel if available
  if (channel) {
    const embed = createApprovalEmbed(resource.name, request.context, request.expiresAt);
    const buttons = createApprovalButtons(request.id);

    // Mention all guardians
    const mentions = guardians.map((g) => `<@${g.discordUserId}>`).join(' ');

    await channel.send({
      content: mentions.length > 0 ? `🔐 Approval needed! ${mentions}` : '🔐 Approval needed!',
      embeds: [embed],
      components: [buttons],
    });

    logger.info('Sent approval message to channel', {
      requestId: request.id,
      channelId: channel.id,
    });
  }
}

/**
 * Start the HTTP server.
 */
export async function startHttpServer(
  port: number,
  deps: HttpServerDeps
): Promise<FastifyInstance> {
  const server = createHttpServer(deps);

  await server.listen({ port, host: '0.0.0.0' });
  logger.info(`HTTP server listening on port ${port}`);

  return server;
}
