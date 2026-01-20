const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Explicitly load from project root
const envPath = path.resolve(__dirname, '../.env');

if (!fs.existsSync(envPath)) {
    console.error(`❌ .env file missing at ${envPath}`);
    process.exit(1);
}

const result = dotenv.config({ path: envPath });

if (result.error) {
    console.error('❌ Failed to parse .env file');
    process.exit(1);
}

const REQUIRED_KEYS = [
    'DATABASE_URL',
    'DISCORD_BOT_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'ENCRYPTION_KEY'
];

const missing = REQUIRED_KEYS.filter(key => !process.env[key]);

if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
}

console.log('✅ Environment validation passed');
