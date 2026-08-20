-- Credential lifecycle cutover.
--
-- Existing Resource.apiKey, ApiToken, AuthSession, and provisional Credential values are
-- intentionally invalidated. Plaintext legacy Resource keys are never copied into the canonical
-- schema; operators must issue replacements after deployment.

PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS "ApiToken";

DROP TABLE "AuthSession";
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceCode" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "userId" TEXT,
    "approvalAttempts" INTEGER NOT NULL DEFAULT 0,
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" DATETIME,
    "consumedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AuthSession_deviceCode_key" ON "AuthSession"("deviceCode");
CREATE UNIQUE INDEX "AuthSession_userCode_key" ON "AuthSession"("userCode");
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

DROP TABLE "Credential";
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "digestKeyId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    "lastUsedAt" DATETIME,
    "version" TEXT NOT NULL
);
CREATE UNIQUE INDEX "Credential_digest_key" ON "Credential"("digest");
CREATE INDEX "Credential_subjectId_type_idx" ON "Credential"("subjectId", "type");
CREATE INDEX "Credential_targetType_targetId_idx" ON "Credential"("targetType", "targetId");
CREATE INDEX "Credential_revokedAt_idx" ON "Credential"("revokedAt");
CREATE INDEX "Credential_digest_idx" ON "Credential"("digest");

CREATE TABLE "new_Resource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ONE_OF_N',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totpAccountId" TEXT,
    "totpDelegationEnvelope" JSONB,
    "version" TEXT NOT NULL,
    "totpLinkVersion" TEXT NOT NULL,
    CONSTRAINT "Resource_totpAccountId_fkey" FOREIGN KEY ("totpAccountId")
      REFERENCES "TOTPAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Resource"
  ("id", "name", "mode", "createdAt", "totpAccountId", "totpDelegationEnvelope",
   "version", "totpLinkVersion")
SELECT "id", "name", "mode", "createdAt", "totpAccountId", "totpDelegationEnvelope",
       "version", "totpLinkVersion"
FROM "Resource";
DROP TABLE "Resource";
ALTER TABLE "new_Resource" RENAME TO "Resource";
CREATE UNIQUE INDEX "Resource_totpAccountId_key" ON "Resource"("totpAccountId");

PRAGMA foreign_keys=ON;
