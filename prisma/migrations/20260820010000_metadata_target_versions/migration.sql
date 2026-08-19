-- Persist exact target versions required by metadata DTOs and future immutable grants.
ALTER TABLE "ResourceField" ADD COLUMN "version" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Resource" ADD COLUMN "totpLinkVersion" TEXT NOT NULL DEFAULT 'legacy';

-- Populated upgrades receive stable, non-empty versions before any request/grant repair.
UPDATE "ResourceField"
SET "version" = 'field-' || lower(hex(randomblob(16)))
WHERE "version" = 'legacy' OR trim("version") = '';

UPDATE "Resource"
SET "totpLinkVersion" = 'link-' || lower(hex(randomblob(16)))
WHERE "totpLinkVersion" = 'legacy' OR trim("totpLinkVersion") = '';

UPDATE "Project"
SET "policyVersion" = 'policy-' || lower(hex(randomblob(16)))
WHERE "policyVersion" = 'legacy' OR trim("policyVersion") = '';

UPDATE "Resource"
SET "version" = 'resource-' || lower(hex(randomblob(16)))
WHERE "version" = 'legacy' OR trim("version") = '';

UPDATE "TOTPAccount"
SET "version" = 'totp-' || lower(hex(randomblob(16)))
WHERE "version" = 'legacy' OR trim("version") = '';

-- Older TOTP requests did not persist the linked account identifier. Capture the current exact
-- target before repairing its immutable version; unlinked decision-only rows remain non-authority.
UPDATE "ApprovalRequest"
SET "targetKey" = (
  SELECT r."totpAccountId" FROM "Resource" r
  WHERE r."id" = "ApprovalRequest"."resourceId"
)
WHERE "action" = 'totp.code.read';

-- Repair legacy pending request bindings from their canonical current targets.
UPDATE "ApprovalRequest"
SET "targetVersion" = CASE
  WHEN "action" = 'secret.value.read' AND "targetKey" IS NOT NULL THEN
    COALESCE((
      SELECT rf."version" FROM "ResourceField" rf
      WHERE rf."resourceId" = "ApprovalRequest"."resourceId"
        AND rf."name" = "ApprovalRequest"."targetKey"
    ), (SELECT r."version" FROM "Resource" r WHERE r."id" = "ApprovalRequest"."resourceId"))
  WHEN "action" = 'totp.code.read' THEN
    COALESCE((
      SELECT '29:purrmission.target-version.v1|9:totp-link|' ||
             length(CAST(t."version" AS BLOB)) || ':' || t."version" || '|' ||
             length(CAST(r."totpLinkVersion" AS BLOB)) || ':' || r."totpLinkVersion"
      FROM "Resource" r
      JOIN "TOTPAccount" t ON t."id" = r."totpAccountId"
      WHERE r."id" = "ApprovalRequest"."resourceId"
    ), (SELECT '29:purrmission.target-version.v1|16:totp-link-absent|' ||
               length(CAST(r."totpLinkVersion" AS BLOB)) || ':' || r."totpLinkVersion"
        FROM "Resource" r WHERE r."id" = "ApprovalRequest"."resourceId"))
  ELSE (SELECT r."version" FROM "Resource" r WHERE r."id" = "ApprovalRequest"."resourceId")
END;

UPDATE "ApprovalRequest"
SET "policyVersion" = COALESCE((
  SELECT '29:purrmission.target-version.v1|23:project-resource-policy|' ||
         length(CAST(p."policyVersion" AS BLOB)) || ':' || p."policyVersion" || '|' ||
         length(CAST(r."version" AS BLOB)) || ':' || r."version"
  FROM "Environment" e
  JOIN "Project" p ON p."id" = e."projectId"
  JOIN "Resource" r ON r."id" = e."resourceId"
  WHERE e."resourceId" = "ApprovalRequest"."resourceId"
), (SELECT r."version" FROM "Resource" r WHERE r."id" = "ApprovalRequest"."resourceId"));

-- Every pre-upgrade grant was issued under the former broad version scheme. Preserve its
-- lifecycle metadata but revoke it rather than silently expanding old authority onto new exact
-- targets. #122 may issue new grants only after re-evaluating the current request and policy.
UPDATE "ApprovalGrant"
SET "targetKey" = COALESCE((
  SELECT ar."targetKey" FROM "ApprovalRequest" ar
  WHERE ar."id" = "ApprovalGrant"."requestId"
), "targetKey"),
"targetVersion" = COALESCE((
  SELECT ar."targetVersion" FROM "ApprovalRequest" ar
  WHERE ar."id" = "ApprovalGrant"."requestId"
), "targetVersion"),
"policyVersion" = COALESCE((
  SELECT ar."policyVersion" FROM "ApprovalRequest" ar
  WHERE ar."id" = "ApprovalGrant"."requestId"
), "policyVersion"),
"revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP);

CREATE INDEX "ResourceField_version_idx" ON "ResourceField"("version");
