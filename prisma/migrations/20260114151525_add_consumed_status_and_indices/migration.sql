-- CreateIndex
CREATE INDEX "ApiToken_expiresAt_idx" ON "ApiToken"("expiresAt");

-- CreateIndex
CREATE INDEX "ApiToken_lastUsedAt_idx" ON "ApiToken"("lastUsedAt");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
