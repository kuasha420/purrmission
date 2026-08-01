import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runGuardianReconciliation } from './reconcile-guardians-owners.js';

const RECONCILIATION_TABLES = ['Environment', 'Guardian', 'Project', 'Resource'] as const;

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

export async function deployMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for migration deployment.');
  }

  const prisma = new PrismaClient();
  try {
    await runMigrationPreflight(prisma);
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
