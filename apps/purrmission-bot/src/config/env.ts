import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// If core variables are missing, try loading from project root
// This supports local development where .env is at the repository root
if (!process.env.DATABASE_URL) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const rootEnvPath = path.resolve(__dirname, '../../../../.env');
  dotenv.config({ path: rootEnvPath });
}
import { z } from 'zod';

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

  // HTTP Server Configuration
  APP_PORT: z.coerce.number().default(3000),

  // Database Configuration
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

const encryptionSchema = z.object({
  // Encryption Configuration (required for encrypting TOTP secrets and resource fields at rest)
  // 32-byte hex string (64 characters)
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be a 64-character hexadecimal string'),
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
