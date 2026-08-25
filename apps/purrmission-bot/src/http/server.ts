/**
 * Fastify HTTP server setup.
 *
 * Provides the authenticated HTTP API for external services and Pawthy CLI.
 */
import formBody from '@fastify/formbody';
import type { Client } from 'discord.js';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  AccessDeniedError,
  ExpiredTokenError,
  InvalidGrantError,
  SlowDownError,
} from '../domain/auth.js';
import { DomainError, ForbiddenError, NotFoundError } from '../domain/ports.js';
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
  action: z.string().min(1).optional().default('secret.value.read'),
  targetKey: z.string().nullable().optional(),
  context: z.record(z.unknown()).optional().default({}),
  callbackUrl: z
    .never({
      message:
        'Arbitrary callback URLs are forbidden; use registered destinations via /api/resources/:id/callbacks',
    })
    .optional(),
  channelId: z
    .never({
      message: 'Direct channelId routing is forbidden',
    })
    .optional(),
  destinationId: z.string().uuid().optional(),
  expiresInMs: z.number().positive().optional(),
  reason: z.string().max(500).optional(),
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
      done();
      return;
    }
    request.headers['x-correlation-id'] = correlationId;
    request.correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);

    const causationId = request.headers['x-causation-id'];
    if (causationId !== undefined && !isValidCorrelationId(causationId)) {
      void reply.status(400).send({ error: 'Invalid x-causation-id header' });
      done();
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

  // ---------------------------------------------------------------------------
  // Approval Requests
  // ---------------------------------------------------------------------------

  // Create approval request endpoint
  server.post<{ Body: CreateRequestBody }>('/api/requests', async (request, reply) => {
    // Check for raw callbackUrl / channelId before safeParse to provide clear error message
    const rawBody = (request.body || {}) as Record<string, unknown>;
    if (rawBody.callbackUrl !== undefined) {
      return reply.status(400).send({
        error: 'validation_error',
        message:
          'Arbitrary callback URLs are forbidden; use registered destinations via /api/resources/:id/callbacks',
      });
    }
    if (rawBody.channelId !== undefined) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Direct channelId routing is forbidden',
      });
    }

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
    const authentication = await services.resource.verifyApiKey(body.apiKey, request.ip);
    if (!authentication) {
      logger.warn('Invalid API key', { resourceId: body.resourceId });
      return reply.status(401).send({
        error: 'Invalid API key',
      });
    }
    const { resource, principal } = authentication;

    // Verify resourceId matches the API key resource
    if (resource.id !== body.resourceId) {
      logger.warn('Resource ID mismatch', {
        providedResourceId: body.resourceId,
        apiKeyResourceId: resource.id,
      });
      return reply.status(401).send({
        error: 'Resource ID does not match API key',
      });
    }

    // Create the approval request via DomainPorts
    const result = await services.ports.createApprovalRequest(
      principal,
      body.resourceId,
      body.action,
      body.targetKey ?? null,
      {
        reason: body.reason,
        expiresInMs: body.expiresInMs,
      },
      request.correlationId
    );

    if (!result.success || !result.request) {
      logger.error('Failed to create approval request', {
        error: result.error,
      });
      return reply.status(400).send({
        error: result.error ?? 'Failed to create approval request',
      });
    }
    const approvalRequest = result.request;

    logger.info('Approval request created via API', {
      requestId: approvalRequest.id,
      resourceId: resource.id,
    });

    return reply.header('Cache-Control', 'no-store').status(201).send({
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
        const approvalRequest = await services.ports.getApprovalRequest(
          principal,
          id,
          request.correlationId
        );
        if (!approvalRequest) {
          return reply.status(404).send({
            error: 'not_found',
            message: 'Request not found',
          });
        }

        let grantId: string | null = null;
        if (approvalRequest.status === 'APPROVED') {
          const grant = await services.ports.getApprovalGrantByRequestId(
            principal,
            id,
            request.correlationId
          );
          if (grant) {
            grantId = grant.id;
          }
        }

        return reply.header('Cache-Control', 'no-store').send({
          requestId: approvalRequest.id,
          resourceId: approvalRequest.resourceId,
          status: approvalRequest.status,
          createdAt: approvalRequest.createdAt.toISOString(),
          expiresAt: approvalRequest.expiresAt.toISOString(),
          resolvedBy: approvalRequest.resolvedBy ?? null,
          resolvedAt: approvalRequest.resolvedAt?.toISOString() ?? null,
          grantId,
        });
      } catch (err) {
        if (err instanceof ForbiddenError || err instanceof AccessDeniedError) {
          return reply.status(404).send({
            error: 'not_found',
            message: 'Request not found',
          });
        }
        throw err;
      }
    }
  );

  // Decide request endpoint (Guardian approval / denial)
  const DecideRequestSchema = z
    .object({
      decision: z.enum(['APPROVE', 'DENY']),
      consentId: z.string().uuid().optional(),
    })
    .strict();

  server.post<{ Params: { id: string }; Body: z.infer<typeof DecideRequestSchema> }>(
    '/api/requests/:id/decide',
    {
      preHandler: [authenticate],
      schema: { body: DecideRequestSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { decision, consentId } = request.body;
      const principal = extractPrincipal(request, request.user.id);

      const result = await services.ports.recordApprovalDecision(
        principal,
        id,
        decision,
        consentId,
        request.correlationId
      );

      if (!result.success) {
        return reply.status(400).send({
          error: result.error ?? 'Failed to record decision',
        });
      }

      return reply
        .header('Cache-Control', 'no-store')
        .send({ success: true, status: decision === 'APPROVE' ? 'APPROVED' : 'DENIED' });
    }
  );

  // Cancel request endpoint (Requester cancellation)
  server.post<{ Params: { id: string } }>(
    '/api/requests/:id/cancel',
    {
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const { id } = request.params;
      const principal = extractPrincipal(request, request.user.id);

      const result = await services.ports.cancelApprovalRequest(
        principal,
        id,
        request.correlationId
      );

      if (!result.success) {
        return reply.status(400).send({
          error: result.error ?? 'Failed to cancel request',
        });
      }

      return reply.header('Cache-Control', 'no-store').send({ success: true, status: 'CANCELLED' });
    }
  );

  // ---------------------------------------------------------------------------
  // Device Auth Flow
  // ---------------------------------------------------------------------------

  // Device Auth Flow: Initiate
  server.post('/api/auth/device/code', async (request, reply) => {
    try {
      const result = await services.auth.initiateDeviceFlow(request.ip);
      return reply.header('Cache-Control', 'no-store').send({
        device_code: result.deviceCode,
        user_code: result.userCode,
        verification_uri: result.verificationUri,
        expires_in: result.expiresIn,
        interval: result.interval,
      });
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('Rate limit exceeded')) {
        return reply
          .status(429)
          .header('Cache-Control', 'no-store')
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

        return reply.header('Cache-Control', 'no-store').send({
          access_token: result.token,
          token_type: 'Bearer',
          expires_in: result.apiToken.expiresAt
            ? Math.round((result.apiToken.expiresAt.getTime() - Date.now()) / 1000)
            : 0,
        });
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
  const CreateProjectSchema = z
    .object({
      name: z.string().trim().min(1).max(128),
      description: z.string().max(1024).nullable().optional(),
    })
    .strict();

  const CreateEnvironmentSchema = z
    .object({
      name: z.string().trim().min(1).max(128),
      slug: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/),
    })
    .strict();

  const ProjectParamsSchema = z
    .object({
      projectId: z.string().uuid(),
    })
    .strict();

  const EnvironmentParamsSchema = z
    .object({
      projectId: z.string().uuid(),
      envId: z.string().uuid(),
    })
    .strict();

  const CreateResourceFieldSchema = z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/),
      value: z.string().max(10240),
    })
    .strict();

  const ResourceParamsSchema = z
    .object({
      id: z.string().uuid(),
    })
    .strict();

  const FieldParamsSchema = z
    .object({
      id: z.string().uuid(),
      name: z.string().trim().min(1),
    })
    .strict();

  const RevealFieldSchema = z
    .object({
      name: z.string().trim().min(1),
      grantId: z.string().uuid().optional(),
    })
    .strict();

  const PutSecretsSchema = z
    .object({
      secrets: z
        .record(z.string().min(1).max(250), z.string().max(65536))
        .refine((rec) => Object.keys(rec).length <= 100, {
          message: 'Secret batch count exceeds maximum of 100.',
        }),
    })
    .strict();

  const RevealSecretsSchema = z
    .object({
      keys: z.array(z.string().trim().min(1).max(250)).max(100).optional(),
      grantId: z.string().uuid().optional(),
    })
    .strict();

  const LinkTotpSchema = z
    .object({
      totpAccountId: z.string().uuid(),
      consentId: z.string().uuid(),
    })
    .strict();

  const TOTPLinkConsentSchema = z
    .object({
      resourceId: z.string().uuid(),
      initiatingResourceOwnerId: z.string().min(1).max(128),
      delegationPolicy: z
        .object({
          allowDelegation: z.boolean().optional(),
          allowedOperations: z.array(z.literal('totp.code.read')).max(1).optional(),
          allowedAuthFamilies: z.array(z.string().min(1).max(128)).max(8).optional(),
          allowedAudiences: z.array(z.string().min(1).max(128)).max(8).optional(),
          maxGrantTtlSeconds: z.number().int().min(1).max(300).optional(),
        })
        .strict()
        .default({}),
    })
    .strict();

  const TOTPDelegationConsentSchema = z
    .object({
      requesterId: z.string().min(1).max(128),
      operation: z.literal('totp.code.read'),
      authFamily: z.string().min(1).max(128),
      audience: z.string().min(1).max(128),
    })
    .strict();

  const RegisterCallbackSchema = z
    .object({
      url: z.string().url().max(1024),
      secret: z.string().min(16).max(256),
    })
    .strict();

  const CallbackParamsSchema = z
    .object({
      id: z.string().uuid(),
      callbackId: z.string().uuid(),
    })
    .strict();

  const RevealTOTPSchema = z
    .object({
      grantId: z.string().uuid().optional(),
      consentId: z.string().uuid().optional(),
    })
    .strict()
    .nullish();

  // Authentication Hook
  async function authenticate(req: FastifyRequest, _rep: FastifyReply) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AccessDeniedError('Missing Bearer token');
    }
    const token = authHeader.substring(7);
    const principal = await services.auth.validateToken(token, {
      clientIp: req.ip,
      audience: 'cli',
      allowedTypes: ['PAWTHY_TOKEN'],
    });
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

  const CredentialParamsSchema = z.object({ credentialId: z.string().uuid() }).strict();
  const ResourceCredentialParamsSchema = z
    .object({ id: z.string().uuid(), credentialId: z.string().uuid() })
    .strict();
  const MintCredentialSchema = z
    .object({
      name: z.string().trim().min(1).max(128),
      expiresInSeconds: z.number().int().min(60).max(31_536_000).optional(),
    })
    .strict();
  const ResourceServiceCapabilitySchema = z.enum([
    'resource.view',
    'secret.metadata.read',
    'secret.value.read',
    'secret.write',
    'secret.delete',
    'totp.metadata.read',
    'totp.code.read',
    'request.create',
    'request.view-own',
    'request.cancel-own',
  ]);
  const MintServiceCredentialSchema = z
    .object({
      serviceName: z.string().trim().min(1).max(128),
      name: z.string().trim().min(1).max(128),
      scopes: z.array(ResourceServiceCapabilitySchema).min(1).max(10),
      expiresInSeconds: z.number().int().min(60).max(31_536_000).optional(),
    })
    .strict();
  const withoutDigest = <T extends { digest: string }>(credential: T): Omit<T, 'digest'> => {
    const safe: Partial<T> = { ...credential };
    delete safe.digest;
    return safe as Omit<T, 'digest'>;
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
    const err = error as Error & { name?: string; message?: string; code?: string };
    const errCode = (err as unknown as DomainError).code;

    if (err.name === 'DuplicateError' || err.name === 'ConflictError' || errCode === 'CONFLICT') {
      return reply.status(409).send({ error: 'conflict', message: err.message });
    }
    if (
      err.name === 'ResourceNotFoundError' ||
      err.name === 'NotFoundError' ||
      errCode === 'NOT_FOUND'
    ) {
      return reply.status(404).send({ error: 'not_found', message: err.message });
    }
    if (
      err.name === 'AccessDeniedError' ||
      err.name === 'UnauthorizedError' ||
      err.name === 'AuthUnauthorizedError' ||
      errCode === 'UNAUTHORIZED'
    ) {
      return reply.status(401).send({ error: 'unauthorized', message: err.message });
    }
    if (
      err.name === 'ForbiddenError' ||
      err.name === 'AuthForbiddenError' ||
      errCode === 'FORBIDDEN'
    ) {
      return reply.status(403).send({
        error: 'INSUFFICIENT_PERMISSIONS',
        message: err.message,
      });
    }
    if (
      err.name === 'SlowDownError' ||
      err.name === 'RateLimitError' ||
      errCode === 'RATE_LIMIT_EXCEEDED' ||
      (err.message && err.message.includes('Rate limit exceeded'))
    ) {
      return reply.status(429).send({ error: 'slow_down', message: 'Rate limit exceeded' });
    }
    if (err.name === 'InvalidGrantError') {
      return reply.status(400).send({ error: 'invalid_grant', message: err.message });
    }
    if (err.name === 'ExpiredTokenError') {
      return reply.status(400).send({ error: 'expired_token' });
    }
    if (err.name === 'ValidationError' || errCode === 'VALIDATION_FAILED') {
      return reply.status(400).send({ error: 'validation_error', message: err.message });
    }

    // Default handler
    logger.error('Unhandled API error', {
      correlationId: request.correlationId,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
    });
    return reply.status(500).send({ error: 'internal_server_error' });
  });

  // ---------------------------------------------------------------------------
  // Auth & Credentials
  // ---------------------------------------------------------------------------

  server.get('/api/auth/credentials', { preHandler: [authenticate] }, async (req, rep) => {
    const principal = extractPrincipal(req, req.user.id);
    return rep
      .header('Cache-Control', 'no-store')
      .send(await services.auth.listOwnCredentials(principal));
  });

  server.post(
    '/api/auth/credentials/:credentialId/rotate',
    {
      preHandler: [authenticate],
      schema: { params: CredentialParamsSchema },
    },
    async (req, rep) => {
      const { credentialId } = req.params as z.infer<typeof CredentialParamsSchema>;
      const principal = extractPrincipal(req, req.user.id);
      const rotated = await services.auth.rotateOwnCredential(principal, credentialId);
      return rep.header('Cache-Control', 'no-store').status(201).send(rotated);
    }
  );

  server.delete(
    '/api/auth/credentials/:credentialId',
    {
      preHandler: [authenticate],
      schema: { params: CredentialParamsSchema },
    },
    async (req, rep) => {
      const { credentialId } = req.params as z.infer<typeof CredentialParamsSchema>;
      const principal = extractPrincipal(req, req.user.id);
      await services.auth.revokeOwnCredential(principal, credentialId);
      return rep.status(204).send();
    }
  );

  server.get(
    '/api/resources/:id/credentials',
    {
      preHandler: [authenticate],
      schema: { params: ResourceParamsSchema },
    },
    async (req, rep) => {
      const { id } = req.params as z.infer<typeof ResourceParamsSchema>;
      const principal = extractPrincipal(req, req.user.id);
      const credentials = await services.resource.listApiKeys(id, principal);
      return rep
        .header('Cache-Control', 'no-store')
        .send(credentials.map((credential) => withoutDigest(credential)));
    }
  );

  server.post(
    '/api/resources/:id/credentials',
    {
      preHandler: [authenticate],
      schema: { params: ResourceParamsSchema, body: MintCredentialSchema },
    },
    async (req, rep) => {
      const { id } = req.params as z.infer<typeof ResourceParamsSchema>;
      const body = req.body as z.infer<typeof MintCredentialSchema>;
      const principal = extractPrincipal(req, req.user.id);
      const created = await services.resource.mintApiKey(
        id,
        principal,
        body.name,
        body.expiresInSeconds ? body.expiresInSeconds * 1000 : undefined
      );
      return rep
        .header('Cache-Control', 'no-store')
        .status(201)
        .send({
          plaintext: created.plaintext,
          credential: withoutDigest(created.credential),
        });
    }
  );

  server.post(
    '/api/resources/:id/credentials/:credentialId/rotate',
    {
      preHandler: [authenticate],
      schema: { params: ResourceCredentialParamsSchema },
    },
    async (req, rep) => {
      const { id, credentialId } = req.params as z.infer<typeof ResourceCredentialParamsSchema>;
      const principal = extractPrincipal(req, req.user.id);
      const rotated = await services.resource.rotateApiKey(id, credentialId, principal);
      return rep
        .header('Cache-Control', 'no-store')
        .status(201)
        .send({
          plaintext: rotated.plaintext,
          credential: withoutDigest(rotated.credential),
        });
    }
  );

  server.post(
    '/api/resources/:id/service-credentials',
    {
      preHandler: [authenticate],
      schema: { params: ResourceParamsSchema, body: MintServiceCredentialSchema },
    },
    async (req, rep) => {
      const { id } = req.params as z.infer<typeof ResourceParamsSchema>;
      const body = req.body as z.infer<typeof MintServiceCredentialSchema>;
      const principal = extractPrincipal(req, req.user.id);
      const created = await services.resource.mintServiceCredential(
        id,
        principal,
        body.serviceName,
        body.name,
        body.scopes,
        body.expiresInSeconds ? body.expiresInSeconds * 1000 : undefined
      );
      return rep
        .header('Cache-Control', 'no-store')
        .status(201)
        .send({
          plaintext: created.plaintext,
          credential: withoutDigest(created.credential),
        });
    }
  );

  server.delete(
    '/api/resources/:id/credentials/:credentialId',
    {
      preHandler: [authenticate],
      schema: { params: ResourceCredentialParamsSchema },
    },
    async (req, rep) => {
      const { id, credentialId } = req.params as z.infer<typeof ResourceCredentialParamsSchema>;
      const principal = extractPrincipal(req, req.user.id);
      await services.resource.revokeApiKey(id, credentialId, principal);
      return rep.status(204).send();
    }
  );

  // ---------------------------------------------------------------------------
  // Projects & Environments (via DomainPorts)
  // ---------------------------------------------------------------------------

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
      const principal = extractPrincipal(req, userId);

      const project = await services.ports.createProject(
        principal,
        {
          name,
          description,
        },
        req.correlationId
      );

      return rep.header('Cache-Control', 'no-store').status(201).send(project);
    }
  );

  server.get(
    '/api/projects',
    {
      preHandler: [authenticate],
    },
    async (req, rep) => {
      const userId = req.user.id;
      const principal = extractPrincipal(req, userId);
      const projects = await services.ports.listProjects(principal, req.correlationId);
      return rep.header('Cache-Control', 'no-store').send(projects);
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
    async (req, rep) => {
      const { projectId } = req.params as z.infer<typeof ProjectParamsSchema>;
      const userId = req.user.id;
      const principal = extractPrincipal(req, userId);

      const project = await services.ports.getProject(principal, projectId, req.correlationId);
      if (!project) throw new NotFoundError('Project not found');

      return rep.header('Cache-Control', 'no-store').send(project);
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
      const principal = extractPrincipal(req, userId);

      const env = await services.ports.createEnvironment(
        principal,
        {
          name,
          slug,
          projectId,
        },
        req.correlationId
      );
      return rep.header('Cache-Control', 'no-store').status(201).send(env);
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
    async (req, rep) => {
      const { projectId } = req.params as z.infer<typeof ProjectParamsSchema>;
      const userId = req.user.id;
      const principal = extractPrincipal(req, userId);

      const envs = await services.ports.listEnvironments(principal, projectId, req.correlationId);
      return rep.header('Cache-Control', 'no-store').send(envs);
    }
  );

  server.get(
    '/api/projects/:projectId/environments/:envId/secrets',
    {
      preHandler: [authenticate],
      schema: {
        params: EnvironmentParamsSchema,
      },
    },
    async (_req, rep) => {
      // Secret redemption is a state-changing, one-time grant consumption and therefore must not
      // happen on GET. This legacy route intentionally performs no policy lookup, approval
      // creation, grant consumption, or value-bearing repository read.
      return rep.status(405).header('allow', 'PUT').header('Cache-Control', 'no-store').send({
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
      schema: {
        params: EnvironmentParamsSchema,
        body: PutSecretsSchema,
      },
    },
    async (req, rep) => {
      const { projectId, envId } = req.params as z.infer<typeof EnvironmentParamsSchema>;
      const { secrets } = req.body as z.infer<typeof PutSecretsSchema>;
      const userId = req.user.id;
      const principal = extractPrincipal(req, userId);

      await services.ports.setSecrets(
        principal,
        {
          projectId,
          envId,
          secrets,
        },
        req.correlationId
      );

      return rep.header('Cache-Control', 'no-store').send({ success: true });
    }
  );

  server.post(
    '/api/projects/:projectId/environments/:envId/secrets/reveal',
    {
      preHandler: [authenticate],
      schema: {
        params: EnvironmentParamsSchema,
        body: RevealSecretsSchema,
      },
    },
    async (req, rep) => {
      const { projectId, envId } = req.params as z.infer<typeof EnvironmentParamsSchema>;
      const { keys, grantId } = (req.body || {}) as z.infer<typeof RevealSecretsSchema>;
      const userId = req.user.id;
      const principal = extractPrincipal(req, userId);

      const secrets = await services.ports.revealSecrets(
        principal,
        projectId,
        envId,
        { keys, grantId },
        req.correlationId
      );

      return rep.header('Cache-Control', 'no-store').send({ secrets });
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
    async (req, rep) => {
      const { id } = req.params;
      await requireResourceCapability(req, 'secret.metadata.read', id);
      const fields = await services.resource.listFieldsMetadata(id);
      return rep.header('Cache-Control', 'no-store').send(fields.map((f) => f.name));
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
      return rep.header('Cache-Control', 'no-store').status(201).send(field);
    }
  );

  // Legacy GET reveal route disabled -> 405 Method Not Allowed
  server.get<{ Params: z.infer<typeof FieldParamsSchema> }>(
    '/api/resources/:id/fields/:name',
    {
      preHandler: [authenticate],
      schema: {
        params: FieldParamsSchema,
      },
    },
    async (_req, rep) => {
      return rep.status(405).header('allow', 'POST').header('Cache-Control', 'no-store').send({
        error: 'method_not_allowed',
        message:
          'Secret field reveal via GET is disabled. Use authenticated POST /api/resources/:id/fields/reveal.',
      });
    }
  );

  // Authenticated POST reveal route
  server.post<{
    Params: z.infer<typeof ResourceParamsSchema>;
    Body: z.infer<typeof RevealFieldSchema>;
  }>(
    '/api/resources/:id/fields/reveal',
    {
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
        body: RevealFieldSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const { name, grantId } = req.body;
      const principal = extractPrincipal(req, req.user.id);

      if (!grantId) {
        await requireResourceCapability(req, 'secret.value.read', id, name);
      }
      const field = await services.resource.revealField(id, name, principal, grantId);
      if (!field) {
        throw new ResourceNotFoundError("Field '" + name + "' not found");
      }

      return rep.header('Cache-Control', 'no-store').send({ name: field.name, value: field.value });
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
  // Webhooks & Callback Destinations (#123)
  // ---------------------------------------------------------------------------

  server.post<{
    Params: z.infer<typeof ResourceParamsSchema>;
    Body: z.infer<typeof RegisterCallbackSchema>;
  }>(
    '/api/resources/:id/callbacks',
    {
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
        body: RegisterCallbackSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const { url, secret } = req.body;
      const principal = extractPrincipal(req, req.user.id);

      const destination = await services.ports.registerCallback(
        principal,
        id,
        url,
        secret,
        req.correlationId
      );

      return rep.header('Cache-Control', 'no-store').status(201).send(destination);
    }
  );

  server.get<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/resources/:id/callbacks',
    {
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const principal = extractPrincipal(req, req.user.id);

      const list = await services.ports.listCallbacks(principal, id, req.correlationId);
      return rep.header('Cache-Control', 'no-store').send(list);
    }
  );

  server.delete<{ Params: z.infer<typeof CallbackParamsSchema> }>(
    '/api/resources/:id/callbacks/:callbackId',
    {
      preHandler: [authenticate],
      schema: {
        params: CallbackParamsSchema,
      },
    },
    async (req, rep) => {
      const { id, callbackId } = req.params;
      const principal = extractPrincipal(req, req.user.id);

      await services.ports.deleteCallback(principal, id, callbackId, req.correlationId);
      return rep.status(204).send();
    }
  );

  // ---------------------------------------------------------------------------
  // Resource 2FA & TOTP Endpoints
  // ---------------------------------------------------------------------------

  server.post<{
    Params: z.infer<typeof ResourceParamsSchema>;
    Body: z.infer<typeof RevealTOTPSchema>;
  }>(
    '/api/resources/:id/2fa/code',
    {
      preHandler: [authenticate],
      schema: {
        params: ResourceParamsSchema,
        body: RevealTOTPSchema,
      },
    },
    async (req, rep) => {
      const { id } = req.params;
      const userId = req.user.id;
      const principal = extractPrincipal(req, userId);
      const body = req.body;

      const code = await services.ports.revealTOTP(
        principal,
        id,
        body?.grantId,
        body?.consentId,
        req.correlationId
      );
      return rep.header('Cache-Control', 'no-store').send({ code });
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
      return rep.header('Cache-Control', 'no-store').status(200).send({ success: true });
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

  server.post<{
    Params: z.infer<typeof ResourceParamsSchema>;
    Body: z.infer<typeof TOTPLinkConsentSchema>;
  }>(
    '/api/totp/:id/link-consents',
    {
      preHandler: [authenticate],
      schema: { params: ResourceParamsSchema, body: TOTPLinkConsentSchema },
    },
    async (req, rep) => {
      const principal = extractPrincipal(req, req.user.id);
      const consent = await services.resource.createTOTPLinkConsent(
        req.params.id,
        req.body.resourceId,
        principal,
        req.body.initiatingResourceOwnerId,
        req.body.delegationPolicy
      );
      return rep.header('Cache-Control', 'no-store').status(201).send(consent);
    }
  );

  server.post<{
    Params: z.infer<typeof ResourceParamsSchema>;
    Body: z.infer<typeof TOTPDelegationConsentSchema>;
  }>(
    '/api/resources/:id/2fa/delegation-consents',
    {
      preHandler: [authenticate],
      schema: { params: ResourceParamsSchema, body: TOTPDelegationConsentSchema },
    },
    async (req, rep) => {
      const principal = extractPrincipal(req, req.user.id);
      const consent = await services.resource.createTOTPDelegationConsent(
        { resourceId: req.params.id, ...req.body },
        principal
      );
      return rep.header('Cache-Control', 'no-store').status(201).send(consent);
    }
  );

  server.post<{ Params: z.infer<typeof ResourceParamsSchema> }>(
    '/api/totp/:id/code',
    {
      preHandler: [authenticate],
      schema: { params: ResourceParamsSchema },
    },
    async (req, rep) => {
      const principal = extractPrincipal(req, req.user.id);
      const code = await services.resource.revealPersonalTOTPCode(req.params.id, principal);
      return rep.header('Cache-Control', 'no-store').send({ code });
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
      const principal = extractPrincipal(req, req.user.id);
      const recoveryKey = await services.resource.revealTOTPRecoveryKey(id, principal);
      return rep.header('Cache-Control', 'no-store').send({ recoveryKey });
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
  logger.info('HTTP server listening on port ' + port);

  return server;
}
