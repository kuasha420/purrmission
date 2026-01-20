
/**
 * Policy definition for accessing sensitive resources (Fields, TOTP Codes).
 */

import type { Resource, Guardian } from './models.js';

export interface AccessRequest {
    resourceId: string;
    actorDiscordId: string;
}

export interface AccessPolicyResult {
    allowed: boolean;
    requiresApproval: boolean;
    reason?: string;
}

import type { Repositories } from './repositories.js';

/**
 * Determine if an actor can access a resource.
 * 
 * Logic:
 * 1. Owners and Guardians have DIRECT access (no approval needed).
 * 2. If an active, approved request exists for the actor -> ALLOWED.
 * 3. Otherwise -> APPROVAL_REQUIRED (or DENIED if functionality limited).
 */
export async function checkAccessPolicy(
    resource: Resource,
    guardians: Guardian[],
    actorDiscordId: string,
    repositories?: Repositories
): Promise<AccessPolicyResult> {
    const isGuardian = guardians.some(g => g.discordUserId === actorDiscordId);

    if (isGuardian) {
        return {
            allowed: true,
            requiresApproval: false,
            reason: 'User is a guardian/owner',
        };
    }

    if (repositories) {
        const activeRequest = await repositories.approvalRequests.findActiveByRequester(resource.id, actorDiscordId);
        if (activeRequest && activeRequest.status === 'APPROVED') {
            // Check expiry if applicable
            if (activeRequest.expiresAt && activeRequest.expiresAt < new Date()) {
                return {
                    allowed: false,
                    requiresApproval: true,
                    reason: 'Previous approval has expired',
                };
            }

            return {
                allowed: true,
                requiresApproval: false,
                reason: 'Active approval granted',
            };
        }
    }

    return {
        allowed: false,
        requiresApproval: true,
        reason: 'User is not a guardian',
    };
}

/**
 * Helper to check if approval is required.
 */
export function requiresApproval(result: AccessPolicyResult): boolean {
    return result.requiresApproval;
}
