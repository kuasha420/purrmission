-- CreateTable
CREATE TABLE "ResourceField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResourceField_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ResourceField_resourceId_idx" ON "ResourceField"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceField_resourceId_name_key" ON "ResourceField"("resourceId", "name");
