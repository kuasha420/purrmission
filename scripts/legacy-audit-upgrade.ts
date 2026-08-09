import { createHash, createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const STAGE_TABLE = '_PurrmissionLegacyAuditStage';
const MANIFEST_TABLE = '_PurrmissionLegacyAuditManifest';
const ANCHOR_TABLE = '_PurrmissionLegacyAuditAnchor';
const MIGRATION = '20260724110200_rbac_dashboard_hardening_remediations';

type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, SqlValue>;

export interface LegacyAuditUpgradeResult {
  state: 'NOT_APPLICABLE' | 'STAGED' | 'RESTORED' | 'ALREADY_COMPLETE';
  rowCount: number;
  aggregateChecksum?: string;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function columns(db: DatabaseSync, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  return new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
      ({ name }) => name
    )
  );
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  return JSON.stringify(value);
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function aggregateChecksum(rows: Array<{ id: string; checksum: string }>): string {
  return checksum(
    rows
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, checksum: rowChecksum }) => `${id}:${rowChecksum}`)
      .join('\n')
  );
}

function ensureControlTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${STAGE_TABLE}" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "rowJson" TEXT NOT NULL,
      "checksum" TEXT NOT NULL,
      "stagedAt" TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "${MANIFEST_TABLE}" (
      "migration" TEXT NOT NULL PRIMARY KEY,
      "rowCount" INTEGER NOT NULL,
      "sourceAggregateChecksum" TEXT NOT NULL,
      "transformedAggregateChecksum" TEXT NOT NULL,
      "integrityKeyId" TEXT NOT NULL,
      "manifestHash" TEXT NOT NULL,
      "completedAt" TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "${ANCHOR_TABLE}" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sourceChecksum" TEXT NOT NULL,
      "transformedChecksum" TEXT NOT NULL,
      "integrityHash" TEXT NOT NULL,
      "integrityKeyId" TEXT NOT NULL,
      "anchorHash" TEXT NOT NULL
    );
  `);
}

function completedManifest(db: DatabaseSync): {
  rowCount: number;
  sourceAggregateChecksum: string;
  transformedAggregateChecksum: string;
  integrityKeyId: string;
  manifestHash: string;
  completedAt: string;
} | null {
  if (!tableExists(db, MANIFEST_TABLE)) return null;
  const row = db
    .prepare(
      `SELECT "rowCount", "sourceAggregateChecksum", "transformedAggregateChecksum", "integrityKeyId", "manifestHash", "completedAt" FROM "${MANIFEST_TABLE}" WHERE "migration" = ?`
    )
    .get(MIGRATION) as
    | {
        rowCount: number;
        sourceAggregateChecksum: string;
        transformedAggregateChecksum: string;
        integrityKeyId: string;
        manifestHash: string;
        completedAt: string;
      }
    | undefined;
  return row ? { ...row, rowCount: Number(row.rowCount) } : null;
}

/**
 * Checksum-safe preflight for the published 20260724110200 SQLite migration.
 *
 * The published migration creates required AuditLog columns but copies only nullable legacy
 * fields. It therefore fails on any legacy row. This function durably stages those rows in the
 * same database and clears only the source rows after count/checksum verification. Calling it
 * again after an interruption is safe.
 */
export function stageLegacyAuditLogs(db: DatabaseSync): LegacyAuditUpgradeResult {
  const complete = completedManifest(db);
  if (complete) {
    verifyCompletedRestore(db, complete);
    return {
      state: 'ALREADY_COMPLETE',
      rowCount: complete.rowCount,
      aggregateChecksum: complete.sourceAggregateChecksum,
    };
  }

  const auditColumns = columns(db, 'AuditLog');
  if (!auditColumns.has('action') || auditColumns.has('eventType')) {
    return { state: 'NOT_APPLICABLE', rowCount: 0 };
  }

  ensureControlTables(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const sourceRows = db
      .prepare(
        'SELECT "id", "action", "resourceId", "actorId", "resolverId", "status", "context", "createdAt" FROM "AuditLog" ORDER BY "id"'
      )
      .all() as SqlRow[];
    let stagedRows = db
      .prepare(`SELECT "id", "rowJson", "checksum" FROM "${STAGE_TABLE}" ORDER BY "id"`)
      .all() as Array<{ id: string; rowJson: string; checksum: string }>;
    for (const staged of stagedRows) {
      if (checksum(staged.rowJson) !== staged.checksum) {
        throw new Error('Legacy AuditLog staging integrity validation failed');
      }
    }
    if (sourceRows.length > 0 && stagedRows.length === 0) {
      const insert = db.prepare(
        `INSERT INTO "${STAGE_TABLE}" ("id", "rowJson", "checksum", "stagedAt") VALUES (?, ?, ?, ?)`
      );
      const now = new Date().toISOString();
      for (const row of sourceRows) {
        const rowJson = canonicalize(row);
        insert.run(String(row.id), rowJson, checksum(rowJson), now);
      }
      stagedRows = db
        .prepare(`SELECT "id", "rowJson", "checksum" FROM "${STAGE_TABLE}" ORDER BY "id"`)
        .all() as Array<{ id: string; rowJson: string; checksum: string }>;
    }
    const sourceAnchors = sourceRows.map((row) => {
      const rowJson = canonicalize(row);
      return { id: String(row.id), checksum: checksum(rowJson) };
    });
    const sourceAggregate = aggregateChecksum(sourceAnchors);
    if (
      (stagedRows.length !== sourceRows.length && sourceRows.length > 0) ||
      (sourceRows.length > 0 && aggregateChecksum(stagedRows) !== sourceAggregate)
    ) {
      throw new Error('Legacy AuditLog staging count validation failed');
    }

    if (sourceRows.length > 0) db.exec('DELETE FROM "AuditLog"');
    const remaining = db.prepare('SELECT count(*) AS "count" FROM "AuditLog"').get() as {
      count: number;
    };
    if (Number(remaining.count) !== 0) {
      throw new Error('Legacy AuditLog source clear validation failed');
    }
    db.exec('COMMIT');
    return {
      state: 'STAGED',
      rowCount: stagedRows.length,
      aggregateChecksum: aggregateChecksum(stagedRows),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function outcomeCode(status: SqlValue): 'SUCCESS' | 'DENIED' | 'FAILURE' {
  const normalized = String(status ?? '').toUpperCase();
  if (normalized === 'SUCCESS' || normalized === 'APPROVED') return 'SUCCESS';
  if (normalized === 'DENIED') return 'DENIED';
  return 'FAILURE';
}

function integrityKey(): { id: string; key: Buffer } {
  const value = process.env.AUDIT_INTEGRITY_KEY;
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('AUDIT_INTEGRITY_KEY is required to restore staged legacy AuditLog rows');
  }
  return {
    id: process.env.AUDIT_INTEGRITY_KEY_ID || 'audit-v1',
    key: Buffer.from(value, 'hex'),
  };
}

/** Restore staged rows into the final v2 envelope and remove raw staging only after verification. */
export function restoreLegacyAuditLogs(db: DatabaseSync): LegacyAuditUpgradeResult {
  const complete = completedManifest(db);
  if (complete) {
    verifyCompletedRestore(db, complete);
    return {
      state: 'ALREADY_COMPLETE',
      rowCount: complete.rowCount,
      aggregateChecksum: complete.sourceAggregateChecksum,
    };
  }
  const auditColumns = columns(db, 'AuditLog');
  if (!auditColumns.has('eventFamily') || !tableExists(db, STAGE_TABLE)) {
    return { state: 'NOT_APPLICABLE', rowCount: 0 };
  }

  const stagedRows = db
    .prepare(`SELECT "id", "rowJson", "checksum" FROM "${STAGE_TABLE}" ORDER BY "id"`)
    .all() as Array<{ id: string; rowJson: string; checksum: string }>;
  const aggregate = aggregateChecksum(stagedRows);
  const integrity = integrityKey();
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`
      INSERT INTO "AuditLog" (
        "id", "schemaVersion", "eventFamily", "eventType", "surface", "operation",
        "outcomeCode", "decisionCode", "reasonCode", "targetType", "targetId",
        "authoritySources", "actorType", "principalId", "actorId", "authKind",
        "resolverType", "resolverId", "resourceId", "retentionClass", "integrityKeyId",
        "integrityHash", "payload", "createdAt"
      ) VALUES (?, 2, 'LEGACY', ?, 'SYSTEM', 'legacy.import', ?, 'ALLOW', 'SERVICE', ?, ?,
        '[]', 'SERVICE', ?, ?, 'SERVICE', ?, ?, ?, 'SECURITY', ?, ?, ?, ?)
    `);
    for (const staged of stagedRows) {
      if (checksum(staged.rowJson) !== staged.checksum) {
        throw new Error('Legacy AuditLog staging integrity validation failed');
      }
      const row = JSON.parse(staged.rowJson) as SqlRow;
      const targetType = row.resourceId ? 'RESOURCE' : 'SYSTEM';
      const targetId = row.resourceId ? String(row.resourceId) : null;
      // Preserve legacy meaning and attribution, but never copy untyped legacy context into the
      // v2 payload. Raw staging is retained until every transformed row is verified below.
      const payload = {
        legacyStatus: String(row.status ?? 'UNKNOWN'),
        legacyResolverPresent: Boolean(row.resolverId),
        legacyContextDiscarded: row.context !== null,
        originalChecksum: staged.checksum,
      };
      const eventType = String(row.action ?? 'LEGACY_EVENT');
      const actorId = row.actorId === null ? null : String(row.actorId);
      const resolverId = row.resolverId === null ? null : String(row.resolverId);
      const resourceId = row.resourceId === null ? null : String(row.resourceId);
      const createdAt = String(row.createdAt);
      const unsigned = {
        id: staged.id,
        schemaVersion: 2,
        eventFamily: 'LEGACY',
        eventType,
        surface: 'SYSTEM',
        operation: 'legacy.import',
        outcomeCode: outcomeCode(row.status),
        capability: null,
        decisionCode: 'ALLOW',
        reasonCode: 'SERVICE',
        targetType,
        targetId,
        authoritySources: [],
        actorType: 'SERVICE',
        principalId: `legacy:${staged.id}`,
        actorId,
        authKind: 'SERVICE',
        resolverType: resolverId ? 'DISCORD_USER' : null,
        resolverId,
        resourceId,
        projectId: null,
        environmentId: null,
        requestId: null,
        grantId: null,
        correlationId: null,
        causationId: null,
        statusCode: null,
        durationMs: null,
        retentionClass: 'SECURITY',
        integrityKeyId: integrity.id,
        payload,
        createdAt,
      };
      const signature = createHmac('sha256', integrity.key)
        .update(canonicalize(unsigned))
        .digest('hex');
      insert.run(
        staged.id,
        eventType,
        unsigned.outcomeCode,
        targetType,
        targetId,
        unsigned.principalId,
        actorId,
        resolverId ? 'DISCORD_USER' : null,
        resolverId,
        resourceId,
        integrity.id,
        signature,
        canonicalize(payload),
        createdAt
      );
    }

    const restored = db
      .prepare(
        `SELECT count(*) AS "count" FROM "AuditLog" WHERE "id" IN (SELECT "id" FROM "${STAGE_TABLE}")`
      )
      .get() as { count: number };
    if (Number(restored.count) !== stagedRows.length) {
      throw new Error('Legacy AuditLog restore count validation failed');
    }
    const restoredRows = db
      .prepare(
        `SELECT * FROM "AuditLog" WHERE "id" IN (SELECT "id" FROM "${STAGE_TABLE}") ORDER BY "id"`
      )
      .all() as SqlRow[];
    const restoredAnchors = restoredRows.map((row) => ({
      id: String(row.id),
      integrityHash: String(row.integrityHash),
      transformedChecksum: checksum(canonicalize(row)),
    }));
    const transformedAggregate = aggregateChecksum(
      restoredAnchors.map(({ id, integrityHash }) => ({ id, checksum: integrityHash }))
    );
    const anchorInsert = db.prepare(
      `INSERT INTO "${ANCHOR_TABLE}" ("id", "sourceChecksum", "transformedChecksum", "integrityHash", "integrityKeyId", "anchorHash") VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const staged of stagedRows) {
      const restoredAnchor = restoredAnchors.find(({ id }) => id === staged.id);
      if (!restoredAnchor) throw new Error('Legacy AuditLog transformed anchor missing');
      const anchor = {
        id: staged.id,
        sourceChecksum: staged.checksum,
        transformedChecksum: restoredAnchor.transformedChecksum,
        integrityHash: restoredAnchor.integrityHash,
        integrityKeyId: integrity.id,
      };
      anchorInsert.run(
        anchor.id,
        anchor.sourceChecksum,
        anchor.transformedChecksum,
        anchor.integrityHash,
        anchor.integrityKeyId,
        createHmac('sha256', integrity.key).update(canonicalize(anchor)).digest('hex')
      );
    }
    const manifest = {
      migration: MIGRATION,
      rowCount: stagedRows.length,
      sourceAggregateChecksum: aggregate,
      transformedAggregateChecksum: transformedAggregate,
      integrityKeyId: integrity.id,
      completedAt: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO "${MANIFEST_TABLE}" ("migration", "rowCount", "sourceAggregateChecksum", "transformedAggregateChecksum", "integrityKeyId", "manifestHash", "completedAt") VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      manifest.migration,
      manifest.rowCount,
      manifest.sourceAggregateChecksum,
      manifest.transformedAggregateChecksum,
      manifest.integrityKeyId,
      createHmac('sha256', integrity.key).update(canonicalize(manifest)).digest('hex'),
      manifest.completedAt
    );
    db.exec(`DELETE FROM "${STAGE_TABLE}"`);
    const retained = db.prepare(`SELECT count(*) AS "count" FROM "${STAGE_TABLE}"`).get() as {
      count: number;
    };
    if (Number(retained.count) !== 0) {
      throw new Error('Legacy AuditLog staging cleanup validation failed');
    }
    db.exec('COMMIT');
    return { state: 'RESTORED', rowCount: stagedRows.length, aggregateChecksum: aggregate };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function verifyCompletedRestore(
  db: DatabaseSync,
  manifest: NonNullable<ReturnType<typeof completedManifest>>
): void {
  if (!tableExists(db, ANCHOR_TABLE) || !tableExists(db, 'AuditLog')) {
    throw new Error('Legacy AuditLog completion anchors are missing');
  }
  const anchors = db
    .prepare(
      `SELECT "id", "sourceChecksum", "transformedChecksum", "integrityHash", "integrityKeyId", "anchorHash" FROM "${ANCHOR_TABLE}" ORDER BY "id"`
    )
    .all() as Array<{
    id: string;
    sourceChecksum: string;
    transformedChecksum: string;
    integrityHash: string;
    integrityKeyId: string;
    anchorHash: string;
  }>;
  const integrity = integrityKey();
  const unsignedManifest = {
    migration: MIGRATION,
    rowCount: manifest.rowCount,
    sourceAggregateChecksum: manifest.sourceAggregateChecksum,
    transformedAggregateChecksum: manifest.transformedAggregateChecksum,
    integrityKeyId: manifest.integrityKeyId,
    completedAt: manifest.completedAt,
  };
  if (
    manifest.integrityKeyId !== integrity.id ||
    createHmac('sha256', integrity.key).update(canonicalize(unsignedManifest)).digest('hex') !==
      manifest.manifestHash
  ) {
    throw new Error('Legacy AuditLog completion manifest integrity validation failed');
  }
  for (const anchor of anchors) {
    const { anchorHash, ...unsignedAnchor } = anchor;
    if (
      anchor.integrityKeyId !== integrity.id ||
      createHmac('sha256', integrity.key).update(canonicalize(unsignedAnchor)).digest('hex') !==
        anchorHash
    ) {
      throw new Error('Legacy AuditLog completion anchor integrity validation failed');
    }
  }
  if (anchors.length !== manifest.rowCount) {
    throw new Error('Legacy AuditLog completed row count validation failed');
  }
  if (
    aggregateChecksum(
      anchors.map(({ id, sourceChecksum }) => ({ id, checksum: sourceChecksum }))
    ) !== manifest.sourceAggregateChecksum
  ) {
    throw new Error('Legacy AuditLog completed source anchor validation failed');
  }
  const rawRows = db
    .prepare(
      `SELECT * FROM "AuditLog" WHERE "id" IN (SELECT "id" FROM "${ANCHOR_TABLE}") ORDER BY "id"`
    )
    .all() as SqlRow[];
  for (const rawRow of rawRows) {
    const integrityHash = String(rawRow.integrityHash);
    const unsigned = { ...rawRow };
    delete unsigned.integrityHash;
    unsigned.authoritySources = JSON.parse(String(unsigned.authoritySources)) as never;
    unsigned.payload = JSON.parse(String(unsigned.payload)) as never;
    const expected = createHmac('sha256', integrity.key)
      .update(canonicalize(unsigned))
      .digest('hex');
    if (integrityHash !== expected) {
      throw new Error('Legacy AuditLog completed event integrity validation failed');
    }
  }
  const rows = rawRows.map((row) => ({
    id: String(row.id),
    integrityKeyId: String(row.integrityKeyId),
    integrityHash: String(row.integrityHash),
    transformedChecksum: checksum(canonicalize(row)),
  }));
  if (
    rows.length !== manifest.rowCount ||
    rows.some((row) => row.integrityKeyId !== manifest.integrityKeyId) ||
    rows.some(
      (row) => anchors.find(({ id }) => id === row.id)?.integrityHash !== row.integrityHash
    ) ||
    rows.some(
      (row) =>
        anchors.find(({ id }) => id === row.id)?.transformedChecksum !== row.transformedChecksum
    ) ||
    aggregateChecksum(rows.map(({ id, integrityHash }) => ({ id, checksum: integrityHash }))) !==
      manifest.transformedAggregateChecksum
  ) {
    throw new Error('Legacy AuditLog completed transformed anchor validation failed');
  }
}

export const legacyAuditUpgradeInternals = { STAGE_TABLE, MANIFEST_TABLE, ANCHOR_TABLE, MIGRATION };
