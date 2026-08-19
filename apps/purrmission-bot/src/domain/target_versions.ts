import type { Repositories } from './repositories.js';

const VERSION_DOMAIN = 'purrmission.target-version.v1';

function digestVersions(kind: string, ...versions: string[]): string {
  return [VERSION_DOMAIN, kind, ...versions]
    .map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`)
    .join('|');
}

export interface ResolvedTargetVersions {
  targetKey: string | null;
  targetVersion: string;
  policyVersion: string;
}

/** Resolve immutable request bindings exclusively from canonical persisted metadata. */
export async function resolveTargetVersions(
  repositories: Repositories,
  resourceId: string,
  action: string,
  targetKey: string | null
): Promise<ResolvedTargetVersions | null> {
  const resource = await repositories.resources.findMetadataById(resourceId);
  if (!resource) return null;

  let targetVersion: string;
  let canonicalTargetKey = targetKey;
  if (action === 'secret.value.read') {
    if (targetKey) {
      const field = await repositories.resourceFields.findMetadataByResourceAndName(
        resourceId,
        targetKey
      );
      if (!field) return null;
      targetVersion = field.version;
    } else {
      // Legacy bulk-secret requests bind the whole secret-set version until #122 removes them.
      targetVersion = resource.version;
    }
  } else if (action === 'totp.code.read') {
    if (resource.totpAccountId) {
      const account = await repositories.totp.findMetadataById(resource.totpAccountId);
      if (!account) return null;
      canonicalTargetKey = account.id;
      targetVersion = digestVersions('totp-link', account.version, resource.totpLinkVersion);
    } else {
      return null;
    }
  } else {
    targetVersion = resource.version;
  }

  const environment = await repositories.projects.findEnvironmentByResourceId(resourceId);
  const project = environment ? await repositories.projects.findById(environment.projectId) : null;
  const policyVersion = project
    ? digestVersions('project-resource-policy', project.policyVersion, resource.version)
    : resource.version;

  return { targetKey: canonicalTargetKey, targetVersion, policyVersion };
}
