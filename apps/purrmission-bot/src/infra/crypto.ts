/**
 * Cryptographic utilities for encrypting/decrypting sensitive data.
 *
 * Uses AES-256-GCM for authenticated encryption at rest.
 * Requires ENCRYPTION_KEY environment variable (32-byte hex string = 64 hex chars).
 */

import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16;
const HEX_REGEX = /^[0-9a-fA-F]{64}$/;

const V1_PREFIX = 'v1:';

/**
 * Get the encryption key from environment.
 * @throws Error if ENCRYPTION_KEY is not set or invalid
 */
function getEncryptionKey(): Buffer {
    const keyHex = env.ENCRYPTION_KEY;
    if (!keyHex) {
        throw new Error('ENCRYPTION_KEY environment variable is not set');
    }

    if (!HEX_REGEX.test(keyHex)) {
        throw new Error('ENCRYPTION_KEY must be a valid 32-byte hex string (64 hexadecimal characters)');
    }

    return Buffer.from(keyHex, 'hex');
}

/**
 * Validates the encryption configuration and performs a test encryption/decryption cycle.
 * Should be called at application startup.
 * @throws Error if configuration is invalid or crypto operations fail
 */
export function validateEncryptionConfig(): void {
    try {
        const key = getEncryptionKey();
        if (key.length !== 32) {
            throw new Error(`Invalid key length: expected 32 bytes, got ${key.length}`);
        }

        // Test cycle
        const testPayload = 'purrmission-startup-check-' + Date.now();
        const encrypted = encryptValue(testPayload);
        const decrypted = decryptValue(encrypted);

        if (decrypted !== testPayload) {
            throw new Error('Encryption round-trip failed: decrypted value does not match original');
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Encryption configuration validation failed: ${msg}`);
    }
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt
 * @param keyBuffer - Optional explicit key to use (defaults to env.ENCRYPTION_KEY)
 * @returns Versioned ciphertext string (e.g., "v1:iv:authTag:ciphertext")
 */
export function encryptValue(plaintext: string, keyBuffer?: Buffer): string {
    const key = keyBuffer || getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: v1:base64(iv):base64(authTag):base64(ciphertext)
    return `${V1_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a ciphertext string.
 * Supports legacy format (iv:tag:data) and v1 format (v1:iv:tag:data).
 *
 * @param ciphertext - The encrypted string
 * @param keyBuffer - Optional explicit key to use (defaults to env.ENCRYPTION_KEY)
 * @returns The decrypted plaintext string
 * @throws Error if decryption fails
 */
export function decryptValue(ciphertext: string, keyBuffer?: Buffer): string {
    const key = keyBuffer || getEncryptionKey();
    let ivStr, tagStr, dataStr;

    if (ciphertext.startsWith(V1_PREFIX)) {
        // v1 format: v1:iv:tag:data
        const parts = ciphertext.slice(V1_PREFIX.length).split(':');
        if (parts.length !== 3) {
            throw new Error('Decryption failed: invalid v1 data format');
        }
        [ivStr, tagStr, dataStr] = parts;
    } else {
        // Legacy format: iv:tag:data
        const parts = ciphertext.split(':');
        if (parts.length !== 3) {
            throw new Error('Decryption failed: invalid legacy data format');
        }
        [ivStr, tagStr, dataStr] = parts;
    }

    try {
        const iv = Buffer.from(ivStr, 'base64');
        const authTag = Buffer.from(tagStr, 'base64');
        const encrypted = Buffer.from(dataStr, 'base64');

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
            authTagLength: AUTH_TAG_LENGTH,
        });
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        // Generic error to avoid leaking cryptographic details
        throw new Error('Decryption failed: invalid data or wrong key');
    }
}

