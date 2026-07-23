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
    pullCommand.setOptionValueWithSource('file', undefined, 'default');
    pullCommand.setOptionValueWithSource('format', undefined, 'default');
    pullCommand.setOptionValueWithSource('projectId', undefined, 'default');
    pullCommand.setOptionValueWithSource('envId', undefined, 'default');
    pullCommand.setOptionValueWithSource('keys', undefined, 'default');
    pullCommand.setOptionValueWithSource('merge', undefined, 'default');
    pullCommand.setOptionValueWithSource('env', undefined, 'default');
    pullCommand.setOptionValue('merge', undefined);

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
    mock.method(axios, 'get', async (url: string): Promise<any> => {
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
    mock.method(axios, 'get', async (url: string): Promise<any> => {
      requestedUrl = url;
      return {
        status: 200,
        data: { secrets: { FOO: 'bar' } },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

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
    mock.method(axios, 'get', async (url: string): Promise<any> => {
      requestedUrl = url;
      return {
        status: 200,
        data: { secrets: { FOO: 'bar' } },
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull']);

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
      await pullCommand.parseAsync(['node', 'pawthy', 'pull']);
    } catch {
      // Expected to throw because process.exit throws
    }

    assert.strictEqual(exitCode, 1);
  });

  it('should natively merge secrets with existing .env file preserving comments and local variables', async () => {
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    // Write initial .env file with comments and local variables
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

    // Mock axios.get to return updated and new secrets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mock.method(axios, 'get', async (): Promise<any> => {
      return {
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
      };
    });

    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    await pullCommand.parseAsync(['node', 'pawthy', 'pull', '--merge']);

    // Read the resulting .env file
    const mergedContent = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = mergedContent.split('\n');

    // Check that DATABASE_URL and EXISTING_OVERWRITE were updated
    assert.ok(lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(lines.includes('EXISTING_OVERWRITE=new-value'));

    // Check spacing, quotes, and comments preservation
    assert.ok(lines.includes('  SPACED_KEY  =  "new-value"  '));
    assert.ok(lines.includes("SINGLE_QUOTED = 'new-single'"));
    assert.ok(lines.includes('WITH_COMMENT = new-val # preserve this comment'));

    // Check multiline preservation/updating
    // The multiline value contains a newline, so it should be double-quoted
    const multilineStartIndex = lines.findIndex((l) => l.startsWith('MULTILINE ='));
    assert.notStrictEqual(multilineStartIndex, -1);
    assert.strictEqual(lines[multilineStartIndex], 'MULTILINE = "new line 1');
    assert.strictEqual(lines[multilineStartIndex + 1], 'new line 2"');

    // Check that LOCAL_ONLY and comments were preserved
    assert.ok(lines.includes('# DB config'));
    assert.ok(lines.includes('LOCAL_ONLY=123'));
    assert.ok(lines.includes('# Local variables'));

    // Check that NEW_SECRET was appended
    assert.ok(lines.includes('NEW_SECRET=new-secret-val'));
  });

  it('should support whitelisting via CLI keys flag in pull command and preserve local-only variables', async () => {
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    // Write a pre-existing .env file
    await fs.writeFile(
      path.join(tempDir, '.env'),
      'DATABASE_URL=postgres://localhost/db\nLOCAL_ONLY=123\n'
    );

    mock.method(axios, 'get', async () => {
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

    // Request only DATABASE_URL and API_KEY
    await pullCommand.parseAsync(['node', 'pawthy', 'pull', '-k', 'DATABASE_URL, API_KEY']);

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    assert.ok(lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(lines.includes('API_KEY=secret-key'));
    // LOCAL_ONLY should be preserved because whitelisting forces merge behavior
    assert.ok(lines.includes('LOCAL_ONLY=123'));
    assert.ok(!lines.includes('ANOTHER_VAR=val'));
  });

  it('should support whitelisting via keys array in .pawthyrc in pull command', async () => {
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

    mock.method(axios, 'get', async () => {
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

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    assert.ok(lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(!lines.includes('API_KEY=secret-key'));
  });

  it('should support whitelisting via keys array in .pawthyrc.local in pull command', async () => {
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    // Write a .pawthyrc and a .pawthyrc.local
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

    mock.method(axios, 'get', async () => {
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

    const content = await fs.readFile(path.join(tempDir, '.env'), 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    assert.ok(!lines.includes('DATABASE_URL=postgres://prod-host/db'));
    assert.ok(lines.includes('API_KEY=secret-key'));
  });

  it('should support whitelisting via syncKeys array in .pawthyrc in pull command', async () => {
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

    mock.method(axios, 'get', async () => {
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

    mock.method(axios, 'get', async () => {
      return {
        status: 200,
        data: {
          secrets: {
            DEV_SECRET: 'dev-val',
          },
        },
      };
    });

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

    mock.method(axios, 'get', async () => {
      return {
        status: 200,
        data: {
          secrets: {
            CUSTOM_SECRET: 'custom-val',
          },
        },
      };
    });

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

    // Ensure .env.development was not created
    let devExists = true;
    try {
      await fs.access(path.join(tempDir, '.env.development'));
    } catch {
      devExists = false;
    }
    assert.strictEqual(devExists, false);
  });
});
