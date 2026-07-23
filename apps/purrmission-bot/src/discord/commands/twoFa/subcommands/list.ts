import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from '../../context.js';
import type { TOTPAccount } from '../../../../domain/models.js';

export async function handleList2FA(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const includeShared = interaction.options.getBoolean('shared', false) ?? false;
  const ownerDiscordUserId = interaction.user.id;
  const { totp: totpRepository } = context.repositories;

  const personalAccounts = await totpRepository.findByOwnerDiscordUserId(ownerDiscordUserId);

  let sharedAccounts: TOTPAccount[] = [];
  if (includeShared) {
    sharedAccounts = await totpRepository.findSharedVisibleTo(ownerDiscordUserId);
  }

  if (personalAccounts.length === 0 && (!includeShared || sharedAccounts.length === 0)) {
    await interaction.reply({
      content: includeShared
        ? "You don't have any 2FA accounts yet, and no shared accounts are visible to you."
        : "You don't have any 2FA accounts yet.",
      ephemeral: true,
    });
    return;
  }

  const lines: string[] = [];

  if (personalAccounts.length > 0) {
    lines.push('**👤 Your 2FA accounts:**');
    for (const account of personalAccounts) {
      lines.push(`• ${account.accountName}${account.shared ? ' (shared)' : ''}`);
    }
    lines.push(''); // blank line
  }

  if (includeShared && sharedAccounts.length > 0) {
    let hasVisibleShared = false;
    const sharedLines: string[] = [];

    for (const account of sharedAccounts) {
      // Avoid duplicating if the user is also the owner
      if (account.ownerDiscordUserId === ownerDiscordUserId) {
        continue;
      }
      sharedLines.push(`• ${account.accountName}`);
      hasVisibleShared = true;
    }

    if (hasVisibleShared) {
      lines.push('**👥 Shared accounts visible to you:**');
      lines.push(...sharedLines);
    }
  }

  if (lines.length === 0) {
    // This case can happen if sharedAccounts only contained accounts owned by the user.
    await interaction.reply({
      content: "You don't have any additional shared 2FA accounts visible to you beyond your own.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: lines.join('\n'),
    ephemeral: true,
  });
}
