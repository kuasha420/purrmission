import crypto from 'node:crypto';

/**
 * KeyManager handles purpose-separated HMAC key derivation and key rotation.
 */
export class KeyManager {
  /**
   * Derive purpose-specific keys from the configured CREDENTIAL_HMAC_KEYS list.
   * If the env variable is not set, a fallback is used for local dev/testing.
   */
  private static getKeyEntries(purpose: string): Array<{ id: string; key: string }> {
    const json = process.env.CREDENTIAL_HMAC_KEYS_JSON;
    let masterKeys: Array<{ id: string; secret: string }>;
    if (json) {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('CREDENTIAL_HMAC_KEYS_JSON must be an object keyed by stable key ID.');
      }
      masterKeys = Object.entries(parsed).map(([id, secret]) => {
        if (!id || typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
          throw new Error(
            'Credential HMAC key IDs must be non-empty and secrets at least 32 bytes.'
          );
        }
        return { id, secret };
      });
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('CREDENTIAL_HMAC_KEYS_JSON is required in production.');
      }
      const legacy =
        process.env.CREDENTIAL_HMAC_KEYS ||
        'default-master-hmac-key-material-must-be-changed-in-production';
      masterKeys = legacy
        .split(',')
        .map((secret) => secret.trim())
        .filter(Boolean)
        .map((secret, index) => ({ id: `legacy-${index}`, secret }));
    }
    if (masterKeys.length === 0) throw new Error('At least one credential HMAC key is required.');

    if (process.env.NODE_ENV === 'production' && !process.env.CREDENTIAL_HMAC_ACTIVE_KEY_ID) {
      throw new Error('CREDENTIAL_HMAC_ACTIVE_KEY_ID is required in production.');
    }
    const activeId = process.env.CREDENTIAL_HMAC_ACTIVE_KEY_ID ?? masterKeys[0].id;
    const active = masterKeys.find(({ id }) => id === activeId);
    if (!active) throw new Error('CREDENTIAL_HMAC_ACTIVE_KEY_ID is absent from the key ring.');
    const ordered = [active, ...masterKeys.filter(({ id }) => id !== activeId)];

    // Derive a unique key for each purpose from each master key
    return ordered.map(({ id, secret }) => ({
      id,
      key: crypto.createHmac('sha256', secret).update(purpose).digest('hex'),
    }));
  }

  /**
   * Returns the derived key for the current active master key.
   */
  static getActiveKey(purpose: string): string {
    return this.getKeyEntries(purpose)[0].key;
  }

  static getActiveKeyId(purpose: string): string {
    return this.getKeyEntries(purpose)[0].id;
  }

  /**
   * Returns derived keys for all configured master keys in rotation.
   */
  static getAllKeys(purpose: string): string[] {
    return this.getKeyEntries(purpose).map(({ key }) => key);
  }

  static getAllKeyEntries(purpose: string): Array<{ id: string; key: string }> {
    return this.getKeyEntries(purpose);
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

export function computeKeyedDigestRecord(
  plaintext: string,
  purpose: string
): { digest: string; keyId: string } {
  return {
    digest: computeKeyedDigest(plaintext, purpose),
    keyId: KeyManager.getActiveKeyId(purpose),
  };
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
  return computeAllKeyedDigestCandidates(plaintext, purpose).map(({ digest }) => digest);
}

export function computeAllKeyedDigestCandidates(
  plaintext: string,
  purpose: string
): Array<{ digest: string; keyId: string }> {
  return KeyManager.getAllKeyEntries(purpose).map(({ id, key }) => ({
    keyId: id,
    digest: crypto.createHmac('sha256', key).update(plaintext).digest('hex'),
  }));
}

/**
 * Generates a deterministic UUID v5 structure using SHA-256.
 */
export function deterministicUUID(value: string): string {
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  const p1 = hash.substring(0, 8);
  const p2 = hash.substring(8, 12);
  const p3 = '5' + hash.substring(13, 16);
  const p4 = '8' + hash.substring(17, 20);
  const p5 = hash.substring(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}
