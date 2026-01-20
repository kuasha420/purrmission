const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

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

// 3. Define Requirements
const REQUIRED_KEYS = [
    'DATABASE_URL',
    'DISCORD_BOT_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'ENCRYPTION_KEY'
];

// 4. Validate Presence
const missing = REQUIRED_KEYS.filter(key => !process.env[key]);
if (missing.length > 0) {
    console.error('❌ CRITICAL: Missing required environment variables in .env:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
}

// 5. Validate Encryption Key Format
if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY)) {
    console.error('❌ CRITICAL: ENCRYPTION_KEY must be a 64-character hexadecimal string.');
    process.exit(1);
}

// 6. Validate Persistence Location (ENFORCEMENT)
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl.startsWith('file:')) {
    console.warn('⚠️  Non-SQLite database detected. Ensure external DB persistence is handled.');
} else {
    // SQLite Specific Enforcement
    // We expect patterns like: file:./data/prod.db (relative to CWD) OR file:../data/prod.db (relative to prisma/)

    const isFragile = dbUrl.includes('/prisma/') ||
        dbUrl.includes('/apps/') ||
        dbUrl.includes('/dist/') ||
        dbUrl.includes('./dev.db'); // default dev name

    if (isFragile) {
        console.error('❌ CRITICAL: DATABASE_URL points to a volatile directory.');
        console.error(`   Current value: ${dbUrl}`);
        console.error('   Deployment will result in DATA LOSS as these directories are flushed.');
        console.error('   FIX: Update .env to use DATABASE_URL="file:../data/purrmission.db"');
        process.exit(1);
    }

    if (!dbUrl.includes('/data/')) {
        console.error('❌ CRITICAL: DATABASE_URL must point to the "data/" directory for persistence.');
        console.error('   FIX: Update .env to use DATABASE_URL="file:../data/purrmission.db"');
        process.exit(1);
    }
}

console.log('✅ Environment and Persistence validation passed.');
