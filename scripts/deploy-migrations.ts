import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runGuardianReconciliation } from './reconcile-guardians-owners.js';

const RECONCILIATION_TABLES = ['Environment', 'Guardian', 'Project', 'Resource'] as const;
const HARDENING_MIGRATION = '20260724110200_rbac_dashboard_hardening_remediations';
const LEGACY_STAGE_TABLES = ['AuditLog', 'Project', 'Resource', 'TOTPAccount'] as const;

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

/**
 * Preserve rows around the published hardening migration without changing its checksum.
 *
 * The published SQLite table rebuild omitted values for newly-required columns. Empty tables are
 * safe, but populated legacy tables fail during deployment. These repository-owned stage tables
 * make the wrapper resumable: a failed deploy leaves the only copy in a plainly named table, and a
 * later invocation resumes instead of overwriting it.
 */
export async function stageLegacyHardeningRows(prisma: PrismaClient): Promise<boolean> {
  const stageAlreadyExists = await tableExists(prisma, '_purrmission_stage_Project');
  if (await hardeningMigrationApplied(prisma)) return stageAlreadyExists;

  const unmappableAuditRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) AS "count" FROM "AuditLog"
     WHERE "resolverId" IS NOT NULL OR "context" IS NOT NULL`
  );
  if (Number(unmappableAuditRows[0]?.count ?? 0) > 0) {
    throw new Error(
      'Legacy AuditLog rows contain resolver/context data that cannot be safely mapped by the compatibility preflight. Refusing a lossy upgrade; complete the #118 audit migration path first.'
    );
  }

  for (const table of LEGACY_STAGE_TABLES) {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "_purrmission_stage_${table}" AS SELECT * FROM "${table}" WHERE 0`
    );
  }

  for (const table of LEGACY_STAGE_TABLES) {
    const sourceCount = await rowCount(prisma, table);
    const stageCount = await rowCount(prisma, `_purrmission_stage_${table}`);
    if (sourceCount > 0 && stageCount > 0) {
      throw new Error(
        `Migration staging found rows in both ${table} and _purrmission_stage_${table}; refusing to overwrite recoverable data.`
      );
    }
  }

  await prisma.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
  try {
    await prisma.$transaction(async (tx) => {
      for (const table of LEGACY_STAGE_TABLES) {
        const sourceCount = await rowCount(tx, table);
        const stageCount = await rowCount(tx, `_purrmission_stage_${table}`);
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
  if (!(await tableExists(prisma, '_purrmission_stage_Project'))) return;
  if (!(await hardeningMigrationApplied(prisma))) {
    throw new Error('Refusing to restore staged rows before the hardening migration is applied.');
  }

  const expected = new Map<string, number>();
  for (const table of LEGACY_STAGE_TABLES) {
    expected.set(table, await rowCount(prisma, `_purrmission_stage_${table}`));
    if ((await rowCount(prisma, table)) > 0 && (expected.get(table) ?? 0) > 0) {
      throw new Error(`Refusing to merge staged ${table} rows into a non-empty destination.`);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO "TOTPAccount"
         ("id", "ownerDiscordUserId", "accountName", "secret", "issuer", "backupKey", "version", "createdAt", "updatedAt")
       SELECT "id", "ownerDiscordUserId", "accountName", "secret", "issuer", "backupKey",
              'legacy-totp-' || "id", "createdAt", "updatedAt"
       FROM "_purrmission_stage_TOTPAccount"`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "Resource"
         ("id", "name", "mode", "apiKey", "createdAt", "totpAccountId", "version")
       SELECT "id", "name", "mode", "apiKey", "createdAt", "totpAccountId",
              'legacy-resource-' || "id"
       FROM "_purrmission_stage_Resource"`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "Project"
         ("id", "name", "description", "ownerId", "policyVersion", "createdAt", "updatedAt")
       SELECT "id", "name", "description", "ownerId", 'legacy-policy-' || "id",
              "createdAt", "updatedAt"
       FROM "_purrmission_stage_Project"`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "AuditLog"
         ("id", "schemaVersion", "eventType", "outcomeCode", "actorType", "actorId",
          "resourceId", "payload", "createdAt")
       SELECT "id", 1, "action", "status",
              CASE WHEN "actorId" IS NULL THEN 'SYSTEM' ELSE 'DISCORD_USER' END,
              "actorId", "resourceId", NULL, "createdAt"
       FROM "_purrmission_stage_AuditLog"`
    );
  });

  for (const table of LEGACY_STAGE_TABLES) {
    const actual = await rowCount(prisma, table);
    if (actual !== expected.get(table)) {
      throw new Error(
        `Restored ${table} row count ${actual} did not match staged count ${expected.get(table)}.`
      );
    }
  }
  const foreignKeyViolations = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'PRAGMA foreign_key_check'
  );
  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `Restored database has ${foreignKeyViolations.length} foreign-key violation(s); staged recovery tables were retained.`
    );
  }
  for (const table of LEGACY_STAGE_TABLES) {
    await prisma.$executeRawUnsafe(`DROP TABLE "_purrmission_stage_${table}"`);
  }
}

export async function deployMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for migration deployment.');
  }

  const prisma = new PrismaClient();
  let stagedHardeningRows = false;
  try {
    const resumesStagedDeploy = await tableExists(prisma, '_purrmission_stage_Project');
    if (resumesStagedDeploy) {
      console.log('🔒 Recoverable hardening stage detected; resuming migration deployment.');
      stagedHardeningRows = await stageLegacyHardeningRows(prisma);
    } else {
      const databaseState = await runMigrationPreflight(prisma);
      stagedHardeningRows =
        databaseState === 'INITIALIZED' ? await stageLegacyHardeningRows(prisma) : false;
    }
  } finally {
    await prisma.$disconnect();
  }

  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy exited with status ${result.status ?? 'unknown'}.`);
  }

  if (stagedHardeningRows) {
    const restoreClient = new PrismaClient();
    try {
      await restoreLegacyHardeningRows(restoreClient);
    } finally {
      await restoreClient.$disconnect();
    }
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
