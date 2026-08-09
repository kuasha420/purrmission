-- Issue #118 forward-only remediation. Do not modify published migrations.
-- The composed deploy wrapper must stage populated legacy rows before Prisma applies the
-- published 20260724110200 migration and restore them after this migration is applied.

ALTER TABLE "AuditLog" ADD COLUMN "eventFamily" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "AuditLog" ADD COLUMN "surface" TEXT NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "AuditLog" ADD COLUMN "operation" TEXT NOT NULL DEFAULT 'legacy.import';
ALTER TABLE "AuditLog" ADD COLUMN "capability" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "decisionCode" TEXT NOT NULL DEFAULT 'ALLOW';
ALTER TABLE "AuditLog" ADD COLUMN "reasonCode" TEXT NOT NULL DEFAULT 'SERVICE';
ALTER TABLE "AuditLog" ADD COLUMN "targetType" TEXT NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "AuditLog" ADD COLUMN "targetId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "authoritySources" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AuditLog" ADD COLUMN "principalId" TEXT NOT NULL DEFAULT 'legacy-import';
ALTER TABLE "AuditLog" ADD COLUMN "resolverType" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "resolverId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "statusCode" INTEGER;
ALTER TABLE "AuditLog" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "AuditLog" ADD COLUMN "retentionClass" TEXT NOT NULL DEFAULT 'SECURITY';
ALTER TABLE "AuditLog" ADD COLUMN "integrityKeyId" TEXT NOT NULL DEFAULT 'legacy-unverified';
ALTER TABLE "AuditLog" ADD COLUMN "integrityHash" TEXT NOT NULL DEFAULT 'legacy-unverified';

CREATE INDEX "AuditLog_eventFamily_idx" ON "AuditLog"("eventFamily");
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");
CREATE INDEX "AuditLog_grantId_idx" ON "AuditLog"("grantId");

CREATE TABLE "AuditCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "previousDigest" TEXT,
    "eventDigest" TEXT NOT NULL,
    "checkpointHash" TEXT NOT NULL,
    "integrityKeyId" TEXT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "throughId" TEXT NOT NULL,
    "throughCreatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL
);
CREATE INDEX "AuditCheckpoint_createdAt_idx" ON "AuditCheckpoint"("createdAt");
CREATE INDEX "AuditCheckpoint_throughCreatedAt_idx" ON "AuditCheckpoint"("throughCreatedAt");

-- Replace the free-form lastError column with a non-secret error code while preserving queued
-- events. Untyped legacy payloads are discarded rather than copied across the trust boundary.
-- Legacy events are quarantined from delivery and require explicit #123 operator reconciliation.
CREATE TABLE "new_OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "eventType" TEXT NOT NULL,
    "resourceId" TEXT,
    "requestId" TEXT,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "integrityKeyId" TEXT NOT NULL,
    "integrityHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_OutboxEvent" (
    "id", "schemaVersion", "eventType", "correlationId", "integrityKeyId", "integrityHash",
    "payload", "status", "attempts", "lastErrorCode", "createdAt", "updatedAt"
)
SELECT
    "id", 1, "eventType", 'legacy-unattributed', 'legacy-unverified', 'legacy-unverified',
    json_object('legacyPayloadDiscarded', true), 'FAILED', "attempts", 'LEGACY_UNVERIFIED',
    "createdAt", "updatedAt"
FROM "OutboxEvent";
DROP TABLE "OutboxEvent";
ALTER TABLE "new_OutboxEvent" RENAME TO "OutboxEvent";

CREATE INDEX "OutboxEvent_status_idx" ON "OutboxEvent"("status");
CREATE INDEX "OutboxEvent_createdAt_idx" ON "OutboxEvent"("createdAt");
CREATE INDEX "OutboxEvent_resourceId_idx" ON "OutboxEvent"("resourceId");
CREATE INDEX "OutboxEvent_requestId_idx" ON "OutboxEvent"("requestId");
CREATE INDEX "OutboxEvent_correlationId_idx" ON "OutboxEvent"("correlationId");
