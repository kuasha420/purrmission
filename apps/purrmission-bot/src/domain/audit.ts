import { ServiceDependencies } from './services.js';
import { AuditLog, CreateAuditLogInput } from './models.js';
import { logger } from '../logging/logger.js';

export class AuditService {
    private deps: ServiceDependencies;

    constructor(deps: ServiceDependencies) {
        this.deps = deps;
    }

    /**
     * Log a security or compliance event.
     * Does NOT throw if logging fails, to prevent blocking business logic.
     * Logs error to console instead.
     */
    async log(event: Omit<CreateAuditLogInput, 'id' | 'createdAt'>): Promise<void> {
        try {
            await this.deps.repositories.audit.create(event);
            logger.debug(`Audit event logged: ${event.action}`, {
                resourceId: event.resourceId,
                actorId: event.actorId,
                status: event.status,
            });
        } catch (error) {
            logger.error('Failed to write audit log', {
                event,
                error: error instanceof Error ? error.message : String(error),
            });
            // Swallow error - audit failure should not crash the request
        }
    }

    /**
     * Retrieve audit logs for a resource.
     */
    async getLogsForResource(resourceId: string): Promise<AuditLog[]> {
        return this.deps.repositories.audit.findByResourceId(resourceId);
    }
}
