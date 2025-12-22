import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { logger } from '../src/logging/logger.js';

/**
 * Backup the SQLite database.
 * Copies the .db file to a backups/ directory with a timestamp.
 * 
 * @returns The absolute path to the backup file
 */
export async function backupDatabase(): Promise<string> {
    const dbUrl = env.DATABASE_URL;

    if (!dbUrl.startsWith('file:')) {
        logger.warn('⚠️ Backup skipped: DATABASE_URL does not start with "file:", assuming non-SQLite DB.');
        throw new Error('Automated backup only supported for SQLite (file: protocol)');
    }

    // Parse file path from URL
    // e.g. "file:./dev.db" -> "./dev.db"
    // e.g. "file:../prisma/dev.db"
    let dbPath = dbUrl.slice(5);

    // Resolve absolute path relative to CWD (which should be app root or where env is loaded)
    // We assume CWD is the app root (apps/purrmission-bot) or project root.
    // The safest is to resolve relative to process.cwd()
    const absoluteDbPath = path.resolve(process.cwd(), dbPath);

    if (!fs.existsSync(absoluteDbPath)) {
        throw new Error(`Database file not found at: ${absoluteDbPath}`);
    }

    const backupDir = path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.basename(absoluteDbPath);
    const backupName = `${path.parse(filename).name}-${timestamp}${path.parse(filename).ext}`;
    const backupPath = path.join(backupDir, backupName);

    logger.info(`📦 Backing up database to: ${backupPath}`);
    fs.copyFileSync(absoluteDbPath, backupPath);
    logger.info('✅ Backup check successful.');

    return backupPath;
}

// Allow running directly
if (process.argv[1] === import.meta.filename) {
    backupDatabase().catch(err => {
        console.error('❌ Backup failed:', err);
        process.exit(1);
    });
}
