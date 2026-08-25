-- Outbox leases and callback destinations hardening migration.
--
-- Persists:
-- - Outbox event atomic leasing (claimedAt, claimExpiresAt, claimedBy, nextRetryAt)
-- - Targeted delivery routing (destinationId, recipientId, deliveryId)
-- - Owner-managed CallbackDestination (status, keyId, encryptedSecret, verificationToken, verificationChallengeExpiresAt, verifiedAt, name, projectId)
-- - Disables legacy plaintext callback destinations safely upon migration

PRAGMA foreign_keys=OFF;

-- 1. Migrate OutboxEvent
CREATE TABLE "new_OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "eventType" TEXT NOT NULL,
    "resourceId" TEXT,
    "requestId" TEXT,
    "destinationId" TEXT,
    "recipientId" TEXT,
    "deliveryId" TEXT,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "integrityKeyId" TEXT NOT NULL,
    "integrityHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "claimedAt" DATETIME,
    "claimExpiresAt" DATETIME,
    "claimedBy" TEXT,
    "nextRetryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_OutboxEvent" (
    "id", "schemaVersion", "eventType", "resourceId", "requestId",
    "correlationId", "causationId", "integrityKeyId", "integrityHash",
    "payload", "status", "attempts", "lastErrorCode", "createdAt", "updatedAt"
)
SELECT
    "id", "schemaVersion", "eventType", "resourceId", "requestId",
    "correlationId", "causationId", "integrityKeyId", "integrityHash",
    "payload", "status", "attempts", "lastErrorCode", "createdAt", "updatedAt"
FROM "OutboxEvent";

DROP TABLE "OutboxEvent";
ALTER TABLE "new_OutboxEvent" RENAME TO "OutboxEvent";

CREATE INDEX "OutboxEvent_status_claimExpiresAt_idx" ON "OutboxEvent"("status", "claimExpiresAt");
CREATE INDEX "OutboxEvent_nextRetryAt_idx" ON "OutboxEvent"("nextRetryAt");
CREATE UNIQUE INDEX "OutboxEvent_deliveryId_key" ON "OutboxEvent"("deliveryId");
CREATE INDEX "OutboxEvent_status_idx" ON "OutboxEvent"("status");
CREATE INDEX "OutboxEvent_resourceId_idx" ON "OutboxEvent"("resourceId");
CREATE INDEX "OutboxEvent_requestId_idx" ON "OutboxEvent"("requestId");
CREATE INDEX "OutboxEvent_correlationId_idx" ON "OutboxEvent"("correlationId");
CREATE INDEX "OutboxEvent_createdAt_idx" ON "OutboxEvent"("createdAt");

-- 2. Migrate CallbackDestination
CREATE TABLE "new_CallbackDestination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "keyId" TEXT NOT NULL DEFAULT 'default',
    "encryptedSecret" TEXT NOT NULL,
    "verificationToken" TEXT,
    "verificationChallengeExpiresAt" DATETIME,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CallbackDestination_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_CallbackDestination" (
    "id", "resourceId", "url", "status", "keyId", "encryptedSecret", "createdAt", "updatedAt"
)
SELECT
    "id", "resourceId", "url", 'DISABLED', 'legacy-redacted', 'REDACTED_LEGACY_PLAINTEXT_ROTATION_REQUIRED', "createdAt", "updatedAt"
FROM "CallbackDestination";

DROP TABLE "CallbackDestination";
ALTER TABLE "new_CallbackDestination" RENAME TO "CallbackDestination";

CREATE INDEX "CallbackDestination_resourceId_status_idx" ON "CallbackDestination"("resourceId", "status");
CREATE INDEX "CallbackDestination_projectId_status_idx" ON "CallbackDestination"("projectId", "status");
CREATE INDEX "CallbackDestination_resourceId_idx" ON "CallbackDestination"("resourceId");

PRAGMA foreign_keys=ON;
