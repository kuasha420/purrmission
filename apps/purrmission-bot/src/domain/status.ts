/**
 * Service for sending bot status announcements to Discord.
 */

import {
    EmbedBuilder,
    Client,
    TextChannel,
    Colors,
    time,
    TimestampStyles
} from 'discord.js';
import { env } from '../config/env.js';
import { logger } from '../logging/logger.js';

export class StatusService {
    /**
     * Send an "Online" announcement to the configured channel.
     * 
     * @param client - The Discord client
     */
    async sendOnlineAnnouncement(client: Client): Promise<void> {
        const channelId = env.DISCORD_ANNOUNCE_CHANNEL_ID;
        if (!channelId) {
            logger.debug('No announcement channel configured, skipping online status message.');
            return;
        }

        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel?.isTextBased()) {
                logger.warn('Announcement channel is not text-based', { channelId });
                return;
            }

            const textChannel = channel as TextChannel;
            // Use configured external URL or fallback to localhost
            const apiUrl = env.EXTERNAL_API_URL || `http://localhost:${env.APP_PORT}`;

            const embed = new EmbedBuilder()
                .setTitle('🐱 Purrmission Bot - Online')
                .setDescription(`The bot is now online and protecting your resources! Built with 💖 by the PurrfectSoft Team.`)
                .setColor(Colors.Green)
                .setThumbnail(client.user?.displayAvatarURL() ?? null)
                .addFields(
                    {
                        name: '🚀 Status',
                        value: `🟢 **Active** since ${time(new Date(), TimestampStyles.ShortDateTime)}`,
                        inline: true
                    },
                    {
                        name: '🌐 API Endpoint',
                        value: `[${apiUrl}](${apiUrl}/health)`,
                        inline: true
                    },
                    {
                        name: '📜 Useful Commands',
                        value: [
                            '• `/purrmission resource list` - View protected resources',
                            '• `/purrmission 2fa get` - Get your 2FA codes',
                            '• `/purrmission guardian add` - Add a resource guardian',
                            '• `/approve` - Approve a pending request (buttons preferred!)'
                        ].join('\n')
                    },
                    {
                        name: '🛡️ Need Help?',
                        value: 'Use `/purrmission help` or contact the infrastructure team.'
                    }
                )
                .setFooter({
                    text: `Purrmission v${process.env.npm_package_version || '1.0.0'} • PID: ${process.pid}`,
                    iconURL: client.user?.displayAvatarURL() ?? undefined
                })
                .setTimestamp();

            await textChannel.send({ embeds: [embed] });
            logger.info('Status announcement sent: Online', { channelId });
        } catch (error) {
            logger.error('Failed to send online announcement', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
        }
    }

    /**
     * Send an "Offline" announcement to the configured channel.
     * 
     * @param client - The Discord client
     * @param reason - Reason for going offline (e.g., "SIGTERM", "Restarting")
     */
    async sendOfflineAnnouncement(client: Client, reason: string): Promise<void> {
        const channelId = env.DISCORD_ANNOUNCE_CHANNEL_ID;
        if (!channelId) {
            logger.debug('No announcement channel configured, skipping offline status message.');
            return;
        }

        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel?.isTextBased()) {
                logger.warn('Announcement channel is not text-based', { channelId });
                return;
            }

            const textChannel = channel as TextChannel;

            const embed = new EmbedBuilder()
                .setTitle('🐱 Purrmission Bot - Offline')
                .setDescription('The bot is going offline for maintenance or a restart.')
                .setColor(Colors.Orange)
                .addFields(
                    {
                        name: '📡 System Note',
                        value: reason === 'SIGTERM' ? '🔄 **Restarting/Updating**' : '🛑 **Manual Shutdown**',
                        inline: true
                    },
                    {
                        name: '⏳ Expectation',
                        value: 'We should be back online within a minute. Hang tight!',
                        inline: true
                    }
                )
                .setFooter({ text: 'Purrmission Infrastructure' })
                .setTimestamp();

            await textChannel.send({ embeds: [embed] });
            logger.info('Status announcement sent: Offline', { channelId, reason });
        } catch (error) {
            logger.warn('Failed to send offline announcement', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
        }
    }
}
