import fs from 'node:fs';
import path from 'node:path';

// Set up mock environment variables for tests if not already set
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'mock';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'mock';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'mock';

// Ensure the directory for SQLite file exists
const dbPath = process.env.DATABASE_URL || 'file:./data/dev.db';
const relativePath = dbPath.replace('file:', '');
const absolutePath = path.resolve(relativePath);
const absoluteDir = path.dirname(absolutePath);
if (!fs.existsSync(absoluteDir)) {
  fs.mkdirSync(absoluteDir, { recursive: true });
}

process.env.DATABASE_URL = `file:${absolutePath}`;
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || '000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f';
