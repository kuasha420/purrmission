import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type SlashCommandSubcommandBuilder,
} from 'discord.js';

import type { CommandContext } from './context.js';
import {
    createTOTPAccountFromSecret,
    createTOTPAccountFromUri,
} from '../../domain/totp.js';

export const purrmissionCommand = new SlashCommandBuilder()
    .setName('purrmission')
    .setDescription('Manage 2FA accounts')
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
                    // Conditional options based on mode (discord doesn't support conditional params well, so we make them optional)
                    .addStringOption((option) =>
                        option
                            .setName('uri')
                            .setDescription('OTP Auth URI (required if mode=uri)')
                            .setRequired(false)
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
    );

import type { TOTPAccount } from '../../domain/models.js';

export async function handlePurrmissionCommand(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);

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
    } else {
        await interaction.reply({
            content: 'Unsupported subcommand for /purrmission 2fa.',
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

    const personalAccounts = await totpRepository.findByOwnerDiscordUserId(
        ownerDiscordUserId
    );

    let sharedAccounts: TOTPAccount[] = [];
    if (includeShared) {
        sharedAccounts = await totpRepository.findSharedVisibleTo(ownerDiscordUserId);
    }

    if (
        personalAccounts.length === 0 &&
        (!includeShared || sharedAccounts.length === 0)
    ) {
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

            const accountData = createTOTPAccountFromUri(
                ownerDiscordUserId,
                uri,
                shared
            );
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
                    content:
                        '❌ You selected mode `secret` but did not provide a `secret` value.',
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
                content:
                    '📷 QR mode is not implemented yet. Please use `uri` or `secret` mode for now.',
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
                shared
                    ? '🔓 This account is marked as **shared**.'
                    : '🔒 This account is **personal**.',
                '',
                '_Note: TOTP codes can be retrieved later via `/purrmission 2fa get` (coming soon)._',
            ].join('\n'),
            ephemeral: true,
        });
    } catch (error) {
        console.error(error);
        await interaction.reply({
            content:
                '❌ Failed to add 2FA account. Please check your input (otpauth URI or secret) and try again.',
            ephemeral: true,
        });
    }
}
