import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AuthRepository, CredentialRepository } from './repositories.js';
import { ApiToken, Credential, Principal } from './models.js';
import { logger } from '../logging/logger.js';
import { computeKeyedDigest, computeAllKeyedDigests } from './crypto.js';
import { rateLimiter } from '../infra/rateLimit.js';

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
    private readonly credentialRepo?: CredentialRepository
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
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

    await this.authRepo.createSession({
      deviceCode,
      userCode,
      expiresAt,
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
      await this.authRepo.updateSessionStatus(session.id, 'EXPIRED');
      return false;
    }

    await this.authRepo.updateSessionStatus(session.id, 'APPROVED', userId);
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
        await this.authRepo.updateSessionStatus(session.id, 'EXPIRED');
        throw new ExpiredTokenError();
      }
      return null; // Still pending
    }

    if (session.status === 'APPROVED' && session.userId) {
      // Check expiry again to ensure session hasn't expired since approval
      if (session.expiresAt < new Date()) {
        await this.authRepo.updateSessionStatus(session.id, 'EXPIRED');
        throw new ExpiredTokenError();
      }

      // Atomically transition status from APPROVED to CONSUMED.
      let transitioned = false;
      if (typeof this.authRepo.transitionSessionStatus === 'function') {
        transitioned = await this.authRepo.transitionSessionStatus(
          session.id,
          'APPROVED',
          'CONSUMED'
        );
      } else {
        await this.authRepo.updateSessionStatus(session.id, 'CONSUMED');
        transitioned = true;
      }
      if (!transitioned) {
        throw new InvalidGrantError('Session has already been consumed or is invalid.');
      }

      const tokenString = 'paw_' + randomBytes(32).toString('hex'); // 'paw_' prefix
      const tokenExpiresAt = new Date(Date.now() + DEFAULT_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      let token: Credential | ApiToken;

      if (this.credentialRepo) {
        const digest = computeKeyedDigest(tokenString, 'PAWTHY_TOKEN');
        const prefix = tokenString.substring(0, 12);
        token = await this.credentialRepo.create({
          type: 'PAWTHY_TOKEN',
          subjectId: session.userId,
          name: `CLI Device Flow ${session.userCode}`,
          digest,
          prefix,
          scopes: 'project.view,environment.view,resource.view,request.create', // Default scopes
          audience: 'cli',
          expiresAt: tokenExpiresAt,
          revokedAt: null,
        });

        // Also write legacy token for dual-read compatibility
        const tokenHash = this.hashToken(tokenString);
        await this.authRepo.createApiToken({
          token: tokenHash,
          userId: session.userId,
          name: `CLI Device Flow ${session.userCode}`,
          expiresAt: tokenExpiresAt,
        });
      } else {
        // Fallback for mock environments lacking credentialRepo
        const tokenHash = this.hashToken(tokenString);
        token = await this.authRepo.createApiToken({
          token: tokenHash,
          userId: session.userId,
          name: `CLI Device Flow ${session.userCode}`,
          expiresAt: tokenExpiresAt,
        });
      }

      // Return the plaintext token to the user
      return {
        token: tokenString,
        apiToken: token,
      };
    }

    throw new AccessDeniedError();
  }

  /**
   * Validates a token and returns a fully-constructed Principal.
   */
  async validateToken(token: string, clientIp?: string): Promise<Principal | null> {
    if (clientIp && rateLimiter.isLimited(`credential-validation-failure-check:${clientIp}`)) {
      logger.warn('Token validation throttled due to rate-limiting failures', { clientIp });
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
        await this.credentialRepo.updateLastUsed(credential.id);
        const isSvc = credential.type === 'SERVICE_CREDENTIAL';
        return {
          type: isSvc ? 'SERVICE' : 'PAWTHY_TOKEN',
          id: credential.id,
          subjectId: credential.subjectId,
          userId: isSvc ? undefined : credential.subjectId, // Legacy compatibility alias
          authKind: isSvc ? 'SERVICE' : 'PAWTHY',
          actorDiscordId: isSvc ? undefined : credential.subjectId,
          scopes: credential.scopes ? credential.scopes.split(',') : [],
          audience: credential.audience,
          expiresAt: credential.expiresAt,
          createdAt: credential.createdAt,
          lastUsedAt: new Date(),
        };
      }
    }

    // 2. Dual-read fallback: check legacy ApiToken table
    const tokenHash = this.hashToken(token);
    const apiToken = await this.authRepo.findApiToken(tokenHash);

    if (apiToken && (!apiToken.expiresAt || apiToken.expiresAt > new Date())) {
      await this.authRepo.updateApiTokenLastUsed(apiToken.id);
      return {
        type: 'PAWTHY_TOKEN',
        id: apiToken.id,
        subjectId: apiToken.userId,
        userId: apiToken.userId, // Legacy compatibility alias
        authKind: 'PAWTHY',
        actorDiscordId: apiToken.userId,
        scopes: ['project.view', 'environment.view', 'resource.view', 'request.create'],
        audience: 'cli',
        expiresAt: apiToken.expiresAt,
        createdAt: apiToken.createdAt,
        lastUsedAt: new Date(),
      };
    }

    // Track failure for rate-limiting
    if (clientIp) {
      rateLimiter.check(`credential-validation-failure-check:${clientIp}`);
    }

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

    const credential = await this.credentialRepo.create({
      type: 'SERVICE_CREDENTIAL',
      subjectId: serviceName,
      name,
      digest,
      prefix,
      scopes: scopes.join(','),
      audience: 'service',
      expiresAt,
      revokedAt: null,
    });

    return { plaintext, credential };
  }

  /**
   * Cleans up expired and consumed sessions from the database.
   */
  async cleanupExpiredSessions(): Promise<number> {
    return this.authRepo.deleteExpiredSessions();
  }
}
