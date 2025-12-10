import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration schema using Zod for validation.
 * All environment variables are validated at startup to ensure
 * the application has all required configuration.
 */
const envSchema = z.object({
  // Discord Configuration
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_GUILD_ID: z.string().min(1, 'DISCORD_GUILD_ID is required'),

  // HTTP Server Configuration
  APP_PORT: z.coerce.number().default(3000),
});

/**
 * Validated environment configuration.
 * Throws an error at startup if required environment variables are missing.
 */
function loadEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();

export type Env = z.infer<typeof envSchema>;
