import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from '../../context.js';
import { resolveUserAccessibleAccount } from '../helpers.js';

export async function handleUpdate2FA(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const accountName = interaction.options.getString('account', true);
  const backupKey = interaction.options.getString('backup_key', true);
  const requesterId = interaction.user.id;
  const { totp: totpRepository } = context.repositories;

  const account = await resolveUserAccessibleAccount(totpRepository, requesterId, accountName);

  if (!account) {
    await interaction.reply({
      content: '❌ Account not found.',
      ephemeral: true,
    });
    return;
  }

  if (account.ownerDiscordUserId !== requesterId) {
    await interaction.reply({
      content:
        '❌ You are not the owner of this 2FA account. Only the owner can update the backup key.',
      ephemeral: true,
    });
    return;
  }

  account.backupKey = backupKey;

  await totpRepository.update(account);

  await interaction.reply({
    content: [
      '✅ Backup key updated successfully.',
      '',
      `Account: **${account.accountName}**`,
      '',
      '_Your backup key is now stored with this TOTP account._',
    ].join('\n'),
    ephemeral: true,
  });
}
