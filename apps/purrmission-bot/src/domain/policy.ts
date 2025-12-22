
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

/**
 * Determine if an actor can access a resource.
 * 
 * Logic:
 * 1. Owners and Guardians have DIRECT access (no approval needed).
 * 2. Everyone else requires APPROVAL (if flow exists) or is DENIED (if flow not supported yet).
 */
export async function checkAccessPolicy(
    resource: Resource,
    guardians: Guardian[],
    actorDiscordId: string
): Promise<AccessPolicyResult> {
    const isGuardian = guardians.some(g => g.discordUserId === actorDiscordId);

    if (isGuardian) {
        return {
            allowed: true,
            requiresApproval: false,
            reason: 'User is a guardian/owner',
        };
    }

    // Future: Check if there's an active, approved request for this actor?
    // For now, non-guardians always require approval flow to be initiated.

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
