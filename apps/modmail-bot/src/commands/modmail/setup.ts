import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../types/command.js';
import { logger } from '../../logging/logger.js';

export const setupCommand: Command = {
    data: new SlashCommandBuilder()
        .setName('modmail-setup')
        .setDescription('Setup ModMail category')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.guild) {
            await interaction.reply({
                content: '❌ This command can only be used in a server.',
                ephemeral: true,
            });
            return;
        }

        try {
            const guild = interaction.guild;

            // Create Category
            const category = await guild.channels.create({
                name: 'ModMail Tickets',
                type: ChannelType.GuildCategory,
            });

            // Create Log Channel
            const logChannel = await guild.channels.create({
                name: 'modmail-logs',
                type: ChannelType.GuildText,
                parent: category.id,
                permissionOverwrites: [
                    {
                        id: guild.id,
                        deny: [PermissionFlagsBits.ViewChannel],
                    },
                ],
            });

            await interaction.reply({
                content: `✅ ModMail Setup Complete!\n\n**Category ID:** \`${category.id}\`\n**Log Channel ID:** \`${logChannel.id}\`\n\nPlease update your \`.env\` file with these IDs:\n\`\`\`env\nMODMAIL_CATEGORY_ID=${category.id}\nLOG_CHANNEL_ID=${logChannel.id}\n\`\`\``,
                ephemeral: true,
            });
        } catch (error) {
            logger.error('Failed to setup ModMail', {
                error: error instanceof Error ? error.message : String(error),
            });
            await interaction.reply({
                content: '❌ Failed to setup ModMail.',
                ephemeral: true,
            });
        }
    },
};
