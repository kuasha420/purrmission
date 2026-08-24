import type { Repositories } from './repositories.js';
import { canonicalizeSecretKeys, digestCanonicalSecretKeySet } from './metadata_queries.js';

const VERSION_DOMAIN = 'purrmission.target-version.v1';

export function digestVersions(kind: string, ...versions: string[]): string {
  return [VERSION_DOMAIN, kind, ...versions]
    .map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`)
    .join('|');
}

export interface ResolvedTargetVersions {
  targetType: string;
  targetId: string | null;
  targetKey: string | null;
  canonicalKeySet: string[] | null;
  canonicalKeyDigest: string | null;
  targetVersion: string;
  policyVersion: string;
  projectId: string | null;
  environmentId: string | null;
}

/** Resolve immutable request bindings exclusively from canonical persisted metadata. */
export async function resolveTargetVersions(
  repositories: Repositories,
  resourceId: string,
  action: string,
  targetKey: string | null = null,
  canonicalKeys?: readonly string[] | null
): Promise<ResolvedTargetVersions | null> {
  const resource = await repositories.resources.findMetadataById(resourceId);
  if (!resource) return null;

  const environment = await repositories.projects.findEnvironmentByResourceId(resourceId);
  const project = environment ? await repositories.projects.findById(environment.projectId) : null;
  const projectId = project?.id ?? null;
  const environmentId = environment?.id ?? null;

  const policyVersion = project
    ? digestVersions('project-resource-policy', project.policyVersion, resource.version)
    : resource.version;

  let targetType = 'RESOURCE';
  let targetId: string | null = resource.id;
  let canonicalTargetKey: string | null = targetKey;
  let canonicalKeySet: string[] | null = null;
  let canonicalKeyDigest: string | null = null;
  let targetVersion = resource.version;

  if (action === 'secret.value.read') {
    const rawKeys =
      canonicalKeys && canonicalKeys.length > 0 ? canonicalKeys : targetKey ? [targetKey] : null;
    if (rawKeys && rawKeys.length > 0) {
      let verifiedKeys: string[];
      try {
        verifiedKeys = canonicalizeSecretKeys(rawKeys);
      } catch {
        return null;
      }
      canonicalKeySet = verifiedKeys;
      canonicalKeyDigest = digestCanonicalSecretKeySet(verifiedKeys);

      if (verifiedKeys.length === 1) {
        targetType = 'SECRET';
        canonicalTargetKey = verifiedKeys[0];
        const field = await repositories.resourceFields.findMetadataByResourceAndName(
          resourceId,
          verifiedKeys[0]
        );
        if (!field) return null;
        targetId = field.id;
        targetVersion = field.version;
      } else {
        targetType = 'SECRET_BUNDLE';
        canonicalTargetKey = null;
        targetId = resource.id;
        const fieldVersions: string[] = [];
        for (const key of verifiedKeys) {
          const field = await repositories.resourceFields.findMetadataByResourceAndName(
            resourceId,
            key
          );
          if (!field) return null;
          fieldVersions.push(field.version);
        }
        targetVersion = digestVersions('secret-bundle', ...fieldVersions);
      }
    } else {
      // Legacy bulk-secret requests bind the whole secret-set version until #122 removes them.
      targetType = 'RESOURCE';
      targetId = resource.id;
      canonicalTargetKey = null;
      targetVersion = resource.version;
    }
  } else if (action === 'totp.code.read') {
    if (resource.totpAccountId) {
      const account = await repositories.totp.findMetadataById(resource.totpAccountId);
      if (!account) return null;
      targetType = 'TOTP_ACCOUNT';
      targetId = account.id;
      canonicalTargetKey = account.id;
      targetVersion = digestVersions('totp-link', account.version, resource.totpLinkVersion);
    } else {
      return null;
    }
  } else {
    targetType = 'RESOURCE';
    targetId = resource.id;
    targetVersion = resource.version;
  }

  return {
    targetType,
    targetId,
    targetKey: canonicalTargetKey,
    canonicalKeySet,
    canonicalKeyDigest,
    targetVersion,
    policyVersion,
    projectId,
    environmentId,
  };
}
