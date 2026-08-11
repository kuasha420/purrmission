/**
 * Policy definition for accessing sensitive resources (Fields, TOTP Codes).
 */

import type {
  Resource,
  Guardian,
  ApprovalRequest,
  Environment,
  Principal,
  Capability,
  CapabilityContext,
  EvaluationResult,
  ReasonCode,
  AuthoritySource,
  PolicyTarget,
} from './models.js';
import { authorizationSubjectId, validatePrincipal } from './principal.js';

export interface AccessRequest {
  resourceId: string;
  actorDiscordId: string;
}

export interface AccessPolicyResult {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

import type {
  ApprovalGrantRepository,
  ApprovalRequestRepository,
  GuardianRepository,
  ProjectRepository,
  Repositories,
  ResourceRepository,
  TOTPRepository,
} from './repositories.js';

export interface CapabilityRepositories {
  resources: Pick<ResourceRepository, 'findById'>;
  guardians: Pick<GuardianRepository, 'findByResourceAndUser'>;
  projects: Pick<
    ProjectRepository,
    'findById' | 'getEnvironmentById' | 'findEnvironmentByResourceId' | 'getMemberRole'
  >;
  approvalRequests: Pick<ApprovalRequestRepository, 'findById'>;
  approvalGrants: Pick<ApprovalGrantRepository, 'findById'>;
  totp: Pick<TOTPRepository, 'findById' | 'findMetadataById'>;
}

export interface EffectiveGuardianRepositories {
  guardians: Pick<
    GuardianRepository,
    'findByResourceId' | 'findByResourceAndUser' | 'findByUserId'
  >;
  projects: Pick<
    ProjectRepository,
    'findById' | 'findEnvironmentByResourceId' | 'listProjectsByOwner' | 'listEnvironments'
  >;
  resources: Pick<ResourceRepository, 'findManyByIds'>;
}

/**
 * Determine if an actor can access a resource.
 *
 * @deprecated Current adapters retain this compatibility function until #128/#129. It is
 * deliberately fail-closed for Guardians and approved requests: only a Resource/Project Owner may
 * receive direct protected access from this non-capability-aware API.
 */
export async function checkAccessPolicy(
  _resource: Resource,
  guardians: Guardian[],
  actorDiscordId: string,
  _repositories?: Repositories
): Promise<AccessPolicyResult> {
  const isOwner = guardians.some(
    (guardian) => guardian.discordUserId === actorDiscordId && guardian.role === 'OWNER'
  );

  if (isOwner) {
    return {
      allowed: true,
      requiresApproval: false,
      reason: 'Resource Owner has direct access',
    };
  }

  return {
    allowed: false,
    requiresApproval: true,
    reason: 'Exact capability and immutable grant evaluation required',
  };
}

/**
 * Helper to check if approval is required.
 */
export function requiresApproval(result: AccessPolicyResult): boolean {
  return result.requiresApproval;
}

/**
 * Retrieve explicit Guardians plus canonical Project/Resource ownership authority.
 *
 * Project Writers are intentionally not synthesized as Guardians.
 */
export async function getEffectiveGuardians(
  repositories: EffectiveGuardianRepositories,
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
      // OWNER rows on project-linked Resources are legacy mirrors or stale ownership. Project
      // ownership is canonical, and provenance is insufficient to reinterpret a stale OWNER row as
      // an explicit GUARDIAN assignment, so fail closed until an operator reconciles it.
      for (const [discordUserId, guardian] of guardianMap) {
        if (guardian.role === 'OWNER' && discordUserId !== project.ownerId) {
          guardianMap.delete(discordUserId);
        }
      }

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
    }
  }

  return Array.from(guardianMap.values());
}

/**
 * Check approval authority for an explicit Guardian or canonical Project/Resource Owner.
 *
 * @deprecated Prefer hasCapability(..., 'request.decide', exactContext).
 */
export async function isEffectiveGuardian(
  repositories: EffectiveGuardianRepositories,
  resourceId: string,
  userId: string
): Promise<boolean> {
  // Project ownership is canonical for linked Resources. A legacy OWNER row cannot override it.
  const environment = repositories.projects
    ? await repositories.projects.findEnvironmentByResourceId(resourceId)
    : null;
  if (environment && repositories.projects) {
    const project = await repositories.projects.findById(environment.projectId);
    if (project) {
      if (project.ownerId === userId) {
        return true;
      }
      const explicitGuardian = await repositories.guardians.findByResourceAndUser(
        resourceId,
        userId
      );
      return explicitGuardian?.role === 'GUARDIAN';
    }
  }

  const explicitGuardian = await repositories.guardians.findByResourceAndUser(resourceId, userId);
  return explicitGuardian !== null;
}

/**
 * Check if a user is an effective owner of a resource.
 */
export async function isEffectiveOwner(
  repositories: EffectiveGuardianRepositories,
  resourceId: string,
  userId: string
): Promise<boolean> {
  // Project ownership is canonical for an environment-linked Resource.
  const environment = repositories.projects
    ? await repositories.projects.findEnvironmentByResourceId(resourceId)
    : null;
  if (environment && repositories.projects) {
    const project = await repositories.projects.findById(environment.projectId);
    return project?.ownerId === userId;
  }

  // Standalone Resources retain their explicit OWNER assignment.
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

  return false;
}

/**
 * Get all resources that a user effectively guards.
 */
export async function getGuardedResourcesForUser(
  repositories: EffectiveGuardianRepositories,
  userId: string,
  query?: string
): Promise<Resource[]> {
  // Use a Map keyed by resourceId to deduplicate
  const resourceMap = new Map<string, Resource>();

  // 1. Get explicit guarded resources
  const explicitGuardians = await repositories.guardians.findByUserId(userId);
  const explicitResourceIds = (
    await Promise.all(
      (explicitGuardians ?? []).map(async (guardian) => {
        if (guardian.role !== 'OWNER') return guardian.resourceId;
        const environment = await repositories.projects.findEnvironmentByResourceId(
          guardian.resourceId
        );
        if (!environment) return guardian.resourceId;
        const project = await repositories.projects.findById(environment.projectId);
        return project?.ownerId === userId ? guardian.resourceId : null;
      })
    )
  ).filter((id): id is string => id !== null);

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

  // Combine all resource IDs and deduplicate before querying
  const allResourceIds = Array.from(new Set([...explicitResourceIds, ...ownedResourceIds]));

  if (allResourceIds.length > 0) {
    const resources = await repositories.resources.findManyByIds(allResourceIds, query);
    resources.forEach((r) => resourceMap.set(r.id, r));
  }

  return Array.from(resourceMap.values());
}

/**
 * Capability evaluator (Prerequisite 1/9)
 */
function resolvePolicyTarget(context: CapabilityContext): PolicyTarget {
  if (context.grantId) return { type: 'APPROVAL_GRANT', id: context.grantId };
  if (context.requestId) return { type: 'APPROVAL_REQUEST', id: context.requestId };
  if (context.totpAccountId) return { type: 'TOTP_ACCOUNT', id: context.totpAccountId };
  if (context.resourceId && context.fieldName) {
    return { type: 'SECRET', resourceId: context.resourceId, key: context.fieldName };
  }
  if (context.resourceId) return { type: 'RESOURCE', id: context.resourceId };
  if (context.environmentId) return { type: 'ENVIRONMENT', id: context.environmentId };
  if (context.projectId) return { type: 'PROJECT', id: context.projectId };
  if (context.subjectId) return { type: 'SUBJECT', id: context.subjectId };
  return { type: 'GLOBAL' };
}

function auditReadCapabilitiesForTarget(target: PolicyTarget): Capability[] {
  switch (target.type) {
    case 'PROJECT':
    case 'ENVIRONMENT':
      return ['audit.full.read', 'audit.operational.read'];
    case 'RESOURCE':
    case 'SECRET':
    case 'APPROVAL_REQUEST':
    case 'APPROVAL_GRANT':
      return ['audit.queue.read'];
    case 'SUBJECT':
      return ['audit.own.read'];
    default:
      return [];
  }
}

export async function hasCapability(
  repositories: CapabilityRepositories,
  principal: Principal,
  capability: Capability,
  context: CapabilityContext
): Promise<EvaluationResult> {
  const target = resolvePolicyTarget(context);
  let isProjectOwner = false;

  const defaultAuthoritySources = (reasonCode: ReasonCode): AuthoritySource[] => {
    switch (reasonCode) {
      case 'OWNER':
        return [isProjectOwner ? 'PROJECT_OWNER' : 'RESOURCE_OWNER'];
      case 'WRITER':
        return ['PROJECT_WRITER'];
      case 'READER':
        return ['PROJECT_READER'];
      case 'GUARDIAN':
        return ['EXPLICIT_GUARDIAN'];
      case 'GRANT':
        return ['APPROVAL_GRANT'];
      case 'SERVICE':
        return ['SCOPED_CREDENTIAL'];
      default:
        return [];
    }
  };

  const allow = (
    reasonCode: ReasonCode,
    safeExplanation: string,
    authoritySources = defaultAuthoritySources(reasonCode),
    grantId?: string
  ): EvaluationResult => ({
    allowed: true,
    decisionCode: 'ALLOW',
    reasonCode,
    capability,
    target,
    authoritySources,
    ...(context.requestId ? { approvalRequestId: context.requestId } : {}),
    ...(grantId ? { grantId } : {}),
    safeExplanation,
  });

  const deny = (
    reasonCode: ReasonCode,
    safeExplanation: string,
    decisionCode: EvaluationResult['decisionCode'] = 'DENY'
  ): EvaluationResult => ({
    allowed: false,
    decisionCode,
    reasonCode,
    capability,
    target,
    authoritySources: [],
    ...(context.requestId ? { approvalRequestId: context.requestId } : {}),
    ...(context.grantId ? { grantId: context.grantId } : {}),
    safeExplanation,
  });

  const principalValidation = validatePrincipal(principal, context.requiredAudience);
  if (!principalValidation.valid) {
    return deny(
      principalValidation.reasonCode ?? 'INVALID_AUTH',
      principalValidation.safeExplanation ?? 'Authentication identity is invalid.'
    );
  }

  // 1. Scoped Capability / Least Privilege Check
  if (principal.scopes) {
    if (!principal.scopes.includes(capability)) {
      return deny('INSUFFICIENT_SCOPES', 'Credential lacks the required capability scope.');
    }
  } else if (principal.type === 'SERVICE' || principal.type === 'RESOURCE_API_KEY') {
    return deny('INSUFFICIENT_SCOPES', 'Credential has no capability scopes.');
  }

  // Service credentials currently carry capability names but no immutable target binding. A scope
  // alone must not authorize an arbitrary caller-supplied object. #121 owns target-bound service
  // credentials; until then only the service's exact own-subject audit target can proceed.
  if (
    principal.type === 'SERVICE' &&
    (target.type !== 'SUBJECT' || target.id !== authorizationSubjectId(principal))
  ) {
    return deny(
      'TARGET_SCOPE_MISMATCH',
      'Service credential is not bound to this exact authorization target.'
    );
  }

  // Resolve roles
  let pOwnerId: string | null = null;
  let pMemberRole: 'WRITER' | 'READER' | null = null;
  let explicitGuardianRole: 'OWNER' | 'GUARDIAN' | null = null;

  let projectId = context.projectId;
  let resourceId = context.resourceId;
  let resolvedRequest: ApprovalRequest | null = null;
  let resolvedEnvironment: Environment | null = null;

  if (context.environmentId && !projectId) {
    return deny(
      'MISSING_CONTEXT',
      'Environment authorization requires its containing Project context.'
    );
  }

  if (context.environmentId && projectId && repositories.projects) {
    const env = await repositories.projects.getEnvironmentById(projectId, context.environmentId);
    if (!env) {
      return deny('TARGET_SCOPE_MISMATCH', 'Environment does not belong to the requested Project.');
    }
    resolvedEnvironment = env;
    if (resourceId && env.resourceId !== resourceId) {
      return deny('TARGET_SCOPE_MISMATCH', 'Environment does not contain the requested Resource.');
    }
    projectId = env.projectId;
    if (env.resourceId) {
      resourceId = env.resourceId;
    }
  }

  if (context.requestId) {
    resolvedRequest = await repositories.approvalRequests.findById(context.requestId);
    if (!resolvedRequest) {
      return deny('TARGET_SCOPE_MISMATCH', 'Approval request target does not exist.');
    }
    if (resourceId && resolvedRequest.resourceId !== resourceId) {
      return deny(
        'TARGET_SCOPE_MISMATCH',
        'Approval request does not belong to the requested Resource.'
      );
    }
    resourceId = resolvedRequest.resourceId;
  }

  if (resolvedEnvironment && resourceId && resolvedEnvironment.resourceId !== resourceId) {
    return deny(
      'TARGET_SCOPE_MISMATCH',
      'Resolved Resource does not belong to the requested Environment.'
    );
  }

  if (resourceId && projectId && repositories.projects) {
    const resourceEnvironment = await repositories.projects.findEnvironmentByResourceId(resourceId);
    if (!resourceEnvironment || resourceEnvironment.projectId !== projectId) {
      return deny('TARGET_SCOPE_MISMATCH', 'Resource does not belong to the requested Project.');
    }
  }

  if (resourceId && !projectId && repositories.projects) {
    const env = await repositories.projects.findEnvironmentByResourceId(resourceId);
    if (env) {
      projectId = env.projectId;
    }
  }

  const userId =
    principal.type === 'DISCORD_USER' || principal.type === 'PAWTHY_TOKEN'
      ? authorizationSubjectId(principal)
      : null;

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

  isProjectOwner = pOwnerId !== null;
  const isProjectLinked = !!projectId;
  const isResourceOwner = isProjectOwner || (!isProjectLinked && explicitGuardianRole === 'OWNER');

  switch (capability) {
    // --- PROJECT CAPABILITIES ---
    case 'project.create':
      if (principal.type === 'DISCORD_USER' || principal.type === 'PAWTHY_TOKEN') {
        return allow('OWNER', 'Authenticated user may create a project.', [
          'AUTHENTICATED_SUBJECT',
        ]);
      }
      return deny('INVALID_AUTH', 'Only an authenticated user may create a project.');

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
        return allow('OWNER', 'Authenticated user may register a resource.', [
          'AUTHENTICATED_SUBJECT',
        ]);
      }
      return deny('INVALID_AUTH', 'Only an authenticated user may register a resource.');

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
        const totpAcc = await repositories.totp.findMetadataById(context.totpAccountId);
        if (totpAcc && totpAcc.ownerDiscordUserId === userId) {
          return allow('OWNER', 'Personal TOTP Owner can view recovery key', ['TOTP_OWNER']);
        }
      }
      return deny(
        'RECOVERY_KEY_OWNER_REQUIRED',
        'Only the personal owner of the TOTP account can view the recovery key'
      );

    case 'totp.link.manage':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can manage TOTP link');
      if (
        context.totpLinkOperation === 'UNLINK' &&
        context.resourceId &&
        context.totpAccountId &&
        repositories.resources &&
        repositories.totp &&
        userId
      ) {
        const linkedResource = await repositories.resources.findById(context.resourceId);
        if (linkedResource?.totpAccountId !== context.totpAccountId) {
          return deny(
            'TARGET_SCOPE_MISMATCH',
            'TOTP account is not linked to the requested Resource.'
          );
        }
        const totpAcc = await repositories.totp.findMetadataById(context.totpAccountId);
        if (totpAcc?.ownerDiscordUserId === userId) {
          return allow('OWNER', 'TOTP custody owner can unlink their account', ['TOTP_OWNER']);
        }
      }
      return deny('NO_ROLE', 'Only Resource Owner can manage TOTP link');

    case 'totp.account.manage':
      if (context.totpAccountId && repositories.totp && userId) {
        const totpAcc = await repositories.totp.findMetadataById(context.totpAccountId);
        if (totpAcc && totpAcc.ownerDiscordUserId === userId) {
          return allow('OWNER', 'Personal TOTP Owner can manage account', ['TOTP_OWNER']);
        }
      }
      return deny('NO_ROLE', 'Only the personal owner can manage this TOTP account');

    // --- GUARDIAN CAPABILITIES ---
    case 'guardian.view':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can view guardians');
      return deny('NO_ROLE', 'Only the Resource Owner may list full Guardian assignments.');

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
      if (principal.type === 'RESOURCE_API_KEY') {
        if (!resourceId || resourceId !== authorizationSubjectId(principal)) {
          return deny(
            'AUTH_SUBJECT_MISMATCH',
            'Resource credential does not match the requested Resource.'
          );
        }
        return allow('READER', 'Scoped Resource credential may create a request.', [
          'SCOPED_CREDENTIAL',
        ]);
      }
      if (principal.type === 'DISCORD_USER' || principal.type === 'PAWTHY_TOKEN') {
        return allow('READER', 'Authenticated user may create an eligible request.', [
          'AUTHENTICATED_SUBJECT',
        ]);
      }
      return deny('INVALID_AUTH', 'Authentication type cannot create requests.');

    case 'request.view-own':
    case 'request.cancel-own':
      if (resolvedRequest && userId) {
        if (resolvedRequest.requesterId === userId) {
          return allow('READER', 'Requester may view or cancel their own request.', [
            'AUTHENTICATED_SUBJECT',
          ]);
        }
      }
      return deny('NO_ROLE', 'Requester does not own this request.');

    case 'request.queue.view':
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can view approval queue');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian can view approval queue');
      return deny('NO_ROLE', 'No role to view approval queue');

    case 'request.decide':
      if (!resolvedRequest) {
        return deny('MISSING_CONTEXT', 'Request decisions require an exact approval request.');
      }
      if (userId) {
        if (resolvedRequest.requesterId === userId) {
          return deny('SELF_APPROVAL_FORBIDDEN', 'A requester cannot decide their own request.');
        }
      }
      if (isResourceOwner) return allow('OWNER', 'Resource Owner can decide requests');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian can decide requests');
      return deny('NO_ROLE', 'Only Owners and Guardians can decide requests');

    // --- GRANT CAPABILITIES ---
    case 'grant.consume': {
      if (!context.grantId || !resourceId) {
        return deny('MISSING_CONTEXT', 'Exact grant and Resource context are required.');
      }
      const grant = await repositories.approvalGrants.findById(context.grantId);
      if (!grant || grant.revokedAt || grant.consumedAt) {
        return deny('GRANT_INVALID', 'Grant is missing, revoked, or already consumed.');
      }
      const now = context.currentTimestamp ?? new Date();
      if (grant.expiresAt <= now) {
        return deny('GRANT_EXPIRED', 'Grant has expired.');
      }
      if (
        grant.requesterId !== authorizationSubjectId(principal) ||
        grant.authKind !== principal.authKind ||
        grant.resourceId !== resourceId ||
        (context.action !== undefined && grant.action !== context.action) ||
        (context.fieldName !== undefined && grant.targetKey !== context.fieldName) ||
        (context.targetVersion !== undefined && grant.targetVersion !== context.targetVersion) ||
        (context.policyVersion !== undefined && grant.policyVersion !== context.policyVersion)
      ) {
        return deny(
          'GRANT_SCOPE_MISMATCH',
          'Grant does not match this subject or exact operation.'
        );
      }
      return allow(
        'GRANT',
        'Exact immutable grant permits this operation.',
        ['APPROVAL_GRANT'],
        grant.id
      );
    }

    // --- AUDIT CAPABILITIES ---
    case 'audit.full.read':
      if (principal.type === 'SERVICE') {
        if (!projectId) {
          return deny('MISSING_CONTEXT', 'Full audit read requires an exact Project target.');
        }
        return allow('SERVICE', 'Scoped service credential permits full Project audit reads.');
      }
      if (isProjectOwner) return allow('OWNER', 'Project Owner has full audit read access');
      return deny('NO_ROLE', 'Only Project Owner has full audit read access');

    case 'audit.operational.read':
      if (principal.type === 'SERVICE') {
        if (!projectId) {
          return deny(
            'MISSING_CONTEXT',
            'Operational audit read requires an exact Project target.'
          );
        }
        return allow(
          'SERVICE',
          'Scoped service credential permits operational Project audit reads.'
        );
      }
      if (isProjectOwner) return allow('OWNER', 'Project Owner has operational audit read access');
      if (pMemberRole === 'WRITER')
        return allow('WRITER', 'Project Writer has operational audit read access');
      return deny('NO_ROLE', 'Only Owner or Writer has operational audit read access');

    case 'audit.queue.read':
      if (principal.type === 'SERVICE') {
        if (!resourceId && !context.requestId) {
          return deny(
            'MISSING_CONTEXT',
            'Queue audit read requires an exact Resource or approval-request target.'
          );
        }
        return allow('SERVICE', 'Scoped service credential permits approval-queue audit reads.');
      }
      if (isResourceOwner) return allow('OWNER', 'Resource Owner has audit queue read access');
      if (explicitGuardianRole === 'GUARDIAN')
        return allow('GUARDIAN', 'Guardian has audit queue read access');
      return deny('NO_ROLE', 'No role to read audit queue');

    case 'audit.own.read':
      if (!context.subjectId) {
        return deny('MISSING_CONTEXT', 'Own-audit read requires an exact Subject target.');
      }
      if (context.subjectId !== authorizationSubjectId(principal)) {
        return deny(
          'AUTH_SUBJECT_MISMATCH',
          'Audit subject does not match the authenticated user.'
        );
      }
      if (principal.type === 'SERVICE') {
        return allow('SERVICE', 'Scoped service credential may read its own audit events.');
      }
      return allow('READER', 'Authenticated user may read their own audit events.', [
        'AUTHENTICATED_SUBJECT',
      ]);

    case 'audit.export': {
      if (principal.type !== 'SERVICE' && !isProjectOwner) {
        return deny('NO_ROLE', 'Only Project Owner can export audits');
      }

      const readCapabilities = auditReadCapabilitiesForTarget(target);
      if (readCapabilities.length === 0) {
        return deny('MISSING_CONTEXT', 'Audit export requires an exact auditable target.');
      }

      for (const readCapability of readCapabilities) {
        const readResult = await hasCapability(repositories, principal, readCapability, context);
        if (readResult.allowed) {
          return allow(
            principal.type === 'SERVICE' ? 'SERVICE' : 'OWNER',
            'Audit export is permitted by export and read authority on the same target.',
            readResult.authoritySources
          );
        }
      }

      return deny(
        principal.scopes ? 'INSUFFICIENT_SCOPES' : 'NO_ROLE',
        'Audit export requires audit read authority on the same target.'
      );
    }

    case 'token.manage-own':
      if (principal.type !== 'DISCORD_USER' && principal.type !== 'PAWTHY_TOKEN') {
        return deny('INVALID_AUTH', 'Only an authenticated user may manage their own tokens.');
      }
      if (context.subjectId && context.subjectId !== authorizationSubjectId(principal)) {
        return deny('AUTH_SUBJECT_MISMATCH', 'Token owner does not match the authenticated user.');
      }
      return allow('READER', 'Authenticated user may manage their own token records.', [
        'AUTHENTICATED_SUBJECT',
      ]);

    default:
      return deny('NO_ROLE', 'Unknown capability');
  }
}
