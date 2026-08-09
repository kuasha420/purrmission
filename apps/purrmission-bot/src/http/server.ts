/**
 * Fastify HTTP server setup.
 *
 * Provides the HTTP API for external services to request approvals.
 */
import formBody from '@fastify/formbody';
import type { Client } from 'discord.js';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  AccessDeniedError,
  ExpiredTokenError,
  ForbiddenError,
  InvalidGrantError,
  SlowDownError,
} from '../domain/auth.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import type { Capability, Principal } from '../domain/models.js';
import { createDiscordPrincipal } from '../domain/principal.js';
import type { Services } from '../domain/services.js';
import { logger } from '../logging/logger.js';
import {
  correlationStorage,
  isValidCorrelationId,
  resolveCorrelationId,
} from '../logging/correlationContext.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string };
    principal?: Principal;
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

function safeRoute(request: FastifyRequest): string {
  return request.routeOptions.url || request.url.split('?', 1)[0] || 'unmatched';
}

/**
 * Create and configure the Fastify server.
 */
export function createHttpServer(deps: HttpServerDeps): FastifyInstance {
  const { services, discordClient } = deps;

  function extractPrincipal(req: FastifyRequest, userId: string): Principal {
    if (req.principal) {
      return {
        ...req.principal,
        correlationId: req.correlationId ?? req.principal.correlationId,
      };
    }
    return createDiscordPrincipal(userId, req.correlationId);
  }

  const server = Fastify({
    logger: false, // We use our own logger
  });

  // Generate and attach correlation ID
  server.addHook('onRequest', (request, reply, done) => {
    let correlationId: string;
    try {
      correlationId = resolveCorrelationId(request.headers['x-correlation-id']);
    } catch {
      void reply.status(400).send({ error: 'Invalid x-correlation-id header' });
      return;
    }
    request.headers['x-correlation-id'] = correlationId;
    request.correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);

    const causationId = request.headers['x-causation-id'];
    if (causationId !== undefined && !isValidCorrelationId(causationId)) {
      void reply.status(400).send({ error: 'Invalid x-causation-id header' });
      return;
    }

    correlationStorage.run({ correlationId, causationId, surface: 'HTTP' }, () => {
      done();
    });
  });

  // Log incoming requests inside correlation storage context
  server.addHook('preHandler', async (request) => {
    logger.info('HTTP Request received', {
      method: request.method,
      route: safeRoute(request),
      correlationId: request.correlationId,
    });
  });

  server.addHook('onError', async (request, _reply, error) => {
    logger.error('HTTP Request failed', {
      method: request.method,
      route: safeRoute(request),
      correlationId: request.correlationId,
      errorType: error.name,
    });
  });

  // Log response completion
  server.addHook('onResponse', async (request, reply) => {
    logger.info('HTTP Response sent', {
      method: request.method,
      route: safeRoute(request),
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

    // Discord notification is enqueued via the transactional outbox and processed by the worker

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

      const principal = extractPrincipal(request, userId);

      try {
        const approvalRequest = await services.ports.getApprovalRequest(principal, id);
        if (!approvalRequest) {
          return reply.status(404).send({
            error: 'Request not found',
          });
        }

        let grantId: string | null = null;
        if (approvalRequest.status === 'APPROVED') {
          const grant = await services.ports.getApprovalGrantByRequestId(principal, id);
          if (grant) {
            grantId = grant.id;
          }
        }

        return {
          requestId: approvalRequest.id,
          resourceId: approvalRequest.resourceId,
          status: approvalRequest.status,
          createdAt: approvalRequest.createdAt.toISOString(),
          expiresAt: approvalRequest.expiresAt.toISOString(),
          resolvedBy: approvalRequest.resolvedBy ?? null,
          resolvedAt: approvalRequest.resolvedAt?.toISOString() ?? null,
          grantId,
        };
      } catch (err) {
        if (err instanceof ForbiddenError) {
          throw new AccessDeniedError(
            'Access denied: You do not have permission to view this request.'
          );
        }
        throw err;
      }
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
          expires_in: result.apiToken.expiresAt
            ? Math.round((result.apiToken.expiresAt.getTime() - Date.now()) / 1000)
            : 0,
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
    req.user = { id: principal.subjectId };
    req.principal = principal;
  }

  const requireResourceCapability = async (
    req: FastifyRequest,
    capability: Capability,
    resourceId: string,
    fieldName?: string
  ): Promise<Principal> => {
    const principal = extractPrincipal(req, req.user.id);
    const decision = await services.resource.evaluateCapability(principal, capability, {
      resourceId,
      ...(fieldName ? { fieldName } : {}),
    });
    if (!decision.allowed) {
      throw new ForbiddenError(decision.safeExplanation);
    }
    return principal;
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
    async (_req, rep) => {
      // Secret redemption is a state-changing, one-time grant consumption and therefore must not
      // happen on GET. This legacy route intentionally performs no policy lookup, approval
      // creation, grant consumption, or value-bearing repository read.
      return rep.status(405).header('allow', 'PUT').send({
        error: 'method_not_allowed',
        message:
          'Secret value retrieval is unavailable. PUT replaces secrets and does not redeem access.',
      });
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

      const principal = extractPrincipal(req, userId);

      await services.resource.setSecrets(resourceId, secrets, principal);

      return { success: true };
    }
  );

  // ---------------------------------------------------------------------------
  // Resource Field Endpoints
  // ---------------------------------------------------------------------------

  server.get<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/resources/:id/fields',
    {
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
      },
    },
    async (req) => {
      const { id } = req.params;
      await requireResourceCapability(req, 'secret.metadata.read', id);
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
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
        body: CreateResourceFieldSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const { name, value } = req.body;
      await requireResourceCapability(req, 'secret.write', id, name);

      const principal = extractPrincipal(req, req.principal?.subjectId ?? 'unknown');
      const field = await services.resource.createField(id, name, value, principal);
      return rep.status(201).send(field);
    }
  );

  server.get<{ Params: z.infer<typeof FieldParamsSchema> }>(
    '/api/resources/:id/fields/:name',
    {
      preHandler: [authenticate],
      schema: {
        params: FieldParamsSchema,
      },
    },
    async (req) => {
      const { id, name } = req.params;
      await requireResourceCapability(req, 'secret.value.read', id, name);

      const principal = extractPrincipal(req, req.principal?.subjectId ?? 'unknown');
      const field = await services.resource.revealField(id, name, principal);
      if (!field) {
        throw new ResourceNotFoundError(`Field '${name}' not found`);
      }

      return { name: field.name, value: field.value };
    }
  );

  server.delete<{ Params: z.infer<typeof FieldParamsSchema> }>(
    '/api/resources/:id/fields/:name',
    {
      preHandler: [authenticate],
      schema: {
        params: FieldParamsSchema,
      },
    },
    async (req, rep) => {
      const { id, name } = req.params;
      await requireResourceCapability(req, 'secret.delete', id, name);

      const principal = extractPrincipal(req, req.principal?.subjectId ?? 'unknown');
      await services.resource.deleteField(id, name, principal);
      return rep.status(204).send();
    }
  );

  // ---------------------------------------------------------------------------
  // Resource 2FA Endpoints
  // ---------------------------------------------------------------------------

  server.post<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/resources/:id/2fa/code',
    {
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const userId = req.user.id;
      const principal = extractPrincipal(req, userId);

      const code = await services.resource.revealTOTPCode(id, principal);
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
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
        body: LinkTotpSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const { totpAccountId, consentId } = req.body;
      const principal = extractPrincipal(req, req.user.id);

      await services.resource.linkTOTPAccount(id, totpAccountId, principal, consentId);
      return rep.status(200).send({ success: true });
    }
  );

  server.delete<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/resources/:id/2fa/link',
    {
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const principal = extractPrincipal(req, req.user.id);

      await services.resource.unlinkTOTPAccount(id, principal);
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
