/**
 * Deny command handler.
 *
 * Previously a standalone /deny command, now routed via /access deny.
 * The execute function is kept for test compatibility.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { handleDecisionCommand } from './decision.js';

/**
 * Execute a denial decision.
 *
 * @param interaction - The command interaction
 * @param services - Application services
 */
export async function execute(interaction: ChatInputCommandInteraction, services: Services) {
  await handleDecisionCommand(interaction, services, 'DENY');
}
