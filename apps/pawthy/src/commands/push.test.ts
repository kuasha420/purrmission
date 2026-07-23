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
    pushCommand.setOptionValue('keys', undefined);

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

  it('should support whitelisting via CLI keys flag in push command', async () => {
    let pushedSecrets: Record<string, string> = {};
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    // Write a .env with multiple variables
    await fs.writeFile(
      path.join(tempDir, '.env'),
      ['DATABASE_URL=postgres://localhost/db', 'API_KEY=secret-key', 'LOCAL_VAR=123'].join('\n')
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mock.method(axios, 'put', async (url: string, data: any): Promise<any> => {
      pushedSecrets = data.secrets;
      return {
        status: 200,
        data: { success: true },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    // Request only DATABASE_URL and API_KEY
    await pushCommand.parseAsync([
      'node',
      'pawthy',
      'push',
      '--force',
      '-k',
      'DATABASE_URL, API_KEY',
    ]);

    assert.deepStrictEqual(pushedSecrets, {
      DATABASE_URL: 'postgres://localhost/db',
      API_KEY: 'secret-key',
    });
  });

  it('should support whitelisting via keys array in .pawthyrc in push command', async () => {
    let pushedSecrets: Record<string, string> = {};
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    // Write a .pawthyrc containing a keys whitelist
    await fs.writeFile(
      path.join(tempDir, '.pawthyrc'),
      JSON.stringify({
        projectId: 'test-project',
        envId: 'test-env',
        keys: ['DATABASE_URL'],
      })
    );

    // Write a .env with multiple variables
    await fs.writeFile(
      path.join(tempDir, '.env'),
      ['DATABASE_URL=postgres://localhost/db', 'API_KEY=secret-key'].join('\n')
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mock.method(axios, 'put', async (url: string, data: any): Promise<any> => {
      pushedSecrets = data.secrets;
      return {
        status: 200,
        data: { success: true },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pushCommand.parseAsync(['node', 'pawthy', 'push', '--force']);

    assert.deepStrictEqual(pushedSecrets, {
      DATABASE_URL: 'postgres://localhost/db',
    });
  });

  it('should support whitelisting via keys array in .pawthyrc.local in push command', async () => {
    let pushedSecrets: Record<string, string> = {};
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    // Write .pawthyrc and .pawthyrc.local
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

    // Write a .env with multiple variables
    await fs.writeFile(
      path.join(tempDir, '.env'),
      ['DATABASE_URL=postgres://localhost/db', 'API_KEY=secret-key'].join('\n')
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mock.method(axios, 'put', async (url: string, data: any): Promise<any> => {
      pushedSecrets = data.secrets;
      return {
        status: 200,
        data: { success: true },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pushCommand.parseAsync(['node', 'pawthy', 'push', '--force']);

    assert.deepStrictEqual(pushedSecrets, {
      API_KEY: 'secret-key',
    });
  });

  it('should support whitelisting via syncKeys array in .pawthyrc in push command', async () => {
    let pushedSecrets: Record<string, string> = {};
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    // Write a .pawthyrc containing syncKeys alias
    await fs.writeFile(
      path.join(tempDir, '.pawthyrc'),
      JSON.stringify({
        projectId: 'test-project',
        envId: 'test-env',
        syncKeys: ['DATABASE_URL'],
      })
    );

    // Write a .env with multiple variables
    await fs.writeFile(
      path.join(tempDir, '.env'),
      ['DATABASE_URL=postgres://localhost/db', 'API_KEY=secret-key'].join('\n')
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mock.method(axios, 'put', async (url: string, data: any): Promise<any> => {
      pushedSecrets = data.secrets;
      return {
        status: 200,
        data: { success: true },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pushCommand.parseAsync(['node', 'pawthy', 'push', '--force']);

    assert.deepStrictEqual(pushedSecrets, {
      DATABASE_URL: 'postgres://localhost/db',
    });
  });
});
