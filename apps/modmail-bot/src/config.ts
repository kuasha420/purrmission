import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
    DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
    DISCORD_GUILD_ID: z.string().optional(),
    MODMAIL_LOG_CHANNEL_ID: z.string().optional(),
    MODMAIL_CATEGORY_ID: z.string().optional(),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
    console.error('❌ Invalid environment variables:', JSON.stringify(_env.error.format(), null, 2));
    process.exit(1);
}

export const config = {
    discordToken: _env.data.DISCORD_TOKEN,
    guildId: _env.data.DISCORD_GUILD_ID,
    logChannelId: _env.data.MODMAIL_LOG_CHANNEL_ID,
    categoryId: _env.data.MODMAIL_CATEGORY_ID,
};
