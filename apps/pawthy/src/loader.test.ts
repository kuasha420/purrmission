import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getCandidateEnvFiles, loadCascadingEnv } from './loader.js';

describe('Modular Environment Loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy-loader-test-'));
  });

  afterEach(async () => {
    mock.restoreAll();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('getCandidateEnvFiles', () => {
    it('returns .env and .env.local in order when no environment is provided', () => {
      const candidates = getCandidateEnvFiles(tempDir);
      assert.deepStrictEqual(candidates, [
        path.join(tempDir, '.env'),
        path.join(tempDir, '.env.local'),
      ]);
    });

    it('returns .env and .env.local when environment is empty or whitespace', () => {
      const candidates = getCandidateEnvFiles(tempDir, '   ');
      assert.deepStrictEqual(candidates, [
        path.join(tempDir, '.env'),
        path.join(tempDir, '.env.local'),
      ]);
    });

    it('returns cascading paths in correct precedence order when environment is specified', () => {
      const candidates = getCandidateEnvFiles(tempDir, 'development');
      assert.deepStrictEqual(candidates, [
        path.join(tempDir, '.env'),
        path.join(tempDir, '.env.development'),
        path.join(tempDir, '.env.local'),
        path.join(tempDir, '.env.development.local'),
      ]);
    });

    it('trims environment name when resolving candidate paths', () => {
      const candidates = getCandidateEnvFiles(tempDir, ' production ');
      assert.deepStrictEqual(candidates, [
        path.join(tempDir, '.env'),
        path.join(tempDir, '.env.production'),
        path.join(tempDir, '.env.local'),
        path.join(tempDir, '.env.production.local'),
      ]);
    });
  });

  describe('loadCascadingEnv', () => {
    it('returns empty object when no candidate env files exist', () => {
      const result = loadCascadingEnv({ rootDir: tempDir, environment: 'development' });
      assert.deepStrictEqual(result, {});
    });

    it('loads standard cascading env files (.env < .env.local) when environment is omitted', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'BASE_VAR=base\nSHARED_VAR=from_base');
      await fs.writeFile(
        path.join(tempDir, '.env.local'),
        'LOCAL_VAR=local\nSHARED_VAR=from_local'
      );

      const result = loadCascadingEnv({ rootDir: tempDir });
      assert.deepStrictEqual(result, {
        BASE_VAR: 'base',
        LOCAL_VAR: 'local',
        SHARED_VAR: 'from_local',
      });
    });

    it('strictly respects priority cascade (.env < .env.{env} < .env.local < .env.{env}.local)', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'VAR1=env\nVAR2=env\nVAR3=env\nVAR4=env');
      await fs.writeFile(
        path.join(tempDir, '.env.staging'),
        'VAR2=staging\nVAR3=staging\nVAR4=staging'
      );
      await fs.writeFile(path.join(tempDir, '.env.local'), 'VAR3=local\nVAR4=local');
      await fs.writeFile(path.join(tempDir, '.env.staging.local'), 'VAR4=staging.local');

      const result = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });
      assert.deepStrictEqual(result, {
        VAR1: 'env',
        VAR2: 'staging',
        VAR3: 'local',
        VAR4: 'staging.local',
      });
    });

    it('gracefully skips missing files in the cascade', async () => {
      // Only .env and .env.development.local exist
      await fs.writeFile(path.join(tempDir, '.env'), 'FOO=base\nBAR=base');
      await fs.writeFile(path.join(tempDir, '.env.development.local'), 'FOO=dev_local');

      const result = loadCascadingEnv({ rootDir: tempDir, environment: 'development' });
      assert.deepStrictEqual(result, {
        FOO: 'dev_local',
        BAR: 'base',
      });
    });

    it('correctly handles complex syntax edge cases (comments, quotes, multiline, equals)', async () => {
      const content = [
        '# This is a comment',
        'PLAIN_KEY=plain_value',
        "SINGLE_QUOTED='single quoted'",
        'DOUBLE_QUOTED="double quoted with # comment char"',
        'MULTILINE="line 1',
        'line 2"',
        'EQUALS_IN_VAL=foo=bar=baz',
        'EMPTY_VAL=',
      ].join('\n');

      await fs.writeFile(path.join(tempDir, '.env'), content);

      const result = loadCascadingEnv({ rootDir: tempDir });
      assert.deepStrictEqual(result, {
        PLAIN_KEY: 'plain_value',
        SINGLE_QUOTED: 'single quoted',
        DOUBLE_QUOTED: 'double quoted with # comment char',
        MULTILINE: 'line 1\nline 2',
        EQUALS_IN_VAL: 'foo=bar=baz',
        EMPTY_VAL: '',
      });
    });

    it('re-throws non-ENOENT file reading errors', async () => {
      // Create a directory named .env so readFileSync fails with EISDIR (or similar non-ENOENT)
      await fs.mkdir(path.join(tempDir, '.env'));

      assert.throws(() => {
        loadCascadingEnv({ rootDir: tempDir });
      });
    });
  });
});
