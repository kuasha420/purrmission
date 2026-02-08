import {
    Message,
    ChannelType,
    EmbedBuilder,
    TextChannel,
    PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logging/logger.js';

export async function handleMessageCreate(message: Message): Promise<void> {
    if (message.author.bot) return;

    // Handle DMs - ModMail System
    if (message.channel.type === ChannelType.DM) {
        await handleDMMessage(message);
        return;
    }

    // Handle staff replies in ticket channels
    if (
        message.guild &&
        config.categoryId &&
        message.channel.type === ChannelType.GuildText &&
        message.channel.parentId === config.categoryId
    ) {
        await handleStaffReply(message);
    }
}

async function handleDMMessage(message: Message): Promise<void> {
    const guild = message.client.guilds.cache.first();
    if (!guild) return;

    const categoryId = config.categoryId;
    if (!categoryId) {
        await message.reply('❌ ModMail system is not configured.');
        return;
    }

    // Check if user already has a ticket
    const cleanUsername = message.author.username
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-');

    // Find ticket channel by topic
    let ticketChannel = guild.channels.cache.find(
        (ch) =>
            ch.parentId === categoryId &&
            ch.type === ChannelType.GuildText &&
            Boolean(ch.topic?.includes(message.author.id))
    ) as TextChannel | undefined;

    // Create new ticket if doesn't exist
    if (!ticketChannel) {
        try {
            // TODO: Check ban status if needed
            const channelName = `ticket-${cleanUsername}`;

            ticketChannel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: categoryId,
                topic: `ModMail ticket for ${message.author.tag} (${message.author.id})`,
                permissionOverwrites: [
                    {
                        id: guild.id,
                        deny: [PermissionFlagsBits.ViewChannel],
                    },
                    {
                        id: message.client.user?.id ?? '', // Safe fallback, though unlikely to be null if logged in
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel],
                    }
                ]
            });

            const welcomeEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('📨 New ModMail Ticket')
                .setDescription(
                    `**User:** ${message.author.tag} (${message.author.id})\n**Account Created:** <t:${Math.floor(
                        message.author.createdTimestamp / 1000
                    )}:R>`
                )
                .setThumbnail(message.author.displayAvatarURL())
                .setTimestamp();

            await ticketChannel.send({ embeds: [welcomeEmbed] });
            await message.react('✅');
        } catch (error) {
            logger.error('Error creating ticket:', {
                error: error instanceof Error ? error.message : String(error),
            });
            await message.reply(
                '❌ Failed to create ticket. Please contact an administrator.'
            );
            return;
        }
    }

    // Forward message to ticket channel
    const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setAuthor({
            name: message.author.tag,
            iconURL: message.author.displayAvatarURL(),
        })
        .setDescription(message.content || '*[No text content]*')
        .setFooter({ text: `User ID: ${message.author.id}` })
        .setTimestamp();

    // Handle Image Attachment
    const imageAttachment = message.attachments.find(
        (a) => a.contentType && a.contentType.startsWith('image/')
    );
    if (imageAttachment) {
        embed.setImage(imageAttachment.url);
    }

    const otherAttachments = message.attachments
        .filter((a) => !a.contentType || !a.contentType.startsWith('image/'))
        .map((a) => a.url);

    try {
        await ticketChannel.send({
            content: message.content, // Content outside embed for mentions/previews
            embeds: [embed],
            files: otherAttachments,
        });
    } catch (error) {
        console.error('Error forwarding message:', error);
    }
}

async function handleStaffReply(message: Message): Promise<void> {
    if (message.content.startsWith('!')) return; // Ignore legacy commands for now

    if (message.channel.type !== ChannelType.GuildText) return;

    const userId = message.channel.topic?.match(/\((\d+)\)/)?.[1];
    if (!userId) return;

    try {
        const user = await message.client.users.fetch(userId);
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setAuthor({
                name: 'Staff Reply',
                iconURL: message.author.displayAvatarURL(),
            })
            .setDescription(message.content || '*[No text content]*')
            .setTimestamp();

        const imageAttachment = message.attachments.find(
            (a) => a.contentType && a.contentType.startsWith('image/')
        );
        if (imageAttachment) {
            embed.setImage(imageAttachment.url);
        }

        const otherAttachments = message.attachments
            .filter((a) => !a.contentType || !a.contentType.startsWith('image/'))
            .map((a) => a.url);

        await user.send({
            content: message.content,
            embeds: [embed],
            files: otherAttachments,
        });
        await message.react('✅');
    } catch (error) {
        await message.react('❌');
        logger.error('Error sending reply to user', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
