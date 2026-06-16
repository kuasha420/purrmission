import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pullCommand } from './pull.js';
import { config } from '../config.js';

describe('Pull Command', () => {
    let exitCode: number | null = null;
    let tempDir: string;

    beforeEach(async () => {
        exitCode = null;

        // Reset commander options to prevent test pollution
        pullCommand.setOptionValue('file', '.env');
        pullCommand.setOptionValue('projectId', undefined);
        pullCommand.setOptionValue('envId', undefined);

        // Create a unique temp directory outside the repository
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy-test-'));

        // Mock process.cwd to return our temp directory
        mock.method(process, 'cwd', () => tempDir);

        // Mock process.exit
        mock.method(process, 'exit', (code?: number) => {
            exitCode = code ?? null;
            throw new Error(`process.exit called with ${code}`);
        });

        // Write a dummy .pawthyrc file in the temp directory
        await fs.writeFile(
            path.join(tempDir, '.pawthyrc'),
            JSON.stringify({ projectId: 'test-project', envId: 'test-env' })
        );
    });

    afterEach(async () => {
        mock.restoreAll();
        // Clean up the temp directory
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore
        }
    });

    it('should exit with code 1 when pull status is 202 (Pending Approval)', async () => {
        // Mock config.get for token
        mock.method(config, 'get', (key: string) => {
            if (key === 'token') return 'test-token';
            if (key === 'apiUrl') return 'http://localhost:3000';
            return undefined;
        });

        // Mock axios.get to return 202 status
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mock.method(axios, 'get', async (): Promise<any> => {
            return {
                status: 202,
                data: {
                    status: 'pending',
                    message: 'Secret access is pending approval in Discord',
                },
            };
        });

        // Suppress console.log / console.error for clean test output
        mock.method(console, 'log', () => {});
        mock.method(console, 'error', () => {});

        try {
            await pullCommand.parseAsync(['node', 'pawthy', 'pull']);
        } catch {
            // Expected to throw because process.exit throws
        }

        assert.strictEqual(exitCode, 1);
    });
});
