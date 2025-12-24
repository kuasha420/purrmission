import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';

import type { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';
import {
  createTOTPAccountFromSecret,
  createTOTPAccountFromUri,
  generateTOTPCode,
} from '../../domain/totp.js';
import type { TOTPAccount } from '../../domain/models.js';
import {
  buildResourceSubcommandGroup,
  handleResourceCommand,
  handleResourceAutocomplete,
} from './resource.js';
import { handleAddGuardian } from './addGuardian.js';
import { rateLimiter } from '../../infra/rateLimit.js';
export const purrmissionCommand = new SlashCommandBuilder()
  .setName('purrmission')
  .setDescription('Manage 2FA accounts and resources')
  .addSubcommandGroup(buildResourceSubcommandGroup())
  .addSubcommandGroup((group) =>
    group
      .setName('2fa')
      .setDescription('Manage 2FA accounts')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('add')
          .setDescription('Add a new 2FA account')
          .addStringOption((option) =>
            option
              .setName('account')
              .setDescription('Account name (e.g. Google, AWS)')
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('Input mode')
              .setRequired(true)
              .addChoices(
                { name: 'URI (otpauth://...)', value: 'uri' },
                { name: 'Secret Key (Base32)', value: 'secret' },
                { name: 'QR Code Image', value: 'qr' }
              )
          )
          .addStringOption((option) =>
            option
              .setName('secret')
              .setDescription('Base32 Secret (required if mode=secret)')
              .setRequired(false)
          )
          .addStringOption((option) =>
            option
              .setName('issuer')
              .setDescription('Issuer name (optional, overrides URI/default)')
              .setRequired(false)
          )
          .addBooleanOption((option) =>
            option
              .setName('shared')
              .setDescription('Whether this code is shared with the team')
              .setRequired(false)
          )
          .addAttachmentOption((option) =>
            option
              .setName('qr')
              .setDescription('QR Code image (required if mode=qr)')
              .setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('list')
          .setDescription('List your TOTP 2FA accounts')
          .addBooleanOption((option) =>
            option
              .setName('shared')
              .setDescription('Include shared accounts visible to you')
              .setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('get')
          .setDescription('Get a TOTP code for one of your accounts')
          .addStringOption((option) =>
            option
              .setName('account')
              .setDescription('Account name')
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addBooleanOption((option) =>
            option
              .setName('backup')
              .setDescription('Get the backup key instead of a TOTP code')
              .setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('update')
          .setDescription('Update a TOTP account (e.g. add backup key)')
          .addStringOption((option) =>
            option
              .setName('account')
              .setDescription('Account name')
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addStringOption((option) =>
            option
              .setName('backup_key')
              .setDescription('Backup key / recovery code to store')
              .setRequired(true)
          )
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName('guardian')
      .setDescription('Manage guardians for resources')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('add')
          .setDescription('Add a guardian to a protected resource')
          .addStringOption((option) =>
            option
              .setName('resource-id')
              .setDescription('ID of the resource')
              .setRequired(true)
          )
          .addUserOption((option) =>
            option
              .setName('user')
              .setDescription('User to add as guardian')
              .setRequired(true)
          )
      )
  );

export async function handlePurrmissionCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommandGroup === 'resource') {
    await handleResourceCommand(interaction, context);
    return;
  }

  if (subcommandGroup === 'guardian') {
    if (subcommand === 'add') {
      await handleAddGuardian(interaction, context.services);
      return;
    }
  }

  if (subcommandGroup !== '2fa') {
    await interaction.reply({
      content: 'Unsupported subcommand group for /purrmission.',
      ephemeral: true,
    });
    return;
  }

  if (subcommand === 'add') {
    await handleAdd2FA(interaction, context);
  } else if (subcommand === 'list') {
    await handleList2FA(interaction, context);
  } else if (subcommand === 'get') {
    await handleGet2FA(interaction, context);
  } else if (subcommand === 'update') {
    await handleUpdate2FA(interaction, context);
  } else {
    await interaction.reply({
      content: 'Unsupported subcommand for /purrmission 2fa.',
      ephemeral: true,
    });
  }
}

export async function handlePurrmissionAutocomplete(
  interaction: AutocompleteInteraction,
  context: CommandContext
): Promise<void> {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommandGroup === 'resource') {
    await handleResourceAutocomplete(interaction, context);
    return;
  }

  if (subcommandGroup !== '2fa') {
    return;
  }

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

  // Load accounts visible to this user:
  const personalAccounts = await totpRepository.findByOwnerDiscordUserId(ownerDiscordUserId);
  const sharedAccounts = await totpRepository.findSharedVisibleTo(ownerDiscordUserId);

  // Merge + dedupe by accountName, preferring personal first
  const accountMap = new Map<string, TOTPAccount>();
  personalAccounts.forEach((acc) => accountMap.set(acc.accountName, acc));
  sharedAccounts.forEach((acc) => {
    if (!accountMap.has(acc.accountName)) {
      accountMap.set(acc.accountName, acc);
    }
  });
  const allAccounts = Array.from(accountMap.values());

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

async function handleGet2FA(
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
      action: 'TOTP_ACCESS_THROTTLED',
      resourceId: null, // No resource ID for direct TOTP access
      actorId: requesterId,
      status: 'DENIED',
      context: JSON.stringify({ reason: 'Rate limit exceeded', accountName }),
    });
    return;
  }

  // Resolve account: personal first, then shared
  const personal = await totpRepository.findByOwnerAndName(requesterId, accountName);
  let account: TOTPAccount | null = personal;

  if (!account) {
    const sharedAccounts = await totpRepository.findSharedVisibleTo(requesterId);
    account = sharedAccounts.find((a) => a.accountName === accountName) ?? null;
  }

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
        content: `❌ No backup key found for **${account.accountName}**. You can add one with \`/purrmission 2fa update\`.`,
        ephemeral: true,
      });
      return;
    }

    try {
      const dm = await interaction.user.createDM();
      await dm.send(
        [
          `🔐 Your backup key for **${account.accountName}**:`,
          '',
          `\`${account.backupKey}\``,
          '',
          '_Keep this key safe and do not share it._',
        ].join('\n')
      );

      await interaction.reply({
        content: '✅ Backup key sent to your DMs.',
        ephemeral: true,
      });
    } catch (error) {
      logger.error('Failed to DM backup key:', error);
      await interaction.reply({
        content:
          "⚠️ I couldn't send you a DM (DMs may be disabled). Please enable DMs from this server and try again.",
        ephemeral: true,
      });
    }
    return;
  }

  // Generate TOTP code
  const code = generateTOTPCode(account);

  // Try to DM the user
  try {
    const dm = await interaction.user.createDM();
    await dm.send(
      [
        `🔐 Your TOTP code for **${account.accountName}**:`,
        '',
        `**${code}**`,
        '',
        '_Code is time-based and will expire soon._',
      ].join('\n')
    );

    await interaction.reply({
      content: '✅ TOTP code sent to your DMs.',
      ephemeral: true,
    });
  } catch (error) {
    logger.error('Failed to DM TOTP code:', error);
    await interaction.reply({
      content:
        "⚠️ I couldn't send you a DM (DMs may be disabled). Please enable DMs from this server and try again.",
      ephemeral: true,
    });
  }
}

async function handleList2FA(
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
        ? '📭 You don’t have any 2FA accounts yet, and no shared accounts are visible to you.'
        : '📭 You don’t have any 2FA accounts yet.',
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
      content:
        '📭 You don’t have any additional shared 2FA accounts visible to you beyond your own.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: lines.join('\n'),
    ephemeral: true,
  });
}

async function handleAdd2FA(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const account = interaction.options.getString('account', true);
  const mode = interaction.options.getString('mode', true);
  const uri = interaction.options.getString('uri', false) ?? undefined;
  const secret = interaction.options.getString('secret', false) ?? undefined;
  const issuer = interaction.options.getString('issuer', false) ?? undefined;
  const shared = interaction.options.getBoolean('shared', false) ?? false;
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

      const accountData = createTOTPAccountFromUri(ownerDiscordUserId, uri, shared);
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

      const accountData = createTOTPAccountFromSecret(
        ownerDiscordUserId,
        account,
        secret,
        issuer,
        shared
      );
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
        shared ? '🔓 This account is marked as **shared**.' : '🔒 This account is **personal**.',
        '',
        '_Note: You can now retrieve codes using `/purrmission 2fa get`._',
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

async function handleUpdate2FA(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const accountName = interaction.options.getString('account', true);
  const backupKey = interaction.options.getString('backup_key', true);
  const requesterId = interaction.user.id;
  const { totp: totpRepository } = context.repositories;

  // Only owner can update backup key in v0.0.1
  // We check personal accounts first, then shared, but ensure ownership.
  let account = await totpRepository.findByOwnerAndName(requesterId, accountName);

  if (!account) {
    // Check shared accounts too, but we verify ownership next
    const sharedAccounts = await totpRepository.findSharedVisibleTo(requesterId);
    account = sharedAccounts.find((a) => a.accountName === accountName) ?? null;
  }

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
