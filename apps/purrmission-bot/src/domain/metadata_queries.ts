import { createHash } from 'node:crypto';

import type {
  ApprovalStatus,
  AuthoritySource,
  Capability,
  CapabilityContext,
  DecisionCode,
  EvaluationResult,
  PolicyTarget,
  Principal,
  ReasonCode,
} from './models.js';
import { authorizationSubjectId, validatePrincipal } from './principal.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_FILTER_LENGTH = 128;
const MAX_CURSOR_LENGTH = 2048;
const MAX_SECRET_KEYS = 100;
const MAX_SECRET_KEY_BYTES = 256;
const KEY_SET_DIGEST_DOMAIN = 'purrmission.secret-key-set.v1';

export type MetadataKind =
  | 'PROJECT'
  | 'ENVIRONMENT'
  | 'RESOURCE'
  | 'SECRET'
  | 'TOTP_ACCOUNT'
  | 'APPROVAL_REQUEST';

export interface MetadataQuery {
  limit?: number;
  cursor?: string;
  filter?: string;
}

export interface MetadataPage<T> {
  items: T[];
  nextCursor: string | null;
  cachePolicy: MetadataCachePolicyDTO;
}

export interface MetadataCachePolicyDTO {
  cacheControl: 'private, no-store';
  vary: readonly ['Authorization'];
}

export const SUBJECT_BOUND_METADATA_CACHE_POLICY: MetadataCachePolicyDTO = Object.freeze({
  cacheControl: 'private, no-store',
  vary: Object.freeze(['Authorization'] as const),
});

export interface CapabilityDecisionDTO {
  capability: Capability;
  allowed: boolean;
  decisionCode: DecisionCode;
  reasonCode: ReasonCode;
  authoritySources: AuthoritySource[];
  safeExplanation: string;
  approvalRequestId?: string;
  grantId?: string;
}

export interface ExactCapabilitySummaryDTO {
  target: PolicyTarget;
  decisions: CapabilityDecisionDTO[];
}

/** Stable, non-sensitive metadata required by exact-object authorization consumers. */
export interface ProjectMetadataRecord {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  policyVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentMetadataRecord {
  id: string;
  projectId: string;
  resourceId?: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResourceMetadataRecord {
  id: string;
  projectId?: string;
  environmentId?: string;
  name: string;
  mode: string;
  version: string;
  createdAt: Date;
}

export interface SecretMetadataRecord {
  id: string;
  projectId?: string;
  environmentId?: string;
  resourceId: string;
  requestId?: string;
  key: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TOTPMetadataRecordBase {
  id: string;
  accountName: string;
  issuer: string | null;
  accountVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersonalTOTPMetadataRecord extends TOTPMetadataRecordBase {
  scope: 'PERSONAL';
  ownerDiscordUserId: string;
}

export interface LinkedTOTPMetadataRecord extends TOTPMetadataRecordBase {
  scope: 'LINKED';
  projectId?: string;
  environmentId?: string;
  resourceId: string;
  resourceVersion: string;
  linkVersion: string;
}

export type TOTPMetadataRecord = PersonalTOTPMetadataRecord | LinkedTOTPMetadataRecord;

export interface SecretRequestTargetMetadataRecord {
  kind: 'SECRET';
  resourceId: string;
  targetKey: string;
  targetVersion: string;
}

export interface ResourceRequestTargetMetadataRecord {
  kind: 'RESOURCE';
  resourceId: string;
  targetKey?: never;
  totpAccountId?: never;
  targetVersion: string;
}

export interface TOTPRequestTargetMetadataRecord {
  kind: 'TOTP_ACCOUNT';
  resourceId: string;
  totpAccountId: string;
  targetKey?: never;
  targetVersion: string;
}

export type RequestTargetMetadataRecord =
  | SecretRequestTargetMetadataRecord
  | ResourceRequestTargetMetadataRecord
  | TOTPRequestTargetMetadataRecord;

export type RequestMetadataAction = Extract<
  Capability,
  'secret.value.read' | 'resource.view' | 'totp.code.read'
>;

export interface GrantMetadataRecord {
  id: string;
  requestId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

export interface RequestMetadataRecord {
  id: string;
  projectId?: string;
  environmentId?: string;
  resourceId: string;
  status: ApprovalStatus;
  action: RequestMetadataAction;
  target: RequestTargetMetadataRecord;
  grant: GrantMetadataRecord | null;
  policyVersion: string;
  createdAt: Date;
  expiresAt: Date;
}

export type ProjectMetadataDTO = Omit<ProjectMetadataRecord, 'ownerId'> & {
  kind: 'PROJECT';
  capabilities: ExactCapabilitySummaryDTO;
};

export type EnvironmentMetadataDTO = EnvironmentMetadataRecord & {
  kind: 'ENVIRONMENT';
  capabilities: ExactCapabilitySummaryDTO;
};

export type ResourceMetadataDTO = ResourceMetadataRecord & {
  kind: 'RESOURCE';
  capabilities: ExactCapabilitySummaryDTO;
};

export type SecretMetadataDTO = SecretMetadataRecord & {
  kind: 'SECRET';
  capabilities: ExactCapabilitySummaryDTO;
};

export interface PersonalTOTPMetadataDTO {
  kind: 'TOTP_ACCOUNT';
  scope: 'PERSONAL';
  id: string;
  accountName: string;
  issuer: string | null;
  accountVersion: string;
  createdAt: Date;
  updatedAt: Date;
  capabilities: ExactCapabilitySummaryDTO;
}

export interface LinkedTOTPDetailMetadataDTO {
  kind: 'TOTP_ACCOUNT';
  scope: 'LINKED';
  id: string;
  projectId?: string;
  environmentId?: string;
  resourceId: string;
  linked: true;
  accountName: string;
  issuer: string | null;
  accountVersion: string;
  linkVersion: string;
  createdAt: Date;
  updatedAt: Date;
  capabilities: ExactCapabilitySummaryDTO;
}

export interface LinkedTOTPExistenceDTO {
  kind: 'TOTP_LINK_STATUS';
  scope: 'LINKED';
  resourceId: string;
  linked: true;
  capabilities: ExactCapabilitySummaryDTO;
}

export type TOTPMetadataDTO =
  | PersonalTOTPMetadataDTO
  | LinkedTOTPDetailMetadataDTO
  | LinkedTOTPExistenceDTO;

export type RequestMetadataDTO = RequestMetadataRecord & {
  kind: 'APPROVAL_REQUEST';
  capabilities: ExactCapabilitySummaryDTO;
};

export interface SubjectBoundMetadataCriteria {
  limit: number;
  filter: string;
  after: { sortKey: string; id: string } | null;
}

/**
 * Candidate methods are subject-bound by contract. Implementations must use the supplied
 * authorization subject in their query predicate instead of performing a global scan. The query
 * service still evaluates every candidate against the exact object before filtering or paging.
 */
export interface SubjectBoundMetadataSource {
  listProjectCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<ProjectMetadataRecord[]>;
  listEnvironmentCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<EnvironmentMetadataRecord[]>;
  listResourceCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<ResourceMetadataRecord[]>;
  listSecretCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<SecretMetadataRecord[]>;
  listTOTPCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<TOTPMetadataRecord[]>;
  listRequestCandidates(
    subjectId: string,
    criteria: SubjectBoundMetadataCriteria
  ): Promise<RequestMetadataRecord[]>;
}

declare const RELATIONSHIP_SAFE_SOURCE_TYPE: unique symbol;
const relationshipSafeSources = new WeakSet<SubjectBoundMetadataSource>();

export type RelationshipSafeMetadataSource = SubjectBoundMetadataSource & {
  readonly [RELATIONSHIP_SAFE_SOURCE_TYPE]: never;
};

export interface MetadataRelationshipVerifier {
  verify(
    kind: MetadataKind,
    record:
      | ProjectMetadataRecord
      | EnvironmentMetadataRecord
      | ResourceMetadataRecord
      | SecretMetadataRecord
      | TOTPMetadataRecord
      | RequestMetadataRecord
  ): Promise<boolean>;
}

/**
 * Brands a metadata source only after every returned projection has passed an independent
 * ancestry/relationship check. Production wiring must back `verifier` with canonical relation
 * lookups; a projection's claimed parent IDs are never sufficient proof of ancestry.
 */
export function createRelationshipSafeMetadataSource(
  source: SubjectBoundMetadataSource,
  verifier: MetadataRelationshipVerifier
): RelationshipSafeMetadataSource {
  const verifyRelationship = verifier.verify.bind(verifier);
  const listProjectCandidates = source.listProjectCandidates.bind(source);
  const listEnvironmentCandidates = source.listEnvironmentCandidates.bind(source);
  const listResourceCandidates = source.listResourceCandidates.bind(source);
  const listSecretCandidates = source.listSecretCandidates.bind(source);
  const listTOTPCandidates = source.listTOTPCandidates.bind(source);
  const listRequestCandidates = source.listRequestCandidates.bind(source);

  async function verified<T>(kind: MetadataKind, records: T[]): Promise<T[]> {
    for (const record of records) {
      if (
        !(await verifyRelationship(
          kind,
          record as
            | ProjectMetadataRecord
            | EnvironmentMetadataRecord
            | ResourceMetadataRecord
            | SecretMetadataRecord
            | TOTPMetadataRecord
            | RequestMetadataRecord
        ))
      ) {
        throw new MetadataContractError(
          `Metadata source returned a ${kind} projection with unverified ancestry.`
        );
      }
    }
    return records;
  }

  const wrapper: SubjectBoundMetadataSource = {
    listProjectCandidates: async (subjectId, criteria) =>
      verified('PROJECT', await listProjectCandidates(subjectId, criteria)),
    listEnvironmentCandidates: async (subjectId, criteria) =>
      verified('ENVIRONMENT', await listEnvironmentCandidates(subjectId, criteria)),
    listResourceCandidates: async (subjectId, criteria) =>
      verified('RESOURCE', await listResourceCandidates(subjectId, criteria)),
    listSecretCandidates: async (subjectId, criteria) =>
      verified('SECRET', await listSecretCandidates(subjectId, criteria)),
    listTOTPCandidates: async (subjectId, criteria) =>
      verified('TOTP_ACCOUNT', await listTOTPCandidates(subjectId, criteria)),
    listRequestCandidates: async (subjectId, criteria) =>
      verified('APPROVAL_REQUEST', await listRequestCandidates(subjectId, criteria)),
  };
  Object.freeze(wrapper);
  relationshipSafeSources.add(wrapper);
  return wrapper as RelationshipSafeMetadataSource;
}

/**
 * Metadata-query evaluators must resolve #117 decisions from policy metadata projections only.
 * They must not hydrate value-bearing TOTP or secret models while calculating a summary.
 */
export interface MetadataCapabilityContext extends CapabilityContext {
  accountVersion?: string;
  linkVersion?: string;
}

export type ExactCapabilityEvaluator = (
  principal: Principal,
  capability: Capability,
  context: MetadataCapabilityContext
) => Promise<EvaluationResult>;

declare const METADATA_SAFE_EVALUATOR_TYPE: unique symbol;
const metadataSafeEvaluators = new WeakSet<ExactCapabilityEvaluator>();

export type MetadataSafeCapabilityEvaluator = ExactCapabilityEvaluator & {
  readonly [METADATA_SAFE_EVALUATOR_TYPE]: never;
};

export type TOTPSummaryCapability = Extract<Capability, `totp.${string}`>;
export type MetadataOnlyTOTPCapabilityEvaluator = (
  principal: Principal,
  capability: TOTPSummaryCapability,
  context: MetadataCapabilityContext
) => Promise<EvaluationResult>;

/**
 * Separates generic policy evaluation from a dedicated metadata-only TOTP evaluator. Every TOTP
 * summary capability is routed to `evaluateTOTPMetadata`; the generic evaluator is never invoked
 * for a TOTP target and therefore may safely remain value-aware for non-metadata use cases.
 */
export function createMetadataSafeCapabilityEvaluator(
  baseEvaluate: ExactCapabilityEvaluator,
  evaluateTOTPMetadata: MetadataOnlyTOTPCapabilityEvaluator
): MetadataSafeCapabilityEvaluator {
  const evaluate: ExactCapabilityEvaluator = async (principal, capability, context) => {
    if (capability.startsWith('totp.') || context.totpAccountId !== undefined) {
      if (!capability.startsWith('totp.')) {
        throw new MetadataContractError('A TOTP metadata target cannot evaluate non-TOTP power.');
      }
      return evaluateTOTPMetadata(principal, capability as TOTPSummaryCapability, context);
    }
    return baseEvaluate(principal, capability, context);
  };
  const wrapper = Object.freeze(evaluate);
  metadataSafeEvaluators.add(wrapper);
  return wrapper as MetadataSafeCapabilityEvaluator;
}

export class MetadataContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataContractError';
  }
}

export class MetadataAuthorizationError extends Error {
  constructor(message = 'The exact object operation is not permitted.') {
    super(message);
    this.name = 'MetadataAuthorizationError';
  }
}

function metadataAuthorizationSubject(principal: Principal): string {
  const validation = validatePrincipal(principal);
  if (!validation.valid)
    throw new MetadataAuthorizationError('Authentication identity is invalid.');
  return authorizationSubjectId(principal);
}

/**
 * Complete #117 capability vocabulary applicable to each existing metadata target.
 *
 * Capabilities are omitted only when their target shape is different from the DTO:
 * global collection operations (`project.create`, `resource.create`), parent collection creation
 * (`environment.create` is represented on Project), subject operations (`audit.own.read`,
 * `token.manage-own`), and grant consumption (`grant.consume`). Child capabilities do not leak
 * into parent summaries unless #117 defines a collection operation on that parent. TOTP has no
 * audit target in #117, so no audit capability can truthfully be evaluated on a TOTP DTO.
 */
export const METADATA_CAPABILITY_SUMMARY_CONTRACT = {
  PROJECT: [
    'project.view',
    'project.update',
    'project.delete',
    'project.transfer',
    'project.members.view',
    'project.members.manage',
    'environment.create',
    'audit.full.read',
    'audit.operational.read',
    'audit.export',
  ],
  ENVIRONMENT: [
    'environment.view',
    'environment.update',
    'environment.delete',
    'audit.full.read',
    'audit.operational.read',
    'audit.export',
  ],
  RESOURCE: [
    'resource.view',
    'resource.policy.manage',
    'resource.delete',
    'resource.api-key.list',
    'resource.api-key.mint',
    'resource.api-key.rotate',
    'resource.api-key.revoke',
    'secret.metadata.read',
    'secret.value.read',
    'secret.write',
    'secret.delete',
    'totp.metadata.read',
    'totp.code.read',
    'totp.link.manage',
    'guardian.view',
    'guardian.context.read',
    'guardian.manage',
    'request.create',
    'request.queue.view',
    'audit.queue.read',
    'audit.export',
  ],
  SECRET: [
    'secret.metadata.read',
    'secret.value.read',
    'secret.write',
    'secret.delete',
    'audit.queue.read',
    'audit.export',
  ],
  TOTP_ACCOUNT: [
    'totp.metadata.read',
    'totp.code.read',
    'totp.recovery.read',
    'totp.link.manage',
    'totp.account.manage',
  ],
  APPROVAL_REQUEST: [
    'request.view-own',
    'request.queue.view',
    'request.decide',
    'request.cancel-own',
    'audit.queue.read',
    'audit.export',
  ],
} as const satisfies Record<MetadataKind, readonly Capability[]>;

export const METADATA_CAPABILITY_EXCLUSIONS = {
  'project.create': 'Global Project collection operation; there is no existing Project target.',
  'resource.create': 'Global Resource collection operation; there is no existing Resource target.',
  'grant.consume': 'Approval Grant operation; grant metadata is not one of these DTO targets.',
  'audit.own.read': 'Authenticated Subject operation; it is not an object metadata capability.',
  'token.manage-own': 'Authenticated Subject operation; it is not an object metadata capability.',
} as const satisfies Partial<Record<Capability, string>>;

type SummarizedCapability = (typeof METADATA_CAPABILITY_SUMMARY_CONTRACT)[MetadataKind][number];
type ReconciledCapability = SummarizedCapability | keyof typeof METADATA_CAPABILITY_EXCLUSIONS;
type UnreconciledCapability = Exclude<Capability, ReconciledCapability>;

// Adding a #117 capability requires placing it on an exact DTO target or documenting its exclusion.
const CAPABILITY_RECONCILIATION_IS_EXHAUSTIVE: UnreconciledCapability extends never ? true : never =
  true;
void CAPABILITY_RECONCILIATION_IS_EXHAUSTIVE;

const PRIMARY_CAPABILITIES = {
  PROJECT: ['project.view'],
  ENVIRONMENT: ['environment.view'],
  RESOURCE: ['resource.view'],
  SECRET: ['secret.metadata.read'],
  TOTP_ACCOUNT: ['totp.metadata.read'],
  APPROVAL_REQUEST: ['request.view-own', 'request.queue.view'],
} as const satisfies Record<MetadataKind, readonly Capability[]>;

interface AuthorizedRecord<T> {
  record: T;
  capabilities: ExactCapabilitySummaryDTO;
}

interface CursorPayload {
  version: 1;
  kind: MetadataKind;
  filterKey: string;
  sortKey: string;
  id: string;
}

function expectedPolicyTarget(context: CapabilityContext): PolicyTarget {
  if (context.grantId) return { type: 'APPROVAL_GRANT', id: context.grantId };
  if (context.resourceId && context.fieldName) {
    return { type: 'SECRET', resourceId: context.resourceId, key: context.fieldName };
  }
  if (context.requestId) return { type: 'APPROVAL_REQUEST', id: context.requestId };
  if (context.totpAccountId) return { type: 'TOTP_ACCOUNT', id: context.totpAccountId };
  if (context.resourceId) return { type: 'RESOURCE', id: context.resourceId };
  if (context.environmentId) return { type: 'ENVIRONMENT', id: context.environmentId };
  if (context.projectId) return { type: 'PROJECT', id: context.projectId };
  if (context.subjectId) return { type: 'SUBJECT', id: context.subjectId };
  return { type: 'GLOBAL' };
}

function samePolicyTarget(left: PolicyTarget, right: PolicyTarget): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case 'SECRET':
      return (
        right.type === 'SECRET' && left.resourceId === right.resourceId && left.key === right.key
      );
    case 'GLOBAL':
      return right.type === 'GLOBAL';
    default:
      return right.type === left.type && left.id === right.id;
  }
}

function normalizeSortKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function compareTuple(
  left: Pick<CursorPayload, 'sortKey' | 'id'>,
  right: Pick<CursorPayload, 'sortKey' | 'id'>
): number {
  const sortComparison = Buffer.compare(
    Buffer.from(left.sortKey, 'utf8'),
    Buffer.from(right.sortKey, 'utf8')
  );
  return sortComparison !== 0
    ? sortComparison
    : Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8'));
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, kind: MetadataKind, filterKey: string): CursorPayload {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('kind' in parsed) ||
      parsed.kind !== kind ||
      !('filterKey' in parsed) ||
      parsed.filterKey !== filterKey ||
      !('sortKey' in parsed) ||
      typeof parsed.sortKey !== 'string' ||
      !('id' in parsed) ||
      typeof parsed.id !== 'string' ||
      !parsed.id
    ) {
      throw new Error('invalid cursor payload');
    }
    return parsed as CursorPayload;
  } catch {
    throw new MetadataContractError('Invalid metadata cursor.');
  }
}

interface NormalizedMetadataQuery {
  limit: number;
  filter: string;
  cursor: CursorPayload | null;
}

function normalizeQuery(kind: MetadataKind, query: MetadataQuery): NormalizedMetadataQuery {
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new MetadataContractError(`Metadata page limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  if (query.filter !== undefined && typeof query.filter !== 'string') {
    throw new MetadataContractError('Metadata filter must be a string.');
  }
  if (query.filter !== undefined && query.filter.length > MAX_FILTER_LENGTH) {
    throw new MetadataContractError(
      `Metadata filter must not exceed ${MAX_FILTER_LENGTH} characters.`
    );
  }
  if (query.cursor !== undefined && typeof query.cursor !== 'string') {
    throw new MetadataContractError('Metadata cursor must be a string.');
  }
  if (query.cursor !== undefined && !query.cursor) {
    throw new MetadataContractError('Metadata cursor must not be empty.');
  }
  if (query.cursor !== undefined && Buffer.byteLength(query.cursor, 'utf8') > MAX_CURSOR_LENGTH) {
    throw new MetadataContractError(`Metadata cursor must not exceed ${MAX_CURSOR_LENGTH} bytes.`);
  }
  const filter = normalizeSortKey(query.filter?.trim() ?? '');
  const cursor = query.cursor ? decodeCursor(query.cursor, kind, filter) : null;
  return { limit, filter, cursor };
}

function candidateTuple<T>(
  record: T,
  getId: (record: T) => string,
  getSearchText: (record: T) => string
): Pick<CursorPayload, 'sortKey' | 'id'> {
  return { id: getId(record), sortKey: normalizeSortKey(getSearchText(record)) };
}

async function collectAuthorized<TSource, TAuthorized = TSource>(
  query: NormalizedMetadataQuery,
  fetch: (criteria: SubjectBoundMetadataCriteria) => Promise<TSource[]>,
  getId: (record: TSource) => string,
  getSearchText: (record: TSource) => string,
  authorize: (record: TSource) => Promise<AuthorizedRecord<TAuthorized> | null>
): Promise<AuthorizedRecord<TAuthorized>[]> {
  const authorized: AuthorizedRecord<TAuthorized>[] = [];
  const batchLimit = query.limit + 1;
  let after = query.cursor ? { sortKey: query.cursor.sortKey, id: query.cursor.id } : null;

  while (authorized.length <= query.limit) {
    const criteria: SubjectBoundMetadataCriteria = {
      limit: batchLimit,
      filter: query.filter,
      after,
    };
    const candidates = await fetch(criteria);
    if (candidates.length > batchLimit) {
      throw new MetadataContractError('Metadata source exceeded the requested candidate limit.');
    }

    let previous = after;
    for (const record of candidates) {
      const tuple = candidateTuple(record, getId, getSearchText);
      if (
        !tuple.id ||
        (query.filter && !tuple.sortKey.includes(query.filter)) ||
        (previous !== null && compareTuple(tuple, previous) <= 0)
      ) {
        throw new MetadataContractError(
          'Metadata source returned candidates outside the requested filter or cursor order.'
        );
      }
      previous = tuple;
      const item = await authorize(record);
      if (item) authorized.push(item);
    }

    if (candidates.length < batchLimit || candidates.length === 0) break;
    after = previous;
  }

  return authorized;
}

function paginate<T, TDTO>(
  kind: MetadataKind,
  authorized: AuthorizedRecord<T>[],
  query: NormalizedMetadataQuery,
  getId: (record: T) => string,
  getSearchText: (record: T) => string,
  toDTO: (item: AuthorizedRecord<T>) => TDTO
): MetadataPage<TDTO> {
  const seen = new Set<string>();
  const rows = authorized
    .map((item) => {
      const id = getId(item.record);
      if (!id || seen.has(id)) {
        throw new MetadataContractError('Metadata projection contains a missing or duplicate ID.');
      }
      seen.add(id);
      return {
        item,
        id,
        sortKey: normalizeSortKey(getSearchText(item.record)),
      };
    })
    .filter((row) => !query.filter || row.sortKey.includes(query.filter))
    .sort(compareTuple);

  const afterCursor = query.cursor
    ? rows.filter((row) => compareTuple(row, query.cursor as CursorPayload) > 0)
    : rows;
  const selected = afterCursor.slice(0, query.limit);
  const hasMore = afterCursor.length > selected.length;
  const last = selected.at(-1);

  return {
    items: selected.map((row) => toDTO(row.item)),
    nextCursor:
      hasMore && last
        ? encodeCursor({
            version: 1,
            kind,
            filterKey: query.filter,
            sortKey: last.sortKey,
            id: last.id,
          })
        : null,
    cachePolicy: SUBJECT_BOUND_METADATA_CACHE_POLICY,
  };
}

async function authorizeRecord<T>(
  principal: Principal,
  kind: MetadataKind,
  record: T,
  context: MetadataCapabilityContext,
  evaluate: ExactCapabilityEvaluator
): Promise<AuthorizedRecord<T> | null> {
  const decisions: CapabilityDecisionDTO[] = [];
  let primaryAllowed = false;
  const target = expectedPolicyTarget(context);

  for (const capability of METADATA_CAPABILITY_SUMMARY_CONTRACT[kind]) {
    const result = await evaluate(principal, capability, context);
    validateEvaluationResult(result, capability, target);
    decisions.push({
      capability,
      allowed: result.allowed,
      decisionCode: result.decisionCode,
      reasonCode: result.reasonCode,
      authoritySources: [...result.authoritySources],
      safeExplanation: result.safeExplanation,
      ...(result.approvalRequestId ? { approvalRequestId: result.approvalRequestId } : {}),
      ...(result.grantId ? { grantId: result.grantId } : {}),
    });
    if (PRIMARY_CAPABILITIES[kind].some((primary) => primary === capability) && result.allowed) {
      primaryAllowed = true;
    }
  }

  if (!primaryAllowed) return null;

  return {
    record,
    capabilities: { target, decisions },
  };
}

function validateEvaluationResult(
  result: EvaluationResult,
  capability: Capability,
  target: PolicyTarget
): void {
  if (result.capability !== capability) {
    throw new MetadataContractError('Capability evaluator returned a mismatched capability.');
  }
  if (!samePolicyTarget(result.target, target)) {
    throw new MetadataContractError('Capability evaluator returned a mismatched target.');
  }
  if (
    (result.allowed && result.decisionCode !== 'ALLOW') ||
    (!result.allowed && result.decisionCode === 'ALLOW')
  ) {
    throw new MetadataContractError(
      'Capability evaluator returned contradictory allowed and decisionCode values.'
    );
  }
}

function validateRequestMetadata(record: RequestMetadataRecord): void {
  const target = record.target as RequestTargetMetadataRecord & Record<string, unknown>;
  const sharedInvalid =
    record.resourceId !== target.resourceId ||
    typeof target.resourceId !== 'string' ||
    target.resourceId.trim().length === 0 ||
    typeof target.targetVersion !== 'string' ||
    target.targetVersion.trim().length === 0 ||
    (record.grant !== null && record.grant.requestId !== record.id);
  let targetInvalid = false;

  switch (target.kind) {
    case 'SECRET':
      targetInvalid =
        record.action !== 'secret.value.read' ||
        typeof target.targetKey !== 'string' ||
        target.targetKey.length === 0 ||
        'totpAccountId' in target;
      break;
    case 'RESOURCE':
      targetInvalid =
        record.action !== 'resource.view' || 'targetKey' in target || 'totpAccountId' in target;
      break;
    case 'TOTP_ACCOUNT':
      targetInvalid =
        record.action !== 'totp.code.read' ||
        typeof target.totpAccountId !== 'string' ||
        target.totpAccountId.length === 0 ||
        'targetKey' in target;
      break;
    default:
      targetInvalid = true;
  }

  if (sharedInvalid || targetInvalid) {
    throw new MetadataContractError('Request metadata contains an inconsistent exact target.');
  }
}

function projectRequestTarget(target: RequestTargetMetadataRecord): RequestTargetMetadataRecord {
  switch (target.kind) {
    case 'SECRET':
      return {
        kind: 'SECRET',
        resourceId: target.resourceId,
        targetKey: target.targetKey,
        targetVersion: target.targetVersion,
      };
    case 'RESOURCE':
      return {
        kind: 'RESOURCE',
        resourceId: target.resourceId,
        targetVersion: target.targetVersion,
      };
    case 'TOTP_ACCOUNT':
      return {
        kind: 'TOTP_ACCOUNT',
        resourceId: target.resourceId,
        totpAccountId: target.totpAccountId,
        targetVersion: target.targetVersion,
      };
  }
}

export class MetadataQueryService {
  constructor(
    private readonly source: RelationshipSafeMetadataSource,
    private readonly evaluate: MetadataSafeCapabilityEvaluator
  ) {
    if (!relationshipSafeSources.has(source)) {
      throw new MetadataContractError('Metadata queries require a relationship-safe source.');
    }
    if (!metadataSafeEvaluators.has(evaluate)) {
      throw new MetadataContractError('Metadata queries require a metadata-safe evaluator.');
    }
  }

  async listProjects(
    principal: Principal,
    query: MetadataQuery = {}
  ): Promise<MetadataPage<ProjectMetadataDTO>> {
    const normalized = normalizeQuery('PROJECT', query);
    const subjectId = metadataAuthorizationSubject(principal);
    const authorized = await collectAuthorized(
      normalized,
      (criteria) => this.source.listProjectCandidates(subjectId, criteria),
      (record: ProjectMetadataRecord) => record.id,
      (record) => record.name,
      (record) =>
        authorizeRecord(principal, 'PROJECT', record, { projectId: record.id }, this.evaluate)
    );
    return paginate(
      'PROJECT',
      authorized,
      normalized,
      (record) => record.id,
      (record) => record.name,
      ({ record, capabilities }): ProjectMetadataDTO => ({
        kind: 'PROJECT',
        id: record.id,
        name: record.name,
        description: record.description,
        policyVersion: record.policyVersion,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        capabilities,
      })
    );
  }

  async listEnvironments(
    principal: Principal,
    query: MetadataQuery = {}
  ): Promise<MetadataPage<EnvironmentMetadataDTO>> {
    const normalized = normalizeQuery('ENVIRONMENT', query);
    const subjectId = metadataAuthorizationSubject(principal);
    const authorized = await collectAuthorized(
      normalized,
      (criteria) => this.source.listEnvironmentCandidates(subjectId, criteria),
      (record: EnvironmentMetadataRecord) => record.id,
      (record) => `${record.name}\u0000${record.slug}`,
      (record) =>
        authorizeRecord(
          principal,
          'ENVIRONMENT',
          record,
          { projectId: record.projectId, environmentId: record.id },
          this.evaluate
        )
    );
    return paginate(
      'ENVIRONMENT',
      authorized,
      normalized,
      (record) => record.id,
      (record) => `${record.name}\u0000${record.slug}`,
      ({ record, capabilities }): EnvironmentMetadataDTO => ({
        kind: 'ENVIRONMENT',
        id: record.id,
        projectId: record.projectId,
        ...(record.resourceId ? { resourceId: record.resourceId } : {}),
        name: record.name,
        slug: record.slug,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        capabilities,
      })
    );
  }

  async listResources(
    principal: Principal,
    query: MetadataQuery = {}
  ): Promise<MetadataPage<ResourceMetadataDTO>> {
    const normalized = normalizeQuery('RESOURCE', query);
    const subjectId = metadataAuthorizationSubject(principal);
    const authorized = await collectAuthorized(
      normalized,
      (criteria) => this.source.listResourceCandidates(subjectId, criteria),
      (record: ResourceMetadataRecord) => record.id,
      (record) => record.name,
      (record) =>
        authorizeRecord(
          principal,
          'RESOURCE',
          record,
          {
            projectId: record.projectId,
            environmentId: record.environmentId,
            resourceId: record.id,
          },
          this.evaluate
        )
    );
    return paginate(
      'RESOURCE',
      authorized,
      normalized,
      (record) => record.id,
      (record) => record.name,
      ({ record, capabilities }): ResourceMetadataDTO => ({
        kind: 'RESOURCE',
        id: record.id,
        ...(record.projectId ? { projectId: record.projectId } : {}),
        ...(record.environmentId ? { environmentId: record.environmentId } : {}),
        name: record.name,
        mode: record.mode,
        version: record.version,
        createdAt: record.createdAt,
        capabilities,
      })
    );
  }

  async listSecrets(
    principal: Principal,
    query: MetadataQuery = {}
  ): Promise<MetadataPage<SecretMetadataDTO>> {
    const normalized = normalizeQuery('SECRET', query);
    const subjectId = metadataAuthorizationSubject(principal);
    const authorized = await collectAuthorized(
      normalized,
      (criteria) => this.source.listSecretCandidates(subjectId, criteria),
      (record: SecretMetadataRecord) => record.id,
      (record) => record.key,
      (record) =>
        authorizeRecord(
          principal,
          'SECRET',
          record,
          {
            projectId: record.projectId,
            environmentId: record.environmentId,
            resourceId: record.resourceId,
            requestId: record.requestId,
            fieldName: record.key,
            targetVersion: record.version,
          },
          this.evaluate
        )
    );
    return paginate(
      'SECRET',
      authorized,
      normalized,
      (record) => record.id,
      (record) => record.key,
      ({ record, capabilities }): SecretMetadataDTO => ({
        kind: 'SECRET',
        id: record.id,
        ...(record.projectId ? { projectId: record.projectId } : {}),
        ...(record.environmentId ? { environmentId: record.environmentId } : {}),
        resourceId: record.resourceId,
        key: record.key,
        version: record.version,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        capabilities,
      })
    );
  }

  async listTOTPAccounts(
    principal: Principal,
    query: MetadataQuery = {}
  ): Promise<MetadataPage<TOTPMetadataDTO>> {
    const normalized = normalizeQuery('TOTP_ACCOUNT', query);
    const subjectId = metadataAuthorizationSubject(principal);
    interface TieredTOTPRecord {
      metadata: TOTPMetadataRecord;
      detailed: boolean;
    }
    const authorized = await collectAuthorized<TOTPMetadataRecord, TieredTOTPRecord>(
      normalized,
      (criteria) => this.source.listTOTPCandidates(subjectId, criteria),
      (record: TOTPMetadataRecord) => (record.scope === 'LINKED' ? record.resourceId : record.id),
      (record) => (record.scope === 'LINKED' ? record.resourceId : record.id),
      async (record) => {
        const accountAuthorization = await authorizeRecord(
          principal,
          'TOTP_ACCOUNT',
          record,
          {
            projectId: record.scope === 'LINKED' ? record.projectId : undefined,
            environmentId: record.scope === 'LINKED' ? record.environmentId : undefined,
            resourceId: record.scope === 'LINKED' ? record.resourceId : undefined,
            totpAccountId: record.id,
            targetVersion: record.accountVersion,
            accountVersion: record.accountVersion,
            linkVersion: record.scope === 'LINKED' ? record.linkVersion : undefined,
          },
          this.evaluate
        );
        if (!accountAuthorization) return null;

        const metadataRead = accountAuthorization.capabilities.decisions.find(
          (decision) => decision.capability === 'totp.metadata.read'
        );
        const detailed =
          metadataRead?.allowed === true &&
          metadataRead.decisionCode === 'ALLOW' &&
          metadataRead.authoritySources.some((source) =>
            ['TOTP_OWNER', 'PROJECT_OWNER', 'RESOURCE_OWNER'].includes(source)
          );
        if (record.scope === 'PERSONAL') {
          return detailed
            ? {
                record: { metadata: record, detailed },
                capabilities: accountAuthorization.capabilities,
              }
            : null;
        }
        if (detailed) {
          return {
            record: { metadata: record, detailed },
            capabilities: accountAuthorization.capabilities,
          };
        }

        const resourceAuthorization = await authorizeRecord(
          principal,
          'RESOURCE',
          record,
          {
            projectId: record.projectId,
            environmentId: record.environmentId,
            resourceId: record.resourceId,
            targetVersion: record.resourceVersion,
          },
          this.evaluate
        );
        return resourceAuthorization
          ? {
              record: { metadata: record, detailed },
              capabilities: resourceAuthorization.capabilities,
            }
          : null;
      }
    );
    return paginate(
      'TOTP_ACCOUNT',
      authorized,
      normalized,
      ({ metadata }) => (metadata.scope === 'LINKED' ? metadata.resourceId : metadata.id),
      ({ metadata }) => (metadata.scope === 'LINKED' ? metadata.resourceId : metadata.id),
      ({ record: { metadata, detailed }, capabilities }): TOTPMetadataDTO => {
        if (!detailed && metadata.scope === 'LINKED') {
          return {
            kind: 'TOTP_LINK_STATUS',
            scope: 'LINKED',
            resourceId: metadata.resourceId,
            linked: true,
            capabilities,
          };
        }
        if (metadata.scope === 'PERSONAL') {
          return {
            kind: 'TOTP_ACCOUNT',
            scope: 'PERSONAL',
            id: metadata.id,
            accountName: metadata.accountName,
            issuer: metadata.issuer,
            accountVersion: metadata.accountVersion,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
            capabilities,
          };
        }
        return {
          kind: 'TOTP_ACCOUNT',
          scope: 'LINKED',
          id: metadata.id,
          ...(metadata.projectId ? { projectId: metadata.projectId } : {}),
          ...(metadata.environmentId ? { environmentId: metadata.environmentId } : {}),
          resourceId: metadata.resourceId,
          linked: true,
          accountName: metadata.accountName,
          issuer: metadata.issuer,
          accountVersion: metadata.accountVersion,
          linkVersion: metadata.linkVersion,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          capabilities,
        };
      }
    );
  }

  async listRequests(
    principal: Principal,
    query: MetadataQuery = {}
  ): Promise<MetadataPage<RequestMetadataDTO>> {
    const normalized = normalizeQuery('APPROVAL_REQUEST', query);
    const subjectId = metadataAuthorizationSubject(principal);
    const authorized = await collectAuthorized(
      normalized,
      (criteria) => this.source.listRequestCandidates(subjectId, criteria),
      (record: RequestMetadataRecord) => record.id,
      (record) => `${record.createdAt.toISOString()}\u0000${record.id}`,
      (record) => {
        validateRequestMetadata(record);
        return authorizeRecord(
          principal,
          'APPROVAL_REQUEST',
          record,
          {
            projectId: record.projectId,
            environmentId: record.environmentId,
            resourceId: record.resourceId,
            requestId: record.id,
            action: record.action,
            targetVersion: record.target.targetVersion,
            policyVersion: record.policyVersion,
          },
          this.evaluate
        );
      }
    );
    return paginate(
      'APPROVAL_REQUEST',
      authorized,
      normalized,
      (record) => record.id,
      (record) => `${record.createdAt.toISOString()}\u0000${record.id}`,
      ({ record, capabilities }): RequestMetadataDTO => ({
        kind: 'APPROVAL_REQUEST',
        id: record.id,
        ...(record.projectId ? { projectId: record.projectId } : {}),
        ...(record.environmentId ? { environmentId: record.environmentId } : {}),
        resourceId: record.resourceId,
        status: record.status,
        action: record.action,
        target: projectRequestTarget(record.target),
        grant: record.grant
          ? {
              id: record.grant.id,
              requestId: record.grant.requestId,
              expiresAt: record.grant.expiresAt,
              consumedAt: record.grant.consumedAt,
              revokedAt: record.grant.revokedAt,
            }
          : null,
        policyVersion: record.policyVersion,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        capabilities,
      })
    );
  }
}

function compareCanonicalKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function canonicalizeSecretKeys(keys: readonly string[]): string[] {
  if (keys.length < 1 || keys.length > MAX_SECRET_KEYS) {
    throw new MetadataContractError(`Secret key sets must contain 1 to ${MAX_SECRET_KEYS} keys.`);
  }

  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const key of keys) {
    if (
      !key ||
      key.trim() !== key ||
      key.normalize('NFC') !== key ||
      Buffer.byteLength(key, 'utf8') > MAX_SECRET_KEY_BYTES ||
      [...key].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      })
    ) {
      throw new MetadataContractError('Secret keys must use canonical, non-empty UTF-8 names.');
    }
    if (seen.has(key)) {
      throw new MetadataContractError('Secret key sets cannot contain duplicates.');
    }
    seen.add(key);
    canonical.push(key);
  }
  return canonical.sort(compareCanonicalKeys);
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

export function digestCanonicalSecretKeySet(canonicalKeys: readonly string[]): string {
  const verified = canonicalizeSecretKeys(canonicalKeys);
  if (verified.some((key, index) => key !== canonicalKeys[index])) {
    throw new MetadataContractError('Secret key digest input must already be canonical.');
  }

  const hash = createHash('sha256');
  updateLengthPrefixed(hash, KEY_SET_DIGEST_DOMAIN);
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(verified.length);
  hash.update(count);
  for (const key of verified) updateLengthPrefixed(hash, key);
  return `sha256:${hash.digest('hex')}`;
}

export interface EncryptedSecretRecord {
  key: string;
  encryptedValue: string;
  targetVersion: string;
}

export interface ExactSecretSelection {
  resourceId: string;
  canonicalKeys: readonly string[];
  targetVersion: string;
}

/**
 * This reveal-only port requires storage-side equality/IN selection on canonicalKeys. An adapter
 * must never hydrate or decrypt a resource's complete field set and filter it afterwards.
 */
export interface ExactSecretValueSource {
  selectEncryptedByCanonicalKeys(selection: ExactSecretSelection): Promise<EncryptedSecretRecord[]>;
}

export type SecretDecryptor = (
  encryptedValue: string,
  context: { resourceId: string; key: string; targetVersion: string }
) => Promise<string>;

export interface ExactSecretRevealInput {
  projectId?: string;
  environmentId?: string;
  resourceId: string;
  targetVersion: string;
  keys: readonly string[];
}

export interface ExactSecretRevealResult {
  values: Readonly<Record<string, string>>;
  canonicalKeys: readonly string[];
  keySetDigest: string;
}

export class ExactSecretRevealService {
  constructor(
    private readonly source: ExactSecretValueSource,
    private readonly decrypt: SecretDecryptor,
    private readonly evaluate: ExactCapabilityEvaluator
  ) {}

  async reveal(
    principal: Principal,
    input: ExactSecretRevealInput
  ): Promise<ExactSecretRevealResult> {
    const canonicalKeys = canonicalizeSecretKeys(input.keys);

    // Authorize the complete exact set before the repository can select ciphertext.
    for (const key of canonicalKeys) {
      const decision = await this.evaluate(principal, 'secret.value.read', {
        projectId: input.projectId,
        environmentId: input.environmentId,
        resourceId: input.resourceId,
        fieldName: key,
        targetVersion: input.targetVersion,
      });
      const exactTarget: PolicyTarget = { type: 'SECRET', resourceId: input.resourceId, key };
      validateEvaluationResult(decision, 'secret.value.read', exactTarget);
      if (!(decision.allowed === true && decision.decisionCode === 'ALLOW')) {
        throw new MetadataAuthorizationError();
      }
    }

    const selected = await this.source.selectEncryptedByCanonicalKeys({
      resourceId: input.resourceId,
      canonicalKeys,
      targetVersion: input.targetVersion,
    });
    const selectedByKey = new Map<string, EncryptedSecretRecord>();
    for (const row of selected) {
      if (
        !canonicalKeys.includes(row.key) ||
        row.targetVersion !== input.targetVersion ||
        selectedByKey.has(row.key)
      ) {
        throw new MetadataContractError('Secret selection returned an inexact key set.');
      }
      selectedByKey.set(row.key, row);
    }
    if (selectedByKey.size !== canonicalKeys.length) {
      throw new MetadataContractError(
        'Secret selection did not return the complete exact key set.'
      );
    }

    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const key of canonicalKeys) {
      const row = selectedByKey.get(key);
      if (!row) {
        throw new MetadataContractError(
          'Secret selection did not return the complete exact key set.'
        );
      }
      values[key] = await this.decrypt(row.encryptedValue, {
        resourceId: input.resourceId,
        key,
        targetVersion: input.targetVersion,
      });
    }

    return {
      values: Object.freeze(values),
      canonicalKeys: Object.freeze([...canonicalKeys]),
      keySetDigest: digestCanonicalSecretKeySet(canonicalKeys),
    };
  }
}
