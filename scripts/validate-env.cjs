const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

// 1. Identify Environment File
const envPath = path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
    console.error(`❌ CRITICAL: .env file missing in project root (${envPath})`);
    console.error(`   The deployment cannot proceed without a root configuration.`);
    process.exit(1);
}

// 2. Load Environment
const result = dotenv.config({ path: envPath });
if (result.error) {
    console.error('❌ CRITICAL: Failed to parse .env file. Ensure it is valid key=value format.');
    process.exit(1);
}

// 3. Define Requirements using Zod
const envSchema = z.object({
    DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
    DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
    DISCORD_GUILD_ID: z.string().min(1, 'DISCORD_GUILD_ID is required'),
    ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be a 64-character hexadecimal string'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    APP_PORT: z.coerce.number().optional().default(3000),
});

// 4. Validate Environment
const validation = envSchema.safeParse(process.env);

if (!validation.success) {
    console.error('❌ CRITICAL: Invalid environment configuration:');
    const formatted = validation.error.format();
    Object.keys(formatted).forEach(key => {
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
    // SQLite Specific Enforcement
    // We expect patterns like: file:./data/prod.db (relative to CWD) OR file:../data/prod.db (relative to prisma/)

    const isFragile = DATABASE_URL.includes('/prisma/') ||
        DATABASE_URL.includes('/apps/') ||
        DATABASE_URL.includes('/dist/') ||
        DATABASE_URL.includes('./dev.db'); // default dev name

    if (isFragile) {
        console.error('❌ CRITICAL: DATABASE_URL points to a volatile directory.');
        console.error(`   Current value: ${DATABASE_URL}`);
        console.error('   Deployment will result in DATA LOSS as these directories are flushed.');
        console.error('   FIX: Update .env to use DATABASE_URL="file:../data/purrmission.db"');
        process.exit(1);
    }

    if (!DATABASE_URL.includes('/data/')) {
        console.error('❌ CRITICAL: DATABASE_URL must point to the "data/" directory for persistence.');
        console.error('   FIX: Update .env to use DATABASE_URL="file:../data/purrmission.db"');
        process.exit(1);
    }
}

console.log('✅ Environment and Persistence validation passed.');
