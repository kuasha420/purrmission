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

