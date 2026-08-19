import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  legacyAuditUpgradeInternals,
  restoreLegacyAuditLogs,
  stageLegacyAuditLogs,
} from './legacy-audit-upgrade.js';
import { classifyMigrationDatabaseTables, resolveSqliteDatabasePath } from './deploy-migrations.js';
import { AuditService } from '../apps/purrmission-bot/src/domain/audit.js';
import { createInMemoryRepositories } from '../apps/purrmission-bot/src/domain/repositories.mock.js';
import type { AuditLog } from '../apps/purrmission-bot/src/domain/models.js';

process.env.AUDIT_INTEGRITY_KEY ||= '11'.repeat(32);
process.env.AUDIT_INTEGRITY_KEY_ID ||= 'audit-test-v1';

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE "AuditLog" (
      "id" TEXT NOT NULL PRIMARY KEY, "action" TEXT NOT NULL, "resourceId" TEXT,
      "actorId" TEXT, "resolverId" TEXT, "status" TEXT NOT NULL, "context" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "AuditLog" VALUES
      ('audit-1', 'FIELD_ACCESSED', 'resource-1', 'actor-1', NULL, 'SUCCESS',
       '{"secret":"must-not-return"}', '2026-01-01T00:00:00.000Z'),
      ('audit-2', 'REQUEST_DENIED', 'resource-1', 'actor-2', 'guardian-1', 'DENIED',
       NULL, '2026-01-02T00:00:00.000Z');
  `);
  return db;
}

const migrationsRoot = path.join(process.cwd(), 'prisma', 'migrations');
const migrations = readdirSync(migrationsRoot)
  .filter((name) => /^\d/.test(name))
  .sort();

function applyMigrations(
  db: DatabaseSync,
  predicate: (migration: string) => boolean = () => true
): void {
  for (const migration of migrations.filter(predicate)) {
    db.exec(readFileSync(path.join(migrationsRoot, migration, 'migration.sql'), 'utf8'));
  }
}

function installFinalAuditTable(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE "AuditLog";
    CREATE TABLE "AuditLog" (
      "id" TEXT NOT NULL PRIMARY KEY, "schemaVersion" INTEGER NOT NULL,
      "eventFamily" TEXT NOT NULL, "eventType" TEXT NOT NULL, "surface" TEXT NOT NULL,
      "operation" TEXT NOT NULL, "outcomeCode" TEXT NOT NULL, "capability" TEXT,
      "decisionCode" TEXT NOT NULL, "reasonCode" TEXT NOT NULL, "targetType" TEXT NOT NULL,
      "targetId" TEXT, "authoritySources" JSONB NOT NULL, "actorType" TEXT NOT NULL,
      "principalId" TEXT NOT NULL, "actorId" TEXT, "authKind" TEXT, "resolverType" TEXT,
      "resolverId" TEXT, "resourceId" TEXT, "projectId" TEXT, "environmentId" TEXT,
      "requestId" TEXT, "grantId" TEXT, "correlationId" TEXT, "causationId" TEXT,
      "statusCode" INTEGER, "durationMs" INTEGER, "retentionClass" TEXT NOT NULL,
      "integrityKeyId" TEXT NOT NULL, "integrityHash" TEXT NOT NULL, "payload" JSONB,
      "createdAt" DATETIME NOT NULL
    );
  `);
}

describe('legacy AuditLog populated upgrade', () => {
  it('wires the supported deployment command through reconciliation and legacy staging', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    ) as {
      scripts: Record<string, string>;
    };
    const wrapper = readFileSync(
      path.join(process.cwd(), 'scripts', 'deploy-migrations.ts'),
      'utf8'
    );
    const orchestration = wrapper.slice(wrapper.indexOf('export async function deployMigrations'));
    assert.equal(packageJson.scripts['prisma:deploy'], 'tsx scripts/deploy-migrations.ts');
    assert.ok(
      orchestration.indexOf('runMigrationPreflight') < orchestration.indexOf('stageLegacyAuditLogs')
    );
    assert.ok(
      orchestration.indexOf('stageLegacyAuditLogs') < orchestration.indexOf('runPrismaDeploy')
    );
    assert.ok(
      orchestration.indexOf('runPrismaDeploy') < orchestration.indexOf('restoreLegacyAuditLogs')
    );
    assert.equal(classifyMigrationDatabaseTables([]), 'FRESH');
    assert.throws(
      () => classifyMigrationDatabaseTables(['_prisma_migrations', 'Guardian']),
      /missing required table\(s\)/
    );
    assert.equal(
      resolveSqliteDatabasePath('file:./data/test.db', '/repo'),
      path.join('/repo', 'prisma', 'data', 'test.db')
    );
  });

  it('applies every migration to a fresh database', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const auditColumns = db.prepare('PRAGMA table_info("AuditLog")').all() as Array<{
      name: string;
    }>;
    assert.ok(auditColumns.some(({ name }) => name === 'eventFamily'));
    assert.ok(auditColumns.some(({ name }) => name === 'integrityHash'));
    const outboxColumns = db.prepare('PRAGMA table_info("OutboxEvent")').all() as Array<{
      name: string;
    }>;
    assert.ok(outboxColumns.some(({ name }) => name === 'lastErrorCode'));
    assert.equal(
      outboxColumns.some(({ name }) => name === 'lastError'),
      false
    );
  });

  it('rehearses the real non-empty migration chain with stage/deploy/restore', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, (migration) => migration < '20260724110200');
    db.prepare(
      'INSERT INTO "AuditLog" ("id", "action", "resourceId", "actorId", "resolverId", "status", "context", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'real-legacy-audit',
      'FIELD_ACCESSED',
      null,
      'actor-1',
      null,
      'SUCCESS',
      '{"token":"must-not-return"}',
      '2026-01-01T00:00:00.000Z'
    );
    assert.equal(stageLegacyAuditLogs(db).rowCount, 1);
    applyMigrations(
      db,
      (migration) => migration === '20260724110200_rbac_dashboard_hardening_remediations'
    );
    db.prepare(
      'INSERT INTO "OutboxEvent" ("id", "eventType", "payload", "status", "attempts", "lastError", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'legacy-outbox',
      'APPROVAL_CALLBACK',
      '{"requestId":"request-1"}',
      'PENDING',
      1,
      'Bearer must-not-return',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
    applyMigrations(
      db,
      (migration) => migration > '20260724110200_rbac_dashboard_hardening_remediations'
    );
    assert.equal(restoreLegacyAuditLogs(db).rowCount, 1);
    const restored = db
      .prepare('SELECT "eventType", "payload" FROM "AuditLog" WHERE "id" = ?')
      .get('real-legacy-audit') as { eventType: string; payload: string };
    assert.equal(restored.eventType, 'FIELD_ACCESSED');
    assert.equal(restored.payload.includes('must-not-return'), false);
    const outbox = db
      .prepare('SELECT "payload", "status", "lastErrorCode" FROM "OutboxEvent" WHERE "id" = ?')
      .get('legacy-outbox') as { payload: string; status: string; lastErrorCode: string };
    assert.equal(outbox.payload, '{"legacyPayloadDiscarded":1}');
    assert.equal(outbox.status, 'FAILED');
    assert.equal(outbox.lastErrorCode, 'LEGACY_UNVERIFIED');
  });

  it('runs the supported deploy wrapper against real populated migration history', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'purrmission-audit-deploy-'));
    const databasePath = path.join(directory, 'populated.db');
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`CREATE TABLE "_prisma_migrations" (
        "id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
        "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
      )`);
      const applied = migrations.filter((migration) => migration < '20260724110100');
      for (const migration of applied) {
        const sql = readFileSync(path.join(migrationsRoot, migration, 'migration.sql'), 'utf8');
        db.exec(sql);
        db.prepare(
          `INSERT INTO "_prisma_migrations"
            ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
           VALUES (?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, 1)`
        ).run(`fixture-${migration}`, createHash('sha256').update(sql).digest('hex'), migration);
      }
      db.prepare(
        `INSERT INTO "AuditLog" ("id", "action", "status", "context", "createdAt")
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        'populated-legacy-audit',
        'FIELD_ACCESSED',
        'SUCCESS',
        '{"secret":"must-not-return"}',
        '2026-01-01T00:00:00.000Z'
      );
    } finally {
      db.close();
    }

    try {
      const result = spawnSync('pnpm', ['prisma:deploy'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `file:${databasePath}`,
          AUDIT_INTEGRITY_KEY: '11'.repeat(32),
          AUDIT_INTEGRITY_KEY_ID: 'audit-test-v1',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const retry = spawnSync('pnpm', ['prisma:deploy'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `file:${databasePath}`,
          AUDIT_INTEGRITY_KEY: '11'.repeat(32),
          AUDIT_INTEGRITY_KEY_ID: 'audit-test-v1',
        },
        encoding: 'utf8',
      });
      assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
      const verified = new DatabaseSync(databasePath);
      try {
        const row = verified
          .prepare(
            'SELECT "eventFamily", "integrityHash", "payload" FROM "AuditLog" WHERE "id" = ?'
          )
          .get('populated-legacy-audit') as {
          eventFamily: string;
          integrityHash: string;
          payload: string;
        };
        assert.equal(row.eventFamily, 'LEGACY');
        assert.match(row.integrityHash, /^[0-9a-f]{64}$/);
        assert.equal(row.payload.includes('must-not-return'), false);
      } finally {
        verified.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stages non-empty legacy data idempotently and restores a redacted v2 envelope', () => {
    const db = legacyDatabase();
    const first = stageLegacyAuditLogs(db);
    assert.equal(first.state, 'STAGED');
    assert.equal(first.rowCount, 2);
    assert.equal(
      Number(
        (db.prepare('SELECT count(*) AS count FROM "AuditLog"').get() as { count: number }).count
      ),
      0
    );

    const retry = stageLegacyAuditLogs(db);
    assert.equal(retry.state, 'STAGED');
    assert.equal(retry.aggregateChecksum, first.aggregateChecksum);
    installFinalAuditTable(db);

    const restored = restoreLegacyAuditLogs(db);
    assert.equal(restored.state, 'RESTORED');
    assert.equal(restored.rowCount, 2);
    const rows = db.prepare('SELECT * FROM "AuditLog" ORDER BY "id"').all() as Array<
      Record<string, unknown>
    >;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].eventType, 'FIELD_ACCESSED');
    assert.equal(rows[0].eventFamily, 'LEGACY');
    assert.equal(String(rows[0].payload).includes('must-not-return'), false);
    assert.match(String(rows[0].integrityHash), /^[0-9a-f]{64}$/);
    const firstRow = rows[0];
    const restoredEnvelope: AuditLog = {
      ...(firstRow as unknown as AuditLog),
      authoritySources: JSON.parse(String(firstRow.authoritySources)),
      payload: JSON.parse(String(firstRow.payload)),
      createdAt: new Date(String(firstRow.createdAt)),
    };
    const verifier = new AuditService(
      { repositories: createInMemoryRepositories() },
      {
        auditIntegrityKey: Buffer.from(process.env.AUDIT_INTEGRITY_KEY ?? '', 'hex'),
        auditIntegrityKeyId: process.env.AUDIT_INTEGRITY_KEY_ID ?? 'audit-test-v1',
        outboxIntegrityKey: Buffer.alloc(32, 0x22),
        outboxIntegrityKeyId: 'outbox-test-v1',
        retentionDays: 365,
        checkpointInterval: 1000,
      }
    );
    assert.equal(verifier.verifyIntegrity(restoredEnvelope), true);
    assert.equal(
      Number(
        (
          db
            .prepare(`SELECT count(*) AS count FROM "${legacyAuditUpgradeInternals.STAGE_TABLE}"`)
            .get() as { count: number }
        ).count
      ),
      0
    );
    assert.equal(restoreLegacyAuditLogs(db).state, 'ALREADY_COMPLETE');

    const originalKey = process.env.AUDIT_INTEGRITY_KEY;
    const originalId = process.env.AUDIT_INTEGRITY_KEY_ID;
    const originalRing = process.env.AUDIT_INTEGRITY_KEYS_JSON;
    try {
      process.env.AUDIT_INTEGRITY_KEY = '33'.repeat(32);
      process.env.AUDIT_INTEGRITY_KEY_ID = 'audit-test-v2';
      process.env.AUDIT_INTEGRITY_KEYS_JSON = JSON.stringify({
        [originalId ?? 'audit-test-v1']: originalKey ?? '11'.repeat(32),
      });
      assert.equal(restoreLegacyAuditLogs(db).state, 'ALREADY_COMPLETE');
    } finally {
      process.env.AUDIT_INTEGRITY_KEY = originalKey;
      process.env.AUDIT_INTEGRITY_KEY_ID = originalId;
      if (originalRing === undefined) delete process.env.AUDIT_INTEGRITY_KEYS_JSON;
      else process.env.AUDIT_INTEGRITY_KEYS_JSON = originalRing;
    }
  });

  it('retains staging and fails nonzero when integrity validation is interrupted', () => {
    const db = legacyDatabase();
    stageLegacyAuditLogs(db);
    installFinalAuditTable(db);
    db.exec(
      `UPDATE "${legacyAuditUpgradeInternals.STAGE_TABLE}" SET "rowJson" = '{"tampered":true}' WHERE "id" = 'audit-1'`
    );
    assert.throws(() => restoreLegacyAuditLogs(db), /integrity validation failed/);
    assert.equal(
      Number(
        (
          db
            .prepare(`SELECT count(*) AS count FROM "${legacyAuditUpgradeInternals.STAGE_TABLE}"`)
            .get() as { count: number }
        ).count
      ),
      2
    );
    assert.equal(
      Number(
        (db.prepare('SELECT count(*) AS count FROM "AuditLog"').get() as { count: number }).count
      ),
      0
    );
  });

  it('fails closed on staged conflicts and re-verifies completed rows', () => {
    const conflicted = legacyDatabase();
    stageLegacyAuditLogs(conflicted);
    conflicted.exec(
      `UPDATE "${legacyAuditUpgradeInternals.STAGE_TABLE}" SET "checksum" = '${'0'.repeat(64)}' WHERE "id" = 'audit-1'`
    );
    assert.throws(() => stageLegacyAuditLogs(conflicted), /integrity validation failed/);

    const completed = legacyDatabase();
    stageLegacyAuditLogs(completed);
    installFinalAuditTable(completed);
    restoreLegacyAuditLogs(completed);
    completed.exec(`UPDATE "AuditLog" SET "operation" = 'tampered' WHERE "id" = 'audit-1'`);
    assert.throws(
      () => restoreLegacyAuditLogs(completed),
      /completed event integrity validation failed/
    );

    const tamperedAnchor = legacyDatabase();
    stageLegacyAuditLogs(tamperedAnchor);
    installFinalAuditTable(tamperedAnchor);
    restoreLegacyAuditLogs(tamperedAnchor);
    tamperedAnchor.exec(
      `UPDATE "${legacyAuditUpgradeInternals.ANCHOR_TABLE}" SET "sourceChecksum" = '${'1'.repeat(64)}' WHERE "id" = 'audit-1'`
    );
    assert.throws(
      () => restoreLegacyAuditLogs(tamperedAnchor),
      /completion anchor integrity validation failed/
    );

    const tamperedManifest = legacyDatabase();
    stageLegacyAuditLogs(tamperedManifest);
    installFinalAuditTable(tamperedManifest);
    restoreLegacyAuditLogs(tamperedManifest);
    tamperedManifest.exec(
      `UPDATE "${legacyAuditUpgradeInternals.MANIFEST_TABLE}" SET "rowCount" = 1`
    );
    assert.throws(
      () => restoreLegacyAuditLogs(tamperedManifest),
      /completion manifest integrity validation failed/
    );
  });
});
