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
     * TODO: Encrypt this at rest.
     */
    secret: string;

    /** Optional issuer from otpauth URI */
    issuer?: string;

    /** True if this account is intended to be shared */
    shared: boolean;

    /** Timestamp when the account was created */
    createdAt: Date;

    /** Timestamp when the account was last updated */
    updatedAt: Date;
}
