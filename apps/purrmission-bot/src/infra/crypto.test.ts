import { describe, it } from 'node:test';
import assert from 'node:assert';
import { encryptValue, decryptValue, validateEncryptionConfig } from './crypto.js';

describe('Crypto Infra', () => {
    it('should encrypt and decrypt a value correctly (v1)', () => {
        const secret = 'super-secret-value';
        const encrypted = encryptValue(secret);
        assert.ok(encrypted.startsWith('v1:'), 'Ciphertext should start with v1:');

        const decrypted = decryptValue(encrypted);
        assert.strictEqual(decrypted, secret);
    });

    it('should decrypt legacy format correctly', () => {
        // We simulate a legacy failure (invalid format) vs a crypto failure

        const invalidLegacy = 'not-enough-parts';
        try {
            decryptValue(invalidLegacy);
            assert.fail('Should have thrown');
        } catch (e: any) {
            assert.match(e.message, /Decryption failed: invalid legacy data format/);
        }

        const validStructureWrongKey = 'a:b:c';
        try {
            decryptValue(validStructureWrongKey);
            // This might fail base64 decode or auth tag check
            assert.fail('Should have thrown');
        } catch (e: any) {
            // It passed the "parts check" for legacy, so it failed deeper
            assert.match(e.message, /Decryption failed: invalid data/);
        }
    });

    it('should validate encryption config successfully', () => {
        // Should not throw
        validateEncryptionConfig();
    });
});
