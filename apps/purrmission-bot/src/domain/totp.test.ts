import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTOTPAccountFromSecret } from './totp.js';

describe('Bypassing spaces in TOTP secrets', () => {
    const accountBase = {
        ownerDiscordUserId: 'user-123',
        accountName: 'Test Account',
        issuer: undefined,
        shared: false,
    };

    test('should accept a valid Base32 secret without spaces', () => {
        const validSecret = 'JBSWY3DPEHPK3PXP'; // Base32 for 'Hello!'
        const account = createTOTPAccountFromSecret(
            accountBase.ownerDiscordUserId,
            accountBase.accountName,
            validSecret,
            accountBase.issuer,
            accountBase.shared
        );
        assert.strictEqual(account.secret, validSecret);
    });

    test('should accept a valid Base32 secret with spaces', () => {
        const secretWithSpaces = 'JBSWY 3DPEH PK3PX P';
        const expectedSecret = 'JBSWY3DPEHPK3PXP';
        const account = createTOTPAccountFromSecret(
            accountBase.ownerDiscordUserId,
            accountBase.accountName,
            secretWithSpaces,
            accountBase.issuer,
            accountBase.shared
        );
        assert.strictEqual(account.secret, expectedSecret);
    });

    test('should accept a valid Base32 secret with multiple spaces', () => {
        const secretWithSpaces = '  JBSWY   3DPEH   PK3PX   P  ';
        const expectedSecret = 'JBSWY3DPEHPK3PXP';
        const account = createTOTPAccountFromSecret(
            accountBase.ownerDiscordUserId,
            accountBase.accountName,
            secretWithSpaces,
            accountBase.issuer,
            accountBase.shared
        );
        assert.strictEqual(account.secret, expectedSecret);
    });

    test('should throw error for invalid Base32 characters even with spaces', () => {
        const invalidSecret = 'JBSWY 3DPEH PK3PX 1'; // '1' is not valid Base32
        assert.throws(() => {
            createTOTPAccountFromSecret(
                accountBase.ownerDiscordUserId,
                accountBase.accountName,
                invalidSecret,
                accountBase.issuer,
                accountBase.shared
            );
        }, /Invalid TOTP secret/);
    });
});
