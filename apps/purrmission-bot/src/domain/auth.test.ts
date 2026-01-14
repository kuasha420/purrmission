
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { AuthService, InvalidGrantError, ExpiredTokenError, AccessDeniedError } from './auth.js';
import { AuthRepository } from './repositories.js';
import { AuthSession, ApiToken } from './models.js';
import { createHash } from 'node:crypto';

describe('AuthService', () => {
    let authService: AuthService;
    let mockRepo: AuthRepository;

    beforeEach(() => {
        // Initialize with mocks. Note: We use type assertions because we are mocking the interface.
        mockRepo = {
            createSession: mock.fn(),
            findSessionByDeviceCode: mock.fn(),
            findSessionByUserCode: mock.fn(),
            updateSessionStatus: mock.fn(),
            createApiToken: mock.fn(),
            findApiToken: mock.fn(),
            updateApiTokenLastUsed: mock.fn(),
        };
        authService = new AuthService(mockRepo);
    });

    describe('initiateDeviceFlow', () => {
        test('should generate device code and user code', async () => {
            // Mock implementation to return the input session
            mockRepo.createSession = mock.fn(async (session: any) => session);

            const result = await authService.initiateDeviceFlow();

            assert.ok(result.deviceCode);
            assert.ok(result.userCode);
            assert.match(result.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
            assert.strictEqual(result.verificationUri, '/purrmission cli-login');
            assert.strictEqual(result.expiresIn, 1800);

            assert.strictEqual((mockRepo.createSession as any).mock.callCount(), 1);
        });
    });

    describe('approveSession', () => {
        test('should approve a pending session', async () => {
            const validSession: AuthSession = {
                id: 'session-1',
                deviceCode: 'device-1',
                userCode: 'ABCD-1234',
                status: 'PENDING',
                expiresAt: new Date(Date.now() + 10000),
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            mockRepo.findSessionByUserCode = mock.fn(async () => validSession);
            mockRepo.updateSessionStatus = mock.fn(async () => undefined);

            const success = await authService.approveSession('ABCD-1234', 'user-123');

            assert.strictEqual(success, true);
            assert.strictEqual((mockRepo.updateSessionStatus as any).mock.callCount(), 1);
            assert.deepStrictEqual((mockRepo.updateSessionStatus as any).mock.calls[0].arguments, ['session-1', 'APPROVED', 'user-123']);
        });

        test('should return false if session not found', async () => {
            mockRepo.findSessionByUserCode = mock.fn(async () => null);
            const success = await authService.approveSession('INVALID', 'user-123');
            assert.strictEqual(success, false);
        });

        test('should expire session if expired during approval', async () => {
            const expiredSession: AuthSession = {
                id: 'session-1',
                deviceCode: 'device-1',
                userCode: 'ABCD-1234',
                status: 'PENDING',
                expiresAt: new Date(Date.now() - 1000),
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            mockRepo.findSessionByUserCode = mock.fn(async () => expiredSession);
            // Re-mock updateSessionStatus to trace calls
            mockRepo.updateSessionStatus = mock.fn(async () => undefined);

            const success = await authService.approveSession('ABCD-1234', 'user-123');

            assert.strictEqual(success, false);
            assert.strictEqual((mockRepo.updateSessionStatus as any).mock.callCount(), 1);
            assert.deepStrictEqual((mockRepo.updateSessionStatus as any).mock.calls[0].arguments, ['session-1', 'EXPIRED']);
        });
    });

    describe('exchangeCodeForToken', () => {
        test('should return null and throw valid errors for pending sessions', async () => {
            const pendingSession: AuthSession = {
                id: 'session-1',
                deviceCode: 'device-1',
                userCode: 'ABCD-1234',
                status: 'PENDING',
                expiresAt: new Date(Date.now() + 10000),
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            mockRepo.findSessionByDeviceCode = mock.fn(async () => pendingSession);

            const result = await authService.exchangeCodeForToken('device-1');
            assert.strictEqual(result, null);
        });

        test('should throw ExpiredTokenError for pending expired session', async () => {
            const expiredSession: AuthSession = {
                id: 'session-1',
                deviceCode: 'device-1',
                userCode: 'ABCD-1234',
                status: 'PENDING',
                expiresAt: new Date(Date.now() - 1000),
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            mockRepo.findSessionByDeviceCode = mock.fn(async () => expiredSession);
            mockRepo.updateSessionStatus = mock.fn(async () => undefined);

            await assert.rejects(
                () => authService.exchangeCodeForToken('device-1'),
                ExpiredTokenError
            );
            assert.strictEqual((mockRepo.updateSessionStatus as any).mock.calls[0].arguments[1], 'EXPIRED');
        });

        test('should issue token for approved session and mark session expired', async () => {
            const approvedSession: AuthSession = {
                id: 'session-1',
                deviceCode: 'device-1',
                userCode: 'ABCD-1234',
                status: 'APPROVED',
                userId: 'user-123',
                expiresAt: new Date(Date.now() + 10000),
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            mockRepo.findSessionByDeviceCode = mock.fn(async () => approvedSession);
            mockRepo.updateSessionStatus = mock.fn(async () => undefined);

            mockRepo.createApiToken = mock.fn(async (input: any) => ({
                id: 'token-1',
                ...input,
                createdAt: new Date(),
                lastUsedAt: null
            }));

            const result = await authService.exchangeCodeForToken('device-1');

            assert.ok(result);
            assert.ok(result?.token.startsWith('paw_')); // Returns plaintext

            // Check hashing in repo
            const createCall = (mockRepo.createApiToken as any).mock.calls[0].arguments[0];
            assert.notStrictEqual(createCall.token, result?.token); // Stored token should be hash, result is plain

            // Should mark session as EXPIRED (consumed)
            assert.deepStrictEqual((mockRepo.updateSessionStatus as any).mock.calls[0].arguments, ['session-1', 'EXPIRED']);
        });
    });

    describe('validateToken', () => {
        test('should validate correct token', async () => {
            const plainToken = 'paw_123456';
            const hashedToken = createHash('sha256').update(plainToken).digest('hex');

            const apiToken: ApiToken = {
                id: 'token-1',
                token: hashedToken,
                userId: 'user-123',
                name: 'Test',
                expiresAt: new Date(Date.now() + 10000),
                lastUsedAt: null,
                createdAt: new Date(),
            };

            mockRepo.findApiToken = mock.fn(async () => apiToken);
            mockRepo.updateApiTokenLastUsed = mock.fn(async () => undefined);

            const result = await authService.validateToken(plainToken);

            assert.deepStrictEqual(result, apiToken);
            assert.strictEqual((mockRepo.findApiToken as any).mock.calls[0].arguments[0], hashedToken);
        });

        test('should return null for expired token', async () => {
            const plainToken = 'paw_123456';
            const apiToken: ApiToken = {
                id: 'token-1',
                token: 'hashed',
                userId: 'user-123',
                name: 'Test',
                expiresAt: new Date(Date.now() - 1000), // Expired
                lastUsedAt: null,
                createdAt: new Date(),
            };
            mockRepo.findApiToken = mock.fn(async () => apiToken);

            const result = await authService.validateToken(plainToken);
            assert.strictEqual(result, null);
        });
    });

});
