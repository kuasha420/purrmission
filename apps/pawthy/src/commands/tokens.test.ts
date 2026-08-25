import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { tokensCommand } from './tokens.js';
import { config } from '../config.js';

describe('Tokens Command', () => {
  let exitCode: number | null = null;
  let tempDir: string;

  beforeEach(async () => {
    exitCode = null;

    // Create unique temp dir
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy-test-tokens-'));

    mock.method(process, 'cwd', () => tempDir);

    mock.method(process, 'exit', (code?: number) => {
      exitCode = code ?? null;
      throw new Error(`process.exit called with ${code}`);
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('tokens list', () => {
    it('fails if not logged in', async () => {
      mock.method(config, 'get', () => undefined);

      const consoleErrors: string[] = [];
      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });

      await assert.rejects(
        () => tokensCommand.parseAsync(['node', 'tokens', 'list']),
        /process.exit called with 1/
      );

      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('You must be logged in')));
    });

    it('lists user credentials and never discloses plaintext, prefix, or digest', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      const mockCredentials = [
        {
          id: 'cred-uuid-1',
          name: 'Personal Laptop',
          type: 'PAWTHY_TOKEN',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-04-01T00:00:00.000Z',
          revokedAt: null,
          revokedReason: null,
          lastUsedAt: '2026-02-01T12:00:00.000Z',
          // Maliciously / accidentally attached sensitive fields that must NEVER be printed
          prefix: 'paw_secret12',
          digest: 'sha256:abcd1234efgh5678',
          plaintext: 'paw_secret1234567890abcdef',
        },
        {
          id: 'cred-uuid-2',
          name: 'Old CI Token',
          type: 'PAWTHY_TOKEN',
          createdAt: '2025-01-01T00:00:00.000Z',
          expiresAt: '2025-04-01T00:00:00.000Z',
          revokedAt: '2025-03-01T00:00:00.000Z',
          revokedReason: 'rotated',
          lastUsedAt: null,
        },
      ];

      let requestedUrl = '';
      let authHeader = '';
      let correlationIdHeader = '';
      let causationIdHeader = '';

      mock.method(
        axios,
        'get',
        async (url: string, reqConfig: { headers?: Record<string, string> }) => {
          requestedUrl = url;
          authHeader = reqConfig?.headers?.Authorization || '';
          correlationIdHeader = reqConfig?.headers?.['x-correlation-id'] || '';
          causationIdHeader = reqConfig?.headers?.['x-causation-id'] || '';
          return {
            status: 200,
            data: mockCredentials,
          };
        }
      );

      const consoleLogs: string[] = [];
      mock.method(console, 'log', (msg: string) => {
        consoleLogs.push(msg);
      });

      await tokensCommand.parseAsync(['node', 'tokens', 'list']);

      assert.strictEqual(requestedUrl, 'http://localhost:3000/api/auth/credentials');
      assert.strictEqual(authHeader, 'Bearer test-token');
      assert.ok(correlationIdHeader.length > 0, 'Correlation ID header must be present');
      assert.ok(causationIdHeader.length > 0, 'Causation ID header must be present');

      const allOutput = consoleLogs.join('\n');
      assert.ok(allOutput.includes('cred-uuid-1'));
      assert.ok(allOutput.includes('Personal Laptop'));
      assert.ok(allOutput.includes('ACTIVE'));
      assert.ok(allOutput.includes('cred-uuid-2'));
      assert.ok(allOutput.includes('REVOKED (rotated)'));

      // Verify strict absence of sensitive fields
      assert.ok(!allOutput.includes('paw_secret12'), 'Must never output prefix');
      assert.ok(!allOutput.includes('sha256:abcd'), 'Must never output digest');
      assert.ok(!allOutput.includes('paw_secret1234567890abcdef'), 'Must never output plaintext');
    });

    it('handles empty credential list gracefully', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(axios, 'get', async () => ({
        status: 200,
        data: [],
      }));

      const consoleLogs: string[] = [];
      mock.method(console, 'log', (msg: string) => {
        consoleLogs.push(msg);
      });

      await tokensCommand.parseAsync(['node', 'tokens', 'list']);

      const allOutput = consoleLogs.join('\n');
      assert.ok(allOutput.includes('No credentials found'));
    });

    it('handles 401 session expired error', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(axios, 'get', async () => {
        const error = Object.assign(new Error('Unauthorized'), {
          isAxiosError: true,
          response: { status: 401, data: { error: 'unauthorized' } },
        });
        throw error;
      });

      const consoleErrors: string[] = [];
      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });

      await assert.rejects(
        () => tokensCommand.parseAsync(['node', 'tokens', 'list']),
        /process.exit called with 1/
      );

      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('Session expired or revoked')));
    });
  });

  describe('tokens revoke', () => {
    it('revokes credential successfully', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      let requestedUrl = '';
      let authHeader = '';
      let correlationIdHeader = '';

      mock.method(
        axios,
        'delete',
        async (url: string, reqConfig: { headers?: Record<string, string> }) => {
          requestedUrl = url;
          authHeader = reqConfig?.headers?.Authorization || '';
          correlationIdHeader = reqConfig?.headers?.['x-correlation-id'] || '';
          return {
            status: 204,
            data: null,
          };
        }
      );

      const consoleLogs: string[] = [];
      mock.method(console, 'log', (msg: string) => {
        consoleLogs.push(msg);
      });

      await tokensCommand.parseAsync(['node', 'tokens', 'revoke', 'cred-123']);

      assert.strictEqual(requestedUrl, 'http://localhost:3000/api/auth/credentials/cred-123');
      assert.strictEqual(authHeader, 'Bearer test-token');
      assert.ok(correlationIdHeader.length > 0);

      const allOutput = consoleLogs.join('\n');
      assert.ok(allOutput.includes('Credential cred-123 has been successfully revoked'));
    });

    it('handles 404 when revoking non-existent credential', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(axios, 'delete', async () => {
        const error = Object.assign(new Error('Not Found'), {
          isAxiosError: true,
          response: { status: 404, data: { error: 'not_found' } },
        });
        throw error;
      });

      const consoleErrors: string[] = [];
      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });

      await assert.rejects(
        () => tokensCommand.parseAsync(['node', 'tokens', 'revoke', 'missing-cred']),
        /process.exit called with 1/
      );

      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('Credential missing-cred not found')));
    });

    it('handles 403 when revoking another user credential', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(axios, 'delete', async () => {
        const error = Object.assign(new Error('Forbidden'), {
          isAxiosError: true,
          response: { status: 403, data: { error: 'forbidden' } },
        });
        throw error;
      });

      const consoleErrors: string[] = [];
      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });

      await assert.rejects(
        () => tokensCommand.parseAsync(['node', 'tokens', 'revoke', 'other-cred']),
        /process.exit called with 1/
      );

      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('Access forbidden')));
    });
  });
});
