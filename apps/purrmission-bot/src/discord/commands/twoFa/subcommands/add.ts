import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from '../../context.js';
import { logger } from '../../../../logging/logger.js';
import { createTOTPAccountFromSecret, createTOTPAccountFromUri } from '../../../../domain/totp.js';

export async function handleAdd2FA(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const account = interaction.options.getString('account', true);
  const mode = interaction.options.getString('mode', true);
  const uri = interaction.options.getString('uri', false) ?? undefined;
  const secret = interaction.options.getString('secret', false) ?? undefined;
  const issuer = interaction.options.getString('issuer', false) ?? undefined;
  // const qrAttachment = interaction.options.getAttachment('qr', false) ?? undefined;

  const ownerDiscordUserId = interaction.user.id;
  const { totp: totpRepository } = context.repositories;

  try {
    let createdAccountSummary: string;

    if (mode === 'uri') {
      if (!uri) {
        await interaction.reply({
          content: '❌ You selected mode `uri` but did not provide a `uri` value.',
          ephemeral: true,
        });
        return;
      }

      const accountData = createTOTPAccountFromUri(ownerDiscordUserId, uri);
      // Override account name if provided manually
      accountData.accountName = account;

      if (issuer) {
        accountData.issuer = issuer;
      }

      const created = await totpRepository.create(accountData);
      createdAccountSummary = `Account **${created.accountName}** added via URI mode.`;
    } else if (mode === 'secret') {
      if (!secret) {
        await interaction.reply({
          content: '❌ You selected mode `secret` but did not provide a `secret` value.',
          ephemeral: true,
        });
        return;
      }

      const accountData = createTOTPAccountFromSecret(ownerDiscordUserId, account, secret, issuer);
      const created = await totpRepository.create(accountData);
      createdAccountSummary = `Account **${created.accountName}** added via Secret mode.`;
    } else if (mode === 'qr') {
      // QR mode stub for now
      await interaction.reply({
        content: '📷 QR mode is not implemented yet. Please use `uri` or `secret` mode for now.',
        ephemeral: true,
      });
      return;
    } else {
      await interaction.reply({
        content: '❌ Unsupported mode. Please choose `uri`, `secret`, or `qr`.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: [
        '✅ 2FA account added successfully.',
        '',
        createdAccountSummary,
        '🔒 This account is **personal**.',
        '',
        '_Note: You can now retrieve codes using `/2fa get`._',
      ].join('\n'),
      ephemeral: true,
    });
  } catch (error) {
    logger.error('Failed to add 2FA account', { error });
    await interaction.reply({
      content:
        '❌ Failed to add 2FA account. Please check your input (otpauth URI or secret) and try again.',
      ephemeral: true,
    });
  }
}
