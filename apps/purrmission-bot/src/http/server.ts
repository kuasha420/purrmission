/**
 * Fastify HTTP server setup.
 *
 * Provides the HTTP API for external services to request approvals.
 */
import formBody from '@fastify/formbody';
import type { Client, TextChannel } from 'discord.js';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  createAccessRequestEmbed,
  createApprovalButtons,
  createApprovalEmbed,
  isAccessRequestContext,
} from '../discord/interactions/approvalButtons.js';
import {
  AccessDeniedError,
  ExpiredTokenError,
  ForbiddenError,
  InvalidGrantError,
  SlowDownError,
} from '../domain/auth.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import type { ApprovalRequest, ResourceField } from '../domain/models.js';
import type { Services } from '../domain/services.js';
import { logger } from '../logging/logger.js';
import crypto from 'node:crypto';
import { correlationStorage } from '../logging/correlationContext.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string };
    correlationId?: string;
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

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') {
    return body;
  }
  const sensitiveKeys = ['value', 'secret', 'apiKey', 'token', 'access_token', 'device_code'];
  const redact = (obj: unknown): unknown => {
    if (Array.isArray(obj)) {
      return obj.map(redact);
    }
    if (obj && typeof obj === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))) {
          copy[key] = '[REDACTED]';
        } else {
          copy[key] = redact(val);
        }
      }
      return copy;
    }
    return obj;
  };
  return redact(body);
}

/**
 * Create and configure the Fastify server.
 */
export function createHttpServer(deps: HttpServerDeps): FastifyInstance {
  const { services, discordClient } = deps;

  const server = Fastify({
    logger: false, // We use our own logger
  });

  // Generate and attach correlation ID
  server.addHook('onRequest', (request, reply, done) => {
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    request.correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);

    correlationStorage.run({ correlationId }, () => {
      done();
    });
  });

  // Log incoming requests inside correlation storage context
  server.addHook('preHandler', async (request) => {
    const redactedBody = redactBody(request.body);
    logger.info('HTTP Request received', {
      method: request.method,
      url: request.url,
      body: redactedBody,
    });
  });

  // Log response completion
  server.addHook('onResponse', async (request, reply) => {
    logger.info('HTTP Response sent', {
      method: request.method,
      url: request.url,
      correlationId: request.correlationId,
      statusCode: reply.statusCode,
      responseTimeMs: reply.elapsedTime,
    });
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
      requesterId: resource.id,
      requesterType: 'SERVICE',
      authKind: 'API_KEY',
      action: 'resource.view',
      targetVersion: resource.version,
      policyVersion: resource.version,
    });

    if (!result.success) {
      logger.error('Failed to create approval request', {
        error: result.error,
      });
      return reply.status(400).send({
        error: result.error,
      });
    }

    if (!result.request) {
      throw new Error('Approval request creation failed unexpectedly');
    }
    const approvalRequest = result.request;

    // Send Discord message to guardians
    try {
      await sendApprovalMessage(deps, result, body.channelId);
    } catch (error) {
      logger.warn('Failed to send Discord notification for approval request', {
        requestId: approvalRequest.id,
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
      expiresAt: approvalRequest.expiresAt.toISOString(),
    });
  });

  // Get request status endpoint
  server.get<{ Params: { id: string } }>(
    '/api/requests/:id',
    {
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user.id;

      const approvalRequest = await services.approval.getApprovalRequest(id);
      if (!approvalRequest) {
        return reply.status(404).send({
          error: 'Request not found',
        });
      }

      // Exact-object authorization
      const isRequester = approvalRequest.requesterId === userId;
      const isGuardian = await services.resource.isGuardian(approvalRequest.resourceId, userId);

      if (!isRequester && !isGuardian) {
        throw new AccessDeniedError(
          'Access denied: You do not have permission to view this request.'
        );
      }

      return {
        requestId: approvalRequest.id,
        resourceId: approvalRequest.resourceId,
        status: approvalRequest.status,
        createdAt: approvalRequest.createdAt.toISOString(),
        expiresAt: approvalRequest.expiresAt.toISOString(),
        resolvedBy: approvalRequest.resolvedBy ?? null,
        resolvedAt: approvalRequest.resolvedAt?.toISOString() ?? null,
      };
    }
  );

  // Device Auth Flow: Initiate
  server.post('/api/auth/device/code', async (request, reply) => {
    try {
      const result = await services.auth.initiateDeviceFlow(request.ip);
      return {
        device_code: result.deviceCode,
        user_code: result.userCode,
        verification_uri: result.verificationUri,
        expires_in: result.expiresIn,
        interval: result.interval,
      };
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('Rate limit exceeded')) {
        return reply
          .status(429)
          .send({ error: 'slow_down', error_description: 'Rate limit exceeded' });
      }
      throw e;
    }
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
        if (e instanceof SlowDownError) {
          return reply.status(400).send({ error: 'slow_down' });
        }
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
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
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
    consentId: z.string().uuid(),
  });

  // Authentication Hook
  async function authenticate(req: FastifyRequest, _rep: FastifyReply) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AccessDeniedError('Missing Bearer token');
    }
    const token = authHeader.substring(7);
    const principal = await services.auth.validateToken(token, req.ip);
    if (!principal) {
      throw new AccessDeniedError('Invalid token');
    }
    // Attach user and principal to request
    req.user = { id: principal.subjectId || (principal as any).userId };
    (req as any).principal = principal;
  }

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
    const err = error as Error & { name?: string; message?: string };
    if (err.name === 'DuplicateError') {
      return reply.status(409).send({ error: err.message });
    }
    if (err.name === 'ResourceNotFoundError') {
      return reply.status(404).send({ error: err.message });
    }
    if (err.name === 'AccessDeniedError') {
      return reply.status(401).send({ error: 'unauthorized', message: err.message });
    }
    if (err.name === 'ForbiddenError') {
      return reply.status(403).send({
        error: 'INSUFFICIENT_PERMISSIONS',
        message: err.message,
      });
    }
    if (err.name === 'InvalidGrantError') {
      return reply.status(400).send({ error: 'invalid_grant', message: err.message });
    }
    if (err.name === 'ExpiredTokenError') {
      return reply.status(400).send({ error: 'expired_token' });
    }

    // Default handler
    logger.error('Unhandled API error', {
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
    });
    return reply.status(500).send({ error: 'internal_server_error' });
  });
  server.post(
    '/api/projects',
    {
      preHandler: [authenticate],
      schema: {
        body: CreateProjectSchema,
      },
    },
    async (req, rep) => {
      const { name, description } = req.body as z.infer<typeof CreateProjectSchema>;
      const userId = req.user.id;

      const project = await services.project.createProject({
        name,
        description,
        ownerId: userId,
      });

      return rep.status(201).send(project);
    }
  );

  server.get(
    '/api/projects',
    {
      preHandler: [authenticate],
    },
    async (req, _rep) => {
      const userId = req.user.id;
      const projects = await services.project.listProjects(userId);
      return projects;
    }
  );

  server.get(
    '/api/projects/:projectId',
    {
      preHandler: [authenticate],
      schema: {
        params: ProjectParamsSchema,
      },
    },
    async (req, _rep) => {
      const { projectId } = req.params as z.infer<typeof ProjectParamsSchema>;
      const userId = req.user.id;

      const project = await services.project.getProject(projectId);
      if (!project) throw new ResourceNotFoundError('Project not found');

      const role = await services.project.getMemberRole(projectId, userId);
      if (project.ownerId !== userId && !role) throw new AccessDeniedError('Access denied');

      return project;
    }
  );

  server.post(
    '/api/projects/:projectId/environments',
    {
      preHandler: [authenticate],
      schema: {
        params: ProjectParamsSchema,
        body: CreateEnvironmentSchema,
      },
    },
    async (req, rep) => {
      const { projectId } = req.params as z.infer<typeof ProjectParamsSchema>;
      const { name, slug } = req.body as z.infer<typeof CreateEnvironmentSchema>;
      const userId = req.user.id;

      const project = await services.project.getProject(projectId);
      if (!project) throw new ResourceNotFoundError('Project not found');
      if (project.ownerId !== userId) throw new AccessDeniedError('Access denied');

      const env = await services.project.createEnvironment({
        name,
        slug,
        projectId,
      });
      return rep.status(201).send(env);
    }
  );

  server.get(
    '/api/projects/:projectId/environments',
    {
      preHandler: [authenticate],
      schema: {
        params: ProjectParamsSchema,
      },
    },
    async (req, _rep) => {
      const { projectId } = req.params as z.infer<typeof ProjectParamsSchema>;
      const userId = req.user.id;

      const project = await services.project.getProject(projectId);
      if (!project) throw new ResourceNotFoundError('Project not found');

      const role = await services.project.getMemberRole(projectId, userId);
      if (project.ownerId !== userId && !role) throw new AccessDeniedError('Access denied');

      const envs = await services.project.listEnvironments(projectId);
      return envs;
    }
  );

  server.get(
    '/api/projects/:projectId/environments/:envId/secrets',
    {
      preHandler: [authenticate],
    },
    async (req, rep) => {
      const { projectId, envId } = req.params as { projectId: string; envId: string };
      const userId = req.user.id;

      const project = await services.project.getProject(projectId);
      if (!project) throw new ResourceNotFoundError('Project not found');

      const environment = await services.project.getEnvironmentById(projectId, envId);
      if (!environment) throw new ResourceNotFoundError('Environment not found');
      if (!environment.resourceId)
        throw new ResourceNotFoundError('Environment has no linked resource');

      const resourceId = environment.resourceId;

      // Project owner has immediate access
      if (project.ownerId === userId) {
        const fields = await services.resource.listFields(resourceId);
        return { secrets: fieldsToSecrets(fields) };
      }

      // Project Members (READER or WRITER) have immediate access
      const memberRole = await services.project.getMemberRole(projectId, userId);
      if (memberRole === 'READER' || memberRole === 'WRITER') {
        const fields = await services.resource.listFields(resourceId);
        return { secrets: fieldsToSecrets(fields) };
      }

      // Guardians also have immediate access
      const isGuardian = await services.resource.isGuardian(resourceId, userId);
      if (isGuardian) {
        const fields = await services.resource.listFields(resourceId);
        return { secrets: fieldsToSecrets(fields) };
      }

      // Fetch the current resource version for V2 state tracking
      let targetVersion = 'v1';
      if (typeof services.resource.getResource === 'function') {
        const resourceObj = await services.resource.getResource(resourceId);
        targetVersion = resourceObj?.version || 'v1';
      }

      // Non-owner/non-guardian: Check for active approval or create one
      let approval: ApprovalRequest | null = await services.approval.findActiveApproval(
        resourceId,
        userId,
        'secrets.read'
      );

      if (!approval) {
        // Create a new approval request
        const result = await services.approval.createApprovalRequest({
          resourceId,
          requesterId: userId,
          requesterType: (req as any).principal?.type || 'DISCORD_USER',
          authKind: (req as any).principal?.authKind || 'DISCORD',
          action: 'secrets.read',
          targetVersion,
          policyVersion: targetVersion,
          context: {
            requesterId: userId,
            type: 'SECRET_ACCESS',
            description: `CLI pull request for ${project.name}:${environment.name}`,
          },
        });

        if (!result.success || !result.request) {
          throw new Error(`Failed to create approval request: ${result.error || 'Unknown error'}`);
        }
        approval = result.request;

        // Send Discord notification to guardians
        try {
          await sendApprovalMessage(deps, result);
        } catch (notifyError) {
          logger.warn('Failed to send Discord notification for approval request', {
            requestId: approval.id,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
          // Continue anyway - the request was created successfully
        }
      }

      if (!approval) {
        throw new Error('Approval request could not be found or created');
      }

      if (approval.status === 'PENDING') {
        rep.status(202);
        return {
          status: 'pending',
          message: 'Secret access is pending approval in Discord',
          requestId: approval.id,
        };
      }

      if (approval.status === 'APPROVED') {
        // Find active unconsumed grant
        let activeGrant = null;
        if (typeof services.approval.findActiveUnconsumedGrant === 'function') {
          activeGrant = await services.approval.findActiveUnconsumedGrant(
            resourceId,
            userId,
            'secrets.read',
            null
          );
        }

        if (activeGrant) {
          // Atomically consume the grant
          const prisma = getPrismaClient();
          try {
            await prisma.$transaction(async (tx) => {
              await services.approval.consumeGrant(
                activeGrant.id,
                (req as any).principal || {
                  type: 'DISCORD_USER',
                  id: userId,
                  authKind: 'DISCORD',
                  actorDiscordId: userId,
                },
                'secrets.read',
                targetVersion,
                targetVersion,
                tx
              );
            });
          } catch (consumeErr) {
            logger.error('Failed to consume approval grant for secrets access', {
              resourceId,
              userId,
              error: consumeErr instanceof Error ? consumeErr.message : String(consumeErr),
            });
            throw consumeErr;
          }
        } else {
          const hasGrantRepo = !!(services.approval as any).deps?.repositories?.approvalGrants;
          if (hasGrantRepo) {
            throw new AccessDeniedError(
              'Access denied: No active unconsumed approval grant found. Please request approval again.'
            );
          }
        }

        const fields = await services.resource.listFields(resourceId);
        return { secrets: fieldsToSecrets(fields) };
      }

      throw new AccessDeniedError('Access denied: Secrets access not approved');
    }
  );

  server.put(
    '/api/projects/:projectId/environments/:envId/secrets',
    {
      preHandler: [authenticate],
    },
    async (req, _rep) => {
      const { projectId, envId } = req.params as { projectId: string; envId: string };
      const { secrets } = req.body as { secrets: Record<string, string> };
      const userId = req.user.id;

      const project = await services.project.getProject(projectId);
      if (!project) throw new ResourceNotFoundError('Project not found');

      // Access Control: Owner OR Writer
      let hasWriteAccess = project.ownerId === userId;
      if (!hasWriteAccess) {
        const role = await services.project.getMemberRole(projectId, userId);
        hasWriteAccess = role === 'WRITER';
      }

      if (!hasWriteAccess) {
        throw new ForbiddenError('Write permission required');
      }

      const environment = await services.project.getEnvironmentById(projectId, envId);
      if (!environment) throw new ResourceNotFoundError('Environment not found');
      if (!environment.resourceId)
        throw new ResourceNotFoundError('Environment has no linked resource');

      const resourceId = environment.resourceId;

      // Upsert fields in parallel to improve performance when many secrets are provided
      await Promise.all(
        Object.entries(secrets).map(([key, value]) =>
          services.resource.upsertField(resourceId, key, value)
        )
      );

      return { success: true };
    }
  );

  // ---------------------------------------------------------------------------
  // Resource Field Endpoints
  // ---------------------------------------------------------------------------

  server.get<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/resources/:id/fields',
    {
      preHandler: [authenticate, verifyIsGuardian],
      schema: {
        params: ResourceParamsSchema,
      },
    },
    async (req) => {
      const { id } = req.params;
      const fields = await services.resource.listFieldsMetadata(id);
      return fields.map((f) => f.name);
    }
  );

  server.post<{
    Params: z.infer<typeof ResourceParamsSchema>;
    Body: z.infer<typeof CreateResourceFieldSchema>;
  }>(
    '/api/resources/:id/fields',
    {
      preHandler: [authenticate, verifyIsGuardian],
      schema: {
        params: ResourceParamsSchema,
        body: CreateResourceFieldSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const { name, value } = req.body;

      const field = await services.resource.createField(id, name, value);
      return rep.status(201).send(field);
    }
  );

  server.get<{ Params: z.infer<typeof FieldParamsSchema> }>(
    '/api/resources/:id/fields/:name',
    {
      preHandler: [authenticate, verifyIsGuardian],
      schema: {
        params: FieldParamsSchema,
      },
    },
    async (req) => {
      const { id, name } = req.params;

      const field = await services.resource.getField(id, name);
      if (!field) {
        throw new ResourceNotFoundError(`Field '${name}' not found`);
      }

      return { name: field.name, value: field.value };
    }
  );

  server.delete<{ Params: z.infer<typeof FieldParamsSchema> }>(
    '/api/resources/:id/fields/:name',
    {
      preHandler: [authenticate, verifyIsGuardian],
      schema: {
        params: FieldParamsSchema,
      },
    },
    async (req, rep) => {
      const { id, name } = req.params;

      await services.resource.deleteField(id, name);
      return rep.status(204).send();
    }
  );

  // ---------------------------------------------------------------------------
  // Resource 2FA Endpoints
  // ---------------------------------------------------------------------------

  server.post<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/resources/:id/2fa/code',
    {
      preHandler: [authenticate, verifyIsGuardian],
      schema: {
        params: ResourceParamsSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const userId = req.user.id;

      const code = await services.resource.revealTOTPCode(id, userId);
      rep.header('Cache-Control', 'no-store');
      return { code };
    }
  );

  server.post<{
    Params: z.infer<typeof ResourceParamsSchema>;
    Body: z.infer<typeof LinkTotpSchema>;
  }>(
    '/api/resources/:id/2fa/link',
    {
      preHandler: [authenticate, verifyIsGuardian],
      schema: {
        params: ResourceParamsSchema,
        body: LinkTotpSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const { totpAccountId, consentId } = req.body;
      const userId = req.user.id; // Actor ID

      await services.resource.linkTOTPAccount(id, totpAccountId, userId, consentId);
      return rep.status(200).send({ success: true });
    }
  );

  server.delete<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/resources/:id/2fa/link',
    {
      preHandler: [authenticate, verifyIsGuardian],
      schema: {
        params: ResourceParamsSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const userId = req.user.id;

      await services.resource.unlinkTOTPAccount(id, userId);
      return rep.status(204).send();
    }
  );

  server.post<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/totp/:id/recovery',
    {
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params; // TOTP Account ID
      const userId = req.user.id;

      const recoveryKey = await services.resource.revealTOTPRecoveryKey(id, userId);
      rep.header('Cache-Control', 'no-store');
      return { recoveryKey };
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
      const embed = isAccessRequestContext(request.context)
        ? createAccessRequestEmbed(resource.name, request.context, request.expiresAt)
        : createApprovalEmbed(resource.name, request.context, request.expiresAt);
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
    const embed = isAccessRequestContext(request.context)
      ? createAccessRequestEmbed(resource.name, request.context, request.expiresAt)
      : createApprovalEmbed(resource.name, request.context, request.expiresAt);
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
  return Object.fromEntries(fields.map((f) => [f.name, f.value]));
}
