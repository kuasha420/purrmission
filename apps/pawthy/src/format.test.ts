import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import axios from 'axios';
import {
  resolveFileAndFormat,
  flattenSecrets,
  deserializeSecrets,
  serializeSecrets,
  getDefaultFilename,
} from './format.js';
import { pullCommand } from './commands/pull.js';
import { pushCommand } from './commands/push.js';
import { config } from './config.js';

describe('Format Module (Issue #64)', () => {
  describe('getDefaultFilename', () => {
    it('returns correct default filename for each format', () => {
      assert.strictEqual(getDefaultFilename('env'), '.env');
      assert.strictEqual(getDefaultFilename('json'), 'secrets.json');
      assert.strictEqual(getDefaultFilename('yaml'), 'secrets.yaml');
      assert.strictEqual(getDefaultFilename('toml'), 'secrets.toml');
    });
  });

  describe('resolveFileAndFormat', () => {
    it('defaults to .env and env format when no options provided', () => {
      const res = resolveFileAndFormat(undefined, undefined);
      assert.deepStrictEqual(res, { file: '.env', format: 'env' });
    });

    it('resolves explicit format flag with default file names', () => {
      assert.deepStrictEqual(resolveFileAndFormat(undefined, 'json'), {
        file: 'secrets.json',
        format: 'json',
      });
      assert.deepStrictEqual(resolveFileAndFormat(undefined, 'yaml'), {
        file: 'secrets.yaml',
        format: 'yaml',
      });
      assert.deepStrictEqual(resolveFileAndFormat(undefined, 'yml'), {
        file: 'secrets.yaml',
        format: 'yaml',
      });
      assert.deepStrictEqual(resolveFileAndFormat(undefined, 'toml'), {
        file: 'secrets.toml',
        format: 'toml',
      });
      assert.deepStrictEqual(resolveFileAndFormat(undefined, 'env'), {
        file: '.env',
        format: 'env',
      });
    });

    it('auto-detects format from file extension', () => {
      assert.deepStrictEqual(resolveFileAndFormat('custom.json'), {
        file: 'custom.json',
        format: 'json',
      });
      assert.deepStrictEqual(resolveFileAndFormat('custom.yaml'), {
        file: 'custom.yaml',
        format: 'yaml',
      });
      assert.deepStrictEqual(resolveFileAndFormat('custom.yml'), {
        file: 'custom.yml',
        format: 'yaml',
      });
      assert.deepStrictEqual(resolveFileAndFormat('custom.toml'), {
        file: 'custom.toml',
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
    });

    it('prioritizes explicit format flag over file extension', () => {
      assert.deepStrictEqual(resolveFileAndFormat('config.txt', 'json'), {
        file: 'config.txt',
        format: 'json',
      });
      assert.deepStrictEqual(resolveFileAndFormat('config.json', 'yaml'), {
        file: 'config.json',
        format: 'yaml',
      });
    });

    it('throws error for unsupported format string', () => {
      assert.throws(
        () => resolveFileAndFormat(undefined, 'xml'),
        (err: Error) =>
          err.message.includes("Unsupported format 'xml'") &&
          err.message.includes('Supported formats are: env, json, yaml, toml')
      );
    });

    it('throws error when format auto-detection fails for unrecognized extension', () => {
      assert.throws(
        () => resolveFileAndFormat('secrets.conf', undefined),
        (err: Error) =>
          err.message.includes("Could not auto-detect file format for 'secrets.conf'") &&
          err.message.includes('Please specify --format')
      );
    });
  });

  describe('flattenSecrets and primitive coercion', () => {
    it('coerces primitive numbers, booleans, and nulls to string', () => {
      const input = {
        str: 'hello',
        num: 123,
        boolTrue: true,
        boolFalse: false,
        nullVal: null,
      };
      const expected = {
        str: 'hello',
        num: '123',
        boolTrue: 'true',
        boolFalse: 'false',
        nullVal: '',
      };
      assert.deepStrictEqual(flattenSecrets(input), expected);
    });

    it('flattens nested object structures with dot notation', () => {
      const input = {
        app: {
          name: 'Purrmission',
          port: 3000,
        },
        database: {
          connection: {
            host: 'localhost',
            ssl: false,
          },
        },
      };
      const expected = {
        'app.name': 'Purrmission',
        'app.port': '3000',
        'database.connection.host': 'localhost',
        'database.connection.ssl': 'false',
      };
      assert.deepStrictEqual(flattenSecrets(input), expected);
    });
  });

  describe('deserializeSecrets', () => {
    it('deserializes .env format content', () => {
      const content = 'FOO=bar\nBAZ=123\n';
      const res = deserializeSecrets(content, 'env', '.env');
      assert.deepStrictEqual(res, { FOO: 'bar', BAZ: '123' });
    });

    it('deserializes JSON format content with flattening and primitive coercion', () => {
      const content = JSON.stringify({
        FOO: 'bar',
        PORT: 8080,
        DEBUG: true,
        db: { host: 'localhost' },
      });
      const res = deserializeSecrets(content, 'json', 'secrets.json');
      assert.deepStrictEqual(res, {
        FOO: 'bar',
        PORT: '8080',
        DEBUG: 'true',
        'db.host': 'localhost',
      });
    });

    it('deserializes YAML format content', () => {
      const content = 'FOO: bar\nPORT: 8080\ndb:\n  host: localhost\n';
      const res = deserializeSecrets(content, 'yaml', 'secrets.yaml');
      assert.deepStrictEqual(res, {
        FOO: 'bar',
        PORT: '8080',
        'db.host': 'localhost',
      });
    });

    it('deserializes TOML format content', () => {
      const content = 'FOO = "bar"\nPORT = 8080\n[db]\nhost = "localhost"\n';
      const res = deserializeSecrets(content, 'toml', 'secrets.toml');
      assert.deepStrictEqual(res, {
        FOO: 'bar',
        PORT: '8080',
        'db.host': 'localhost',
      });
    });

    it('returns empty object for empty content', () => {
      assert.deepStrictEqual(deserializeSecrets('', 'json', 'secrets.json'), {});
      assert.deepStrictEqual(deserializeSecrets('  \n ', 'yaml', 'secrets.yaml'), {});
      assert.deepStrictEqual(deserializeSecrets('', 'toml', 'secrets.toml'), {});
    });

    it('throws error for malformed JSON file syntax', () => {
      assert.throws(
        () => deserializeSecrets('{ invalid json ', 'json', 'secrets.json'),
        (err: Error) => err.message.includes('Could not parse JSON file at secrets.json')
      );
    });

    it('throws error for malformed YAML file syntax', () => {
      assert.throws(
        () => deserializeSecrets('FOO: [unclosed array', 'yaml', 'secrets.yaml'),
        (err: Error) => err.message.includes('Could not parse YAML file at secrets.yaml')
      );
    });

    it('throws error for malformed TOML file syntax', () => {
      assert.throws(
        () => deserializeSecrets('FOO = invalid toml', 'toml', 'secrets.toml'),
        (err: Error) => err.message.includes('Could not parse TOML file at secrets.toml')
      );
    });

    it('throws error when top-level structure is not a key-value object', () => {
      assert.throws(
        () => deserializeSecrets('[1, 2, 3]', 'json', 'secrets.json'),
        (err: Error) =>
          err.message.includes(
            'Invalid content in secrets.json. Top-level structure must be a key-value object.'
          )
      );
      assert.throws(
        () => deserializeSecrets('"just a string"', 'json', 'secrets.json'),
        (err: Error) => err.message.includes('Top-level structure must be a key-value object.')
      );
    });
  });

  describe('serializeSecrets & Roundtripping', () => {
    const testSecrets = {
      API_KEY: 'secret_123',
      PORT: '3000',
      ENABLE_FEATURE: 'true',
    };

    it('roundtrips ENV format', () => {
      const serialized = serializeSecrets(testSecrets, 'env');
      const deserialized = deserializeSecrets(serialized, 'env', '.env');
      assert.deepStrictEqual(deserialized, testSecrets);
    });

    it('roundtrips JSON format', () => {
      const serialized = serializeSecrets(testSecrets, 'json');
      const deserialized = deserializeSecrets(serialized, 'json', 'secrets.json');
      assert.deepStrictEqual(deserialized, testSecrets);
    });

    it('roundtrips YAML format', () => {
      const serialized = serializeSecrets(testSecrets, 'yaml');
      const deserialized = deserializeSecrets(serialized, 'yaml', 'secrets.yaml');
      assert.deepStrictEqual(deserialized, testSecrets);
    });

    it('roundtrips TOML format', () => {
      const serialized = serializeSecrets(testSecrets, 'toml');
      const deserialized = deserializeSecrets(serialized, 'toml', 'secrets.toml');
      assert.deepStrictEqual(deserialized, testSecrets);
    });

    it('merges secrets into existing JSON file', () => {
      const existing = JSON.stringify({ EXISTING: 'old', API_KEY: 'old_key' }, null, 2);
      const serialized = serializeSecrets(testSecrets, 'json', existing);
      const deserialized = deserializeSecrets(serialized, 'json', 'secrets.json');
      assert.deepStrictEqual(deserialized, {
        EXISTING: 'old',
        API_KEY: 'secret_123',
        PORT: '3000',
        ENABLE_FEATURE: 'true',
      });
    });

    it('merges secrets into existing YAML file', () => {
      const existing = 'EXISTING: old\nAPI_KEY: old_key\n';
      const serialized = serializeSecrets(testSecrets, 'yaml', existing);
      const deserialized = deserializeSecrets(serialized, 'yaml', 'secrets.yaml');
      assert.deepStrictEqual(deserialized, {
        EXISTING: 'old',
        API_KEY: 'secret_123',
        PORT: '3000',
        ENABLE_FEATURE: 'true',
      });
    });

    it('merges secrets into existing TOML file', () => {
      const existing = 'EXISTING = "old"\nAPI_KEY = "old_key"\n';
      const serialized = serializeSecrets(testSecrets, 'toml', existing);
      const deserialized = deserializeSecrets(serialized, 'toml', 'secrets.toml');
      assert.deepStrictEqual(deserialized, {
        EXISTING: 'old',
        API_KEY: 'secret_123',
        PORT: '3000',
        ENABLE_FEATURE: 'true',
      });
    });
  });

  describe('CLI Multi-Format Integration', () => {
    let tempDir: string;
    let exitCode: number | null = null;
    let consoleLogs: string[] = [];
    let consoleErrors: string[] = [];

    beforeEach(async () => {
      exitCode = null;
      consoleLogs = [];
      consoleErrors = [];

      pullCommand.setOptionValueWithSource('file', undefined, 'default');
      pullCommand.setOptionValueWithSource('format', undefined, 'default');
      pullCommand.setOptionValueWithSource('projectId', undefined, 'default');
      pullCommand.setOptionValueWithSource('envId', undefined, 'default');
      pullCommand.setOptionValueWithSource('keys', undefined, 'default');
      pullCommand.setOptionValueWithSource('merge', undefined, 'default');
      pullCommand.setOptionValueWithSource('env', undefined, 'default');

      pushCommand.setOptionValueWithSource('file', undefined, 'default');
      pushCommand.setOptionValueWithSource('format', undefined, 'default');
      pushCommand.setOptionValueWithSource('force', undefined, 'default');
      pushCommand.setOptionValueWithSource('projectId', undefined, 'default');
      pushCommand.setOptionValueWithSource('envId', undefined, 'default');
      pushCommand.setOptionValueWithSource('keys', undefined, 'default');
      pushCommand.setOptionValueWithSource('env', undefined, 'default');

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawthy-format-test-'));

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

      mock.method(console, 'log', (msg: string) => {
        consoleLogs.push(msg);
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
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('pawthy pull with --format json writes secrets.json', async () => {
      mock.method(
        axios,
        'get',
        async (): Promise<{ status: number; data: unknown }> => ({
          status: 200,
          data: { secrets: { DB_HOST: 'localhost', PORT: '5432' } },
        })
      );

      await pullCommand.parseAsync(['node', 'pawthy', 'pull', '-F', 'json']);

      const filePath = path.join(tempDir, 'secrets.json');
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(fileContent);
      assert.deepStrictEqual(parsed, { DB_HOST: 'localhost', PORT: '5432' });
    });

    it('pawthy pull auto-detects .yaml file extension', async () => {
      mock.method(
        axios,
        'get',
        async (): Promise<{ status: number; data: unknown }> => ({
          status: 200,
          data: { secrets: { SERVICE: 'auth' } },
        })
      );

      await pullCommand.parseAsync(['node', 'pawthy', 'pull', '-f', 'config.yaml']);

      const filePath = path.join(tempDir, 'config.yaml');
      const fileContent = await fs.readFile(filePath, 'utf-8');
      assert.ok(fileContent.includes('SERVICE: auth'));
    });

    it('pawthy push reads and parses .toml file', async () => {
      await fs.writeFile(path.join(tempDir, 'secrets.toml'), 'KEY = "value_123"\nNUM = 42\n');

      let pushedPayload: Record<string, string> | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mock.method(axios, 'put', async (_url: string, body: any): Promise<any> => {
        pushedPayload = body.secrets;
        return { status: 200, data: { success: true } };
      });

      await pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.toml', '--force']);

      assert.deepStrictEqual(pushedPayload, { KEY: 'value_123', NUM: '42' });
    });

    it('pawthy push with explicit --format json overrides file extension', async () => {
      await fs.writeFile(
        path.join(tempDir, 'secrets.txt'),
        JSON.stringify({ CUSTOM_KEY: 'custom_val' })
      );

      let pushedPayload: Record<string, string> | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mock.method(axios, 'put', async (_url: string, body: any): Promise<any> => {
        pushedPayload = body.secrets;
        return { status: 200, data: { success: true } };
      });

      await pushCommand.parseAsync([
        'node',
        'pawthy',
        'push',
        '-f',
        'secrets.txt',
        '-F',
        'json',
        '--force',
      ]);

      assert.deepStrictEqual(pushedPayload, { CUSTOM_KEY: 'custom_val' });
    });

    it('pawthy push fails gracefully on invalid format string', async () => {
      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-F', 'invalidFormat']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes("Unsupported format 'invalidFormat'")));
    });

    it('pawthy push fails gracefully on unknown file extension without format flag', async () => {
      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.unknown']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(
        consoleErrors.some((e) =>
          e.includes("Could not auto-detect file format for 'secrets.unknown'")
        )
      );
    });

    it('pawthy push fails gracefully on syntax error in JSON file', async () => {
      await fs.writeFile(path.join(tempDir, 'secrets.json'), '{ bad json content ');

      await assert.rejects(
        () => pushCommand.parseAsync(['node', 'pawthy', 'push', '-f', 'secrets.json']),
        /process.exit called with 1/
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(consoleErrors.some((e) => e.includes('Could not parse JSON file at')));
    });
  });
});
