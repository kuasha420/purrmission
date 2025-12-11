-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ONE_OF_N',
    "apiKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Guardian" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'GUARDIAN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Guardian_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "context" JSONB NOT NULL,
    "callbackUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    CONSTRAINT "ApprovalRequest_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TOTPAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerDiscordUserId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "issuer" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Resource_apiKey_idx" ON "Resource"("apiKey");

-- CreateIndex
CREATE INDEX "Guardian_resourceId_idx" ON "Guardian"("resourceId");

-- CreateIndex
CREATE INDEX "Guardian_discordUserId_idx" ON "Guardian"("discordUserId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_resourceId_idx" ON "ApprovalRequest"("resourceId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");

-- CreateIndex
CREATE INDEX "TOTPAccount_ownerDiscordUserId_idx" ON "TOTPAccount"("ownerDiscordUserId");

-- CreateIndex
CREATE INDEX "TOTPAccount_shared_idx" ON "TOTPAccount"("shared");

-- CreateIndex
CREATE UNIQUE INDEX "TOTPAccount_ownerDiscordUserId_accountName_key" ON "TOTPAccount"("ownerDiscordUserId", "accountName");
