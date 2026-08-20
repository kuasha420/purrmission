import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type * as NodeSqlite from 'node:sqlite';

// Keep the Node 24 built-in specifier opaque to the script bundler, which otherwise rewrites
// `node:sqlite` to the unrelated npm package name `sqlite`.
const SQLITE_MODULE_SPECIFIER = ['node', 'sqlite'].join(':');
const { DatabaseSync } = (await import(SQLITE_MODULE_SPECIFIER)) as typeof NodeSqlite;
type SqliteDatabase = InstanceType<typeof DatabaseSync>;

const PACKAGE_VERSION = 1 as const;
const PACKAGE_ALGORITHM = 'aes-256-gcm' as const;
const PACKAGE_SUFFIX = '.purrbackup';
const MAX_JSON_PACKAGE_DATABASE_BYTES = 256 * 1024 * 1024;

export interface BackupManifest {
  version: typeof PACKAGE_VERSION;
  packageId: string;
  createdAt: string;
  algorithm: typeof PACKAGE_ALGORITHM;
  keyId: string;
  databaseFormat: 'sqlite3';
  byteLength: number;
  sha256: string;
  migrationNames: string[];
  tableNames: string[];
}

interface EncryptedBackupPackage {
  version: typeof PACKAGE_VERSION;
  manifest: BackupManifest;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface CreateBackupOptions {
  databasePath: string;
  outputDirectory: string;
  keyId: string;
  key: Buffer;
  maximumDatabaseBytes: number;
  now?: Date;
}

export interface VerifyBackupOptions {
  packagePath: string;
  keyRing: ReadonlyMap<string, Buffer>;
  restoreRoot: string;
  productionDatabasePath: string;
  maximumAgeMs: number;
  maximumPackageBytes: number;
  now?: Date;
}

export interface VerifiedRestore {
  manifest: BackupManifest;
  restoredDatabasePath: string;
}

export type VerifiedOffsiteRoundTripResult =
  | { status: 'VERIFIED_BACKUP'; packageName: string; packageId: string }
  | { status: 'FRESH_DATABASE'; databasePath: string };

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} contains missing or unrecognized fields.`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid.`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`${label} is invalid.`);
  }
  const entries = [...value] as string[];
  if (
    new Set(entries).size !== entries.length ||
    entries.some((entry, index) => {
      const previous = entries[index - 1];
      return previous !== undefined && previous > entry;
    })
  ) {
    throw new Error(`${label} must be unique and canonically ordered.`);
  }
  return entries;
}

function parseManifest(value: unknown): BackupManifest {
  const record = requireRecord(value, 'Backup manifest');
  assertExactKeys(
    record,
    [
      'version',
      'packageId',
      'createdAt',
      'algorithm',
      'keyId',
      'databaseFormat',
      'byteLength',
      'sha256',
      'migrationNames',
      'tableNames',
    ],
    'Backup manifest'
  );
  const createdAt = requireString(record.createdAt, 'Backup manifest createdAt');
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt)
    throw new Error('Backup manifest createdAt is invalid.');
  if (!Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 1) {
    throw new Error('Backup manifest byteLength is invalid.');
  }
  const sha256 = requireString(record.sha256, 'Backup manifest sha256');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Backup manifest sha256 is invalid.');
  if (record.version !== PACKAGE_VERSION || record.algorithm !== PACKAGE_ALGORITHM) {
    throw new Error('Backup package version or algorithm is unsupported.');
  }
  if (record.databaseFormat !== 'sqlite3')
    throw new Error('Backup database format is unsupported.');
  const packageId = requireString(record.packageId, 'Backup package ID');
  const keyId = requireString(record.keyId, 'Backup key ID');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(packageId)
  ) {
    throw new Error('Backup package ID is invalid.');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error('Backup key ID is invalid.');
  return {
    version: PACKAGE_VERSION,
    packageId,
    createdAt,
    algorithm: PACKAGE_ALGORITHM,
    keyId,
    databaseFormat: 'sqlite3',
    byteLength: record.byteLength as number,
    sha256,
    migrationNames: requireStringArray(record.migrationNames, 'Backup migrations'),
    tableNames: requireStringArray(record.tableNames, 'Backup tables'),
  };
}

function parsePackage(contents: string): EncryptedBackupPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Backup package is not valid JSON.');
  }
  const record = requireRecord(parsed, 'Backup package');
  assertExactKeys(record, ['version', 'manifest', 'iv', 'authTag', 'ciphertext'], 'Backup package');
  if (record.version !== PACKAGE_VERSION) throw new Error('Backup package version is unsupported.');
  const manifest = parseManifest(record.manifest);
  const iv = requireString(record.iv, 'Backup IV');
  const authTag = requireString(record.authTag, 'Backup authentication tag');
  const ciphertext = requireString(record.ciphertext, 'Backup ciphertext');
  if (!/^[0-9a-f]{24}$/.test(iv) || !/^[0-9a-f]{32}$/.test(authTag)) {
    throw new Error('Backup cryptographic envelope is malformed.');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) {
    throw new Error('Backup ciphertext encoding is malformed.');
  }
  return { version: PACKAGE_VERSION, manifest, iv, authTag, ciphertext };
}

function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function listTables(database: SqliteDatabase): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

function listMigrations(database: SqliteDatabase, tables: readonly string[]): string[] {
  if (!tables.includes('_prisma_migrations')) return [];
  return (
    database
      .prepare(
        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name'
      )
      .all() as Array<{ migration_name: string }>
  ).map(({ migration_name }) => migration_name);
}

function verifySqlite(
  databasePath: string,
  expected?: Pick<BackupManifest, 'tableNames' | 'migrationNames'>
) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const checks = database.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') {
      throw new Error('Restored SQLite integrity check failed.');
    }
    const tableNames = listTables(database);
    const migrationNames = listMigrations(database, tableNames);
    for (const tableName of tableNames) {
      database.prepare(`SELECT 1 FROM "${tableName.replaceAll('"', '""')}" LIMIT 1`).get();
    }
    if (expected && JSON.stringify(tableNames) !== JSON.stringify(expected.tableNames)) {
      throw new Error('Restored database schema smoke check does not match the manifest.');
    }
    if (expected && JSON.stringify(migrationNames) !== JSON.stringify(expected.migrationNames)) {
      throw new Error('Restored Prisma migration state does not match the manifest.');
    }
    return { tableNames, migrationNames };
  } finally {
    database.close();
  }
}

function writePrivateFileAtomically(destination: string, contents: string | Buffer) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, destination);
}

function resolvePathAllowingMissingLeaf(input: string): string {
  let existingAncestor = path.resolve(input);
  const missingSegments: string[] = [];
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error('Unable to resolve an existing ancestor for the database path.');
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  return path.join(fs.realpathSync(existingAncestor), ...missingSegments);
}

function assertSupportedDatabaseSizeLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('BACKUP_MAX_DATABASE_BYTES must be a positive safe integer.');
  }
  if (value > MAX_JSON_PACKAGE_DATABASE_BYTES) {
    throw new Error(
      `BACKUP_MAX_DATABASE_BYTES exceeds the ${MAX_JSON_PACKAGE_DATABASE_BYTES}-byte safety ceiling for the current package format.`
    );
  }
}

export function parseSqliteDatabaseUrl(
  databaseUrl: string,
  deploymentRoot = process.cwd()
): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error('Verified backup supports only SQLite DATABASE_URL values using file:.');
  }
  const withoutQuery = decodeURIComponent(databaseUrl.slice('file:'.length).split('?')[0]);
  if (!withoutQuery) throw new Error('DATABASE_URL does not identify a SQLite file.');
  return path.isAbsolute(withoutQuery)
    ? withoutQuery
    : path.resolve(deploymentRoot, 'prisma', withoutQuery);
}

export function parseBackupKeyRing(serialized: string): Map<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('BACKUP_ENCRYPTION_KEYS_JSON must be valid JSON.');
  }
  const record = requireRecord(parsed, 'Backup encryption key ring');
  const entries = Object.entries(record);
  if (entries.length === 0) throw new Error('Backup encryption key ring must not be empty.');
  return new Map(
    entries.map(([keyId, encoded]) => {
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
        typeof encoded !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(encoded)
      ) {
        throw new Error('Backup encryption key ring contains an invalid key ID or key.');
      }
      return [keyId, Buffer.from(encoded, 'hex')] as const;
    })
  );
}

function parseIntegrityKeyRingValues(
  serialized: string | undefined,
  name: 'AUDIT_INTEGRITY_KEYS_JSON' | 'OUTBOX_INTEGRITY_KEYS_JSON'
): Buffer[] {
  if (!serialized) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  const record = requireRecord(parsed, name);
  return Object.entries(record).map(([keyId, encoded]) => {
    if (
      !/^[A-Za-z0-9._:-]{1,64}$/.test(keyId) ||
      typeof encoded !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(encoded)
    ) {
      throw new Error(`${name} contains an invalid key ID or key.`);
    }
    return Buffer.from(encoded, 'hex');
  });
}

export function createEncryptedBackup(options: CreateBackupOptions): {
  packagePath: string;
  manifest: BackupManifest;
} {
  const databasePath = path.resolve(options.databasePath);
  const outputDirectory = path.resolve(options.outputDirectory);
  if (options.key.length !== 32) throw new Error('Backup encryption key must contain 32 bytes.');
  assertSupportedDatabaseSizeLimit(options.maximumDatabaseBytes);
  if (!fs.statSync(databasePath).isFile()) throw new Error('Database path is not a regular file.');
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'purrmission-snapshot-'));
  const snapshotPath = path.join(workspace, 'snapshot.db');
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      source.exec('PRAGMA busy_timeout = 5000');
      const pageCount = source.prepare('PRAGMA page_count').get() as
        | { page_count: number | bigint }
        | undefined;
      const pageSize = source.prepare('PRAGMA page_size').get() as
        | { page_size: number | bigint }
        | undefined;
      if (!pageCount || !pageSize) {
        throw new Error('Unable to estimate the SQLite source size before backup.');
      }
      if (
        BigInt(pageCount.page_count) * BigInt(pageSize.page_size) >
        BigInt(options.maximumDatabaseBytes)
      ) {
        throw new Error('SQLite source estimate exceeds BACKUP_MAX_DATABASE_BYTES.');
      }
      source.exec(`VACUUM INTO ${quoteSqliteString(snapshotPath)}`);
    } finally {
      source.close();
    }
    const state = verifySqlite(snapshotPath);
    if (fs.statSync(snapshotPath).size > options.maximumDatabaseBytes) {
      throw new Error('SQLite snapshot exceeds BACKUP_MAX_DATABASE_BYTES.');
    }
    const plaintext = fs.readFileSync(snapshotPath);
    const manifest: BackupManifest = {
      version: PACKAGE_VERSION,
      packageId: randomUUID(),
      createdAt: (options.now ?? new Date()).toISOString(),
      algorithm: PACKAGE_ALGORITHM,
      keyId: options.keyId,
      databaseFormat: 'sqlite3',
      byteLength: plaintext.length,
      sha256: createHash('sha256').update(plaintext).digest('hex'),
      migrationNames: state.migrationNames,
      tableNames: state.tableNames,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', options.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(manifest), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const backupPackage: EncryptedBackupPackage = {
      version: PACKAGE_VERSION,
      manifest,
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('base64'),
    };
    const filename = `${manifest.createdAt.replaceAll(':', '-')}-${manifest.packageId}${PACKAGE_SUFFIX}`;
    const packagePath = path.join(outputDirectory, filename);
    writePrivateFileAtomically(packagePath, JSON.stringify(backupPackage));
    return { packagePath, manifest };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

export function verifyAndRestoreEncryptedBackup(options: VerifyBackupOptions): VerifiedRestore {
  if (!Number.isSafeInteger(options.maximumPackageBytes) || options.maximumPackageBytes < 1) {
    throw new Error('Maximum backup package size must be a positive safe integer.');
  }
  if (fs.statSync(options.packagePath).size > options.maximumPackageBytes) {
    throw new Error('Backup package exceeds the configured size limit.');
  }
  const productionDatabasePath = resolvePathAllowingMissingLeaf(options.productionDatabasePath);
  const requestedRestoreRoot = path.resolve(options.restoreRoot);
  fs.mkdirSync(requestedRestoreRoot, { recursive: true, mode: 0o700 });
  const restoreRoot = fs.realpathSync(requestedRestoreRoot);
  if ((fs.statSync(restoreRoot).mode & 0o077) !== 0) {
    throw new Error('Restore root must not grant group or world filesystem permissions.');
  }
  if (
    restoreRoot === productionDatabasePath ||
    productionDatabasePath.startsWith(`${restoreRoot}${path.sep}`)
  ) {
    throw new Error('Restore root must not contain or equal the production database path.');
  }
  const backupPackage = parsePackage(fs.readFileSync(options.packagePath, 'utf8'));
  const createdAt = Date.parse(backupPackage.manifest.createdAt);
  const age = (options.now ?? new Date()).getTime() - createdAt;
  if (age < 0 || age > options.maximumAgeMs)
    throw new Error('Backup manifest is stale or future-dated.');
  const key = options.keyRing.get(backupPackage.manifest.keyId);
  if (!key) throw new Error('Backup package key ID is unavailable.');
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(PACKAGE_ALGORITHM, key, Buffer.from(backupPackage.iv, 'hex'));
    decipher.setAAD(Buffer.from(JSON.stringify(backupPackage.manifest), 'utf8'));
    decipher.setAuthTag(Buffer.from(backupPackage.authTag, 'hex'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(backupPackage.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new Error('Backup authentication or decryption failed.');
  }
  if (
    plaintext.length !== backupPackage.manifest.byteLength ||
    createHash('sha256').update(plaintext).digest('hex') !== backupPackage.manifest.sha256
  ) {
    throw new Error('Backup plaintext digest or size does not match the manifest.');
  }
  const restoredDatabasePath = path.join(restoreRoot, `${backupPackage.manifest.packageId}.db`);
  if (path.resolve(restoredDatabasePath) === productionDatabasePath) {
    throw new Error('Restore verification must never overwrite production.');
  }
  writePrivateFileAtomically(restoredDatabasePath, plaintext);
  try {
    verifySqlite(restoredDatabasePath, backupPackage.manifest);
  } catch (error) {
    fs.rmSync(restoredDatabasePath, { force: true });
    throw error;
  }
  return { manifest: backupPackage.manifest, restoredDatabasePath };
}

export function enforceBackupRetention(options: {
  offsiteDirectory: string;
  retentionDays: number;
  minimumRecoveryCopies: number;
  isValidRecoveryCopy: (packagePath: string) => boolean;
  now?: Date;
  removeFile?: (file: string) => void;
}): string[] {
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1)
    throw new Error('Backup retention days must be a positive integer.');
  if (!Number.isInteger(options.minimumRecoveryCopies) || options.minimumRecoveryCopies < 1)
    throw new Error('Backup minimum recovery copies must be a positive integer.');
  const files = fs
    .readdirSync(options.offsiteDirectory)
    .filter((name) => name.endsWith(PACKAGE_SUFFIX))
    .map((name) => ({
      name,
      path: path.join(options.offsiteDirectory, name),
      stat: fs.statSync(path.join(options.offsiteDirectory, name)),
    }))
    .filter(
      ({ stat, path: packagePath }) => stat.isFile() && options.isValidRecoveryCopy(packagePath)
    )
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  const cutoff = (options.now ?? new Date()).getTime() - options.retentionDays * 86_400_000;
  const removed: string[] = [];
  for (const file of files.slice(options.minimumRecoveryCopies)) {
    if (file.stat.mtimeMs >= cutoff) continue;
    (options.removeFile ?? fs.unlinkSync)(file.path);
    removed.push(file.name);
  }
  return removed;
}

function copyFileDurably(source: string, destination: string) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const descriptor = fs.openSync(destination, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const directoryDescriptor = fs.openSync(path.dirname(destination), 'r');
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

export function runVerifiedOffsiteRoundTrip(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    requireDifferentFilesystem?: boolean;
    uploadPackage?: (source: string, destination: string) => void;
    downloadPackage?: (source: string, destination: string) => void;
    additionalForbiddenKeys?: readonly Buffer[];
  } = {}
): VerifiedOffsiteRoundTripResult {
  const required = (name: string) => {
    const value = environment[name];
    if (!value) throw new Error(`${name} is required for verified production backup.`);
    return value;
  };
  const deploymentRoot = fs.realpathSync(
    path.resolve(environment.DEPLOYMENT_ROOT ?? process.cwd())
  );
  const databasePath = resolvePathAllowingMissingLeaf(
    parseSqliteDatabaseUrl(required('DATABASE_URL'), deploymentRoot)
  );
  if (!fs.existsSync(databasePath)) {
    const residualState = [
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ].filter((candidate) => fs.existsSync(candidate));
    if (residualState.length > 0) {
      throw new Error(
        `Database file is absent but SQLite sidecar state remains: ${residualState.join(', ')}.`
      );
    }
    return { status: 'FRESH_DATABASE', databasePath };
  }
  const requestedOffsiteDirectory = path.resolve(required('BACKUP_OFFSITE_DIR'));
  if (
    !path.isAbsolute(required('BACKUP_OFFSITE_DIR')) ||
    requestedOffsiteDirectory === deploymentRoot ||
    requestedOffsiteDirectory.startsWith(`${deploymentRoot}${path.sep}`)
  ) {
    throw new Error(
      'BACKUP_OFFSITE_DIR must be an absolute separately mounted path outside the deployment root.'
    );
  }
  fs.mkdirSync(requestedOffsiteDirectory, { recursive: true, mode: 0o700 });
  const offsiteDirectory = fs.realpathSync(requestedOffsiteDirectory);
  if (
    offsiteDirectory === deploymentRoot ||
    offsiteDirectory.startsWith(`${deploymentRoot}${path.sep}`)
  ) {
    throw new Error('BACKUP_OFFSITE_DIR resolves inside the deployment root.');
  }
  if ((fs.statSync(offsiteDirectory).mode & 0o077) !== 0) {
    throw new Error('BACKUP_OFFSITE_DIR must not grant group or world filesystem permissions.');
  }
  if (
    options.requireDifferentFilesystem !== false &&
    fs.statSync(offsiteDirectory).dev === fs.statSync(deploymentRoot).dev
  ) {
    throw new Error(
      'BACKUP_OFFSITE_DIR must be a separately mounted filesystem, not local deployment storage.'
    );
  }
  const keyRing = parseBackupKeyRing(required('BACKUP_ENCRYPTION_KEYS_JSON'));
  const activeKeyId = required('BACKUP_ACTIVE_KEY_ID');
  const activeKey = keyRing.get(activeKeyId);
  if (!activeKey) throw new Error('BACKUP_ACTIVE_KEY_ID is not present in the backup key ring.');
  const historicalPurposeKeys = [
    ...parseIntegrityKeyRingValues(
      environment.AUDIT_INTEGRITY_KEYS_JSON,
      'AUDIT_INTEGRITY_KEYS_JSON'
    ),
    ...parseIntegrityKeyRingValues(
      environment.OUTBOX_INTEGRITY_KEYS_JSON,
      'OUTBOX_INTEGRITY_KEYS_JSON'
    ),
  ];
  for (const [backupKeyId, backupKey] of keyRing) {
    for (const purpose of [
      'ENCRYPTION_KEY',
      'ENCRYPTION_KEY_OLD',
      'ENCRYPTION_KEY_NEW',
      'AUDIT_INTEGRITY_KEY',
      'OUTBOX_INTEGRITY_KEY',
    ] as const) {
      const otherKey = environment[purpose];
      if (otherKey && otherKey.toLowerCase() === backupKey.toString('hex')) {
        throw new Error(`Backup key ${backupKeyId} must not reuse ${purpose}.`);
      }
    }
    if (historicalPurposeKeys.some((otherKey) => otherKey.equals(backupKey))) {
      throw new Error(
        `Backup key ${backupKeyId} must not reuse a historical audit or outbox integrity key.`
      );
    }
    if (options.additionalForbiddenKeys?.some((otherKey) => otherKey.equals(backupKey))) {
      throw new Error(`Backup key ${backupKeyId} must not reuse an application encryption key.`);
    }
  }
  const retentionDays = Number(required('BACKUP_RETENTION_DAYS'));
  const minimumRecoveryCopies = Number(required('BACKUP_MIN_RECOVERY_COPIES'));
  const maximumAgeMinutes = Number(environment.BACKUP_MAX_AGE_MINUTES ?? '30');
  const maximumDatabaseBytes = Number(required('BACKUP_MAX_DATABASE_BYTES'));
  if (!Number.isFinite(maximumAgeMinutes) || maximumAgeMinutes <= 0)
    throw new Error('BACKUP_MAX_AGE_MINUTES must be positive.');
  assertSupportedDatabaseSizeLimit(maximumDatabaseBytes);
  const maximumPackageBytes = Math.ceil(maximumDatabaseBytes * 1.5) + 1_048_576;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'purrmission-backup-roundtrip-'));
  try {
    const created = createEncryptedBackup({
      databasePath,
      outputDirectory: workspace,
      keyId: activeKeyId,
      key: activeKey,
      maximumDatabaseBytes,
    });
    const uploadedPath = path.join(offsiteDirectory, path.basename(created.packagePath));
    (options.uploadPackage ?? copyFileDurably)(created.packagePath, uploadedPath);
    const downloadedPath = path.join(workspace, `downloaded-${path.basename(uploadedPath)}`);
    (options.downloadPackage ?? fs.copyFileSync)(uploadedPath, downloadedPath);
    const restored = verifyAndRestoreEncryptedBackup({
      packagePath: downloadedPath,
      keyRing,
      restoreRoot: path.join(workspace, 'isolated-restore'),
      productionDatabasePath: databasePath,
      maximumAgeMs: maximumAgeMinutes * 60_000,
      maximumPackageBytes,
    });
    const retentionRestoreRoot = path.join(workspace, 'retention-restore');
    fs.mkdirSync(retentionRestoreRoot, { mode: 0o700 });
    enforceBackupRetention({
      offsiteDirectory,
      retentionDays,
      minimumRecoveryCopies,
      isValidRecoveryCopy: (packagePath) => {
        let restoredDatabasePath: string | undefined;
        try {
          restoredDatabasePath = verifyAndRestoreEncryptedBackup({
            packagePath,
            keyRing,
            restoreRoot: retentionRestoreRoot,
            productionDatabasePath: databasePath,
            maximumAgeMs: Number.MAX_SAFE_INTEGER,
            maximumPackageBytes,
          }).restoredDatabasePath;
          return true;
        } catch {
          return false;
        } finally {
          if (restoredDatabasePath) fs.rmSync(restoredDatabasePath, { force: true });
        }
      },
    });
    return {
      status: 'VERIFIED_BACKUP',
      packageName: path.basename(uploadedPath),
      packageId: restored.manifest.packageId,
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// Backward-compatible exported name now performs the complete encrypted offsite round trip.
export async function backupDatabase(
  additionalForbiddenKeys: readonly Buffer[] = []
): Promise<string> {
  const result = runVerifiedOffsiteRoundTrip(process.env, { additionalForbiddenKeys });
  return result.status === 'VERIFIED_BACKUP'
    ? result.packageName
    : `fresh-database:${result.databasePath}`;
}

function loadEnvironmentFile(argument: string | undefined) {
  if (!argument) return;
  const envFile = path.resolve(argument);
  process.loadEnvFile(envFile);
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function runBackupCli(argv: readonly string[] = process.argv): void {
  try {
    loadEnvironmentFile(argumentValue(argv, '--env-file'));
    const command = argv[2] ?? 'roundtrip';
    if (command === 'roundtrip' || command.startsWith('--')) {
      const result = runVerifiedOffsiteRoundTrip();
      if (result.status === 'VERIFIED_BACKUP') {
        console.info(
          `Verified encrypted offsite backup ${result.packageName} (${result.packageId}).`
        );
      } else {
        console.info(`Fresh database path has no existing SQLite state: ${result.databasePath}.`);
      }
    } else if (command === 'verify') {
      const packagePath = argumentValue(argv, '--package');
      const restoreRoot = argumentValue(argv, '--restore-root');
      if (!packagePath || !restoreRoot) {
        throw new Error('verify requires --package and --restore-root.');
      }
      const databasePath = parseSqliteDatabaseUrl(
        process.env.DATABASE_URL ?? '',
        process.env.DEPLOYMENT_ROOT ?? process.cwd()
      );
      const maximumAgeMinutes = Number(
        argumentValue(argv, '--maximum-age-minutes') ?? process.env.BACKUP_MAX_AGE_MINUTES ?? '30'
      );
      if (!Number.isFinite(maximumAgeMinutes) || maximumAgeMinutes <= 0) {
        throw new Error('Maximum backup age must be positive.');
      }
      const maximumDatabaseBytes = Number(process.env.BACKUP_MAX_DATABASE_BYTES ?? '');
      assertSupportedDatabaseSizeLimit(maximumDatabaseBytes);
      const restored = verifyAndRestoreEncryptedBackup({
        packagePath,
        keyRing: parseBackupKeyRing(process.env.BACKUP_ENCRYPTION_KEYS_JSON ?? ''),
        restoreRoot,
        productionDatabasePath: databasePath,
        maximumAgeMs: maximumAgeMinutes * 60_000,
        maximumPackageBytes: Math.ceil(maximumDatabaseBytes * 1.5) + 1_048_576,
      });
      console.info(
        `Verified backup ${restored.manifest.packageId} at isolated path ${restored.restoredDatabasePath}.`
      );
    } else {
      throw new Error(`Unknown backup command: ${command}`);
    }
  } catch (error) {
    console.error(
      `Verified backup failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    process.exitCode = 1;
  }
}
