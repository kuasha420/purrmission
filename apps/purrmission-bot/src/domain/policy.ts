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
  const isGuardian = guardians.some((g) => g.discordUserId === actorDiscordId);

  if (isGuardian) {
    return {
      allowed: true,
      requiresApproval: false,
      reason: 'User is a guardian/owner',
    };
  }

  if (repositories) {
    const activeRequest = await repositories.approvalRequests.findActiveByRequester(
      resource.id,
      actorDiscordId
    );
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

/**
 * Retrieve the effective list of guardians for a resource (explicit database guardians
 * + project owner as OWNER + project WRITER members as GUARDIAN).
 */
export async function getEffectiveGuardians(
  repositories: Repositories,
  resourceId: string
): Promise<Guardian[]> {
  // 1. Get explicit guardians from database
  const explicitGuardians = (await repositories.guardians.findByResourceId(resourceId)) || [];

  // Use a map keyed by discordUserId to deduplicate/override
  const guardianMap = new Map<string, Guardian>();
  explicitGuardians.forEach((g) => guardianMap.set(g.discordUserId || g.id, g));

  // 2. Check if resource is linked to an environment
  const environment = await repositories.projects.findEnvironmentByResourceId(resourceId);
  if (environment) {
    const project = await repositories.projects.findById(environment.projectId);
    if (project) {
      // Project owner -> OWNER role
      if (!guardianMap.has(project.ownerId)) {
        guardianMap.set(project.ownerId, {
          id: `project-owner-${project.id}-${project.ownerId}`,
          resourceId,
          discordUserId: project.ownerId,
          role: 'OWNER',
          createdAt: project.createdAt,
        });
      }

      // Project members with WRITER -> GUARDIAN role
      const members = await repositories.projects.listMembers(project.id);
      const writers = members.filter((m) => m.role === 'WRITER');
      for (const writer of writers) {
        if (!guardianMap.has(writer.userId)) {
          guardianMap.set(writer.userId, {
            id: `project-member-${writer.id}`,
            resourceId,
            discordUserId: writer.userId,
            role: 'GUARDIAN',
            createdAt: writer.createdAt,
          });
        }
      }
    }
  }

  return Array.from(guardianMap.values());
}

/**
 * Check if a user is an effective guardian (explicit or project owner/writer) for a resource.
 */
export async function isEffectiveGuardian(
  repositories: Repositories,
  resourceId: string,
  userId: string
): Promise<boolean> {
  // 1. Check explicit guardians table for this user first
  const explicitGuardian = await repositories.guardians.findByResourceAndUser(resourceId, userId);
  if (explicitGuardian) {
    return true;
  }

  // 2. Resolve other effective guardians (project owner, project writer)
  const environment = await repositories.projects.findEnvironmentByResourceId(resourceId);
  if (environment) {
    const project = await repositories.projects.findById(environment.projectId);
    if (project) {
      if (project.ownerId === userId) {
        return true;
      }
      const memberRole = await repositories.projects.getMemberRole(project.id, userId);
      if (memberRole === 'WRITER') {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a user is an effective owner of a resource.
 */
export async function isEffectiveOwner(
  repositories: Repositories,
  resourceId: string,
  userId: string
): Promise<boolean> {
  // 1. Check explicit guardians table for this user first
  const explicitGuardian = await repositories.guardians.findByResourceAndUser(resourceId, userId);
  if (explicitGuardian && explicitGuardian.role === 'OWNER') {
    return true;
  }

  // 2. Resolve other effective guardians (project owner)
  const environment = await repositories.projects.findEnvironmentByResourceId(resourceId);
  if (environment) {
    const project = await repositories.projects.findById(environment.projectId);
    if (project && project.ownerId === userId) {
      return true;
    }
  }

  return false;
}

/**
 * Get all resources that a user effectively guards.
 */
export async function getGuardedResourcesForUser(
  repositories: Repositories,
  userId: string
): Promise<Resource[]> {
  // Use a Map keyed by resourceId to deduplicate
  const resourceMap = new Map<string, Resource>();

  // 1. Get explicit guarded resources
  const explicitGuardians = await repositories.guardians.findByUserId(userId);
  if (explicitGuardians && explicitGuardians.length > 0) {
    const resourceIds = explicitGuardians
      .map((g) => g.resourceId)
      .filter((id): id is string => !!id);
    if (resourceIds.length > 0) {
      const explicitResources = await repositories.resources.findManyByIds(resourceIds);
      explicitResources.forEach((r) => resourceMap.set(r.id, r));
    }
  }

  // 2. Resolve resources inherited via project ownership
  const ownedProjects = await repositories.projects.listProjectsByOwner(userId);
  for (const project of ownedProjects) {
    const envs = await repositories.projects.listEnvironments(project.id);
    const resourceIds = envs.map((e) => e.resourceId).filter((id): id is string => !!id);
    if (resourceIds.length > 0) {
      const projectResources = await repositories.resources.findManyByIds(resourceIds);
      projectResources.forEach((r) => resourceMap.set(r.id, r));
    }
  }

  // 3. Resolve resources inherited via project writer role
  const memberships = await repositories.projects.listMembershipsByUser(userId);
  const writerProjectIds = memberships.filter((m) => m.role === 'WRITER').map((m) => m.projectId);
  for (const projectId of writerProjectIds) {
    const envs = await repositories.projects.listEnvironments(projectId);
    const resourceIds = envs.map((e) => e.resourceId).filter((id): id is string => !!id);
    if (resourceIds.length > 0) {
      const projectResources = await repositories.resources.findManyByIds(resourceIds);
      projectResources.forEach((r) => resourceMap.set(r.id, r));
    }
  }

  return Array.from(resourceMap.values());
}
