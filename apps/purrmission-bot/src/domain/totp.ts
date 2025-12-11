import { authenticator } from 'otplib';
import type { TOTPAccount } from './models.js';

// Configure authenticator with sane defaults
authenticator.options = {
  ...authenticator.options,
  step: 30,
  digits: 6,
  // encoding: "base32" -> authenticator defaults to base32 via keyEncoder/keyDecoder
};
// TODO: In the future, per-account options (step/digits) may be supported if needed.

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

  // Check host or type. usually otpauth://totp/...
  // node's URL parser might put 'totp' in host if the slashes are present.
  // otpauth URIs are technically `otpauth://TYPE/LABEL?PARAMETERS`.
  if (url.hostname !== 'totp' && !url.pathname.startsWith('//totp')) {
    // Some libs might produce otpauth:totp... without //
    // But standard is usually otpauth://totp
    // Let's be strict for now based on what typical apps generate.
    if (url.hostname !== 'totp') {
      throw new Error('Only TOTP URIs are supported');
    }
  }

  // Extract label / account name
  // Pathname is usually `/Label` or `/Issuer:Label`
  // remove leading slash
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

  // TODO: Encryption at rest will be added in a later mission
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
  // Lightweight validation
  if (!secret || secret.trim().length === 0) {
    throw new Error('Secret cannot be empty');
  }

  // Basic Base32 check (A-Z, 2-7, =)
  const base32Regex = /^[A-Z2-7=]+$/i;
  if (!base32Regex.test(secret)) {
    throw new Error('Invalid TOTP secret format (Base32 expected)');
  }

  return {
    ownerDiscordUserId,
    accountName,
    issuer,
    secret,
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
