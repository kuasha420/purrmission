import type { ApprovalRequestMetadataProjection, Environment, ResourceMetadata } from './models.js';
import { hasCapability } from './policy.js';
import type { Repositories } from './repositories.js';
import {
  createMetadataSafeCapabilityEvaluator,
  createRelationshipSafeMetadataSource,
  MetadataQueryService,
  type EnvironmentMetadataRecord,
  type MetadataKind,
  type MetadataRelationshipVerifier,
  type ProjectMetadataRecord,
  type RequestMetadataAction,
  type RequestMetadataRecord,
  type ResourceMetadataRecord,
  type SecretMetadataRecord,
  type SubjectBoundMetadataCriteria,
  type SubjectBoundMetadataSource,
  type TOTPMetadataRecord,
} from './metadata_queries.js';

type MetadataRecord =
  | ProjectMetadataRecord
  | EnvironmentMetadataRecord
  | ResourceMetadataRecord
  | SecretMetadataRecord
  | TOTPMetadataRecord
  | RequestMetadataRecord;

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function page<T>(
  records: Iterable<T>,
  criteria: SubjectBoundMetadataCriteria,
  getId: (record: T) => string,
  getSearchText: (record: T) => string
): T[] {
  return [...records]
    .map((record) => ({
      record,
      id: getId(record),
      sortKey: getSearchText(record).normalize('NFKC').toLowerCase(),
    }))
    .filter(({ sortKey }) => !criteria.filter || sortKey.includes(criteria.filter))
    .sort(
      (left, right) => compareText(left.sortKey, right.sortKey) || compareText(left.id, right.id)
    )
    .filter(({ sortKey, id }) => {
      if (!criteria.after) return true;
      return (
        compareText(sortKey, criteria.after.sortKey) > 0 ||
        (sortKey === criteria.after.sortKey && compareText(id, criteria.after.id) > 0)
      );
    })
    .slice(0, criteria.limit)
    .map(({ record }) => record);
}

function dedupe<T>(records: Iterable<T>, getId: (record: T) => string): T[] {
  return [...new Map([...records].map((record) => [getId(record), record])).values()];
}

class RepositoryMetadataSource implements SubjectBoundMetadataSource {
  constructor(private readonly repositories: Repositories) {}

  private async projectsForMember(subjectId: string): Promise<ProjectMetadataRecord[]> {
    const owned = await this.repositories.projects.listProjectsByOwner(subjectId);
    const memberships = await this.repositories.projects.listMembershipsByUser(subjectId);
    const memberProjects = await Promise.all(
      memberships.map(({ projectId }) => this.repositories.projects.findById(projectId))
    );
    return dedupe(
      [...owned, ...memberProjects.filter((project) => project !== null)].map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        ownerId: project.ownerId,
        policyVersion: project.policyVersion,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
      ({ id }) => id
    );
  }

  private async environmentsForProjects(projects: ProjectMetadataRecord[]): Promise<Environment[]> {
    return (
      await Promise.all(projects.map(({ id }) => this.repositories.projects.listEnvironments(id)))
    ).flat();
  }

  private async subjectResources(subjectId: string): Promise<ResourceMetadataRecord[]> {
    const projects = await this.projectsForMember(subjectId);
    const environments = await this.environmentsForProjects(projects);
    const environmentByResource = new Map(
      environments.flatMap((environment) =>
        environment.resourceId ? [[environment.resourceId, environment] as const] : []
      )
    );
    const guardianships = await this.repositories.guardians.findByUserId(subjectId);
    const ownRequests =
      await this.repositories.approvalRequests.findMetadataByRequesterId(subjectId);
    const resourceIds = new Set([
      ...environmentByResource.keys(),
      ...guardianships.map(({ resourceId }) => resourceId),
      ...ownRequests.map(({ resourceId }) => resourceId),
    ]);
    if (await this.repositories.resources.findMetadataById(subjectId)) resourceIds.add(subjectId);
    const resources = await this.repositories.resources.findMetadataManyByIds([...resourceIds]);
    return Promise.all(resources.map((resource) => this.resourceRecord(resource)));
  }

  private async queueResourceIds(subjectId: string): Promise<Set<string>> {
    const projects = await this.projectsForMember(subjectId);
    const ownedProjectIds = new Set(
      projects.filter(({ ownerId }) => ownerId === subjectId).map(({ id }) => id)
    );
    const ownedEnvironments = await this.environmentsForProjects(
      projects.filter(({ id }) => ownedProjectIds.has(id))
    );
    const guardianships = await this.repositories.guardians.findByUserId(subjectId);
    return new Set([
      ...ownedEnvironments.flatMap(({ resourceId }) => (resourceId ? [resourceId] : [])),
      ...guardianships.map(({ resourceId }) => resourceId),
    ]);
  }

  private async requestsForSubject(
    subjectId: string
  ): Promise<ApprovalRequestMetadataProjection[]> {
    const own = await this.repositories.approvalRequests.findMetadataByRequesterId(subjectId);
    const queueResourceIds = await this.queueResourceIds(subjectId);
    const queue = (
      await Promise.all(
        [...queueResourceIds].map((resourceId) =>
          this.repositories.approvalRequests.findMetadataByResourceId(resourceId)
        )
      )
    ).flat();
    return dedupe([...own, ...queue], ({ id }) => id);
  }

  private async resourceRecord(resource: ResourceMetadata): Promise<ResourceMetadataRecord> {
    const environment = await this.repositories.projects.findEnvironmentByResourceId(resource.id);
    return {
      id: resource.id,
      ...(environment ? { projectId: environment.projectId, environmentId: environment.id } : {}),
      name: resource.name,
      mode: resource.mode,
      version: resource.version,
      createdAt: resource.createdAt,
    };
  }

  async listProjectCandidates(subjectId: string, criteria: SubjectBoundMetadataCriteria) {
    return page(
      await this.projectsForMember(subjectId),
      criteria,
      ({ id }) => id,
      ({ name }) => name
    );
  }

  async listEnvironmentCandidates(subjectId: string, criteria: SubjectBoundMetadataCriteria) {
    const environments = await this.environmentsForProjects(
      await this.projectsForMember(subjectId)
    );
    const records: EnvironmentMetadataRecord[] = environments.map((environment) => ({
      id: environment.id,
      projectId: environment.projectId,
      ...(environment.resourceId ? { resourceId: environment.resourceId } : {}),
      name: environment.name,
      slug: environment.slug,
      createdAt: environment.createdAt,
      updatedAt: environment.updatedAt,
    }));
    return page(
      records,
      criteria,
      ({ id }) => id,
      ({ name, slug }) => `${name}\0${slug}`
    );
  }

  async listResourceCandidates(subjectId: string, criteria: SubjectBoundMetadataCriteria) {
    return page(
      await this.subjectResources(subjectId),
      criteria,
      ({ id }) => id,
      ({ name }) => name
    );
  }

  async listSecretCandidates(subjectId: string, criteria: SubjectBoundMetadataCriteria) {
    const projects = await this.projectsForMember(subjectId);
    const memberEnvironments = await this.environmentsForProjects(projects);
    const ownerGuardianships = (await this.repositories.guardians.findByUserId(subjectId)).filter(
      ({ role }) => role === 'OWNER'
    );
    const broadResourceIds = new Set([
      ...memberEnvironments.flatMap(({ resourceId }) => (resourceId ? [resourceId] : [])),
      ...ownerGuardianships.map(({ resourceId }) => resourceId),
    ]);
    if (await this.repositories.resources.findMetadataById(subjectId))
      broadResourceIds.add(subjectId);

    const broadFields = (
      await Promise.all(
        [...broadResourceIds].map((resourceId) =>
          this.repositories.resourceFields.findMetadataByResourceId(resourceId)
        )
      )
    ).flat();
    const requests = await this.requestsForSubject(subjectId);
    const requestedFields = await Promise.all(
      requests
        .filter((request) => request.action === 'secret.value.read' && request.targetKey !== null)
        .map((request) =>
          this.repositories.resourceFields.findMetadataByResourceAndName(
            request.resourceId,
            request.targetKey as string
          )
        )
    );
    const fields = dedupe(
      [...broadFields, ...requestedFields.filter((field) => field !== null)],
      ({ id }) => id
    );
    const records = await Promise.all(
      fields.map(async (field): Promise<SecretMetadataRecord> => {
        const environment = await this.repositories.projects.findEnvironmentByResourceId(
          field.resourceId
        );
        return {
          id: field.id,
          ...(environment
            ? { projectId: environment.projectId, environmentId: environment.id }
            : {}),
          resourceId: field.resourceId,
          key: field.name,
          version: field.version,
          createdAt: field.createdAt,
          updatedAt: field.updatedAt,
        };
      })
    );
    return page(
      records,
      criteria,
      ({ id }) => id,
      ({ key }) => key
    );
  }

  async listTOTPCandidates(subjectId: string, criteria: SubjectBoundMetadataCriteria) {
    const personal = await this.repositories.totp.findMetadataByOwnerDiscordUserId(subjectId);
    const resourceRecords = await this.subjectResources(subjectId);
    const resources = await Promise.all(
      resourceRecords.map(({ id }) => this.repositories.resources.findMetadataById(id))
    );
    const linked = await Promise.all(
      resources
        .filter((resource) => resource?.totpAccountId)
        .map(async (resource): Promise<TOTPMetadataRecord | null> => {
          if (!resource?.totpAccountId) return null;
          const account = await this.repositories.totp.findMetadataById(resource.totpAccountId);
          if (!account) return null;
          const environment = await this.repositories.projects.findEnvironmentByResourceId(
            resource.id
          );
          return {
            scope: 'LINKED',
            id: account.id,
            ...(environment
              ? { projectId: environment.projectId, environmentId: environment.id }
              : {}),
            resourceId: resource.id,
            resourceVersion: resource.version,
            linkVersion: resource.totpLinkVersion,
            accountName: account.accountName,
            issuer: account.issuer ?? null,
            accountVersion: account.version,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          };
        })
    );
    const records: TOTPMetadataRecord[] = [
      ...personal.map((account) => ({
        scope: 'PERSONAL' as const,
        id: account.id,
        ownerDiscordUserId: account.ownerDiscordUserId,
        accountName: account.accountName,
        issuer: account.issuer ?? null,
        accountVersion: account.version,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })),
      ...linked.filter((record) => record !== null),
    ];
    return page(
      dedupe(records, (record) =>
        record.scope === 'LINKED' ? `linked:${record.resourceId}` : `personal:${record.id}`
      ),
      criteria,
      (record) => (record.scope === 'LINKED' ? record.resourceId : record.id),
      (record) => (record.scope === 'LINKED' ? record.resourceId : record.id)
    );
  }

  private async requestRecord(
    request: ApprovalRequestMetadataProjection
  ): Promise<RequestMetadataRecord | null> {
    const resource = await this.repositories.resources.findMetadataById(request.resourceId);
    if (!resource) return null;
    const environment = await this.repositories.projects.findEnvironmentByResourceId(resource.id);
    const action = request.action as RequestMetadataAction;
    let target: RequestMetadataRecord['target'];
    if (action === 'secret.value.read') {
      if (!request.targetKey) return null;
      target = {
        kind: 'SECRET',
        resourceId: resource.id,
        targetKey: request.targetKey,
        targetVersion: request.targetVersion,
      };
    } else if (action === 'totp.code.read') {
      if (!request.targetKey) return null;
      target = {
        kind: 'TOTP_ACCOUNT',
        resourceId: resource.id,
        totpAccountId: request.targetKey,
        targetVersion: request.targetVersion,
      };
    } else if (action === 'resource.view') {
      target = {
        kind: 'RESOURCE',
        resourceId: resource.id,
        targetVersion: request.targetVersion,
      };
    } else {
      return null;
    }
    const grant = await this.repositories.approvalGrants.findMetadataByRequestId(request.id);
    return {
      id: request.id,
      ...(environment ? { projectId: environment.projectId, environmentId: environment.id } : {}),
      resourceId: resource.id,
      status: request.status,
      action,
      target,
      grant: grant
        ? {
            id: grant.id,
            requestId: grant.requestId,
            expiresAt: grant.expiresAt,
            consumedAt: grant.consumedAt ?? null,
            revokedAt: grant.revokedAt ?? null,
          }
        : null,
      policyVersion: request.policyVersion,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    };
  }

  async listRequestCandidates(subjectId: string, criteria: SubjectBoundMetadataCriteria) {
    const candidates = page(
      await this.requestsForSubject(subjectId),
      criteria,
      ({ id }) => id,
      ({ createdAt, id }) => `${createdAt.toISOString()}\0${id}`
    );
    return (await Promise.all(candidates.map((request) => this.requestRecord(request)))).filter(
      (record) => record !== null
    );
  }
}

class RepositoryRelationshipVerifier implements MetadataRelationshipVerifier {
  constructor(private readonly repositories: Repositories) {}

  private async matchesResourceAncestry(
    resourceId: string,
    projectId: string | undefined,
    environmentId: string | undefined
  ): Promise<boolean> {
    const environment = await this.repositories.projects.findEnvironmentByResourceId(resourceId);
    return environment
      ? environment.id === environmentId && environment.projectId === projectId
      : environmentId === undefined && projectId === undefined;
  }

  async verify(kind: MetadataKind, record: MetadataRecord): Promise<boolean> {
    if (kind === 'PROJECT') {
      const projected = record as ProjectMetadataRecord;
      return (await this.repositories.projects.findById(projected.id))?.id === projected.id;
    }
    if (kind === 'ENVIRONMENT') {
      const projected = record as EnvironmentMetadataRecord;
      const environment = await this.repositories.projects.getEnvironmentById(
        projected.projectId,
        projected.id
      );
      return environment?.resourceId === projected.resourceId;
    }
    if (kind === 'RESOURCE') {
      const projected = record as ResourceMetadataRecord;
      const resource = await this.repositories.resources.findMetadataById(projected.id);
      if (!resource) return false;
      const environment = await this.repositories.projects.findEnvironmentByResourceId(
        projected.id
      );
      return environment
        ? environment.id === projected.environmentId &&
            environment.projectId === projected.projectId
        : projected.environmentId === undefined && projected.projectId === undefined;
    }
    if (kind === 'SECRET') {
      const projected = record as SecretMetadataRecord;
      const field = await this.repositories.resourceFields.findMetadataByResourceAndName(
        projected.resourceId,
        projected.key
      );
      return (
        field?.id === projected.id &&
        field.version === projected.version &&
        (await this.matchesResourceAncestry(
          projected.resourceId,
          projected.projectId,
          projected.environmentId
        ))
      );
    }
    if (kind === 'TOTP_ACCOUNT') {
      const projected = record as TOTPMetadataRecord;
      const account = await this.repositories.totp.findMetadataById(projected.id);
      if (!account || account.version !== projected.accountVersion) return false;
      if (projected.scope === 'PERSONAL') {
        return account.ownerDiscordUserId === projected.ownerDiscordUserId;
      }
      const resource = await this.repositories.resources.findMetadataById(projected.resourceId);
      return (
        resource?.totpAccountId === projected.id &&
        resource.version === projected.resourceVersion &&
        resource.totpLinkVersion === projected.linkVersion &&
        (await this.matchesResourceAncestry(
          projected.resourceId,
          projected.projectId,
          projected.environmentId
        ))
      );
    }
    const projected = record as RequestMetadataRecord;
    const request = await this.repositories.approvalRequests.findMetadataById(projected.id);
    if (
      !request ||
      request.resourceId !== projected.resourceId ||
      request.action !== projected.action ||
      request.targetVersion !== projected.target.targetVersion ||
      request.policyVersion !== projected.policyVersion ||
      !(await this.matchesResourceAncestry(
        projected.resourceId,
        projected.projectId,
        projected.environmentId
      ))
    ) {
      return false;
    }
    if (projected.target.kind === 'SECRET') {
      return request.targetKey === projected.target.targetKey;
    }
    if (projected.target.kind === 'TOTP_ACCOUNT') {
      return request.targetKey === projected.target.totpAccountId;
    }
    return request.targetKey === null;
  }
}

/** Production-safe repository/query composition shared by future adapters. */
export function createRepositoryMetadataQueryService(
  repositories: Repositories
): MetadataQueryService {
  const source = createRelationshipSafeMetadataSource(
    new RepositoryMetadataSource(repositories),
    new RepositoryRelationshipVerifier(repositories)
  );
  const evaluate = createMetadataSafeCapabilityEvaluator(
    (principal, capability, context) => hasCapability(repositories, principal, capability, context),
    (principal, capability, context) => hasCapability(repositories, principal, capability, context)
  );
  return new MetadataQueryService(source, evaluate);
}
