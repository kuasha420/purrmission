-- CreateTable
CREATE TABLE "ApprovalGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requesterType" TEXT NOT NULL,
    "authKind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetKey" TEXT,
    "targetVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "constraints" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "revokedAt" DATETIME
);

-- CreateTable
CREATE TABLE "TOTPLinkConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "ownerDiscordUserId" TEXT NOT NULL,
    "delegationPolicy" JSONB NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TOTPDelegationConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "totpAccountId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "authFamily" TEXT NOT NULL,
    "accountVersion" TEXT NOT NULL,
    "linkVersion" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "version" TEXT NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "context" JSONB,
    "requesterId" TEXT NOT NULL DEFAULT 'legacy',
    "requesterType" TEXT NOT NULL DEFAULT 'DISCORD_USER',
    "authKind" TEXT NOT NULL DEFAULT 'DISCORD',
    "action" TEXT NOT NULL DEFAULT 'resource.view',
    "targetKey" TEXT,
    "targetVersion" TEXT NOT NULL DEFAULT 'legacy',
    "policyVersion" TEXT NOT NULL DEFAULT 'legacy',
    "constraints" TEXT,
    "callbackUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "discordMessageId" TEXT,
    "discordChannelId" TEXT,
    CONSTRAINT "ApprovalRequest_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ApprovalRequest" ("callbackUrl", "context", "createdAt", "discordChannelId", "discordMessageId", "expiresAt", "id", "resolvedAt", "resolvedBy", "resourceId", "status") SELECT "callbackUrl", "context", "createdAt", "discordChannelId", "discordMessageId", coalesce("expiresAt", CURRENT_TIMESTAMP) AS "expiresAt", "id", "resolvedAt", "resolvedBy", "resourceId", "status" FROM "ApprovalRequest";
DROP TABLE "ApprovalRequest";
ALTER TABLE "new_ApprovalRequest" RENAME TO "ApprovalRequest";
CREATE INDEX "ApprovalRequest_resourceId_idx" ON "ApprovalRequest"("resourceId");
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");
CREATE INDEX "ApprovalRequest_requesterId_idx" ON "ApprovalRequest"("requesterId");
CREATE TABLE "new_AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "eventType" TEXT NOT NULL,
    "outcomeCode" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "authKind" TEXT,
    "resourceId" TEXT,
    "projectId" TEXT,
    "environmentId" TEXT,
    "requestId" TEXT,
    "grantId" TEXT,
    "correlationId" TEXT,
    "causationId" TEXT,
    "payload" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_AuditLog" ("actorId", "createdAt", "id", "resourceId") SELECT "actorId", "createdAt", "id", "resourceId" FROM "AuditLog";
DROP TABLE "AuditLog";
ALTER TABLE "new_AuditLog" RENAME TO "AuditLog";
CREATE INDEX "AuditLog_resourceId_idx" ON "AuditLog"("resourceId");
CREATE INDEX "AuditLog_projectId_idx" ON "AuditLog"("projectId");
CREATE INDEX "AuditLog_eventType_idx" ON "AuditLog"("eventType");
CREATE INDEX "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("createdAt", "description", "id", "name", "ownerId", "updatedAt") SELECT "createdAt", "description", "id", "name", "ownerId", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");
CREATE TABLE "new_Resource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ONE_OF_N',
    "apiKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totpAccountId" TEXT,
    "totpDelegationEnvelope" JSONB,
    "version" TEXT NOT NULL,
    CONSTRAINT "Resource_totpAccountId_fkey" FOREIGN KEY ("totpAccountId") REFERENCES "TOTPAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Resource" ("apiKey", "createdAt", "id", "mode", "name", "totpAccountId") SELECT "apiKey", "createdAt", "id", "mode", "name", "totpAccountId" FROM "Resource";
DROP TABLE "Resource";
ALTER TABLE "new_Resource" RENAME TO "Resource";
CREATE UNIQUE INDEX "Resource_totpAccountId_key" ON "Resource"("totpAccountId");
CREATE INDEX "Resource_apiKey_idx" ON "Resource"("apiKey");
CREATE TABLE "new_TOTPAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerDiscordUserId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "issuer" TEXT,
    "backupKey" TEXT,
    "version" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_TOTPAccount" ("accountName", "backupKey", "createdAt", "id", "issuer", "ownerDiscordUserId", "secret", "updatedAt") SELECT "accountName", "backupKey", "createdAt", "id", "issuer", "ownerDiscordUserId", "secret", "updatedAt" FROM "TOTPAccount";
DROP TABLE "TOTPAccount";
ALTER TABLE "new_TOTPAccount" RENAME TO "TOTPAccount";
CREATE INDEX "TOTPAccount_ownerDiscordUserId_idx" ON "TOTPAccount"("ownerDiscordUserId");
CREATE UNIQUE INDEX "TOTPAccount_ownerDiscordUserId_accountName_key" ON "TOTPAccount"("ownerDiscordUserId", "accountName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalGrant_requestId_key" ON "ApprovalGrant"("requestId");

-- CreateIndex
CREATE INDEX "ApprovalGrant_resourceId_idx" ON "ApprovalGrant"("resourceId");

-- CreateIndex
CREATE INDEX "ApprovalGrant_requesterId_idx" ON "ApprovalGrant"("requesterId");

-- CreateIndex
CREATE INDEX "ApprovalGrant_expiresAt_idx" ON "ApprovalGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "TOTPLinkConsent_accountId_idx" ON "TOTPLinkConsent"("accountId");

-- CreateIndex
CREATE INDEX "TOTPLinkConsent_resourceId_idx" ON "TOTPLinkConsent"("resourceId");

-- CreateIndex
CREATE INDEX "TOTPDelegationConsent_resourceId_idx" ON "TOTPDelegationConsent"("resourceId");

-- CreateIndex
CREATE INDEX "TOTPDelegationConsent_totpAccountId_idx" ON "TOTPDelegationConsent"("totpAccountId");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_idx" ON "OutboxEvent"("status");

-- CreateIndex
CREATE INDEX "OutboxEvent_createdAt_idx" ON "OutboxEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_digest_key" ON "Credential"("digest");

-- CreateIndex
CREATE INDEX "Credential_subjectId_idx" ON "Credential"("subjectId");

-- CreateIndex
CREATE INDEX "Credential_digest_idx" ON "Credential"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "Guardian_resourceId_discordUserId_key" ON "Guardian"("resourceId", "discordUserId");
