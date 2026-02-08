import { Interaction, EmbedBuilder, ChannelType, TextChannel, ButtonInteraction } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logging/logger.js';

export async function handleInteractionCreate(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;

    // ModMail Close Confirmation
    if (interaction.customId === 'confirm_close') {
        await handleCloseConfirmation(interaction);
    }
}

async function handleCloseConfirmation(interaction: ButtonInteraction): Promise<void> {
    // any type used for now as interaction is generic, but we know it's a ButtonInteraction
    // and we need access to message content etc.

    // Extract reason from message
    // Legacy: "✅ Click the button below to confirm closing this ticket.\n**Reason:** ${reason}"
    const reasonMatch = interaction.message.content.match(/\*\*Reason:\*\* (.*)/);
    const reason = reasonMatch ? reasonMatch[1] : 'No reason provided';

    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const userId = channel.topic?.match(/\((\d+)\)/)?.[1];

    // DM the user
    if (userId) {
        try {
            const user = await interaction.client.users.fetch(userId);
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('🔒 Ticket Closed')
                .setDescription(`Your ticket has been closed by staff.\n**Reason:** ${reason}`)
                .setTimestamp();
            await user.send({ embeds: [embed] });
        } catch (e) {
            logger.error('Failed to DM user on close', { error: e instanceof Error ? e.message : String(e) });
        }
    }

    // Log action
    if (config.logChannelId) {
        const logChannel = interaction.guild?.channels.cache.get(config.logChannelId) as TextChannel | undefined;
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('Ticket Closed')
                .addFields(
                    { name: 'Channel', value: channel.name, inline: true },
                    { name: 'Closed By', value: interaction.user.tag, inline: true },
                    { name: 'Reason', value: reason }
                )
                .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
        }
    }

    await interaction.update({ content: '✅ Ticket will be deleted shortly...', components: [] });
    setTimeout(() => channel.delete().catch(() => { }), 5000);
}
