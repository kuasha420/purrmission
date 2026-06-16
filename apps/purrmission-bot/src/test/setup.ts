// Set up mock environment variables for tests if not already set
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'mock';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'mock';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'mock';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./data/dev.db';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || '000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f';
