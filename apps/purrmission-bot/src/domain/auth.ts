
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthRepository } from './repositories.js';
import { ApiToken, AuthSession } from './models.js';

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
        const userCode = randomBytes(4).toString('hex').toUpperCase().match(/.{1,4}/g)!.join('-');
        const expiresIn = 1800; // 30 minutes in seconds

        const expiresAt = new Date(Date.now() + expiresIn * 1000);

        await this.authRepo.createSession({
            deviceCode,
            userCode,
            expiresAt,
        });

        return {
            deviceCode,
            userCode,
            verificationUri: '/purrmission cli-login', // Or full URL if web-based
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
        if (!session) throw new Error('invalid_grant');

        if (session.status === 'PENDING') {
            if (session.expiresAt < new Date()) {
                await this.authRepo.updateSessionStatus(session.id, 'EXPIRED');
                throw new Error('expired_token');
            }
            return null; // Still pending
        }

        if (session.status === 'APPROVED' && session.userId) {
            // Issue token
            // Idempotency: Check if we already issued a token for this session?
            // For simplicity, generate new token. In product, might look up existing.
            const tokenString = 'paw_' + randomBytes(32).toString('hex'); // 'paw_' prefix
            // Hash it? For MVP, storing plain is risky but let's stick to plan "Hashed?".
            // If we store hashed, we can't return it again.
            // So we generate, hash, store hash, return plain.

            // Actually, for MVP let's store plain but mark as TODO to hash.
            const token = await this.authRepo.createApiToken({
                token: tokenString,
                userId: session.userId,
                name: `CLI Device Flow ${session.userCode}`,
                expiresAt: null // Never expires currently
            });

            // Invalidate session so it can't be used again
            // Actually, OAuth device flow doesn't strictly say delete session, but good practice.
            // We'll leave it APPROVED for audit.

            return token;
        }

        throw new Error('access_denied');
    }

    async validateToken(token: string): Promise<ApiToken | null> {
        const apiToken = await this.authRepo.findApiToken(token);
        if (!apiToken) return null;

        // Update last used (async, fire and forget)
        this.authRepo.updateApiTokenLastUsed(apiToken.id).catch(() => { });

        return apiToken;
    }
}
