import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function runReconciliation() {
  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute');
  const isDryRun = !isExecute;

  console.log(`🚀 Starting Database Reconciliation (Mode: ${isDryRun ? 'DRY-RUN' : 'EXECUTE'})`);
  console.log('================================================================');

  // 1. Fetch data
  const environments = await prisma.environment.findMany({
    where: { resourceId: { not: null } },
    include: { project: true },
  });

  const guardians = await prisma.guardian.findMany();

  console.log(`Found ${environments.length} environment-linked resources.`);
  console.log(`Found ${guardians.length} total explicit guardian rows.`);

  const projectLinkedResourceIds = new Set(
    environments.map((e) => e.resourceId).filter((id): id is string => !!id)
  );
  const resourceToProjectOwnerMap = new Map<string, string>(); // resourceId -> project.ownerId
  for (const env of environments) {
    if (env.resourceId) {
      resourceToProjectOwnerMap.set(env.resourceId, env.project.ownerId);
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
    // Choose primary row to keep:
    // Prefer OWNER role first. If roles match, keep the oldest (smallest createdAt or id)
    const sorted = [...group].sort((a, b) => {
      if (a.role === 'OWNER' && b.role !== 'OWNER') return -1;
      if (a.role !== 'OWNER' && b.role === 'OWNER') return 1;
      const createdAtOrder = a.createdAt.getTime() - b.createdAt.getTime();
      return createdAtOrder !== 0 ? createdAtOrder : a.id.localeCompare(b.id);
    });

    const primary = sorted[0];
    keptGuardians.push(primary);
    console.log(
      `   Keeping row ID: ${primary.id} (role: ${primary.role}, created: ${primary.createdAt.toISOString()})`
    );

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
    return;
  }

  if (isDryRun) {
    console.log('\n👉 Running in DRY-RUN mode. No database changes were made.');
    console.log('   To apply these changes, run the script with: --execute');
  } else {
    console.log('\n💾 Executing database writes...');
    const result = await prisma.guardian.deleteMany({
      where: {
        id: { in: duplicatesToDelete },
      },
    });
    console.log(`✅ Successfully deleted ${result.count} guardian rows from database.`);
  }
}

runReconciliation()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
