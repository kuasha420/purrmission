import { ServiceDependencies } from './services.js';
import { AuditLog, CreateAuditLogInput } from './models.js';
import { logger } from '../logging/logger.js';
import { Prisma } from '@prisma/client';
import { correlationStorage } from '../logging/correlationContext.js';

export class AuditService {
  private deps: ServiceDependencies;

  constructor(deps: ServiceDependencies) {
    this.deps = deps;
  }

  /**
   * Log a security or compliance event.
   * Throws if logging fails, to support transaction rollback and fail-closed security.
   */
  async log(
    event: Omit<CreateAuditLogInput, 'id' | 'createdAt' | 'schemaVersion'>,
    tx?: Prisma.TransactionClient
  ): Promise<AuditLog> {
    try {
      const store = correlationStorage.getStore();
      const correlationId = event.correlationId ?? store?.correlationId ?? null;

      const created = await this.deps.repositories.audit.create(
        {
          schemaVersion: 1,
          ...event,
          correlationId,
        },
        tx
      );
      logger.debug(`Audit event logged: ${event.eventType}`, {
        resourceId: event.resourceId,
        actorId: event.actorId,
        outcomeCode: event.outcomeCode,
        correlationId,
      });
      return created;
    } catch (error) {
      logger.error('Failed to write audit log', {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve audit logs for a resource.
   */
  async getLogsForResource(resourceId: string): Promise<AuditLog[]> {
    return this.deps.repositories.audit.findByResourceId(resourceId);
  }

  /**
   * Retrieve audit logs for a project.
   */
  async getLogsForProject(projectId: string): Promise<AuditLog[]> {
    return this.deps.repositories.audit.findByProjectId(projectId);
  }
}
