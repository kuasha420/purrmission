
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AuthRepository } from './repositories.js';
import { ApiToken } from './models.js';
import { logger } from '../logging/logger.js';

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

const DEFAULT_TOKEN_EXPIRY_DAYS = 90;

export class AuthService {
    constructor(private readonly authRepo: AuthRepository) { }

    private hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    /**
     * Starts the device flow.
     * Generates a device code (for cli) and user code (for human).
     */
    async initiateDeviceFlow(): Promise<{
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        expiresIn: number;
        interval: number;
    }> {
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
            verificationUri: '/purrmission cli-login',
            expiresIn,
            interval: 5, // Poll every 5 seconds
        };
    }

    /**
     * Approves a pending session, linking it to a user.
     */
    async approveSession(userCode: string, userId: string): Promise<boolean> {
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
    async exchangeCodeForToken(deviceCode: string): Promise<{ token: string; apiToken: ApiToken } | null> {
        const session = await this.authRepo.findSessionByDeviceCode(deviceCode);
        if (!session) throw new InvalidGrantError();

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

            // Mark session as fully consumed/closed so it can't be used to mint more tokens.
            await this.authRepo.updateSessionStatus(session.id, 'CONSUMED');

            const tokenString = 'paw_' + randomBytes(32).toString('hex'); // 'paw_' prefix

            // Hash the token for storage
            const tokenHash = createHash('sha256').update(tokenString).digest('hex');

            // Default expiry
            const tokenExpiresAt = new Date(Date.now() + DEFAULT_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

            const token = await this.authRepo.createApiToken({
                token: tokenHash,
                userId: session.userId,
                name: `CLI Device Flow ${session.userCode}`,
                expiresAt: tokenExpiresAt
            });

            // Return the plaintext token to the user (BUT based on the DB record structure)
            return {
                ...token,
                token: tokenString // OVERWRITE hash with plaintext for the response
            };
        }

        throw new AccessDeniedError();
    }

    async validateToken(token: string): Promise<ApiToken | null> {
        // Token is provided in plaintext, we must hash it to lookup
        const tokenHash = createHash('sha256').update(token).digest('hex');

        const apiToken = await this.authRepo.findApiToken(tokenHash);
        if (!apiToken) return null;

        // Check expiration
        if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
            return null;
        }

        // Update last used (async, fire and forget)
        this.authRepo.updateApiTokenLastUsed(apiToken.id).catch((error) => {
            logger.warn('Failed to update token last used timestamp', { tokenId: apiToken.id, error });
        });

        return apiToken;
    }

    /**
     * Cleans up expired and consumed sessions from the database.
     */
    async cleanupExpiredSessions(): Promise<number> {
        return this.authRepo.deleteExpiredSessions();
    }
}
