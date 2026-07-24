import type { AutocompleteInteraction } from 'discord.js';
import type { CommandContext } from '../context.js';

/**
 * Handle autocomplete for /2fa commands (account names).
 */
export async function handleTwoFaAutocomplete(
  interaction: AutocompleteInteraction,
  context: CommandContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand !== 'get' && subcommand !== 'update') {
    return;
  }

  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name !== 'account') {
    return;
  }

  const query = focusedOption.value.trim().toLowerCase();
  const ownerDiscordUserId = interaction.user.id;
  const { totp: totpRepository } = context.repositories;

  // Load personal accounts visible to this user:
  const personalAccounts =
    await totpRepository.findMetadataByOwnerDiscordUserId(ownerDiscordUserId);

  const allAccounts = personalAccounts;

  // Filter by query (simple case-insensitive substring match)
  const filtered = allAccounts.filter((account) =>
    account.accountName.toLowerCase().includes(query)
  );

  const choices = filtered.slice(0, 25).map((account) => ({
    name: account.accountName,
    value: account.accountName,
  }));

  await interaction.respond(choices);
}

/**
 * Alias for backward compatibility.
 */
export const handle2FAAutocomplete = handleTwoFaAutocomplete;
