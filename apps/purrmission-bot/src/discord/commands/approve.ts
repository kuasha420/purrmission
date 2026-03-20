/**
 * Approve command handler.
 *
 * Previously a standalone /approve command, now routed via /access approve.
 * The execute function is kept for test compatibility.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { handleDecisionCommand } from './decision.js';

/**
 * Execute an approval decision.
 *
 * @param interaction - The command interaction
 * @param services - Application services
 */
export async function execute(interaction: ChatInputCommandInteraction, services: Services) {
  await handleDecisionCommand(interaction, services, 'APPROVE');
}
