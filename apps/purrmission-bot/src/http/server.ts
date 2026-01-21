/**
 * Fastify HTTP server setup.
 *
 * Provides the HTTP API for external services to request approvals.
 */

import formBody from '@fastify/formbody';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Client, TextChannel } from 'discord.js';
import { z } from 'zod';
import { logger } from '../logging/logger.js';
import type { Services } from '../domain/services.js';
import {
  createApprovalButtons,
  createApprovalEmbed,
} from '../discord/interactions/approvalButtons.js';
import {
  InvalidGrantError,
  ExpiredTokenError,
  AccessDeniedError,
} from '../domain/auth.js';
import { generateTOTPCode } from '../domain/totp.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import type { ApprovalRequest, ResourceField } from '../domain/models.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string };
  }
}

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

  // Register formbody to support application/x-www-form-urlencoded (OAuth2 standard)
  server.register(formBody);


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
        const result = await services.auth.exchangeCodeForToken(device_code);
        if (!result) {
          return reply.status(400).send({ error: 'authorization_pending' });
        }

        return {
          access_token: result.token,
          token_type: 'Bearer',
          expires_in: Math.round((result.apiToken.expiresAt.getTime() - Date.now()) / 1000),
        };
      } catch (e: unknown) {
        if (e instanceof ExpiredTokenError) {
          return reply.status(400).send({ error: 'expired_token' });
        }
        if (e instanceof AccessDeniedError) {
          return reply.status(403).send({ error: 'access_denied' });
        }
        if (e instanceof InvalidGrantError) {
          return reply.status(400).send({ error: 'invalid_grant' });
        }
        throw e;
      }
    }
  );

  // -------------------------------------------------------------------------
  // Project & Environment Management
  // -------------------------------------------------------------------------

  // Zod Schemas
  const CreateProjectSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  });

  const CreateEnvironmentSchema = z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
  });

  const ProjectParamsSchema = z.object({
    projectId: z.string().uuid(),
  });

  const CreateResourceFieldSchema = z.object({
    name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    value: z.string().max(10240),
  });

  const ResourceParamsSchema = z.object({
    id: z.string().uuid(),
  });

  const FieldParamsSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
  });

  const LinkTotpSchema = z.object({
    totpAccountId: z.string().uuid(),
  });

  // Authentication Hook
  const authenticate = async (req: FastifyRequest, rep: FastifyReply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AccessDeniedError('Missing Bearer token');
    }
    const token = authHeader.substring(7);
    const apiToken = await services.auth.validateToken(token);
    if (!apiToken) {
      throw new AccessDeniedError('Invalid token');
    }
    // Attach user to request
    // Attach user to request
    (req as any).user = { id: apiToken.userId };
  };

  // Authorization Hook: Verify Guardian/Owner Access
  const verifyIsGuardian = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = req.params;
    if (!(await services.resource.isGuardian(id, req.user.id))) {
      throw new AccessDeniedError('Access denied');
    }
  };

  // Configure Zod Validator
  server.setValidatorCompiler(({ schema }) => {
    return (data) => {
      const result = (schema as z.ZodTypeAny).safeParse(data);
      if (result.success === false) {
        return { error: result.error };
      }
      return { value: result.data };
    };
  });

  // Global Error Handler
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: 'validation_error', details: error.issues });
    }
    const err = error as any;
    if (err.name === 'DuplicateError') {
      return reply.status(409).send({ error: err.message });
    }
    if (err.name === 'ResourceNotFoundError') {
      return reply.status(404).send({ error: err.message });
    }
    if (err.name === 'AccessDeniedError') {
      return reply.status(401).send({ error: 'unauthorized', message: err.message });
    }
    if (err.name === 'InvalidGrantError') {
      return reply.status(400).send({ error: 'invalid_grant', message: err.message });
    }
    if (err.name === 'ExpiredTokenError') {
      return reply.status(400).send({ error: 'expired_token' });
    }

    // Default handler
    logger.error('Unhandled API error', { error });
    return reply.status(500).send({ error: 'internal_server_error' });
  });
  server.post('/api/projects', {
    preHandler: [authenticate],
    schema: {
      body: CreateProjectSchema
    }
  }, async (req, rep) => {
    const { name, description } = req.body as z.infer<typeof CreateProjectSchema>;
    const userId = (req as any).user.id;

    const project = await services.project.createProject({
      name,
      description,
      ownerId: userId
    });

    return rep.status(201).send(project);
  });

  server.get('/api/projects', {
    preHandler: [authenticate]
  }, async (req, rep) => {
    const userId = (req as any).user.id;
    const projects = await services.project.listProjects(userId);
    return projects;
  });

  server.get('/api/projects/:projectId', {
    preHandler: [authenticate],
    schema: {
      params: ProjectParamsSchema
    }
  }, async (req, rep) => {
    const { projectId } = req.params as z.infer<typeof ProjectParamsSchema>;
    const userId = (req as any).user.id;

    const project = await services.project.getProject(projectId);
    if (!project) throw new ResourceNotFoundError('Project not found');

    // Basic ACL: only owner can view (for now)
    if (project.ownerId !== userId) throw new AccessDeniedError('Access denied');

    return project;
  });

  server.post('/api/projects/:projectId/environments', {
    preHandler: [authenticate],
    schema: {
      params: ProjectParamsSchema,
      body: CreateEnvironmentSchema
    }
  }, async (req, rep) => {
    const { projectId } = req.params as z.infer<typeof ProjectParamsSchema>;
    const { name, slug } = req.body as z.infer<typeof CreateEnvironmentSchema>;
    const userId = (req as any).user.id;

    const project = await services.project.getProject(projectId);
    if (!project) throw new ResourceNotFoundError('Project not found');
    if (project.ownerId !== userId) throw new AccessDeniedError('Access denied');

    const env = await services.project.createEnvironment({
      name,
      slug,
      projectId
    });
    return rep.status(201).send(env);
  });

  server.get('/api/projects/:projectId/environments', {
    preHandler: [authenticate],
    schema: {
      params: ProjectParamsSchema
    }
  }, async (req, rep) => {
    const { projectId } = req.params as z.infer<typeof ProjectParamsSchema>;
    const userId = (req as any).user.id;

    const project = await services.project.getProject(projectId);
    if (!project) throw new ResourceNotFoundError('Project not found');
    if (project.ownerId !== userId) throw new AccessDeniedError('Access denied');

    const envs = await services.project.listEnvironments(projectId);
    return envs;
  });

  server.get('/api/projects/:projectId/environments/:envId/secrets', {
    preHandler: [authenticate]
  }, async (req, rep) => {
    const { projectId, envId } = req.params as { projectId: string; envId: string };
    const userId = (req as any).user.id;

    const project = await services.project.getProject(projectId);
    if (!project) throw new ResourceNotFoundError('Project not found');

    const environment = await services.project.getEnvironmentById(projectId, envId);
    if (!environment) throw new ResourceNotFoundError('Environment not found');
    if (!environment.resourceId) throw new ResourceNotFoundError('Environment has no linked resource');

    const resourceId = environment.resourceId;

    // Project owner has immediate access
    if (project.ownerId === userId) {
      const fields = await services.resource.listFields(resourceId);
      return { secrets: fieldsToSecrets(fields) };
    }

    // Non-owners must be guardians
    const isGuardian = await services.resource.isGuardian(resourceId, userId);
    if (!isGuardian) {
      throw new AccessDeniedError('Access denied: Only project owners or guardians can access secrets');
    }

    // Check for active approval
    let approval: ApprovalRequest | null = await services.approval.findActiveApproval(resourceId, userId);

    if (!approval) {
      // Create a new approval request
      const result = await services.approval.createApprovalRequest({
        resourceId,
        context: {
          requesterId: userId,
          action: 'SECRET_ACCESS',
          reason: `CLI pull request for ${project.name}:${environment.name}`
        }
      });

      if (!result.success || !result.request) {
        throw new Error(`Failed to create approval request: ${result.error || 'Unknown error'}`);
      }
      approval = result.request;
    }

    if (!approval) {
      throw new Error('Approval request could not be found or created');
    }

    if (approval.status === 'PENDING') {
      rep.status(202);
      return {
        status: 'pending',
        message: 'Secret access is pending approval in Discord',
        requestId: approval.id
      };
    }

    if (approval.status === 'APPROVED') {
      const fields = await services.resource.listFields(resourceId);
      return { secrets: fieldsToSecrets(fields) };
    }

    throw new AccessDeniedError('Access denied: Secrets access not approved');
  });

  server.put('/api/projects/:projectId/environments/:envId/secrets', {
    preHandler: [authenticate]
  }, async (req, rep) => {
    const { projectId, envId } = req.params as { projectId: string; envId: string };
    const { secrets } = req.body as { secrets: Record<string, string> };
    const userId = (req as any).user.id;

    const project = await services.project.getProject(projectId);
    if (!project) throw new ResourceNotFoundError('Project not found');
    if (project.ownerId !== userId) throw new AccessDeniedError('Access denied');

    const environment = await services.project.getEnvironmentById(projectId, envId);
    if (!environment) throw new ResourceNotFoundError('Environment not found');
    if (!environment.resourceId) throw new ResourceNotFoundError('Environment has no linked resource');

    // Upsert fields in parallel to improve performance when many secrets are provided
    await Promise.all(
      Object.entries(secrets).map(([key, value]) =>
        services.resource.upsertField(environment.resourceId!, key, value)
      )
    );

    return { success: true };
  });

  // ---------------------------------------------------------------------------
  // Resource Field Endpoints
  // ---------------------------------------------------------------------------

  server.get<{ Params: z.infer<typeof ResourceParamsSchema> }>('/api/resources/:id/fields', {
    preHandler: [authenticate, verifyIsGuardian],
    schema: {
      params: ResourceParamsSchema
    }
  }, async (req) => {
    const { id } = req.params;
    const fields = await services.resource.listFields(id);
    return fields.map(f => f.name);
  });

  server.post<{ Params: z.infer<typeof ResourceParamsSchema>, Body: z.infer<typeof CreateResourceFieldSchema> }>('/api/resources/:id/fields', {
    preHandler: [authenticate, verifyIsGuardian],
    schema: {
      params: ResourceParamsSchema,
      body: CreateResourceFieldSchema
    }
  }, async (req, rep) => {
    const { id } = req.params;
    const { name, value } = req.body;

    const field = await services.resource.createField(id, name, value);
    return rep.status(201).send(field);
  });

  server.get<{ Params: z.infer<typeof FieldParamsSchema> }>('/api/resources/:id/fields/:name', {
    preHandler: [authenticate, verifyIsGuardian],
    schema: {
      params: FieldParamsSchema
    }
  }, async (req) => {
    const { id, name } = req.params;

    const field = await services.resource.getField(id, name);
    if (!field) {
      throw new ResourceNotFoundError(`Field '${name}' not found`);
    }

    return { name: field.name, value: field.value };
  });

  server.delete<{ Params: z.infer<typeof FieldParamsSchema> }>('/api/resources/:id/fields/:name', {
    preHandler: [authenticate, verifyIsGuardian],
    schema: {
      params: FieldParamsSchema
    }
  }, async (req, rep) => {
    const { id, name } = req.params;

    await services.resource.deleteField(id, name);
    return rep.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Resource 2FA Endpoints
  // ---------------------------------------------------------------------------

  server.get<{ Params: z.infer<typeof ResourceParamsSchema> }>('/api/resources/:id/2fa', {
    preHandler: [authenticate, verifyIsGuardian],
    schema: {
      params: ResourceParamsSchema
    }
  }, async (req) => {
    const { id } = req.params;

    const account = await services.resource.getLinkedTOTPAccount(id);
    if (!account) {
      throw new ResourceNotFoundError('No 2FA account linked to this resource');
    }

    const code = generateTOTPCode(account);
    return { code };
  });

  server.post<{ Params: z.infer<typeof ResourceParamsSchema>, Body: z.infer<typeof LinkTotpSchema> }>('/api/resources/:id/2fa/link', {
    preHandler: [authenticate, verifyIsGuardian],
    schema: {
      params: ResourceParamsSchema,
      body: LinkTotpSchema
    }
  }, async (req, rep) => {
    const { id } = req.params;
    const { totpAccountId } = req.body;
    const userId = req.user.id; // Actor ID

    await services.resource.linkTOTPAccount(id, totpAccountId, userId);
    return rep.status(200).send({ success: true });
  });

  server.delete<{ Params: z.infer<typeof ResourceParamsSchema> }>('/api/resources/:id/2fa/link', {
    preHandler: [authenticate, verifyIsGuardian],
    schema: {
      params: ResourceParamsSchema
    }
  }, async (req, rep) => {
    const { id } = req.params;

    await services.resource.unlinkTOTPAccount(id);
    return rep.status(204).send();
  });

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

function fieldsToSecrets(fields: ResourceField[]): Record<string, string> {
  return Object.fromEntries(fields.map(f => [f.name, f.value]));
}
