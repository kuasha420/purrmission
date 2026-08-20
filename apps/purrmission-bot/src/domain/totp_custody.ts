import crypto from 'node:crypto';
import type { TOTPDelegationPolicy, TOTPLinkEnvelope } from './models.js';

const MAX_GRANT_TTL_SECONDS = 300;
const MAX_CONSENT_TTL_MS = 5 * 60_000;
const CODE_OPERATION = 'totp.code.read' as const;

export interface TOTPDelegationPolicyInput {
  allowDelegation?: unknown;
  allowedOperations?: unknown;
  allowedAuthFamilies?: unknown;
  allowedAudiences?: unknown;
  maxGrantTtlSeconds?: unknown;
}

function strictStringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const values = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 128
  );
  return values.length === value.length ? [...new Set(values)] : null;
}

/** Parse a persisted/input policy. Anything missing or unrecognized defaults to no delegation. */
export function parseTOTPDelegationPolicy(input: unknown): TOTPDelegationPolicy {
  const denied: TOTPDelegationPolicy = {
    allowDelegation: false,
    allowedOperations: [],
    allowedAuthFamilies: [],
    allowedAudiences: [],
    maxGrantTtlSeconds: 0,
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return denied;
  const candidate = input as TOTPDelegationPolicyInput;
  const allowedKeys = new Set([
    'allowDelegation',
    'allowedOperations',
    'allowedAuthFamilies',
    'allowedAudiences',
    'maxGrantTtlSeconds',
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return denied;
  const operations = strictStringList(candidate.allowedOperations);
  const authFamilies = strictStringList(candidate.allowedAuthFamilies);
  const audiences = strictStringList(candidate.allowedAudiences);
  const ttl = candidate.maxGrantTtlSeconds;
  if (
    candidate.allowDelegation !== true ||
    !operations ||
    operations.length !== 1 ||
    operations[0] !== CODE_OPERATION ||
    !authFamilies ||
    !audiences ||
    typeof ttl !== 'number' ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > MAX_GRANT_TTL_SECONDS
  ) {
    return denied;
  }
  return {
    allowDelegation: true,
    allowedOperations: [CODE_OPERATION],
    allowedAuthFamilies: authFamilies,
    allowedAudiences: audiences,
    maxGrantTtlSeconds: ttl,
  };
}

export function createTOTPLinkEnvelope(input: {
  consentId: string;
  resourceId: string;
  initiatingResourceOwnerId: string;
  accountOwnerDiscordUserId: string;
  accountVersion: string;
  linkPolicyVersion?: string;
  delegationPolicy: TOTPDelegationPolicy;
  createdAt?: Date;
}): TOTPLinkEnvelope {
  return Object.freeze({
    schemaVersion: 1 as const,
    consentId: input.consentId,
    resourceId: input.resourceId,
    initiatingResourceOwnerId: input.initiatingResourceOwnerId,
    accountOwnerDiscordUserId: input.accountOwnerDiscordUserId,
    accountVersion: input.accountVersion,
    linkPolicyVersion: input.linkPolicyVersion ?? crypto.randomUUID(),
    delegationPolicy: input.delegationPolicy,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  });
}

export function validateTOTPLinkEnvelope(value: unknown): TOTPLinkEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<TOTPLinkEnvelope>;
  const allowedKeys = new Set([
    'schemaVersion',
    'consentId',
    'resourceId',
    'initiatingResourceOwnerId',
    'delegationPolicy',
    'accountOwnerDiscordUserId',
    'accountVersion',
    'linkPolicyVersion',
    'createdAt',
  ]);
  if (
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    input.schemaVersion !== 1 ||
    !isBoundedNonEmptyString(input.consentId) ||
    !isBoundedNonEmptyString(input.resourceId) ||
    !isBoundedNonEmptyString(input.initiatingResourceOwnerId) ||
    !isBoundedNonEmptyString(input.accountOwnerDiscordUserId) ||
    !isBoundedNonEmptyString(input.accountVersion) ||
    !isBoundedNonEmptyString(input.linkPolicyVersion) ||
    typeof input.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(input.createdAt))
  ) {
    return null;
  }
  const policy = parseTOTPDelegationPolicy(input.delegationPolicy);
  return {
    schemaVersion: 1,
    consentId: input.consentId,
    resourceId: input.resourceId,
    initiatingResourceOwnerId: input.initiatingResourceOwnerId,
    delegationPolicy: policy,
    accountOwnerDiscordUserId: input.accountOwnerDiscordUserId,
    accountVersion: input.accountVersion,
    linkPolicyVersion: input.linkPolicyVersion,
    createdAt: input.createdAt,
  };
}

function isBoundedNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function boundedConsentExpiry(now = new Date()): Date {
  return new Date(now.getTime() + MAX_CONSENT_TTL_MS);
}

export { CODE_OPERATION, MAX_CONSENT_TTL_MS, MAX_GRANT_TTL_SECONDS };
