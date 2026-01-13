---
trigger: model_decision
---

# Development Workflows

## Common Tasks

### Adding a New Command
1. Create file in `apps/purrmission-bot/src/commands/` (e.g., `mycommand.ts`)
2. Use this boilerplate:
   ```typescript
   import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
   import { Command } from "../types/command.js";

   export const data = new SlashCommandBuilder()
     .setName("mycommand")
     .setDescription("Does something cool");

   export async function execute(interaction: ChatInputCommandInteraction) {
     await interaction.reply("Hello!");
   }

   export default { data, execute } satisfies Command;
   ```
3. Add to command index if needed
4. Run `pnpm discord:deploy-commands` to register with Discord
5. Restart the bot

### Modifying Domain Logic
- Edit files in `apps/purrmission-bot/src/domain/`
- Update models in `models.ts`
- **Database**:
    - Update `prisma/schema.prisma` if model structure changes
    - Run `pnpm prisma migrate dev --name <change_name>` to generate and apply migrations
    - Run `pnpm prisma generate` to update the client
- Update repository interfaces in `repositories.ts`
- Implement changes in repository implementations (Prisma)
- Update TOTP logic in `totp.ts`

### Adding API Endpoints
1. Add route to `apps/purrmission-bot/src/api/server.ts`
2. Define Zod schema for validation
3. Implement handler with proper error handling
4. Test with curl or Postman

## Code Standards

### TypeScript
- Strict mode enabled
- Explicit type annotations required
- Avoid `any` types (use `unknown` with type guards)
- Use defined interfaces for type safety
- File extensions (`.js`) required in imports (ESM)

### Error Handling
- Use custom error classes for domain-specific errors
- Add type guards for runtime validation
- Log errors with logger, not `console.error()`
- Provide user-friendly error messages

### Async/Await
- Used for all Discord API calls and file I/O
- Proper error handling in try-catch blocks
- Avoid callback-based patterns

### Import Patterns
- ES Modules only (`import`/`export`)
- Use `.js` extensions even for `.ts` files
- Organize imports: external → internal → types

## Testing

### Running Tests
We use the Node.js native test runner (`node:test`) with `tsx`.

```bash
# Run all tests
pnpm test

# Run a specific test file
node --import tsx --test apps/purrmission-bot/src/domain/totp.test.ts
```

### Writing Tests
- Use `node:test` module (`test`, `describe`, `it`)
- Use `node:assert` for assertions
- Mock external dependencies (Discord.js, Prisma) where appropriate
- Place test files next to source files (e.g., `totp.test.ts` next to `totp.ts`)
