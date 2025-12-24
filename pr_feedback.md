------------------------------------------------------------
Comment #2640225052 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/resource.ts:N/A
State: null | Created: 2025-12-22T15:21:07Z

![high](https://www.gstatic.com/codereviewagent/high-priority.svg)

This `Promise.all` with `map` can lead to a N+1 query problem, where N is the number of guardianships a user has. Each `findById` call could result in a separate database query when you switch to a database implementation like Prisma. This can be very inefficient.

To optimize this, I recommend adding a method like `findManyByIds(ids: string[]): Promise<Resource[]>` to the `ResourceRepository`. This would allow fetching all required resources in a single batch operation, which is much more performant.

For example, in `PrismaResourceRepository`, it would be a `findMany` with a `where: { id: { in: ids } }` clause. The logic here would then change to first collect all `resourceId`s and then make one call to `findManyByIds`.

Code context:
@@ -201,9 +201,29 @@ export async function handleResourceAutocomplete(
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
+
+        // Fetch resource details
+        const userResources = await Promise.all(
+            userGuardianships.map((g) => resources.findById(g.resourceId))
+        );


------------------------------------------------------------
Comment #2640225054 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/resource.test.ts:N/A
State: null | Created: 2025-12-22T15:21:07Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

This mock function helper is overly complex and contains a confusing structure with both an inner `fn` and a `proxy`. The `fn` part appears to have a bug where it doesn't use the updated implementation, while the `proxy` works around it. The logic can be greatly simplified to be more readable and maintainable, without the need for a proxy.

Here is a simpler and more direct implementation that achieves the same goal:

```typescript
function createMockFn(impl: (...args: any[]) => any = () => {}) {
    let currentImpl = impl;
    const calls: any[][] = [];

    const mock = (...args: any[]) => {
        calls.push(args);
        return currentImpl(...args);
    };

    mock.calls = calls;

    mock.mockResolvedValue = (val: any) => {
        currentImpl = () => Promise.resolve(val);
    };

    mock.mockReturnValue = (val: any) => {
        currentImpl = () => val;
    };

    mock.mockImplementation = (newImpl: (...args: any[]) => any) => {
        currentImpl = newImpl;
    };

    return mock;
}
```

Code context:
@@ -0,0 +1,159 @@
+
+import { describe, it, beforeEach } from 'node:test';
+import assert from 'node:assert';
+import { handleResourceAutocomplete } from './resource.js';
+import type { CommandContext } from './context.js';
+import type { AutocompleteInteraction } from 'discord.js';
+
+// Simple mock function helper
+function createMockFn(impl: (...args: any[]) => any = () => { }) {
+    const fn = (...args: any[]) => {
+        fn.calls.push(args);
+        return impl(...args);
+    };
+    fn.calls = [] as any[][];
+    fn.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val); // Update implementation
+        return fn;
+    };
+    fn.mockReturnValue = (val: any) => {
+        fn.impl = () => val;
+        return fn;
+    };
+    // To allow changing implementation
+    fn.impl = impl;
+
+    // Proxy to run the current implementation
+    const proxy = (...args: any[]) => {
+        fn.calls.push(args);
+        return fn.impl(...args);
+    };
+    proxy.calls = fn.calls;
+    proxy.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val);
+    };
+    proxy.mockReturnValue = (val: any) => {
+        fn.impl = () => val;
+    };
+    proxy.mockImplementation = (newImpl: (...args: any[]) => any) => {
+        fn.impl = newImpl;
+    };
+
+    return proxy;
+}


------------------------------------------------------------
Comment #2640225064 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/resource.test.ts:N/A
State: null | Created: 2025-12-22T15:21:07Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

Using `any` for mocks (`mockInteraction` and `mockContext`) completely bypasses TypeScript's type checking, which can lead to hard-to-debug issues if the mocked structures diverge from the actual types. Consider using partial types or a mocking utility to create type-safe mocks. For example, you could use `Partial<AutocompleteInteraction>` and `Partial<CommandContext>` and define only the properties needed for the test. For nested properties, you can create more specific partial types.

Example:
```typescript
import type { AutocompleteInteraction } from 'discord.js';
import type { CommandContext } from './context.js';

// ...

let mockInteraction: Partial<AutocompleteInteraction>;
let mockContext: { repositories: { /* ... */ } };
```
This will make your tests more robust and easier to maintain.

Code context:
@@ -0,0 +1,159 @@
+
+import { describe, it, beforeEach } from 'node:test';
+import assert from 'node:assert';
+import { handleResourceAutocomplete } from './resource.js';
+import type { CommandContext } from './context.js';
+import type { AutocompleteInteraction } from 'discord.js';
+
+// Simple mock function helper
+function createMockFn(impl: (...args: any[]) => any = () => { }) {
+    const fn = (...args: any[]) => {
+        fn.calls.push(args);
+        return impl(...args);
+    };
+    fn.calls = [] as any[][];
+    fn.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val); // Update implementation
+        return fn;
+    };
+    fn.mockReturnValue = (val: any) => {
+        fn.impl = () => val;
+        return fn;
+    };
+    // To allow changing implementation
+    fn.impl = impl;
+
+    // Proxy to run the current implementation
+    const proxy = (...args: any[]) => {
+        fn.calls.push(args);
+        return fn.impl(...args);
+    };
+    proxy.calls = fn.calls;
+    proxy.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val);
+    };
+    proxy.mockReturnValue = (val: any) => {
+        fn.impl = () => val;
+    };
+    proxy.mockImplementation = (newImpl: (...args: any[]) => any) => {
+        fn.impl = newImpl;
+    };
+
+    return proxy;
+}
+
+
+describe('handleResourceAutocomplete', () => {
+    let mockInteraction: any;
+    let mockContext: any;


------------------------------------------------------------
Comment #2640225067 by gemini-code-assist[bot] on apps/purrmission-bot/src/domain/repositories.ts:N/A
State: null | Created: 2025-12-22T15:21:07Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

This `for` loop can be simplified to a more concise and functional approach using `Array.from()` and `filter()`.

```typescript
    return Array.from(this.guardians.values()).filter(
      (guardian) => guardian.discordUserId === discordUserId
    );
```

Code context:
@@ -298,6 +303,16 @@ export class InMemoryGuardianRepository implements GuardianRepository {
     }
     return null;
   }
+
+  async findByUserId(discordUserId: string): Promise<Guardian[]> {
+    const result: Guardian[] = [];
+    for (const guardian of this.guardians.values()) {
+      if (guardian.discordUserId === discordUserId) {
+        result.push(guardian);
+      }
+    }
+    return result;
\n---\n
------------------------------------------------------------
Comment #2640245778 by chatgpt-codex-connector[bot] on apps/purrmission-bot/src/discord/commands/resource.test.ts:N/A
State: null | Created: 2025-12-22T15:26:50Z

**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Mock helper breaks strict TypeScript build**

The new `createMockFn` augments a function value with custom properties (`calls`, `mockResolvedValue`, etc.) without widening its type. With the repo’s `strict` TypeScript settings (see `tsconfig.base.json`), `tsc` will error with messages like `Property 'calls' does not exist on type '(...args: any[]) => any'` for these assignments (and the similar `proxy.*` assignments later in the helper). That means `pnpm build`/`tsc -p apps/purrmission-bot/tsconfig.json` will now fail before tests even run.

Useful? React with 👍 / 👎.

Code context:
@@ -0,0 +1,159 @@
+
+import { describe, it, beforeEach } from 'node:test';
+import assert from 'node:assert';
+import { handleResourceAutocomplete } from './resource.js';
+import type { CommandContext } from './context.js';
+import type { AutocompleteInteraction } from 'discord.js';
+
+// Simple mock function helper
+function createMockFn(impl: (...args: any[]) => any = () => { }) {
+    const fn = (...args: any[]) => {
+        fn.calls.push(args);
+        return impl(...args);
+    };
+    fn.calls = [] as any[][];
+    fn.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val); // Update implementation
+        return fn;
\n---\n
------------------------------------------------------------
Comment #2640272873 by Copilot on apps/purrmission-bot/src/discord/commands/resource.ts:N/A
State: null | Created: 2025-12-22T15:33:19Z

The focusedOption.value can be of type string or number according to Discord.js types. Calling .toLowerCase() directly on it will cause a runtime error if the value is a number. Consider converting it to a string first using String(focusedOption.value) or focusedOption.value.toString() before calling .toLowerCase().

Code context:
@@ -201,9 +201,29 @@ export async function handleResourceAutocomplete(
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
+
+        // Fetch resource details
+        const userResources = await Promise.all(
+            userGuardianships.map((g) => resources.findById(g.resourceId))
+        );
+
+        // Filter valid resources and match query
+        const query = focusedOption.value.toLowerCase();


------------------------------------------------------------
Comment #2640272899 by Copilot on apps/purrmission-bot/src/discord/commands/resource.test.ts:N/A
State: null | Created: 2025-12-22T15:33:20Z

The createMockFn implementation is overly complex and has potential issues with double-counting calls (both fn and proxy push to the same calls array). Consider following the pattern used in other test files in this codebase (see audit.test.ts) where simple inline object mocks with 'as any' type assertions are used instead. This would be more maintainable and consistent with the existing codebase conventions.
```suggestion
    const mock: any = (...args: any[]) => {
        mock.calls.push(args);
        return mock.impl(...args);
    };

    mock.calls = [] as any[][];
    mock.impl = impl;

    mock.mockResolvedValue = (val: any) => {
        mock.impl = () => Promise.resolve(val);
        return mock;
    };

    mock.mockReturnValue = (val: any) => {
        mock.impl = () => val;
        return mock;
    };

    mock.mockImplementation = (newImpl: (...args: any[]) => any) => {
        mock.impl = newImpl;
        return mock;
    };

    return mock;
```

Code context:
@@ -0,0 +1,159 @@
+
+import { describe, it, beforeEach } from 'node:test';
+import assert from 'node:assert';
+import { handleResourceAutocomplete } from './resource.js';
+import type { CommandContext } from './context.js';
+import type { AutocompleteInteraction } from 'discord.js';
+
+// Simple mock function helper
+function createMockFn(impl: (...args: any[]) => any = () => { }) {
+    const fn = (...args: any[]) => {
+        fn.calls.push(args);
+        return impl(...args);
+    };
+    fn.calls = [] as any[][];
+    fn.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val); // Update implementation
+        return fn;
+    };
+    fn.mockReturnValue = (val: any) => {
+        fn.impl = () => val;
+        return fn;
+    };
+    // To allow changing implementation
+    fn.impl = impl;
+
+    // Proxy to run the current implementation
+    const proxy = (...args: any[]) => {
+        fn.calls.push(args);
+        return fn.impl(...args);
+    };
+    proxy.calls = fn.calls;
+    proxy.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val);
+    };
+    proxy.mockReturnValue = (val: any) => {
+        fn.impl = () => val;
+    };
+    proxy.mockImplementation = (newImpl: (...args: any[]) => any) => {
+        fn.impl = newImpl;
+    };
+
+    return proxy;


------------------------------------------------------------
Comment #2640272936 by Copilot on apps/purrmission-bot/src/discord/commands/resource.test.ts:N/A
State: null | Created: 2025-12-22T15:33:20Z

Consider adding a test case to verify the behavior when some resources fail to load (i.e., when resources.findById returns null for some guardianships). The current implementation handles this correctly with the filter on line 218, but it would be valuable to have explicit test coverage for this edge case.

Code context:
@@ -0,0 +1,159 @@
+
+import { describe, it, beforeEach } from 'node:test';
+import assert from 'node:assert';
+import { handleResourceAutocomplete } from './resource.js';
+import type { CommandContext } from './context.js';
+import type { AutocompleteInteraction } from 'discord.js';
+
+// Simple mock function helper
+function createMockFn(impl: (...args: any[]) => any = () => { }) {
+    const fn = (...args: any[]) => {
+        fn.calls.push(args);
+        return impl(...args);
+    };
+    fn.calls = [] as any[][];
+    fn.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val); // Update implementation
+        return fn;
+    };
+    fn.mockReturnValue = (val: any) => {
+        fn.impl = () => val;
+        return fn;
+    };
+    // To allow changing implementation
+    fn.impl = impl;
+
+    // Proxy to run the current implementation
+    const proxy = (...args: any[]) => {
+        fn.calls.push(args);
+        return fn.impl(...args);
+    };
+    proxy.calls = fn.calls;
+    proxy.mockResolvedValue = (val: any) => {
+        fn.impl = () => Promise.resolve(val);
+    };
+    proxy.mockReturnValue = (val: any) => {
+        fn.impl = () => val;
+    };
+    proxy.mockImplementation = (newImpl: (...args: any[]) => any) => {
+        fn.impl = newImpl;
+    };
+
+    return proxy;
+}
+
+
+describe('handleResourceAutocomplete', () => {
+    let mockInteraction: any;
+    let mockContext: any;
+
+    beforeEach(() => {
+        mockInteraction = {
+            user: { id: 'user-1' },
+            options: {
+                getFocused: createMockFn(),
+                getString: createMockFn(),
+            },
+            respond: createMockFn(),
+        };
+
+        mockContext = {
+            repositories: {
+                guardians: {
+                    findByUserId: createMockFn(),
+                },
+                resources: {
+                    findById: createMockFn(),
+                },
+                resourceFields: {
+                    findByResourceId: createMockFn(),
+                },
+                totp: {
+                    findByOwnerDiscordUserId: createMockFn(() => Promise.resolve([])),
+                    findSharedVisibleTo: createMockFn(() => Promise.resolve([])),
+                }
+            },
+        };
+    });
+
+    it('should return matching resources for resource-id autocomplete', async () => {
+        // Setup
+        mockInteraction.options.getFocused.mockReturnValue({
+            name: 'resource-id',
+            value: 'cool',
+        });
+
+        // User is guardian of 2 resources
+        mockContext.repositories.guardians.findByUserId.mockResolvedValue([
+            { resourceId: 'res-1', discordUserId: 'user-1', id: 'g1', createdAt: new Date() },
+            { resourceId: 'res-2', discordUserId: 'user-1', id: 'g2', createdAt: new Date() },
+        ]);
+
+        // Resource details
+        mockContext.repositories.resources.findById.mockImplementation(async (id: string) => {
+            if (id === 'res-1') return { id: 'res-1', name: 'My Cool Resource', mode: 'ONE_OF_N' };
+            if (id === 'res-2') return { id: 'res-2', name: 'Other Resource', mode: 'ONE_OF_N' };
+            return null;
+        });
+
+        // Execute
+        await handleResourceAutocomplete(mockInteraction, mockContext);
+
+        // Verify
+        const findByUserIdCalls = mockContext.repositories.guardians.findByUserId.calls;
+        assert.strictEqual(findByUserIdCalls.length, 1);
+        assert.strictEqual(findByUserIdCalls[0][0], 'user-1');
+
+        const respondCalls = mockInteraction.respond.calls;
+        assert.strictEqual(respondCalls.length, 1);
+        assert.deepStrictEqual(respondCalls[0][0], [
+            { name: 'My Cool Resource', value: 'res-1' },
+        ]);
+    });


------------------------------------------------------------
Comment #2640272948 by Copilot on apps/purrmission-bot/src/discord/commands/resource.test.ts:N/A
State: null | Created: 2025-12-22T15:33:20Z

The file starts with an empty line, which is inconsistent with other test files in the codebase (e.g., audit.test.ts, policy.test.ts, crypto.test.ts all start directly with imports). Consider removing the leading empty line for consistency.

Code context:
@@ -0,0 +1,159 @@
+
