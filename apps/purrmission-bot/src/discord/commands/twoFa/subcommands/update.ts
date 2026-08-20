import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from '../../context.js';
import { createDiscordPrincipal } from '../../../../domain/principal.js';
import { AccessDeniedError, ForbiddenError } from '../../../../domain/auth.js';

export async function handleUpdate2FA(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const accountName = interaction.options.getString('account', true);
  const backupKey = interaction.options.getString('backup_key', true);
  const requesterId = interaction.user.id;
  let account;
  try {
    account = await context.services.resource.updateTOTPBackupKey(
      accountName,
      backupKey,
      createDiscordPrincipal(requesterId, interaction.id)
    );
  } catch (error) {
    if (!(error instanceof AccessDeniedError || error instanceof ForbiddenError)) {
      throw error;
    }
    await interaction.reply({
      content: '❌ Account not found or not owned by you.',
      ephemeral: true,
    });
    return;
  }

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
