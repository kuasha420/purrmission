import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { getCandidateEnvFiles, loadCascadingEnv } from './loader.js';
import { resolveFileAndFormat } from './format.js';

describe('Empirical Stress Test Harness - Milestone 2 (.env.* Cascading & CLI Flags)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy-stress-m2-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // =========================================================================
  // 1. PRIORITY LEVELS CASCADING (.env < .env.staging < .env.local < .env.staging.local)
  // =========================================================================
  describe('1. Four Priority Levels Cascading', () => {
    it('returns candidate file paths in exact order of lowest to highest precedence', () => {
      const candidates = getCandidateEnvFiles(tempDir, 'staging');
      assert.deepStrictEqual(candidates, [
        path.join(tempDir, '.env'),
        path.join(tempDir, '.env.staging'),
        path.join(tempDir, '.env.local'),
        path.join(tempDir, '.env.staging.local'),
      ]);
    });

    it('resolves all 4 levels when all 4 files exist simultaneously', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'K1=v1_env\nK2=v2_env\nK3=v3_env\nK4=v4_env');
      await fs.writeFile(
        path.join(tempDir, '.env.staging'),
        'K2=v2_staging\nK3=v3_staging\nK4=v4_staging'
      );
      await fs.writeFile(path.join(tempDir, '.env.local'), 'K3=v3_local\nK4=v4_local');
      await fs.writeFile(path.join(tempDir, '.env.staging.local'), 'K4=v4_staging_local');

      const result = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });
      assert.deepStrictEqual(result, {
        K1: 'v1_env',
        K2: 'v2_staging',
        K3: 'v3_local',
        K4: 'v4_staging_local',
      });
    });

    it('verifies Priority 2 (.env.staging) overrides Priority 1 (.env)', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'VAR=base');
      await fs.writeFile(path.join(tempDir, '.env.staging'), 'VAR=staging');

      const result = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });
      assert.strictEqual(result['VAR'], 'staging');
    });

    it('verifies Priority 3 (.env.local) overrides Priority 2 (.env.staging)', async () => {
      await fs.writeFile(path.join(tempDir, '.env.staging'), 'VAR=staging');
      await fs.writeFile(path.join(tempDir, '.env.local'), 'VAR=local');

      const result = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });
      assert.strictEqual(result['VAR'], 'local');
    });

    it('verifies Priority 4 (.env.staging.local) overrides Priority 3 (.env.local)', async () => {
      await fs.writeFile(path.join(tempDir, '.env.local'), 'VAR=local');
      await fs.writeFile(path.join(tempDir, '.env.staging.local'), 'VAR=staging_local');

      const result = loadCascadingEnv({ rootDir: tempDir, environment: 'staging' });
      assert.strictEqual(result['VAR'], 'staging_local');
    });
  });

  // =========================================================================
  // 2. SUBSET EXISTENCE COMBINATIONS (All 16 combinations of 4 files)
  // =========================================================================
  describe('2. Precedence Combinations for All 16 File Existence Subsets', () => {
    const filesSpec = [
      { name: '.env', tag: 'P1_ENV', priority: 1 },
      { name: '.env.staging', tag: 'P2_STAGING', priority: 2 },
      { name: '.env.local', tag: 'P3_LOCAL', priority: 3 },
      { name: '.env.staging.local', tag: 'P4_STAGING_LOCAL', priority: 4 },
    ];

    // Loop through all 2^4 = 16 combinations
    for (let mask = 0; mask < 16; mask++) {
      const activeFiles = filesSpec.filter((_, idx) => (mask & (1 << idx)) !== 0);
      const activeNames = activeFiles.map((f) => f.name).join(', ') || 'NONE';

      it(`Subset mask ${mask} [${activeNames}]: resolves highest priority file and skips missing files gracefully`, async () => {
        const subDir = await fs.mkdtemp(path.join(tempDir, `mask-${mask}-`));

        for (const fileObj of activeFiles) {
          await fs.writeFile(
            path.join(subDir, fileObj.name),
            `SHARED_VAR=${fileObj.tag}\nUNIQUE_${fileObj.tag}=yes`
          );
        }

        const result = loadCascadingEnv({ rootDir: subDir, environment: 'staging' });

        if (activeFiles.length === 0) {
          assert.deepStrictEqual(result, {});
        } else {
          const highestActive = activeFiles.reduce((prev, curr) =>
            curr.priority > prev.priority ? curr : prev
          );

          // Highest priority existing file wins
          assert.strictEqual(
            result['SHARED_VAR'],
            highestActive.tag,
            `In subset [${activeNames}], expected SHARED_VAR to be '${highestActive.tag}' but got '${result['SHARED_VAR']}'`
          );

          // Unique keys from all existing files are merged
          for (const fileObj of activeFiles) {
            assert.strictEqual(result[`UNIQUE_${fileObj.tag}`], 'yes');
          }
        }
      });
    }
  });

  // =========================================================================
  // 3. EDGE CASE CONTENT SYNTAX PARSING
  // =========================================================================
  describe('3. Edge Case Content Syntax Parsing', () => {
    it('parses values containing multiple equal signs correctly', async () => {
      await fs.writeFile(
        path.join(tempDir, '.env'),
        'URL=https://example.com/api?a=1&b=2\nEQUALS====\nCOMPLEX=foo=bar=baz'
      );
      const result = loadCascadingEnv({ rootDir: tempDir });
      assert.strictEqual(result['URL'], 'https://example.com/api?a=1&b=2');
      assert.strictEqual(result['EQUALS'], '===');
      assert.strictEqual(result['COMPLEX'], 'foo=bar=baz');
    });

    it('handles trailing whitespace for unquoted vs quoted values', async () => {
      await fs.writeFile(
        path.join(tempDir, '.env'),
        'UNQUOTED=value   \nQUOTED="value   "\nSINGLE_QUOTED=\'value   \''
      );
      const result = loadCascadingEnv({ rootDir: tempDir });
      assert.strictEqual(result['UNQUOTED'], 'value');
      assert.strictEqual(result['QUOTED'], 'value   ');
      assert.strictEqual(result['SINGLE_QUOTED'], 'value   ');
    });

    it('parses multiline values enclosed in double quotes', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'MULTILINE="line 1\nline 2\nline 3"');
      const result = loadCascadingEnv({ rootDir: tempDir });
      assert.strictEqual(result['MULTILINE'], 'line 1\nline 2\nline 3');
    });

    it('ignores commented lines and handles inline comments correctly', async () => {
      await fs.writeFile(
        path.join(tempDir, '.env'),
        '# FULL_COMMENT=ignored\n  # INDENTED_COMMENT=ignored\nINLINE=hello # inline comment\nQUOTED_HASH="val # hash"'
      );
      const result = loadCascadingEnv({ rootDir: tempDir });
      assert.strictEqual(result['FULL_COMMENT'], undefined);
      assert.strictEqual(result['INDENTED_COMMENT'], undefined);
      assert.strictEqual(result['INLINE'], 'hello');
      assert.strictEqual(result['QUOTED_HASH'], 'val # hash');
    });

    it('handles empty strings, quotes, and escaped quotes', async () => {
      await fs.writeFile(
        path.join(tempDir, '.env'),
        'EMPTY=\nEMPTY_DBL=""\nEMPTY_SGL=\'\'\nESCAPED="hello \\"world\\""\nSINGLE=\'hello "world"\''
      );
      const result = loadCascadingEnv({ rootDir: tempDir });
      assert.strictEqual(result['EMPTY'], '');
      assert.strictEqual(result['EMPTY_DBL'], '');
      assert.strictEqual(result['EMPTY_SGL'], '');
      assert.strictEqual(result['ESCAPED'], 'hello \\"world\\"');
      assert.strictEqual(result['SINGLE'], 'hello "world"');
    });

    it('handles export prefix and leading/trailing spaces around key and equals', async () => {
      await fs.writeFile(
        path.join(tempDir, '.env'),
        'export EXPORTED=true\n  SPACED_KEY  =  spaced_value  '
      );
      const result = loadCascadingEnv({ rootDir: tempDir });
      assert.strictEqual(result['EXPORTED'], 'true');
      assert.strictEqual(result['SPACED_KEY'], 'spaced_value');
    });
  });

  // =========================================================================
  // 4. CLI OPTION BEHAVIOR: -f OVERRIDE vs -E FLAG
  // =========================================================================
  describe('4. CLI Option Non-Interference (-f, --file vs -E, --env)', () => {
    function resolveCliOptions(args: string[]) {
      const cmd = new Command('test')
        .option('-f, --file <path>', 'Secret file')
        .option('-F, --format <format>', 'Secret format')
        .option('-E, --env <environment>', 'Environment');

      cmd.parse(args, { from: 'user' });
      const opts = cmd.opts();

      const isFileExplicit = cmd.getOptionValueSource('file') === 'cli';
      const isFormatExplicit = cmd.getOptionValueSource('format') === 'cli';

      const resolved = resolveFileAndFormat(opts.file, opts.format);
      let file = resolved.file;
      const format = resolved.format;

      if (opts.env && !isFileExplicit && !isFormatExplicit && format === 'env') {
        file = `.env.${opts.env}`;
      }

      const shouldCascade = !isFileExplicit && !isFormatExplicit && format === 'env';

      return { file, format, isFileExplicit, isFormatExplicit, shouldCascade, opts };
    }

    it('pawthy push -E staging -> defaults to .env.staging and enables cascading', () => {
      const res = resolveCliOptions(['-E', 'staging']);
      assert.strictEqual(res.file, '.env.staging');
      assert.strictEqual(res.shouldCascade, true);
    });

    it('pawthy push -E staging -f custom.env -> explicit -f overrides file and disables cascading', () => {
      const res = resolveCliOptions(['-E', 'staging', '-f', 'custom.env']);
      assert.strictEqual(res.file, 'custom.env');
      assert.strictEqual(res.shouldCascade, false);
      assert.strictEqual(res.isFileExplicit, true);
    });

    it('pawthy push -E staging -f .env -> explicit -f .env overrides file and disables cascading', () => {
      const res = resolveCliOptions(['-E', 'staging', '-f', '.env']);
      assert.strictEqual(res.file, '.env');
      assert.strictEqual(res.shouldCascade, false);
      assert.strictEqual(res.isFileExplicit, true);
    });

    it('pawthy push -f custom.env -> explicit -f disables cascading', () => {
      const res = resolveCliOptions(['-f', 'custom.env']);
      assert.strictEqual(res.file, 'custom.env');
      assert.strictEqual(res.shouldCascade, false);
      assert.strictEqual(res.isFileExplicit, true);
    });

    it('pawthy push (no flags) -> defaults to .env and enables cascading (.env < .env.local)', () => {
      const res = resolveCliOptions([]);
      assert.strictEqual(res.file, '.env');
      assert.strictEqual(res.shouldCascade, true);
    });

    it('pawthy pull -E staging -> target .env.staging', () => {
      const res = resolveCliOptions(['-E', 'staging']);
      assert.strictEqual(res.file, '.env.staging');
    });

    it('pawthy pull -E staging -f custom.env -> explicit -f overrides -E flag to custom.env', () => {
      const res = resolveCliOptions(['-E', 'staging', '-f', 'custom.env']);
      assert.strictEqual(res.file, 'custom.env');
      assert.strictEqual(res.isFileExplicit, true);
    });

    it('pawthy pull -E staging -f .env -> explicit -f overrides -E flag to .env', () => {
      const res = resolveCliOptions(['-E', 'staging', '-f', '.env']);
      assert.strictEqual(res.file, '.env');
      assert.strictEqual(res.isFileExplicit, true);
    });

    it('pawthy pull -f custom.env -> target custom.env', () => {
      const res = resolveCliOptions(['-f', 'custom.env']);
      assert.strictEqual(res.file, 'custom.env');
    });

    it('pawthy pull (no flags) -> target .env', () => {
      const res = resolveCliOptions([]);
      assert.strictEqual(res.file, '.env');
    });
  });
});
