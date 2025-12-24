------------------------------------------------------------
Comment #2640363666 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/resource.test.ts:N/A
State: null | Created: 2025-12-22T15:54:10Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

The test file heavily relies on `any` and `as unknown as` type assertions for mocking, which is explicitly disabled via an eslint comment at the top of the file. While this is pragmatic for getting tests running quickly, it reduces type safety and can make the tests harder to maintain in the long run. For long-term project health, consider creating more strongly-typed mock objects or helper functions. This will improve refactoring safety and make the tests easier to understand and extend.

Code context:
@@ -0,0 +1,146 @@
+/* eslint-disable @typescript-eslint/no-explicit-any */
+import { describe, it, beforeEach } from 'node:test';
+import assert from 'node:assert';
+import { handleResourceAutocomplete } from './resource.js';
+import type { CommandContext } from './context.js';
+import type { AutocompleteInteraction } from 'discord.js';
+
+
+
+describe('handleResourceAutocomplete', () => {


------------------------------------------------------------
Comment #2640363669 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/resource.ts:N/A
State: null | Created: 2025-12-22T15:54:10Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

To avoid an unnecessary database query when the user has no guardianships (and thus `resourceIds` is an empty array), you can add a condition to only call `findManyByIds` if there are IDs to fetch. This is a small but good optimization.

```suggestion
        const validResources = resourceIds.length > 0 ? await resources.findManyByIds(resourceIds) : [];
```

Code context:
@@ -201,9 +201,27 @@ export async function handleResourceAutocomplete(
     const focusedOption = interaction.options.getFocused(true);
 
     if (focusedOption.name === 'resource-id') {
-        // TODO: Implement resource autocomplete
-        // For now, just return empty (user needs to paste resource ID)
-        await interaction.respond([]);
+        const userId = interaction.user.id;
+        const { guardians, resources } = context.repositories;
+
+        // Find all resources where the user is a guardian
+        const userGuardianships = await guardians.findByUserId(userId);
+        const resourceIds = userGuardianships.map((g) => g.resourceId);
+
+        // Fetch resource details optimized
+        const validResources = await resources.findManyByIds(resourceIds);
