-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Resource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ONE_OF_N',
    "apiKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totpAccountId" TEXT,
    CONSTRAINT "Resource_totpAccountId_fkey" FOREIGN KEY ("totpAccountId") REFERENCES "TOTPAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Resource" ("apiKey", "createdAt", "id", "mode", "name") SELECT "apiKey", "createdAt", "id", "mode", "name" FROM "Resource";
DROP TABLE "Resource";
ALTER TABLE "new_Resource" RENAME TO "Resource";
CREATE UNIQUE INDEX "Resource_totpAccountId_key" ON "Resource"("totpAccountId");
CREATE INDEX "Resource_apiKey_idx" ON "Resource"("apiKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
