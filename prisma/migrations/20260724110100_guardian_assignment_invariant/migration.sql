-- Reconcile duplicate explicit Guardian assignments before enforcing uniqueness.
-- Prefer OWNER over GUARDIAN, then the oldest row, then the lexicographically smallest ID.
-- Project membership is deliberately not inspected, so an explicit assignment is never removed
-- merely because its subject is also a Project Writer.
DELETE FROM "Guardian"
WHERE EXISTS (
    SELECT 1
    FROM "Guardian" AS "preferred"
    WHERE "preferred"."resourceId" = "Guardian"."resourceId"
      AND "preferred"."discordUserId" = "Guardian"."discordUserId"
      AND (
        CASE "preferred"."role" WHEN 'OWNER' THEN 0 ELSE 1 END
          < CASE "Guardian"."role" WHEN 'OWNER' THEN 0 ELSE 1 END
        OR (
          "preferred"."role" = "Guardian"."role"
          AND (
            "preferred"."createdAt" < "Guardian"."createdAt"
            OR (
              "preferred"."createdAt" = "Guardian"."createdAt"
              AND "preferred"."id" < "Guardian"."id"
            )
          )
        )
      )
);

CREATE UNIQUE INDEX "Guardian_resourceId_discordUserId_key"
ON "Guardian"("resourceId", "discordUserId");
