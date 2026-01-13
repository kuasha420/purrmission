
import { ChatInputCommandInteraction } from 'discord.js';
import { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';

export async function handleAuthLogin(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const code = interaction.options.getString('code', true).toUpperCase().trim();
    const userId = interaction.user.id;

    try {
        const success = await context.services.auth.approveSession(code, userId);

        if (success) {
            await interaction.reply({
                content: `✅ Successfully authenticated! Your CLI session is now approved.\nLinked to Discord User: <@${userId}>`,
                ephemeral: true,
            });

            logger.info('Approved CLI session', {
                userId,
                userCode: code
            });
        } else {
            await interaction.reply({
                content: '❌ Failed to approve session. The code may be invalid, expired, or already approved.',
                ephemeral: true,
            });
        }
    } catch (error: any) {
        logger.error('Error handling auth login', {
            message: error.message,
            stack: error.stack
        });
        await interaction.reply({
            content: '❌ An internal error occurred while processing your login.',
            ephemeral: true,
        });
    }
}
