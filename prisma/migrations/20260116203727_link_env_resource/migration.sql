-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "resourceId" TEXT,
    CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Environment_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Environment" ("createdAt", "id", "name", "projectId", "slug", "updatedAt") SELECT "createdAt", "id", "name", "projectId", "slug", "updatedAt" FROM "Environment";
DROP TABLE "Environment";
ALTER TABLE "new_Environment" RENAME TO "Environment";
CREATE UNIQUE INDEX "Environment_resourceId_key" ON "Environment"("resourceId");
CREATE INDEX "Environment_projectId_idx" ON "Environment"("projectId");
CREATE UNIQUE INDEX "Environment_projectId_slug_key" ON "Environment"("projectId", "slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
