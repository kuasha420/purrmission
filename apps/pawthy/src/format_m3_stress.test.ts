import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  resolveFileAndFormat,
  deserializeSecrets,
  serializeSecrets,
  SecretFormat,
} from './format.js';
import { pushCommand } from './commands/push.js';
import { pullCommand } from './commands/pull.js';
import { config } from './config.js';

describe('Milestone 3 (R3) Multi-Format Secret Files Empirical Stress Tests', () => {
  describe('1. Scenario 1: Roundtrip Integrity across Formats with Special Characters', () => {
    const specialCases: Array<{ name: string; key: string; value: string }> = [
      { name: 'Equals', key: 'EQUALS_KEY', value: 'abc=def=123' },
      { name: 'Colon', key: 'COLON_KEY', value: 'http://localhost:8080/api:v1' },
      { name: 'Double Quote', key: 'DOUBLE_QUOTE_KEY', value: 'say "hello" world' },
      { name: 'Single Quote', key: 'SINGLE_QUOTE_KEY', value: "don't stop believing" },
      { name: 'Hash', key: 'HASH_KEY', value: 'color#ff0000#bg' },
      { name: 'Newline (LF)', key: 'NEWLINE_KEY', value: 'line1\nline2\nline3' },
      { name: 'CRLF', key: 'CRLF_KEY', value: 'line1\r\nline2' },
      { name: 'Spaces', key: 'SPACES_KEY', value: '   leading and trailing spaces   ' },
      { name: 'Unicode', key: 'UNICODE_KEY', value: '🚀 Pawthy 🔑 Secrets €100 日本語 🐱' },
      { name: 'Empty String', key: 'EMPTY_KEY', value: '' },
      { name: 'Combined Special Chars', key: 'COMBINED_KEY', value: 'a=b:c "d" \'e\' #f \n g 🚀' },
    ];

    const formats: SecretFormat[] = ['env', 'json', 'yaml', 'toml'];

    for (const fmt of formats) {
      describe(`Format: ${fmt.toUpperCase()}`, () => {
        for (const testCase of specialCases) {
          it(`roundtrips ${testCase.name} in ${fmt.toUpperCase()}`, () => {
            const inputSecrets = { [testCase.key]: testCase.value };
            const dummyPath = `test_secrets.${fmt === 'env' ? 'env' : fmt}`;
            const serialized = serializeSecrets(inputSecrets, fmt);
            const deserialized = deserializeSecrets(serialized, fmt, dummyPath);

            const expectedValue =
              fmt === 'env' && testCase.value.includes('\r\n')
                ? testCase.value.replace(/\r\n/g, '\n')
                : testCase.value;

            assert.strictEqual(
              deserialized[testCase.key],
              expectedValue,
              `Roundtrip mismatch for ${testCase.name} in format ${fmt}`
            );
          });
        }
      });
    }

    it('roundtrips JSON, YAML, TOML formats full dictionary with special characters', () => {
      const fullDict: Record<string, string> = {};
      for (const tc of specialCases) {
        fullDict[tc.key] = tc.value;
      }

      for (const fmt of ['json', 'yaml', 'toml'] as SecretFormat[]) {
        const dummyPath = `secrets.${fmt}`;
        const serialized = serializeSecrets(fullDict, fmt);
        const deserialized = deserializeSecrets(serialized, fmt, dummyPath);
        assert.deepStrictEqual(
          deserialized,
          fullDict,
          `Full dictionary roundtrip failed for ${fmt}`
        );
      }
    });
  });

  describe('2. Scenario 2: Extension & Format Priority', () => {
    it('prioritizes explicit --format flag over file extension', () => {
      // Explicit --format json on .yaml file uses JSON format
      const res1 = resolveFileAndFormat('secrets.yaml', 'json');
      assert.deepStrictEqual(res1, { file: 'secrets.yaml', format: 'json' });

      // Explicit --format toml on .env file uses TOML format
      const res2 = resolveFileAndFormat('.env', 'toml');
      assert.deepStrictEqual(res2, { file: '.env', format: 'toml' });

      // Explicit --format env on secrets.json file uses ENV format
      const res3 = resolveFileAndFormat('secrets.json', 'env');
      assert.deepStrictEqual(res3, { file: 'secrets.json', format: 'env' });

      // Explicit --format yml normalizes to yaml format
      const res4 = resolveFileAndFormat('config.toml', 'yml');
      assert.deepStrictEqual(res4, { file: 'config.toml', format: 'yaml' });
    });

    it('auto-detects format for all specified file extensions', () => {
      assert.deepStrictEqual(resolveFileAndFormat('secrets.json'), {
        file: 'secrets.json',
        format: 'json',
      });

      assert.deepStrictEqual(resolveFileAndFormat('secrets.yaml'), {
        file: 'secrets.yaml',
        format: 'yaml',
      });

      assert.deepStrictEqual(resolveFileAndFormat('secrets.yml'), {
        file: 'secrets.yml',
        format: 'yaml',
      });

      assert.deepStrictEqual(resolveFileAndFormat('secrets.toml'), {
        file: 'secrets.toml',
        format: 'toml',
      });

      assert.deepStrictEqual(resolveFileAndFormat('.env'), {
        file: '.env',
        format: 'env',
      });

      assert.deepStrictEqual(resolveFileAndFormat('.env.local'), {
        file: '.env.local',
        format: 'env',
      });

      assert.deepStrictEqual(resolveFileAndFormat('.env.production'), {
        file: '.env.production',
        format: 'env',
      });

      assert.deepStrictEqual(resolveFileAndFormat('.env.staging.local'), {
        file: '.env.staging.local',
        format: 'env',
      });

      assert.deepStrictEqual(resolveFileAndFormat('my_secrets.env'), {
        file: 'my_secrets.env',
        format: 'env',
      });
    });
  });

  describe('3. Scenario 3: CLI Execution & Edge Cases', () => {
    let tempDir: string;
    let exitCode: number | null = null;
    let consoleErrors: string[] = [];

    beforeEach(async () => {
      exitCode = null;
      consoleErrors = [];

      pushCommand.setOptionValueWithSource('file', undefined, 'default');
      pushCommand.setOptionValueWithSource('format', undefined, 'default');
      pushCommand.setOptionValueWithSource('force', undefined, 'default');
      pushCommand.setOptionValueWithSource('projectId', undefined, 'default');
      pushCommand.setOptionValueWithSource('envId', undefined, 'default');

      pullCommand.setOptionValueWithSource('file', undefined, 'default');
      pullCommand.setOptionValueWithSource('format', undefined, 'default');
      pullCommand.setOptionValueWithSource('projectId', undefined, 'default');
      pullCommand.setOptionValueWithSource('envId', undefined, 'default');

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy-edge-test-'));

      mock.method(process, 'cwd', () => tempDir);
      mock.method(process, 'exit', (code?: number) => {
        exitCode = code ?? null;
        throw new Error(`process.exit called with ${code}`);
      });

      mock.method(config, 'get', (key: string) => {
        if (key === 'token') return 'test-token';
        if (key === 'apiUrl') return 'http://localhost:3000';
        return undefined;
      });

      mock.method(console, 'error', (msg: string) => {
        consoleErrors.push(msg);
      });

      await fs.writeFile(
        path.join(tempDir, '.pawthyrc'),
        JSON.stringify({ projectId: 'test-proj', envId: 'test-env' })
      );
    });

    afterEach(async () => {
      mock.restoreAll();
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    it('returns descriptive error on invalid --format argument (e.g. --format xml)', async () => {
      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-F', 'xml']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(
        consoleErrors.some((e) =>
          e.includes("Unsupported format 'xml'. Supported formats are: env, json, yaml, toml.")
        )
      );
    });

    it('returns descriptive error when auto-detection fails for unrecognized extension', async () => {
      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.xml']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(
        consoleErrors.some((e) => e.includes("Could not auto-detect file format for 'secrets.xml'"))
      );
    });

    it('handles malformed JSON file on push with descriptive error', async () => {
      await fs.writeFile(path.join(tempDir, 'secrets.json'), '{\n  "FOO": "bar",\n');

      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.json']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('Could not parse JSON file at')));
    });

    it('handles malformed YAML file on push with descriptive error', async () => {
      await fs.writeFile(path.join(tempDir, 'secrets.yaml'), 'FOO: [unclosed array\nBAR: 123');

      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.yaml']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('Could not parse YAML file at')));
    });

    it('handles malformed TOML file on push with descriptive error', async () => {
      await fs.writeFile(path.join(tempDir, 'secrets.toml'), 'FOO = invalid toml syntax');

      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.toml']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('Could not parse TOML file at')));
    });

    it('handles non-object top-level structures (arrays, scalars) with descriptive error', async () => {
      // JSON Array
      await fs.writeFile(path.join(tempDir, 'secrets.json'), '[1, 2, 3]');
      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.json']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(
        consoleErrors.some((e) => e.includes('Top-level structure must be a key-value object.'))
      );

      consoleErrors = [];
      exitCode = null;

      // YAML Array
      await fs.writeFile(path.join(tempDir, 'secrets.yaml'), '- item1\n- item2');
      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.yaml']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(
        consoleErrors.some((e) => e.includes('Top-level structure must be a key-value object.'))
      );
    });
  });
});
