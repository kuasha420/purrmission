
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { getApiUrl, config } from './config.js';

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
});
