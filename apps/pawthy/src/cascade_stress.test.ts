import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getCandidateEnvFiles, loadCascadingEnv } from './loader.js';
import { pullCommand } from './commands/pull.js';
import { pushCommand } from './commands/push.js';
import { config } from './config.js';

describe('Milestone 2 Environment Cascading Stress & Edge Case Harness', () => {
  let tempDir: string;
  let exitCode: number | null = null;

  beforeEach(async () => {
    exitCode = null;

    // Reset Commander options for pull and push commands
    pullCommand.setOptionValueWithSource('file', undefined, 'default');
    pullCommand.setOptionValueWithSource('format', undefined, 'default');
    pullCommand.setOptionValueWithSource('projectId', undefined, 'default');
    pullCommand.setOptionValueWithSource('envId', undefined, 'default');
    pullCommand.setOptionValueWithSource('keys', undefined, 'default');
    pullCommand.setOptionValueWithSource('merge', undefined, 'default');
    pullCommand.setOptionValueWithSource('env', undefined, 'default');
    pullCommand.setOptionValue('merge', undefined);

    pushCommand.setOptionValueWithSource('file', undefined, 'default');
    pushCommand.setOptionValueWithSource('format', undefined, 'default');
    pushCommand.setOptionValueWithSource('force', undefined, 'default');
    pushCommand.setOptionValueWithSource('projectId', undefined, 'default');
    pushCommand.setOptionValueWithSource('envId', undefined, 'default');
    pushCommand.setOptionValueWithSource('keys', undefined, 'default');
    pushCommand.setOptionValueWithSource('env', undefined, 'default');
    pushCommand.setOptionValue('keys', undefined);

    // Create a temp directory (with possible spaces in name to test space handling)
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy test space-dir-'));

    mock.method(process, 'cwd', () => tempDir);

    mock.method(process, 'exit', (code?: number) => {
      exitCode = code ?? null;
      throw new Error(`process.exit called with ${code}`);
    });

    // Default mock config
    mock.method(config, 'get', (key: string) => {
      if (key === 'token') return 'test-token';
      if (key === 'apiUrl') return 'http://localhost:3000';
      return undefined;
    });

    // Write a standard .pawthyrc file in tempDir
    await fs.writeFile(
      path.join(tempDir, '.pawthyrc'),
      JSON.stringify({ projectId: 'test-project', envId: 'test-env' })
    );
  });

  afterEach(async () => {
    mock.restoreAll();
    delete process.env.PAWTHY_PROJECT_ID;
    delete process.env.PAWTHY_ENV_ID;

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ---------------------------------------------------------------------------
  // Category 1: Missing Intermediate Files in Cascading Matrix
  // ---------------------------------------------------------------------------
  describe('Category 1: Missing Intermediate Files Matrix', () => {
    it('1.1: missing .env.staging & .env.local (only .env and .env.staging.local exist)', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'VAR_BASE=base\nSHARED_VAR=base');
      await fs.writeFile(
        path.join(tempDir, '.env.staging.local'),
        'VAR_STAGING_LOCAL=stg_loc\nSHARED_VAR=override_stg_loc'
      );

      const loaded = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });

      assert.strictEqual(loaded.VAR_BASE, 'base');
      assert.strictEqual(loaded.VAR_STAGING_LOCAL, 'stg_loc');
      assert.strictEqual(loaded.SHARED_VAR, 'override_stg_loc');
    });

    it('1.2: missing .env and .env.staging.local (only .env.staging and .env.local exist)', async () => {
      await fs.writeFile(path.join(tempDir, '.env.staging'), 'SHARED=from_staging\nSTAGING_ONLY=1');
      await fs.writeFile(path.join(tempDir, '.env.local'), 'SHARED=from_local\nLOCAL_ONLY=1');

      const loaded = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });

      assert.strictEqual(loaded.SHARED, 'from_local'); // .env.local overrides .env.staging
      assert.strictEqual(loaded.STAGING_ONLY, '1');
      assert.strictEqual(loaded.LOCAL_ONLY, '1');
    });

    it('1.3: only highest precedence file (.env.staging.local) exists', async () => {
      await fs.writeFile(path.join(tempDir, '.env.staging.local'), 'HIGHEST=true');

      const loaded = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });

      assert.strictEqual(loaded.HIGHEST, 'true');
      assert.strictEqual(Object.keys(loaded).length, 1);
    });

    it('1.4: no candidate env files exist at all', async () => {
      const loaded = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });
      assert.deepStrictEqual(loaded, {});
    });

    it('1.5: pawthy push -E staging with missing intermediate files loads merged result', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'BASE=1\nOVERRIDE=base');
      await fs.writeFile(
        path.join(tempDir, '.env.staging.local'),
        'OVERRIDE=stg_local\nLOCAL_SECRET=secret'
      );

      let pushedData: Record<string, string> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mock.method(axios, 'put', async (_url: string, body: any) => {
        pushedData = body.secrets;
        return { status: 200, data: { success: true } };
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      await pushCommand.parseAsync(['node', 'pawthy', 'push', '--force', '-E', 'staging']);

      assert.deepStrictEqual(pushedData, {
        BASE: '1',
        OVERRIDE: 'stg_local',
        LOCAL_SECRET: 'secret',
      });
    });

    it('1.6: pawthy push -E staging when zero candidate files exist gracefully exits', async () => {
      let putCalled = false;
      mock.method(axios, 'put', async () => {
        putCalled = true;
        return { status: 200, data: { success: true } };
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      await pushCommand.parseAsync(['node', 'pawthy', 'push', '--force', '-E', 'staging']);

      assert.strictEqual(putCalled, false);
      assert.strictEqual(exitCode, null); // Graceful completion (no exit code 1)
    });
  });

  // ---------------------------------------------------------------------------
  // Category 2: CLI Flag Edge Cases & Combinations
  // ---------------------------------------------------------------------------
  describe('Category 2: CLI Flag Edge Cases & Disambiguation', () => {
    it('2.1: environment profile with special characters, symbols, and dots', async () => {
      const profile = 'v1.2-alpha_build.99';
      const candidates = getCandidateEnvFiles(tempDir, profile);

      assert.deepStrictEqual(candidates, [
        path.join(tempDir, '.env'),
        path.join(tempDir, `.env.${profile}`),
        path.join(tempDir, '.env.local'),
        path.join(tempDir, `.env.${profile}.local`),
      ]);

      await fs.writeFile(path.join(tempDir, `.env.${profile}`), 'ENV_SPECIFIC=v1.2');
      const loaded = loadCascadingEnv({ rootDir: tempDir, environment: profile });
      assert.strictEqual(loaded.ENV_SPECIFIC, 'v1.2');
    });

    it('2.2: environment profile with whitespace padding', async () => {
      const candidates = getCandidateEnvFiles(tempDir, '  production  ');
      assert.strictEqual(candidates[1], path.join(tempDir, '.env.production'));
      assert.strictEqual(candidates[3], path.join(tempDir, '.env.production.local'));
    });

    it('2.3: disambiguation between -E (env profile) and -e (env ID)', async () => {
      let requestedUrl = '';
      let pushedData: Record<string, string> = {};

      await fs.writeFile(path.join(tempDir, '.env.staging'), 'STAGING_VAR=100');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mock.method(axios, 'put', async (url: string, body: any) => {
        requestedUrl = url;
        pushedData = body.secrets;
        return { status: 200, data: { success: true } };
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      // Pass -E staging AND -e remote_env_999 AND -p remote_proj_888
      await pushCommand.parseAsync([
        'node',
        'pawthy',
        'push',
        '--force',
        '-E',
        'staging',
        '-e',
        'remote_env_999',
        '-p',
        'remote_proj_888',
      ]);

      assert.ok(
        requestedUrl.includes('/projects/remote_proj_888/environments/remote_env_999/secrets')
      );
      assert.strictEqual(pushedData.STAGING_VAR, '100');
    });

    it('2.4: pawthy pull -E staging -e remote_env_999 -m writes to .env.staging and merges existing file', async () => {
      let requestedUrl = '';
      await fs.writeFile(
        path.join(tempDir, '.env.staging'),
        'LOCAL_STAGING_KEY=local_val\n# preserve comment'
      );

      mock.method(axios, 'get', async (url: string) => {
        requestedUrl = url;
        return {
          status: 200,
          data: { secrets: { REMOTE_KEY: 'remote_val' } },
        };
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      await pullCommand.parseAsync([
        'node',
        'pawthy',
        'pull',
        '-E',
        'staging',
        '-e',
        'remote_env_999',
        '-p',
        'remote_proj_888',
        '-m',
      ]);

      assert.ok(
        requestedUrl.includes('/projects/remote_proj_888/environments/remote_env_999/secrets')
      );

      const fileContent = await fs.readFile(path.join(tempDir, '.env.staging'), 'utf-8');
      assert.ok(fileContent.includes('LOCAL_STAGING_KEY=local_val'));
      assert.ok(fileContent.includes('REMOTE_KEY=remote_val'));
      assert.ok(fileContent.includes('# preserve comment'));
    });

    it('2.5: pawthy pull explicit -f overrides -E target file', async () => {
      mock.method(axios, 'get', async () => {
        return { status: 200, data: { secrets: { FOO: 'bar' } } };
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      await pullCommand.parseAsync([
        'node',
        'pawthy',
        'pull',
        '-f',
        'override_target.env',
        '-E',
        'staging',
      ]);

      const customExists = await fs
        .access(path.join(tempDir, 'override_target.env'))
        .then(() => true)
        .catch(() => false);
      const stagingExists = await fs
        .access(path.join(tempDir, '.env.staging'))
        .then(() => true)
        .catch(() => false);

      assert.strictEqual(customExists, true);
      assert.strictEqual(stagingExists, false);
    });

    it('2.6: pawthy push explicit -f overrides -E cascading loader', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'BASE_VAR=base');
      await fs.writeFile(path.join(tempDir, '.env.staging'), 'STAGING_VAR=staging');
      await fs.writeFile(path.join(tempDir, 'explicit.env'), 'EXPLICIT_VAR=explicit');

      let pushedData: Record<string, string> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mock.method(axios, 'put', async (_url: string, body: any) => {
        pushedData = body.secrets;
        return { status: 200, data: { success: true } };
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      await pushCommand.parseAsync([
        'node',
        'pawthy',
        'push',
        '--force',
        '-f',
        'explicit.env',
        '-E',
        'staging',
      ]);

      assert.deepStrictEqual(pushedData, { EXPLICIT_VAR: 'explicit' });
    });

    it('2.7: pawthy push -E staging -k FOO filters secrets loaded from cascade', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'FOO=base_foo\nBAR=base_bar');
      await fs.writeFile(path.join(tempDir, '.env.staging'), 'FOO=stg_foo\nBAZ=stg_baz');

      let pushedData: Record<string, string> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mock.method(axios, 'put', async (_url: string, body: any) => {
        pushedData = body.secrets;
        return { status: 200, data: { success: true } };
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      await pushCommand.parseAsync([
        'node',
        'pawthy',
        'push',
        '--force',
        '-E',
        'staging',
        '-k',
        'FOO',
      ]);

      assert.deepStrictEqual(pushedData, { FOO: 'stg_foo' });
    });
  });

  // ---------------------------------------------------------------------------
  // Category 3: Directory Paths with Spaces & Permission Issues
  // ---------------------------------------------------------------------------
  describe('Category 3: Space-containing paths and Permission Faults', () => {
    it('3.1: cascading env loader works in directory path containing spaces and special chars', async () => {
      const spaceSubDir = path.join(tempDir, 'dir with spaces & # symbols');
      await fs.mkdir(spaceSubDir, { recursive: true });

      await fs.writeFile(path.join(spaceSubDir, '.env'), 'PATH_TEST=base');
      await fs.writeFile(path.join(spaceSubDir, '.env.production'), 'PATH_TEST=prod');

      const loaded = loadCascadingEnv({ rootDir: spaceSubDir, environment: 'production' });
      assert.strictEqual(loaded.PATH_TEST, 'prod');
    });

    it('3.2: pawthy push -f non-existent file exits with code 1', async () => {
      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      try {
        await pushCommand.parseAsync([
          'node',
          'pawthy',
          'push',
          '--force',
          '-f',
          'non_existent_file.env',
        ]);
      } catch {
        // Expected process.exit throw
      }

      assert.strictEqual(exitCode, 1);
    });

    it('3.3: pawthy pull when destination file has EACCES permission failure', async () => {
      const readOnlyFile = path.join(tempDir, '.env');
      await fs.writeFile(readOnlyFile, 'LOCKED=1');
      await fs.chmod(readOnlyFile, 0o444); // Read-only

      mock.method(axios, 'get', async () => {
        return { status: 200, data: { secrets: { LOCKED: '2' } } };
      });

      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});

      try {
        await pullCommand.parseAsync(['node', 'pawthy', 'pull', '--merge']);
      } catch {
        // Expected process.exit throw
      }

      // Re-enable write permissions so cleanup succeeds
      await fs.chmod(readOnlyFile, 0o666);

      assert.strictEqual(exitCode, 1);
    });
  });
});
