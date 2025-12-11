/**
 * Context passed to all command handlers.
 *
 * This interface encapsulates all dependencies that a command might need,
 * including repositories for data access and services for business logic.
 */

import type { Repositories } from '../../domain/repositories.js';
import type { Services } from '../../domain/services.js';

export interface CommandContext {
  repositories: Repositories;
  services: Services;
}
