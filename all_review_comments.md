------------------------------------------------------------
Comment #2693231031 by gemini-code-assist[bot] on apps/purrmission-bot/src/domain/services.ts:N/A
State: N/A | Created: 2026-01-15T07:10:15Z

![high](https://www.gstatic.com/codereviewagent/high-priority.svg)

The current implementation allows a resource owner to remove any guardian, including themselves. This could lead to orphaned resources with no owner to manage them. To prevent this, you should add a check to prevent the removal of any guardian with the `OWNER` role. Ownership changes should ideally be handled by a more explicit "transfer ownership" function in the future.

```suggestion
    // Verify Target is a Guardian and not an Owner
    const targetGuardian = await repositories.guardians.findByResourceAndUser(resourceId, targetUserId);
    if (!targetGuardian) {
      return { success: false, error: 'User is not a guardian of this resource.' };
    }
    if (targetGuardian.role === 'OWNER') {
      return { success: false, error: 'Cannot remove the resource owner.' };
    }
```

Code context:
@@ -359,6 +359,56 @@ export class ResourceService {
     return { success: true, guardian };
   }
 
+  /**
+   * Remove a guardian from a resource.
+   */
+  async removeGuardian(
+    resourceId: string,
+    actorId: string,
+    targetUserId: string
+  ): Promise<{ success: boolean; error?: string }> {
+    const { repositories } = this.deps;
+
+    // Verify Actor is Owner
+    const actorGuardian = await repositories.guardians.findByResourceAndUser(resourceId, actorId);
+    if (!actorGuardian || actorGuardian.role !== 'OWNER') {
+      return { success: false, error: 'Only the resource owner can remove guardians.' };
+    }
+
+    // Verify Target is a Guardian
+    const targetGuardian = await repositories.guardians.findByResourceAndUser(resourceId, targetUserId);
+    if (!targetGuardian) {
+      return { success: false, error: 'User is not a guardian of this resource.' };
+    }

------------------------------------------------------------
Comment #2693231044 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/guardian.test.ts:N/A
State: N/A | Created: 2026-01-15T07:10:15Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

There's a type mismatch in the `removeGuardianCalls` array definition. The type specifies a `userId` property, but the mock implementation and test assertions correctly use `targetUserId`. To ensure type safety and consistency, the type definition should be updated to use `targetUserId`.

```suggestion
    let removeGuardianCalls: { resourceId: string; targetUserId: string; actorId: string }[] = [];
```

Code context:
@@ -12,17 +12,23 @@ import type {
 interface MockServices {
     resource: {
         addGuardian: (resourceId: string, userId: string) => Promise<{ success: boolean; guardian?: { id: string; role: string } }>;
+        removeGuardian: (resourceId: string, actorId: string, targetUserId: string) => Promise<{ success: boolean; error?: string }>;
+        listGuardians: (resourceId: string, actorId: string) => Promise<{ success: boolean; guardians?: { discordUserId: string; role: string }[]; error?: string }>;
     }
 }
 
 describe('handlePurrmissionCommand - Guardian Routing', () => {
     let mockInteraction: Partial<ChatInputCommandInteraction>;
     let mockContext: CommandContext;
     let addGuardianCalls: { resourceId: string; userId: string }[] = [];
+    let removeGuardianCalls: { resourceId: string; userId: string; actorId: string }[] = [];

------------------------------------------------------------
Comment #2693231054 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/listGuardians.ts:N/A
State: N/A | Created: 2026-01-15T07:10:15Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

The condition `!result.guardians` is redundant. The `listGuardians` service method guarantees that `result.guardians` will be an array if `result.success` is true. Simplifying this check to only `!result.success` improves code clarity and avoids confusion about the service's contract.

```suggestion
        if (!result.success) {
            await interaction.reply({
                content: `❌ ${result.error || 'Failed to list guardians'}`,
                ephemeral: true,
            });
            return;
        }
```

Code context:
@@ -0,0 +1,55 @@
+/**
+ * Handler for /purrmission guardian list command.
+ */
+
+import type { ChatInputCommandInteraction } from 'discord.js';
+import type { Services } from '../../domain/services.js';
+import { logger } from '../../logging/logger.js';
+
+export async function handleListGuardians(
+    interaction: ChatInputCommandInteraction,
+    services: Services
+): Promise<void> {
+    const resourceId = interaction.options.getString('resource-id', true);
+    const callerId = interaction.user.id;
+
+    try {
+        const result = await services.resource.listGuardians(resourceId, callerId);
+
+        if (!result.success || !result.guardians) {
+            await interaction.reply({
+                content: `❌ ${result.error || 'Failed to list guardians'}`,
+                ephemeral: true,
+            });
+            return;
+        }

------------------------------------------------------------
Comment #2693231065 by gemini-code-assist[bot] on apps/purrmission-bot/src/domain/repositories.ts:N/A
State: N/A | Created: 2026-01-15T07:10:16Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

These comments are overly verbose and describe the developer's thought process rather than the code's intent. The use of `deleteMany` is a standard Prisma pattern that is largely self-documenting. Removing these comments will reduce clutter and improve maintainability.

Code context:
@@ -642,6 +647,24 @@ export class PrismaGuardianRepository implements GuardianRepository {
     return rows.map((row) => this.mapPrismaToDomain(row));
   }
 
+  async remove(resourceId: string, discordUserId: string): Promise<void> {
+    // Delete validation is implicit: if not found, Prisma throws or deletes 0.
+    // We want to delete specific entry.
+    // Since composite key or fields are not id, we use deleteMany or delete with unique constraint if exists.
+    // The schema likely has a unique compound index on [resourceId, discordUserId] or logic handles it.
+    // Let's check if we can delete by ID if we find it first, or use deleteMany.
+    // Safer to use deleteMany for non-unique-id based deletions if uncertain of schema constraints, 
+    // but typically guardians are unique per resource/user.
+
+    // Using deleteMany is safe and idempotent-ish (won't fail if not found).

------------------------------------------------------------
Comment #2693233839 by chatgpt-codex-connector[bot] on apps/purrmission-bot/src/domain/services.ts:N/A
State: N/A | Created: 2026-01-15T07:11:33Z

**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Prevent removing the sole OWNER guardian**

The new `removeGuardian` flow allows deleting any guardian without checking `targetGuardian.role`. Because the only OWNER is created in `createResource` and `addGuardian` only adds `GUARDIAN` roles, this means an owner can remove themselves (or another OWNER if added externally), leaving the resource with no OWNER. At that point no one can add/remove guardians, effectively orphaning the resource. Consider blocking removal when `targetGuardian.role === 'OWNER'` or ensuring another OWNER remains.

Useful? React with 👍 / 👎.

Code context:
@@ -359,6 +359,56 @@ export class ResourceService {
     return { success: true, guardian };
   }
 
+  /**
+   * Remove a guardian from a resource.
+   */
+  async removeGuardian(
+    resourceId: string,
+    actorId: string,
+    targetUserId: string
+  ): Promise<{ success: boolean; error?: string }> {
+    const { repositories } = this.deps;
+
+    // Verify Actor is Owner
+    const actorGuardian = await repositories.guardians.findByResourceAndUser(resourceId, actorId);
+    if (!actorGuardian || actorGuardian.role !== 'OWNER') {
+      return { success: false, error: 'Only the resource owner can remove guardians.' };
+    }
+
+    // Verify Target is a Guardian
+    const targetGuardian = await repositories.guardians.findByResourceAndUser(resourceId, targetUserId);
+    if (!targetGuardian) {
+      return { success: false, error: 'User is not a guardian of this resource.' };
+    }
+
+    await repositories.guardians.remove(resourceId, targetUserId);

