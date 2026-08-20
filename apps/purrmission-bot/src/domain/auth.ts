import { randomBytes } from 'node:crypto';
import { AuthRepository, CredentialRepository } from './repositories.js';
import { Credential, CredentialType, Principal } from './models.js';
import { logger } from '../logging/logger.js';
import { computeAllKeyedDigestCandidates, computeKeyedDigestRecord, KeyManager } from './crypto.js';
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
const MAX_APPROVAL_ATTEMPTS = 8;
const MAX_POLL_ATTEMPTS = 120;
const PAWTHY_SCOPES = ['project.view', 'environment.view', 'resource.view', 'request.create'];

export interface TokenValidationOptions {
  clientIp?: string;
  audience?: string;
  requiredScopes?: string[];
  allowedTypes?: CredentialType[];
}

export type CredentialMetadata = Omit<Credential, 'digest'>;

function toCredentialMetadata(credential: Credential): CredentialMetadata {
  const metadata: Partial<Credential> = { ...credential };
  delete metadata.digest;
  return metadata as CredentialMetadata;
}

export class AuthService {
  constructor(
    private readonly authRepo: AuthRepository,
    private readonly credentialRepo: CredentialRepository,
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

    const deviceCode = randomBytes(32).toString('base64url');
    const hex = randomBytes(8).toString('hex').toUpperCase();
    const userCodeParts = hex.match(/.{1,4}/g);

    if (!userCodeParts) {
      throw new Error('Failed to generate user code');
    }

    const userCode = userCodeParts.join('-');
    const expiresIn = 600;

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

    return this.runTransaction(async (tx) => {
      const session = await this.authRepo.findSessionByUserCode(userCode.toUpperCase(), tx);
      if (!session) return false;
      const attemptAccepted = await this.authRepo.incrementSessionAttempts(
        session.id,
        'APPROVAL',
        MAX_APPROVAL_ATTEMPTS,
        tx
      );
      if (!attemptAccepted || session.status !== 'PENDING') return false;
      if (session.expiresAt < new Date()) {
        await this.authRepo.transitionSessionStatus(
          session.id,
          'PENDING',
          'EXPIRED',
          undefined,
          tx
        );
        return false;
      }
      const transitioned = await this.authRepo.transitionSessionStatus(
        session.id,
        'PENDING',
        'APPROVED',
        userId,
        tx
      );
      if (!transitioned) return false;
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
      return true;
    });
  }

  /**
   * Exchanges a device code for an API token.
   * Returns null if pending, approved token if approved, throws if expired/denied.
   */
  async exchangeCodeForToken(
    deviceCode: string
  ): Promise<{ token: string; apiToken: Credential } | null> {
    if (!rateLimiter.check(`token-poll:${deviceCode}`)) {
      throw new SlowDownError();
    }

    return this.runTransaction(async (tx) => {
      const session = await this.authRepo.findSessionByDeviceCode(deviceCode, tx);
      if (!session) throw new InvalidGrantError();
      const attemptAccepted = await this.authRepo.incrementSessionAttempts(
        session.id,
        'POLL',
        MAX_POLL_ATTEMPTS,
        tx
      );
      if (!attemptAccepted) throw new SlowDownError();
      if (session.status === 'CONSUMED') {
        throw new InvalidGrantError('Session has already been consumed.');
      }
      if (session.expiresAt < new Date()) {
        if (session.status === 'PENDING' || session.status === 'APPROVED') {
          await this.authRepo.transitionSessionStatus(
            session.id,
            session.status,
            'EXPIRED',
            undefined,
            tx
          );
        }
        throw new ExpiredTokenError();
      }
      if (session.status === 'PENDING') return null;
      if (session.status !== 'APPROVED' || !session.userId) throw new AccessDeniedError();

      const transitioned = await this.authRepo.transitionSessionStatus(
        session.id,
        'APPROVED',
        'CONSUMED',
        undefined,
        tx
      );
      if (!transitioned) {
        throw new InvalidGrantError('Session has already been consumed or is invalid.');
      }
      const tokenString = 'paw_' + randomBytes(32).toString('base64url');
      const tokenExpiresAt = new Date(Date.now() + DEFAULT_TOKEN_EXPIRY_DAYS * 86_400_000);
      const digestRecord = computeKeyedDigestRecord(tokenString, 'PAWTHY_TOKEN');
      const token = await this.credentialRepo.create(
        {
          type: 'PAWTHY_TOKEN',
          subjectId: session.userId,
          name: `CLI Device Flow ${session.userCode}`,
          digest: digestRecord.digest,
          digestKeyId: digestRecord.keyId,
          prefix: tokenString.substring(0, 12),
          scopes: PAWTHY_SCOPES,
          audience: 'cli',
          targetType: 'ACCOUNT',
          targetId: session.userId,
          expiresAt: tokenExpiresAt,
          revokedAt: null,
          revokedReason: null,
        },
        tx
      );

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

  /**
   * Validates a token and returns a fully-constructed Principal.
   */
  async validateToken(
    token: string,
    optionsOrIp: TokenValidationOptions | string = {}
  ): Promise<Principal | null> {
    const options = typeof optionsOrIp === 'string' ? { clientIp: optionsOrIp } : optionsOrIp;
    const { clientIp } = options;
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

    let credential: Credential | null = null;
    let matchedPurpose: 'PAWTHY_TOKEN' | 'SERVICE_CREDENTIAL' | null = null;
    let matchedKeyId: string | null = null;
    for (const purpose of ['PAWTHY_TOKEN', 'SERVICE_CREDENTIAL'] as const) {
      for (const candidate of computeAllKeyedDigestCandidates(token, purpose)) {
        credential = await this.credentialRepo.findByDigest(candidate.digest);
        if (credential) {
          matchedPurpose = purpose;
          matchedKeyId = candidate.keyId;
          break;
        }
      }
      if (credential) break;
    }

    if (
      credential &&
      credential.type === matchedPurpose &&
      credential.digestKeyId === matchedKeyId &&
      !credential.revokedAt &&
      (!credential.expiresAt || credential.expiresAt > new Date()) &&
      (!options.audience || credential.audience === options.audience) &&
      (!options.allowedTypes || options.allowedTypes.includes(credential.type)) &&
      (!options.requiredScopes ||
        options.requiredScopes.every((s) => credential.scopes.includes(s)))
    ) {
      const acceptedCredential = credential;
      const isSvc = acceptedCredential.type === 'SERVICE_CREDENTIAL';
      const principal: Principal = {
        type: isSvc ? 'SERVICE' : 'PAWTHY_TOKEN',
        id: credential.id,
        subjectId: credential.subjectId,
        authKind: isSvc ? 'SERVICE' : 'PAWTHY',
        actorDiscordId: isSvc ? undefined : credential.subjectId,
        scopes: credential.scopes,
        audience: credential.audience,
        expiresAt: credential.expiresAt,
        createdAt: credential.createdAt,
        lastUsedAt: new Date(),
        credentialTarget: { type: credential.targetType, id: credential.targetId },
      };
      await this.runTransaction(async (tx) => {
        if (matchedPurpose && matchedKeyId !== KeyManager.getActiveKeyId(matchedPurpose)) {
          const active = computeKeyedDigestRecord(token, matchedPurpose);
          await this.credentialRepo.updateDigest(
            acceptedCredential.id,
            active.digest,
            active.keyId,
            tx
          );
        }
        await this.credentialRepo.updateLastUsed(acceptedCredential.id, tx);
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
            targetId: acceptedCredential.id,
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

    const rejectionReason =
      credential && options.audience && credential.audience !== options.audience
        ? 'WRONG_AUDIENCE'
        : credential &&
            options.requiredScopes &&
            !options.requiredScopes.every((scope) => credential.scopes.includes(scope))
          ? 'INSUFFICIENT_SCOPES'
          : 'INVALID_AUTH';

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
      reasonCode: rejectionReason,
      authoritySources: [],
      targetType: 'CREDENTIAL',
      actorType: 'SERVICE',
      principalId: 'anonymous:credential',
      authKind: 'SERVICE',
      payload: credential ? { credentialId: credential.id } : {},
    });

    return null;
  }

  async listOwnCredentials(principal: Principal): Promise<CredentialMetadata[]> {
    if (principal.type !== 'PAWTHY_TOKEN') throw new ForbiddenError();
    const credentials = await this.credentialRepo.findBySubject(
      principal.subjectId,
      'PAWTHY_TOKEN'
    );
    return credentials.map(toCredentialMetadata);
  }

  async rotateOwnCredential(
    principal: Principal,
    credentialId: string
  ): Promise<{ plaintext: string; credential: CredentialMetadata }> {
    if (principal.type !== 'PAWTHY_TOKEN') throw new ForbiddenError();
    const plaintext = 'paw_' + randomBytes(32).toString('base64url');
    const digest = computeKeyedDigestRecord(plaintext, 'PAWTHY_TOKEN');
    return this.runTransaction(async (tx) => {
      const current = await this.credentialRepo.findById(credentialId, tx);
      if (
        !current ||
        current.type !== 'PAWTHY_TOKEN' ||
        current.subjectId !== principal.subjectId ||
        current.revokedAt
      ) {
        throw new ForbiddenError('Credential is not eligible for rotation.');
      }
      const replacement = await this.credentialRepo.create(
        {
          type: current.type,
          subjectId: current.subjectId,
          name: current.name,
          digest: digest.digest,
          digestKeyId: digest.keyId,
          prefix: plaintext.substring(0, 12),
          scopes: current.scopes,
          audience: current.audience,
          targetType: current.targetType,
          targetId: current.targetId,
          expiresAt: current.expiresAt,
          revokedAt: null,
          revokedReason: null,
        },
        tx
      );
      await this.credentialRepo.revoke(current.id, 'rotated', tx);
      await this.audit.log(
        {
          eventFamily: 'AUTHENTICATION',
          eventType: 'CREDENTIAL_ROTATE',
          surface: this.surface,
          operation: 'credential.rotate-own',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['AUTHENTICATED_SUBJECT'],
          targetType: 'CREDENTIAL',
          targetId: replacement.id,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          payload: { credentialId: replacement.id },
        },
        tx
      );
      return { plaintext, credential: toCredentialMetadata(replacement) };
    });
  }

  async revokeOwnCredential(principal: Principal, credentialId: string): Promise<void> {
    if (principal.type !== 'PAWTHY_TOKEN') throw new ForbiddenError();
    await this.runTransaction(async (tx) => {
      const credential = await this.credentialRepo.findById(credentialId, tx);
      if (
        !credential ||
        credential.type !== 'PAWTHY_TOKEN' ||
        credential.subjectId !== principal.subjectId
      ) {
        throw new ForbiddenError('Credential is not eligible for revocation.');
      }
      if (!credential.revokedAt) {
        await this.credentialRepo.revoke(credential.id, 'subject-revoked', tx);
      }
      await this.audit.log(
        {
          eventFamily: 'AUTHENTICATION',
          eventType: 'CREDENTIAL_REVOKE',
          surface: this.surface,
          operation: 'credential.revoke-own',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: 'AUTHENTICATED_SUBJECT',
          authoritySources: ['AUTHENTICATED_SUBJECT'],
          targetType: 'CREDENTIAL',
          targetId: credential.id,
          actorType: principal.type,
          principalId: principal.id,
          actorId: principal.subjectId,
          authKind: principal.authKind,
          payload: { credentialId: credential.id },
        },
        tx
      );
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
