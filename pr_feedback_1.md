------------------------------------------------------------
Comment #2645507084 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/guardian.test.ts:N/A
State: null | Created: 2025-12-24T11:41:47Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

Disabling `no-explicit-any` and using `any` extensively for mocks (e.g., for `mockInteraction` and `mockContext`) reduces the benefits of TypeScript by sacrificing type safety. This can make tests more brittle and harder to maintain. For better long-term test quality, consider using more specific types for your mocks, such as `Partial<ChatInputCommandInteraction>`, or using a mocking library to create type-safe test doubles. This will help catch issues at compile time if the underlying interfaces change.

Code context:
@@ -0,0 +1,89 @@
+/* eslint-disable @typescript-eslint/no-explicit-any */


------------------------------------------------------------
Comment #2645507086 by gemini-code-assist[bot] on apps/purrmission-bot/src/discord/commands/twoFa.ts:N/A
State: null | Created: 2025-12-24T11:41:47Z

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

To improve maintainability and prepare for future subcommands within the `guardian` group (e.g., `remove`, `list`), it would be better to use a `switch` statement here. This makes the code more scalable and allows for more specific error messages for unsupported subcommands within this group.

```typescript
  if (subcommandGroup === 'guardian') {
    switch (subcommand) {
      case 'add':
        await handleAddGuardian(interaction, context.services);
        return;
      default:
        await interaction.reply({
          content: `Unsupported 'guardian' subcommand.`,
          ephemeral: true,
        });
        return;
    }
  }
```

Code context:
@@ -133,6 +156,13 @@ export async function handlePurrmissionCommand(
     return;
   }
 
+  if (subcommandGroup === 'guardian') {
+    if (subcommand === 'add') {
+      await handleAddGuardian(interaction, context.services);
+      return;
+    }
+  }
