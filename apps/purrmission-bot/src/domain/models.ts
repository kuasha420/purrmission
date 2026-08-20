/**
 * Domain models for the Purrmission approval system.
 *
 * These types represent the core entities in the system:
 * - Resource: A protected resource that requires approval for access
 * - Guardian: A user who can approve/deny requests for a resource
 * - ApprovalRequest: A pending request for access to a resource
 */

/**
 * Approval mode for a resource.
 * - ONE_OF_N: Only one guardian needs to approve for the request to be approved.
 *
 * TODO: Add more modes in the future:
 * - ALL_OF_N: All guardians must approve
 * - M_OF_N: At least M guardians must approve
 */
export type ApprovalMode = 'ONE_OF_N';

/**
 * A protected resource that requires guardian approval for access.
 */
export interface TOTPLinkEnvelope {
  schemaVersion: 1;
  consentId: string;
  resourceId: string;
  initiatingResourceOwnerId: string;
  delegationPolicy: TOTPDelegationPolicy;
  accountOwnerDiscordUserId: string;
  accountVersion: string;
  linkPolicyVersion: string;
  createdAt: string;
}

export interface TOTPDelegationPolicy {
  allowDelegation: boolean;
  allowedOperations: readonly 'totp.code.read'[];
  allowedAuthFamilies: readonly string[];
  allowedAudiences: readonly string[];
  maxGrantTtlSeconds: number;
}

/**
 * A protected resource that requires guardian approval for access.
 */
export interface Resource {
  /** Unique identifier for the resource */
  id: string;

  /** Human-readable name of the resource */
  name: string;

  /** Approval mode determining how many guardians need to approve */
  mode: ApprovalMode;

  /** Optional linked TOTP account ID (one-to-one) */
  totpAccountId?: string | null;

  /** Versioned delegation envelope for linked TOTP account */
  totpDelegationEnvelope?: TOTPLinkEnvelope | null;

  /** Stable version identifier of the resource state */
  version: string;

  /** Stable version of the linked/unlinked TOTP relationship itself. */
  totpLinkVersion: string;

  /** Timestamp when the resource was created */
  createdAt: Date;
}

/** Value-free Resource projection for discovery and capability summaries. */
export type ResourceMetadata = Pick<
  Resource,
  'id' | 'name' | 'mode' | 'totpAccountId' | 'version' | 'totpLinkVersion' | 'createdAt'
>;

/**
 * Role of a guardian for a resource.
 * - OWNER: Can add/remove other guardians, full control
 * - GUARDIAN: Can approve/deny requests
 */
export type GuardianRole = 'OWNER' | 'GUARDIAN';

/**
 * A user who can approve or deny requests for a specific resource.
 */
export interface Guardian {
  /** Unique identifier for this guardian assignment */
  id: string;

  /** The resource this guardian is assigned to */
  resourceId: string;

  /** Discord user ID of the guardian */
  discordUserId: string;

  /** Role of this guardian */
  role: GuardianRole;

  /** Timestamp when the guardian was added */
  createdAt: Date;
}

/**
 * Status of an approval request.
 */
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

/**
 * An approval request for access to a protected resource.
 */
export interface ApprovalRequest {
  id: string;
  resourceId: string;
  status: ApprovalStatus;
  context?: Record<string, unknown> | null; // Legacy metadata/telemetry compatibility
  requesterId: string;
  requesterType: string;
  authKind: string;
  action: string;
  targetKey: string | null;
  targetVersion: string;
  policyVersion: string;
  constraints: Record<string, unknown> | null;
  callbackUrl?: string;
  discordMessageId?: string;
  discordChannelId?: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedBy?: string;
  resolvedAt?: Date;
}

export interface ApprovalGrant {
  id: string;
  requestId: string;
  resourceId: string;
  requesterId: string;
  requesterType: string;
  authKind: string;
  action: string;
  targetKey: string | null;
  targetVersion: string;
  policyVersion: string;
  constraints: Record<string, unknown> | null;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

/** Request projection that cannot carry callback or free-form context/constraints. */
export type ApprovalRequestMetadataProjection = Pick<
  ApprovalRequest,
  | 'id'
  | 'resourceId'
  | 'status'
  | 'requesterId'
  | 'requesterType'
  | 'authKind'
  | 'action'
  | 'targetKey'
  | 'targetVersion'
  | 'policyVersion'
  | 'createdAt'
  | 'expiresAt'
>;

/** Grant projection that excludes constraints and credential/auth provenance. */
export type ApprovalGrantMetadataProjection = Pick<
  ApprovalGrant,
  'id' | 'requestId' | 'resourceId' | 'expiresAt' | 'consumedAt' | 'revokedAt'
>;

/**
 * Decision made on an approval request.
 */
export type ApprovalDecision = 'APPROVE' | 'DENY';

/**
 * Result of recording a decision on an approval request.
 */
export interface DecisionResult {
  /** Whether the decision was recorded successfully */
  success: boolean;

  /** Error message if the decision failed */
  error?: string;

  /** Updated request state */
  request?: ApprovalRequest;

  /** Action to take after recording the decision */
  action?: {
    type: 'CALL_CALLBACK_URL';
    url: string;
    status: ApprovalStatus;
  };
}

/**
 * Input for creating a new resource.
 */
export type CreateResourceInput = Omit<
  Resource,
  'id' | 'createdAt' | 'version' | 'totpLinkVersion'
> & {
  id?: string;
  version?: string;
  totpLinkVersion?: string;
};

/**
 * Input for adding a new guardian.
 */
export type AddGuardianInput = Omit<Guardian, 'id' | 'createdAt'> & { id?: string };

/**
 * Input for creating a new approval request.
 */
export type CreateApprovalRequestInput = Omit<
  ApprovalRequest,
  'createdAt' | 'resolvedBy' | 'resolvedAt'
>;

export type CreateApprovalGrantInput = Omit<
  ApprovalGrant,
  'id' | 'createdAt' | 'consumedAt' | 'revokedAt'
>;

/**
 * Type of access being requested via approval flow.
 */
export type AccessRequestType = 'FIELD_ACCESS' | 'TOTP_ACCESS' | 'SECRET_ACCESS';

/**
 * Typed context for field/2FA access approval requests.
 */
export interface AccessRequestContext {
  /** Type of access being requested */
  type: AccessRequestType;

  /** Discord user ID of the requester */
  requesterId: string;

  /** Name of the field being requested (for FIELD_ACCESS) */
  fieldName?: string;

  /** Human-readable description of what's being requested */
  description: string;
}

/**
 * Extended access request context for compatibility with JSON storage
 * or Record<string, unknown> APIs where additional properties may be present.
 */
export type AccessRequestContextWithExtras = AccessRequestContext & Record<string, unknown>;

/**
 * A TOTP account for generating 2FA codes.
 */
export interface TOTPAccount {
  /** Unique identifier for the account */
  id: string;

  /** Discord ID of the primary owner */
  ownerDiscordUserId: string;

  /** Human-readable name (e.g., "GitHub (opensource@...)") */
  accountName: string;

  /**
   * Raw TOTP secret (BASE32).
   * Encrypted at rest in the database using AES-256-GCM.
   */
  secret: string;

  /** Optional issuer from otpauth URI */
  issuer?: string;

  /** Optional backup key / recovery code */
  backupKey?: string;

  /** Stable version identifier of the TOTP state */
  version: string;

  /** Timestamp when the account was created */
  createdAt: Date;

  /** Timestamp when the account was last updated */
  updatedAt: Date;
}

/**
 * Metadata projection of a TOTP account (excludes sensitive secrets).
 */
export interface TOTPAccountMetadata {
  id: string;
  ownerDiscordUserId: string;
  accountName: string;
  issuer?: string | null;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TOTPLinkConsent {
  id: string;
  accountId: string;
  resourceId: string;
  ownerDiscordUserId: string;
  initiatingResourceOwnerId: string;
  accountVersion: string;
  linkPolicyVersion: string;
  delegationPolicy: TOTPDelegationPolicy;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface TOTPDelegationConsent {
  id: string;
  resourceId: string;
  totpAccountId: string;
  operation: string;
  requesterId: string;
  ownerDiscordUserId: string;
  authFamily: string;
  audience: string;
  accountVersion: string;
  linkVersion: string;
  maxGrantExpiresAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/**
 * A text field attached to a resource (e.g., password, API key, secret).
 * Values are encrypted at rest in the database.
 */
export interface ResourceField {
  /** Unique identifier for the field */
  id: string;

  /** The resource this field belongs to */
  resourceId: string;

  /** Field name (e.g., "password", "api_key") */
  name: string;

  /** Field value (decrypted in domain layer) */
  value: string;

  /** Stable exact-secret version; advances whenever this value changes. */
  version: string;

  /** Timestamp when the field was created */
  createdAt: Date;

  /** Timestamp when the field was last updated */
  updatedAt: Date;
}

/**
 * Metadata projection of a resource field (excludes sensitive value).
 */
export interface ResourceFieldMetadata {
  id: string;
  resourceId: string;
  name: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for creating a new resource field.
 */
export type CreateResourceFieldInput = Omit<
  ResourceField,
  'id' | 'version' | 'createdAt' | 'updatedAt'
>;

export type AuditEventFamily =
  | 'AUTHENTICATION'
  | 'PROJECT_MEMBERSHIP'
  | 'RESOURCE_CONFIGURATION'
  | 'AUTHORIZATION'
  | 'SECRET_LIFECYCLE'
  | 'TOTP_LIFECYCLE'
  | 'REQUEST_GRANT_LIFECYCLE'
  | 'DELIVERY'
  | 'AUDIT_ACCESS'
  | 'LEGACY';

export type AuditSurface = 'DISCORD' | 'HTTP' | 'PAWTHY' | 'DOMAIN' | 'WORKER' | 'SYSTEM';
export type AuditOutcomeCode = 'SUCCESS' | 'DENIED' | 'FAILURE' | 'QUEUED' | 'NOOP';
export type AuditRetentionClass = 'SECURITY' | 'OPERATIONAL' | 'PRIVACY';
export type AuditTargetType =
  | 'SUBJECT'
  | 'PROJECT'
  | 'ENVIRONMENT'
  | 'RESOURCE'
  | 'SECRET'
  | 'TOTP_ACCOUNT'
  | 'APPROVAL_REQUEST'
  | 'APPROVAL_GRANT'
  | 'CREDENTIAL'
  | 'SESSION'
  | 'DELIVERY'
  | 'AUDIT_SCOPE'
  | 'SYSTEM';

export type AuditMetadataPrimitive = string | number | boolean | null;
export type AuditMetadataValue =
  | AuditMetadataPrimitive
  | AuditMetadataValue[]
  | { [key: string]: AuditMetadataValue };
export type AuditMetadata = Record<string, AuditMetadataValue>;

/** Version 2 append-only audit envelope. Secret-bearing values are forbidden in payload. */
export interface AuditLog {
  id: string;
  schemaVersion: number;
  eventFamily: AuditEventFamily;
  eventType: string;
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
  retentionClass: AuditRetentionClass;
  integrityKeyId: string;
  integrityHash: string;
  payload?: AuditMetadata | null;
  createdAt: Date;
}

/** Identity and time are supplied by the signing boundary, not generated after signing. */
export type CreateAuditLogInput = AuditLog;

export interface AuditCheckpoint {
  id: string;
  previousDigest: string | null;
  eventDigest: string;
  checkpointHash: string;
  integrityKeyId: string;
  eventCount: number;
  throughId: string;
  throughCreatedAt: Date;
  createdAt: Date;
}

/**
 * OutboxEvent for transactional outbox side-effects.
 */
export interface OutboxEvent {
  id: string;
  schemaVersion: number;
  eventType: string;
  resourceId?: string | null;
  requestId?: string | null;
  correlationId: string;
  causationId?: string | null;
  integrityKeyId: string;
  integrityHash: string;
  payload: AuditMetadata;
  status: 'PENDING' | 'DELIVERY_IN_PROGRESS' | 'DELIVERED_PENDING_AUDIT' | 'PROCESSED' | 'FAILED';
  attempts: number;
  lastErrorCode?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateOutboxEventInput = Omit<OutboxEvent, 'attempts' | 'status' | 'updatedAt'>;

/**
 * Represents a device login session (OAuth Device Flow).
 */
export type AuthSessionStatus = 'PENDING' | 'APPROVED' | 'EXPIRED' | 'DENIED' | 'CONSUMED';

export interface AuthSession {
  id: string;
  deviceCode: string;
  userCode: string;
  status: AuthSessionStatus;
  userId?: string;
  approvalAttempts: number;
  pollAttempts: number;
  approvedAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateAuthSessionInput = Omit<
  AuthSession,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'userId'
  | 'approvalAttempts'
  | 'pollAttempts'
  | 'approvedAt'
  | 'consumedAt'
>;

// ----------------------------------------------------
// Project & Environment
// ----------------------------------------------------

export interface Project {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  policyVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Environment {
  id: string;
  name: string;
  slug: string;
  projectId: string;
  resourceId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  ownerId: string;
}

export interface CreateEnvironmentInput {
  name: string;
  slug: string;
  projectId: string;
  resourceId?: string;
}

export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

// ----------------------------------------------------
// Project Members
// ----------------------------------------------------

export type ProjectMemberRole = 'READER' | 'WRITER';

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  addedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectMemberInput {
  projectId: string;
  userId: string;
  role?: ProjectMemberRole;
  addedBy: string;
}

// ----------------------------------------------------
// RBAC & Capabilities (Prerequisite 1/9)
// ----------------------------------------------------

export type PrincipalType = 'DISCORD_USER' | 'PAWTHY_TOKEN' | 'RESOURCE_API_KEY' | 'SERVICE';
export type AuthKind = 'DISCORD' | 'PAWTHY' | 'API_KEY' | 'SERVICE';

export interface Principal {
  /** Stable credential/session record identifier. Never use this as the authorization subject. */
  type: PrincipalType;
  id: string;
  /** Discord user, Resource, or service identity that capabilities are evaluated against. */
  subjectId: string;
  authKind: AuthKind;
  /** Optional human attribution. It is not an alternative authorization subject. */
  actorDiscordId?: string;
  correlationId?: string;
  scopes?: string[];
  audience?: string;
  expiresAt?: Date | null;
  createdAt?: Date;
  lastUsedAt?: Date | null;
  /** Exact object boundary carried by a scoped service credential. */
  credentialTarget?: CredentialTarget;
}

export type CredentialType = 'RESOURCE_API_KEY' | 'PAWTHY_TOKEN' | 'SERVICE_CREDENTIAL';
export type CredentialTargetType = 'ACCOUNT' | 'PROJECT' | 'ENVIRONMENT' | 'RESOURCE';
export interface CredentialTarget {
  type: CredentialTargetType;
  id: string;
}

export interface Credential {
  id: string;
  type: CredentialType;
  subjectId: string;
  name: string;
  digest: string;
  digestKeyId: string;
  prefix: string;
  scopes: string[];
  audience: string;
  targetType: CredentialTargetType;
  targetId: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  lastUsedAt: Date | null;
  version: string;
}

export type CreateCredentialInput = Omit<Credential, 'id' | 'createdAt' | 'lastUsedAt' | 'version'>;

export type Capability =
  // Project capabilities
  | 'project.create'
  | 'project.view'
  | 'project.update'
  | 'project.delete'
  | 'project.transfer'
  | 'project.members.view'
  | 'project.members.manage'
  // Environment capabilities
  | 'environment.view'
  | 'environment.create'
  | 'environment.update'
  | 'environment.delete'
  // Resource capabilities
  | 'resource.create'
  | 'resource.view'
  | 'resource.policy.manage'
  | 'resource.delete'
  | 'resource.api-key.list'
  | 'resource.api-key.mint'
  | 'resource.api-key.rotate'
  | 'resource.api-key.revoke'
  // Secret capabilities
  | 'secret.metadata.read'
  | 'secret.value.read'
  | 'secret.write'
  | 'secret.delete'
  // TOTP capabilities
  | 'totp.metadata.read'
  | 'totp.code.read'
  | 'totp.recovery.read'
  | 'totp.link.manage'
  | 'totp.account.manage'
  // Guardian capabilities
  | 'guardian.view'
  | 'guardian.context.read'
  | 'guardian.manage'
  // Request capabilities
  | 'request.create'
  | 'request.view-own'
  | 'request.queue.view'
  | 'request.decide'
  | 'request.cancel-own'
  // Grant capabilities
  | 'grant.consume'
  // Audit capabilities
  | 'audit.full.read'
  | 'audit.operational.read'
  | 'audit.queue.read'
  | 'audit.own.read'
  | 'audit.export'
  // Current CLI credential lifecycle capabilities
  | 'token.manage-own';

export interface CapabilityContext {
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  totpAccountId?: string;
  /** Distinguishes Resource-owner link authority from custody-owner unlink authority. */
  totpLinkOperation?: 'LINK' | 'UNLINK';
  requestId?: string;
  /** Request used as scoped authority evidence without changing the evaluated object target. */
  authorizationRequestId?: string;
  fieldName?: string; // specific secret/field
  subjectId?: string;
  // For grant consumption validation
  grantId?: string;
  action?: string;
  targetVersion?: string;
  policyVersion?: string;
  requiredAudience?: string;
  currentTimestamp?: Date;
}

export type DecisionCode = 'ALLOW' | 'DENY' | 'APPROVAL_REQUIRED';

export type ReasonCode =
  | 'AUTHENTICATED_SUBJECT'
  | 'OWNER'
  | 'WRITER'
  | 'READER'
  | 'GUARDIAN'
  | 'GRANT'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'RECOVERY_KEY_OWNER_REQUIRED'
  | 'NO_ROLE'
  | 'INVALID_AUTH'
  | 'AUTH_SUBJECT_MISMATCH'
  | 'WRONG_AUDIENCE'
  | 'MISSING_CONTEXT'
  | 'TARGET_SCOPE_MISMATCH'
  | 'GRANT_EXPIRED'
  | 'GRANT_SCOPE_MISMATCH'
  | 'GRANT_INVALID'
  | 'SERVICE'
  | 'INSUFFICIENT_SCOPES';

export type AuthoritySource =
  | 'AUTHENTICATED_SUBJECT'
  | 'PROJECT_OWNER'
  | 'PROJECT_WRITER'
  | 'PROJECT_READER'
  | 'RESOURCE_OWNER'
  | 'EXPLICIT_GUARDIAN'
  | 'TOTP_OWNER'
  | 'SCOPED_CREDENTIAL'
  | 'APPROVAL_GRANT';

export type PolicyTarget =
  | { type: 'GLOBAL' }
  | { type: 'SUBJECT'; id: string }
  | { type: 'PROJECT'; id: string }
  | { type: 'ENVIRONMENT'; id: string }
  | { type: 'RESOURCE'; id: string }
  | { type: 'SECRET'; resourceId: string; key: string }
  | { type: 'TOTP_ACCOUNT'; id: string }
  | { type: 'APPROVAL_REQUEST'; id: string }
  | { type: 'APPROVAL_GRANT'; id: string };

export interface EvaluationResult {
  allowed: boolean;
  decisionCode: DecisionCode;
  reasonCode: ReasonCode;
  capability: Capability;
  target: PolicyTarget;
  authoritySources: AuthoritySource[];
  approvalRequestId?: string;
  grantId?: string;
  /** Safe for UI/CLI display; never contains protected values or object names. */
  safeExplanation: string;
}

export interface CallbackDestination {
  id: string;
  resourceId: string;
  url: string;
  secret: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCallbackDestinationInput {
  resourceId: string;
  url: string;
  secret: string;
}
