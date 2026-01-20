const fs = require('fs');
const path = require('path');
// 1. Identify Environment File
const envPath = process.env.ENV_PATH_OVERRIDE || path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.error(`❌ CRITICAL: .env file missing at ${envPath}`);
  process.exit(1);
}

const dotenv = require('dotenv');
const { z } = require('zod');

// 2. Load Environment
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.error('❌ CRITICAL: Failed to parse .env file. Ensure it is valid key=value format.');
  process.exit(1);
}

// 3. Define Requirements using Zod
const envSchema = z.object({
  DISCORD_BOT_TOKEN: z
    .string({ required_error: 'DISCORD_BOT_TOKEN is required' })
    .min(1, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_CLIENT_ID: z
    .string({ required_error: 'DISCORD_CLIENT_ID is required' })
    .min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_GUILD_ID: z
    .string({ required_error: 'DISCORD_GUILD_ID is required' })
    .min(1, 'DISCORD_GUILD_ID is required'),
  ENCRYPTION_KEY: z
    .string({ required_error: 'ENCRYPTION_KEY is required' })
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be a 64-character hexadecimal string'),
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required'),
  APP_PORT: z.coerce.number().optional().default(3000),
});

// 4. Validate Environment
const validation = envSchema.safeParse(process.env);

if (!validation.success) {
  console.error('❌ CRITICAL: Invalid environment configuration:');
  const formatted = validation.error.format();
  Object.keys(formatted).forEach((key) => {
    if (key === '_errors') return;
    if (formatted[key] && formatted[key]._errors && formatted[key]._errors.length > 0) {
      console.error(`   - ${key}: ${formatted[key]._errors.join(', ')}`);
    }
  });
  process.exit(1);
}

const { DATABASE_URL } = validation.data;

// 5. Validate Persistence Location (ENFORCEMENT)
if (!DATABASE_URL.startsWith('file:')) {
  console.warn('⚠️  Non-SQLite database detected. Ensure external DB persistence is handled.');
} else {
  // 5a. Extract path from file: prefix
  const dbFilePath = DATABASE_URL.replace(/^file:/, '');
  const absoluteDbPath = path.resolve(process.cwd(), dbFilePath);
  const dbDir = path.dirname(absoluteDbPath);
  const pathSegments = dbDir.split(path.sep);

  // 5b. Check for fragile directory segments
  const volatileSegments = ['prisma', 'apps', 'dist', 'node_modules'];
  const hitVolatile = pathSegments.some((seg) => volatileSegments.includes(seg.toLowerCase()));

  // Specific check for default dev name if directly in cwd
  const isDefaultDev = path.basename(absoluteDbPath) === 'dev.db' && dbDir === process.cwd();

  if (hitVolatile || isDefaultDev) {
    console.error('❌ CRITICAL: DATABASE_URL points to a volatile directory.');
    console.error(`   Identified Path: ${absoluteDbPath}`);
    console.error('   Deployment will result in DATA LOSS as these directories are flushed.');
    console.error('   FIX: Update .env to use DATABASE_URL="file:../data/purrmission.db"');
    process.exit(1);
  }

  // 5c. Enforce "data/" directory usage for SQLite
  if (!pathSegments.includes('data')) {
    console.error(
      '❌ CRITICAL: DATABASE_URL must point to a file inside a "data/" directory for persistence.'
    );
    console.error('   FIX: Update .env to use DATABASE_URL="file:../data/purrmission.db"');
    process.exit(1);
  }
}

console.log('✅ Environment and Persistence validation passed.');
