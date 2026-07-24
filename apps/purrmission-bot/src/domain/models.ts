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
  consentId: string;
  delegationPolicy: Record<string, unknown>;
  accountOwnerDiscordUserId: string;
  accountVersion: string;
  linkVersion: string;
  createdAt: Date;
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

  /**
   * API key for authenticating external requests.
   * TODO: In production, this should be hashed. For MVP, stored as plaintext.
   */
  apiKey?: string | null;

  /** Optional linked TOTP account ID (one-to-one) */
  totpAccountId?: string | null;

  /** Versioned delegation envelope for linked TOTP account */
  totpDelegationEnvelope?: TOTPLinkEnvelope | null;

  /** Stable version identifier of the resource state */
  version: string;

  /** Timestamp when the resource was created */
  createdAt: Date;
}

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
export type CreateResourceInput = Omit<Resource, 'createdAt' | 'version'> & { version?: string };

/**
 * Input for adding a new guardian.
 */
export type AddGuardianInput = Omit<Guardian, 'createdAt'>;

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
  delegationPolicy: Record<string, unknown>;
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
  authFamily: string;
  accountVersion: string;
  linkVersion: string;
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
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for creating a new resource field.
 */
export type CreateResourceFieldInput = Omit<ResourceField, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Audit Log entry for sensitive actions.
 */
export interface AuditLog {
  id: string;
  schemaVersion: number;
  eventType: string;
  outcomeCode: string;
  actorType: string;
  actorId?: string | null;
  authKind?: string | null;
  resourceId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  requestId?: string | null;
  grantId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  payload?: Record<string, unknown> | null; // Redacted JSON context
  createdAt: Date;
}

export type CreateAuditLogInput = Omit<AuditLog, 'id' | 'createdAt'>;

/**
 * OutboxEvent for transactional outbox side-effects.
 */
export interface OutboxEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  attempts: number;
  lastError?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateOutboxEventInput = Omit<
  OutboxEvent,
  'id' | 'attempts' | 'status' | 'createdAt' | 'updatedAt'
>;

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
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Long-lived API token for CLI access.
 */
export interface ApiToken {
  id: string;
  token: string; // Hashed at rest
  userId: string;
  name: string;
  lastUsedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export type CreateAuthSessionInput = Omit<AuthSession, 'id' | 'createdAt' | 'updatedAt' | 'userId'>;
export type CreateApiTokenInput = Omit<ApiToken, 'id' | 'createdAt' | 'lastUsedAt'>;

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
// RBAC & Capabilities (Prerequisite 1/8)
// ----------------------------------------------------

export type PrincipalType = 'DISCORD_USER' | 'PAWTHY_TOKEN' | 'RESOURCE_API_KEY' | 'SERVICE';
export type AuthKind = 'DISCORD' | 'PAWTHY' | 'API_KEY' | 'SERVICE';

export interface Principal {
  type: PrincipalType;
  id: string; // Stable Credential / Principal ID
  subjectId: string; // Resource ID, User ID, or Service Name
  authKind: AuthKind;
  actorDiscordId?: string; // Optional human Discord User ID association
  correlationId?: string;
  scopes?: string[];
  audience?: string;
  expiresAt?: Date | null;
  createdAt?: Date;
  lastUsedAt?: Date | null;
}

export type CredentialType = 'RESOURCE_API_KEY' | 'PAWTHY_TOKEN' | 'SERVICE_CREDENTIAL';

export interface Credential {
  id: string;
  type: CredentialType;
  subjectId: string;
  name: string;
  digest: string;
  prefix: string;
  scopes: string; // Comma-separated or JSON list
  audience: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
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
  | 'audit.export';

export interface CapabilityContext {
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  totpAccountId?: string;
  requestId?: string;
  fieldName?: string; // specific secret/field
  // For grant consumption validation
  grantId?: string;
  targetVersion?: string;
  currentTimestamp?: Date;
}

export type DecisionCode = 'ALLOW' | 'DENY' | 'APPROVAL_REQUIRED';

export type ReasonCode =
  | 'OWNER'
  | 'WRITER'
  | 'READER'
  | 'GUARDIAN'
  | 'GRANT'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'RECOVERY_KEY_OWNER_REQUIRED'
  | 'NO_ROLE'
  | 'INVALID_AUTH'
  | 'MISSING_CONTEXT'
  | 'GRANT_EXPIRED'
  | 'GRANT_SCOPE_MISMATCH'
  | 'SERVICE'
  | 'INSUFFICIENT_SCOPES';

export interface EvaluationResult {
  allowed: boolean;
  decisionCode: DecisionCode;
  reasonCode: ReasonCode;
  reason: string;
}
