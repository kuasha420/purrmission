import { authenticator } from 'otplib';
import type { TOTPAccount } from './models.js';

// Configure authenticator
authenticator.options = {
  ...authenticator.options,
  step: 30,
  digits: 6,
};

export interface ParsedOtpauthUri {
  accountName: string;
  issuer?: string;
  secret: string;
}

/**
 * Validates and parses an otpauth://totp/... URI.
 * Throws an Error if the URI is invalid or not supported.
 */
export function parseOtpauthUri(uri: string): ParsedOtpauthUri {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('Invalid URI format');
  }

  if (url.protocol !== 'otpauth:') {
    throw new Error(`Invalid protocol: ${url.protocol}. Expected 'otpauth:'`);
  }

  if (url.hostname !== 'totp') {
    throw new Error('Only TOTP URIs are supported');
  }

  const label = decodeURIComponent(url.pathname.substring(1));
  if (!label) {
    throw new Error('Missing label in TOTP URI');
  }

  // TODO: Add smarter splitting on 'issuer:account' if needed. For now use full label.
  const accountName = label;

  const secret = url.searchParams.get('secret');
  if (!secret) {
    throw new Error("Missing 'secret' query parameter");
  }

  const issuer = url.searchParams.get('issuer') || undefined;

  return {
    accountName,
    issuer,
    secret,
  };
}

/**
 * Creates a TOTPAccount structure (without DB ID) from a URI.
 */
export function createTOTPAccountFromUri(
  ownerDiscordUserId: string,
  uri: string,
  shared: boolean
): Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt'> {
  const { accountName, issuer, secret } = parseOtpauthUri(uri);


  return {
    ownerDiscordUserId,
    accountName,
    issuer,
    secret,
    shared,
  };
}

/**
 * Creates a TOTPAccount structure (without DB ID) from a raw secret.
 */
export function createTOTPAccountFromSecret(
  ownerDiscordUserId: string,
  accountName: string,
  secret: string,
  issuer: string | undefined,
  shared: boolean
): Omit<TOTPAccount, 'id' | 'createdAt' | 'updatedAt'> {

  if (!secret || secret.trim().length === 0) {
    throw new Error('Secret cannot be empty');
  }

  // Sanitize secret: remove all whitespace (including internal spaces)
  // Google Authenticator often displays secrets with spaces for readability.
  const sanitizedSecret = secret.replace(/\s+/g, '');

  // Stricter Base32 check: A-Z, 2-7, with optional padding only at the end (per RFC 4648)
  const base32Regex = /^[A-Z2-7]+=*$/i;
  if (!base32Regex.test(sanitizedSecret)) {
    throw new Error('Invalid TOTP secret format (Base32 expected)');
  }

  return {
    ownerDiscordUserId,
    accountName,
    issuer,
    secret: sanitizedSecret,
    shared,
  };
}

/**
 * Generates the current TOTP code for the given account.
 * Uses the current system time via authenticator.
 */
export function generateTOTPCode(account: TOTPAccount): string {
  return authenticator.generate(account.secret);
}

/**
 * Verifies a token against the account's secret.
 */
export function verifyTOTPCode(account: TOTPAccount, token: string): boolean {
  return authenticator.verify({ token, secret: account.secret });
}
