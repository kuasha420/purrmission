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

    // Parse file path from URL robustly for SQLite
    if (!dbUrl.startsWith('file:')) {
        throw new Error('backup-db script only supports SQLite (DATABASE_URL must start with file:)');
    }

    // Remove 'file:' prefix. Handle both file:./path and file:///path
    // Prisma uses file:./path for relative and file:/path or file:///path for absolute.
    let dbPath = dbUrl.replace(/^file:/, '');

    // If it starts with ///, it's an absolute path (e.g. file:///path/to/db)
    if (dbPath.startsWith('///')) {
        dbPath = dbPath.slice(2); // Keep one / for absolute path
    } else if (dbPath.startsWith('//')) {
        // file://localhost/path or file://path -> usually interpreted as absolute path /path
        dbPath = dbPath.slice(1);
    }
    // Otherwise it's something like ./path or ../path or /path

    // Remove query parameters (Prisma supports them, e.g. ?connection_limit=1)
    dbPath = dbPath.split('?')[0];

    // Resolve absolute path relative to CWD
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
    logger.info('✅ Backup completed successfully.');

    return backupPath;
}

// Allow running directly
if (process.argv[1] === import.meta.filename) {
    backupDatabase().catch(err => {
        console.error('❌ Backup failed:', err);
        process.exit(1);
    });
}
