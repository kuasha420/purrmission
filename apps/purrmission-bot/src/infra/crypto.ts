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
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt
 * @returns Base64-encoded ciphertext in format: iv:authTag:ciphertext
 */
export function encryptValue(plaintext: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: base64(iv):base64(authTag):base64(ciphertext)
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a ciphertext string encrypted with encryptValue.
 *
 * @param ciphertext - Base64-encoded ciphertext in format: iv:authTag:ciphertext
 * @returns The decrypted plaintext string
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export function decryptValue(ciphertext: string): string {
    const key = getEncryptionKey();
    const parts = ciphertext.split(':');

    if (parts.length !== 3) {
        // Generic error to avoid leaking information about expected format
        throw new Error('Decryption failed: invalid data');
    }

    try {
        const iv = Buffer.from(parts[0], 'base64');
        const authTag = Buffer.from(parts[1], 'base64');
        const encrypted = Buffer.from(parts[2], 'base64');

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

