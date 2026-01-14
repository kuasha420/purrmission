
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

export class AuthService {
    constructor(private readonly authRepo: AuthRepository) { }

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
        const userCodeParts = randomBytes(4).toString('hex').toUpperCase().match(/.{1,4}/g);

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

        // TODO: In a real app, this should be a full URL like https://example.com/device
        // For this Discord bot, we direct them to the slash command.
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
        const session = await this.authRepo.findSessionByUserCode(userCode);

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
    async exchangeCodeForToken(deviceCode: string): Promise<ApiToken | null> {
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
            // Check if we should invalidate the session to prevent replay?
            // OAuth 2.0 Device Flow spec doesn't explicitly require one-time use of the device code *after* exchange,
            // but it is good security practice. We'll mark it DENIED (or consumed) effectively.
            // However, we might want to return the same token if called again?
            // For now, let's issue a new token and assume the client stores it.

            const tokenString = 'paw_' + randomBytes(32).toString('hex'); // 'paw_' prefix

            // Hash the token for storage
            const tokenHash = createHash('sha256').update(tokenString).digest('hex');

            // Default expiry: 90 days
            const tokenExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

            const token = await this.authRepo.createApiToken({
                token: tokenHash,
                userId: session.userId,
                name: `CLI Device Flow ${session.userCode}`,
                expiresAt: tokenExpiresAt
            });

            // Mark session as fully consumed/closed so it can't be used to mint more tokens
            // Re-using 'DENIED' as a terminal state for now to block further exchanges, 
            // though 'EXPIRED' or a new 'CONSUMED' state might be cleaner.
            // Given the enum constraints, let's use EXPIRED to signify it's done.
            await this.authRepo.updateSessionStatus(session.id, 'EXPIRED');

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
}
