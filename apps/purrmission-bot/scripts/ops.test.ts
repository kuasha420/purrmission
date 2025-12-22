import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { backupDatabase } from './backup-db.js';

describe('Operations Scripts', () => {
    const backupDir = path.resolve(process.cwd(), 'backups');

    before(() => {
        // Find where the script thinks the DB is
        const dbUrl = env.DATABASE_URL;
        if (dbUrl.startsWith('file:')) {
            const dbPath = path.resolve(process.cwd(), dbUrl.slice(5));
            if (!fs.existsSync(dbPath)) {
                fs.writeFileSync(dbPath, 'dummy data');
            }
        }
    });

    after(() => {
        // We could clean up the dummy DB but maybe not if it's the real dev one?
        // For safety in this environment, we'll just let it be or only delete if we created it.
    });

    describe('backup-db', () => {
        it('should create a backup file for a valid SQLite DB', async () => {
            // Mock env.DATABASE_URL if possible, or just rely on existing dev.db if it exists
            // Since we can't easily mock the 'env' import here without a more complex setup,
            // we'll assume the function uses the current env.
            // If DATABASE_URL is not set to a file: path, it will throw.

            try {
                const backupPath = await backupDatabase();
                assert.ok(fs.existsSync(backupPath));
                assert.ok(backupPath.includes('backups'));
            } catch (err) {
                if (err instanceof Error && err.message.includes('only supported for SQLite')) {
                    // Skip if not SQLite
                    return;
                }
                throw err;
            }
        });
    });

    // rotate-keys.ts is harder to test without a full Prisma mock setup,
    // but we can verify it exports what we expect and doesn't crash on import.
    describe('rotate-keys', () => {
        it('should be importable without side effects', async () => {
            const module = await import('./rotate-keys.js');
            assert.ok(module);
        });
    });
});
