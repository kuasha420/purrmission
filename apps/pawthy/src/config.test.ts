
import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getApiUrl, config, findProjectRoot } from './config.js';

describe('Config', () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        mock.restoreAll();
    });

    it('should prioritize PAWTHY_API_URL from shell environment', () => {
        process.env = { ...originalEnv, PAWTHY_API_URL: 'https://shell.example.com' };
        // We don't need to mock config here because env var takes precedence
        assert.strictEqual(getApiUrl(), 'https://shell.example.com');
    });

    it('should prioritize config file over default if env var is missing', () => {
        process.env = { ...originalEnv };
        delete process.env.PAWTHY_API_URL;

        // Mock config.get
        mock.method(config, 'get', (key: string) => {
            return key === 'apiUrl' ? 'https://config.example.com' : undefined;
        });

        assert.strictEqual(getApiUrl(), 'https://config.example.com');
    });

    it('should use default production URL if no env var or config is set', () => {
        process.env = { ...originalEnv };
        delete process.env.PAWTHY_API_URL;


        // Mock config.get to return default value
        mock.method(config, 'get', (key: string) => {
            return key === 'apiUrl' ? 'https://purrmission.infra.purrfecthq.com' : undefined;
        });


        assert.strictEqual(getApiUrl(), 'https://purrmission.infra.purrfecthq.com');
    });

    describe('findProjectRoot', () => {
        let tempDir: string;

        beforeEach(async () => {
            tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pawthy-find-root-'));
        });

        afterEach(async () => {
            try {
                await fs.promises.rm(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore
            }
        });

        it('should return starting directory if .pawthyrc exists', async () => {
            await fs.promises.writeFile(path.join(tempDir, '.pawthyrc'), '{}');
            const root = findProjectRoot(tempDir);
            assert.strictEqual(root, tempDir);
        });

        it('should walk up to find .pawthyrc in parent directory', async () => {
            await fs.promises.writeFile(path.join(tempDir, '.pawthyrc'), '{}');
            const subDir = path.join(tempDir, 'sub1', 'sub2');
            await fs.promises.mkdir(subDir, { recursive: true });
            const root = findProjectRoot(subDir);
            assert.strictEqual(root, tempDir);
        });

        it('should walk up to find .git in parent directory', async () => {
            await fs.promises.mkdir(path.join(tempDir, '.git'), { recursive: true });
            const subDir = path.join(tempDir, 'sub1', 'sub2');
            await fs.promises.mkdir(subDir, { recursive: true });
            const root = findProjectRoot(subDir);
            assert.strictEqual(root, tempDir);
        });

        it('should fallback to process.cwd() if no project root indicators are found', () => {
            const root = findProjectRoot(tempDir);
            assert.strictEqual(root, process.cwd());
        });
    });
});
