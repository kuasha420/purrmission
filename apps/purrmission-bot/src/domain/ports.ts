import type { Principal, Project, Environment, ApprovalRequest } from './models.js';

// ---------------------------------------------------------------------------
// Shared Boundary Errors
// ---------------------------------------------------------------------------
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized access') {
    super('UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Action forbidden by policy') {
    super('FORBIDDEN', message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', message);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

export class RateLimitError extends DomainError {
  constructor(message = 'Rate limit exceeded') {
    super('RATE_LIMIT_EXCEEDED', message);
  }
}

// ---------------------------------------------------------------------------
// Boundary DTO Interfaces
// ---------------------------------------------------------------------------
export interface CreateProjectDTO {
  name: string;
}

export interface AddMemberDTO {
  projectId: string;
  memberUserId: string;
  role: 'OWNER' | 'WRITER' | 'READER';
}

export interface CreateEnvironmentDTO {
  projectId: string;
  name: string;
  slug: string;
}

export interface BatchSetSecretsDTO {
  projectId: string;
  envId: string;
  secrets: Record<string, string>;
}

export interface CallbackDestinationDTO {
  id: string;
  resourceId: string;
  url: string;
  enabled: boolean;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Frozen Boundary Port Interface
// ---------------------------------------------------------------------------
export interface DomainPorts {
  // Projects
  createProject(
    principal: Principal,
    dto: CreateProjectDTO,
    correlationId?: string
  ): Promise<Project>;
  listProjects(principal: Principal, correlationId?: string): Promise<Project[]>;
  getProject(
    principal: Principal,
    projectId: string,
    correlationId?: string
  ): Promise<Project | null>;
  addProjectMember(principal: Principal, dto: AddMemberDTO, correlationId?: string): Promise<void>;
  removeProjectMember(
    principal: Principal,
    projectId: string,
    memberUserId: string,
    correlationId?: string
  ): Promise<void>;
  listProjectMembers(
    principal: Principal,
    projectId: string,
    correlationId?: string
  ): Promise<any[]>;

  // Environments
  createEnvironment(
    principal: Principal,
    dto: CreateEnvironmentDTO,
    correlationId?: string
  ): Promise<Environment>;
  listEnvironments(
    principal: Principal,
    projectId: string,
    correlationId?: string
  ): Promise<Environment[]>;
  getEnvironment(
    principal: Principal,
    projectId: string,
    envSlug: string,
    correlationId?: string
  ): Promise<Environment | null>;

  // Secrets & Reveal Operations
  getSecrets(
    principal: Principal,
    projectId: string,
    envId: string,
    grantId?: string,
    correlationId?: string
  ): Promise<Record<string, string>>;
  setSecrets(principal: Principal, dto: BatchSetSecretsDTO, correlationId?: string): Promise<void>;
  revealTOTP(
    principal: Principal,
    resourceId: string,
    grantId?: string,
    consentId?: string,
    correlationId?: string
  ): Promise<string>;

  // Callback / Webhook Destinations
  registerCallback(
    principal: Principal,
    resourceId: string,
    url: string,
    secret: string,
    correlationId?: string
  ): Promise<CallbackDestinationDTO>;
  listCallbacks(
    principal: Principal,
    resourceId: string,
    correlationId?: string
  ): Promise<CallbackDestinationDTO[]>;
  deleteCallback(
    principal: Principal,
    resourceId: string,
    callbackId: string,
    correlationId?: string
  ): Promise<void>;

  // Approvals & Grants
  createApprovalRequest(
    principal: Principal,
    resourceId: string,
    action: string,
    targetKey?: string | null,
    correlationId?: string
  ): Promise<{ success: boolean; request?: ApprovalRequest }>;
  recordApprovalDecision(
    principal: Principal,
    requestId: string,
    decision: 'APPROVE' | 'DENY',
    correlationId?: string
  ): Promise<{ success: boolean }>;
  getApprovalRequest(
    principal: Principal,
    requestId: string,
    correlationId?: string
  ): Promise<ApprovalRequest | null>;
}
