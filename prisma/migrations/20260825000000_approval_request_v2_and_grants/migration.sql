-- Approval Request V2 and immutable grants migration.
--
-- Persists typed security dimensions for ApprovalRequest and ApprovalGrant:
-- - project/environment/target scoping
-- - canonical key sets and digests
-- - auth family and audience bindings
-- - idempotency key and payload digest
-- - resolver evidence and explicit cancellation
-- - safe invalidation of legacy unconsumed grants

PRAGMA foreign_keys=OFF;

-- 1. Migrate ApprovalRequest
CREATE TABLE "new_ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "projectId" TEXT,
    "environmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "context" JSONB,
    "requesterId" TEXT NOT NULL DEFAULT 'legacy',
    "requesterType" TEXT NOT NULL DEFAULT 'DISCORD_USER',
    "authKind" TEXT NOT NULL DEFAULT 'DISCORD',
    "authFamily" TEXT NOT NULL DEFAULT 'DISCORD',
    "audience" TEXT NOT NULL DEFAULT 'purrmission-bot',
    "action" TEXT NOT NULL DEFAULT 'resource.view',
    "targetType" TEXT NOT NULL DEFAULT 'RESOURCE',
    "targetId" TEXT,
    "targetKey" TEXT,
    "canonicalKeySet" JSONB,
    "canonicalKeyDigest" TEXT,
    "targetVersion" TEXT NOT NULL DEFAULT 'legacy',
    "policyVersion" TEXT NOT NULL DEFAULT 'legacy',
    "reason" TEXT,
    "constraints" TEXT,
    "callbackUrl" TEXT,
    "idempotencyKey" TEXT,
    "payloadDigest" TEXT,
    "deliveryState" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedByType" TEXT,
    "resolvedAt" DATETIME,
    "cancelledBy" TEXT,
    "cancelledAt" DATETIME,
    "discordMessageId" TEXT,
    "discordChannelId" TEXT,
    CONSTRAINT "ApprovalRequest_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ApprovalRequest" (
    "id", "resourceId", "status", "context", "requesterId", "requesterType",
    "authKind", "authFamily", "audience", "action", "targetType", "targetKey",
    "targetVersion", "policyVersion", "constraints", "callbackUrl",
    "createdAt", "expiresAt", "resolvedBy", "resolvedAt",
    "discordMessageId", "discordChannelId", "deliveryState"
)
SELECT
    "id", "resourceId", "status", "context", "requesterId", "requesterType",
    "authKind",
    CASE WHEN "authKind" = 'PAWTHY' THEN 'PAWTHY_CLI' WHEN "authKind" = 'API_KEY' THEN 'RESOURCE_KEY' WHEN "authKind" = 'SERVICE' THEN 'SERVICE' ELSE 'DISCORD' END,
    'purrmission-bot',
    "action",
    'RESOURCE',
    "targetKey",
    "targetVersion",
    "policyVersion",
    "constraints",
    "callbackUrl",
    "createdAt",
    "expiresAt",
    "resolvedBy",
    "resolvedAt",
    "discordMessageId",
    "discordChannelId",
    'PENDING'
FROM "ApprovalRequest";

DROP TABLE "ApprovalRequest";
ALTER TABLE "new_ApprovalRequest" RENAME TO "ApprovalRequest";

CREATE INDEX "ApprovalRequest_resourceId_idx" ON "ApprovalRequest"("resourceId");
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");
CREATE INDEX "ApprovalRequest_requesterId_idx" ON "ApprovalRequest"("requesterId");
CREATE INDEX "ApprovalRequest_expiresAt_idx" ON "ApprovalRequest"("expiresAt");
CREATE INDEX "ApprovalRequest_idempotencyKey_idx" ON "ApprovalRequest"("idempotencyKey");
CREATE INDEX "ApprovalRequest_canonicalKeyDigest_idx" ON "ApprovalRequest"("canonicalKeyDigest");
CREATE INDEX "ApprovalRequest_targetType_targetId_idx" ON "ApprovalRequest"("targetType", "targetId");

-- 2. Migrate ApprovalGrant
CREATE TABLE "new_ApprovalGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "projectId" TEXT,
    "environmentId" TEXT,
    "requesterId" TEXT NOT NULL,
    "requesterType" TEXT NOT NULL,
    "authKind" TEXT NOT NULL,
    "authFamily" TEXT NOT NULL DEFAULT 'DISCORD',
    "audience" TEXT NOT NULL DEFAULT 'purrmission-bot',
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT 'RESOURCE',
    "targetId" TEXT,
    "targetKey" TEXT,
    "canonicalKeySet" JSONB,
    "canonicalKeyDigest" TEXT,
    "targetVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "constraints" TEXT,
    "resolverId" TEXT NOT NULL DEFAULT 'system',
    "resolverType" TEXT NOT NULL DEFAULT 'DISCORD_USER',
    "resolverEvidence" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedReason" TEXT
);

INSERT INTO "new_ApprovalGrant" (
    "id", "requestId", "resourceId", "requesterId", "requesterType",
    "authKind", "authFamily", "audience", "action", "targetType", "targetKey",
    "targetVersion", "policyVersion", "constraints", "createdAt",
    "expiresAt", "consumedAt", "revokedAt", "revokedReason"
)
SELECT
    "id", "requestId", "resourceId", "requesterId", "requesterType",
    "authKind",
    CASE WHEN "authKind" = 'PAWTHY' THEN 'PAWTHY_CLI' WHEN "authKind" = 'API_KEY' THEN 'RESOURCE_KEY' WHEN "authKind" = 'SERVICE' THEN 'SERVICE' ELSE 'DISCORD' END,
    'purrmission-bot',
    "action",
    'RESOURCE',
    "targetKey",
    "targetVersion",
    "policyVersion",
    "constraints",
    "createdAt",
    "expiresAt",
    "consumedAt",
    COALESCE("revokedAt", CURRENT_TIMESTAMP),
    CASE WHEN "revokedAt" IS NOT NULL THEN NULL ELSE 'LEGACY_MIGRATION_INVALIDATED' END
FROM "ApprovalGrant";

DROP TABLE "ApprovalGrant";
ALTER TABLE "new_ApprovalGrant" RENAME TO "ApprovalGrant";

CREATE UNIQUE INDEX "ApprovalGrant_requestId_key" ON "ApprovalGrant"("requestId");
CREATE INDEX "ApprovalGrant_resourceId_idx" ON "ApprovalGrant"("resourceId");
CREATE INDEX "ApprovalGrant_requesterId_idx" ON "ApprovalGrant"("requesterId");
CREATE INDEX "ApprovalGrant_expiresAt_idx" ON "ApprovalGrant"("expiresAt");
CREATE INDEX "ApprovalGrant_canonicalKeyDigest_idx" ON "ApprovalGrant"("canonicalKeyDigest");

PRAGMA foreign_keys=ON;
