import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { loadAuditSecurityConfig, type AuditSecurityConfig } from '../config/auditSecurity.js';
import {
  correlationStorage,
  createCorrelationId,
  requireValidCorrelationId,
} from '../logging/correlationContext.js';
import { logger } from '../logging/logger.js';
import type {
  AuditEventFamily,
  AuditCheckpoint,
  AuditLog,
  AuditMetadata,
  AuditOutcomeCode,
  AuditRetentionClass,
  AuditSurface,
  AuditTargetType,
  AuthoritySource,
  AuthKind,
  Capability,
  CreateAuditLogInput,
  CreateOutboxEventInput,
  DecisionCode,
  Principal,
  PrincipalType,
  ReasonCode,
  OutboxEvent,
} from './models.js';
import { hasCapability } from './policy.js';
import type { Repositories } from './repositories.js';

type SafePayloadValue = string | number | boolean | null;
type SafeAuditPayload = Partial<
  Record<
    | 'route'
    | 'projection'
    | 'exported'
    | 'credentialId'
    | 'throttled'
    | 'legacy'
    | 'deletedCount'
    | 'attempt'
    | 'errorCode'
    | 'terminal'
    | 'deliveryType'
    | 'result'
    | 'slug'
    | 'memberUserId'
    | 'role'
    | 'action'
    | 'targetKey'
    | 'targetVersion'
    | 'policyVersion'
    | 'expiresAt'
    | 'decision'
    | 'requesterId'
    | 'expiredCount'
    | 'guardianId'
    | 'totpAccountId'
    | 'consentId'
    | 'accountName'
    | 'issuerPresent'
    | 'backupKeyConfigured'
    | 'fieldName'
    | 'reason'
    | 'priorDigest',
    SafePayloadValue
  >
>;

/** Stable current-surface vocabulary. New event types require an explicit family review. */
export const AUDIT_EVENT_CATALOG = {
  AUTH_LOGIN: 'AUTHENTICATION',
  AUTH_SESSION_INITIATE: 'AUTHENTICATION',
  AUTH_SESSION_APPROVE: 'AUTHENTICATION',
  AUTH_SESSION_EXCHANGE: 'AUTHENTICATION',
  AUTH_SESSION_EXPIRE: 'AUTHENTICATION',
  AUTH_SESSION_CLEANUP: 'AUTHENTICATION',
  CREDENTIAL_USE: 'AUTHENTICATION',
  SERVICE_CREDENTIAL_MINT: 'AUTHENTICATION',
  API_KEY_MINT: 'AUTHENTICATION',
  API_KEY_REVOKE: 'AUTHENTICATION',
  PROJECT_CREATE: 'PROJECT_MEMBERSHIP',
  PROJECT_UPDATE: 'PROJECT_MEMBERSHIP',
  PROJECT_DELETE: 'PROJECT_MEMBERSHIP',
  PROJECT_MEMBER_ADD: 'PROJECT_MEMBERSHIP',
  PROJECT_MEMBER_REMOVE: 'PROJECT_MEMBERSHIP',
  ENVIRONMENT_CREATE: 'RESOURCE_CONFIGURATION',
  ENVIRONMENT_UPDATE: 'RESOURCE_CONFIGURATION',
  ENVIRONMENT_DELETE: 'RESOURCE_CONFIGURATION',
  RESOURCE_CREATE: 'RESOURCE_CONFIGURATION',
  RESOURCE_UPDATE: 'RESOURCE_CONFIGURATION',
  RESOURCE_DELETE: 'RESOURCE_CONFIGURATION',
  CALLBACK_REGISTER: 'RESOURCE_CONFIGURATION',
  CALLBACK_DELETE: 'RESOURCE_CONFIGURATION',
  AUTHORIZATION_DECISION: 'AUTHORIZATION',
  SECRET_CREATE: 'SECRET_LIFECYCLE',
  SECRET_UPDATE: 'SECRET_LIFECYCLE',
  SECRET_DELETE: 'SECRET_LIFECYCLE',
  SECRET_REVEAL: 'SECRET_LIFECYCLE',
  SECRET_REVEAL_DENIED: 'AUTHORIZATION',
  TOTP_LINK: 'TOTP_LIFECYCLE',
  TOTP_UNLINK: 'TOTP_LIFECYCLE',
  TOTP_ACCOUNT_CREATE: 'TOTP_LIFECYCLE',
  TOTP_ACCOUNT_UPDATE: 'TOTP_LIFECYCLE',
  TOTP_CODE_REVEAL: 'TOTP_LIFECYCLE',
  TOTP_RECOVERY_REVEAL: 'TOTP_LIFECYCLE',
  TOTP_ACCESS_THROTTLED: 'AUTHORIZATION',
  TOTP_REVEAL_DENIED: 'AUTHORIZATION',
  REQUEST_CREATE: 'REQUEST_GRANT_LIFECYCLE',
  REQUEST_EXPIRE: 'REQUEST_GRANT_LIFECYCLE',
  REQUEST_EXPIRY_SWEEP: 'REQUEST_GRANT_LIFECYCLE',
  APPROVAL_DECISION: 'REQUEST_GRANT_LIFECYCLE',
  GRANT_ISSUE: 'REQUEST_GRANT_LIFECYCLE',
  GRANT_CONSUME: 'REQUEST_GRANT_LIFECYCLE',
  GRANT_REVOKE: 'REQUEST_GRANT_LIFECYCLE',
  DELIVERY_ENQUEUE: 'DELIVERY',
  DELIVERY_ATTEMPT: 'DELIVERY',
  DELIVERY_OUTCOME: 'DELIVERY',
  AUDIT_READ: 'AUDIT_ACCESS',
  AUDIT_EXPORT: 'AUDIT_ACCESS',
  PRIVACY_PSEUDONYMIZE: 'AUDIT_ACCESS',
} as const satisfies Record<string, AuditEventFamily>;
export type AuditEventType = keyof typeof AUDIT_EVENT_CATALOG;

const keys = <T extends Array<keyof SafeAuditPayload>>(...values: T): T => values;
const NONE = keys();

const PAYLOAD_FIELDS_BY_EVENT = {
  AUTH_LOGIN: NONE,
  AUTH_SESSION_INITIATE: NONE,
  AUTH_SESSION_APPROVE: NONE,
  AUTH_SESSION_EXCHANGE: keys('credentialId'),
  AUTH_SESSION_EXPIRE: keys('throttled'),
  AUTH_SESSION_CLEANUP: keys('deletedCount'),
  CREDENTIAL_USE: keys('credentialId', 'legacy', 'throttled'),
  SERVICE_CREDENTIAL_MINT: keys('credentialId'),
  API_KEY_MINT: keys('credentialId'),
  API_KEY_REVOKE: keys('credentialId'),
  PROJECT_CREATE: NONE,
  PROJECT_UPDATE: NONE,
  PROJECT_DELETE: NONE,
  PROJECT_MEMBER_ADD: keys('memberUserId', 'role', 'guardianId'),
  PROJECT_MEMBER_REMOVE: keys('memberUserId'),
  ENVIRONMENT_CREATE: keys('slug'),
  ENVIRONMENT_UPDATE: keys('slug'),
  ENVIRONMENT_DELETE: NONE,
  RESOURCE_CREATE: NONE,
  RESOURCE_UPDATE: keys('guardianId', 'memberUserId'),
  RESOURCE_DELETE: NONE,
  CALLBACK_REGISTER: NONE,
  CALLBACK_DELETE: NONE,
  AUTHORIZATION_DECISION: keys('route', 'projection', 'reason', 'fieldName'),
  SECRET_CREATE: keys('fieldName'),
  SECRET_UPDATE: keys('fieldName'),
  SECRET_DELETE: keys('fieldName'),
  SECRET_REVEAL: keys('fieldName', 'projection'),
  SECRET_REVEAL_DENIED: keys('fieldName', 'reason'),
  TOTP_LINK: keys('totpAccountId', 'consentId'),
  TOTP_UNLINK: keys('totpAccountId'),
  TOTP_ACCOUNT_CREATE: keys('accountName', 'issuerPresent'),
  TOTP_ACCOUNT_UPDATE: keys('accountName', 'backupKeyConfigured'),
  TOTP_CODE_REVEAL: keys('totpAccountId'),
  TOTP_RECOVERY_REVEAL: keys('totpAccountId'),
  TOTP_ACCESS_THROTTLED: keys('accountName', 'reason'),
  TOTP_REVEAL_DENIED: keys('reason'),
  REQUEST_CREATE: keys('action', 'targetKey', 'targetVersion', 'policyVersion', 'expiresAt'),
  REQUEST_EXPIRE: NONE,
  REQUEST_EXPIRY_SWEEP: keys('expiredCount'),
  APPROVAL_DECISION: keys('decision', 'requesterId'),
  GRANT_ISSUE: NONE,
  GRANT_CONSUME: NONE,
  GRANT_REVOKE: NONE,
  DELIVERY_ENQUEUE: keys('deliveryType'),
  DELIVERY_ATTEMPT: keys('attempt', 'deliveryType'),
  DELIVERY_OUTCOME: keys('attempt', 'deliveryType', 'result', 'errorCode', 'terminal'),
  AUDIT_READ: keys('projection', 'exported'),
  AUDIT_EXPORT: keys('projection', 'exported'),
  PRIVACY_PSEUDONYMIZE: keys('deletedCount', 'priorDigest'),
} as const satisfies Record<AuditEventType, readonly (keyof SafeAuditPayload)[]>;

export type AuditPayloadFor<T extends AuditEventType> = Partial<
  Record<(typeof PAYLOAD_FIELDS_BY_EVENT)[T][number], SafePayloadValue>
>;

/** Build a flat, event-typed metadata object. Unknown or structured input fails closed. */
export function buildAuditPayload<T extends AuditEventType>(
  eventType: T,
  payload?: AuditPayloadFor<T> | null
): AuditMetadata | null {
  if (!payload) return null;
  const allowed = new Set<string>(PAYLOAD_FIELDS_BY_EVENT[eventType]);
  const result: AuditMetadata = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key as keyof SafeAuditPayload)) {
      throw new Error(`Audit payload field is not registered for ${eventType}: ${key}`);
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Audit payload field must be a safe scalar: ${key}`);
    }
    result[key] = value as SafePayloadValue;
  }
  return result;
}

function canonicalize(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function signEnvelope(key: Buffer, envelope: Record<string, unknown>): string {
  return createHmac('sha256', key).update(canonicalize(envelope)).digest('hex');
}

export interface OperationContext {
  correlationId: string;
  causationId: string | null;
}

export function createOperationContext(
  input: {
    correlationId?: string | null;
    causationId?: string | null;
  } = {}
): OperationContext {
  const store = correlationStorage.getStore();
  const correlationId = requireValidCorrelationId(
    input.correlationId ?? store?.correlationId ?? createCorrelationId()
  );
  const inheritedCausation =
    input.causationId === null ? null : (input.causationId ?? store?.causationId ?? null);
  return {
    correlationId,
    causationId: inheritedCausation === null ? null : requireValidCorrelationId(inheritedCausation),
  };
}

export interface AuditEventInput<T extends AuditEventType = AuditEventType> {
  eventFamily: AuditEventFamily;
  eventType: T;
  surface: AuditSurface;
  operation: string;
  outcomeCode: AuditOutcomeCode;
  capability?: Capability | null;
  decisionCode: DecisionCode;
  reasonCode: ReasonCode;
  targetType: AuditTargetType;
  targetId?: string | null;
  authoritySources: AuthoritySource[];
  actorType: PrincipalType;
  principalId: string;
  actorId?: string | null;
  authKind?: AuthKind | null;
  resolverType?: PrincipalType | null;
  resolverId?: string | null;
  resourceId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  requestId?: string | null;
  grantId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  retentionClass?: AuditRetentionClass;
  payload?: AuditPayloadFor<T> | null;
}

export interface AuditScope {
  type: 'PROJECT' | 'RESOURCE' | 'REQUEST' | 'SUBJECT';
  id: string;
}

export interface AuditReadRequest {
  scope: AuditScope;
  projection: 'FULL' | 'OPERATIONAL' | 'QUEUE' | 'OWN';
  export: boolean;
}

function applyProjection(
  events: AuditLog[],
  projection: AuditReadRequest['projection']
): AuditLog[] {
  if (projection === 'FULL' || projection === 'OWN') return events;
  if (projection === 'QUEUE') {
    return events.filter((event) =>
      ['REQUEST_GRANT_LIFECYCLE', 'DELIVERY', 'AUTHORIZATION'].includes(event.eventFamily)
    );
  }
  return events.filter(
    (event) =>
      ['PROJECT_MEMBERSHIP', 'RESOURCE_CONFIGURATION', 'AUTHORIZATION'].includes(
        event.eventFamily
      ) || ['SECRET_CREATE', 'SECRET_UPDATE', 'SECRET_DELETE'].includes(event.eventType)
  );
}

export class AuditService {
  constructor(
    private readonly deps: { repositories: Repositories },
    private readonly config: AuditSecurityConfig = loadAuditSecurityConfig()
  ) {}

  async log<T extends AuditEventType>(
    event: AuditEventInput<T>,
    tx?: Prisma.TransactionClient
  ): Promise<AuditLog> {
    if (AUDIT_EVENT_CATALOG[event.eventType] !== event.eventFamily) {
      throw new Error('Audit event family does not match the registered event type.');
    }
    const context = createOperationContext({
      correlationId: event.correlationId,
      causationId: event.causationId,
    });
    const id = randomUUID();
    const createdAt = new Date();
    const unsigned: Omit<CreateAuditLogInput, 'integrityHash'> = {
      id,
      schemaVersion: 2,
      eventFamily: event.eventFamily,
      eventType: event.eventType,
      surface: event.surface,
      operation: event.operation,
      outcomeCode: event.outcomeCode,
      capability: event.capability ?? null,
      decisionCode: event.decisionCode,
      reasonCode: event.reasonCode,
      targetType: event.targetType,
      targetId: event.targetId ?? null,
      authoritySources: [...event.authoritySources],
      actorType: event.actorType,
      principalId: event.principalId,
      actorId: event.actorId ?? null,
      authKind: event.authKind ?? null,
      resolverType: event.resolverType ?? null,
      resolverId: event.resolverId ?? null,
      resourceId: event.resourceId ?? null,
      projectId: event.projectId ?? null,
      environmentId: event.environmentId ?? null,
      requestId: event.requestId ?? null,
      grantId: event.grantId ?? null,
      correlationId: context.correlationId,
      causationId: context.causationId,
      statusCode: event.statusCode ?? null,
      durationMs: event.durationMs ?? null,
      retentionClass: event.retentionClass ?? 'SECURITY',
      integrityKeyId: this.config.auditIntegrityKeyId,
      payload: buildAuditPayload(event.eventType, event.payload),
      createdAt,
    };
    const integrityHash = signEnvelope(this.config.auditIntegrityKey, unsigned);

    try {
      const created = await this.deps.repositories.audit.create({ ...unsigned, integrityHash }, tx);
      logger.debug('Audit event persisted', {
        eventType: event.eventType,
        targetType: event.targetType,
        targetId: event.targetId,
        correlationId: context.correlationId,
      });
      return created;
    } catch (error) {
      // Never log the rejected event, payload, database statement, or error message. Those values
      // can contain the secret that caused persistence to fail.
      logger.error('Required audit persistence failed', {
        eventType: event.eventType,
        targetType: event.targetType,
        correlationId: context.correlationId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }

  verifyIntegrity(event: AuditLog): boolean {
    if (event.integrityKeyId === 'legacy-unverified') return false;
    const key =
      this.config.auditIntegrityKeys?.get(event.integrityKeyId) ??
      (event.integrityKeyId === this.config.auditIntegrityKeyId
        ? this.config.auditIntegrityKey
        : undefined);
    if (!key) return false;
    const unsigned = Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== 'integrityHash')
    );
    const expected = signEnvelope(key, unsigned);
    const left = Buffer.from(event.integrityHash, 'hex');
    const right = Buffer.from(expected, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  getRetentionCutoff(now = new Date()): Date {
    return new Date(now.getTime() - this.config.retentionDays * 24 * 60 * 60 * 1000);
  }

  shouldCheckpoint(eventCount: number): boolean {
    return eventCount >= this.config.checkpointInterval;
  }

  async createCheckpoint(now = new Date()): Promise<AuditCheckpoint | null> {
    const repository = this.deps.repositories.audit;
    if (
      !repository.findThrough ||
      !repository.createCheckpoint ||
      !repository.findLatestCheckpoint
    ) {
      throw new Error('Audit repository does not provide the durable checkpoint capability.');
    }
    const events = await repository.findThrough(now);
    if (events.length === 0) return null;
    if (events.some((event) => !this.verifyIntegrity(event))) {
      throw new Error('Cannot checkpoint an unverifiable audit event.');
    }
    const previous = await repository.findLatestCheckpoint();
    if (previous && !this.verifyCheckpointSink(previous)) {
      throw new Error('Cannot extend an unverifiable audit checkpoint chain.');
    }
    const last = events.at(-1);
    if (!last) return null;
    const eventDigest = signEnvelope(this.config.auditIntegrityKey, {
      events: events.map(({ id, integrityHash }) => ({ id, integrityHash })),
    });
    const unsigned = {
      id: randomUUID(),
      previousDigest: previous?.checkpointHash ?? null,
      eventDigest,
      integrityKeyId: this.config.auditIntegrityKeyId,
      eventCount: events.length,
      throughId: last.id,
      throughCreatedAt: last.createdAt,
      createdAt: now,
    };
    const checkpoint = {
      ...unsigned,
      checkpointHash: signEnvelope(this.config.auditIntegrityKey, unsigned),
    };
    const persisted = await repository.createCheckpoint(checkpoint);
    if (!this.verifyCheckpointSink(persisted)) {
      throw new Error('Persisted audit checkpoint failed sink verification.');
    }
    return persisted;
  }

  verifyCheckpointSink(checkpoint: AuditCheckpoint): boolean {
    const key =
      this.config.auditIntegrityKeys?.get(checkpoint.integrityKeyId) ??
      (checkpoint.integrityKeyId === this.config.auditIntegrityKeyId
        ? this.config.auditIntegrityKey
        : undefined);
    if (!key) return false;
    const { checkpointHash, ...unsigned } = checkpoint;
    const expected = signEnvelope(key, unsigned);
    const left = Buffer.from(checkpointHash, 'hex');
    const right = Buffer.from(expected, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  /** Checkpoint and verify the deletion boundary before executing configured retention. */
  async executeRetention(now = new Date()): Promise<number> {
    if (
      !this.deps.repositories.audit.deleteRetainedBefore ||
      !this.deps.repositories.audit.countRetainedBefore
    ) {
      throw new Error('Audit repository does not provide the durable retention capability.');
    }
    const cutoff = this.getRetentionCutoff(now);
    if ((await this.deps.repositories.audit.countRetainedBefore(cutoff)) === 0) return 0;
    const checkpoint = await this.createCheckpoint(now);
    if (checkpoint && !this.verifyCheckpointSink(checkpoint)) {
      throw new Error('Audit retention checkpoint verification failed.');
    }
    return this.deps.repositories.audit.deleteRetainedBefore(cutoff);
  }

  /** Runtime maintenance entrypoint used by the application cleanup scheduler. */
  async runMaintenance(now = new Date()): Promise<{ checkpointed: boolean; deleted: number }> {
    const repository = this.deps.repositories.audit;
    if (!repository.countSinceCheckpoint || !repository.findLatestCheckpoint) {
      throw new Error('Audit repository does not provide the maintenance cadence capability.');
    }
    const deleted = await this.executeRetention(now);
    if (deleted > 0) return { checkpointed: true, deleted };
    const latest = await repository.findLatestCheckpoint();
    const pending = await repository.countSinceCheckpoint(
      latest?.throughCreatedAt ?? null,
      latest?.throughId ?? null
    );
    if (!this.shouldCheckpoint(pending)) return { checkpointed: false, deleted: 0 };
    return { checkpointed: (await this.createCheckpoint(now)) !== null, deleted: 0 };
  }

  /**
   * Privacy workflow: checkpoint original evidence, replace direct subject identifiers with a
   * keyed pseudonym, re-sign each envelope, then append a non-identifying transformation record.
   */
  async pseudonymizeSubject(subjectId: string): Promise<number> {
    const repository = this.deps.repositories.audit;
    if (!repository.replace) {
      throw new Error('Audit repository does not provide privacy pseudonymization capability.');
    }
    const events = await repository.findByScope({ type: 'SUBJECT', id: subjectId });
    if (events.length === 0) return 0;
    if (events.some((event) => !this.verifyIntegrity(event))) {
      throw new Error('Cannot pseudonymize unverifiable audit evidence.');
    }
    await this.createCheckpoint();
    const priorDigest = signEnvelope(this.config.auditIntegrityKey, {
      events: events.map(({ id, integrityHash }) => ({ id, integrityHash })),
    });
    const pseudonym = `anon:${createHmac('sha256', this.config.auditIntegrityKey)
      .update(`subject:${subjectId}`)
      .digest('hex')}`;
    await this.deps.repositories.transaction(async (tx) => {
      for (const event of events) {
        const payload = event.payload
          ? Object.fromEntries(
              Object.entries(event.payload).map(([key, value]) => [
                key,
                value === subjectId ? pseudonym : value,
              ])
            )
          : null;
        const unsigned = {
          ...event,
          targetId: event.targetId === subjectId ? pseudonym : event.targetId,
          principalId: event.principalId === subjectId ? pseudonym : event.principalId,
          actorId: event.actorId === subjectId ? pseudonym : event.actorId,
          resolverId: event.resolverId === subjectId ? pseudonym : event.resolverId,
          integrityKeyId: this.config.auditIntegrityKeyId,
          payload,
        };
        const toSign = Object.fromEntries(
          Object.entries(unsigned).filter(([key]) => key !== 'integrityHash')
        ) as Omit<AuditLog, 'integrityHash'>;
        await repository.replace(
          {
            ...toSign,
            integrityHash: signEnvelope(this.config.auditIntegrityKey, toSign),
          },
          tx
        );
      }
      await this.log(
        {
          eventFamily: 'AUDIT_ACCESS',
          eventType: 'PRIVACY_PSEUDONYMIZE',
          surface: 'SYSTEM',
          operation: 'audit.privacy.pseudonymize',
          outcomeCode: 'SUCCESS',
          decisionCode: 'ALLOW',
          reasonCode: 'SERVICE',
          authoritySources: [],
          targetType: 'SUBJECT',
          targetId: pseudonym,
          actorType: 'SERVICE',
          principalId: 'service:audit-privacy',
          actorId: null,
          authKind: 'SERVICE',
          payload: { deletedCount: events.length, priorDigest },
        },
        tx
      );
    });
    return events.length;
  }

  async read(principal: Principal, request: AuditReadRequest): Promise<AuditLog[]> {
    const capabilityByProjection: Record<AuditReadRequest['projection'], Capability> = {
      FULL: 'audit.full.read',
      OPERATIONAL: 'audit.operational.read',
      QUEUE: 'audit.queue.read',
      OWN: 'audit.own.read',
    };
    const capability = capabilityByProjection[request.projection];
    const requestTarget =
      request.scope.type === 'REQUEST'
        ? await this.deps.repositories.approvalRequests.findById(request.scope.id)
        : null;
    const context =
      request.scope.type === 'PROJECT'
        ? { projectId: request.scope.id }
        : request.scope.type === 'RESOURCE'
          ? { resourceId: request.scope.id }
          : request.scope.type === 'REQUEST'
            ? { requestId: request.scope.id, resourceId: requestTarget?.resourceId }
            : { subjectId: request.scope.id };
    const readDecision = await hasCapability(
      this.deps.repositories,
      principal,
      capability,
      context
    );
    let finalDecision = readDecision;
    if (request.export) {
      finalDecision = readDecision.allowed
        ? await hasCapability(this.deps.repositories, principal, 'audit.export', context)
        : readDecision;
    }

    await this.log({
      eventFamily: 'AUDIT_ACCESS',
      eventType: request.export ? 'AUDIT_EXPORT' : 'AUDIT_READ',
      surface: correlationStorage.getStore()?.surface ?? 'DOMAIN',
      operation: request.export ? 'audit.export' : 'audit.read',
      outcomeCode: finalDecision.allowed ? 'SUCCESS' : 'DENIED',
      capability: request.export ? 'audit.export' : capability,
      decisionCode: finalDecision.decisionCode,
      reasonCode: finalDecision.reasonCode,
      authoritySources: finalDecision.authoritySources,
      targetType: 'AUDIT_SCOPE',
      targetId: `${request.scope.type}:${request.scope.id}`,
      actorType: principal.type,
      principalId: principal.id,
      actorId: principal.subjectId,
      authKind: principal.authKind,
      projectId: request.scope.type === 'PROJECT' ? request.scope.id : null,
      resourceId: request.scope.type === 'RESOURCE' ? request.scope.id : null,
      requestId: request.scope.type === 'REQUEST' ? request.scope.id : null,
      payload: { projection: request.projection, exported: request.export },
    });
    if (!readDecision.allowed) throw new Error('Audit scope is not authorized.');
    if (request.export && !finalDecision.allowed) {
      throw new Error('Audit export is not authorized on this scope.');
    }
    const events = await this.deps.repositories.audit.findByScope(request.scope);
    if (events.some((event) => !this.verifyIntegrity(event))) {
      throw new Error('Audit scope contains an unverifiable or legacy-unverified event.');
    }
    return applyProjection(events, request.projection);
  }
}

export function buildOutboxEvent(
  input: Omit<
    CreateOutboxEventInput,
    | 'id'
    | 'createdAt'
    | 'schemaVersion'
    | 'correlationId'
    | 'integrityKeyId'
    | 'integrityHash'
    | 'payload'
  > & { id?: string; correlationId?: string; createdAt?: Date; payload: AuditMetadata },
  config: AuditSecurityConfig = loadAuditSecurityConfig()
): Omit<CreateOutboxEventInput, 'id'> & { id: string } {
  const context = createOperationContext({
    correlationId: input.correlationId,
    causationId: input.causationId,
  });
  const allowed =
    input.eventType === 'REQUEST_CREATED'
      ? new Set(['requestId', 'resourceId'])
      : input.eventType === 'APPROVAL_CALLBACK'
        ? new Set(['requestId', 'status'])
        : null;
  if (!allowed) throw new Error(`Unregistered outbox event type: ${input.eventType}`);
  const payload: AuditMetadata = {};
  for (const [key, value] of Object.entries(input.payload)) {
    if (
      !allowed.has(key) ||
      (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
    ) {
      throw new Error(`Outbox payload field is not registered for ${input.eventType}: ${key}`);
    }
    payload[key] = value as SafePayloadValue;
  }
  const unsigned = {
    id: input.id ?? randomUUID(),
    schemaVersion: 1,
    eventType: input.eventType,
    resourceId: input.resourceId ?? null,
    requestId: input.requestId ?? null,
    correlationId: context.correlationId,
    causationId: context.causationId,
    integrityKeyId: config.outboxIntegrityKeyId,
    payload,
    createdAt: input.createdAt ?? new Date(),
  };
  return {
    ...unsigned,
    integrityHash: signEnvelope(config.outboxIntegrityKey, unsigned),
  };
}

export function verifyOutboxIntegrity(
  event: OutboxEvent,
  config: AuditSecurityConfig = loadAuditSecurityConfig()
): boolean {
  if (event.integrityKeyId === 'legacy-unverified') return false;
  const key =
    config.outboxIntegrityKeys?.get(event.integrityKeyId) ??
    (event.integrityKeyId === config.outboxIntegrityKeyId ? config.outboxIntegrityKey : undefined);
  if (!key) return false;
  const unsigned = Object.fromEntries(
    Object.entries(event).filter(
      ([key]) =>
        !['status', 'attempts', 'lastErrorCode', 'updatedAt', 'integrityHash'].includes(key)
    )
  );
  const expected = signEnvelope(key, unsigned);
  const left = Buffer.from(event.integrityHash, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
