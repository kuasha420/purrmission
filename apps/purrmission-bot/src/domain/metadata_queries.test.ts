import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { METADATA_CONTRACT_FIXTURES } from './metadata_contract_fixtures.js';
import {
  canonicalizeSecretKeys,
  createMetadataSafeCapabilityEvaluator,
  createRelationshipSafeMetadataSource,
  digestCanonicalSecretKeySet,
  ExactSecretRevealService,
  METADATA_CAPABILITY_EXCLUSIONS,
  METADATA_CAPABILITY_SUMMARY_CONTRACT,
  MetadataAuthorizationError,
  MetadataContractError,
  MetadataQueryService,
  SUBJECT_BOUND_METADATA_CACHE_POLICY,
  type EnvironmentMetadataRecord,
  type ExactCapabilityEvaluator,
  type ExactSecretSelection,
  type MetadataPage,
  type MetadataCapabilityContext,
  type MetadataSafeCapabilityEvaluator,
  type ProjectMetadataRecord,
  type RequestMetadataRecord,
  type ResourceMetadataRecord,
  type SecretMetadataRecord,
  type SubjectBoundMetadataCriteria,
  type SubjectBoundMetadataSource,
  type TOTPMetadataRecord,
} from './metadata_queries.js';
import type {
  AuthoritySource,
  Capability,
  CapabilityContext,
  EvaluationResult,
  PolicyTarget,
  Principal,
  ReasonCode,
} from './models.js';

const now = new Date('2026-08-01T00:00:00.000Z');
const later = new Date('2026-08-01T00:10:00.000Z');

const principal: Principal = {
  type: 'DISCORD_USER',
  id: 'discord-session-1',
  subjectId: 'user-1',
  actorDiscordId: 'user-1',
  authKind: 'DISCORD',
};

function targetFor(context: CapabilityContext): PolicyTarget {
  if (context.requestId) return { type: 'APPROVAL_REQUEST', id: context.requestId };
  if (context.totpAccountId) return { type: 'TOTP_ACCOUNT', id: context.totpAccountId };
  if (context.resourceId && context.fieldName) {
    return { type: 'SECRET', resourceId: context.resourceId, key: context.fieldName };
  }
  if (context.resourceId) return { type: 'RESOURCE', id: context.resourceId };
  if (context.environmentId) return { type: 'ENVIRONMENT', id: context.environmentId };
  if (context.projectId) return { type: 'PROJECT', id: context.projectId };
  return { type: 'GLOBAL' };
}

function rawEvaluator(
  decide: (
    capability: Capability,
    context: MetadataCapabilityContext
  ) => {
    allowed: boolean;
    decisionCode?: EvaluationResult['decisionCode'];
    reasonCode?: ReasonCode;
    authority?: AuthoritySource[];
    safeExplanation?: string;
    approvalRequestId?: string;
    grantId?: string;
  }
): ExactCapabilityEvaluator {
  return async (_principal, capability, context) => {
    const decision = decide(capability, context);
    return {
      allowed: decision.allowed,
      decisionCode: decision.decisionCode ?? (decision.allowed ? 'ALLOW' : 'DENY'),
      reasonCode: decision.reasonCode ?? (decision.allowed ? 'READER' : 'NO_ROLE'),
      capability,
      target: targetFor(context),
      authoritySources: decision.authority ?? (decision.allowed ? ['AUTHENTICATED_SUBJECT'] : []),
      safeExplanation:
        decision.safeExplanation ??
        (decision.allowed ? 'Exact capability allowed.' : 'Exact capability denied.'),
      ...(decision.approvalRequestId ? { approvalRequestId: decision.approvalRequestId } : {}),
      ...(decision.grantId ? { grantId: decision.grantId } : {}),
    };
  };
}

function evaluator(decide: Parameters<typeof rawEvaluator>[0]): MetadataSafeCapabilityEvaluator {
  const generic = rawEvaluator(decide);
  const totpMetadata = rawEvaluator(decide);
  return createMetadataSafeCapabilityEvaluator(generic, totpMetadata);
}

class MemoryMetadataSource implements SubjectBoundMetadataSource {
  projects: ProjectMetadataRecord[] = [];
  environments: EnvironmentMetadataRecord[] = [];
  resources: ResourceMetadataRecord[] = [];
  secrets: SecretMetadataRecord[] = [];
  totp: TOTPMetadataRecord[] = [];
  requests: RequestMetadataRecord[] = [];
  readonly observedSubjects: string[] = [];
  readonly observedCriteria: SubjectBoundMetadataCriteria[] = [];

  private observe(subjectId: string, criteria: SubjectBoundMetadataCriteria): void {
    this.observedSubjects.push(subjectId);
    this.observedCriteria.push(criteria);
  }

  private page<T>(
    records: T[],
    criteria: SubjectBoundMetadataCriteria,
    getId: (record: T) => string,
    getSearchText: (record: T) => string
  ): T[] {
    const normalized = records
      .map((record) => ({
        record,
        id: getId(record),
        sortKey: getSearchText(record).normalize('NFKC').toLowerCase(),
      }))
      .filter(({ sortKey }) => !criteria.filter || sortKey.includes(criteria.filter))
      .sort((left, right) =>
        left.sortKey === right.sortKey
          ? Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
          : Buffer.compare(Buffer.from(left.sortKey), Buffer.from(right.sortKey))
      )
      .filter(({ sortKey, id }) => {
        if (!criteria.after) return true;
        return (
          sortKey > criteria.after.sortKey ||
          (sortKey === criteria.after.sortKey && id > criteria.after.id)
        );
      });
    return normalized.slice(0, criteria.limit).map(({ record }) => record);
  }

  async listProjectCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<ProjectMetadataRecord[]> {
    this.observe(subjectId, criteria);
    return this.page(
      this.projects,
      criteria,
      (record) => record.id,
      (record) => record.name
    );
  }

  async listEnvironmentCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<EnvironmentMetadataRecord[]> {
    this.observe(subjectId, criteria);
    return this.page(
      this.environments,
      criteria,
      (record) => record.id,
      (record) => `${record.name}\u0000${record.slug}`
    );
  }

  async listResourceCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<ResourceMetadataRecord[]> {
    this.observe(subjectId, criteria);
    return this.page(
      this.resources,
      criteria,
      (record) => record.id,
      (record) => record.name
    );
  }

  async listSecretCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<SecretMetadataRecord[]> {
    this.observe(subjectId, criteria);
    return this.page(
      this.secrets,
      criteria,
      (record) => record.id,
      (record) => record.key
    );
  }

  async listTOTPCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<TOTPMetadataRecord[]> {
    this.observe(subjectId, criteria);
    return this.page(
      this.totp,
      criteria,
      (record) => (record.scope === 'LINKED' ? record.resourceId : record.id),
      (record) => (record.scope === 'LINKED' ? record.resourceId : record.id)
    );
  }

  async listRequestCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<RequestMetadataRecord[]> {
    this.observe(subjectId, criteria);
    return this.page(
      this.requests,
      criteria,
      (record) => record.id,
      (record) => `${record.createdAt.toISOString()}\u0000${record.id}`
    );
  }
}

function metadataService(
  source: SubjectBoundMetadataSource,
  evaluate: MetadataSafeCapabilityEvaluator,
  verify: Parameters<typeof createRelationshipSafeMetadataSource>[1]['verify'] = async () => true
): MetadataQueryService {
  return new MetadataQueryService(
    createRelationshipSafeMetadataSource(source, { verify }),
    evaluate
  );
}

function compileNegativeRawEvaluatorFixture(
  source: ReturnType<typeof createRelationshipSafeMetadataSource>,
  raw: ExactCapabilityEvaluator
): void {
  // @ts-expect-error MetadataQueryService must reject an unbranded/raw evaluator at compile time.
  new MetadataQueryService(source, raw);
}
void compileNegativeRawEvaluatorFixture;

function project(id: string, name: string): ProjectMetadataRecord {
  return {
    id,
    name,
    description: null,
    ownerId: `owner-of-${id}`,
    policyVersion: `policy-${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

function assertNoProtectedProperties(value: unknown): void {
  const forbidden = new Set([
    'value',
    'encryptedvalue',
    'ciphertext',
    'secret',
    'seed',
    'backupkey',
    'recoverykey',
    'credential',
    'credentialdigest',
    'token',
    'apikey',
    'callbacksecret',
  ]);
  if (!value || typeof value !== 'object' || value instanceof Date) return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(forbidden.has(key.toLowerCase()), false, `protected property ${key}`);
    assertNoProtectedProperties(nested);
  }
}

function assertCapabilityContract(
  page: MetadataPage<{ capabilities: { decisions: Array<{ capability: Capability }> } }>,
  kind: keyof typeof METADATA_CAPABILITY_SUMMARY_CONTRACT
): void {
  for (const item of page.items) {
    assert.deepEqual(
      item.capabilities.decisions.map((decision) => decision.capability),
      METADATA_CAPABILITY_SUMMARY_CONTRACT[kind]
    );
  }
}

describe('adapter-neutral metadata query contracts', () => {
  it('documents every #117 capability that has no metadata DTO target', () => {
    assert.deepEqual(Object.keys(METADATA_CAPABILITY_EXCLUSIONS).sort(), [
      'audit.own.read',
      'grant.consume',
      'project.create',
      'resource.create',
      'token.manage-own',
    ]);
    for (const reason of Object.values(METADATA_CAPABILITY_EXCLUSIONS)) {
      assert.ok(reason.length > 20);
    }
  });

  it('discovers owned, Writer, and Reader projects in deterministic cursor pages', async () => {
    const source = new MemoryMetadataSource();
    source.projects = [
      project('project-3', 'Zulu'),
      project('project-denied', 'Aardvark'),
      project('project-2', 'alpha'),
      project('project-1', 'Alpha'),
    ];
    const observedPrimaryTargets: string[] = [];
    const roleByProject: Record<string, ReasonCode> = {
      'project-1': 'OWNER',
      'project-2': 'WRITER',
      'project-3': 'READER',
    };
    const service = metadataService(
      source,
      evaluator((capability, context) => {
        if (capability === 'project.view' && context.projectId) {
          observedPrimaryTargets.push(context.projectId);
        }
        const role = context.projectId ? roleByProject[context.projectId] : undefined;
        return {
          allowed: capability === 'project.view' && role !== undefined,
          reasonCode: role,
          authority:
            role === 'OWNER'
              ? ['PROJECT_OWNER']
              : role === 'WRITER'
                ? ['PROJECT_WRITER']
                : role === 'READER'
                  ? ['PROJECT_READER']
                  : [],
        };
      })
    );

    const first = await service.listProjects(principal, { limit: 2 });
    assert.deepEqual(
      first.items.map(({ id, name }) => ({ id, name })),
      METADATA_CONTRACT_FIXTURES.deterministicProjectOrder.slice(0, 2)
    );
    assert.ok(first.nextCursor);
    assert.equal(first.nextCursor, METADATA_CONTRACT_FIXTURES.firstProjectCursor);
    assert.deepEqual(first.cachePolicy, SUBJECT_BOUND_METADATA_CACHE_POLICY);
    assert.equal('ownerId' in first.items[0], false);
    assert.deepEqual(first.items[0].capabilities.target, {
      type: 'PROJECT',
      id: 'project-1',
    });
    assertCapabilityContract(first, 'PROJECT');

    const second = await service.listProjects(principal, {
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map(({ id, name }) => ({ id, name })),
      METADATA_CONTRACT_FIXTURES.deterministicProjectOrder.slice(2)
    );
    assert.equal(second.nextCursor, null);

    const filtered = await service.listProjects(principal, { filter: 'ZUL' });
    assert.deepEqual(
      filtered.items.map((item) => item.id),
      ['project-3']
    );
    assert.ok(observedPrimaryTargets.includes('project-denied'));
    assert.deepEqual(source.observedSubjects, ['user-1', 'user-1', 'user-1', 'user-1']);
  });

  it('iteratively overfetches past denied candidates without shortening authorized pages', async () => {
    const source = new MemoryMetadataSource();
    source.projects = [
      project('project-a', 'Alpha'),
      project('project-b', 'Bravo'),
      project('project-c', 'Charlie'),
      project('project-d', 'Delta'),
      project('project-e', 'Echo'),
    ];
    const service = metadataService(
      source,
      evaluator((capability, context) => ({
        allowed:
          capability === 'project.view' &&
          context.projectId !== 'project-a' &&
          context.projectId !== 'project-b',
      }))
    );

    const first = await service.listProjects(principal, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.id),
      ['project-c', 'project-d']
    );
    assert.ok(first.nextCursor);
    assert.equal(source.observedCriteria.length, 2);
    assert.ok(source.observedCriteria.every((criteria) => criteria.limit === 3));
    assert.deepEqual(source.observedCriteria[1].after, {
      sortKey: 'charlie',
      id: 'project-c',
    });

    const second = await service.listProjects(principal, {
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((item) => item.id),
      ['project-e']
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects raw evaluators at runtime even when a caller defeats the type checker', () => {
    const source = createRelationshipSafeMetadataSource(new MemoryMetadataSource(), {
      async verify() {
        return true;
      },
    });
    assert.throws(
      () =>
        new MetadataQueryService(
          source,
          rawEvaluator(() => ({ allowed: true })) as MetadataSafeCapabilityEvaluator
        ),
      MetadataContractError
    );
  });

  it('rejects copied safety identities and freezes authenticated wrappers', async () => {
    const rawSource = new MemoryMetadataSource();
    const verifier = {
      async verify() {
        return true;
      },
    };
    const source = createRelationshipSafeMetadataSource(rawSource, verifier);
    const safeEvaluate = evaluator(() => ({ allowed: true }));
    const copiedSource = { ...source } as typeof source;
    const assignedSource = Object.assign({}, source) as typeof source;
    const spreadEvaluator = { ...safeEvaluate } as unknown as MetadataSafeCapabilityEvaluator;
    const copiedEvaluator = Object.assign(
      async (...args: Parameters<ExactCapabilityEvaluator>) => safeEvaluate(...args),
      safeEvaluate
    ) as MetadataSafeCapabilityEvaluator;

    assert.throws(
      () => new MetadataQueryService(copiedSource, safeEvaluate),
      MetadataContractError
    );
    assert.throws(
      () => new MetadataQueryService(assignedSource, safeEvaluate),
      MetadataContractError
    );
    assert.throws(() => new MetadataQueryService(source, copiedEvaluator), MetadataContractError);
    assert.throws(() => new MetadataQueryService(source, spreadEvaluator), MetadataContractError);
    assert.throws(
      () => Object.assign(source, { listProjectCandidates: rawSource.listProjectCandidates }),
      TypeError
    );
    assert.throws(() => Object.assign(safeEvaluate, { apply: rawEvaluator }), TypeError);
    assert.equal(Object.isFrozen(source), true);
    assert.equal(Object.isFrozen(safeEvaluate), true);

    rawSource.listProjectCandidates = async () => [project('injected', 'Injected')];
    verifier.verify = async () => false;
    assert.deepEqual(
      await source.listProjectCandidates('user-1', { limit: 1, filter: '', after: null }),
      []
    );
  });

  it('rejects cross-kind cursors, duplicate IDs, and non-deterministic query inputs', async () => {
    const source = new MemoryMetadataSource();
    source.projects = [project('project-1', 'Alpha'), project('project-2', 'Beta')];
    source.resources = [
      {
        id: 'resource-1',
        name: 'Resource',
        mode: 'ONE_OF_N',
        version: 'resource-v1',
        createdAt: now,
      },
    ];
    const service = metadataService(
      source,
      evaluator(() => ({ allowed: true }))
    );
    const projects = await service.listProjects(principal, { limit: 1 });
    assert.ok(projects.nextCursor);

    await assert.rejects(
      service.listResources(principal, { cursor: projects.nextCursor }),
      MetadataContractError
    );
    await assert.rejects(
      service.listProjects(principal, { cursor: 'not-a-valid-json-cursor' }),
      MetadataContractError
    );
    await assert.rejects(
      service.listProjects(principal, { cursor: projects.nextCursor, filter: 'Beta' }),
      MetadataContractError
    );
    await assert.rejects(service.listProjects(principal, { limit: 0 }), MetadataContractError);

    source.projects = [project('duplicate', 'One'), project('duplicate', 'Two')];
    await assert.rejects(service.listProjects(principal), MetadataContractError);
  });

  it('validates and decodes queries before any source or evaluator access', async () => {
    const source = new MemoryMetadataSource();
    let evaluatorCalls = 0;
    const service = metadataService(
      source,
      evaluator(() => {
        evaluatorCalls += 1;
        return { allowed: true };
      })
    );

    await assert.rejects(service.listProjects(principal, { limit: 101 }), MetadataContractError);
    await assert.rejects(
      service.listProjects(principal, { cursor: 'malformed-before-source' }),
      MetadataContractError
    );
    await assert.rejects(
      service.listProjects(principal, { filter: 'x'.repeat(129) }),
      MetadataContractError
    );
    await assert.rejects(
      service.listProjects(principal, { filter: 42 as unknown as string }),
      MetadataContractError
    );
    await assert.rejects(
      service.listProjects(principal, { cursor: 'x'.repeat(2049) }),
      MetadataContractError
    );
    assert.equal(source.observedSubjects.length, 0);
    assert.equal(source.observedCriteria.length, 0);
    assert.equal(evaluatorCalls, 0);

    source.projects = [project('project-1', 'Alpha')];
    await service.listProjects(principal, { limit: 7, filter: ' ALPHA ' });
    assert.deepEqual(source.observedCriteria, [{ limit: 8, filter: 'alpha', after: null }]);
  });

  it('fails closed through an independent ancestry verifier before policy evaluation', async () => {
    const source = new MemoryMetadataSource();
    source.projects = [project('project-foreign', 'Foreign')];
    source.environments = [
      {
        id: 'environment-cross-project',
        projectId: 'project-claimed',
        resourceId: 'resource-cross-environment',
        name: 'Cross project',
        slug: 'cross',
        createdAt: now,
        updatedAt: now,
      },
    ];
    source.resources = [
      {
        id: 'resource-cross-environment',
        projectId: 'project-claimed',
        environmentId: 'environment-claimed',
        name: 'Cross environment',
        mode: 'ONE_OF_N',
        version: 'resource-v1',
        createdAt: now,
      },
    ];
    source.secrets = [
      {
        id: 'secret-cross-resource',
        projectId: 'project-claimed',
        environmentId: 'environment-claimed',
        resourceId: 'resource-foreign',
        key: 'CROSS_RESOURCE',
        version: 'secret-v1',
        createdAt: now,
        updatedAt: now,
      },
    ];
    let evaluatorCalls = 0;
    const relationshipEvaluator = evaluator(() => {
      evaluatorCalls += 1;
      return { allowed: true };
    });
    const verifier: Parameters<typeof metadataService>[2] = async (kind, record) => {
      if (kind === 'PROJECT') return record.id !== 'project-foreign';
      if (kind === 'ENVIRONMENT') return record.id !== 'environment-cross-project';
      if (kind === 'RESOURCE') return record.id !== 'resource-cross-environment';
      if (kind === 'SECRET') return record.id !== 'secret-cross-resource';
      return true;
    };

    await assert.rejects(
      metadataService(source, relationshipEvaluator, verifier).listProjects(principal),
      MetadataContractError
    );
    await assert.rejects(
      metadataService(source, relationshipEvaluator, verifier).listEnvironments(principal),
      MetadataContractError
    );
    await assert.rejects(
      metadataService(source, relationshipEvaluator, verifier).listResources(principal),
      MetadataContractError
    );
    await assert.rejects(
      metadataService(source, relationshipEvaluator, verifier).listSecrets(principal),
      MetadataContractError
    );
    assert.equal(evaluatorCalls, 0);
  });

  it('preserves complete ALLOW, DENY, and APPROVAL_REQUIRED decision semantics', async () => {
    const source = new MemoryMetadataSource();
    source.projects = [project('project-1', 'Alpha')];
    const service = metadataService(
      source,
      evaluator((capability) => {
        if (capability === 'project.view') {
          return {
            allowed: true,
            reasonCode: 'READER',
            authority: ['PROJECT_READER'],
            safeExplanation: 'Reader can view this exact Project.',
            grantId: 'grant-attribution',
          };
        }
        if (capability === 'project.delete') {
          return {
            allowed: false,
            decisionCode: 'APPROVAL_REQUIRED',
            reasonCode: 'NO_ROLE',
            safeExplanation: 'Additional approval is required.',
            approvalRequestId: 'request-pending',
          };
        }
        return {
          allowed: false,
          reasonCode: 'NO_ROLE',
          safeExplanation: 'The exact Project operation is denied.',
        };
      })
    );

    const page = await service.listProjects(principal);
    const decisions = page.items[0].capabilities.decisions;
    assert.deepEqual(
      decisions.find((item) => item.capability === 'project.view'),
      {
        capability: 'project.view',
        allowed: true,
        decisionCode: 'ALLOW',
        reasonCode: 'READER',
        authoritySources: ['PROJECT_READER'],
        safeExplanation: 'Reader can view this exact Project.',
        grantId: 'grant-attribution',
      }
    );
    assert.deepEqual(
      decisions.find((item) => item.capability === 'project.delete'),
      {
        capability: 'project.delete',
        allowed: false,
        decisionCode: 'APPROVAL_REQUIRED',
        reasonCode: 'NO_ROLE',
        authoritySources: [],
        safeExplanation: 'Additional approval is required.',
        approvalRequestId: 'request-pending',
      }
    );
    assert.equal(
      decisions.find((item) => item.capability === 'project.update')?.decisionCode,
      'DENY'
    );
  });

  it('rejects contradictory allowed and decisionCode evaluator results', async () => {
    for (const contradiction of [
      { allowed: true, decisionCode: 'APPROVAL_REQUIRED' as const },
      { allowed: false, decisionCode: 'ALLOW' as const },
    ]) {
      const source = new MemoryMetadataSource();
      source.projects = [project('project-1', 'Alpha')];
      const service = metadataService(
        source,
        evaluator((capability) =>
          capability === 'project.view' ? contradiction : { allowed: false, decisionCode: 'DENY' }
        )
      );
      await assert.rejects(service.listProjects(principal), MetadataContractError);
    }
  });

  it('rejects inconsistent request/grant targets before capability evaluation', async () => {
    const source = new MemoryMetadataSource();
    source.requests = [
      {
        id: 'request-inconsistent',
        resourceId: 'resource-a',
        status: 'PENDING',
        action: 'secret.value.read',
        target: {
          kind: 'SECRET',
          resourceId: 'resource-b',
          targetKey: 'TARGET',
          targetVersion: 'target-v1',
        },
        grant: {
          id: 'grant-inconsistent',
          requestId: 'another-request',
          expiresAt: later,
          consumedAt: null,
          revokedAt: null,
        },
        policyVersion: 'policy-v1',
        createdAt: now,
        expiresAt: later,
      },
    ];
    let evaluatorCalls = 0;
    const service = metadataService(
      source,
      evaluator(() => {
        evaluatorCalls += 1;
        return { allowed: true };
      })
    );

    await assert.rejects(service.listRequests(principal), MetadataContractError);
    assert.equal(evaluatorCalls, 0);
  });

  it('rejects malformed discriminated request targets and incoherent actions', async () => {
    const malformedTargets: Array<Pick<RequestMetadataRecord, 'action' | 'target'>> = [
      {
        action: 'secret.value.read',
        target: {
          kind: 'SECRET',
          resourceId: 'resource-a',
          targetVersion: 'target-v1',
        } as RequestMetadataRecord['target'],
      },
      {
        action: 'resource.view',
        target: {
          kind: 'RESOURCE',
          resourceId: 'resource-a',
          targetKey: null,
          targetVersion: 'target-v1',
        } as unknown as RequestMetadataRecord['target'],
      },
      {
        action: 'totp.code.read',
        target: {
          kind: 'TOTP_ACCOUNT',
          resourceId: 'resource-a',
          targetKey: 'legacy-overloaded-account-id',
          targetVersion: 'target-v1',
        } as unknown as RequestMetadataRecord['target'],
      },
      {
        action: 'totp.code.read',
        target: {
          kind: 'SECRET',
          resourceId: 'resource-a',
          targetKey: 'SECRET_KEY',
          targetVersion: 'target-v1',
        },
      },
      {
        action: 'secret.value.read',
        target: {
          kind: 'SECRET',
          resourceId: 'resource-a',
          targetKey: 'SECRET_KEY',
          targetVersion: 42,
        } as unknown as RequestMetadataRecord['target'],
      },
      {
        action: 'resource.view',
        target: {
          kind: 'RESOURCE',
          resourceId: 'resource-a',
          targetVersion: { version: 'target-v1' },
        } as unknown as RequestMetadataRecord['target'],
      },
      {
        action: 'secret.reveal' as RequestMetadataRecord['action'],
        target: {
          kind: 'SECRET',
          resourceId: 'resource-a',
          targetKey: 'SECRET_KEY',
          targetVersion: 'target-v1',
        },
      },
    ];

    for (const malformed of malformedTargets) {
      const source = new MemoryMetadataSource();
      source.requests = [
        {
          id: 'request-malformed',
          resourceId: 'resource-a',
          status: 'PENDING',
          action: malformed.action,
          target: malformed.target,
          grant: null,
          policyVersion: 'policy-v1',
          createdAt: now,
          expiresAt: later,
        },
      ];
      let evaluatorCalls = 0;
      const service = metadataService(
        source,
        evaluator(() => {
          evaluatorCalls += 1;
          return { allowed: true };
        })
      );
      await assert.rejects(service.listRequests(principal), MetadataContractError);
      assert.equal(evaluatorCalls, 0);
    }
  });

  it('allowlists every nested request-target kind and drops protected adapter properties', async () => {
    const source = new MemoryMetadataSource();
    const common = {
      resourceId: 'resource-a',
      status: 'PENDING' as const,
      grant: null,
      policyVersion: 'policy-v1',
      createdAt: now,
      expiresAt: later,
    };
    source.requests = [
      {
        ...common,
        id: 'request-secret',
        action: 'secret.value.read',
        target: {
          kind: 'SECRET',
          resourceId: 'resource-a',
          targetKey: 'DATABASE_URL',
          targetVersion: 'secret-v1',
          encryptedValue: 'ciphertext-must-not-emit',
        } as unknown as RequestMetadataRecord['target'],
      },
      {
        ...common,
        id: 'request-resource',
        action: 'resource.view',
        target: {
          kind: 'RESOURCE',
          resourceId: 'resource-a',
          targetVersion: 'resource-v1',
          callbackSecret: 'callback-must-not-emit',
          password: 'password-must-not-emit',
        } as unknown as RequestMetadataRecord['target'],
      },
      {
        ...common,
        id: 'request-totp',
        action: 'totp.code.read',
        target: {
          kind: 'TOTP_ACCOUNT',
          resourceId: 'resource-a',
          totpAccountId: 'totp-a',
          targetVersion: 'totp-v1',
          privateKey: 'private-key-must-not-emit',
        } as unknown as RequestMetadataRecord['target'],
      },
    ];
    const page = await metadataService(
      source,
      evaluator((capability) => ({ allowed: capability === 'request.view-own' }))
    ).listRequests(principal);

    assert.equal(page.items.length, 3);
    assertNoProtectedProperties(page);
    for (const item of page.items) {
      const expectedKeys =
        item.target.kind === 'SECRET'
          ? ['kind', 'resourceId', 'targetKey', 'targetVersion']
          : item.target.kind === 'TOTP_ACCOUNT'
            ? ['kind', 'resourceId', 'targetVersion', 'totpAccountId']
            : ['kind', 'resourceId', 'targetVersion'];
      assert.deepEqual(Object.keys(item.target).sort(), expectedKeys.sort());
    }
  });

  it('filters every object kind with an exact capability and never globally enumerates requests', async () => {
    const source = new MemoryMetadataSource();
    source.environments = [
      {
        id: 'environment-visible',
        projectId: 'project-visible',
        resourceId: 'resource-member',
        name: 'Production',
        slug: 'prod',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'environment-hidden',
        projectId: 'project-hidden',
        name: 'Hidden',
        slug: 'hidden',
        createdAt: now,
        updatedAt: now,
      },
    ];
    source.resources = [
      {
        id: 'resource-guarded',
        name: 'Guarded',
        mode: 'ONE_OF_N',
        version: 'resource-v1',
        createdAt: now,
      },
      {
        id: 'resource-hidden',
        name: 'Hidden',
        mode: 'ONE_OF_N',
        version: 'resource-v1',
        createdAt: now,
      },
    ];
    source.secrets = [
      {
        id: 'secret-visible',
        projectId: 'project-visible',
        environmentId: 'environment-visible',
        resourceId: 'resource-member',
        key: 'DATABASE_URL',
        version: 'secret-v1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'secret-hidden',
        resourceId: 'resource-guarded',
        key: 'GUARDIAN_MUST_NOT_SEE',
        version: 'secret-v1',
        createdAt: now,
        updatedAt: now,
      },
    ];
    source.totp = [
      {
        id: 'totp-visible',
        scope: 'LINKED',
        projectId: 'project-visible',
        resourceId: 'resource-member',
        accountName: 'Deployment',
        issuer: 'Example',
        accountVersion: 'totp-v1',
        resourceVersion: 'resource-v1',
        linkVersion: 'link-v1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'totp-global-shared',
        scope: 'LINKED',
        resourceId: 'resource-other',
        accountName: 'Must not enumerate',
        issuer: null,
        accountVersion: 'totp-v1',
        resourceVersion: 'resource-v1',
        linkVersion: 'link-v1',
        createdAt: now,
        updatedAt: now,
      },
    ];
    source.requests = [
      {
        id: 'request-own',
        resourceId: 'resource-other',
        status: 'PENDING',
        action: 'secret.value.read',
        target: {
          kind: 'SECRET',
          resourceId: 'resource-other',
          targetKey: 'OWN_REQUEST_KEY',
          targetVersion: 'secret-v1',
        },
        grant: null,
        policyVersion: 'policy-v1',
        createdAt: now,
        expiresAt: later,
      },
      {
        id: 'request-guarded',
        resourceId: 'resource-guarded',
        status: 'PENDING',
        action: 'totp.code.read',
        target: {
          kind: 'TOTP_ACCOUNT',
          resourceId: 'resource-guarded',
          totpAccountId: 'totp-visible',
          targetVersion: 'totp-v1',
        },
        grant: {
          id: 'grant-guarded',
          requestId: 'request-guarded',
          expiresAt: later,
          consumedAt: null,
          revokedAt: null,
        },
        policyVersion: 'policy-v1',
        createdAt: later,
        expiresAt: later,
      },
      {
        id: 'request-member-only',
        projectId: 'project-visible',
        resourceId: 'resource-member',
        status: 'PENDING',
        action: 'secret.value.read',
        target: {
          kind: 'SECRET',
          resourceId: 'resource-member',
          targetKey: 'MEMBER_MUST_NOT_SEE',
          targetVersion: 'secret-v1',
        },
        grant: null,
        policyVersion: 'policy-v1',
        createdAt: later,
        expiresAt: later,
      },
    ];

    const service = metadataService(
      source,
      evaluator((capability, context) => {
        const allowed =
          (capability === 'environment.view' && context.environmentId === 'environment-visible') ||
          (capability === 'resource.view' && context.resourceId === 'resource-guarded') ||
          (capability === 'secret.metadata.read' && context.fieldName === 'DATABASE_URL') ||
          (capability === 'totp.metadata.read' && context.totpAccountId === 'totp-visible') ||
          (capability === 'request.view-own' && context.requestId === 'request-own') ||
          (capability === 'request.queue.view' && context.requestId === 'request-guarded');
        return {
          allowed,
          authority:
            capability === 'totp.metadata.read' && context.totpAccountId === 'totp-visible'
              ? ['PROJECT_OWNER']
              : undefined,
        };
      })
    );

    const environments = await service.listEnvironments(principal);
    assert.deepEqual(
      environments.items.map((item) => item.id),
      ['environment-visible']
    );
    assertCapabilityContract(environments, 'ENVIRONMENT');
    const resources = await service.listResources(principal);
    assert.deepEqual(
      resources.items.map((item) => item.id),
      ['resource-guarded']
    );
    assertCapabilityContract(resources, 'RESOURCE');
    const secrets = await service.listSecrets(principal);
    assert.deepEqual(
      secrets.items.map((item) => item.id),
      ['secret-visible']
    );
    assertCapabilityContract(secrets, 'SECRET');
    const totp = await service.listTOTPAccounts(principal);
    assert.equal(totp.items[0]?.kind, 'TOTP_ACCOUNT');
    if (totp.items[0]?.kind !== 'TOTP_ACCOUNT') assert.fail('expected detailed TOTP metadata');
    assert.equal(totp.items[0].id, 'totp-visible');
    assertCapabilityContract({ ...totp, items: [totp.items[0]] }, 'TOTP_ACCOUNT');
    const requests = await service.listRequests(principal);
    assert.deepEqual(requests.items.map((item) => item.id).sort(), [
      'request-guarded',
      'request-own',
    ]);
    assert.equal(
      requests.items.some((item) => item.id === 'request-member-only'),
      false
    );
    assert.equal(
      requests.items.some((item) => 'requesterId' in item),
      false
    );
    assertCapabilityContract(requests, 'APPROVAL_REQUEST');
    assert.deepEqual(
      requests.items
        .map((item) =>
          item.target.kind === 'SECRET' ? item.target.targetKey : item.target.totpAccountId
        )
        .sort(),
      ['OWN_REQUEST_KEY', 'totp-visible']
    );
    assert.equal(
      requests.items.some(
        (item) => item.target.kind === 'SECRET' && item.target.targetKey === 'MEMBER_MUST_NOT_SEE'
      ),
      false
    );
    assertNoProtectedProperties(requests);
  });

  it('tiers TOTP metadata for Owners, members, Guardians, and Requesters', async () => {
    const source = new MemoryMetadataSource();
    source.totp = [
      {
        id: 'personal-account',
        scope: 'PERSONAL',
        ownerDiscordUserId: 'user-1',
        accountName: 'Personal label',
        issuer: 'Personal issuer',
        accountVersion: 'personal-v1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'linked-account',
        scope: 'LINKED',
        projectId: 'project-1',
        environmentId: 'environment-1',
        resourceId: 'resource-1',
        accountName: 'Linked label',
        issuer: 'Linked issuer',
        accountVersion: 'account-v1',
        resourceVersion: 'resource-v1',
        linkVersion: 'link-v1',
        createdAt: now,
        updatedAt: now,
      },
    ];

    const ownerService = metadataService(
      source,
      evaluator((capability) => ({
        allowed: capability === 'totp.metadata.read',
        reasonCode: 'OWNER',
        authority: capability === 'totp.metadata.read' ? ['TOTP_OWNER'] : [],
      }))
    );
    const ownerPage = await ownerService.listTOTPAccounts(principal);
    assert.equal(ownerPage.items.length, 2);
    assert.ok(ownerPage.items.every((item) => item.kind === 'TOTP_ACCOUNT'));
    assert.ok(
      ownerPage.items.some(
        (item) => item.kind === 'TOTP_ACCOUNT' && item.accountName === 'Personal label'
      )
    );
    assert.ok(
      ownerPage.items.some(
        (item) => item.kind === 'TOTP_ACCOUNT' && item.accountName === 'Linked label'
      )
    );

    for (const role of ['WRITER', 'READER'] as const) {
      const memberService = metadataService(
        source,
        evaluator((capability, context) => ({
          allowed:
            (capability === 'totp.metadata.read' && context.totpAccountId === 'linked-account') ||
            (capability === 'resource.view' &&
              context.resourceId === 'resource-1' &&
              context.totpAccountId === undefined),
          reasonCode: role,
          authority:
            capability === 'totp.metadata.read' || capability === 'resource.view'
              ? [role === 'WRITER' ? 'PROJECT_WRITER' : 'PROJECT_READER']
              : [],
        }))
      );
      const memberPage = await memberService.listTOTPAccounts(principal);
      assert.equal(memberPage.items.length, 1);
      assert.equal(memberPage.items[0].kind, 'TOTP_LINK_STATUS');
      assert.equal(memberPage.items[0].resourceId, 'resource-1');
      assert.deepEqual(memberPage.items[0].capabilities.target, {
        type: 'RESOURCE',
        id: 'resource-1',
      });
      assertCapabilityContract(memberPage, 'RESOURCE');
      assert.equal(JSON.stringify(memberPage).includes('Linked label'), false);
      assert.equal(JSON.stringify(memberPage).includes('linked-account'), false);
      assert.equal(JSON.stringify(memberPage).includes('account-v1'), false);
      assert.equal(JSON.stringify(memberPage).includes('link-v1'), false);
    }

    const unrelatedOwnerAuthority = metadataService(
      source,
      evaluator((capability, context) => ({
        allowed:
          (context.totpAccountId === 'linked-account' &&
            (capability === 'totp.metadata.read' || capability === 'totp.code.read')) ||
          (capability === 'resource.view' &&
            context.resourceId === 'resource-1' &&
            context.totpAccountId === undefined),
        authority:
          capability === 'totp.metadata.read'
            ? ['PROJECT_READER']
            : capability === 'totp.code.read'
              ? ['PROJECT_OWNER']
              : capability === 'resource.view'
                ? ['PROJECT_READER']
                : [],
      }))
    );
    const minimized = await unrelatedOwnerAuthority.listTOTPAccounts(principal);
    assert.equal(minimized.items.length, 1);
    assert.equal(minimized.items[0].kind, 'TOTP_LINK_STATUS');
    assert.equal(minimized.items[0].resourceId, 'resource-1');
    assert.deepEqual(minimized.items[0].capabilities.target, {
      type: 'RESOURCE',
      id: 'resource-1',
    });
    assertCapabilityContract(minimized, 'RESOURCE');
    assert.equal(JSON.stringify(minimized).includes('linked-account'), false);

    for (const authority of ['EXPLICIT_GUARDIAN', 'APPROVAL_GRANT'] as const) {
      const scopedService = metadataService(
        source,
        evaluator((_capability) => ({
          allowed: false,
          reasonCode: authority === 'EXPLICIT_GUARDIAN' ? 'GUARDIAN' : 'GRANT',
          authority: [],
        }))
      );
      assert.equal((await scopedService.listTOTPAccounts(principal)).items.length, 0);
    }
  });

  it('never invokes a value-bearing decryptor while building metadata capability summaries', async () => {
    const source = new MemoryMetadataSource();
    source.totp = [
      {
        id: 'totp-linked',
        scope: 'LINKED',
        projectId: 'project-visible',
        resourceId: 'resource-visible',
        accountName: 'Metadata only',
        issuer: 'Example',
        accountVersion: 'totp-v1',
        resourceVersion: 'resource-v1',
        linkVersion: 'link-v1',
        createdAt: now,
        updatedAt: now,
      },
    ];
    let decryptorCalls = 0;
    const valueBearingStore = {
      decrypt(): never {
        decryptorCalls += 1;
        throw new Error('metadata must not decrypt');
      },
    };
    const evaluatedCapabilities: Capability[] = [];
    const observedVersionContexts: Array<{ accountVersion?: string; linkVersion?: string }> = [];
    const baseEvaluator: ExactCapabilityEvaluator = async (
      evaluatedPrincipal,
      capability,
      context
    ) => {
      if (capability.startsWith('totp.')) valueBearingStore.decrypt();
      return rawEvaluator(() => ({ allowed: false }))(evaluatedPrincipal, capability, context);
    };
    const totpMetadataEvaluator = rawEvaluator((capability, context) => {
      evaluatedCapabilities.push(capability);
      observedVersionContexts.push({
        accountVersion: context.accountVersion,
        linkVersion: context.linkVersion,
      });
      return {
        allowed: capability === 'totp.metadata.read',
        authority: capability === 'totp.metadata.read' ? ['TOTP_OWNER'] : [],
      };
    });
    const safeEvaluator = createMetadataSafeCapabilityEvaluator(
      baseEvaluator,
      totpMetadataEvaluator
    );
    const service = metadataService(source, safeEvaluator);

    const page = await service.listTOTPAccounts(principal);
    assert.equal(page.items[0]?.kind, 'TOTP_ACCOUNT');
    if (page.items[0]?.kind !== 'TOTP_ACCOUNT') assert.fail('expected detailed TOTP metadata');
    assert.equal(page.items[0].id, 'totp-linked');
    assert.equal(page.items[0].accountVersion, 'totp-v1');
    assert.equal(page.items[0].scope, 'LINKED');
    if (page.items[0].scope !== 'LINKED') assert.fail('expected linked TOTP metadata');
    assert.equal(page.items[0].linkVersion, 'link-v1');
    assert.deepEqual(evaluatedCapabilities, METADATA_CAPABILITY_SUMMARY_CONTRACT.TOTP_ACCOUNT);
    assert.ok(
      observedVersionContexts.every(
        (context) => context.accountVersion === 'totp-v1' && context.linkVersion === 'link-v1'
      )
    );
    assert.equal(decryptorCalls, 0);
    assert.equal(typeof valueBearingStore.decrypt, 'function');
    assertNoProtectedProperties(page);
  });

  it('constructs output from an explicit allowlist and drops unknown protected properties', async () => {
    const source = new MemoryMetadataSource();
    source.totp = [
      {
        id: 'totp-unsafe',
        scope: 'PERSONAL',
        ownerDiscordUserId: 'user-1',
        accountName: 'Unsafe adapter',
        issuer: null,
        accountVersion: 'totp-v1',
        createdAt: now,
        updatedAt: now,
        encryptedSeed: 'encrypted-but-still-protected',
        password: 'must-not-emit',
        privateKey: 'must-not-emit',
        unknown: 'must-not-emit',
      } as unknown as TOTPMetadataRecord,
    ];
    const service = metadataService(
      source,
      evaluator((capability) => ({
        allowed: true,
        authority: capability === 'totp.metadata.read' ? ['TOTP_OWNER'] : [],
      }))
    );
    const page = await service.listTOTPAccounts(principal);
    assert.equal(page.items.length, 1);
    assertNoProtectedProperties(page);
    assert.equal('unknown' in page.items[0], false);
    assert.equal('password' in page.items[0], false);
    assert.equal('privateKey' in page.items[0], false);
  });
});

describe('canonical secret selection and reveal boundary', () => {
  it('keeps canonical ordering and digest stable across adapter fixtures', () => {
    const fixture = METADATA_CONTRACT_FIXTURES.canonicalSecretKeySet;
    const canonical = canonicalizeSecretKeys(fixture.input);
    assert.deepEqual(canonical, fixture.canonical);
    assert.equal(digestCanonicalSecretKeySet(canonical), fixture.digest);
    assert.throws(() => digestCanonicalSecretKeySet(fixture.input), MetadataContractError);
    assert.throws(() => canonicalizeSecretKeys(['duplicate', 'duplicate']), MetadataContractError);
    assert.throws(() => canonicalizeSecretKeys([' leading-space']), MetadataContractError);
    assert.throws(() => canonicalizeSecretKeys(['e\u0301clair']), MetadataContractError);
  });

  it('authorizes exact canonical keys before storage selection and decryption', async () => {
    const events: string[] = [];
    let observedSelection: ExactSecretSelection | undefined;
    const reveal = new ExactSecretRevealService(
      {
        async selectEncryptedByCanonicalKeys(selection) {
          events.push('select');
          observedSelection = selection;
          return selection.canonicalKeys.map((key) => ({
            key,
            encryptedValue: `cipher:${key}`,
            targetVersion: selection.targetVersion,
          }));
        },
      },
      async (encryptedValue, context) => {
        events.push(`decrypt:${context.key}`);
        return encryptedValue.replace('cipher:', 'plain:');
      },
      evaluator((capability, context) => {
        events.push(`authorize:${context.fieldName}`);
        return { allowed: capability === 'secret.value.read' };
      })
    );

    const result = await reveal.reveal(principal, {
      projectId: 'project-1',
      environmentId: 'environment-1',
      resourceId: 'resource-1',
      targetVersion: 'resource-v7',
      keys: ['zeta', 'alpha'],
    });

    assert.deepEqual(observedSelection, {
      resourceId: 'resource-1',
      canonicalKeys: ['alpha', 'zeta'],
      targetVersion: 'resource-v7',
    });
    assert.deepEqual(events, [
      'authorize:alpha',
      'authorize:zeta',
      'select',
      'decrypt:alpha',
      'decrypt:zeta',
    ]);
    assert.deepEqual(
      { ...result.values },
      {
        alpha: 'plain:alpha',
        zeta: 'plain:zeta',
      }
    );
    assert.equal(result.keySetDigest, digestCanonicalSecretKeySet(['alpha', 'zeta']));
  });

  it('never selects or decrypts if any exact key is denied', async () => {
    let selections = 0;
    let decryptions = 0;
    const reveal = new ExactSecretRevealService(
      {
        async selectEncryptedByCanonicalKeys() {
          selections += 1;
          return [];
        },
      },
      async () => {
        decryptions += 1;
        return 'should-not-run';
      },
      evaluator((_capability, context) => ({ allowed: context.fieldName !== 'denied' }))
    );

    await assert.rejects(
      reveal.reveal(principal, {
        resourceId: 'resource-1',
        targetVersion: 'resource-v1',
        keys: ['allowed', 'denied'],
      }),
      MetadataAuthorizationError
    );
    assert.equal(selections, 0);
    assert.equal(decryptions, 0);
  });

  it('never selects or decrypts for contradictory allow decisions', async () => {
    for (const decisionCode of ['DENY', 'APPROVAL_REQUIRED'] as const) {
      let selections = 0;
      let decryptions = 0;
      const reveal = new ExactSecretRevealService(
        {
          async selectEncryptedByCanonicalKeys() {
            selections += 1;
            return [];
          },
        },
        async () => {
          decryptions += 1;
          return 'should-not-run';
        },
        evaluator(() => ({ allowed: true, decisionCode }))
      );

      await assert.rejects(
        reveal.reveal(principal, {
          resourceId: 'resource-1',
          targetVersion: 'resource-v1',
          keys: ['requested'],
        }),
        MetadataContractError
      );
      assert.equal(selections, 0);
      assert.equal(decryptions, 0);
    }
  });

  it('rejects overbroad, incomplete, duplicate, or stale selections before decrypting', async () => {
    const invalidSelections = [
      [
        { key: 'requested', encryptedValue: 'cipher', targetVersion: 'v1' },
        { key: 'extra', encryptedValue: 'cipher', targetVersion: 'v1' },
      ],
      [],
      [
        { key: 'requested', encryptedValue: 'cipher-1', targetVersion: 'v1' },
        { key: 'requested', encryptedValue: 'cipher-2', targetVersion: 'v1' },
      ],
      [{ key: 'requested', encryptedValue: 'cipher', targetVersion: 'stale' }],
    ];

    for (const rows of invalidSelections) {
      let decryptions = 0;
      const reveal = new ExactSecretRevealService(
        {
          async selectEncryptedByCanonicalKeys() {
            return rows;
          },
        },
        async () => {
          decryptions += 1;
          return 'should-not-run';
        },
        evaluator(() => ({ allowed: true }))
      );
      await assert.rejects(
        reveal.reveal(principal, {
          resourceId: 'resource-1',
          targetVersion: 'v1',
          keys: ['requested'],
        }),
        MetadataContractError
      );
      assert.equal(decryptions, 0);
    }
  });
});

// Keep the generic page type exercised by contract consumers without coupling to an adapter.
const _pageContract: MetadataPage<{ id: string }> = {
  items: [],
  nextCursor: null,
  cachePolicy: SUBJECT_BOUND_METADATA_CACHE_POLICY,
};
void _pageContract;
