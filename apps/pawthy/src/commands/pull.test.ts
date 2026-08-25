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

    // Set fast poll intervals for tests
    process.env.PAWTHY_POLL_INTERVAL_MS = '5';
    process.env.PAWTHY_POLL_MAX_INTERVAL_MS = '20';
    process.env.PAWTHY_POLL_TIMEOUT_MS = '150';

    // Reset commander options to prevent test pollution
    pullCommand.setOptionValueWithSource('file', undefined, 'default');
    pullCommand.setOptionValueWithSource('format', undefined, 'default');
    pullCommand.setOptionValueWithSource('projectId', undefined, 'default');
    pullCommand.setOptionValueWithSource('envId', undefined, 'default');
    pullCommand.setOptionValueWithSource('keys', undefined, 'default');
    pullCommand.setOptionValueWithSource('merge', undefined, 'default');
    pullCommand.setOptionValueWithSource('env', undefined, 'default');
    pullCommand.setOptionValueWithSource('grant', undefined, 'default');
    pullCommand.setOptionValueWithSource('grantId', undefined, 'default');
    pullCommand.setOptionValue('merge', undefined);
    pullCommand.setOptionValue('grant', undefined);
    pullCommand.setOptionValue('grantId', undefined);

    // Create a unique temp directory outside the repository
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy-test-pull-'));

    // Mock process.cwd to return our temp directory
    mock.method(process, 'cwd', () => tempDir);

    // Mock process.exit
    mock.method(process, 'exit', (code?: number) => {
      exitCode = code ?? null;
      throw new Error(`process.exit called with ${code}`);
    });

    // Set fast poll defaults for deterministic test execution
    process.env.PAWTHY_POLL_INTERVAL_MS = '10';
    process.env.PAWTHY_POLL_MAX_INTERVAL_MS = '50';
    process.env.PAWTHY_POLL_TIMEOUT_MS = '1000';

    // Write a dummy .pawthyrc file in the temp directory
    await fs.writeFile(
      path.join(tempDir, '.pawthyrc'),
      JSON.stringify({ projectId: 'test-project', envId: 'test-env' })
    );
  });

  afterEach(async () => {
    mock.restoreAll();
    // Clean up environment variables to prevent test pollution
    delete process.env.PAWTHY_PROJECT_ID;
    delete process.env.PAWTHY_ENV_ID;
    delete process.env.PAWTHY_POLL_INTERVAL_MS;
    delete process.env.PAWTHY_POLL_MAX_INTERVAL_MS;
    delete process.env.PAWTHY_POLL_TIMEOUT_MS;

    // Clean up the temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('pulls secrets via POST reveal endpoint without exposing keys in URL', async () => {
    let requestedUrl = '';
    let requestMethod = '';
    let requestBody: unknown = null;
    let authHeader = '';
    let correlationHeader = '';
    let causationHeader = '';

    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    mock.method(
      axios,
      'post',
      async (url: string, data: unknown, reqConfig: { headers?: Record<string, string> }) => {
        requestedUrl = url;
        requestMethod = 'POST';
        requestBody = data;
        authHeader = reqConfig?.headers?.Authorization || '';
        correlationHeader = reqConfig?.headers?.['x-correlation-id'] || '';
        causationHeader = reqConfig?.headers?.['x-causation-id'] || '';
        return {
          status: 200,
          data: { secrets: { SECRET_A: 'val_a', SECRET_B: 'val_b' } },
        };
      }
    );

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

    assert.strictEqual(
      requestedUrl,
      'http://localhost:3000/api/projects/test-project/environments/test-env/secrets/reveal'
    );
    assert.strictEqual(requestMethod, 'POST');
    assert.strictEqual(authHeader, 'Bearer test-token');
    assert.ok(correlationHeader.length > 0);
    assert.ok(causationHeader.length > 0);
    assert.deepStrictEqual(requestBody, {});

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    assert.ok(content.includes('SECRET_A=val_a'));
    assert.ok(content.includes('SECRET_B=val_b'));
  });

  it('supports direct grant redemption via --grant flag in POST body', async () => {
    let requestedUrl = '';
    let requestBody: unknown = null;

    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    mock.method(axios, 'post', async (url: string, data: unknown) => {
      requestedUrl = url;
      requestBody = data;
      return {
        status: 200,
        data: { secrets: { GRANTED_SECRET: 'granted_val' } },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull', '--grant', 'grant-uuid-123']);

    assert.ok(requestedUrl.endsWith('/secrets/reveal'));
    assert.deepStrictEqual(requestBody, { grantId: 'grant-uuid-123' });

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    assert.ok(content.includes('GRANTED_SECRET=granted_val'));
  });

  describe('Approval Request Lifecycle & Bounded Polling', () => {
    it('handles 202 pending -> approved -> reveals secrets with grantId', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      let initialRevealCall = 0;
      let finalRevealCall = 0;
      let pollCallCount = 0;
      let finalGrantId = '';

      mock.method(axios, 'post', async (_url: string, data: { grantId?: string }) => {
        if (!data.grantId) {
          initialRevealCall++;
          return {
            status: 202,
            data: {
              status: 'pending',
              message: 'Access pending Guardian approval in Discord',
              requestId: 'req-uuid-999',
            },
          };
        } else {
          finalRevealCall++;
          finalGrantId = data.grantId;
          return {
            status: 200,
            data: { secrets: { REVEALED_AFTER_APPROVAL: 'approved_val' } },
          };
        }
      });

      mock.method(axios, 'get', async (url: string) => {
        pollCallCount++;
        assert.ok(url.includes('/api/requests/req-uuid-999'));
        if (pollCallCount === 1) {
          return {
            status: 200,
            data: {
              requestId: 'req-uuid-999',
              status: 'PENDING',
            },
          };
        }
        return {
          status: 200,
          data: {
            requestId: 'req-uuid-999',
            status: 'APPROVED',
            grantId: 'grant-resolved-777',
            resolvedBy: 'guardian-user-1',
          },
        };
      });

      const consoleLogs: string[] = [];
      mock.method(console, 'log', (msg: string) => {
        consoleLogs.push(msg);
      });
      mock.method(console, 'error', () => {});

      await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

      assert.strictEqual(initialRevealCall, 1);
      assert.strictEqual(pollCallCount, 2);
      assert.strictEqual(finalRevealCall, 1);
      assert.strictEqual(finalGrantId, 'grant-resolved-777');

      const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
      assert.ok(content.includes('REVEALED_AFTER_APPROVAL=approved_val'));
    });

    it('handles 202 pending -> denied by guardian', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(axios, 'post', async () => ({
        status: 202,
        data: {
          status: 'pending',
          requestId: 'req-uuid-denied',
        },
      }));

      mock.method(axios, 'get', async () => ({
        status: 200,
        data: {
          requestId: 'req-uuid-denied',
          status: 'DENIED',
        },
      }));

      const consoleErrors: string[] = [];
      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });
      mock.method(console, 'log', () => {});

      await assert.rejects(
        () => pullCommand.parseAsync(['node', 'pawthy', 'pull']),
        /process.exit called with 1/
      );

      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('was denied by a Guardian')));
    });

    it('handles 202 pending -> expired or cancelled', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(axios, 'post', async () => ({
        status: 202,
        data: {
          status: 'pending',
          requestId: 'req-uuid-expired',
        },
      }));

      mock.method(axios, 'get', async () => ({
        status: 200,
        data: {
          requestId: 'req-uuid-expired',
          status: 'EXPIRED',
        },
      }));

      const consoleErrors: string[] = [];
      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });
      mock.method(console, 'log', () => {});

      await assert.rejects(
        () => pullCommand.parseAsync(['node', 'pawthy', 'pull']),
        /process.exit called with 1/
      );

      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('has expired')));
    });

    it('fails safely when 202 response is missing requestId', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(axios, 'post', async () => ({
        status: 202,
        data: {
          status: 'pending',
          // Missing requestId
        },
      }));

      const consoleErrors: string[] = [];
      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });
      mock.method(console, 'log', () => {});

      await assert.rejects(
        () => pullCommand.parseAsync(['node', 'pawthy', 'pull']),
        /process.exit called with 1/
      );

      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('without a valid request ID')));
    });

    it('handles 429 rate-limited backoff and network retries during polling', async () => {
      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      let pollAttempt = 0;

      mock.method(axios, 'post', async (_url: string, data: { grantId?: string }) => {
        if (!data.grantId) {
          return {
            status: 202,
            data: { status: 'pending', requestId: 'req-rate-limited' },
          };
        }
        return {
          status: 200,
          data: { secrets: { SECRET_RETRY: 'success' } },
        };
      });

      mock.method(axios, 'get', async () => {
        pollAttempt++;
        if (pollAttempt === 1) {
          // Simulate 429 rate limit
          const error = Object.assign(new Error('Rate limited'), {
            isAxiosError: true,
            response: {
              status: 429,
              headers: { 'retry-after': '0.01' },
              data: { error: 'slow_down' },
            },
          });
          throw error;
        } else if (pollAttempt === 2) {
          // Simulate transient network failure
          throw new Error('Network timeout');
        } else {
          return {
            status: 200,
            data: {
              requestId: 'req-rate-limited',
              status: 'APPROVED',
              grantId: 'grant-after-retries',
            },
          };
        }
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

      assert.strictEqual(pollAttempt, 3);
      const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
      assert.ok(content.includes('SECRET_RETRY=success'));
    });

    it('times out when polling exceeds total deadline', async () => {
      process.env.PAWTHY_POLL_INTERVAL_MS = '5';
      process.env.PAWTHY_POLL_TIMEOUT_MS = '20'; // Very short timeout

      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(axios, 'post', async () => ({
        status: 202,
        data: { status: 'pending', requestId: 'req-timeout' },
      }));

      mock.method(axios, 'get', async () => ({
        status: 200,
        data: {
          requestId: 'req-timeout',
          status: 'PENDING',
        },
      }));

      const consoleErrors: string[] = [];
      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });
      mock.method(console, 'log', () => {});

      await assert.rejects(
        () => pullCommand.parseAsync(['node', 'pawthy', 'pull']),
        /process.exit called with 1/
      );

      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('Timed out waiting for approval')));
    });
  });

  it('should prioritize CLI flags over env vars and .pawthyrc', async () => {
    let requestedUrl = '';
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    process.env.PAWTHY_PROJECT_ID = 'env-project';
    process.env.PAWTHY_ENV_ID = 'env-env';

    mock.method(axios, 'post', async (url: string) => {
      requestedUrl = url;
      return {
        status: 200,
        data: { secrets: { FOO: 'bar' } },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync([
      'node',
      'pawthy',
      'pull',
      '-p',
      'flag-project',
      '-e',
      'flag-env',
    ]);

    assert.ok(requestedUrl.includes('/projects/flag-project/environments/flag-env/secrets/reveal'));
  });

  it('should prioritize .pawthyrc over env vars', async () => {
    let requestedUrl = '';
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    process.env.PAWTHY_PROJECT_ID = 'env-project';
    process.env.PAWTHY_ENV_ID = 'env-env';

    mock.method(axios, 'post', async (url: string) => {
      requestedUrl = url;
      return {
        status: 200,
        data: { secrets: { FOO: 'bar' } },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

    assert.ok(requestedUrl.includes('/projects/test-project/environments/test-env/secrets/reveal'));
  });

  it('should use env vars if .pawthyrc is missing', async () => {
    let requestedUrl = '';
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    await fs.unlink(path.join(tempDir, '.pawthyrc'));

    process.env.PAWTHY_PROJECT_ID = 'env-project';
    process.env.PAWTHY_ENV_ID = 'env-env';

    mock.method(axios, 'post', async (url: string) => {
      requestedUrl = url;
      return {
        status: 200,
        data: { secrets: { FOO: 'bar' } },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

    assert.ok(requestedUrl.includes('/projects/env-project/environments/env-env/secrets/reveal'));
  });

  it('should exit with code 1 if project ID or environment ID is missing and no .pawthyrc', async () => {
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    await fs.unlink(path.join(tempDir, '.pawthyrc'));

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await assert.rejects(
      () => pullCommand.parseAsync(['node', 'pawthy', 'pull']),
      /process.exit called with 1/
    );

    assert.strictEqual(exitCode, 1);
  });

  it('should natively merge secrets with existing .env file preserving comments and local variables', async () => {
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    const initialEnv = [
      '# DB config',
      'DATABASE_URL=postgres://localhost/db',
      '',
      '# Spacing and quotes tests',
      '  SPACED_KEY  =  "old-value"  ',
      "SINGLE_QUOTED = 'old-single'",
      'WITH_COMMENT = old-val # preserve this comment',
      'MULTILINE = "line 1',
      'line 2"',
      '',
      '# Local variables',
      'LOCAL_ONLY=123',
      'EXISTING_OVERWRITE=old-value',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, '.env'), initialEnv);

    mock.method(axios, 'post', async () => ({
      status: 200,
      data: {
        secrets: {
          DATABASE_URL: 'postgres://prod-host/db',
          SPACED_KEY: 'new-value',
          SINGLE_QUOTED: 'new-single',
          WITH_COMMENT: 'new-val',
          MULTILINE: 'new line 1\nnew line 2',
          EXISTING_OVERWRITE: 'new-value',
          NEW_SECRET: 'new-secret-val',
        },
      },
    }));

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull', '--merge']);

    const mergedContent = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = mergedContent.split('\n');

    assert.ok(lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(lines.includes('EXISTING_OVERWRITE=new-value'));
    assert.ok(lines.includes('  SPACED_KEY  =  "new-value"  '));
    assert.ok(lines.includes("SINGLE_QUOTED = 'new-single'"));
    assert.ok(lines.includes('WITH_COMMENT = new-val # preserve this comment'));

    const multilineStartIndex = lines.findIndex((l) => l.startsWith('MULTILINE ='));
    assert.notStrictEqual(multilineStartIndex, -1);
    assert.strictEqual(lines[multilineStartIndex], 'MULTILINE = "new line 1');
    assert.strictEqual(lines[multilineStartIndex + 1], 'new line 2"');

    assert.ok(lines.includes('# DB config'));
    assert.ok(lines.includes('LOCAL_ONLY=123'));
    assert.ok(lines.includes('# Local variables'));
    assert.ok(lines.includes('NEW_SECRET=new-secret-val'));
  });

  it('should support whitelisting via CLI keys flag in pull command and pass keys in POST body', async () => {
    let requestPayload: { keys?: string[] } = {};

    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    await fs.writeFile(
      path.join(tempDir, '.env'),
      'DATABASE_URL=postgres://localhost/db\nLOCAL_ONLY=123\n'
    );

    mock.method(axios, 'post', async (_url: string, data: { keys?: string[] }) => {
      requestPayload = data;
      return {
        status: 200,
        data: {
          secrets: {
            DATABASE_URL: 'postgres://prod-host/db',
            API_KEY: 'secret-key',
            ANOTHER_VAR: 'val',
          },
        },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull', '-k', 'DATABASE_URL, API_KEY']);

    assert.deepStrictEqual(requestPayload.keys, ['DATABASE_URL', 'API_KEY']);

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    assert.ok(lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(lines.includes('API_KEY=secret-key'));
    assert.ok(lines.includes('LOCAL_ONLY=123'));
    assert.ok(!lines.includes('ANOTHER_VAR=val'));
  });

  it('should support whitelisting via keys array in .pawthyrc in pull command', async () => {
    let requestPayload: { keys?: string[] } = {};

    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    await fs.writeFile(
      path.join(tempDir, '.pawthyrc'),
      JSON.stringify({
        projectId: 'test-project',
        envId: 'test-env',
        keys: ['DATABASE_URL'],
      })
    );

    mock.method(axios, 'post', async (_url: string, data: { keys?: string[] }) => {
      requestPayload = data;
      return {
        status: 200,
        data: {
          secrets: {
            DATABASE_URL: 'postgres://prod-host/db',
            API_KEY: 'secret-key',
          },
        },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

    assert.deepStrictEqual(requestPayload.keys, ['DATABASE_URL']);

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    assert.ok(lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(!lines.includes('API_KEY=secret-key'));
  });

  it('should support whitelisting via keys array in .pawthyrc.local in pull command', async () => {
    let requestPayload: { keys?: string[] } = {};

    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    await fs.writeFile(
      path.join(tempDir, '.pawthyrc'),
      JSON.stringify({
        projectId: 'test-project',
        envId: 'test-env',
      })
    );
    await fs.writeFile(
      path.join(tempDir, '.pawthyrc.local'),
      JSON.stringify({
        keys: ['API_KEY'],
      })
    );

    mock.method(axios, 'post', async (_url: string, data: { keys?: string[] }) => {
      requestPayload = data;
      return {
        status: 200,
        data: {
          secrets: {
            DATABASE_URL: 'postgres://prod-host/db',
            API_KEY: 'secret-key',
          },
        },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

    assert.deepStrictEqual(requestPayload.keys, ['API_KEY']);

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    assert.ok(!lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(lines.includes('API_KEY=secret-key'));
  });

  it('should support whitelisting via syncKeys array in .pawthyrc in pull command', async () => {
    let requestPayload: { keys?: string[] } = {};

    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    await fs.writeFile(
      path.join(tempDir, '.pawthyrc'),
      JSON.stringify({
        projectId: 'test-project',
        envId: 'test-env',
        syncKeys: ['DATABASE_URL'],
      })
    );

    mock.method(axios, 'post', async (_url: string, data: { keys?: string[] }) => {
      requestPayload = data;
      return {
        status: 200,
        data: {
          secrets: {
            DATABASE_URL: 'postgres://prod-host/db',
            API_KEY: 'secret-key',
          },
        },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

    assert.deepStrictEqual(requestPayload.keys, ['DATABASE_URL']);

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    assert.ok(lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(!lines.includes('API_KEY=secret-key'));
  });

  it('should write secrets to environment-specific file when --env flag is passed', async () => {
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    mock.method(axios, 'post', async () => ({
      status: 200,
      data: {
        secrets: {
          DEV_SECRET: 'dev-val',
        },
      },
    }));

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull', '-E', 'development']);

    const devContent = await fs.readFile(path.join(tempDir, '.env.development'), 'utf-8');
    assert.ok(devContent.includes('DEV_SECRET=dev-val'));
  });

  it('should preserve explicit -f flag over --env flag in pull command', async () => {
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    mock.method(axios, 'post', async () => ({
      status: 200,
      data: {
        secrets: {
          CUSTOM_SECRET: 'custom-val',
        },
      },
    }));

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync([
      'node',
      'pawthy',
      'pull',
      '-f',
      'custom.env',
      '-E',
      'development',
    ]);

    const customContent = await fs.readFile(path.join(tempDir, 'custom.env'), 'utf-8');
    assert.ok(customContent.includes('CUSTOM_SECRET=custom-val'));

    let devExists = true;
    try {
      await fs.access(path.join(tempDir, '.env.development'));
    } catch {
      devExists = false;
    }
    assert.strictEqual(devExists, false);
  });
});
