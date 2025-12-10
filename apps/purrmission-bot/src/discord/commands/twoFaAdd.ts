import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type SlashCommandSubcommandBuilder,
} from 'discord.js';

export const purrmissionCommand = new SlashCommandBuilder()
    .setName('purrmission')
    .setDescription('Purrmission utilities and 2FA management')
    .addSubcommandGroup((group) =>
        group
            .setName('2fa')
            .setDescription('Manage TOTP 2FA accounts')
            .addSubcommand((subcommand: SlashCommandSubcommandBuilder) =>
                subcommand
                    .setName('add')
                    .setDescription('Add a new TOTP 2FA account')
                    .addStringOption((option) =>
                        option
                            .setName('account')
                            .setDescription('Account name (e.g. GitHub, OpenSource inbox)')
                            .setRequired(true)
                    )
                    .addStringOption((option) =>
                        option
                            .setName('mode')
                            .setDescription('Input mode')
                            .setRequired(true)
                            .addChoices(
                                { name: 'URI (otpauth://)', value: 'uri' },
                                { name: 'Secret (BASE32)', value: 'secret' },
                                { name: 'QR image upload', value: 'qr' }
                            )
                    )
                    .addStringOption((option) =>
                        option
                            .setName('uri')
                            .setDescription('otpauth:// URI (if using URI mode)')
                            .setRequired(false)
                    )
                    .addStringOption((option) =>
                        option
                            .setName('secret')
                            .setDescription('Raw TOTP secret (BASE32) if using Secret mode')
                            .setRequired(false)
                    )
                    .addStringOption((option) =>
                        option
                            .setName('issuer')
                            .setDescription('Issuer / provider name (optional)')
                            .setRequired(false)
                    )
                    .addBooleanOption((option) =>
                        option
                            .setName('shared')
                            .setDescription('Mark this 2FA account as shared')
                            .setRequired(false)
                    )
                    .addAttachmentOption((option) =>
                        option
                            .setName('qr')
                            .setDescription('QR code image for this 2FA account')
                            .setRequired(false)
                    )
            )
    );

export async function handlePurrmissionCommand(
    interaction: ChatInputCommandInteraction
): Promise<void> {
    // Ensure we only handle /purrmission 2fa add here
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommandGroup !== '2fa' || subcommand !== 'add') {
        // For safety, ignore anything we don't explicitly handle.
        await interaction.reply({
            content: 'Unsupported subcommand for /purrmission at this time.',
            ephemeral: true,
        });
        return;
    }

    const account = interaction.options.getString('account', true);
    const mode = interaction.options.getString('mode', true);
    const uri = interaction.options.getString('uri', false) ?? undefined;
    const secret = interaction.options.getString('secret', false) ?? undefined;
    const issuer = interaction.options.getString('issuer', false) ?? undefined;
    const shared = interaction.options.getBoolean('shared', false) ?? false;
    const qrAttachment = interaction.options.getAttachment('qr', false) ?? undefined;

    // MVP stub: just echo back the parameters, no persistence yet.
    // Later missions will:
    // - parse URI / secret
    // - decode QR
    // - create TOTPAccount via TOTPRepository

    const summaryLines = [
        `**Account:** ${account}`,
        `**Mode:** ${mode}`,
        issuer ? `**Issuer:** ${issuer}` : null,
        shared ? `**Shared:** yes` : `**Shared:** no`,
        uri ? `**URI provided:** yes` : `**URI provided:** no`,
        secret ? `**Secret provided:** yes` : `**Secret provided:** no`,
        qrAttachment ? `**QR uploaded:** ${qrAttachment.name}` : `**QR uploaded:** no`,
    ].filter(Boolean) as string[];

    await interaction.reply({
        content: [
            '🧩 2FA add request received.',
            '',
            ...summaryLines,
            '',
            '_TOTP account creation not wired yet – this is a structural stub._',
        ].join('\n'),
        ephemeral: true,
    });
}
