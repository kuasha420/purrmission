import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from '../../context.js';
import { generateTOTPCode } from '../../../../domain/totp.js';
import { rateLimiter } from '../../../../infra/rateLimit.js';
import { resolveUserAccessibleAccount, sendDmOrFallback } from '../helpers.js';

export async function handleGet2FA(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const accountName = interaction.options.getString('account', true);
  const getBackup = interaction.options.getBoolean('backup', false) ?? false;
  const requesterId = interaction.user.id;
  const { totp: totpRepository } = context.repositories;

  // Rate Limit Check
  const rateLimitKey = `req:2fa:${requesterId}`;
  if (!rateLimiter.check(rateLimitKey)) {
    await interaction.reply({
      content: '⏱️ You are requesting 2FA codes too quickly. Please wait a moment.',
      ephemeral: true,
    });

    await context.services.audit.log({
      eventFamily: 'AUTHORIZATION',
      eventType: 'TOTP_ACCESS_THROTTLED',
      surface: 'DISCORD',
      operation: 'totp.get',
      outcomeCode: 'DENIED',
      capability: getBackup ? 'totp.recovery.read' : 'totp.code.read',
      decisionCode: 'DENY',
      reasonCode: 'INSUFFICIENT_SCOPES',
      authoritySources: [],
      targetType: 'TOTP_ACCOUNT',
      targetId: accountName,
      actorType: 'DISCORD_USER',
      principalId: `discord-interaction:${interaction.id}`,
      actorId: requesterId,
      authKind: 'DISCORD',
      correlationId: interaction.id,
      payload: { reason: 'Rate limit exceeded', accountName },
    });
    return;
  }

  // Resolve account: personal first, then shared
  const account = await resolveUserAccessibleAccount(totpRepository, requesterId, accountName);

  if (!account) {
    await interaction.reply({
      content: '❌ No matching 2FA account found that you can access.',
      ephemeral: true,
    });
    return;
  }

  if (getBackup) {
    if (!account.backupKey) {
      await interaction.reply({
        content: `❌ No backup key found for **${account.accountName}**. You can add one with \`/2fa update\`.`,
        ephemeral: true,
      });
      return;
    }

    await context.services.audit.log({
      eventFamily: 'TOTP_LIFECYCLE',
      eventType: 'TOTP_RECOVERY_REVEAL',
      surface: 'DISCORD',
      operation: 'totp.recovery.reveal',
      outcomeCode: 'SUCCESS',
      capability: 'totp.recovery.read',
      decisionCode: 'ALLOW',
      reasonCode: 'AUTHENTICATED_SUBJECT',
      authoritySources: ['AUTHENTICATED_SUBJECT'],
      targetType: 'TOTP_ACCOUNT',
      targetId: account.id,
      actorType: 'DISCORD_USER',
      principalId: `discord-interaction:${interaction.id}`,
      actorId: requesterId,
      authKind: 'DISCORD',
      correlationId: interaction.id,
      payload: { totpAccountId: account.id },
    });

    await sendDmOrFallback(
      interaction,
      [
        `🔐 Your backup key for **${account.accountName}**:`,
        '',
        `\`${account.backupKey}\``,
        '',
        '_Keep this key safe and do not share it._',
      ],
      '✅ Backup key sent to your DMs.',
      'Failed to DM backup key:'
    );
    return;
  }

  // Generate TOTP code
  const code = generateTOTPCode(account);

  await context.services.audit.log({
    eventFamily: 'TOTP_LIFECYCLE',
    eventType: 'TOTP_CODE_REVEAL',
    surface: 'DISCORD',
    operation: 'totp.code.reveal',
    outcomeCode: 'SUCCESS',
    capability: 'totp.code.read',
    decisionCode: 'ALLOW',
    reasonCode: 'AUTHENTICATED_SUBJECT',
    authoritySources: ['AUTHENTICATED_SUBJECT'],
    targetType: 'TOTP_ACCOUNT',
    targetId: account.id,
    actorType: 'DISCORD_USER',
    principalId: `discord-interaction:${interaction.id}`,
    actorId: requesterId,
    authKind: 'DISCORD',
    correlationId: interaction.id,
    payload: { totpAccountId: account.id },
  });

  await sendDmOrFallback(
    interaction,
    [
      `🔐 Your TOTP code for **${account.accountName}**:`,
      '',
      `**${code}**`,
      '',
      '_Code is time-based and will expire soon._',
    ],
    '✅ TOTP code sent to your DMs.',
    'Failed to DM TOTP code:'
  );
}
