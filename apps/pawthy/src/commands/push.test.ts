import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pushCommand } from './push.js';
import { config } from '../config.js';

describe('Push Command', () => {
    let exitCode: number | null = null;
    let tempDir: string;

    beforeEach(async () => {
        exitCode = null;

        // Reset commander options to prevent test pollution
        pushCommand.setOptionValue('file', '.env');
        pushCommand.setOptionValue('force', undefined);
        pushCommand.setOptionValue('projectId', undefined);
        pushCommand.setOptionValue('envId', undefined);

        // Create a unique temp directory outside the repository
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy-test-push-'));

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

        // Write a dummy .env file
        await fs.writeFile(path.join(tempDir, '.env'), 'MY_VAR=value');
    });

    afterEach(async () => {
        mock.restoreAll();
        // Clean up environment variables to prevent test pollution
        delete process.env.PAWTHY_PROJECT_ID;
        delete process.env.PAWTHY_ENV_ID;

        // Clean up the temp directory
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore
        }
    });

    it('should prioritize CLI flags over env vars and .pawthyrc', async () => {
        let requestedUrl = '';
        mock.method(config, 'get', (key: string) => {
            if (key === 'token') return 'test-token';
            if (key === 'apiUrl') return 'http://localhost:3000';
            return undefined;
        });

        // Set env vars
        process.env.PAWTHY_PROJECT_ID = 'env-project';
        process.env.PAWTHY_ENV_ID = 'env-env';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mock.method(axios, 'put', async (url: string): Promise<any> => {
            requestedUrl = url;
            return {
                status: 200,
                data: { success: true },
            };
        });

        mock.method(console, 'log', () => {});
        mock.method(console, 'error', () => {});

        await pushCommand.parseAsync([
            'node',
            'pawthy',
            'push',
            '--force',
            '-p',
            'flag-project',
            '-e',
            'flag-env',
        ]);

        // Verify the URL contained the flag values
        assert.ok(requestedUrl.includes('/projects/flag-project/environments/flag-env/secrets'));
    });

    it('should prioritize .pawthyrc over env vars', async () => {
        let requestedUrl = '';
        mock.method(config, 'get', (key: string) => {
            if (key === 'token') return 'test-token';
            if (key === 'apiUrl') return 'http://localhost:3000';
            return undefined;
        });

        // Set env vars
        process.env.PAWTHY_PROJECT_ID = 'env-project';
        process.env.PAWTHY_ENV_ID = 'env-env';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mock.method(axios, 'put', async (url: string): Promise<any> => {
            requestedUrl = url;
            return {
                status: 200,
                data: { success: true },
            };
        });

        mock.method(console, 'log', () => {});
        mock.method(console, 'error', () => {});

        await pushCommand.parseAsync(['node', 'pawthy', 'push', '--force']);

        // Verify the URL contained the .pawthyrc values, not the env var values
        assert.ok(requestedUrl.includes('/projects/test-project/environments/test-env/secrets'));
    });

    it('should use env vars if .pawthyrc is missing', async () => {
        let requestedUrl = '';
        mock.method(config, 'get', (key: string) => {
            if (key === 'token') return 'test-token';
            if (key === 'apiUrl') return 'http://localhost:3000';
            return undefined;
        });

        // Delete the .pawthyrc file
        await fs.unlink(path.join(tempDir, '.pawthyrc'));

        // Set env vars
        process.env.PAWTHY_PROJECT_ID = 'env-project';
        process.env.PAWTHY_ENV_ID = 'env-env';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mock.method(axios, 'put', async (url: string): Promise<any> => {
            requestedUrl = url;
            return {
                status: 200,
                data: { success: true },
            };
        });

        mock.method(console, 'log', () => {});
        mock.method(console, 'error', () => {});

        await pushCommand.parseAsync(['node', 'pawthy', 'push', '--force']);

        // Verify the URL contained the env var values
        assert.ok(requestedUrl.includes('/projects/env-project/environments/env-env/secrets'));
    });

    it('should exit with code 1 if project ID or environment ID is missing and no .pawthyrc', async () => {
        mock.method(config, 'get', (key: string) => {
            if (key === 'token') return 'test-token';
            if (key === 'apiUrl') return 'http://localhost:3000';
            return undefined;
        });

        // Delete the .pawthyrc file so it cannot be resolved there
        await fs.unlink(path.join(tempDir, '.pawthyrc'));

        mock.method(console, 'log', () => {});
        mock.method(console, 'error', () => {});

        try {
            await pushCommand.parseAsync(['node', 'pawthy', 'push', '--force']);
        } catch {
            // Expected to throw because process.exit throws
        }

        assert.strictEqual(exitCode, 1);
    });
});
