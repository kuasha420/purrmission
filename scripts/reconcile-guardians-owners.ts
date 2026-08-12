import { PrismaClient } from '@prisma/client';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface GuardianReconciliationRow {
  id: string;
  resourceId: string;
  discordUserId: string;
  role: 'OWNER' | 'GUARDIAN';
  createdAt: Date;
}

interface EnvironmentOwnerRow {
  resourceId: string;
  ownerId: string;
}

export interface GuardianReconciliationDatabase {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface GuardianReconciliationSummary {
  duplicatesDeleted: number;
  ownerRowsRetainedForReview: string[];
}

/**
 * Select the one assignment that preserves the canonical authority model.
 *
 * For project-linked resources, a noncanonical OWNER row is a stale mirror and must never win
 * over an explicit GUARDIAN row. For the canonical Project Owner (and standalone Resources), an
 * OWNER row remains authoritative. Timestamp/ID ordering makes same-role reconciliation stable.
 */
export function selectCanonicalGuardianRow<T extends GuardianReconciliationRow>(
  group: readonly T[],
  canonicalProjectOwnerId?: string
): T {
  if (group.length === 0) {
    throw new Error('Cannot reconcile an empty Guardian assignment group.');
  }

  const subjectId = group[0].discordUserId;
  const preferGuardian =
    canonicalProjectOwnerId !== undefined && subjectId !== canonicalProjectOwnerId;

  return [...group].sort((a, b) => {
    if (a.role !== b.role) {
      if (preferGuardian) return a.role === 'GUARDIAN' ? -1 : 1;
      return a.role === 'OWNER' ? -1 : 1;
    }
    const createdAtOrder = a.createdAt.getTime() - b.createdAt.getTime();
    return createdAtOrder !== 0 ? createdAtOrder : a.id.localeCompare(b.id);
  })[0];
}

export async function runGuardianReconciliation(
  prisma: GuardianReconciliationDatabase,
  isExecute: boolean
): Promise<GuardianReconciliationSummary> {
  const isDryRun = !isExecute;

  console.log(`🚀 Starting Database Reconciliation (Mode: ${isDryRun ? 'DRY-RUN' : 'EXECUTE'})`);
  console.log('================================================================');

  // 1. Fetch data
  // Select only columns that exist before and after the published hardening migrations. Using the
  // generated model shape here would request newer columns from a pre-migration database.
  const environments = await prisma.$queryRawUnsafe<EnvironmentOwnerRow[]>(
    `SELECT "Environment"."resourceId", "Project"."ownerId"
       FROM "Environment"
       INNER JOIN "Project" ON "Project"."id" = "Environment"."projectId"
      WHERE "Environment"."resourceId" IS NOT NULL`
  );
  const guardians = await prisma.$queryRawUnsafe<GuardianReconciliationRow[]>(
    `SELECT "id", "resourceId", "discordUserId", "role", "createdAt" FROM "Guardian"`
  );

  console.log(`Found ${environments.length} environment-linked resources.`);
  console.log(`Found ${guardians.length} total explicit guardian rows.`);

  const projectLinkedResourceIds = new Set(
    environments.map((e) => e.resourceId).filter((id): id is string => !!id)
  );
  const resourceToProjectOwnerMap = new Map<string, string>(); // resourceId -> project.ownerId
  for (const env of environments) {
    if (env.resourceId) {
      resourceToProjectOwnerMap.set(env.resourceId, env.ownerId);
    }
  }

  // 2. Identify duplicate guardian rows per (resourceId, discordUserId)
  // We group rows by resourceId_discordUserId key
  const guardianGroups = new Map<string, typeof guardians>();
  for (const g of guardians) {
    const key = JSON.stringify([g.resourceId, g.discordUserId]);
    let group = guardianGroups.get(key);
    if (!group) {
      group = [];
      guardianGroups.set(key, group);
    }
    group.push(g);
  }

  const duplicatesToDelete: string[] = [];
  const keptGuardians: typeof guardians = [];

  for (const [key, group] of guardianGroups.entries()) {
    if (group.length === 1) {
      keptGuardians.push(group[0]);
      continue;
    }

    console.log(`⚠️ Found duplicate assignments for key "${key}" (count: ${group.length})`);
    const canonicalProjectOwnerId = resourceToProjectOwnerMap.get(group[0].resourceId);
    const primary = selectCanonicalGuardianRow(group, canonicalProjectOwnerId);
    const sorted = [primary, ...group.filter((row) => row.id !== primary.id)];
    keptGuardians.push(primary);
    console.log(
      `   Keeping row ID: ${primary.id} (role: ${primary.role}, created: ${primary.createdAt.toISOString()})`
    );
    if (
      canonicalProjectOwnerId &&
      primary.discordUserId !== canonicalProjectOwnerId &&
      primary.role === 'GUARDIAN'
    ) {
      console.log(
        `   Preserving explicit GUARDIAN; OWNER rows for this subject are noncanonical Project-owner mirrors.`
      );
    }

    for (let i = 1; i < sorted.length; i++) {
      duplicatesToDelete.push(sorted[i].id);
      console.log(
        `   Marking for deletion ID: ${sorted[i].id} (role: ${sorted[i].role}, created: ${sorted[i].createdAt.toISOString()})`
      );
    }
  }

  // 3. Identify legacy project-linked Resource owner rows for operator review.
  //
  // The current schema has no provenance column that can distinguish an automatically mirrored
  // OWNER row from a deliberate historical assignment. Project.ownerId is authoritative in policy,
  // but this script must not destroy ambiguous data. Report these rows and leave them untouched.
  const ownerRowsToReview: string[] = [];

  for (const g of keptGuardians) {
    if (projectLinkedResourceIds.has(g.resourceId) && g.role === 'OWNER') {
      const pOwnerId = resourceToProjectOwnerMap.get(g.resourceId);
      console.log(
        `📋 Found OWNER guardian row on project-linked resource ${g.resourceId} (user: ${g.discordUserId})`
      );
      if (g.discordUserId === pOwnerId) {
        console.log(
          `   Row ID: ${g.id} matches Project Owner (${pOwnerId}). Retaining for operator review.`
        );
      } else {
        console.log(
          `   Row ID: ${g.id} does not match Project Owner ${pOwnerId}. Policy ignores its OWNER authority; retaining ambiguous data for operator review.`
        );
      }
      ownerRowsToReview.push(g.id);
    }
  }

  console.log('================================================================');
  console.log(`Reconciliation Summary:`);
  console.log(`- Duplicate guardian rows to delete: ${duplicatesToDelete.length}`);
  console.log(
    `- Ambiguous project-linked OWNER rows retained for review: ${ownerRowsToReview.length}`
  );

  if (duplicatesToDelete.length === 0) {
    console.log('✅ No duplicate Guardian assignments require reconciliation.');
    return { duplicatesDeleted: 0, ownerRowsRetainedForReview: ownerRowsToReview };
  }

  if (isDryRun) {
    console.log('\n👉 Running in DRY-RUN mode. No database changes were made.');
    console.log('   To apply these changes, run the script with: --execute');
  } else {
    console.log('\n💾 Executing database writes...');
    const placeholders = duplicatesToDelete.map(() => '?').join(', ');
    const deletedCount = await prisma.$executeRawUnsafe(
      `DELETE FROM "Guardian" WHERE "id" IN (${placeholders})`,
      ...duplicatesToDelete
    );
    if (deletedCount !== duplicatesToDelete.length) {
      throw new Error(
        `Guardian reconciliation deleted ${deletedCount} rows; expected ${duplicatesToDelete.length}.`
      );
    }
    console.log(`✅ Successfully deleted ${deletedCount} guardian rows from database.`);
    return {
      duplicatesDeleted: deletedCount,
      ownerRowsRetainedForReview: ownerRowsToReview,
    };
  }

  return { duplicatesDeleted: 0, ownerRowsRetainedForReview: ownerRowsToReview };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runGuardianReconciliation(prisma, process.argv.slice(2).includes('--execute'));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      await prisma.$disconnect();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  void main();
}
