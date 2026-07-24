import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from '../../context.js';

export async function handleList2FA(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const ownerDiscordUserId = interaction.user.id;
  const { totp: totpRepository } = context.repositories;

  const personalAccounts =
    await totpRepository.findMetadataByOwnerDiscordUserId(ownerDiscordUserId);

  if (personalAccounts.length === 0) {
    await interaction.reply({
      content: "You don't have any 2FA accounts yet.",
      ephemeral: true,
    });
    return;
  }

  const lines: string[] = ['**👤 Your 2FA accounts:**'];
  for (const account of personalAccounts) {
    lines.push(`• ${account.accountName}`);
  }

  await interaction.reply({
    content: lines.join('\n'),
    ephemeral: true,
  });
}
