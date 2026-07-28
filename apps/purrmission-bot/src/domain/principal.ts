import { randomUUID } from 'node:crypto';
import type { AuthKind, Principal, PrincipalType, ReasonCode } from './models.js';

const AUTH_KIND_BY_PRINCIPAL_TYPE: Readonly<Record<PrincipalType, AuthKind>> = {
  DISCORD_USER: 'DISCORD',
  PAWTHY_TOKEN: 'PAWTHY',
  RESOURCE_API_KEY: 'API_KEY',
  SERVICE: 'SERVICE',
};

export interface PrincipalValidationResult {
  valid: boolean;
  reasonCode?: Extract<ReasonCode, 'INVALID_AUTH' | 'AUTH_SUBJECT_MISMATCH' | 'WRONG_AUDIENCE'>;
  safeExplanation?: string;
}

/**
 * Constructs the principal used by Discord interactions. The provider identity is the subject,
 * while the prefixed ID represents the authentication record for this interaction.
 */
export function createDiscordPrincipal(discordUserId: string, correlationId?: string): Principal {
  return {
    type: 'DISCORD_USER',
    id: `discord-interaction:${correlationId ?? randomUUID()}`,
    subjectId: discordUserId,
    authKind: 'DISCORD',
    actorDiscordId: discordUserId,
    correlationId,
  };
}

/**
 * Returns the only identity that may participate in role and ownership authorization.
 */
export function authorizationSubjectId(principal: Principal): string {
  return principal.subjectId;
}

/**
 * Validates authentication provenance without consulting object roles.
 */
export function validatePrincipal(
  principal: Principal,
  requiredAudience?: string
): PrincipalValidationResult {
  if (!principal.id.trim() || !principal.subjectId.trim()) {
    return {
      valid: false,
      reasonCode: 'INVALID_AUTH',
      safeExplanation: 'Authentication identity is incomplete.',
    };
  }

  if (AUTH_KIND_BY_PRINCIPAL_TYPE[principal.type] !== principal.authKind) {
    return {
      valid: false,
      reasonCode: 'INVALID_AUTH',
      safeExplanation: 'Authentication provenance is invalid.',
    };
  }

  if (
    (principal.type === 'DISCORD_USER' || principal.type === 'PAWTHY_TOKEN') &&
    principal.actorDiscordId !== undefined &&
    principal.actorDiscordId !== principal.subjectId
  ) {
    return {
      valid: false,
      reasonCode: 'AUTH_SUBJECT_MISMATCH',
      safeExplanation: 'Authenticated actor does not match the authorization subject.',
    };
  }

  if (requiredAudience && principal.audience !== requiredAudience) {
    return {
      valid: false,
      reasonCode: 'WRONG_AUDIENCE',
      safeExplanation: 'Credential audience is not valid for this operation.',
    };
  }

  return { valid: true };
}
