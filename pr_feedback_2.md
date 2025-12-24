------------------------------------------------------------
Comment #2645513144 by Copilot on apps/purrmission-bot/src/discord/commands/twoFa.ts:N/A
State: null | Created: 2025-12-24T11:45:04Z

The resource-id option should have autocomplete enabled for consistency with other resource-related commands. In the resource subcommand group, all resource-id options use `.setAutocomplete(true)` to provide users with a list of resources they can manage. The guardian add command should follow the same pattern to improve user experience.
```suggestion
              .setRequired(true)
              .setAutocomplete(true)
```

Code context:
@@ -119,6 +120,28 @@ export const purrmissionCommand = new SlashCommandBuilder()
               .setRequired(true)
           )
       )
+  )
+  .addSubcommandGroup((group) =>
+    group
+      .setName('guardian')
+      .setDescription('Manage guardians for resources')
+      .addSubcommand((subcommand) =>
+        subcommand
+          .setName('add')
+          .setDescription('Add a guardian to a protected resource')
+          .addStringOption((option) =>
+            option
+              .setName('resource-id')
+              .setDescription('ID of the resource')
+              .setRequired(true)


------------------------------------------------------------
Comment #2645513153 by Copilot on apps/purrmission-bot/src/discord/commands/index.ts:N/A
State: null | Created: 2025-12-24T11:45:04Z

There are unnecessary blank lines left after removing the purrmission-add-guardian case. The empty lines on 68-69 should be reduced to a single blank line for consistency with the rest of the file's formatting.
```suggestion

```

Code context:
@@ -77,9 +65,7 @@ export async function handleSlashCommand(
       await handleRegisterResource(interaction, services);
       break;
 
-    case 'purrmission-add-guardian':
-      await handleAddGuardian(interaction, services);
-      break;
+
 


------------------------------------------------------------
Comment #2645513162 by Copilot on apps/purrmission-bot/src/discord/commands/twoFa.ts:N/A
State: null | Created: 2025-12-24T11:45:05Z

The guardian subcommand group handler lacks a fallback for unsupported subcommands. If subcommandGroup is 'guardian' but subcommand is not 'add', the code falls through to the next condition which checks if subcommandGroup is not '2fa', resulting in an incorrect error message. Add an else block to handle unknown guardian subcommands with an appropriate error message, and add a return statement to prevent fallthrough.
```suggestion
      return;
    } else {
      await interaction.reply({
        content: 'Unsupported subcommand for /purrmission guardian.',
        ephemeral: true,
      });
      return;
```

Code context:
@@ -133,6 +156,13 @@ export async function handlePurrmissionCommand(
     return;
   }
 
+  if (subcommandGroup === 'guardian') {
+    if (subcommand === 'add') {
+      await handleAddGuardian(interaction, context.services);
+      return;


------------------------------------------------------------
Comment #2645513173 by Copilot on apps/purrmission-bot/src/discord/commands/guardian.test.ts:N/A
State: null | Created: 2025-12-24T11:45:05Z

Missing test coverage for unknown guardian subcommands. The test file should include a test case that verifies the behavior when subcommandGroup is 'guardian' but the subcommand is not 'add' (e.g., 'remove', 'list'). This would catch the fallthrough bug in the routing logic where unsupported guardian subcommands don't receive an appropriate error message.

Code context:
@@ -0,0 +1,89 @@
+/* eslint-disable @typescript-eslint/no-explicit-any */
+import { describe, it, beforeEach } from 'node:test';
+import assert from 'node:assert';
+import { handlePurrmissionCommand } from './twoFa.js';
+import type { CommandContext } from './context.js';
+import type { ChatInputCommandInteraction } from 'discord.js';
+
+describe('handlePurrmissionCommand - Guardian Routing', () => {
+    let mockInteraction: ChatInputCommandInteraction;
+    let mockContext: CommandContext;
+    let addGuardianCalls: any[] = [];
+    let replyCalls: any[] = [];
+
+    beforeEach(() => {
+        addGuardianCalls = [];
+        replyCalls = [];
+
+        mockInteraction = {
+            commandName: 'purrmission',
+            user: { id: 'caller-id' } as any,
+            options: {
+                getSubcommandGroup: ((_required: boolean) => {
+                    return null; // overridden
+                }) as any,
+                getSubcommand: ((_required: boolean) => {
+                    return null; // overridden
+                }) as any,
+                getString: ((name: string) => {
+                    if (name === 'resource-id') return 'res-123';
+                    return null;
+                }) as any,
+                getUser: ((name: string) => {
+                    if (name === 'user') return { id: 'target-user-id' };
+                    return null;
+                }) as any,
+            } as any,
+            reply: ((options: any) => {
+                replyCalls.push(options);
+                return Promise.resolve();
+            }) as any,
+        } as unknown as ChatInputCommandInteraction;
+
+        mockContext = {
+            services: {
+                resource: {
+                    addGuardian: async (resourceId: string, userId: string) => {
+                        addGuardianCalls.push({ resourceId, userId });
+                        // simulate success so handleAddGuardian completes
+                        return { success: true, guardian: { id: 'g-1', role: 'GUARDIAN' } };
+                    },
+                } as any,
+            } as any,
+            repositories: {} as any,
+        } as unknown as CommandContext;
+    });
+
+    it('should route /purrmission guardian add to handleAddGuardian logic', async () => {
+        // Setup
+        mockInteraction.options.getSubcommandGroup = () => 'guardian';
+        mockInteraction.options.getSubcommand = () => 'add';
+
+        // Execute
+        await handlePurrmissionCommand(mockInteraction, mockContext);
+
+        // Verify that the service method invoked by handleAddGuardian was called
+        assert.strictEqual(addGuardianCalls.length, 1);
+        assert.deepStrictEqual(addGuardianCalls[0], { resourceId: 'res-123', userId: 'target-user-id' });
+
+        // Also verify the success reply from handleAddGuardian to be sure
+        assert.ok(replyCalls.length > 0);
+        assert.ok(replyCalls[0].content.includes('Guardian added successfully'));
+    });
+
+    it('should NOT route to guardian logic if group is unrelated', async () => {
+        // Setup
+        mockInteraction.options.getSubcommandGroup = () => 'other';
+        mockInteraction.options.getSubcommand = () => 'foo';
+
+        // Execute
+        await handlePurrmissionCommand(mockInteraction, mockContext);
+
+        // Verify service not called
+        assert.strictEqual(addGuardianCalls.length, 0);
+
+        // Verify unsupported group reply
+        assert.ok(replyCalls.length > 0);
+        assert.ok(replyCalls[0].content.includes('Unsupported subcommand group'));
+    });
+});
