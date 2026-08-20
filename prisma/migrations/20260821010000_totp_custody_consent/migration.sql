-- #120: old shared/link state is not authority. Existing links and incomplete consents are
-- intentionally invalidated so an authenticated custody owner must issue a new version-bound
-- link consent before the account can be used through a Resource.
UPDATE "Resource"
SET "totpAccountId" = NULL,
    "totpDelegationEnvelope" = NULL,
    "totpLinkVersion" = 'link-' || lower(hex(randomblob(16)))
WHERE "totpAccountId" IS NOT NULL OR "totpDelegationEnvelope" IS NOT NULL;

DELETE FROM "TOTPLinkConsent";
DELETE FROM "TOTPDelegationConsent";

DROP TABLE "TOTPLinkConsent";
CREATE TABLE "TOTPLinkConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "ownerDiscordUserId" TEXT NOT NULL,
    "initiatingResourceOwnerId" TEXT NOT NULL,
    "accountVersion" TEXT NOT NULL,
    "linkPolicyVersion" TEXT NOT NULL,
    "delegationPolicy" JSONB NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TOTPLinkConsent_accountId_idx" ON "TOTPLinkConsent"("accountId");
CREATE INDEX "TOTPLinkConsent_resourceId_idx" ON "TOTPLinkConsent"("resourceId");

DROP TABLE "TOTPDelegationConsent";
CREATE TABLE "TOTPDelegationConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "totpAccountId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "ownerDiscordUserId" TEXT NOT NULL,
    "authFamily" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "accountVersion" TEXT NOT NULL,
    "linkVersion" TEXT NOT NULL,
    "maxGrantExpiresAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TOTPDelegationConsent_resourceId_idx" ON "TOTPDelegationConsent"("resourceId");
CREATE INDEX "TOTPDelegationConsent_totpAccountId_idx" ON "TOTPDelegationConsent"("totpAccountId");
