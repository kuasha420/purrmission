import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

describe('validate-env.cjs', () => {
  const tempDir = path.join(os.tmpdir(), `purrmission-test-${Date.now()}`);
  const scriptPath = path.resolve(process.cwd(), 'scripts/validate-env.cjs');

  before(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runValidator(envContent: string | null) {
    const testEnvPath = path.join(tempDir, '.env.test');
    if (envContent !== null) {
      fs.writeFileSync(testEnvPath, envContent);
    }

    return spawnSync('node', [scriptPath], {
      cwd: process.cwd(), // Run in root to find node_modules
      env: {
        ...process.env,
        ENV_PATH_OVERRIDE: envContent !== null ? testEnvPath : '/non/existent/.env',
      },
      encoding: 'utf-8',
    });
  }

  it('should fail if .env is missing', () => {
    const result = runValidator(null);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('CRITICAL: .env file missing'));
  });

  it('should pass with a perfectly valid configuration', () => {
    const validEnv = `
DISCORD_BOT_TOKEN=token123
DISCORD_CLIENT_ID=client123
DISCORD_GUILD_ID=guild123
ENCRYPTION_KEY=${'a'.repeat(64)}
DATABASE_URL="file:../data/prod.db"
        `;
    const result = runValidator(validEnv);
    assert.strictEqual(result.status, 0, `Failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('validation passed'));
  });

  it('should fail if a required key is missing', () => {
    const invalidEnv = `
DISCORD_BOT_TOKEN=token123
ENCRYPTION_KEY=${'a'.repeat(64)}
DATABASE_URL="file:../data/prod.db"
        `;
    const result = runValidator(invalidEnv);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('DISCORD_CLIENT_ID is required'));
  });

  it('should fail if ENCRYPTION_KEY is not 64 hex characters', () => {
    const invalidEnv = `
DISCORD_BOT_TOKEN=token123
DISCORD_CLIENT_ID=client123
DISCORD_GUILD_ID=guild123
ENCRYPTION_KEY=tooshort
DATABASE_URL="file:../data/prod.db"
        `;
    const result = runValidator(invalidEnv);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('ENCRYPTION_KEY must be a 64-character hexadecimal string'));
  });

  it('should fail if DATABASE_URL points to prisma/ directory', () => {
    const fragileEnv = `
DISCORD_BOT_TOKEN=token123
DISCORD_CLIENT_ID=client123
DISCORD_GUILD_ID=guild123
ENCRYPTION_KEY=${'a'.repeat(64)}
DATABASE_URL="file:./prisma/dev.db"
        `;
    const result = runValidator(fragileEnv);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('points to a volatile directory'));
  });

  it('should fail if DATABASE_URL is not in a data/ directory', () => {
    const invalidDirEnv = `
DISCORD_BOT_TOKEN=token123
DISCORD_CLIENT_ID=client123
DISCORD_GUILD_ID=guild123
ENCRYPTION_KEY=${'a'.repeat(64)}
DATABASE_URL="file:./mydb.sqlite"
        `;
    const result = runValidator(invalidDirEnv);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('must point to a file inside a "data/" directory'));
  });

  it('should NOT fail for valid paths containing the string "prisma" but not as a segment', () => {
    const edgeCaseEnv = `
DISCORD_BOT_TOKEN=token123
DISCORD_CLIENT_ID=client123
DISCORD_GUILD_ID=guild123
ENCRYPTION_KEY=${'a'.repeat(64)}
DATABASE_URL="file:../data/prisma-backup.db"
        `;
    const result = runValidator(edgeCaseEnv);
    assert.strictEqual(
      result.status,
      0,
      `Edge case failed but should have passed: ${result.stderr}`
    );
  });
});
