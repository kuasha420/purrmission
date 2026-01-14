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
  apiKey: string;

  /** Optional linked TOTP account ID (one-to-one) */
  totpAccountId?: string | null;

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
  /** Unique identifier for the request */
  id: string;

  /** The resource being requested */
  resourceId: string;

  /** Current status of the request */
  status: ApprovalStatus;

  /** Additional context provided with the request (e.g., reason, requester info) */
  context: Record<string, unknown>;

  /** Optional URL to call when the request is resolved */
  callbackUrl?: string;

  /** ID of the Discord message showing the approval buttons */
  discordMessageId?: string;

  /** ID of the Discord channel where the approval message was sent */
  discordChannelId?: string;

  /** Timestamp when the request was created */
  createdAt: Date;

  /** Timestamp when the request expires (null = no expiration) */
  expiresAt: Date | null;

  /** Discord user ID of the guardian who resolved the request */
  resolvedBy?: string;

  /** Timestamp when the request was resolved */
  resolvedAt?: Date;
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
export type CreateResourceInput = Omit<Resource, 'createdAt'>;

/**
 * Input for adding a new guardian.
 */
export type AddGuardianInput = Omit<Guardian, 'createdAt'>;

/**
 * Input for creating a new approval request.
 */
export type CreateApprovalRequestInput = Omit<ApprovalRequest, 'createdAt'>;

/**
 * Type of access being requested via approval flow.
 */
export type AccessRequestType = 'FIELD_ACCESS' | 'TOTP_ACCESS';

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

  /** True if this account is intended to be shared */
  shared: boolean;

  /** Optional backup key / recovery code */
  backupKey?: string;

  /** Timestamp when the account was created */
  createdAt: Date;

  /** Timestamp when the account was last updated */
  updatedAt: Date;
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
 * Input for creating a new resource field.
 */
export type CreateResourceFieldInput = Omit<ResourceField, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Audit Log entry for sensitive actions.
 */
export interface AuditLog {
  id: string;
  action: string;
  resourceId?: string | null;
  actorId?: string | null;
  resolverId?: string | null;
  status: string;
  context?: string | null; // JSON string
  createdAt: Date;
}

export type CreateAuditLogInput = Omit<AuditLog, 'id' | 'createdAt'>;


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
  createdAt: Date;
  updatedAt: Date;
}

export interface Environment {
  id: string;
  name: string;
  slug: string;
  projectId: string;
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
}
