import 'dotenv/config';

import { PrismaClient, type Prisma } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runGuardianReconciliation } from './reconcile-guardians-owners.js';
import { restoreLegacyAuditLogs, stageLegacyAuditLogs } from './legacy-audit-upgrade.js';

const RECONCILIATION_TABLES = ['Environment', 'Guardian', 'Project', 'Resource'] as const;
const HARDENING_MIGRATION = '20260724110200_rbac_dashboard_hardening_remediations';
const LEGACY_STAGE_TABLES = ['Project', 'Resource', 'TOTPAccount'] as const;
const LEGACY_STAGE_TABLE_NAMES = LEGACY_STAGE_TABLES.map((table) => `_purrmission_stage_${table}`);

export type MigrationDatabaseState = 'FRESH' | 'INITIALIZED';

export function classifyMigrationDatabaseTables(
  tableNames: readonly string[]
): MigrationDatabaseState {
  const applicationTables = tableNames.filter(
    (name) => name !== '_prisma_migrations' && !name.startsWith('sqlite_')
  );
  if (applicationTables.length === 0 && !tableNames.includes('_prisma_migrations')) {
    return 'FRESH';
  }

  const missing = RECONCILIATION_TABLES.filter((name) => !tableNames.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Migration preflight found an initialized database missing required table(s): ${missing.join(', ')}. Refusing to bypass Guardian reconciliation.`
    );
  }
  return 'INITIALIZED';
}

export function resolveSqliteDatabasePath(databaseUrl: string, cwd = process.cwd()): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error('The supported migration wrapper currently requires a SQLite file: URL.');
  }
  const value = decodeURIComponent(databaseUrl.slice('file:'.length).split('?')[0]);
  if (!value) throw new Error('DATABASE_URL must identify a SQLite database file.');
  return path.isAbsolute(value) ? value : path.resolve(cwd, 'prisma', value);
}

export async function runMigrationPreflight(prisma: PrismaClient): Promise<MigrationDatabaseState> {
  const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table'`
  );
  const state = classifyMigrationDatabaseTables(tables.map(({ name }) => name));

  if (state === 'FRESH') {
    console.log('✅ Fresh empty database detected; Guardian reconciliation is not required.');
    return state;
  }

  console.log('🔒 Running Guardian/owner reconciliation before published migrations...');
  await runGuardianReconciliation(prisma, true);
  return state;
}

async function tableExists(prisma: PrismaClient, tableName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) AS "count" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`,
    tableName
  );
  return Number(rows[0]?.count ?? 0) === 1;
}

async function rowCount(
  prisma: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>,
  tableName: string
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) AS "count" FROM "${tableName}"`
  );
  return Number(rows[0]?.count ?? 0);
}

async function hardeningMigrationApplied(prisma: PrismaClient): Promise<boolean> {
  if (!(await tableExists(prisma, '_prisma_migrations'))) return false;
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) AS "count" FROM "_prisma_migrations"
     WHERE "migration_name" = ? AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
    HARDENING_MIGRATION
  );
  return Number(rows[0]?.count ?? 0) === 1;
}

async function presentLegacyStageTables(prisma: PrismaClient): Promise<string[]> {
  const present: string[] = [];
  for (const tableName of LEGACY_STAGE_TABLE_NAMES) {
    if (await tableExists(prisma, tableName)) present.push(tableName);
  }
  return present;
}

function assertCompleteLegacyStage(present: readonly string[]): void {
  if (present.length === 0 || present.length === LEGACY_STAGE_TABLE_NAMES.length) return;
  const missing = LEGACY_STAGE_TABLE_NAMES.filter((tableName) => !present.includes(tableName));
  throw new Error(
    `Incomplete hardening recovery stage detected. Present: ${present.join(', ')}; missing: ${missing.join(', ')}. Refusing to ignore recoverable credential data.`
  );
}

/**
 * Preserve rows around the published hardening migration without changing its checksum.
 *
 * The published SQLite table rebuild omitted values for newly-required columns. Empty tables are
 * safe, but populated legacy tables fail during deployment. These repository-owned stage tables
 * make the wrapper resumable: a failed deploy leaves the only copy in a plainly named table, and a
 * later invocation resumes instead of overwriting it.
 */
export async function stageLegacyHardeningRows(prisma: PrismaClient): Promise<boolean> {
  const presentStageTables = await presentLegacyStageTables(prisma);
  assertCompleteLegacyStage(presentStageTables);
  const stageAlreadyExists = presentStageTables.length > 0;
  if (await hardeningMigrationApplied(prisma)) return stageAlreadyExists;

  await prisma.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
  try {
    await prisma.$transaction(async (tx) => {
      if (!stageAlreadyExists) {
        for (const table of LEGACY_STAGE_TABLES) {
          await tx.$executeRawUnsafe(
            `CREATE TABLE "_purrmission_stage_${table}" AS SELECT * FROM "${table}" WHERE 0`
          );
        }
      }
      for (const table of LEGACY_STAGE_TABLES) {
        const sourceCount = await rowCount(tx, table);
        const stageCount = await rowCount(tx, `_purrmission_stage_${table}`);
        if (sourceCount > 0 && stageCount > 0) {
          throw new Error(
            `Migration staging found rows in both ${table} and _purrmission_stage_${table}; refusing to overwrite recoverable data.`
          );
        }
        if (sourceCount > 0 && stageCount === 0) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "_purrmission_stage_${table}" SELECT * FROM "${table}"`
          );
          await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
        }
      }
    });
  } finally {
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys=ON');
  }
  return true;
}

export async function restoreLegacyHardeningRows(prisma: PrismaClient): Promise<void> {
  const presentStageTables = await presentLegacyStageTables(prisma);
  assertCompleteLegacyStage(presentStageTables);
  if (presentStageTables.length === 0) return;
  if (!(await hardeningMigrationApplied(prisma))) {
    throw new Error('Refusing to restore staged rows before the hardening migration is applied.');
  }

  await prisma.$transaction(async (tx) => {
    const expected = new Map<string, number>();
    for (const table of LEGACY_STAGE_TABLES) {
      expected.set(table, await rowCount(tx, `_purrmission_stage_${table}`));
      if ((await rowCount(tx, table)) > 0 && (expected.get(table) ?? 0) > 0) {
        throw new Error(`Refusing to merge staged ${table} rows into a non-empty destination.`);
      }
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO "TOTPAccount"
         ("id", "ownerDiscordUserId", "accountName", "secret", "issuer", "backupKey", "version", "createdAt", "updatedAt")
       SELECT "id", "ownerDiscordUserId", "accountName", "secret", "issuer", "backupKey",
              'legacy-totp-' || "id", "createdAt", "updatedAt"
       FROM "_purrmission_stage_TOTPAccount"`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "Resource"
         ("id", "name", "mode", "createdAt", "totpAccountId",
          "totpDelegationEnvelope", "version", "totpLinkVersion")
       SELECT "id", "name", "mode", "createdAt", NULL, NULL,
              'legacy-resource-' || "id", 'legacy-link-' || "id"
       FROM "_purrmission_stage_Resource"`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "Project"
         ("id", "name", "description", "ownerId", "policyVersion", "createdAt", "updatedAt")
       SELECT "id", "name", "description", "ownerId", 'legacy-policy-' || "id",
              "createdAt", "updatedAt"
       FROM "_purrmission_stage_Project"`
    );
    for (const table of LEGACY_STAGE_TABLES) {
      const actual = await rowCount(tx, table);
      if (actual !== expected.get(table)) {
        throw new Error(
          `Restored ${table} row count ${actual} did not match staged count ${expected.get(table)}.`
        );
      }
    }
    const foreignKeyViolations = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'PRAGMA foreign_key_check'
    );
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Restored database has ${foreignKeyViolations.length} foreign-key violation(s); staged recovery tables were retained.`
      );
    }
    // Keep value restoration and removal of every seed-bearing recovery table in one SQLite
    // transaction. An interruption therefore leaves either the complete stage or no stage.
    for (const table of LEGACY_STAGE_TABLES) {
      await tx.$executeRawUnsafe(`DROP TABLE "_purrmission_stage_${table}"`);
    }
  });
}

function runPrismaDeploy(): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy exited with status ${result.status ?? 'unknown'}.`);
  }
}

export async function deployMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for migration deployment.');
  }

  const preflight = new PrismaClient();
  let databaseState: MigrationDatabaseState;
  try {
    databaseState = await runMigrationPreflight(preflight);
  } finally {
    await preflight.$disconnect();
  }

  const databasePath = resolveSqliteDatabasePath(databaseUrl);
  const auditStage = new DatabaseSync(databasePath);
  try {
    stageLegacyAuditLogs(auditStage);
  } finally {
    auditStage.close();
  }

  const prisma = new PrismaClient();
  let stagedHardeningRows = false;
  try {
    const presentStageTables = await presentLegacyStageTables(prisma);
    assertCompleteLegacyStage(presentStageTables);
    if (presentStageTables.length > 0) {
      console.log('🔒 Recoverable hardening stage detected; resuming migration deployment.');
      stagedHardeningRows = await stageLegacyHardeningRows(prisma);
    } else {
      stagedHardeningRows =
        databaseState === 'INITIALIZED' ? await stageLegacyHardeningRows(prisma) : false;
    }
  } finally {
    await prisma.$disconnect();
  }

  runPrismaDeploy();

  if (stagedHardeningRows) {
    const restoreClient = new PrismaClient();
    try {
      await restoreLegacyHardeningRows(restoreClient);
    } finally {
      await restoreClient.$disconnect();
    }
  }

  const auditRestore = new DatabaseSync(databasePath);
  try {
    restoreLegacyAuditLogs(auditRestore);
  } finally {
    auditRestore.close();
  }
}

async function main(): Promise<void> {
  try {
    await deployMigrations();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  void main();
}
