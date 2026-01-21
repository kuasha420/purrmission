import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load local .env first
dotenv.config();

/**
 * If core configuration is missing, search upward for a root .env file.
 * This supports nested application structures during development where the
 * .env file typically resides at the repository root.
 */
const CORE_VARS = ['DATABASE_URL', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];
const isMissingCore = CORE_VARS.some((v) => !process.env[v]);

if (isMissingCore) {
  const __filename = fileURLToPath(import.meta.url);
  let currentDir = path.dirname(__filename);

  // Search upward until we find a .env file or reach the filesystem root
  while (currentDir !== path.dirname(currentDir)) {
    const candidatePath = path.join(currentDir, '.env');
    if (fs.existsSync(candidatePath)) {
      dotenv.config({ path: candidatePath });
      break;
    }
    currentDir = path.dirname(currentDir);
  }
}

/**
 * Environment configuration schema using Zod for validation.
 * All environment variables are validated at startup to ensure
 * the application has all required configuration.
 */
const coreSchema = z.object({
  // Discord Configuration
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_GUILD_ID: z.string().min(1, 'DISCORD_GUILD_ID is required'),
  DISCORD_ANNOUNCE_CHANNEL_ID: z.string().min(1, 'DISCORD_ANNOUNCE_CHANNEL_ID is required'),

  // HTTP Server Configuration
  APP_PORT: z.coerce.number().default(3000),
  EXTERNAL_API_URL: z.string().url().default('http://localhost:3000'),

  // Database Configuration
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

const encryptionSchema = z.object({
  // Encryption Configuration (required for encrypting TOTP secrets and resource fields at rest)
  // 32-byte hex string (64 characters)
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be a 64-character hexadecimal string'),
});

export const fullSchema = coreSchema.merge(encryptionSchema);

/**
 * Validated environment configuration.
 * Uses a getter for ENCRYPTION_KEY to decouple encryption validation from general startup.
 * This allows utility scripts (like command registration) to run without the encryption key
 * as long as they don't attempt to use encryption features.
 */
function loadEnv() {
  const coreResult = coreSchema.safeParse(process.env);

  if (!coreResult.success) {
    console.error('❌ Invalid core environment configuration:');
    console.error(coreResult.error.format());
    process.exit(1);
  }

  const env = {
    ...coreResult.data,
    get ENCRYPTION_KEY() {
      const result = encryptionSchema.safeParse(process.env);
      if (!result.success) {
        // Return undefined instead of crashing immediately, allowing callers to handle or
        // the startup validator to catch it.
        return undefined as unknown as string; // Assert as string to match Env type
      }
      return result.data.ENCRYPTION_KEY;
    },
  };

  return env as z.infer<typeof fullSchema>;
}

export const env = loadEnv();

export type Env = z.infer<typeof fullSchema>;
