import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import {
  createEncryptedBackup,
  enforceBackupRetention,
  parseBackupKeyRing,
  runVerifiedOffsiteRoundTrip,
  verifyAndRestoreEncryptedBackup,
} from './backup-db.js';

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);
const KEY_RING = new Map([['backup-a', KEY_A]]);
const NOW = new Date('2026-08-20T00:00:00.000Z');
const MAX_DATABASE_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `purrmission-backup-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureDatabase(directory: string): string {
  const databasePath = path.join(directory, 'production.db');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE "_prisma_migrations" (
        "migration_name" TEXT PRIMARY KEY,
        "finished_at" DATETIME,
        "rolled_back_at" DATETIME
      );
      INSERT INTO "_prisma_migrations" VALUES ('20260820010000_metadata_target_versions', CURRENT_TIMESTAMP, NULL);
      CREATE TABLE "SecretFixture" ("id" TEXT PRIMARY KEY, "value" TEXT NOT NULL);
      INSERT INTO "SecretFixture" VALUES ('fixture', 'plaintext-must-never-enter-package');
    `);
  } finally {
    database.close();
  }
  return databasePath;
}

function createFixturePackage(name: string, now = NOW) {
  const root = temporaryDirectory(name);
  const databasePath = fixtureDatabase(root);
  const created = createEncryptedBackup({
    databasePath,
    outputDirectory: path.join(root, 'packages'),
    keyId: 'backup-a',
    key: KEY_A,
    maximumDatabaseBytes: MAX_DATABASE_BYTES,
    now,
  });
  return { root, databasePath, ...created };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('verified encrypted database backup', () => {
  it('creates an authenticated package and restores it only into an isolated location', () => {
    const fixture = createFixturePackage('roundtrip');
    const serialized = fs.readFileSync(fixture.packagePath, 'utf8');
    assert.equal(serialized.includes('plaintext-must-never-enter-package'), false);
    assert.equal(fs.statSync(fixture.packagePath).mode & 0o777, 0o600);

    const restored = verifyAndRestoreEncryptedBackup({
      packagePath: fixture.packagePath,
      keyRing: KEY_RING,
      restoreRoot: path.join(fixture.root, 'isolated'),
      productionDatabasePath: fixture.databasePath,
      maximumAgeMs: 60_000,
      maximumPackageBytes: MAX_PACKAGE_BYTES,
      now: NOW,
    });
    assert.notEqual(restored.restoredDatabasePath, fixture.databasePath);
    const database = new DatabaseSync(restored.restoredDatabasePath, { readOnly: true });
    try {
      const row = database.prepare('SELECT * FROM "SecretFixture"').get() as {
        id: string;
        value: string;
      };
      assert.equal(row.id, 'fixture');
      assert.equal(row.value, 'plaintext-must-never-enter-package');
    } finally {
      database.close();
    }
    assert.deepEqual(restored.manifest.migrationNames, ['20260820010000_metadata_target_versions']);
  });

  it('verifies a recovery package when the intended production database is absent', () => {
    const fixture = createFixturePackage('lost-production');
    fs.rmSync(fixture.databasePath);

    const restored = verifyAndRestoreEncryptedBackup({
      packagePath: fixture.packagePath,
      keyRing: KEY_RING,
      restoreRoot: path.join(fixture.root, 'disaster-recovery'),
      productionDatabasePath: fixture.databasePath,
      maximumAgeMs: 60_000,
      maximumPackageBytes: MAX_PACKAGE_BYTES,
      now: NOW,
    });

    assert.equal(fs.existsSync(restored.restoredDatabasePath), true);
    assert.equal(fs.existsSync(fixture.databasePath), false);
  });

  it('captures committed WAL state in the consistent SQLite snapshot', () => {
    const root = temporaryDirectory('wal');
    const databasePath = fixtureDatabase(root);
    const live = new DatabaseSync(databasePath);
    try {
      live.exec('PRAGMA journal_mode = WAL');
      live.exec(`INSERT INTO "SecretFixture" VALUES ('wal-row', 'committed-before-snapshot')`);
      const created = createEncryptedBackup({
        databasePath,
        outputDirectory: path.join(root, 'packages'),
        keyId: 'backup-a',
        key: KEY_A,
        maximumDatabaseBytes: MAX_DATABASE_BYTES,
        now: NOW,
      });
      const restored = verifyAndRestoreEncryptedBackup({
        packagePath: created.packagePath,
        keyRing: KEY_RING,
        restoreRoot: path.join(root, 'isolated'),
        productionDatabasePath: databasePath,
        maximumAgeMs: 60_000,
        maximumPackageBytes: MAX_PACKAGE_BYTES,
        now: NOW,
      });
      const copy = new DatabaseSync(restored.restoredDatabasePath, { readOnly: true });
      try {
        assert.equal(
          (
            copy.prepare(`SELECT "value" FROM "SecretFixture" WHERE "id" = 'wal-row'`).get() as {
              value: string;
            }
          ).value,
          'committed-before-snapshot'
        );
      } finally {
        copy.close();
      }
    } finally {
      live.close();
    }
  });

  it('rejects wrong keys, tampering, truncation, and stale manifests', () => {
    const fixture = createFixturePackage('adversarial');
    const verify = (packagePath: string, keyRing = KEY_RING, now = NOW) =>
      verifyAndRestoreEncryptedBackup({
        packagePath,
        keyRing,
        restoreRoot: path.join(fixture.root, `restore-${path.basename(packagePath)}`),
        productionDatabasePath: fixture.databasePath,
        maximumAgeMs: 60_000,
        maximumPackageBytes: MAX_PACKAGE_BYTES,
        now,
      });

    assert.throws(
      () => verify(fixture.packagePath, new Map([['backup-a', KEY_B]])),
      /authentication|decryption/
    );

    const parsed = JSON.parse(fs.readFileSync(fixture.packagePath, 'utf8')) as {
      manifest: { packageId: string; sha256: string };
      ciphertext: string;
    };
    const finalDigestCharacter = parsed.manifest.sha256.at(-1);
    parsed.manifest.sha256 = `${parsed.manifest.sha256.slice(0, -1)}${
      finalDigestCharacter === '0' ? '1' : '0'
    }`;
    const tampered = path.join(fixture.root, 'tampered.purrbackup');
    fs.writeFileSync(tampered, JSON.stringify(parsed));
    assert.throws(() => verify(tampered), /authentication|decryption/);

    parsed.manifest.packageId = '../../production';
    const traversing = path.join(fixture.root, 'traversing.purrbackup');
    fs.writeFileSync(traversing, JSON.stringify(parsed));
    assert.throws(() => verify(traversing), /package ID is invalid/);

    const truncated = path.join(fixture.root, 'truncated.purrbackup');
    fs.writeFileSync(truncated, fs.readFileSync(fixture.packagePath).subarray(0, 32));
    assert.throws(() => verify(truncated), /valid JSON/);
    assert.throws(
      () => verify(fixture.packagePath, KEY_RING, new Date(NOW.getTime() + 61_000)),
      /stale/
    );
    assert.throws(
      () =>
        verifyAndRestoreEncryptedBackup({
          packagePath: fixture.packagePath,
          keyRing: KEY_RING,
          restoreRoot: path.join(fixture.root, 'oversized-package'),
          productionDatabasePath: fixture.databasePath,
          maximumAgeMs: 60_000,
          maximumPackageBytes: 1,
          now: NOW,
        }),
      /exceeds the configured size limit/
    );
    assert.throws(
      () =>
        createEncryptedBackup({
          databasePath: fixture.databasePath,
          outputDirectory: path.join(fixture.root, 'oversized-database'),
          keyId: 'backup-a',
          key: KEY_A,
          maximumDatabaseBytes: 1,
          now: NOW,
        }),
      /exceeds BACKUP_MAX_DATABASE_BYTES/
    );
  });

  it('refuses a restore root that could contain the production database', () => {
    const fixture = createFixturePackage('production-guard');
    assert.throws(
      () =>
        verifyAndRestoreEncryptedBackup({
          packagePath: fixture.packagePath,
          keyRing: KEY_RING,
          restoreRoot: fixture.root,
          productionDatabasePath: fixture.databasePath,
          maximumAgeMs: 60_000,
          maximumPackageBytes: MAX_PACKAGE_BYTES,
          now: NOW,
        }),
      /must not contain/
    );
    const permissiveRoot = temporaryDirectory('permissive-restore');
    fs.chmodSync(permissiveRoot, 0o755);
    assert.throws(
      () =>
        verifyAndRestoreEncryptedBackup({
          packagePath: fixture.packagePath,
          keyRing: KEY_RING,
          restoreRoot: permissiveRoot,
          productionDatabasePath: fixture.databasePath,
          maximumAgeMs: 60_000,
          maximumPackageBytes: MAX_PACKAGE_BYTES,
          now: NOW,
        }),
      /must not grant group or world/
    );
    assert.equal(fs.existsSync(fixture.databasePath), true);
    const symlink = path.join(temporaryDirectory('restore-link'), 'root-link');
    fs.symlinkSync(fixture.root, symlink);
    assert.throws(
      () =>
        verifyAndRestoreEncryptedBackup({
          packagePath: fixture.packagePath,
          keyRing: KEY_RING,
          restoreRoot: symlink,
          productionDatabasePath: fixture.databasePath,
          maximumAgeMs: 60_000,
          maximumPackageBytes: MAX_PACKAGE_BYTES,
          now: NOW,
        }),
      /must not contain/
    );
  });

  it('round-trips through the configured offsite mount and rejects local deployment storage', () => {
    const root = temporaryDirectory('offsite');
    const deploymentRoot = path.join(root, 'deployment');
    const offsiteDirectory = path.join(root, 'separate-offsite-mount');
    const dataDirectory = path.join(deploymentRoot, 'data');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const databasePath = fixtureDatabase(dataDirectory);
    const environment = {
      DATABASE_URL: `file:../data/${encodeURIComponent(path.basename(databasePath))}`,
      DEPLOYMENT_ROOT: deploymentRoot,
      BACKUP_OFFSITE_DIR: offsiteDirectory,
      BACKUP_ENCRYPTION_KEYS_JSON: JSON.stringify({ 'backup-a': KEY_A.toString('hex') }),
      BACKUP_ACTIVE_KEY_ID: 'backup-a',
      BACKUP_RETENTION_DAYS: '30',
      BACKUP_MIN_RECOVERY_COPIES: '2',
      BACKUP_MAX_AGE_MINUTES: '5',
      BACKUP_MAX_DATABASE_BYTES: String(MAX_DATABASE_BYTES),
    };
    const result = runVerifiedOffsiteRoundTrip(environment, { requireDifferentFilesystem: false });
    assert.equal(result.status, 'VERIFIED_BACKUP');
    if (result.status !== 'VERIFIED_BACKUP') throw new Error('Expected a verified backup.');
    assert.match(result.packageName, /\.purrbackup$/);
    assert.equal(fs.existsSync(path.join(offsiteDirectory, result.packageName)), true);
    assert.equal(
      fs.readdirSync(os.tmpdir()).some((name) => name === result.packageId),
      false
    );

    assert.throws(
      () =>
        runVerifiedOffsiteRoundTrip(
          {
            ...environment,
            BACKUP_OFFSITE_DIR: path.join(deploymentRoot, 'backups'),
          },
          { requireDifferentFilesystem: false }
        ),
      /outside the deployment root/
    );
    assert.throws(() => runVerifiedOffsiteRoundTrip(environment), /separately mounted filesystem/);
    assert.throws(
      () =>
        runVerifiedOffsiteRoundTrip(
          { ...environment, ENCRYPTION_KEY: KEY_A.toString('hex') },
          { requireDifferentFilesystem: false }
        ),
      /must not reuse ENCRYPTION_KEY/
    );
    assert.throws(
      () =>
        runVerifiedOffsiteRoundTrip(
          { ...environment, ENCRYPTION_KEY_NEW: KEY_A.toString('hex') },
          { requireDifferentFilesystem: false }
        ),
      /must not reuse ENCRYPTION_KEY_NEW/
    );
    assert.throws(
      () =>
        runVerifiedOffsiteRoundTrip(environment, {
          requireDifferentFilesystem: false,
          additionalForbiddenKeys: [KEY_A],
        }),
      /must not reuse an application encryption key/
    );
    assert.throws(
      () =>
        runVerifiedOffsiteRoundTrip(
          { ...environment, BACKUP_MAX_DATABASE_BYTES: String(256 * 1024 * 1024 + 1) },
          { requireDifferentFilesystem: false }
        ),
      /safety ceiling for the current package format/
    );
    for (const ringName of ['AUDIT_INTEGRITY_KEYS_JSON', 'OUTBOX_INTEGRITY_KEYS_JSON'] as const) {
      assert.throws(
        () =>
          runVerifiedOffsiteRoundTrip(
            {
              ...environment,
              [ringName]: JSON.stringify({ historical: KEY_A.toString('hex') }),
            },
            { requireDifferentFilesystem: false }
          ),
        /must not reuse a historical audit or outbox integrity key/
      );
    }
    assert.throws(
      () =>
        runVerifiedOffsiteRoundTrip(environment, {
          requireDifferentFilesystem: false,
          uploadPackage: () => {
            throw new Error('offsite upload unavailable');
          },
        }),
      /offsite upload unavailable/
    );
    assert.throws(
      () =>
        runVerifiedOffsiteRoundTrip(environment, {
          requireDifferentFilesystem: false,
          downloadPackage: () => {
            throw new Error('offsite download unavailable');
          },
        }),
      /offsite download unavailable/
    );
    fs.chmodSync(offsiteDirectory, 0o755);
    assert.throws(
      () => runVerifiedOffsiteRoundTrip(environment, { requireDifferentFilesystem: false }),
      /must not grant group or world/
    );
  });

  it('runs the production filesystem-separation check against an independent mount', (context) => {
    const mountRoot = '/dev/shm';
    if (!fs.existsSync(mountRoot) || fs.statSync(mountRoot).dev === fs.statSync(os.tmpdir()).dev) {
      context.skip('No independent writable test mount is available.');
      return;
    }
    const deploymentRoot = temporaryDirectory('mounted-deployment');
    const offsiteDirectory = fs.mkdtempSync(path.join(mountRoot, 'purrmission-offsite-'));
    temporaryDirectories.push(offsiteDirectory);
    const databasePath = fixtureDatabase(deploymentRoot);
    const result = runVerifiedOffsiteRoundTrip({
      DATABASE_URL: `file:${databasePath}`,
      DEPLOYMENT_ROOT: deploymentRoot,
      BACKUP_OFFSITE_DIR: offsiteDirectory,
      BACKUP_ENCRYPTION_KEYS_JSON: JSON.stringify({ 'backup-a': KEY_A.toString('hex') }),
      BACKUP_ACTIVE_KEY_ID: 'backup-a',
      BACKUP_RETENTION_DAYS: '30',
      BACKUP_MIN_RECOVERY_COPIES: '2',
      BACKUP_MAX_AGE_MINUTES: '5',
      BACKUP_MAX_DATABASE_BYTES: String(MAX_DATABASE_BYTES),
    });
    assert.equal(result.status, 'VERIFIED_BACKUP');
    if (result.status !== 'VERIFIED_BACKUP') throw new Error('Expected a verified backup.');
    assert.equal(fs.existsSync(path.join(offsiteDirectory, result.packageName)), true);
  });

  it('allows a first deployment only when no database or SQLite sidecar state exists', () => {
    const deploymentRoot = temporaryDirectory('fresh-deployment');
    const databasePath = path.join(deploymentRoot, 'data', 'production.db');
    const environment = {
      DATABASE_URL: 'file:../data/production.db',
      DEPLOYMENT_ROOT: deploymentRoot,
    };

    assert.deepEqual(runVerifiedOffsiteRoundTrip(environment), {
      status: 'FRESH_DATABASE',
      databasePath,
    });

    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(`${databasePath}-wal`, 'residual-state');
    assert.throws(
      () => runVerifiedOffsiteRoundTrip(environment),
      /database file is absent but SQLite sidecar state remains/i
    );
  });

  it('keeps a minimum recovery window and surfaces retention deletion failures', () => {
    const offsiteDirectory = temporaryDirectory('retention');
    const old = new Date('2026-01-01T00:00:00.000Z');
    for (let index = 0; index < 4; index += 1) {
      const file = path.join(offsiteDirectory, `${index}.purrbackup`);
      fs.writeFileSync(file, 'encrypted');
      fs.utimesSync(file, old, new Date(old.getTime() + index));
    }
    const removed = enforceBackupRetention({
      offsiteDirectory,
      retentionDays: 30,
      minimumRecoveryCopies: 2,
      isValidRecoveryCopy: () => true,
      now: NOW,
    });
    assert.equal(removed.length, 2);
    assert.equal(fs.readdirSync(offsiteDirectory).length, 2);

    assert.throws(
      () =>
        enforceBackupRetention({
          offsiteDirectory,
          retentionDays: 1,
          minimumRecoveryCopies: 1,
          isValidRecoveryCopy: () => true,
          now: NOW,
          removeFile: () => {
            throw new Error('offsite deletion denied');
          },
        }),
      /offsite deletion denied/
    );
  });

  it('does not count corrupt packages toward the minimum recovery floor', () => {
    const offsiteDirectory = temporaryDirectory('retention-validity');
    const old = new Date('2026-01-01T00:00:00.000Z');
    for (let index = 0; index < 4; index += 1) {
      const file = path.join(offsiteDirectory, `valid-${index}.purrbackup`);
      fs.writeFileSync(file, 'valid');
      fs.utimesSync(file, old, new Date(old.getTime() + index));
    }
    const corrupt = path.join(offsiteDirectory, 'corrupt-newest.purrbackup');
    fs.writeFileSync(corrupt, 'corrupt');
    fs.utimesSync(corrupt, old, new Date(old.getTime() + 10_000));

    const removed = enforceBackupRetention({
      offsiteDirectory,
      retentionDays: 30,
      minimumRecoveryCopies: 2,
      isValidRecoveryCopy: (packagePath) => fs.readFileSync(packagePath, 'utf8') === 'valid',
      now: NOW,
    });

    assert.equal(removed.length, 2);
    assert.equal(
      fs.readdirSync(offsiteDirectory).filter((name) => name.startsWith('valid-')).length,
      2
    );
    assert.equal(fs.existsSync(corrupt), true);
  });

  it('requires a dedicated, valid, non-empty backup key ring', () => {
    assert.throws(() => parseBackupKeyRing('{}'), /must not be empty/);
    assert.throws(() => parseBackupKeyRing('{not-json'), /valid JSON/);
    assert.throws(() => parseBackupKeyRing('{"active":"abcd"}'), /invalid key/);
    assert.deepEqual(
      parseBackupKeyRing(JSON.stringify({ active: KEY_A.toString('hex') })).get('active'),
      KEY_A
    );
  });

  it('retains historical keys to verify packages across rotation', () => {
    const first = createFixturePackage('rotation-a');
    const secondRoot = temporaryDirectory('rotation-b');
    const secondDatabase = fixtureDatabase(secondRoot);
    const second = createEncryptedBackup({
      databasePath: secondDatabase,
      outputDirectory: path.join(secondRoot, 'packages'),
      keyId: 'backup-b',
      key: KEY_B,
      maximumDatabaseBytes: MAX_DATABASE_BYTES,
      now: NOW,
    });
    const rotatingRing = new Map([
      ['backup-a', KEY_A],
      ['backup-b', KEY_B],
    ]);
    for (const [packagePath, databasePath, restoreName] of [
      [first.packagePath, first.databasePath, 'old-key-restore'],
      [second.packagePath, secondDatabase, 'new-key-restore'],
    ] as const) {
      assert.doesNotThrow(() =>
        verifyAndRestoreEncryptedBackup({
          packagePath,
          keyRing: rotatingRing,
          restoreRoot: path.join(path.dirname(databasePath), restoreName),
          productionDatabasePath: databasePath,
          maximumAgeMs: 60_000,
          maximumPackageBytes: MAX_PACKAGE_BYTES,
          now: NOW,
        })
      );
    }
  });
});
