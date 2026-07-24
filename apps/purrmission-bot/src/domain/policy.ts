/**
 * Policy definition for accessing sensitive resources (Fields, TOTP Codes).
 */

import type {
  Resource,
  Guardian,
  Principal,
  Capability,
  CapabilityContext,
  EvaluationResult,
  ReasonCode,
} from './models.js';

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
  explicitGuardians.forEach((g) => guardianMap.set(g.discordUserId, g));

  // 2. Check if resource is linked to an environment
  const environment = repositories.projects
    ? await repositories.projects.findEnvironmentByResourceId(resourceId)
    : null;
  if (environment && repositories.projects) {
    const project = await repositories.projects.findById(environment.projectId);
    if (project) {
      // Project owner -> OWNER role (upgrade if they only have GUARDIAN role explicitly)
      const existingOwner = guardianMap.get(project.ownerId);
      if (!existingOwner || existingOwner.role !== 'OWNER') {
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
  let explicitGuardian = null;
  if (repositories.guardians.findByResourceAndUser) {
    explicitGuardian = await repositories.guardians.findByResourceAndUser(resourceId, userId);
  } else if (repositories.guardians.findByUserId) {
    const list = await repositories.guardians.findByUserId(userId);
    explicitGuardian = list.find((g) => g.resourceId === resourceId) || null;
  }
  if (explicitGuardian) {
    return true;
  }

  // 2. Resolve other effective guardians (project owner, project writer)
  const environment = repositories.projects
    ? await repositories.projects.findEnvironmentByResourceId(resourceId)
    : null;
  if (environment && repositories.projects) {
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
  let explicitGuardian = null;
  if (repositories.guardians.findByResourceAndUser) {
    explicitGuardian = await repositories.guardians.findByResourceAndUser(resourceId, userId);
  } else if (repositories.guardians.findByUserId) {
    const list = await repositories.guardians.findByUserId(userId);
    explicitGuardian = list.find((g) => g.resourceId === resourceId) || null;
  }
  if (explicitGuardian && explicitGuardian.role === 'OWNER') {
    return true;
  }

  // 2. Resolve other effective guardians (project owner)
  const environment = repositories.projects
    ? await repositories.projects.findEnvironmentByResourceId(resourceId)
    : null;
  if (environment && repositories.projects) {
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
  userId: string,
  query?: string
): Promise<Resource[]> {
  // Use a Map keyed by resourceId to deduplicate
  const resourceMap = new Map<string, Resource>();

  // 1. Get explicit guarded resources
  const explicitGuardians = await repositories.guardians.findByUserId(userId);
  const explicitResourceIds = explicitGuardians
    ? explicitGuardians.map((g) => g.resourceId).filter((id): id is string => !!id)
    : [];

  // 2. Resolve resources inherited via project ownership
  const ownedProjects = repositories.projects
    ? await repositories.projects.listProjectsByOwner(userId)
    : [];
  const ownedProjectEnvironments = await Promise.all(
    ownedProjects.map((project) => repositories.projects.listEnvironments(project.id))
  );
  const ownedResourceIds = ownedProjectEnvironments
    .flat()
    .map((e) => e.resourceId)
    .filter((id): id is string => !!id);

  // 3. Resolve resources inherited via project writer role
  const memberships = repositories.projects
    ? await repositories.projects.listMembershipsByUser(userId)
    : [];
  const writerProjectIds = memberships.filter((m) => m.role === 'WRITER').map((m) => m.projectId);
  const writerProjectEnvironments = await Promise.all(
    writerProjectIds.map((projectId) => repositories.projects.listEnvironments(projectId))
  );
  const writerResourceIds = writerProjectEnvironments
    .flat()
    .map((e) => e.resourceId)
    .filter((id): id is string => !!id);

  // Combine all resource IDs and deduplicate before querying
  const allResourceIds = Array.from(
    new Set([...explicitResourceIds, ...ownedResourceIds, ...writerResourceIds])
  );

  if (allResourceIds.length > 0) {
    const resources = await repositories.resources.findManyByIds(allResourceIds, query);
    resources.forEach((r) => resourceMap.set(r.id, r));
  }

  return Array.from(resourceMap.values());
}

/**
 * Capability evaluator (Prerequisite 1/8)
 */
export async function hasCapability(
  repositories: Repositories,
  principal: Principal,
  capability: Capability,
  context: CapabilityContext
): Promise<EvaluationResult> {
  const allow = (reasonCode: ReasonCode, reason: string): EvaluationResult => ({
    allowed: true,
    decisionCode: 'ALLOW',
    reasonCode,
    reason,
  });

  const deny = (reasonCode: ReasonCode, reason: string): EvaluationResult => ({
    allowed: false,
    decisionCode: 'DENY',
    reasonCode,
    reason,
  });

  // 1. Scoped Capability / Least Privilege Check
  if (principal.scopes) {
    if (!principal.scopes.includes(capability)) {
      return deny('INSUFFICIENT_SCOPES', `Principal lacks required scope: ${capability}`);
    }
    // For SERVICE type, authorization is purely capability-scope based (no human user role)
    if (principal.type === 'SERVICE') {
      return allow('SERVICE', `Service principal authorized via scope: ${capability}`);
    }
  } else if (principal.type === 'SERVICE') {
    return deny('INSUFFICIENT_SCOPES', 'Service principal lacks scopes');
  }

  // Resolve roles
  let pOwnerId: string | null = null;
  let pMemberRole: 'WRITER' | 'READER' | null = null;
  let explicitGuardianRole: 'OWNER' | 'GUARDIAN' | null = null;

  let projectId = context.projectId;
  let resourceId = context.resourceId;

  if (context.environmentId && repositories.projects) {
    const env = await repositories.projects.findEnvironmentById(context.environmentId);
    if (env) {
      projectId = env.projectId;
      if (env.resourceId) {
        resourceId = env.resourceId;
      }
    }
  }

  if (resourceId && !projectId && repositories.projects) {
    const env = await repositories.projects.findEnvironmentByResourceId(resourceId);
    if (env) {
      projectId = env.projectId;
    }
  }

  const userId =
    principal.actorDiscordId || (principal.type === 'DISCORD_USER' ? principal.id : null);

  if (projectId && userId && repositories.projects) {
    const project = await repositories.projects.findById(projectId);
    if (project) {
      if (project.ownerId === userId) {
        pOwnerId = project.ownerId;
      } else {
        const role = await repositories.projects.getMemberRole(projectId, userId);
        if (role === 'WRITER' || role === 'READER') {
          pMemberRole = role;
        }
      }
    }
  }

  if (resourceId && userId && repositories.guardians) {
    const g = await repositories.guardians.findByResourceAndUser(resourceId, userId);
    if (g) {
      explicitGuardianRole = g.role;
    }
  }

  const isProjectOwner = pOwnerId !== null;
  const isProjectLinked = !!projectId;
  const isResourceOwner = isProjectOwner || (!isProjectLinked && explicitGuardianRole === 'OWNER');

  switch (capability) {
    // --- PROJECT CAPABILITIES ---
    case 'project.create':
      if (principal.type === 'DISCORD_USER' || principal.type === 'PAWTHY_TOKEN') {
        return allow('OWNER', 'Authorized to create project');
      }
      return deny('INVALID_AUTH', 'Only user sessions can create projects');

    case 'project.view':
    case 'project.members.view':
      if (isProjectOwner) return allow('OWNER', 'Project Owner can view project');
      if (pMemberRole === 'WRITER') return allow('WRITER', 'Project Writer can view project');
      if (pMemberRole === 'READER') return allow('READER', 'Project Reader can view project');
      return deny('NO_ROLE', 'No member role on project');

    case 'project.update':
    case 'project.delete':
    case 'project.transfer':
    case 'project.members.manage':
      if (isProjectOwner) return allow('OWNER', 'Project Owner can manage project');
      return deny('NO_ROLE', 'Only Project Owner can manage project');

    // --- ENVIRONMENT CAPABILITIES ---
    case 'environment.view':
      if (isProjectOwner) return allow('OWNER', 'Project Owner can view environment');
      if (pMemberRole === 'WRITER') return allow('WRITER', 'Project Writer can view environment');
      if (pMemberRole === 'READER') return allow('READER', 'Project Reader can view environment');
      return deny('NO_ROLE', 'No member role on environment');

    case 'environment.create':
    case 'environment.delete':
      if (isProjectOwner) return allow('OWNER', 'Project Owner can create/delete environments');
      return deny('NO_ROLE', 'Only Project Owner can create/delete environments');

    case 'environment.update':
      if (isProjectOwner) return allow('OWNER', 'Project Owner can update environment');
      if (pMemberRole === 'WRITER') return allow('WRITER', 'Project Writer can update environment');
      return deny('NO_ROLE', 'Only Owner or Writer can update environment');

    // --- RESOURCE CAPABILITIES ---
    case 'resource.create':
      if (principal.type === 'DISCORD_USER' || principal.type === 'PAWTHY_TOKEN') {
        return allow('OWNER', 'Authorized to register resource');
      }
      return deny('INVALID_AUTH', 'Only user sessions can register resources');

    case 'resource.view':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can view resource');
      if (pMemberRole === 'WRITER') return allow('WRITER', 'Project Writer can view resource');
      if (pMemberRole === 'READER') return allow('READER', 'Project Reader can view resource');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian can view resource');
      return deny('NO_ROLE', 'No role on resource');

    case 'resource.policy.manage':
    case 'resource.delete':
    case 'resource.api-key.list':
    case 'resource.api-key.mint':
    case 'resource.api-key.rotate':
    case 'resource.api-key.revoke':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can manage resource');
      return deny('NO_ROLE', 'Only Resource Owner can manage resource');

    // --- SECRET CAPABILITIES ---
    case 'secret.metadata.read':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can read secret metadata');
      if (pMemberRole === 'WRITER')
        return allow('WRITER', 'Project Writer can read secret metadata');
      if (pMemberRole === 'READER')
        return allow('READER', 'Project Reader can read secret metadata');
      return deny('NO_ROLE', 'No secret metadata access');

    case 'secret.value.read':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can read secrets');
      if (pMemberRole === 'WRITER') return allow('WRITER', 'Project Writer can read secrets');
      if (pMemberRole === 'READER') return allow('READER', 'Project Reader can read secrets');
      return deny('NO_ROLE', 'No direct secret read access');

    case 'secret.write':
    case 'secret.delete':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can write secrets');
      if (pMemberRole === 'WRITER') return allow('WRITER', 'Project Writer can write secrets');
      return deny('NO_ROLE', 'Only Owner or Writer can modify secrets');

    // --- TOTP CAPABILITIES ---
    case 'totp.metadata.read':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can read TOTP metadata');
      if (pMemberRole === 'WRITER') return allow('WRITER', 'Project Writer can read TOTP metadata');
      if (pMemberRole === 'READER') return allow('READER', 'Project Reader can read TOTP metadata');
      return deny('NO_ROLE', 'No TOTP metadata access');

    case 'totp.code.read':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can read TOTP code');
      return deny('NO_ROLE', 'No direct TOTP code read access');

    case 'totp.recovery.read':
      if (context.totpAccountId && repositories.totp && userId) {
        const totpAcc = await repositories.totp.findById(context.totpAccountId);
        if (totpAcc && totpAcc.ownerDiscordUserId === userId) {
          return allow('OWNER', 'Personal TOTP Owner can view recovery key');
        }
      }
      return deny(
        'RECOVERY_KEY_OWNER_REQUIRED',
        'Only the personal owner of the TOTP account can view the recovery key'
      );

    case 'totp.link.manage':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can manage TOTP link');
      return deny('NO_ROLE', 'Only Resource Owner can manage TOTP link');

    case 'totp.account.manage':
      if (context.totpAccountId && repositories.totp && userId) {
        const totpAcc = await repositories.totp.findById(context.totpAccountId);
        if (totpAcc && totpAcc.ownerDiscordUserId === userId) {
          return allow('OWNER', 'Personal TOTP Owner can manage account');
        }
      }
      return deny('NO_ROLE', 'Only the personal owner can manage this TOTP account');

    // --- GUARDIAN CAPABILITIES ---
    case 'guardian.view':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can view guardians');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian can view guardians');
      return deny('NO_ROLE', 'No role to view guardians');

    case 'guardian.context.read':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can view guardian context');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian can view guardian context');
      return deny('NO_ROLE', 'No role to view guardian context');

    case 'guardian.manage':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can manage guardians');
      return deny('NO_ROLE', 'Only Resource Owner can manage guardians');

    // --- REQUEST CAPABILITIES ---
    case 'request.create':
      if (
        principal.type === 'DISCORD_USER' ||
        principal.type === 'PAWTHY_TOKEN' ||
        principal.type === 'RESOURCE_API_KEY'
      ) {
        return allow('READER', 'Authorized to create requests');
      }
      return deny('INVALID_AUTH', 'Invalid authentication to create requests');

    case 'request.view-own':
    case 'request.cancel-own':
      if (context.requestId && repositories.approvalRequests && userId) {
        const req = await repositories.approvalRequests.findById(context.requestId);
        if (req && req.context && typeof req.context === 'object') {
          const requesterId = (req.context as Record<string, unknown>)['requesterId'];
          if (requesterId === userId) {
            return allow('READER', 'Can view/cancel own request');
          }
        }
      }
      return deny('NO_ROLE', "Cannot view/cancel someone else's request");

    case 'request.queue.view':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can view approval queue');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian can view approval queue');
      return deny('NO_ROLE', 'No role to view approval queue');

    case 'request.decide':
      if (context.requestId && repositories.approvalRequests && userId) {
        const req = await repositories.approvalRequests.findById(context.requestId);
        if (req && req.context && typeof req.context === 'object') {
          const requesterId = (req.context as Record<string, unknown>)['requesterId'];
          if (requesterId === userId) {
            return deny('SELF_APPROVAL_FORBIDDEN', 'Guardians cannot approve their own requests');
          }
        }
      }
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can decide requests');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian can decide requests');
      return deny('NO_ROLE', 'Only Owners and Guardians can decide requests');

    // --- GRANT CAPABILITIES ---
    case 'grant.consume':
      if (resourceId && userId && repositories.approvalRequests) {
        const activeRequest = await repositories.approvalRequests.findActiveByRequester(
          resourceId,
          userId
        );
        if (activeRequest && activeRequest.status === 'APPROVED') {
          if (activeRequest.expiresAt && activeRequest.expiresAt < new Date()) {
            return deny('GRANT_EXPIRED', 'Approved grant has expired');
          }
          return allow('GRANT', 'Valid approved grant exists');
        }
      }
      return deny('NO_ROLE', 'No active approved grant found');

    // --- AUDIT CAPABILITIES ---
    case 'audit.full.read':
      if (isProjectOwner) return allow('OWNER', 'Project Owner has full audit read access');
      return deny('NO_ROLE', 'Only Project Owner has full audit read access');

    case 'audit.operational.read':
      if (isProjectOwner) return allow('OWNER', 'Project Owner has operational audit read access');
      if (pMemberRole === 'WRITER')
        return allow('WRITER', 'Project Writer has operational audit read access');
      return deny('NO_ROLE', 'Only Owner or Writer has operational audit read access');

    case 'audit.queue.read':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner has audit queue read access');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian has audit queue read access');
      return deny('NO_ROLE', 'No role to read audit queue');

    case 'audit.own.read':
      return allow('READER', 'Any authenticated actor can read their own audit events');

    case 'audit.export':
      if (isProjectOwner) return allow('OWNER', 'Project Owner can export audits');
      return deny('NO_ROLE', 'Only Project Owner can export audits');

    default:
      return deny('NO_ROLE', 'Unknown capability');
  }
}
