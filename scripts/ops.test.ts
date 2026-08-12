import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { env } from '../apps/purrmission-bot/src/config/env.js';
import { backupDatabase } from './backup-db.js';
import {
  classifyMigrationDatabaseTables,
  runMigrationPreflight,
  stageLegacyHardeningRows,
} from './deploy-migrations.js';
import { selectCanonicalGuardianRow } from './reconcile-guardians-owners.js';

describe('Operations Scripts', () => {
  let dummyDbCreated = false;
  let resolvedDbPath = '';
  const temporaryDirectories: string[] = [];

  before(() => {
    // Find where the script thinks the DB is
    const dbUrl = env.DATABASE_URL;
    if (dbUrl.startsWith('file:')) {
      let dbPath = dbUrl.replace(/^file:/, '');
      if (dbPath.startsWith('///')) {
        dbPath = dbPath.slice(2);
      } else if (dbPath.startsWith('//')) {
        dbPath = dbPath.slice(1);
      }
      dbPath = dbPath.split('?')[0];

      resolvedDbPath = path.resolve(process.cwd(), dbPath);
      const dir = path.dirname(resolvedDbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(resolvedDbPath)) {
        fs.writeFileSync(resolvedDbPath, 'dummy data');
        dummyDbCreated = true;
      }
    }
  });

  after(() => {
    if (dummyDbCreated && resolvedDbPath && fs.existsSync(resolvedDbPath)) {
      try {
        fs.unlinkSync(resolvedDbPath);
      } catch {
        // ignore
      }
    }
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  describe('backup-db', () => {
    it('should create a backup file for a valid SQLite DB', async () => {
      // Mock env.DATABASE_URL if possible, or just rely on existing dev.db if it exists
      // Since we can't easily mock the 'env' import here without a more complex setup,
      // we'll assume the function uses the current env.
      // If DATABASE_URL is not set to a file: path, it will throw.

      try {
        const backupPath = await backupDatabase();
        assert.ok(fs.existsSync(backupPath));
        assert.ok(backupPath.includes('backups'));
      } catch (err) {
        if (err instanceof Error && err.message.includes('only supported for SQLite')) {
          // Skip if not SQLite
          return;
        }
        throw err;
      }
    });
  });

  // rotate-keys.ts is harder to test without a full Prisma mock setup,
  // but we can verify it exports what we expect and doesn't crash on import.
  describe('rotate-keys', () => {
    it('should be importable without side effects', async () => {
      const module = await import('./rotate-keys.js');
      assert.ok(module);
    });
  });

  describe('supported migration command', () => {
    it('does not document a raw Prisma deployment bypass in operational files', () => {
      const operationalFiles = [
        'README.md',
        'DEPLOY.md',
        'AGENTS.md',
        'docs/deployment-checklist.md',
        'apps/purrmission-bot/README.md',
        'scripts/quick-start.sh',
        '.github/workflows/deploy.yml',
        'package.json',
      ];
      const rawDeployCommand = /\b(?:npx|pnpm\s+exec)\s+prisma\s+migrate\s+deploy\b/;

      for (const file of operationalFiles) {
        assert.doesNotMatch(
          fs.readFileSync(path.join(process.cwd(), file), 'utf8'),
          rawDeployCommand,
          `${file} must direct operators through pnpm prisma:deploy`
        );
      }
      assert.doesNotMatch(
        fs.readFileSync(path.join(process.cwd(), 'scripts/quick-start.sh'), 'utf8'),
        /prisma:deploy\s*\|\|/,
        'quick-start must propagate migration deployment failures'
      );

      const deployWorkflow = fs.readFileSync(
        path.join(process.cwd(), '.github/workflows/deploy.yml'),
        'utf8'
      );
      assert.match(deployWorkflow, /pnpm prisma:deploy/);
      assert.match(deployWorkflow, /scripts\/deploy-migrations\.ts/);
      assert.match(deployWorkflow, /scripts\/reconcile-guardians-owners\.ts/);
      for (const script of [
        'scripts/deploy-migrations.ts',
        'scripts/reconcile-guardians-owners.ts',
        'scripts/validate-env.cjs',
      ]) {
        assert.match(
          deployWorkflow,
          new RegExp(`- ['"]${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
          `${script} must trigger the deploy workflow when it changes`
        );
      }
    });
  });

  describe('guardian-owner reconciliation', () => {
    const at = (day: number) => new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00Z`);

    it('preserves Writer plus explicit Guardian when a stale OWNER mirror is duplicated', () => {
      const rows = [
        {
          id: 'stale-owner-mirror',
          resourceId: 'resource-1',
          discordUserId: 'writer-and-guardian',
          role: 'OWNER' as const,
          createdAt: at(20),
        },
        {
          id: 'explicit-guardian',
          resourceId: 'resource-1',
          discordUserId: 'writer-and-guardian',
          role: 'GUARDIAN' as const,
          createdAt: at(21),
        },
      ];

      const kept = selectCanonicalGuardianRow(rows, 'canonical-project-owner');
      assert.equal(kept.id, 'explicit-guardian');
      assert.equal(kept.role, 'GUARDIAN');
    });

    it('retains OWNER for the canonical Project Owner and standalone Resource Owner', () => {
      const rows = [
        {
          id: 'guardian',
          resourceId: 'resource-1',
          discordUserId: 'canonical-project-owner',
          role: 'GUARDIAN' as const,
          createdAt: at(20),
        },
        {
          id: 'owner',
          resourceId: 'resource-1',
          discordUserId: 'canonical-project-owner',
          role: 'OWNER' as const,
          createdAt: at(21),
        },
      ];

      assert.equal(selectCanonicalGuardianRow(rows, 'canonical-project-owner').role, 'OWNER');
      assert.equal(selectCanonicalGuardianRow(rows).role, 'OWNER');
    });

    it('does not promote an ambiguous stale OWNER-only row to Guardian authority', () => {
      const staleOwnerOnly = [
        {
          id: 'ambiguous-stale-owner',
          resourceId: 'resource-1',
          discordUserId: 'former-owner',
          role: 'OWNER' as const,
          createdAt: at(20),
        },
      ];

      const kept = selectCanonicalGuardianRow(staleOwnerOnly, 'canonical-project-owner');
      assert.equal(kept.role, 'OWNER');
      assert.notEqual(kept.role, 'GUARDIAN');
    });
  });

  describe('safe migration deployment', () => {
    const createTemporaryDatabase = (name: string): string => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `purrmission-${name}-`));
      temporaryDirectories.push(directory);
      return path.join(directory, 'test.db');
    };

    const applySql = (databasePath: string, sql: string): void => {
      execFileSync('sqlite3', ['-bail', databasePath], { input: sql });
    };

    const applyMigrationsBeforeGuardianInvariant = (
      databasePath: string,
      recordMigrationHistory = false
    ): void => {
      const sourceMigrationsRoot = path.join(process.cwd(), 'prisma', 'migrations');
      if (recordMigrationHistory) {
        applySql(
          databasePath,
          `CREATE TABLE "_prisma_migrations" (
             "id" TEXT PRIMARY KEY NOT NULL,
             "checksum" TEXT NOT NULL,
             "finished_at" DATETIME,
             "migration_name" TEXT NOT NULL,
             "logs" TEXT,
             "rolled_back_at" DATETIME,
             "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
             "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
           );`
        );
      }
      const migrations = fs
        .readdirSync(sourceMigrationsRoot)
        .filter((name) => name < '20260724110100_guardian_assignment_invariant')
        .sort();
      for (const migration of migrations) {
        const sql = fs.readFileSync(
          path.join(sourceMigrationsRoot, migration, 'migration.sql'),
          'utf8'
        );
        applySql(databasePath, sql);
        if (recordMigrationHistory) {
          const checksum = createHash('sha256').update(sql).digest('hex');
          applySql(
            databasePath,
            `INSERT INTO "_prisma_migrations"
               ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
             VALUES
               ('fixture-${migration}', '${checksum}', CURRENT_TIMESTAMP, '${migration}', CURRENT_TIMESTAMP, 1);`
          );
        }
      }
    };

    const runSupportedDeploy = (databasePath: string) =>
      spawnSync('pnpm', ['prisma:deploy'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
        encoding: 'utf8',
      });

    it('classifies a fresh database and fails closed on initialized partial schemas', () => {
      assert.equal(classifyMigrationDatabaseTables([]), 'FRESH');
      assert.throws(
        () => classifyMigrationDatabaseTables(['_prisma_migrations', 'Guardian']),
        /missing required table\(s\)/
      );
    });

    it('returns nonzero for an initialized database missing reconciliation tables', () => {
      const databasePath = createTemporaryDatabase('corrupt-deploy');
      applySql(databasePath, 'CREATE TABLE "Guardian" ("id" TEXT PRIMARY KEY);');

      const result = runSupportedDeploy(databasePath);
      assert.equal(result.status, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /missing required table\(s\)/);
    });

    it('reconciles populated data before applying the published Guardian invariant', async () => {
      const databasePath = createTemporaryDatabase('guardian-upgrade');
      applyMigrationsBeforeGuardianInvariant(databasePath);
      applySql(
        databasePath,
        `PRAGMA foreign_keys=ON;
         INSERT INTO "Resource" ("id", "name", "mode", "apiKey")
           VALUES ('resource-1', 'Protected', 'ONE_OF_N', 'key');
         INSERT INTO "Project" ("id", "name", "ownerId", "updatedAt")
           VALUES ('project-1', 'Project', 'canonical-owner', '2026-07-01T00:00:00Z');
         INSERT INTO "ProjectMember" ("id", "projectId", "userId", "role", "addedBy", "updatedAt")
           VALUES ('member-1', 'project-1', 'writer-guardian', 'WRITER', 'canonical-owner', '2026-07-01T00:00:00Z');
         INSERT INTO "Environment" ("id", "name", "slug", "projectId", "updatedAt", "resourceId")
           VALUES ('environment-1', 'Production', 'prod', 'project-1', '2026-07-01T00:00:00Z', 'resource-1');
         INSERT INTO "Guardian" ("id", "resourceId", "discordUserId", "role", "createdAt")
           VALUES ('stale-owner', 'resource-1', 'writer-guardian', 'OWNER', '2026-07-01T00:00:00Z');
         INSERT INTO "Guardian" ("id", "resourceId", "discordUserId", "role", "createdAt")
           VALUES ('explicit-guardian', 'resource-1', 'writer-guardian', 'GUARDIAN', '2026-07-02T00:00:00Z');
         INSERT INTO "Guardian" ("id", "resourceId", "discordUserId", "role", "createdAt")
           VALUES ('ambiguous-owner-only', 'resource-1', 'former-owner', 'OWNER', '2026-07-03T00:00:00Z');`
      );

      const prisma = new PrismaClient({
        datasources: { db: { url: `file:${databasePath}` } },
      });
      try {
        assert.equal(await runMigrationPreflight(prisma), 'INITIALIZED');
      } finally {
        await prisma.$disconnect();
      }

      applySql(
        databasePath,
        fs.readFileSync(
          path.join(
            process.cwd(),
            'prisma/migrations/20260724110100_guardian_assignment_invariant/migration.sql'
          ),
          'utf8'
        )
      );

      const rows = execFileSync(
        'sqlite3',
        [
          '-noheader',
          databasePath,
          `SELECT "discordUserId" || ':' || "role" FROM "Guardian" ORDER BY "discordUserId";`,
        ],
        { encoding: 'utf8' }
      )
        .trim()
        .split('\n');
      assert.deepEqual(rows, ['former-owner:OWNER', 'writer-guardian:GUARDIAN']);
    });

    it('preserves populated legacy AuditLog rows through the published hardening migration', () => {
      const databasePath = createTemporaryDatabase('audit-history-blocker');
      applyMigrationsBeforeGuardianInvariant(databasePath, true);
      applySql(
        databasePath,
        `INSERT INTO "AuditLog" ("id", "action", "status")
         VALUES ('legacy-audit', 'FIELD_ACCESSED', 'SUCCESS');`
      );

      const result = runSupportedDeploy(databasePath);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const auditRow = execFileSync(
        'sqlite3',
        [
          '-noheader',
          databasePath,
          `SELECT "eventType" || ':' || "outcomeCode" || ':' || "actorType"
           FROM "AuditLog" WHERE "id" = 'legacy-audit';`,
        ],
        { encoding: 'utf8' }
      ).trim();
      assert.equal(auditRow, 'FIELD_ACCESSED:SUCCESS:SYSTEM');
      assert.equal(
        execFileSync(
          'sqlite3',
          [
            '-noheader',
            databasePath,
            `SELECT COUNT(*) FROM "sqlite_master"
             WHERE "type" = 'table' AND "name" LIKE '_purrmission_stage_%';`,
          ],
          { encoding: 'utf8' }
        ).trim(),
        '0'
      );
    });

    it('fails closed instead of silently dropping unmappable legacy audit context', () => {
      const databasePath = createTemporaryDatabase('audit-context-blocker');
      applyMigrationsBeforeGuardianInvariant(databasePath, true);
      applySql(
        databasePath,
        `INSERT INTO "AuditLog" ("id", "action", "status", "context")
         VALUES ('legacy-audit-context', 'FIELD_ACCESSED', 'SUCCESS', '{"unknown":"value"}');`
      );

      const result = runSupportedDeploy(databasePath);
      assert.equal(result.status, 1);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /cannot be safely mapped by the compatibility preflight/
      );
      assert.equal(
        execFileSync('sqlite3', ['-noheader', databasePath, `SELECT COUNT(*) FROM "AuditLog";`], {
          encoding: 'utf8',
        }).trim(),
        '1'
      );
    });

    it('preserves Guardian data and supplies stable compatibility versions on populated deploy', () => {
      const databasePath = createTemporaryDatabase('version-history-blocker');
      applyMigrationsBeforeGuardianInvariant(databasePath, true);
      applySql(
        databasePath,
        `INSERT INTO "Resource" ("id", "name", "mode", "apiKey")
           VALUES ('resource-1', 'Protected', 'ONE_OF_N', 'key');
         INSERT INTO "Project" ("id", "name", "ownerId", "updatedAt")
           VALUES ('project-1', 'Project', 'canonical-owner', '2026-07-01T00:00:00Z');
         INSERT INTO "Environment" ("id", "name", "slug", "projectId", "updatedAt", "resourceId")
           VALUES ('environment-1', 'Production', 'prod', 'project-1', '2026-07-01T00:00:00Z', 'resource-1');
         INSERT INTO "Guardian" ("id", "resourceId", "discordUserId", "role", "createdAt")
           VALUES ('stale-owner', 'resource-1', 'writer-guardian', 'OWNER', '2026-07-01T00:00:00Z');
         INSERT INTO "Guardian" ("id", "resourceId", "discordUserId", "role", "createdAt")
           VALUES ('explicit-guardian', 'resource-1', 'writer-guardian', 'GUARDIAN', '2026-07-02T00:00:00Z');`
      );

      const result = runSupportedDeploy(databasePath);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const guardianRows = execFileSync(
        'sqlite3',
        [
          '-noheader',
          databasePath,
          `SELECT "discordUserId" || ':' || "role" FROM "Guardian" ORDER BY "discordUserId";`,
        ],
        { encoding: 'utf8' }
      ).trim();
      assert.equal(guardianRows, 'writer-guardian:GUARDIAN');
      const compatibilityVersions = execFileSync(
        'sqlite3',
        [
          '-noheader',
          databasePath,
          `SELECT "policyVersion" FROM "Project" WHERE "id" = 'project-1';
           SELECT "version" FROM "Resource" WHERE "id" = 'resource-1';`,
        ],
        { encoding: 'utf8' }
      )
        .trim()
        .split('\n');
      assert.deepEqual(compatibilityVersions, [
        'legacy-policy-project-1',
        'legacy-resource-resource-1',
      ]);
    });

    it('resumes safely after interruption leaves the complete pre-migration stage', async () => {
      const databasePath = createTemporaryDatabase('staged-resume');
      applyMigrationsBeforeGuardianInvariant(databasePath, true);
      applySql(
        databasePath,
        `INSERT INTO "Resource" ("id", "name", "mode", "apiKey")
           VALUES ('resource-resume', 'Protected', 'ONE_OF_N', 'key');
         INSERT INTO "Project" ("id", "name", "ownerId", "updatedAt")
           VALUES ('project-resume', 'Project', 'owner', '2026-07-01T00:00:00Z');
         INSERT INTO "Environment" ("id", "name", "slug", "projectId", "updatedAt", "resourceId")
           VALUES ('environment-resume', 'Production', 'prod', 'project-resume', '2026-07-01T00:00:00Z', 'resource-resume');`
      );

      const prisma = new PrismaClient({
        datasources: { db: { url: `file:${databasePath}` } },
      });
      try {
        assert.equal(await stageLegacyHardeningRows(prisma), true);
      } finally {
        await prisma.$disconnect();
      }
      assert.equal(
        execFileSync('sqlite3', ['-noheader', databasePath, `SELECT COUNT(*) FROM "Resource";`], {
          encoding: 'utf8',
        }).trim(),
        '0'
      );

      const result = runSupportedDeploy(databasePath);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(
        execFileSync(
          'sqlite3',
          [
            '-noheader',
            databasePath,
            `SELECT "version" FROM "Resource" WHERE "id" = 'resource-resume';`,
          ],
          { encoding: 'utf8' }
        ).trim(),
        'legacy-resource-resource-resume'
      );
    });

    it('fails closed when any seed-bearing recovery stage table is residual by itself', () => {
      const databasePath = createTemporaryDatabase('partial-stage');
      assert.equal(runSupportedDeploy(databasePath).status, 0);
      applySql(
        databasePath,
        `CREATE TABLE "_purrmission_stage_TOTPAccount" AS
           SELECT * FROM "TOTPAccount" WHERE 0;
         INSERT INTO "_purrmission_stage_TOTPAccount"
           ("id", "ownerDiscordUserId", "accountName", "secret", "version", "createdAt", "updatedAt")
         VALUES
           ('residual-totp', 'owner', 'Residual', 'SENSITIVE-SEED', 'v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);`
      );

      const result = runSupportedDeploy(databasePath);
      assert.equal(result.status, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /Incomplete hardening recovery stage/);
      assert.equal(
        execFileSync(
          'sqlite3',
          [
            '-noheader',
            databasePath,
            `SELECT "secret" FROM "_purrmission_stage_TOTPAccount" WHERE "id" = 'residual-totp';`,
          ],
          { encoding: 'utf8' }
        ).trim(),
        'SENSITIVE-SEED'
      );
    });

    it('deploys every migration on a fresh empty database through the supported wrapper', () => {
      const databasePath = createTemporaryDatabase('fresh-deploy');
      applySql(databasePath, 'VACUUM;');

      const result = runSupportedDeploy(databasePath);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const appliedCount = Number(
        execFileSync(
          'sqlite3',
          ['-noheader', databasePath, 'SELECT COUNT(*) FROM "_prisma_migrations";'],
          { encoding: 'utf8' }
        ).trim()
      );
      assert.equal(appliedCount, 16);
    });
  });
});
