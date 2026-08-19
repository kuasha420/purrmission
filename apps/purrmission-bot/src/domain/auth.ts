import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AuthRepository, CredentialRepository } from './repositories.js';
import { ApiToken, Credential, Principal } from './models.js';
import { logger } from '../logging/logger.js';
import { computeKeyedDigest, computeAllKeyedDigests } from './crypto.js';
import { rateLimiter } from '../infra/rateLimit.js';
import { AuditService } from './audit.js';
import { correlationStorage } from '../logging/correlationContext.js';
import type { Prisma } from '@prisma/client';

export class InvalidGrantError extends Error {
  constructor(message = 'invalid_grant') {
    super(message);
    this.name = 'InvalidGrantError';
  }
}

export class ExpiredTokenError extends Error {
  constructor(message = 'expired_token') {
    super(message);
    this.name = 'ExpiredTokenError';
  }
}

export class AccessDeniedError extends Error {
  constructor(message = 'access_denied') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class SlowDownError extends Error {
  constructor(message = 'slow_down') {
    super(message);
    this.name = 'SlowDownError';
  }
}

const DEFAULT_TOKEN_EXPIRY_DAYS = 90;

export class AuthService {
  constructor(
    private readonly authRepo: AuthRepository,
    private readonly credentialRepo: CredentialRepository | undefined,
    private readonly audit: AuditService,
    private readonly transaction: <T>(
      callback: (tx: Prisma.TransactionClient) => Promise<T>
    ) => Promise<T>
  ) {
    if (!audit) throw new TypeError('AuthService requires an audit dependency.');
  }

  private get surface() {
    return correlationStorage.getStore()?.surface ?? ('DOMAIN' as const);
  }

  private async runTransaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.transaction(callback);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async expireSession(
    session: { id: string; userId?: string },
    operation: string
  ): Promise<void> {
    await this.runTransaction(async (tx) => {
      await this.authRepo.updateSessionStatus(session.id, 'EXPIRED', undefined, tx);
      await this.audit.log(
        {
          eventFamily: 'AUTHENTICATION',
          eventType: 'AUTH_SESSION_EXPIRE',
          surface: this.surface,
          operation,
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: 'SERVICE',
          authoritySources: [],
          targetType: 'SESSION',
          targetId: session.id,
          actorType: 'SERVICE',
          principalId: 'service:auth-session-expiry',
          actorId: session.userId ?? null,
          authKind: 'SERVICE',
          payload: {},
        },
        tx
      );
    });
  }

  /**
   * Starts the device flow.
   * Generates a device code (for cli) and user code (for human).
   */
  async initiateDeviceFlow(clientIp?: string): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> {
    if (clientIp && !rateLimiter.check(`device-flow-initiate:${clientIp}`)) {
      throw new Error('Rate limit exceeded for device flow initiation');
    }

    const deviceCode = randomUUID();
    // Generate a short 8-char user code (e.g. ABCD-1234)
    const hex = randomBytes(4).toString('hex').toUpperCase();
    const userCodeParts = hex.match(/.{1,4}/g);

    if (!userCodeParts) {
      throw new Error('Failed to generate user code');
    }

    const userCode = userCodeParts.join('-');
    const expiresIn = 1800; // 30 minutes in seconds

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await this.runTransaction(async (tx) => {
      const session = await this.authRepo.createSession({ deviceCode, userCode, expiresAt }, tx);
      await this.audit.log(
        {
          eventFamily: 'AUTHENTICATION',
          eventType: 'AUTH_SESSION_INITIATE',
          surface: this.surface,
          operation: 'auth.device.initiate',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: [],
          targetType: 'SESSION',
          targetId: session.id,
          actorType: 'SERVICE',
          principalId: 'system:auth-device-flow',
          authKind: 'SERVICE',
          payload: {},
        },
        tx
      );
    });

    // For this Discord bot, we direct them to the slash command.
    // This is a known deviation from RFC 8628 for better Discord UX.
    return {
      deviceCode,
      userCode,
      verificationUri: '/auth login',
      expiresIn,
      interval: 5, // Poll every 5 seconds
    };
  }

  /**
   * Approves a pending session, linking it to a user.
   */
  async approveSession(userCode: string, userId: string): Promise<boolean> {
    if (!rateLimiter.check(`approve-session:${userId}`)) {
      logger.warn('Approve session rate-limited', { userId });
      return false;
    }

    const session = await this.authRepo.findSessionByUserCode(userCode.toUpperCase());

    if (!session) return false;
    if (session.status !== 'PENDING') return false;
    if (session.expiresAt < new Date()) {
      await this.expireSession(session, 'auth.device.approve.expire');
      return false;
    }

    await this.runTransaction(async (tx) => {
      await this.authRepo.updateSessionStatus(session.id, 'APPROVED', userId, tx);
      await this.audit.log(
        {
          eventFamily: 'AUTHENTICATION',
          eventType: 'AUTH_SESSION_APPROVE',
          surface: this.surface,
          operation: 'auth.device.approve',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['AUTHENTICATED_SUBJECT'],
          targetType: 'SESSION',
          targetId: session.id,
          actorType: 'DISCORD_USER',
          principalId: `discord:${userId}`,
          actorId: userId,
          authKind: 'DISCORD',
          payload: {},
        },
        tx
      );
    });
    return true;
  }

  /**
   * Exchanges a device code for an API token.
   * Returns null if pending, approved token if approved, throws if expired/denied.
   */
  async exchangeCodeForToken(
    deviceCode: string
  ): Promise<{ token: string; apiToken: ApiToken | Credential } | null> {
    if (!rateLimiter.check(`token-poll:${deviceCode}`)) {
      throw new SlowDownError();
    }

    const session = await this.authRepo.findSessionByDeviceCode(deviceCode);
    if (!session) throw new InvalidGrantError();

    if (session.status === 'CONSUMED') {
      throw new InvalidGrantError('Session has already been consumed.');
    }

    if (session.status === 'PENDING') {
      if (session.expiresAt < new Date()) {
        await this.expireSession(session, 'auth.device.poll.expire');
        throw new ExpiredTokenError();
      }
      return null; // Still pending
    }

    if (session.status === 'APPROVED' && session.userId) {
      // Check expiry again to ensure session hasn't expired since approval
      if (session.expiresAt < new Date()) {
        await this.expireSession(session, 'auth.device.exchange.expire');
        throw new ExpiredTokenError();
      }

      const tokenString = 'paw_' + randomBytes(32).toString('hex'); // 'paw_' prefix
      const tokenExpiresAt = new Date(Date.now() + DEFAULT_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      return this.runTransaction(async (tx) => {
        let transitioned = false;
        if (typeof this.authRepo.transitionSessionStatus === 'function') {
          transitioned = await this.authRepo.transitionSessionStatus(
            session.id,
            'APPROVED',
            'CONSUMED',
            undefined,
            tx
          );
        } else {
          await this.authRepo.updateSessionStatus(session.id, 'CONSUMED', undefined, tx);
          transitioned = true;
        }
        if (!transitioned) {
          throw new InvalidGrantError('Session has already been consumed or is invalid.');
        }

        let token: Credential | ApiToken;
        if (this.credentialRepo) {
          const digest = computeKeyedDigest(tokenString, 'PAWTHY_TOKEN');
          const prefix = tokenString.substring(0, 12);
          token = await this.credentialRepo.create(
            {
              type: 'PAWTHY_TOKEN',
              subjectId: session.userId!,
              name: `CLI Device Flow ${session.userCode}`,
              digest,
              prefix,
              scopes: 'project.view,environment.view,resource.view,request.create',
              audience: 'cli',
              expiresAt: tokenExpiresAt,
              revokedAt: null,
            },
            tx
          );

          const tokenHash = this.hashToken(tokenString);
          await this.authRepo.createApiToken(
            {
              token: tokenHash,
              userId: session.userId!,
              name: `CLI Device Flow ${session.userCode}`,
              expiresAt: tokenExpiresAt,
            },
            tx
          );
        } else {
          const tokenHash = this.hashToken(tokenString);
          token = await this.authRepo.createApiToken(
            {
              token: tokenHash,
              userId: session.userId!,
              name: `CLI Device Flow ${session.userCode}`,
              expiresAt: tokenExpiresAt,
            },
            tx
          );
        }

        await this.audit.log(
          {
            eventFamily: 'AUTHENTICATION',
            eventType: 'AUTH_SESSION_EXCHANGE',
            surface: this.surface,
            operation: 'auth.device.exchange',
            outcomeCode: 'SUCCESS',
            decisionCode: 'ALLOW',
            reasonCode: 'AUTHENTICATED_SUBJECT',
            authoritySources: ['AUTHENTICATED_SUBJECT'],
            targetType: 'SESSION',
            targetId: session.id,
            actorType: 'PAWTHY_TOKEN',
            principalId: token.id,
            actorId: session.userId,
            authKind: 'PAWTHY',
            payload: { credentialId: token.id },
          },
          tx
        );

        return { token: tokenString, apiToken: token };
      });
    }

    throw new AccessDeniedError();
  }

  /**
   * Validates a token and returns a fully-constructed Principal.
   */
  async validateToken(token: string, clientIp?: string): Promise<Principal | null> {
    if (clientIp && rateLimiter.isLimited(`credential-validation-failure-check:${clientIp}`)) {
      logger.warn('Token validation throttled due to rate-limiting failures', { clientIp });
      await this.audit.log({
        eventFamily: 'AUTHENTICATION',
        eventType: 'CREDENTIAL_USE',
        surface: this.surface,
        operation: 'credential.validate',
        outcomeCode: 'DENIED',
        decisionCode: 'DENY',
        reasonCode: 'INVALID_AUTH',
        authoritySources: [],
        targetType: 'CREDENTIAL',
        actorType: 'SERVICE',
        principalId: 'anonymous:credential',
        authKind: 'SERVICE',
        payload: { throttled: true },
      });
      return null;
    }

    // 1. Try digested credential lookup (PAWTHY_TOKEN)
    if (this.credentialRepo) {
      let credential = null;
      const pawthyDigests = computeAllKeyedDigests(token, 'PAWTHY_TOKEN');
      for (const digest of pawthyDigests) {
        credential = await this.credentialRepo.findByDigest(digest);
        if (credential) break;
      }

      // If not found, try as SERVICE_CREDENTIAL
      if (!credential) {
        const serviceDigests = computeAllKeyedDigests(token, 'SERVICE_CREDENTIAL');
        for (const digest of serviceDigests) {
          credential = await this.credentialRepo.findByDigest(digest);
          if (credential) break;
        }
      }

      if (
        credential &&
        !credential.revokedAt &&
        (!credential.expiresAt || credential.expiresAt > new Date())
      ) {
        const isSvc = credential.type === 'SERVICE_CREDENTIAL';
        const principal: Principal = {
          type: isSvc ? 'SERVICE' : 'PAWTHY_TOKEN',
          id: credential.id,
          subjectId: credential.subjectId,
          authKind: isSvc ? 'SERVICE' : 'PAWTHY',
          actorDiscordId: isSvc ? undefined : credential.subjectId,
          scopes: credential.scopes ? credential.scopes.split(',') : [],
          audience: credential.audience,
          expiresAt: credential.expiresAt,
          createdAt: credential.createdAt,
          lastUsedAt: new Date(),
        };
        await this.runTransaction(async (tx) => {
          await this.credentialRepo!.updateLastUsed(credential!.id, tx);
          await this.audit.log(
            {
              eventFamily: 'AUTHENTICATION',
              eventType: 'CREDENTIAL_USE',
              surface: this.surface,
              operation: 'credential.validate',
              outcomeCode: 'SUCCESS',
              decisionCode: 'ALLOW',
              reasonCode: isSvc ? 'SERVICE' : 'AUTHENTICATED_SUBJECT',
              authoritySources: ['SCOPED_CREDENTIAL'],
              targetType: 'CREDENTIAL',
              targetId: credential!.id,
              actorType: principal.type,
              principalId: principal.id,
              actorId: principal.subjectId,
              authKind: principal.authKind,
              payload: {},
            },
            tx
          );
        });
        return principal;
      }
    }

    // 2. Dual-read fallback: check legacy ApiToken table
    const tokenHash = this.hashToken(token);
    const apiToken = await this.authRepo.findApiToken(tokenHash);

    if (apiToken && (!apiToken.expiresAt || apiToken.expiresAt > new Date())) {
      const principal: Principal = {
        type: 'PAWTHY_TOKEN',
        id: apiToken.id,
        subjectId: apiToken.userId,
        authKind: 'PAWTHY',
        actorDiscordId: apiToken.userId,
        scopes: ['project.view', 'environment.view', 'resource.view', 'request.create'],
        audience: 'cli',
        expiresAt: apiToken.expiresAt,
        createdAt: apiToken.createdAt,
        lastUsedAt: new Date(),
      };
      await this.runTransaction(async (tx) => {
        await this.authRepo.updateApiTokenLastUsed(apiToken.id, tx);
        await this.audit.log(
          {
            eventFamily: 'AUTHENTICATION',
            eventType: 'CREDENTIAL_USE',
            surface: this.surface,
            operation: 'credential.validate',
            outcomeCode: 'SUCCESS',
            decisionCode: 'ALLOW',
            reasonCode: 'AUTHENTICATED_SUBJECT',
            authoritySources: ['SCOPED_CREDENTIAL'],
            targetType: 'CREDENTIAL',
            targetId: apiToken.id,
            actorType: principal.type,
            principalId: principal.id,
            actorId: principal.subjectId,
            authKind: principal.authKind,
            payload: { legacy: true },
          },
          tx
        );
      });
      return principal;
    }

    // Track failure for rate-limiting
    if (clientIp) {
      rateLimiter.check(`credential-validation-failure-check:${clientIp}`);
    }

    await this.audit.log({
      eventFamily: 'AUTHENTICATION',
      eventType: 'CREDENTIAL_USE',
      surface: this.surface,
      operation: 'credential.validate',
      outcomeCode: 'DENIED',
      decisionCode: 'DENY',
      reasonCode: 'INVALID_AUTH',
      authoritySources: [],
      targetType: 'CREDENTIAL',
      actorType: 'SERVICE',
      principalId: 'anonymous:credential',
      authKind: 'SERVICE',
      payload: {},
    });

    return null;
  }

  /**
   * Mint a new service credential.
   */
  async mintServiceCredential(
    serviceName: string,
    name: string,
    scopes: string[],
    expiresInMs?: number
  ): Promise<{ plaintext: string; credential: Credential }> {
    if (!this.credentialRepo) {
      throw new Error('Credential repository not initialized');
    }

    const plaintext = 'pur_svc_' + randomBytes(32).toString('hex');
    const digest = computeKeyedDigest(plaintext, 'SERVICE_CREDENTIAL');
    const prefix = plaintext.substring(0, 16);
    const expiresAt = expiresInMs ? new Date(Date.now() + expiresInMs) : null;

    return this.runTransaction(async (tx) => {
      const credential = await this.credentialRepo!.create(
        {
          type: 'SERVICE_CREDENTIAL',
          subjectId: serviceName,
          name,
          digest,
          prefix,
          scopes: scopes.join(','),
          audience: 'service',
          expiresAt,
          revokedAt: null,
        },
        tx
      );

      await this.audit.log(
        {
          eventFamily: 'AUTHENTICATION',
          eventType: 'SERVICE_CREDENTIAL_MINT',
          surface: this.surface,
          operation: 'credential.service.mint',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: 'SERVICE',
          authoritySources: ['SCOPED_CREDENTIAL'],
          targetType: 'CREDENTIAL',
          targetId: credential.id,
          actorType: 'SERVICE',
          principalId: `service:${serviceName}`,
          actorId: serviceName,
          authKind: 'SERVICE',
          payload: { credentialId: credential.id },
        },
        tx
      );

      return { plaintext, credential };
    });
  }

  /**
   * Cleans up expired and consumed sessions from the database.
   */
  async cleanupExpiredSessions(): Promise<number> {
    return this.runTransaction(async (tx) => {
      const count = await this.authRepo.deleteExpiredSessions(tx);
      if (count > 0) {
        await this.audit.log(
          {
            eventFamily: 'AUTHENTICATION',
            eventType: 'AUTH_SESSION_CLEANUP',
            surface: this.surface,
            operation: 'auth.session.cleanup',
            outcomeCode: 'SUCCESS',
            decisionCode: 'ALLOW',
            reasonCode: 'SERVICE',
            authoritySources: [],
            targetType: 'SESSION',
            actorType: 'SERVICE',
            principalId: 'service:auth-session-cleanup',
            authKind: 'SERVICE',
            payload: { deletedCount: count },
          },
          tx
        );
      }
      return count;
    });
  }
}
