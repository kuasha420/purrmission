import crypto from 'node:crypto';

/**
 * KeyManager handles purpose-separated HMAC key derivation and key rotation.
 */
export class KeyManager {
  /**
   * Derive purpose-specific keys from the configured CREDENTIAL_HMAC_KEYS list.
   * If the env variable is not set, a fallback is used for local dev/testing.
   */
  private static getKeys(purpose: string): string[] {
    const masterKeysStr =
      process.env.CREDENTIAL_HMAC_KEYS ||
      'default-master-hmac-key-material-must-be-changed-in-production';
    const masterKeys = masterKeysStr
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    // Derive a unique key for each purpose from each master key
    return masterKeys.map((masterKey) =>
      crypto.createHmac('sha256', masterKey).update(purpose).digest('hex')
    );
  }

  /**
   * Returns the derived key for the current active master key.
   */
  static getActiveKey(purpose: string): string {
    return this.getKeys(purpose)[0];
  }

  /**
   * Returns derived keys for all configured master keys in rotation.
   */
  static getAllKeys(purpose: string): string[] {
    return this.getKeys(purpose);
  }
}

/**
 * Computes the keyed HMAC-SHA256 digest of a plaintext key for a specific purpose.
 * Uses the active derived key.
 */
export function computeKeyedDigest(plaintext: string, purpose: string): string {
  const activeKey = KeyManager.getActiveKey(purpose);
  return crypto.createHmac('sha256', activeKey).update(plaintext).digest('hex');
}

/**
 * Verifies if a plaintext key matches a target digest for a specific purpose.
 * Traverses all derived keys in rotation (active and historic).
 */
export function verifyKeyedDigest(
  plaintext: string,
  digestToMatch: string,
  purpose: string
): boolean {
  const derivedKeys = KeyManager.getAllKeys(purpose);
  for (const key of derivedKeys) {
    const digest = crypto.createHmac('sha256', key).update(plaintext).digest('hex');
    if (
      digest.length === digestToMatch.length &&
      crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(digestToMatch))
    ) {
      return true;
    }
  }
  return false;
} /**
 * Computes all possible keyed digests for a plaintext key across all keys in rotation.
 */
export function computeAllKeyedDigests(plaintext: string, purpose: string): string[] {
  const derivedKeys = KeyManager.getAllKeys(purpose);
  return derivedKeys.map((key) => crypto.createHmac('sha256', key).update(plaintext).digest('hex'));
}
